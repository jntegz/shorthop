// Analytics Engine SQL client and the queries behind rollups and live stats.
// The SQL API has no bound parameters: the only values ever interpolated are
// a slug that passed the slug regex, a domain that passed the hostname regex,
// a hit type, device or country code from a fixed list or pattern, integer
// timestamps and the AE_DATASET name, which must be an identifier.
// blob17 holds the short domain of each hit.

import { HOSTNAME_RE } from "../shared/domains";
import { IMPORT_SLUG_RE } from "../shared/slug";
import { SCANNER_PATHS_PER_DAY } from "../shared/types";
import { domainsOf } from "./domains";

const ROW_LIMIT = 10000;
const DATASET_RE = /^\w{1,64}$/;

/** The dataset the CLICKS binding writes to (AE_DATASET). It goes into SQL, so it must be a plain identifier. */
export function dataset(env: Env): string {
  const name = env.AE_DATASET ?? "";
  if (!DATASET_RE.test(name)) throw new Error("AE_DATASET must be 1-64 letters, digits or underscores");
  return name;
}

export function aeAvailable(env: Env): boolean {
  return Boolean(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN);
}

/** A query returned ROW_LIMIT rows, so some were cut off. */
export class AeRowLimitError extends Error {
  constructor() {
    super(`Analytics Engine query hit the ${ROW_LIMIT}-row limit`);
    this.name = "AeRowLimitError";
  }
}

/** `strict` throws AeRowLimitError on a truncated result (the rollup can't store a partial day); otherwise it is logged. */
async function aeQuery<T extends Record<string, unknown>>(env: Env, sql: string, strict = false): Promise<T[]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "text/plain" },
    body: sql,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Analytics Engine SQL failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json<{ data?: T[] }>();
  const data = json.data ?? [];
  if (data.length >= ROW_LIMIT) {
    if (strict) throw new AeRowLimitError();
    console.error(JSON.stringify({ message: "AE query hit row limit, results truncated", limit: ROW_LIMIT }));
  }
  return data;
}

function slugLiteral(slug: string): string {
  if (!IMPORT_SLUG_RE.test(slug)) throw new Error("Refusing to query an invalid slug");
  return `'${slug}'`;
}

export function domainLiteral(domain: string): string {
  if (!HOSTNAME_RE.test(domain)) throw new Error("Refusing to query an invalid domain");
  return `'${domain}'`;
}

/** Narrows a query to one domain, or to one link (domain and slug). */
export interface LinkFilter {
  domain?: string;
  slug?: string;
}

function where(fromSec: number, toSec: number, filter: LinkFilter | undefined, extra: string): string {
  const parts = [
    `timestamp >= toDateTime(${Math.floor(fromSec)})`,
    `timestamp < toDateTime(${Math.floor(toSec)})`,
    extra,
  ];
  if (filter?.slug !== undefined) parts.push(`index1 = ${slugLiteral(filter.slug)}`);
  if (filter?.domain !== undefined) parts.push(`blob17 = ${domainLiteral(filter.domain)}`);
  return parts.filter(Boolean).join(" AND ");
}

const DAY = "toUnixTimestamp(toStartOfDay(timestamp))";
const CLICKS = "sumIf(_sample_interval, blob1 = 'click')";
const BOTS = "sumIf(_sample_interval, blob1 = 'bot')";

/** Breakdown dimensions stored in daily_dims, with their AE columns. */
export const AE_DIMS = {
  city: ["blob4", "blob2"],
  region: ["blob3", "blob2"],
  os: ["blob9"],
  browser: ["blob10"],
  referrer: ["blob11"],
  language: ["blob13"],
  bot: ["blob14"],
  // Smart-routed links only: "rule" or "rule.variant", "-" for the fallback.
  route: ["blob18"],
} as const;
export type AeDim = keyof typeof AE_DIMS;

/** "Paris, FR" for city and region; the plain value otherwise. */
function formatDimValue(dim: AeDim, v0: string, v1: string): string {
  if ((dim === "city" || dim === "region") && v0) return v1 ? `${v0}, ${v1}` : v0;
  return v0;
}

export interface AeDimRow {
  day: number;
  domain: string;
  slug: string;
  value: string;
  clicks: number;
  bots: number;
}

export interface AeComboRow {
  day: number;
  domain: string;
  slug: string;
  country: string;
  device: string;
  source: string;
  clicks: number;
  bots: number;
  uniques: number;
}

export interface AeTotalRow {
  day: number;
  domain: string;
  slug: string;
  uniques: number;
}

export interface AeMissRow {
  day: number;
  domain: string;
  slug: string;
  hits: number;
  bots: number;
}

type Raw = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
/** Every data point is written with a domain; an empty one counts as the primary. */
const domainOf = (env: Env, v: unknown) => str(v) || domainsOf(env).primary;

export async function queryDim(env: Env, dim: AeDim, fromSec: number, toSec: number, filter?: LinkFilter, strict = false): Promise<AeDimRow[]> {
  const cols = AE_DIMS[dim];
  const select = cols.map((c, i) => `${c} AS v${i}`).join(", ");
  const group = cols.map((_, i) => `v${i}`).join(", ");
  const extra = dim === "bot" ? "blob1 = 'bot'" : dim === "route" ? "blob1 != 'miss' AND blob18 != ''" : "blob1 != 'miss'";
  const sql = `SELECT ${DAY} AS day, blob17 AS domain, index1 AS slug, ${select}, ${CLICKS} AS clicks, ${BOTS} AS bots
FROM ${dataset(env)} WHERE ${where(fromSec, toSec, filter, extra)}
GROUP BY day, domain, slug, ${group} ORDER BY ${dim === "bot" ? "bots" : "clicks"} DESC LIMIT ${ROW_LIMIT} FORMAT JSON`;
  const rows = await aeQuery<Raw>(env, sql, strict);
  return rows.map((r) => ({
    day: num(r.day),
    domain: domainOf(env, r.domain),
    slug: str(r.slug),
    value: formatDimValue(dim, str(r.v0), str(r.v1)),
    clicks: num(r.clicks),
    bots: num(r.bots),
  }));
}

/** Country × device × source combinations, the daily_stats shape. */
export async function queryCombos(env: Env, fromSec: number, toSec: number, filter?: LinkFilter, strict = false): Promise<AeComboRow[]> {
  const base = `${DAY} AS day, blob17 AS domain, index1 AS slug, blob2 AS country, blob8 AS device, blob12 AS source`;
  const group = "GROUP BY day, domain, slug, country, device, source";
  const [counts, uniques] = await Promise.all([
    aeQuery<Raw>(
      env,
      `SELECT ${base}, ${CLICKS} AS clicks, ${BOTS} AS bots FROM ${dataset(env)}
WHERE ${where(fromSec, toSec, filter, "blob1 != 'miss'")} ${group} ORDER BY clicks DESC LIMIT ${ROW_LIMIT} FORMAT JSON`,
      strict,
    ),
    aeQuery<Raw>(
      env,
      `SELECT ${base}, count(DISTINCT blob15) AS uniques FROM ${dataset(env)}
WHERE ${where(fromSec, toSec, filter, "blob1 = 'click'")} ${group} ORDER BY uniques DESC LIMIT ${ROW_LIMIT} FORMAT JSON`,
      strict,
    ),
  ]);
  const key = (r: Raw) => `${num(r.day)}|${domainOf(env, r.domain)}|${str(r.slug)}|${str(r.country)}|${str(r.device)}|${str(r.source)}`;
  const uniqueMap = new Map(uniques.map((r) => [key(r), num(r.uniques)]));
  return counts.map((r) => ({
    day: num(r.day),
    domain: domainOf(env, r.domain),
    slug: str(r.slug),
    country: str(r.country),
    device: str(r.device),
    source: str(r.source),
    clicks: num(r.clicks),
    bots: num(r.bots),
    uniques: uniqueMap.get(key(r)) ?? 0,
  }));
}

/** True per-day uniques per link (visitor hashes are per day). */
export async function queryUniques(env: Env, fromSec: number, toSec: number, filter?: LinkFilter, strict = false): Promise<AeTotalRow[]> {
  const rows = await aeQuery<Raw>(
    env,
    `SELECT ${DAY} AS day, blob17 AS domain, index1 AS slug, count(DISTINCT blob15) AS uniques FROM ${dataset(env)}
WHERE ${where(fromSec, toSec, filter, "blob1 = 'click'")} GROUP BY day, domain, slug ORDER BY uniques DESC LIMIT ${ROW_LIMIT} FORMAT JSON`,
    strict,
  );
  return rows.map((r) => ({ day: num(r.day), domain: domainOf(env, r.domain), slug: str(r.slug), uniques: num(r.uniques) }));
}

/** Misses cleared by the owner: hits up to these unix seconds are left out. */
export interface MissCutoffs {
  /** The last "clear all". */
  all: number | null;
  /** Links cleared one by one (only those isQueryableMiss accepts). */
  links: { domain: string; slug: string; sec: number }[];
}

/** A missed path that can be named in an AE query: index1 holds at most 96 bytes. */
export function isQueryableMiss(domain: string, slug: string): boolean {
  return HOSTNAME_RE.test(domain) && IMPORT_SLUG_RE.test(slug) && slug.length <= 96;
}

/**
 * Missed paths per day and link. Never strict: one wordlist scanner can miss thousands
 * of paths a day, and the rollup keeps only the top ones, which come first (most human hits).
 */
export async function queryMisses(env: Env, fromSec: number, toSec: number, cutoffs?: MissCutoffs): Promise<AeMissRow[]> {
  const from = cutoffs?.all != null ? Math.max(fromSec, cutoffs.all + 1) : fromSec;
  if (from >= toSec) return [];
  const extra = [
    "blob1 = 'miss'",
    ...(cutoffs?.links ?? [])
      // A clear after the window hides all of the window's days by date (and the pruner deletes them).
      .filter((l) => l.sec >= from && l.sec < toSec)
      .map((l) => `NOT (blob17 = ${domainLiteral(l.domain)} AND index1 = ${slugLiteral(l.slug)} AND timestamp < toDateTime(${l.sec + 1}))`),
  ].join(" AND ");
  const [rows, scanners] = await Promise.all([
    aeQuery<Raw>(
      env,
      `SELECT ${DAY} AS day, blob17 AS domain, index1 AS slug, sumIf(_sample_interval, double2 = 0) AS hits, sumIf(_sample_interval, double2 = 1) AS bots
FROM ${dataset(env)} WHERE ${where(from, toSec, undefined, extra)}
GROUP BY day, domain, slug ORDER BY hits DESC LIMIT ${ROW_LIMIT} FORMAT JSON`,
    ),
    queryScanners(env, from, toSec),
  ]);
  const out = rows.map((r) => ({ day: num(r.day), domain: domainOf(env, r.domain), slug: str(r.slug), hits: num(r.hits), bots: num(r.bots) }));
  if (!scanners.length) return out;

  // A browser user agent from a home network passes detectBot; its spread of paths gives it away. Count its visits as bot visits.
  const scanned = await aeQuery<Raw>(
    env,
    `SELECT ${DAY} AS day, blob17 AS domain, index1 AS slug, sumIf(_sample_interval, double2 = 0) AS hits
FROM ${dataset(env)} WHERE ${where(from, toSec, undefined, `${extra} AND double2 = 0 AND blob15 IN (${scanners.map((v) => `'${v}'`).join(", ")})`)}
GROUP BY day, domain, slug ORDER BY hits DESC LIMIT ${ROW_LIMIT} FORMAT JSON`,
  );
  const byKey = new Map(out.map((r) => [`${r.day}|${r.domain}|${r.slug}`, r]));
  for (const s of scanned) {
    const r = byKey.get(`${num(s.day)}|${domainOf(env, s.domain)}|${str(s.slug)}`);
    if (!r) continue;
    const moved = Math.min(r.hits, num(s.hits));
    r.hits -= moved;
    r.bots += moved;
  }
  return out;
}

const MAX_SCANNERS = 200;
const VISITOR_RE = /^[0-9a-f]{16}$/;

/** Visitor hashes (per day) that missed at least SCANNER_PATHS_PER_DAY paths while passing as human. */
export async function queryScanners(env: Env, fromSec: number, toSec: number): Promise<string[]> {
  const rows = await aeQuery<Raw>(
    env,
    `SELECT ${DAY} AS day, blob15 AS visitor, count(DISTINCT index1) AS paths
FROM ${dataset(env)} WHERE ${where(fromSec, toSec, undefined, "blob1 = 'miss' AND double2 = 0")}
GROUP BY day, visitor ORDER BY paths DESC LIMIT ${MAX_SCANNERS} FORMAT JSON`,
  );
  return rows.filter((r) => num(r.paths) >= SCANNER_PATHS_PER_DAY && VISITOR_RE.test(str(r.visitor))).map((r) => str(r.visitor));
}

/** Clicks and bots per link in a window (cheap, for list views). */
export async function queryTotalsByLink(
  env: Env,
  fromSec: number,
  toSec: number,
): Promise<{ domain: string; slug: string; clicks: number; bots: number }[]> {
  const rows = await aeQuery<Raw>(
    env,
    `SELECT blob17 AS domain, index1 AS slug, ${CLICKS} AS clicks, ${BOTS} AS bots FROM ${dataset(env)}
WHERE ${where(fromSec, toSec, undefined, "blob1 != 'miss'")} GROUP BY domain, slug ORDER BY clicks DESC LIMIT ${ROW_LIMIT} FORMAT JSON`,
  );
  return rows.map((r) => ({ domain: domainOf(env, r.domain), slug: str(r.slug), clicks: num(r.clicks), bots: num(r.bots) }));
}

export interface AeRecentRow {
  time: string;
  domain: string;
  slug: string;
  event: string;
  country: string;
  city: string;
  device: string;
  os: string;
  browser: string;
  referrer: string;
  source: string;
  botName: string;
  /** The day's visitor hash: for matching against queryScanners, never sent to the browser. */
  visitor: string;
}

/** Narrows recent hits beyond the link: hit type, country and device. */
export interface RecentFilter extends LinkFilter {
  event?: (typeof HIT_EVENTS)[number];
  /** ISO 3166 code, as Cloudflare reports it ("CZ", "T1" for Tor). */
  country?: string;
  device?: (typeof HIT_DEVICES)[number];
}

export const HIT_EVENTS = ["click", "bot", "miss"] as const;
export const HIT_DEVICES = ["desktop", "mobile", "tablet"] as const;

function recentConditions(f: RecentFilter): string {
  const parts: string[] = [];
  if (f.event !== undefined) {
    if (!HIT_EVENTS.includes(f.event)) throw new Error("Refusing to query an invalid hit type");
    parts.push(`blob1 = '${f.event}'`);
  }
  if (f.country !== undefined) {
    if (!/^[A-Z0-9]{2}$/.test(f.country)) throw new Error("Refusing to query an invalid country");
    parts.push(`blob2 = '${f.country}'`);
  }
  if (f.device !== undefined) {
    if (!HIT_DEVICES.includes(f.device)) throw new Error("Refusing to query an invalid device");
    parts.push(`blob8 = '${f.device}'`);
  }
  return parts.join(" AND ");
}

export async function queryRecent(env: Env, sinceSec: number, filter: RecentFilter = {}, limit = 50): Promise<AeRecentRow[]> {
  const { event, country, device, ...link } = filter;
  const rows = await aeQuery<Raw>(
    env,
    `SELECT toUnixTimestamp(timestamp) AS ts, blob17 AS domain, index1 AS slug, blob1 AS event, blob2 AS country, blob4 AS city,
blob8 AS device, blob9 AS os, blob10 AS browser, blob11 AS referrer, blob12 AS source, blob14 AS bot, blob15 AS visitor
FROM ${dataset(env)} WHERE ${where(sinceSec, Date.now() / 1000 + 60, link, recentConditions({ event, country, device }))}
ORDER BY ts DESC LIMIT ${Math.min(Math.max(1, Math.floor(limit)), 200)} FORMAT JSON`,
  );
  return rows.map((r) => ({
    time: new Date(num(r.ts) * 1000).toISOString(),
    domain: domainOf(env, r.domain),
    slug: str(r.slug),
    event: str(r.event),
    country: str(r.country),
    city: str(r.city),
    device: str(r.device),
    os: str(r.os),
    browser: str(r.browser),
    referrer: str(r.referrer),
    source: str(r.source),
    botName: str(r.bot),
    visitor: str(r.visitor),
  }));
}

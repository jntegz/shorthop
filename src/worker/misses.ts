// What the misses report keeps: the owner's policy (noise tracking, limits,
// retention), pruning that enforces it, and clearing.

import { addDays, utcDate } from "../shared/dates";
import { linkKey } from "../shared/domains";
import { isProbePath, isRoutableSlug } from "../shared/slug";
import { DEFAULT_MISS_POLICY, MISS_RETENTION_DAYS, NOISE_LIMITS, REAL_MISS_LIMITS, type MissKind, type MissPolicy } from "../shared/types";
import { isQueryableMiss, type MissCutoffs } from "./ae";
import { getSetting, jsonChunks, setSettingStmt } from "./db";

const MISS_POLICY = "miss_policy";
const POLICY_CACHE_MS = 30_000;

let cached: { policy: MissPolicy; at: number } | null = null;

/** Forgets the cached policy and link lookups (after a save, and between tests). */
export function resetMissPolicyCache(): void {
  cached = null;
  linkLookups.clear();
}

/** The policy as saved before probes and bot-only misses had their own settings. */
interface LegacyPolicy {
  trackNoise?: boolean;
  noiseLimit?: number;
}

function parsePolicy(raw: string | null): MissPolicy {
  try {
    const stored = JSON.parse(raw ?? "{}") as Partial<MissPolicy> & LegacyPolicy;
    const legacy: Partial<MissPolicy> =
      stored.trackNoise === undefined
        ? {}
        : { trackProbes: stored.trackNoise, trackBots: stored.trackNoise, probeLimit: stored.noiseLimit as MissPolicy["probeLimit"], botLimit: stored.noiseLimit as MissPolicy["botLimit"] };
    const v = { ...DEFAULT_MISS_POLICY, ...legacy, ...stored };
    const limit = (n: unknown, fallback: MissPolicy["probeLimit"]) => ((NOISE_LIMITS as readonly unknown[]).includes(n) ? (n as MissPolicy["probeLimit"]) : fallback);
    return {
      trackHumans: v.trackHumans !== false,
      trackProbes: v.trackProbes === true,
      trackBots: v.trackBots === true,
      probeLimit: limit(v.probeLimit, DEFAULT_MISS_POLICY.probeLimit),
      botLimit: limit(v.botLimit, DEFAULT_MISS_POLICY.botLimit),
      retentionDays: (MISS_RETENTION_DAYS as readonly number[]).includes(v.retentionDays) ? v.retentionDays : DEFAULT_MISS_POLICY.retentionDays,
      realLimit: (REAL_MISS_LIMITS as readonly number[]).includes(v.realLimit) ? v.realLimit : DEFAULT_MISS_POLICY.realLimit,
    };
  } catch {
    return DEFAULT_MISS_POLICY;
  }
}

/**
 * The policy, cached per isolate for 30 seconds: the click logger reads it for
 * every noise miss, so a change reaches logging within 30 seconds. `fresh`
 * skips the cache (the admin's reads).
 */
export async function getMissPolicy(db: D1Database, fresh = false): Promise<MissPolicy> {
  if (!fresh && cached && Date.now() - cached.at < POLICY_CACHE_MS) return cached.policy;
  const policy = parsePolicy(await getSetting(db, MISS_POLICY));
  cached = { policy, at: Date.now() };
  return policy;
}

/** The policy the owner saved, or null when they haven't (nothing stored is pruned until then). */
export async function savedMissPolicy(db: D1Database): Promise<MissPolicy | null> {
  const raw = await getSetting(db, MISS_POLICY);
  return raw === null ? null : parsePolicy(raw);
}

/** Saves the policy and prunes stored misses to fit it right away. Returns how many paths were removed. */
export async function saveMissPolicy(env: Env, policy: MissPolicy, now = new Date()): Promise<number> {
  await setSettingStmt(env.DB, MISS_POLICY, JSON.stringify(policy)).run();
  resetMissPolicyCache();
  return pruneMisses(env, policy, now);
}

/** Answers per isolate: scanners repeat the same few paths, so most lookups cost no D1 read. */
const linkLookups = new Map<string, { found: boolean; at: number }>();
const LINK_LOOKUP_MS = 10 * 60_000;
const LINK_LOOKUP_MAX = 1000;

/** True when a link on `domain` matches `slug` apart from case (the report's "case differs"). */
export async function hasLinkIgnoringCase(db: D1Database, domain: string, slug: string): Promise<boolean> {
  if (!isRoutableSlug(slug)) return false;
  const key = linkKey(domain, slug.toLowerCase());
  const known = linkLookups.get(key);
  if (known && Date.now() - known.at < LINK_LOOKUP_MS) return known.found;
  const row = await db.prepare("SELECT 1 AS x FROM links WHERE domain = ? AND slug = ? COLLATE NOCASE LIMIT 1").bind(domain, slug).first();
  if (linkLookups.size >= LINK_LOOKUP_MAX) linkLookups.clear();
  linkLookups.set(key, { found: row !== null, at: Date.now() });
  return row !== null;
}

/** A scanner probe (a probe-looking path no link matches), else bot-only (no human hits), else human. */
export function missKind(slug: string, hits: number, hasLink: boolean): MissKind {
  if (!hasLink && isProbePath(slug)) return "probe";
  return hits === 0 ? "bot" : "human";
}

/** Noise: a path only bots asked for, or a scanner probe that isn't a real link. */
export function isNoise(slug: string, hits: number, hasLink: boolean): boolean {
  return missKind(slug, hits, hasLink) !== "human";
}

/** Whether the policy tracks a kind, and how many of its most recent paths it keeps (0: all). */
export function kindLimit(policy: MissPolicy, kind: MissKind): { tracked: boolean; limit: number } {
  if (kind === "probe") return { tracked: policy.trackProbes, limit: policy.probeLimit };
  if (kind === "bot") return { tracked: policy.trackBots, limit: policy.botLimit };
  return { tracked: policy.trackHumans, limit: policy.realLimit };
}

/** The paths of `rows` a policy keeps: tracked kinds only, each kind's most recent up to its limit. */
export function keptByPolicy<T extends { last: string; hits: number; bots: number }>(policy: MissPolicy, rows: T[], kindOf: (r: T) => MissKind): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const kind of ["human", "probe", "bot"] as const) {
    const { tracked, limit } = kindLimit(policy, kind);
    const list = rows.filter((r) => kindOf(r) === kind).sort(byRecent);
    const keep = !tracked ? 0 : limit || list.length;
    kept.push(...list.slice(0, keep));
    dropped.push(...list.slice(keep));
  }
  return { kept, dropped };
}

/** Most recently seen first, then the busiest: the order limits keep paths in. */
export function byRecent(a: { last: string; hits: number; bots: number }, b: { last: string; hits: number; bots: number }): number {
  return b.last.localeCompare(a.last) || b.hits + b.bots - (a.hits + a.bots);
}

/** Deletes the given paths' rows, or only those dated up to `through`. */
function deleteMissStmts(db: D1Database, links: { domain: string; slug: string }[], through?: string): D1PreparedStatement[] {
  return jsonChunks(links.map((l) => [l.domain, l.slug])).map((chunk) =>
    db
      .prepare(
        `DELETE FROM daily_dims WHERE dim = 'miss' AND (domain, slug) IN
         (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))${through ? " AND date <= ?2" : ""}`,
      )
      .bind(...(through ? [chunk, through] : [chunk])),
  );
}

interface StoredMissPath {
  domain: string;
  slug: string;
  hits: number;
  bots: number;
  last: string;
  /** 1 when a link matches the path apart from case. */
  has_link: number;
}

/** Every stored missed path with its totals. */
async function storedMissPaths(db: D1Database): Promise<StoredMissPath[]> {
  const { results } = await db
    .prepare(
      `SELECT d.domain, d.slug, SUM(d.clicks) AS hits, SUM(d.bots) AS bots, MAX(d.date) AS last,
              EXISTS (SELECT 1 FROM links l WHERE l.domain = d.domain AND l.slug = d.slug COLLATE NOCASE) AS has_link
       FROM daily_dims d WHERE d.dim = 'miss' GROUP BY d.domain, d.slug`,
    )
    .all<StoredMissPath>();
  return results;
}

/** The report's rule: a probe-looking path that no link matches, even apart from case. */
const isStoredProbe = (r: StoredMissPath) => r.has_link !== 1 && isProbePath(r.slug);

/** Deletes the rows of every stored scanner probe dated up to `day`. */
async function deleteProbesThrough(db: D1Database, day: string): Promise<void> {
  const probes = (await storedMissPaths(db)).filter(isStoredProbe);
  if (probes.length) await db.batch(deleteMissStmts(db, probes, day));
}

/**
 * Deletes the stored misses that clears hide, and those of ignored paths (so they can't take a visible
 * path's place, and a rollup of the clearing day can't bring them back). With
 * a policy, also enforces it: drops misses older than the retention, all noise
 * when it isn't tracked, and the oldest paths beyond each limit. Returns how
 * many paths were removed entirely by the policy.
 */
export async function pruneMisses(env: Env, policy: MissPolicy | null, now = new Date()): Promise<number> {
  const db = env.DB;
  const cleared = await missesCleared(db, now);
  const oldest = policy ? addDays(utcDate(now), -policy.retentionDays) : null;
  const hiddenAll = cleared.all !== null && (oldest === null || cleared.all > oldest) ? cleared.all : oldest;
  await db.batch([
    ...(hiddenAll !== null ? [db.prepare("DELETE FROM daily_dims WHERE dim = 'miss' AND date <= ?").bind(hiddenAll)] : []),
    db
      .prepare(
        `DELETE FROM daily_dims WHERE dim = 'miss'
         AND date <= (SELECT value FROM json_each(?1) WHERE key = daily_dims.domain || '/' || daily_dims.slug)`,
      )
      .bind(JSON.stringify(cleared.links)),
  ]);
  if (cleared.probes !== null) await deleteProbesThrough(db, cleared.probes);
  const ignored = Object.keys(await ignoredMisses(db)).map((key) => {
    const i = key.indexOf("/");
    return { domain: key.slice(0, i), slug: key.slice(i + 1) };
  });
  if (ignored.length) await db.batch(deleteMissStmts(db, ignored));
  if (!policy) return 0;
  const { dropped: drop } = keptByPolicy(policy, await storedMissPaths(db), (r) => missKind(r.slug, r.hits, r.has_link === 1));
  if (drop.length) await db.batch(deleteMissStmts(db, drop));
  return drop.length;
}

/**
 * Misses the owner cleared. Each clear is stored as its unix second, so a
 * visit right after a clear shows up at once: Analytics Engine queries leave
 * out only the hits up to that second (the cutoffs), and the rollup of the
 * clearing day keeps just the later ones. Rolled-up rows are hidden by day:
 * `all` and `links` give the last hidden day. A path cleared in a large bulk
 * clear, or one that can't be named in an AE query, is hidden by day only,
 * through the end of the clearing day (UTC).
 *
 * "Clear scanner probes" is stored as a day: probes are told apart in JS
 * (isProbePath), not in AE SQL, so they're hidden through the end of the
 * clearing day. Real misses aren't affected.
 */
export interface MissesCleared {
  all: string | null;
  /** linkKey → day. */
  links: Record<string, string>;
  /** Scanner probes are hidden through this day; null when a later "clear all" supersedes it. */
  probes: string | null;
  cutoffs: MissCutoffs;
}

/** As stored: unix seconds, or a day (hidden through its end) for older clears and day-only paths. */
interface StoredClears {
  all: number | string | null;
  links: Record<string, number | string>;
  probes: string | null;
}

const MISSES_CLEARED = "misses_cleared";
/** Older clears can't be resurrected by a rollup (AE keeps ~90 days), so they're dropped. */
const CLEARED_KEEP_DAYS = 92;
/**
 * Exact clears become one AE query clause each, so they're limited: at most
 * this many per clear and in the last 8 days (a rollup's widest window is 7).
 * Past either limit, paths are cleared by day.
 */
const EXACT_CLEAR_MAX = 50;
const EXACT_CLEARS_ACTIVE_MAX = 200;
const EXACT_CLEAR_WINDOW_SEC = 8 * 86400;

const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isClear = (v: unknown): v is number | string => (typeof v === "number" && Number.isFinite(v)) || isDay(v);
const dayOf = (v: number | string) => (typeof v === "number" ? utcDate(new Date(v * 1000)) : v);
/** The last day whose rolled-up rows are hidden. */
const hiddenThrough = (v: number | string) => (typeof v === "number" ? addDays(dayOf(v), -1) : v);

async function storedClears(db: D1Database): Promise<StoredClears> {
  try {
    const v = JSON.parse((await getSetting(db, MISSES_CLEARED)) ?? "{}") as Partial<StoredClears>;
    const links = v.links && typeof v.links === "object" ? Object.fromEntries(Object.entries(v.links).filter(([, d]) => isClear(d))) : {};
    return { all: isClear(v.all) ? v.all : null, links, probes: isDay(v.probes) ? v.probes : null };
  } catch {
    return { all: null, links: {}, probes: null };
  }
}

export async function missesCleared(db: D1Database, now = new Date()): Promise<MissesCleared> {
  const s = await storedClears(db);
  // A path's exact clear only matters until its day is rolled up; past the
  // window it works by day, so a query never carries more than
  // EXACT_CLEARS_ACTIVE_MAX clauses however long rollups lag.
  const oldest = now.getTime() / 1000 - EXACT_CLEAR_WINDOW_SEC;
  // Its day was rolled up with the cutoff, so (like an exact clear) only earlier days stay hidden.
  for (const [key, v] of Object.entries(s.links)) if (typeof v === "number" && v < oldest) s.links[key] = hiddenThrough(v);
  const cutoffs: MissCutoffs = { all: typeof s.all === "number" ? s.all : null, links: [] };
  for (const [key, v] of Object.entries(s.links)) {
    if (typeof v !== "number") continue;
    const i = key.indexOf("/");
    cutoffs.links.push({ domain: key.slice(0, i), slug: key.slice(i + 1), sec: v });
  }
  const all = s.all === null ? null : hiddenThrough(s.all);
  return {
    all,
    links: Object.fromEntries(Object.entries(s.links).map(([k, v]) => [k, hiddenThrough(v)])),
    probes: s.probes !== null && (all === null || s.probes > all) ? s.probes : null,
    cutoffs,
  };
}

/** For rolled-up rows, and AE rows already narrowed by the cutoffs. */
export function isCleared(c: MissesCleared, domain: string, slug: string, date: string): boolean {
  return (c.all !== null && date <= c.all) || date <= (c.links[linkKey(domain, slug)] ?? "");
}

/** A probe-looking path on a day "Clear scanner probes" hides. The caller still checks that no link matches it. */
export function isProbeCleared(c: MissesCleared, slug: string, date: string): boolean {
  return c.probes !== null && date <= c.probes && isProbePath(slug);
}

/** Drops a removed domain's clears (see domain-purge.ts): its misses go with it. */
export async function forgetDomainClears(db: D1Database, domain: string): Promise<D1PreparedStatement> {
  const stored = await storedClears(db);
  const links = Object.fromEntries(Object.entries(stored.links).filter(([key]) => !key.startsWith(`${domain}/`)));
  return setSettingStmt(db, MISSES_CLEARED, JSON.stringify({ ...stored, links }));
}

/**
 * Deletes stored misses: all of them, every scanner probe, or the given
 * links. Visits from now on show again (probes: from tomorrow, UTC).
 */
export async function clearMisses(env: Env, target: "all" | "probes" | { domain: string; slug: string }[], now = new Date()): Promise<void> {
  const sec = Math.floor(now.getTime() / 1000);
  const today = utcDate(now);
  const keep = addDays(today, -CLEARED_KEEP_DAYS);
  const stored = await storedClears(env.DB);
  if (target === "probes") {
    // The marker first: a rollup running in between then can't leave probe rows behind.
    await setSettingStmt(env.DB, MISSES_CLEARED, JSON.stringify({ ...stored, probes: today })).run();
    await deleteProbesThrough(env.DB, today);
    return;
  }
  const links = target === "all" ? undefined : target;
  const next: StoredClears = links
    ? {
        all: stored.all !== null && dayOf(stored.all) >= keep ? stored.all : null,
        links: Object.fromEntries(Object.entries(stored.links).filter(([, v]) => dayOf(v) >= keep)),
        probes: stored.probes,
      }
    : { all: sec, links: {}, probes: null };
  const clearing = new Set((links ?? []).map((l) => linkKey(l.domain, l.slug)));
  const active = Object.entries(next.links).filter(([k, v]) => !clearing.has(k) && typeof v === "number" && v > sec - EXACT_CLEAR_WINDOW_SEC).length;
  const exact = (links?.length ?? 0) <= EXACT_CLEAR_MAX && active + (links?.length ?? 0) <= EXACT_CLEARS_ACTIVE_MAX;
  for (const l of links ?? []) next.links[linkKey(l.domain, l.slug)] = exact && isQueryableMiss(l.domain, l.slug) ? sec : today;
  await env.DB.batch([
    ...(links ? deleteMissStmts(env.DB, links) : [env.DB.prepare("DELETE FROM daily_dims WHERE dim = 'miss'")]),
    setSettingStmt(env.DB, MISSES_CLEARED, JSON.stringify(next)),
  ]);
}

const MISSES_IGNORED = "misses_ignored";

/** Paths the owner ignored: linkKey → the UTC day they did. Hidden from the report and digest, and their counts aren't kept. */
export async function ignoredMisses(db: D1Database): Promise<Record<string, string>> {
  try {
    const v = JSON.parse((await getSetting(db, MISSES_IGNORED)) ?? "{}") as unknown;
    return v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, d]) => isDay(d))) : {};
  } catch {
    return {};
  }
}

/** Ignores these paths from now on and deletes their stored counts. */
export async function ignoreMisses(env: Env, links: { domain: string; slug: string; since?: string }[], now = new Date()): Promise<void> {
  const next = await ignoredMisses(env.DB);
  const today = utcDate(now);
  for (const l of links) next[linkKey(l.domain, l.slug)] ??= l.since && l.since <= today ? l.since : today;
  await env.DB.batch([...deleteMissStmts(env.DB, links), setSettingStmt(env.DB, MISSES_IGNORED, JSON.stringify(next))]);
}

/** Shows every ignored path again. */
export async function unignoreAllMisses(env: Env): Promise<number> {
  const count = Object.keys(await ignoredMisses(env.DB)).length;
  await setSettingStmt(env.DB, MISSES_IGNORED, "{}").run();
  return count;
}

/** Shows these paths again; their visits count from now on. */
export async function unignoreMisses(env: Env, links: { domain: string; slug: string }[]): Promise<void> {
  const next = await ignoredMisses(env.DB);
  for (const l of links) delete next[linkKey(l.domain, l.slug)];
  await setSettingStmt(env.DB, MISSES_IGNORED, JSON.stringify(next)).run();
}

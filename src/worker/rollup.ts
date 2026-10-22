// Daily rollup: Analytics Engine (90-day retention) → D1 (kept forever).
// Self-healing: every run rolls each day after last_rolled up to yesterday,
// and each day is replaced atomically, so re-running is always safe.

import { addDays, dateFromDaySec, dayStartSec, daysBetween, utcDate } from "../shared/dates";
import { AE_DIMS, AeRowLimitError, aeAvailable, queryCombos, queryDim, queryMisses, queryUniques, type AeDim, type LinkFilter, type MissCutoffs } from "./ae";
import { getSetting, jsonChunks, setSettingStmt } from "./db";
import { purgedDomains } from "./domain-purge";
import { isNoise, missesCleared, pruneMisses, savedMissPolicy } from "./misses";

export interface StatsRow {
  date: string;
  domain: string;
  slug: string;
  country: string;
  device: string;
  source: string;
  clicks: number;
  uniques: number;
  bots: number;
}

export interface DimRow {
  date: string;
  domain: string;
  slug: string;
  dim: string;
  value: string;
  clicks: number;
  uniques: number;
  bots: number;
}

const MAX_VALUES_PER_DIM = 100;
/** Missed paths kept per day and domain, each kind on its own so scanners can't push real misses out. */
const MAX_REAL_MISSES_PER_DAY = 1000;
const MAX_NOISE_MISSES_PER_DAY = 200;
const OTHER = "(other)";
const MAX_CHUNK_DAYS = 7;
const AE_RETENTION_DAYS = 89;

export interface CollectOptions {
  /** One link (domain and slug), or all links when omitted. */
  link?: Required<LinkFilter>;
  /** Include city/region/os/browser/referrer/language/bot breakdowns. */
  dims?: boolean;
  /** Include misses (only meaningful without a link filter). */
  misses?: boolean;
  /** Leave out misses the owner cleared. */
  missCutoffs?: MissCutoffs;
  /** Throw AeRowLimitError instead of returning clicks, uniques or breakdowns cut off at the row limit. */
  strict?: boolean;
}

/** Reads one window from Analytics Engine in the D1 rollup shape. */
export async function collectFromAE(
  env: Env,
  fromSec: number,
  toSec: number,
  opts: CollectOptions = {},
): Promise<{ stats: StatsRow[]; dims: DimRow[] }> {
  const { link, dims: withDims = true, misses: withMisses = link === undefined, missCutoffs, strict = false } = opts;
  const dimNames = withDims ? (Object.keys(AE_DIMS) as AeDim[]) : [];

  const [[combos, uniques, misses], dimResults, purged] = await Promise.all([
    Promise.all([
      queryCombos(env, fromSec, toSec, link, strict),
      queryUniques(env, fromSec, toSec, link, strict),
      withMisses ? queryMisses(env, fromSec, toSec, missCutoffs) : Promise.resolve([]),
    ]),
    Promise.all(dimNames.map((d) => queryDim(env, d, fromSec, toSec, link, strict))),
    purgedDomains(env.DB),
  ]);
  // A removed domain's AE rows stay until they expire; hide them through its purge day.
  const kept = (domain: string, day: number) => dateFromDaySec(day) > (purged[domain] ?? "");

  const stats: StatsRow[] = combos.filter((r) => kept(r.domain, r.day)).map((r) => ({
    date: dateFromDaySec(r.day),
    domain: r.domain,
    slug: r.slug,
    country: r.country,
    device: r.device,
    source: r.source,
    clicks: r.clicks,
    uniques: r.uniques,
    bots: r.bots,
  }));

  const dimMap = new Map<string, DimRow>();
  const add = (row: DimRow) => {
    const key = `${row.date}|${row.domain}|${row.slug}|${row.dim}|${row.value}`;
    const prev = dimMap.get(key);
    if (prev) {
      prev.clicks += row.clicks;
      prev.bots += row.bots;
      prev.uniques += row.uniques;
    } else {
      dimMap.set(key, { ...row });
    }
  };

  // Totals per day and link: clicks/bots from the combos, uniques counted once per day.
  for (const r of stats) add({ date: r.date, domain: r.domain, slug: r.slug, dim: "total", value: "", clicks: r.clicks, uniques: 0, bots: r.bots });
  for (const u of uniques) {
    if (!kept(u.domain, u.day)) continue;
    const date = dateFromDaySec(u.day);
    const row = dimMap.get(`${date}|${u.domain}|${u.slug}|total|`);
    if (row) row.uniques = u.uniques;
  }

  dimNames.forEach((dim, i) => {
    for (const r of dimResults[i] ?? []) {
      if (kept(r.domain, r.day)) add({ date: dateFromDaySec(r.day), domain: r.domain, slug: r.slug, dim, value: r.value, clicks: r.clicks, uniques: 0, bots: r.bots });
    }
  });

  for (const m of misses) {
    if (kept(m.domain, m.day)) add({ date: dateFromDaySec(m.day), domain: m.domain, slug: m.slug, dim: "miss", value: "", clicks: m.hits, uniques: 0, bots: m.bots });
  }

  return { stats, dims: capDims([...dimMap.values()]) };
}

/**
 * Keeps the top values per (date, link, dim), folding the rest into "(other)",
 * and the top misses per day, domain and kind (real or noise). Extra misses
 * are dropped, not folded: an "(other)" path would read as a scanner probe.
 */
export function capDims(rows: DimRow[]): DimRow[] {
  const groups = new Map<string, DimRow[]>();
  for (const r of rows) {
    // The same rule as the report and the pruner, without the case-insensitive link check.
    const kind = r.dim === "miss" && isNoise(r.slug, r.clicks, false) ? "noise" : "real";
    const key = r.dim === "miss" ? `${r.date}|${r.domain}|miss|${kind}` : `${r.date}|${r.domain}|${r.slug}|${r.dim}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: DimRow[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    if (!first) continue;
    const max =
      first.dim === "miss" ? (isNoise(first.slug, first.clicks, false) ? MAX_NOISE_MISSES_PER_DAY : MAX_REAL_MISSES_PER_DAY) : MAX_VALUES_PER_DIM;
    if (list.length <= max || first.dim === "total") {
      out.push(...list);
      continue;
    }
    list.sort((a, b) => b.clicks + b.bots - (a.clicks + a.bots));
    const top = list.slice(0, max);
    if (first.dim === "miss") {
      out.push(...top);
      continue;
    }
    // A kept value that is itself "(other)" takes the fold: two rows with one value would break the day's insert.
    const named = top.find((r) => r.value === OTHER);
    const other: DimRow = named
      ? { ...named }
      : { date: first.date, domain: first.domain, slug: first.slug, dim: first.dim, value: OTHER, clicks: 0, uniques: 0, bots: 0 };
    for (const r of list.slice(max)) {
      other.clicks += r.clicks;
      other.bots += r.bots;
    }
    out.push(...top.filter((r) => r !== named), other);
  }
  return out;
}

const INSERT_STATS = `INSERT INTO daily_stats (date, domain, slug, country, device, source, clicks, uniques, bots)
SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
       json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]')
FROM json_each(?2)`;

const INSERT_DIMS = `INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots)
SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
       json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]')
FROM json_each(?2)`;

/** Replaces one day's rollup rows in a single transaction. */
async function writeDay(
  db: D1Database,
  date: string,
  stats: StatsRow[],
  dims: DimRow[],
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM daily_stats WHERE date = ?").bind(date),
    db.prepare("DELETE FROM daily_dims WHERE date = ?").bind(date),
  ];
  for (const chunk of jsonChunks(stats.map((r) => [r.domain, r.slug, r.country, r.device, r.source, r.clicks, r.uniques, r.bots]))) {
    stmts.push(db.prepare(INSERT_STATS).bind(date, chunk));
  }
  for (const chunk of jsonChunks(dims.map((r) => [r.domain, r.slug, r.dim, r.value, r.clicks, r.uniques, r.bots]))) {
    stmts.push(db.prepare(INSERT_DIMS).bind(date, chunk));
  }
  stmts.push(setSettingStmt(db, "last_rolled", date));
  await db.batch(stmts);
}

export interface RollupResult {
  skipped?: string;
  rolled: string[];
}

/** The finished UTC days the next rollup would summarize, or null when it is up to date. */
export async function pendingRollup(env: Env, now: Date = new Date()): Promise<{ from: string; to: string; days: number } | null> {
  const today = utcDate(now);
  const yesterday = addDays(today, -1);
  const oldest = addDays(today, -AE_RETENTION_DAYS);
  const last = await getSetting(env.DB, "last_rolled");
  let start = last ? addDays(last, 1) : addDays(yesterday, -(MAX_CHUNK_DAYS - 1));
  if (start < oldest) start = oldest;
  return start <= yesterday ? { from: start, to: yesterday, days: daysBetween(start, yesterday) + 1 } : null;
}

export async function runRollup(env: Env, now: Date = new Date()): Promise<RollupResult> {
  if (!aeAvailable(env)) {
    console.log(JSON.stringify({ message: "rollup skipped", reason: "Analytics Engine credentials not configured" }));
    return { skipped: "Analytics Engine credentials not configured", rolled: [] };
  }
  const pending = await pendingRollup(env, now);
  const rolled: string[] = [];
  if (pending) {
    const { cutoffs } = await missesCleared(env.DB);
    const collect = (from: string, to: string) =>
      collectFromAE(env, dayStartSec(from), dayStartSec(addDays(to, 1)), { missCutoffs: cutoffs, strict: true });
    let chunkDays = MAX_CHUNK_DAYS;
    let start = pending.from;
    while (start <= pending.to) {
      let end = addDays(start, chunkDays - 1);
      if (end > pending.to) end = pending.to;
      let chunk: Awaited<ReturnType<typeof collect>>;
      try {
        chunk = await collect(start, end);
      } catch (err) {
        // Too many rows for one query: go a day at a time for the rest of this run. A single day
        // that still doesn't fit throws, so last_rolled stays put rather than saving a partial day.
        if (!(err instanceof AeRowLimitError) || start === end) throw err;
        chunkDays = 1;
        end = start;
        chunk = await collect(start, end);
      }
      const { stats, dims } = chunk;
      for (let d = start; d <= end; d = addDays(d, 1)) {
        await writeDay(
          env.DB,
          d,
          stats.filter((r) => r.date === d),
          dims.filter((r) => r.date === d),
        );
        rolled.push(d);
      }
      start = addDays(end, 1);
    }
  }
  // Apply the clears to what was just rolled up, and keep the misses report
  // within the owner's limits and retention once they've chosen them.
  let prunedMisses = 0;
  try {
    prunedMisses = await pruneMisses(env, await savedMissPolicy(env.DB), now);
  } catch (err) {
    console.error(JSON.stringify({ message: "miss pruning failed", error: String(err) }));
  }
  console.log(JSON.stringify({ message: "rollup complete", days: rolled.length, from: rolled[0], to: rolled.at(-1), prunedMisses }));
  return { rolled };
}

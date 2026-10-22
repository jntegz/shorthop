// Stats reads: completed days come from the D1 rollups, and only days that
// haven't been rolled up yet (normally just today) come from Analytics Engine.

import { addDays, dayStartSec, rangeBounds, utcDate } from "../shared/dates";
import { linkKey } from "../shared/domains";
import { isProbePath } from "../shared/slug";
import {
  DIMS,
  type BreakdownRow,
  type Dim,
  type LinkStatsDTO,
  type MissPolicy,
  type MissRow,
  type OverviewDTO,
  type Range,
  type SeriesPoint,
  type TopLink,
  type Totals,
} from "../shared/types";
import { aeAvailable, queryTotalsByLink, type LinkFilter } from "./ae";
import { getSetting, jsonChunks, nowSec } from "./db";
import { byRecent, getMissPolicy, isCleared, isNoise, isProbeCleared, missesCleared } from "./misses";
import { collectFromAE } from "./rollup";

const TOP_N = 50;

interface Windows {
  from: string;
  to: string;
  /** Inclusive D1 date span, or null when nothing has been rolled up for it. */
  d1: { from: string; to: string } | null;
  /** AE window in unix seconds, or null. */
  ae: { fromSec: number; toSec: number } | null;
  aeAvailable: boolean;
}

export async function windows(env: Env, range: Range, now: Date = new Date()): Promise<Windows> {
  const { from, to } = rangeBounds(range, now);
  const lastRolled = await getSetting(env.DB, "last_rolled");
  const d1To = lastRolled && lastRolled < to ? lastRolled : lastRolled ? to : null;
  const d1 = d1To && d1To >= from ? { from, to: d1To } : null;

  const available = aeAvailable(env);
  let ae: Windows["ae"] = null;
  if (available) {
    const oldest = addDays(utcDate(now), -89);
    let start = d1To ? addDays(d1To, 1) : from;
    if (start < from) start = from;
    if (start < oldest) start = oldest;
    if (start <= to) ae = { fromSec: dayStartSec(start), toSec: Math.floor(now.getTime() / 1000) + 60 };
  }
  return { from, to, d1, ae, aeAvailable: available };
}

class Aggregate {
  series = new Map<string, Totals>();
  dims = new Map<Dim, Map<string, { clicks: number; bots: number }>>();

  addSeries(date: string, clicks: number, uniques: number, bots: number) {
    const t = this.series.get(date) ?? { clicks: 0, uniques: 0, bots: 0 };
    t.clicks += clicks;
    t.uniques += uniques;
    t.bots += bots;
    this.series.set(date, t);
  }

  addDim(dim: Dim, value: string, clicks: number, bots: number) {
    let m = this.dims.get(dim);
    if (!m) this.dims.set(dim, (m = new Map()));
    const v = m.get(value) ?? { clicks: 0, bots: 0 };
    v.clicks += clicks;
    v.bots += bots;
    m.set(value, v);
  }

  totals(): Totals {
    const t = { clicks: 0, uniques: 0, bots: 0 };
    for (const s of this.series.values()) {
      t.clicks += s.clicks;
      t.uniques += s.uniques;
      t.bots += s.bots;
    }
    return t;
  }

  seriesList(from: string, to: string): SeriesPoint[] {
    // "all" starts in 2000: begin at the first day with data instead.
    let start = from;
    if (from === "2000-01-01") {
      const dates = [...this.series.keys()].sort();
      start = dates[0] ?? to;
    }
    const out: SeriesPoint[] = [];
    for (let d = start; d <= to; d = addDays(d, 1)) {
      out.push({ date: d, ...(this.series.get(d) ?? { clicks: 0, uniques: 0, bots: 0 }) });
    }
    return out;
  }

  breakdown(dim: Dim, limit = TOP_N): BreakdownRow[] {
    const m = this.dims.get(dim);
    if (!m) return [];
    return [...m.entries()]
      .map(([value, v]) => ({ value, clicks: v.clicks, bots: v.bots }))
      .sort((a, b) => b.clicks - a.clicks || b.bots - a.bots)
      .slice(0, limit);
  }
}

const COMBO_DIMS = ["country", "device", "source"] as const;

type Link = Required<LinkFilter>;

async function addD1(env: Env, agg: Aggregate, w: Windows, link: Link | undefined, withDims: boolean) {
  if (!w.d1) return;
  const slugSql = link === undefined ? "" : " AND domain = ?3 AND slug = ?4";
  const bind = (s: D1PreparedStatement) =>
    link === undefined ? s.bind(w.d1!.from, w.d1!.to) : s.bind(w.d1!.from, w.d1!.to, link.domain, link.slug);
  const stmts = [
    bind(
      env.DB.prepare(
        `SELECT date, SUM(clicks) AS clicks, SUM(uniques) AS uniques, SUM(bots) AS bots FROM daily_dims
         WHERE dim = 'total' AND date BETWEEN ?1 AND ?2${slugSql} GROUP BY date`,
      ),
    ),
    bind(
      env.DB.prepare(
        `SELECT country, device, source, SUM(clicks) AS clicks, SUM(bots) AS bots FROM daily_stats
         WHERE date BETWEEN ?1 AND ?2${slugSql} GROUP BY country, device, source`,
      ),
    ),
  ];
  if (withDims) {
    stmts.push(
      bind(
        env.DB.prepare(
          `SELECT dim, value, SUM(clicks) AS clicks, SUM(bots) AS bots FROM daily_dims
           WHERE dim NOT IN ('total', 'miss') AND date BETWEEN ?1 AND ?2${slugSql} GROUP BY dim, value`,
        ),
      ),
    );
  }
  const [series, combos, dims] = await env.DB.batch<Record<string, string | number>>(stmts);
  for (const r of series?.results ?? []) agg.addSeries(String(r.date), Number(r.clicks), Number(r.uniques), Number(r.bots));
  for (const r of combos?.results ?? []) {
    for (const d of COMBO_DIMS) agg.addDim(d, String(r[d] ?? ""), Number(r.clicks), Number(r.bots));
  }
  for (const r of dims?.results ?? []) agg.addDim(r.dim as Dim, String(r.value ?? ""), Number(r.clicks), Number(r.bots));
}

async function addAE(env: Env, agg: Aggregate, w: Windows, link: Link | undefined, withDims: boolean) {
  if (!w.ae) return;
  const { stats, dims } = await collectFromAE(env, w.ae.fromSec, w.ae.toSec, { link, dims: withDims, misses: false });
  for (const r of stats) for (const d of COMBO_DIMS) agg.addDim(d, r[d], r.clicks, r.bots);
  for (const r of dims) {
    if (r.dim === "total") agg.addSeries(r.date, r.clicks, r.uniques, r.bots);
    else if ((DIMS as readonly string[]).includes(r.dim)) agg.addDim(r.dim as Dim, r.value, r.clicks, r.bots);
  }
}

/** Runs the AE part but never lets an AE outage break the page. */
async function safeAE(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(JSON.stringify({ message: "AE stats query failed", error: String(err) }));
    return false;
  }
}

export async function linkStats(env: Env, domain: string, slug: string, range: Range, now = new Date()): Promise<LinkStatsDTO> {
  const w = await windows(env, range, now);
  const agg = new Aggregate();
  const link = { domain, slug };
  const [, aeOk] = await Promise.all([addD1(env, agg, w, link, true), safeAE(() => addAE(env, agg, w, link, true))]);
  const dims = Object.fromEntries(DIMS.map((d) => [d, agg.breakdown(d)])) as Record<Dim, BreakdownRow[]>;
  return {
    domain,
    slug,
    range,
    from: w.from,
    to: w.to,
    aeAvailable: w.aeAvailable && aeOk,
    totals: agg.totals(),
    series: agg.seriesList(w.from, w.to),
    dims,
  };
}

export async function overview(env: Env, range: Range, now = new Date()): Promise<OverviewDTO> {
  const w = await windows(env, range, now);
  const agg = new Aggregate();
  const perLink = new Map<string, Totals & Link>();
  const addLink = (domain: string, slug: string, clicks: number, uniques: number, bots: number) => {
    const key = linkKey(domain, slug);
    const t = perLink.get(key) ?? { domain, slug, clicks: 0, uniques: 0, bots: 0 };
    t.clicks += clicks;
    t.uniques += uniques;
    t.bots += bots;
    perLink.set(key, t);
  };

  const d1Links = async () => {
    if (!w.d1) return;
    const { results } = await env.DB.prepare(
      `SELECT domain, slug, SUM(clicks) AS clicks, SUM(uniques) AS uniques, SUM(bots) AS bots FROM daily_dims
       WHERE dim = 'total' AND date BETWEEN ?1 AND ?2 GROUP BY domain, slug ORDER BY clicks DESC LIMIT 500`,
    )
      .bind(w.d1.from, w.d1.to)
      .all<{ domain: string; slug: string; clicks: number; uniques: number; bots: number }>();
    for (const r of results) addLink(r.domain, r.slug, r.clicks, r.uniques, r.bots);
  };

  const ae = async () => {
    if (!w.ae) return;
    const { stats, dims } = await collectFromAE(env, w.ae.fromSec, w.ae.toSec, { dims: false, misses: false });
    for (const r of stats) for (const d of COMBO_DIMS) agg.addDim(d, r[d], r.clicks, r.bots);
    for (const r of dims) {
      if (r.dim !== "total") continue;
      agg.addSeries(r.date, r.clicks, r.uniques, r.bots);
      addLink(r.domain, r.slug, r.clicks, r.uniques, r.bots);
    }
  };

  const [, , aeOk] = await Promise.all([addD1(env, agg, w, undefined, false), d1Links(), safeAE(ae)]);

  const top = [...perLink.values()].sort((a, b) => b.clicks - a.clicks || b.bots - a.bots).slice(0, 20);
  const targets = await targetsFor(env, top);
  const topLinks: TopLink[] = top.map((t) => ({ ...t, target: targets.get(linkKey(t.domain, t.slug)) ?? null }));

  return {
    range,
    from: w.from,
    to: w.to,
    aeAvailable: w.aeAvailable && aeOk,
    totals: agg.totals(),
    series: agg.seriesList(w.from, w.to),
    topLinks,
    countries: agg.breakdown("country", 15),
    sources: agg.breakdown("source", 15),
    devices: agg.breakdown("device", 10),
  };
}

/** Targets keyed by linkKey. */
async function targetsFor(env: Env, links: Link[]): Promise<Map<string, string>> {
  if (links.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT l.domain, l.slug, l.target FROM json_each(?1) j
     JOIN links l ON l.domain = json_extract(j.value, '$[0]') AND l.slug = json_extract(j.value, '$[1]')`,
  )
    .bind(JSON.stringify(links.map((l) => [l.domain, l.slug])))
    .all<{ domain: string; slug: string; target: string }>();
  return new Map(results.map((r) => [linkKey(r.domain, r.slug), r.target]));
}

/** Display cap when real misses have no limit. */
const MAX_REPORT_ROWS = 5000;

export async function missReport(
  env: Env,
  range: Range,
  now = new Date(),
): Promise<{ aeAvailable: boolean; policy: MissPolicy; rows: MissRow[] }> {
  const [w, cleared, policy] = await Promise.all([windows(env, range, now), missesCleared(env.DB, now), getMissPolicy(env.DB, true)]);
  type Total = Link & { hits: number; bots: number; last: string };
  const totals = new Map<string, Total>();
  // Probe-looking paths on days "Clear scanner probes" hides, until the link check below says whether they're probes.
  const held = new Map<string, Total>();
  const addTo = (into: Map<string, Total>, domain: string, slug: string, hits: number, bots: number, last: string) => {
    const key = linkKey(domain, slug);
    const t = into.get(key) ?? { domain, slug, hits: 0, bots: 0, last };
    t.hits += hits;
    t.bots += bots;
    if (last > t.last) t.last = last;
    into.set(key, t);
  };
  const add = (domain: string, slug: string, hits: number, bots: number, last: string) =>
    addTo(isProbeCleared(cleared, slug, last) ? held : totals, domain, slug, hits, bots, last);
  const d1From = w.d1 && cleared.all !== null && cleared.all >= w.d1.from ? addDays(cleared.all, 1) : w.d1?.from;
  if (w.d1 && d1From && d1From <= w.d1.to) {
    const { results } = await env.DB.prepare(
      `SELECT d.domain, d.slug, SUM(d.clicks) AS hits, SUM(d.bots) AS bots, MAX(d.date) AS last FROM daily_dims d
       LEFT JOIN json_each(?3) c ON c.key = d.domain || '/' || d.slug
       WHERE d.dim = 'miss' AND d.date BETWEEN ?1 AND ?2 AND (c.value IS NULL OR d.date > c.value)
       GROUP BY d.domain, d.slug ORDER BY last DESC LIMIT 10000`,
    )
      .bind(d1From, w.d1.to, JSON.stringify(cleared.links))
      .all<{ domain: string; slug: string; hits: number; bots: number; last: string }>();
    for (const r of results) add(r.domain, r.slug, r.hits, r.bots, r.last);
  }
  const aeOk = await safeAE(async () => {
    if (!w.ae) return;
    const { dims } = await collectFromAE(env, w.ae.fromSec, w.ae.toSec, { dims: false, misses: true, missCutoffs: cleared.cutoffs });
    for (const r of dims) if (r.dim === "miss" && !isCleared(cleared, r.domain, r.slug, r.date)) add(r.domain, r.slug, r.clicks, r.bots, r.date);
  });

  // Flag misses that hit a disabled/expired link, or differ from a real slug on the same domain only by case.
  const matchStmt = env.DB.prepare(
    `SELECT json_extract(j.value, '$[0]') AS domain, json_extract(j.value, '$[1]') AS miss, l.slug, l.active, l.expires_at
     FROM json_each(?1) j
     JOIN links l ON l.domain = json_extract(j.value, '$[0]') AND l.slug = json_extract(j.value, '$[1]') COLLATE NOCASE`,
  );
  const chunks = jsonChunks([...totals.values(), ...held.values()].map((t) => [t.domain, t.slug]));
  const results = chunks.length
    ? (await env.DB.batch<{ domain: string; miss: string; slug: string; active: number; expires_at: number | null }>(chunks.map((c) => matchStmt.bind(c)))).flatMap(
        (r) => r.results,
      )
    : [];
  const matchesOf = new Map<string, typeof results>();
  for (const r of results) {
    const key = linkKey(r.domain, r.miss);
    matchesOf.set(key, [...(matchesOf.get(key) ?? []), r]);
  }
  // A held path that matches a link apart from case is a typo of it, not a probe: it stays. The rest stay cleared.
  for (const [key, t] of held) if (matchesOf.has(key)) addTo(totals, t.domain, t.slug, t.hits, t.bots, t.last);
  const all = [...totals.values()];
  const now_ = nowSec();
  const rows: MissRow[] = all.map((t) => {
    const matches = matchesOf.get(linkKey(t.domain, t.slug)) ?? [];
    const exact = matches.find((r) => r.slug === t.slug);
    const caseMatch = matches.find((r) => r.slug !== t.slug);
    let link: MissRow["link"] = "none";
    if (exact) link = !exact.active ? "disabled" : exact.expires_at !== null && exact.expires_at <= now_ ? "expired" : "active";
    // No link, not even one differing only by case: a scanner probe if the path looks like one.
    const probe = matches.length === 0 && isProbePath(t.slug);
    return { domain: t.domain, slug: t.slug, hits: t.hits, bots: t.bots, lastSeen: t.last, link, suggestion: caseMatch?.slug ?? null, probe };
  });

  // Each kind keeps its most recent paths, so a busy scanner can't push real misses out.
  const recent = (a: MissRow, b: MissRow) => byRecent({ ...a, last: a.lastSeen }, { ...b, last: b.lastSeen });
  // The pruner's rule: any link matching regardless of case means the path isn't a probe.
  const noisy = (r: MissRow) => isNoise(r.slug, r.hits, r.link !== "none" || r.suggestion !== null);
  const kept = [
    ...rows.filter((r) => !noisy(r)).sort(recent).slice(0, policy.realLimit || MAX_REPORT_ROWS),
    ...(policy.trackNoise ? rows.filter(noisy).sort(recent).slice(0, policy.noiseLimit) : []),
  ].sort((a, b) => b.hits - a.hits || b.bots - a.bots);
  return { aeAvailable: w.aeAvailable && aeOk, policy, rows: kept };
}

/** How long this isolate reuses the all-time rollup sums (they change only when a rollup runs). */
const ALL_TIME_MEMO_MS = 60_000;
let allTimeMemo: { to: string; at: number; clicks: Map<string, number> } | null = null;

/** Drops the memoized all-time sums (for tests). */
export function forgetAllTimeClicks(): void {
  allTimeMemo = null;
}

/** Human clicks per link (keyed by linkKey) over a range: rollups plus today's live data. */
export async function clicksByLink(env: Env, range: Range, now = new Date()): Promise<Map<string, number>> {
  const w = await windows(env, range, now);
  const out = new Map<string, number>();
  if (w.d1) {
    // "all" sums every day ever rolled up, on every links list: reuse it briefly. Keyed by the
    // last rolled day, so a new rollup is picked up at once; today's live clicks are never memoized.
    const memo = range === "all" && allTimeMemo?.to === w.d1.to && Date.now() - allTimeMemo.at < ALL_TIME_MEMO_MS ? allTimeMemo : null;
    if (memo) {
      for (const [k, v] of memo.clicks) out.set(k, v);
    } else {
      const { results } = await env.DB.prepare(
        `SELECT domain, slug, SUM(clicks) AS clicks FROM daily_dims WHERE dim = 'total' AND date BETWEEN ?1 AND ?2 GROUP BY domain, slug`,
      )
        .bind(w.d1.from, w.d1.to)
        .all<{ domain: string; slug: string; clicks: number }>();
      for (const r of results) out.set(linkKey(r.domain, r.slug), r.clicks);
      if (range === "all") allTimeMemo = { to: w.d1.to, at: Date.now(), clicks: new Map(out) };
    }
  }
  await safeAE(async () => {
    if (!w.ae) return;
    for (const r of await queryTotalsByLink(env, w.ae.fromSec, w.ae.toSec)) {
      const key = linkKey(r.domain, r.slug);
      out.set(key, (out.get(key) ?? 0) + r.clicks);
    }
  });
  return out;
}

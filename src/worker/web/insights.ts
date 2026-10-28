// Deeper site reports: when visitors and buyers arrive (peak hours), how pages
// are read (engagement), how customers get to their first purchase, and what
// customers are worth by the source that first brought them.
//
// Visitors are only as linkable as the site's identification mode: on a
// cookieless site a visitor id lasts one day, so paths and first sources
// only see that day.

import {
  SITE_ID_RE,
  type CustomerValueDTO,
  type CustomerValueRow,
  type EngagementDTO,
  type EngagementRow,
  type PageSpeedDTO,
  type VitalsRow,
  type PeakHoursDTO,
  type PeakMetric,
  type PurchasePathsDTO,
  type SiteDTO,
} from "../../shared/sites";
import { tzOffsetSec } from "../../shared/tz";
import { aeAvailable, aeQuery, webDataset } from "../ae";
import { AMOUNT, CUSTOMER, NEW_CHARGE, type Filters, type Window } from "./queries";

const median = (list: number[]): number | null => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

// ---- Peak hours -----------------------------------------------------------------------------

/** Weekday (Monday 0) and hour of an instant in the zone. */
function localSlot(sec: number, tz: string): { day: number; hour: number } {
  const local = new Date((sec + tzOffsetSec(tz, sec)) * 1000);
  return { day: (local.getUTCDay() + 6) % 7, hour: local.getUTCHours() };
}

export async function peakHours(db: D1Database, site: SiteDTO, w: Window, f: Filters, metric: PeakMetric): Promise<PeakHoursDTO> {
  // Counted per UTC hour in D1, then placed on the site's clock (a half-hour zone uses the hour's middle).
  const sql =
    metric === "visits"
      ? `SELECT s.started_at / 3600 AS h, COUNT(*) AS v FROM web_sessions s
         WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3${f.sql} GROUP BY h`
      : `SELECT p.occurred_at / 3600 AS h, ${metric === "sales" ? "COUNT(*)" : `SUM(${AMOUNT})`} AS v FROM payments p
         ${f.active ? "JOIN web_sessions s ON s.id = p.credited_session_id" : ""}
         WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.test_mode = 0 AND p.kind = 'charge'${f.sql} GROUP BY h`;
  const { results } = await db.prepare(sql).bind(site.id, w.start, w.end, ...f.binds).all<{ h: number; v: number | null }>();
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  for (const r of results) {
    const { day, hour } = localSlot(r.h * 3600 + 1800, site.timezone);
    const v = r.v ?? 0;
    cells[day]![hour]! += v;
    total += v;
  }
  const top = cells
    .flatMap((row, day) => row.map((value, hour) => ({ day, hour, value })))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
  return { metric, cells, top, total };
}

// ---- Reading engagement -----------------------------------------------------------------------

const DEEP_SCROLL = 75;
const ENGAGEMENT_ROWS = 20_000;

interface VisitReading {
  ms: number;
  scroll: number;
}

function engagementRows(byPath: Map<string, VisitReading[]>): EngagementRow[] {
  return [...byPath.entries()]
    .map(([path, visits]) => {
      const secs = visits.map((v) => v.ms / 1000);
      const scrolled = visits.filter((v) => v.scroll > 0);
      return {
        path,
        visits: visits.length,
        medianSec: Math.round(median(secs) ?? 0),
        avgSec: Math.round(secs.reduce((a, b) => a + b, 0) / visits.length),
        avgScroll: scrolled.length ? Math.round(scrolled.reduce((a, v) => a + v.scroll, 0) / scrolled.length) : 0,
        deepShare: scrolled.length ? scrolled.filter((v) => v.scroll >= DEEP_SCROLL).length / scrolled.length : 0,
      };
    })
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 100);
}

/** Reading time and scroll depth per page (Analytics Engine "engage" points), split by whether the visitor ever paid. */
export async function engagement(env: Env, site: SiteDTO, w: Window): Promise<EngagementDTO> {
  if (!aeAvailable(env)) return { available: false, all: [], buyers: [], others: [] };
  if (!SITE_ID_RE.test(site.id)) throw new Error("Refusing to query an invalid site id");
  const [rows, buyerSessions] = await Promise.all([
    aeQuery<{ path: string; session: string; ms: number | string; scroll: number | string }>(
      env,
      `SELECT blob2 AS path, blob16 AS session, sum(double2) AS ms, max(double5) AS scroll FROM ${webDataset(env)}
       WHERE index1 = '${site.id}' AND blob1 = 'engage' AND timestamp >= toDateTime(${Math.floor(w.start)}) AND timestamp < toDateTime(${Math.floor(w.end)})
       GROUP BY path, session ORDER BY ms DESC LIMIT ${ENGAGEMENT_ROWS}`,
    ),
    env.DB.prepare(
      `SELECT s.id FROM web_sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3
         AND s.visitor_id IN (SELECT visitor_id FROM payments WHERE site_id = ?1 AND kind = 'charge' AND test_mode = 0 AND visitor_id IS NOT NULL)`,
    )
      .bind(site.id, w.start - 86400, w.end)
      .all<{ id: string }>(),
  ]);
  const buyers = new Set(buyerSessions.results.map((r) => r.id));
  const all = new Map<string, VisitReading[]>();
  const bought = new Map<string, VisitReading[]>();
  const others = new Map<string, VisitReading[]>();
  const add = (m: Map<string, VisitReading[]>, path: string, v: VisitReading) => {
    const list = m.get(path);
    if (list) list.push(v);
    else m.set(path, [v]);
  };
  for (const r of rows) {
    const v = { ms: Number(r.ms) || 0, scroll: Math.min(100, Number(r.scroll) || 0) };
    const path = String(r.path ?? "");
    add(all, path, v);
    add(buyers.has(String(r.session)) ? bought : others, path, v);
  }
  return { available: true, all: engagementRows(all), buyers: engagementRows(bought), others: engagementRows(others) };
}

// ---- Page speed ----------------------------------------------------------------------------------

const VITALS = [
  { key: "lcpMs", col: "double6" },
  { key: "cls", col: "double7" },
  { key: "inpMs", col: "double8" },
] as const;

/**
 * p75 of each Core Web Vital, for the site and its busiest pages (Analytics
 * Engine "vitals" points). Each metric is its own query, over the loads that
 * measured it (0 means not measured; layout shift is stored × 1000 + 1).
 */
export async function pageSpeed(env: Env, site: SiteDTO, w: Window): Promise<PageSpeedDTO> {
  if (!aeAvailable(env)) return { available: false, overall: null, pages: [] };
  if (!SITE_ID_RE.test(site.id)) throw new Error("Refusing to query an invalid site id");
  const base = `FROM ${webDataset(env)} WHERE index1 = '${site.id}' AND blob1 = 'vitals' AND timestamp >= toDateTime(${Math.floor(w.start)}) AND timestamp < toDateTime(${Math.floor(w.end)})`;
  const results = await Promise.all(
    VITALS.flatMap(({ col }) => [
      aeQuery<{ loads: number | string; p75: number | string }>(env, `SELECT sum(_sample_interval) AS loads, quantileExactWeighted(0.75)(${col}, _sample_interval) AS p75 ${base} AND ${col} > 0`),
      aeQuery<{ path: string; loads: number | string; p75: number | string }>(
        env,
        `SELECT blob2 AS path, sum(_sample_interval) AS loads, quantileExactWeighted(0.75)(${col}, _sample_interval) AS p75 ${base} AND ${col} > 0 GROUP BY path ORDER BY loads DESC LIMIT 50`,
      ),
    ]),
  );
  const value = (key: (typeof VITALS)[number]["key"], raw: number | string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return key === "cls" ? Math.max(0, n - 1) / 1000 : Math.round(n);
  };
  const empty = (path: string): VitalsRow => ({ path, loads: 0, lcpMs: null, cls: null, inpMs: null });
  const overall = empty("");
  const pages = new Map<string, VitalsRow>();
  VITALS.forEach(({ key }, i) => {
    const whole = results[i * 2]![0];
    if (whole) {
      overall[key] = value(key, whole.p75);
      overall.loads = Math.max(overall.loads, Number(whole.loads) || 0);
    }
    for (const r of results[i * 2 + 1] as { path: string; loads: number | string; p75: number | string }[]) {
      const path = String(r.path ?? "");
      const row = pages.get(path) ?? empty(path);
      row[key] = value(key, r.p75);
      row.loads = Math.max(row.loads, Number(r.loads) || 0);
      pages.set(path, row);
    }
  });
  return {
    available: true,
    overall: overall.loads ? overall : null,
    pages: [...pages.values()].sort((a, b) => b.loads - a.loads).slice(0, 50),
  };
}

// ---- Path to purchase ---------------------------------------------------------------------------

const PATH_PAYMENTS = 2000;

/** First purchases in the window: is there an earlier charge from the same customer? */
const FIRST_PURCHASE = `${NEW_CHARGE} AND p.test_mode = 0 AND NOT EXISTS (
  SELECT 1 FROM payments e WHERE e.site_id = p.site_id AND e.kind = 'charge' AND e.test_mode = 0 AND e.occurred_at < p.occurred_at
    AND COALESCE(e.customer_id, e.email, e.visitor_id, e.id) = ${CUSTOMER})`;

export async function purchasePaths(db: D1Database, site: SiteDTO, w: Window): Promise<PurchasePathsDTO> {
  const [buys, pages] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT p.id, p.occurred_at AS paid_at, ${AMOUNT} AS amount,
           (SELECT MIN(s.started_at) FROM web_sessions s WHERE s.site_id = p.site_id AND s.visitor_id = p.visitor_id) AS first_at,
           (SELECT COUNT(*) FROM web_sessions s WHERE s.site_id = p.site_id AND s.visitor_id = p.visitor_id AND s.started_at <= p.occurred_at) AS visits,
           (SELECT s.source FROM web_sessions s WHERE s.site_id = p.site_id AND s.visitor_id = p.visitor_id ORDER BY s.started_at LIMIT 1) AS found,
           (SELECT s.source FROM web_sessions s WHERE s.id = p.credited_session_id) AS credited
         FROM payments p
         WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.visitor_id IS NOT NULL AND ${FIRST_PURCHASE}
         ORDER BY p.occurred_at DESC LIMIT ${PATH_PAYMENTS}`,
      )
      .bind(site.id, w.start, w.end),
    db
      .prepare(
        `SELECT s.entry_path AS path, COUNT(DISTINCT p.id) AS customers
         FROM payments p JOIN web_sessions s ON s.site_id = p.site_id AND s.visitor_id = p.visitor_id AND s.started_at <= p.occurred_at
         WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.visitor_id IS NOT NULL AND s.entry_path != '' AND ${FIRST_PURCHASE}
         GROUP BY path ORDER BY customers DESC LIMIT 20`,
      )
      .bind(site.id, w.start, w.end),
  ]);
  const rows = ((buys?.results ?? []) as { paid_at: number; amount: number; first_at: number | null; visits: number; found: string | null; credited: string | null }[]).filter(
    (r) => r.first_at !== null && r.visits > 0,
  );
  const pairs = new Map<string, { found: string; credited: string; customers: number; revenue: number }>();
  for (const r of rows) {
    const found = r.found ?? "";
    const credited = r.credited ?? "";
    const key = `${found}\u0000${credited}`;
    const e = pairs.get(key) ?? { found, credited, customers: 0, revenue: 0 };
    e.customers++;
    e.revenue += r.amount ?? 0;
    pairs.set(key, e);
  }
  const hours = median(rows.map((r) => Math.max(0, r.paid_at - (r.first_at ?? r.paid_at)) / 3600));
  return {
    customers: rows.length,
    medianHoursToBuy: hours === null ? null : Math.round(hours * 10) / 10,
    medianVisits: median(rows.map((r) => r.visits)),
    firstVisitShare: rows.length ? rows.filter((r) => r.visits === 1).length / rows.length : 0,
    pairs: [...pairs.values()].sort((a, b) => b.customers - a.customers || b.revenue - a.revenue).slice(0, 15),
    pages: ((pages?.results ?? []) as { path: string; customers: number }[]).map((r) => ({ path: r.path, customers: r.customers })),
  };
}

// ---- Lifetime value -------------------------------------------------------------------------------

/** Customers whose first charge is in the window, with everything they've paid since, by the source of their first visit. */
export async function customerValue(db: D1Database, site: SiteDTO, w: Window): Promise<CustomerValueDTO> {
  const { results } = await db
    .prepare(
      `WITH c AS (
         SELECT ${CUSTOMER} AS cust, MIN(CASE WHEN p.kind = 'charge' THEN p.occurred_at END) AS first_at, MAX(p.visitor_id) AS vid,
           SUM(${AMOUNT}) AS lifetime, SUM(CASE WHEN p.kind = 'charge' THEN 1 ELSE 0 END) AS charges
         FROM payments p WHERE p.site_id = ?1 AND p.test_mode = 0
         GROUP BY cust HAVING first_at >= ?2 AND first_at < ?3
       )
       SELECT c.lifetime, c.charges,
         (SELECT s.source FROM web_sessions s WHERE s.site_id = ?1 AND s.visitor_id = c.vid ORDER BY s.started_at LIMIT 1) AS source,
         (SELECT s.channel FROM web_sessions s WHERE s.site_id = ?1 AND s.visitor_id = c.vid ORDER BY s.started_at LIMIT 1) AS channel
       FROM c`,
    )
    .bind(site.id, w.start, w.end)
    .all<{ lifetime: number | null; charges: number; source: string | null; channel: string | null }>();
  const groups = new Map<string, CustomerValueRow & { repeat: number }>();
  for (const r of results) {
    const source = r.source ?? "";
    const channel = r.channel ?? "";
    const key = `${channel}\u0000${source}`;
    const g = groups.get(key) ?? { source, channel, customers: 0, lifetimeRevenue: 0, avgValue: 0, repeatShare: 0, repeat: 0 };
    g.customers++;
    g.lifetimeRevenue += r.lifetime ?? 0;
    if (r.charges > 1) g.repeat++;
    groups.set(key, g);
  }
  const rows: CustomerValueRow[] = [...groups.values()]
    .map(({ repeat, ...g }) => ({ ...g, avgValue: Math.round(g.lifetimeRevenue / g.customers), repeatShare: repeat / g.customers }))
    .sort((a, b) => b.lifetimeRevenue - a.lifetimeRevenue);
  return { rows, customers: results.length, lifetimeRevenue: rows.reduce((s, r) => s + r.lifetimeRevenue, 0) };
}

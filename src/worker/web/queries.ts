// The site dashboard's numbers. Visits and revenue come from D1 (sessions and
// payments, kept as long as the site exists); page, goal and outbound lists
// come from Analytics Engine (the last 90 days).
//
// Days are the site's own (its time zone, DST-correct); revenue is in the
// site's currency, net of refunds and disputes, test payments left out. Each
// payment is credited to one visit, so revenue by any dimension adds up to the
// total, plus a "not matched" row for payments no visit could be found for.

import { addDays, dateFromDaySec, dayStartSec, periodBounds } from "../../shared/dates";
import {
  GOAL_NAME_RE,
  SITE_ID_RE,
  type GoalPropRow,
  type EventList,
  type EventListRow,
  type Granularity,
  type LinkRevenueDTO,
  type SessionDTO,
  type SiteBreakdownRow,
  type SiteDim,
  type SiteDTO,
  type SitePaymentDTO,
  type SitePoint,
  type SiteSpikeDTO,
  type SiteSummary,
  type SiteQuery,
  type SiteTotals,
  type SubscriptionStatsDTO,
  type VisitorProfileDTO,
  SITE_DIMS,
} from "../../shared/sites";
import { bucketEdges, localDate, localMidnight } from "../../shared/tz";
import { aeAvailable, aeQuery, webDataset } from "../ae";
import { aeFirstDay } from "./rollup";

const utcDayOf = (sec: number) => dateFromDaySec(Math.floor(sec / 86400) * 86400);

export const NOT_MATCHED = "(not matched)";
const ONLINE_SEC = 5 * 60;

/** Session column (or expression) of each dimension. Fixed strings only: never user input. */
export const DIM_COLUMN: Record<SiteDim, string> = {
  channel: "s.channel",
  source: "s.source",
  referrer: "s.referrer_host",
  campaign: "s.utm_campaign",
  utm_source: "s.utm_source",
  utm_medium: "s.utm_medium",
  utm_term: "s.utm_term",
  utm_content: "s.utm_content",
  link: "CASE WHEN s.link_slug = '' THEN '' ELSE s.link_domain || '/' || s.link_slug END",
  entry: "s.entry_path",
  exit: "s.exit_path",
  hostname: "s.hostname",
  country: "s.country",
  region: "s.region",
  city: "s.city",
  device: "s.device",
  os: "s.os",
  browser: "s.browser",
  language: "s.language",
  org: "s.org",
  continent: "s.continent",
  timezone: "s.timezone",
  screen: "s.screen",
  visitor_type: "CASE WHEN s.return_visit = 1 THEN 'returning' ELSE 'new' END",
};

/** Net amount in the site currency (a payment whose rate isn't known yet counts 0 until it is). */
export const AMOUNT = "COALESCE(p.amount_site_minor, 0)";
/** One customer: their provider id, else email, else the visitor, else the payment. */
export const CUSTOMER = "COALESCE(p.customer_id, p.email, p.visitor_id, p.id)";
export const NEW_CHARGE = "p.kind = 'charge' AND p.billing != 'sub_renewal'";

export interface Window {
  from: string;
  to: string;
  start: number;
  end: number;
  granularity: Granularity;
}

/** The query's period in the site's days. "All time" starts on the day the site was added. */
export function windowOf(site: SiteDTO, q: Pick<SiteQuery, "range" | "from" | "to" | "granularity">, now = Date.now()): Window {
  const today = localDate(Math.floor(now / 1000), site.timezone);
  let { from, to } = periodBounds({ range: q.range, from: q.from, to: q.to }, new Date(`${today}T12:00:00Z`));
  const created = localDate(site.createdAt, site.timezone);
  if (q.range === "all" || from < "2000-01-02") from = created < to ? created : to;
  const start = localMidnight(from, site.timezone);
  const end = localMidnight(new Date(Date.parse(`${to}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10), site.timezone);
  const days = (end - start) / 86400;
  const auto: Granularity = days <= 2 ? "hour" : days <= 92 ? "day" : days <= 400 ? "week" : "month";
  let granularity = q.granularity ?? auto;
  // An hourly chart of a long period would be thousands of points.
  if (granularity === "hour" && days > 7) granularity = "day";
  return { from, to, start, end, granularity };
}

export interface Filters {
  sql: string;
  binds: unknown[];
  active: boolean;
}

/** Equality filters on session dimensions, as SQL on alias "s" with numbered parameters from `first`. */
export function filtersOf(q: SiteQuery, first: number): Filters {
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const dim of SITE_DIMS) {
    const v = (q as Record<string, unknown>)[`f_${dim}`];
    if (typeof v !== "string") continue;
    binds.push(v);
    parts.push(`${DIM_COLUMN[dim]} = ?${first + binds.length - 1}`);
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", binds, active: parts.length > 0 };
}

interface TrafficRow {
  sessions: number;
  visitors: number;
  pageviews: number | null;
  bounces: number | null;
  engaged: number | null;
  goal_visitors: number | null;
  checkout_visitors: number | null;
  link_visitors: number | null;
}

interface MoneyRow {
  revenue: number | null;
  gross: number | null;
  refunds: number | null;
  payments: number;
  customers: number;
}

/** Revenue in a window: credited to filtered visits, or (without filters) everything, matched or not. */
function moneySql(f: Filters): string {
  const base = `FROM payments p ${f.active ? "JOIN web_sessions s ON s.id = p.credited_session_id" : ""}
    WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.test_mode = 0${f.sql}`;
  return `SELECT SUM(${AMOUNT}) AS revenue,
      SUM(CASE WHEN p.kind = 'charge' THEN ${AMOUNT} ELSE 0 END) AS gross,
      -SUM(CASE WHEN p.kind IN ('refund', 'dispute') THEN ${AMOUNT} ELSE 0 END) AS refunds,
      SUM(CASE WHEN p.kind = 'charge' THEN 1 ELSE 0 END) AS payments,
      COUNT(DISTINCT CASE WHEN ${NEW_CHARGE} THEN ${CUSTOMER} END) AS customers ${base}`;
}

export async function totals(db: D1Database, site: SiteDTO, start: number, end: number, f: Filters): Promise<SiteTotals> {
  const [traffic, money] = await db.batch<TrafficRow | MoneyRow>([
    db
      .prepare(
        `SELECT COUNT(*) AS sessions, COUNT(DISTINCT s.visitor_id) AS visitors, SUM(s.pageviews) AS pageviews,
           SUM(CASE WHEN s.pageviews <= 1 AND s.goals = 0 THEN 1 ELSE 0 END) AS bounces, AVG(s.engaged_ms) AS engaged,
           COUNT(DISTINCT CASE WHEN s.goals > 0 THEN s.visitor_id END) AS goal_visitors,
           COUNT(DISTINCT CASE WHEN s.checkout_at IS NOT NULL THEN s.visitor_id END) AS checkout_visitors,
           COUNT(DISTINCT CASE WHEN s.link_slug != '' THEN s.visitor_id END) AS link_visitors
         FROM web_sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3${f.sql}`,
      )
      .bind(site.id, start, end, ...f.binds),
    db.prepare(moneySql(f)).bind(site.id, start, end, ...f.binds),
  ]);
  const t = (traffic?.results[0] ?? {}) as Partial<TrafficRow>;
  const m = (money?.results[0] ?? {}) as Partial<MoneyRow>;
  const visitors = t.visitors ?? 0;
  const sessions = t.sessions ?? 0;
  const revenue = m.revenue ?? 0;
  const customers = m.customers ?? 0;
  return {
    visitors,
    sessions,
    pageviews: t.pageviews ?? 0,
    bounceRate: sessions ? (t.bounces ?? 0) / sessions : 0,
    avgEngagedSec: Math.round((t.engaged ?? 0) / 1000),
    revenue,
    grossRevenue: m.gross ?? 0,
    refunds: m.refunds ?? 0,
    payments: m.payments ?? 0,
    customers,
    conversion: visitors ? Math.min(1, customers / visitors) : 0,
    revenuePerVisitor: visitors ? Math.round(revenue / visitors) : 0,
    goalVisitors: t.goal_visitors ?? 0,
    checkoutVisitors: t.checkout_visitors ?? 0,
    linkVisitors: t.link_visitors ?? 0,
  };
}

/** Bucket boundaries as a VALUES list of integer literals (numbers only). */
function bucketsCte(edges: number[]): string {
  const rows: string[] = [];
  for (let i = 0; i < edges.length - 1; i++) rows.push(`(${i}, ${Math.floor(edges[i]!)}, ${Math.floor(edges[i + 1]!)})`);
  return `WITH b(i, lo, hi) AS (VALUES ${rows.join(", ")})`;
}

export async function series(db: D1Database, site: SiteDTO, w: Window, f: Filters): Promise<SitePoint[]> {
  const edges = bucketEdges(w.from, w.to, site.timezone, w.granularity);
  const points: SitePoint[] = edges.slice(0, -1).map((t) => ({ t, visitors: 0, sessions: 0, pageviews: 0, revenue: 0, payments: 0, engagedMs: 0, goalSessions: 0 }));
  if (!points.length) return points;
  const cte = bucketsCte(edges);
  const [traffic, money] = await db.batch<{ i: number; visitors?: number; sessions?: number; pageviews?: number; revenue?: number; payments?: number; engaged?: number; converted?: number }>([
    db
      .prepare(
        `${cte} SELECT b.i AS i, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews,
           SUM(s.engaged_ms) AS engaged, SUM(CASE WHEN s.goals > 0 THEN 1 ELSE 0 END) AS converted
         FROM b JOIN web_sessions s ON s.site_id = ?1 AND s.started_at >= b.lo AND s.started_at < b.hi
         WHERE s.started_at >= ?2 AND s.started_at < ?3${f.sql} GROUP BY b.i`,
      )
      .bind(site.id, w.start, w.end, ...f.binds),
    db
      .prepare(
        `${cte} SELECT b.i AS i, SUM(${AMOUNT}) AS revenue, SUM(CASE WHEN p.kind = 'charge' THEN 1 ELSE 0 END) AS payments
         FROM b JOIN payments p ON p.site_id = ?1 AND p.occurred_at >= b.lo AND p.occurred_at < b.hi
         ${f.active ? "JOIN web_sessions s ON s.id = p.credited_session_id" : ""}
         WHERE p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.test_mode = 0${f.sql} GROUP BY b.i`,
      )
      .bind(site.id, w.start, w.end, ...f.binds),
  ]);
  for (const r of traffic?.results ?? []) {
    const p = points[r.i];
    if (p) Object.assign(p, { visitors: r.visitors ?? 0, sessions: r.sessions ?? 0, pageviews: r.pageviews ?? 0, engagedMs: r.engaged ?? 0, goalSessions: r.converted ?? 0 });
  }
  for (const r of money?.results ?? []) {
    const p = points[r.i];
    if (p) Object.assign(p, { revenue: r.revenue ?? 0, payments: r.payments ?? 0 });
  }
  return points;
}

/** The window just before `w`, of the same number of days, in the same buckets. */
export function previousWindow(site: SiteDTO, w: Window): Window {
  const days = Math.round((w.end - w.start) / 86400);
  const to = addDays(w.from, -1);
  const from = addDays(to, -(days - 1));
  const start = localMidnight(from, site.timezone);
  return { from, to, start, end: w.start, granularity: w.granularity };
}

/** Traffic spikes detected in the window, oldest first. */
export async function spikesIn(db: D1Database, siteId: string, w: Window): Promise<SiteSpikeDTO[]> {
  const { results } = await db
    .prepare("SELECT source, detected_at AS t, visits, baseline FROM site_spikes WHERE site_id = ?1 AND detected_at >= ?2 AND detected_at < ?3 ORDER BY detected_at LIMIT 50")
    .bind(siteId, w.start, w.end)
    .all<SiteSpikeDTO>();
  return results;
}

export async function onlineNow(db: D1Database, siteId: string, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const row = await db.prepare("SELECT COUNT(DISTINCT visitor_id) AS n FROM web_sessions WHERE site_id = ?1 AND last_seen_at > ?2").bind(siteId, now - ONLINE_SEC).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function unmatchedCount(db: D1Database, siteId: string, start: number, end: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE site_id = ?1 AND kind = 'charge' AND session_id IS NULL AND personal_cleared_at IS NULL AND test_mode = 0 AND occurred_at >= ?2 AND occurred_at < ?3")
    .bind(siteId, start, end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function breakdown(db: D1Database, site: SiteDTO, dim: SiteDim, w: Window, f: Filters, limit: number): Promise<SiteBreakdownRow[]> {
  const col = DIM_COLUMN[dim];
  const [traffic, money, unmatched] = await db.batch<{ value: string; visitors?: number; sessions?: number; pageviews?: number; revenue?: number; customers?: number }>([
    db
      .prepare(
        `SELECT ${col} AS value, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, SUM(s.pageviews) AS pageviews
         FROM web_sessions s WHERE s.site_id = ?1 AND s.started_at >= ?2 AND s.started_at < ?3${f.sql}
         GROUP BY value ORDER BY visitors DESC LIMIT ${Math.floor(limit)}`,
      )
      .bind(site.id, w.start, w.end, ...f.binds),
    db
      .prepare(
        `SELECT ${col} AS value, SUM(${AMOUNT}) AS revenue, COUNT(DISTINCT CASE WHEN ${NEW_CHARGE} THEN ${CUSTOMER} END) AS customers
         FROM payments p JOIN web_sessions s ON s.id = p.credited_session_id
         WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.test_mode = 0${f.sql}
         GROUP BY value ORDER BY revenue DESC LIMIT ${Math.floor(limit)}`,
      )
      .bind(site.id, w.start, w.end, ...f.binds),
    db
      .prepare(
        `SELECT '' AS value, SUM(${AMOUNT}) AS revenue, COUNT(DISTINCT CASE WHEN ${NEW_CHARGE} THEN ${CUSTOMER} END) AS customers
         FROM payments p WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.test_mode = 0 AND p.credited_session_id IS NULL`,
      )
      .bind(site.id, w.start, w.end),
  ]);
  const rows = new Map<string, SiteBreakdownRow>();
  const row = (value: string) => {
    let r = rows.get(value);
    if (!r) rows.set(value, (r = { value, visitors: 0, sessions: 0, pageviews: 0, revenue: 0, customers: 0 }));
    return r;
  };
  for (const r of traffic?.results ?? []) Object.assign(row(r.value ?? ""), { visitors: r.visitors ?? 0, sessions: r.sessions ?? 0, pageviews: r.pageviews ?? 0 });
  for (const r of money?.results ?? []) Object.assign(row(r.value ?? ""), { revenue: r.revenue ?? 0, customers: r.customers ?? 0 });
  const u = unmatched?.results[0];
  if (!f.active && u?.revenue) Object.assign(row(NOT_MATCHED), { revenue: u.revenue, customers: u.customers ?? 0 });
  return [...rows.values()].sort((a, b) => b.visitors - a.visitors || b.revenue - a.revenue);
}

/** Pages, goals or outbound links over the window (Analytics Engine; its 90 days at most). */
export async function eventList(env: Env, site: SiteDTO, list: EventList, w: Window): Promise<EventListRow[]> {
  if (!aeAvailable(env)) return [];
  if (!SITE_ID_RE.test(site.id)) throw new Error("Refusing to query an invalid site id");
  const value = list === "pages" ? "blob2" : "blob18";
  const events = list === "pages" ? "blob1 = 'pageview'" : list === "goals" ? "blob1 = 'goal'" : "blob1 IN ('outbound', 'checkout')";
  // Analytics Engine has the last 90 days; whole days before that come from the daily rollup.
  const aeStart = dayStartSec(aeFirstDay());
  const from = Math.max(Math.floor(w.start), aeStart);
  const [rows, older] = await Promise.all([
    from < w.end
      ? aeQuery<{ value: string; visitors: number | string; count: number | string }>(
          env,
          `SELECT ${value} AS value, count(DISTINCT blob17) AS visitors, sum(_sample_interval) AS count FROM ${webDataset(env)}
           WHERE index1 = '${site.id}' AND ${events} AND timestamp >= toDateTime(${from}) AND timestamp < toDateTime(${Math.floor(w.end)})
           GROUP BY value ORDER BY count DESC LIMIT 200`,
        )
      : Promise.resolve([]),
    w.start < aeStart
      ? db(env)
          .prepare(
            `SELECT name AS value, SUM(visitors) AS visitors, SUM(events) AS count FROM web_daily_events
             WHERE site_id = ?1 AND kind IN (${list === "pages" ? "'pageview'" : list === "goals" ? "'goal'" : "'outbound', 'checkout'"}) AND day >= ?2 AND day < ?3
             GROUP BY name ORDER BY count DESC LIMIT 500`,
          )
          .bind(site.id, utcDayOf(w.start), aeFirstDay())
          .all<{ value: string; visitors: number; count: number }>()
          .then((r) => r.results)
      : Promise.resolve([]),
  ]);
  const merged = new Map<string, EventListRow>();
  for (const r of [...rows, ...older]) {
    const key = String(r.value ?? "");
    const row = merged.get(key) ?? { value: key, visitors: 0, count: 0 };
    // Visitors of different days add up: someone who came on two days counts twice.
    row.visitors += Number(r.visitors) || 0;
    row.count += Number(r.count) || 0;
    merged.set(key, row);
  }
  const out: EventListRow[] = [...merged.values()].sort((a, b) => b.count - a.count).slice(0, 200);
  if (list === "pages") {
    // Revenue of the visits that started on each page (exclusive: adds up to the total).
    const { results } = await db(env)
      .prepare(
        `SELECT s.entry_path AS value, SUM(${AMOUNT}) AS revenue FROM payments p JOIN web_sessions s ON s.id = p.credited_session_id
         WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3 AND p.test_mode = 0 GROUP BY value`,
      )
      .bind(site.id, w.start, w.end)
      .all<{ value: string; revenue: number }>();
    const byPath = new Map(results.map((r) => [r.value, r.revenue]));
    for (const r of out) r.revenue = byPath.get(r.value) ?? 0;
  }
  return out;
}

/** The properties sent with one goal, split into key and value (Analytics Engine; its 90 days at most). */
export async function goalProps(env: Env, site: SiteDTO, name: string, w: Window): Promise<GoalPropRow[]> {
  if (!aeAvailable(env)) return [];
  if (!SITE_ID_RE.test(site.id)) throw new Error("Refusing to query an invalid site id");
  if (!GOAL_NAME_RE.test(name)) throw new Error("Refusing to query an invalid goal name");
  const rows = await aeQuery<{ props: string; visitors: number | string; count: number | string }>(
    env,
    `SELECT blob20 AS props, count(DISTINCT blob17) AS visitors, sum(_sample_interval) AS count FROM ${webDataset(env)}
     WHERE index1 = '${site.id}' AND blob1 = 'goal' AND blob18 = '${name}' AND timestamp >= toDateTime(${Math.floor(w.start)}) AND timestamp < toDateTime(${Math.floor(w.end)})
     GROUP BY props ORDER BY count DESC LIMIT 500`,
  );
  // Visitors are counted per combination of properties, so a value's total can count someone twice.
  const out = new Map<string, GoalPropRow>();
  for (const r of rows) {
    for (const part of String(r.props ?? "").split("; ")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq);
      const value = part.slice(eq + 1);
      const id = `${key}=${value}`;
      const row = out.get(id) ?? { key, value, visitors: 0, count: 0 };
      row.visitors += Number(r.visitors) || 0;
      row.count += Number(r.count) || 0;
      out.set(id, row);
    }
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key) || b.count - a.count);
}

const db = (env: Env) => env.DB;

// ---- Payments, visits and visitors ------------------------------------------------------

interface PaymentJoinRow {
  id: string;
  provider: string;
  kind: string;
  billing: string;
  occurred_at: number;
  amount_minor: number;
  currency: string;
  amount_site_minor: number | null;
  email: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  matched_by: string | null;
  confidence: string | null;
  unmatched_reason: string | null;
  test_mode: number;
  visitor_id: string | null;
  [key: string]: unknown;
}

const SESSION_BRIEF = (a: string) =>
  `${a}.id AS ${a}_id, ${a}.started_at AS ${a}_started, ${a}.channel AS ${a}_channel, ${a}.source AS ${a}_source, ${a}.utm_campaign AS ${a}_campaign,
   CASE WHEN ${a}.link_slug = '' THEN '' ELSE ${a}.link_domain || '/' || ${a}.link_slug END AS ${a}_link, ${a}.entry_path AS ${a}_entry, ${a}.country AS ${a}_country`;

function brief(r: PaymentJoinRow, a: string): SitePaymentDTO["session"] {
  if (!r[`${a}_id`]) return null;
  return {
    id: String(r[`${a}_id`]),
    startedAt: Number(r[`${a}_started`]),
    channel: String(r[`${a}_channel`] ?? ""),
    source: String(r[`${a}_source`] ?? ""),
    campaign: String(r[`${a}_campaign`] ?? ""),
    link: String(r[`${a}_link`] ?? ""),
    entry: String(r[`${a}_entry`] ?? ""),
    country: String(r[`${a}_country`] ?? ""),
  };
}

function paymentDTO(r: PaymentJoinRow): SitePaymentDTO {
  return {
    id: r.id,
    provider: r.provider,
    kind: r.kind,
    billing: r.billing,
    occurredAt: r.occurred_at,
    amountMinor: r.amount_minor,
    currency: r.currency,
    amountSiteMinor: r.amount_site_minor,
    email: r.email,
    customerId: r.customer_id,
    subscriptionId: r.subscription_id,
    matchedBy: r.matched_by,
    confidence: r.confidence,
    unmatchedReason: r.unmatched_reason,
    testMode: r.test_mode === 1,
    visitorId: r.visitor_id,
    session: brief(r, "ms"),
    credited: brief(r, "cs"),
  };
}

const PAYMENTS_SELECT = `SELECT p.*, ${SESSION_BRIEF("ms")}, ${SESSION_BRIEF("cs")} FROM payments p
  LEFT JOIN web_sessions ms ON ms.id = p.session_id LEFT JOIN web_sessions cs ON cs.id = p.credited_session_id`;

export interface PaymentsPage {
  payments: SitePaymentDTO[];
  /** Matching payments in the period, for paging. */
  total: number;
  /** Net amount of every matching payment, site currency (tests left out). */
  net: number;
}

/**
 * A page of the period's payments, newest first. `q` finds a customer email,
 * customer id or payment id (part of it).
 */
export async function payments(
  d1: D1Database,
  site: SiteDTO,
  w: Window,
  opts: { status: "all" | "matched" | "unmatched"; limit: number; offset?: number; q?: string },
): Promise<PaymentsPage> {
  let where = opts.status === "matched" ? " AND p.session_id IS NOT NULL" : opts.status === "unmatched" ? " AND p.session_id IS NULL AND p.kind = 'charge' AND p.personal_cleared_at IS NULL" : "";
  const binds: unknown[] = [site.id, w.start, w.end];
  const q = opts.q?.trim().toLowerCase();
  if (q) {
    // "!" escapes LIKE's wildcards, so "50%" or "a_b" are searched as typed.
    binds.push(`%${q.replace(/[%_!]/g, (c) => `!${c}`)}%`);
    where += ` AND (lower(COALESCE(p.email, '')) LIKE ?4 ESCAPE '!' OR lower(COALESCE(p.customer_id, '')) LIKE ?4 ESCAPE '!' OR lower(p.id) LIKE ?4 ESCAPE '!')`;
  }
  const base = `FROM payments p WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3${where}`;
  const [page, count] = await d1.batch<Record<string, unknown>>([
    d1
      .prepare(`${PAYMENTS_SELECT} WHERE p.site_id = ?1 AND p.occurred_at >= ?2 AND p.occurred_at < ?3${where} ORDER BY p.occurred_at DESC, p.created_at DESC, p.rowid DESC LIMIT ${Math.floor(opts.limit)} OFFSET ${Math.floor(opts.offset ?? 0)}`)
      .bind(...binds),
    d1.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN p.test_mode = 0 THEN COALESCE(p.amount_site_minor, 0) ELSE 0 END) AS net ${base}`).bind(...binds),
  ]);
  const c = (count?.results[0] ?? {}) as { n?: number; net?: number | null };
  return { payments: ((page?.results ?? []) as unknown as PaymentJoinRow[]).map(paymentDTO), total: c.n ?? 0, net: c.net ?? 0 };
}

interface SessionRow {
  id: string;
  visitor_id: string;
  started_at: number;
  last_seen_at: number;
  pageviews: number;
  goals: number;
  engaged_ms: number;
  channel: string;
  source: string;
  utm_campaign: string;
  link_domain: string;
  link_slug: string;
  entry_path: string;
  exit_path: string;
  country: string;
  city: string;
  device: string;
  browser: string;
  os: string;
}

export function sessionDTO(r: SessionRow): SessionDTO {
  return {
    id: r.id,
    visitorId: r.visitor_id,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
    pageviews: r.pageviews,
    goals: r.goals,
    engagedSec: Math.round(r.engaged_ms / 1000),
    channel: r.channel,
    source: r.source,
    campaign: r.utm_campaign,
    link: r.link_slug ? `${r.link_domain}/${r.link_slug}` : "",
    entry: r.entry_path,
    exit: r.exit_path,
    country: r.country,
    city: r.city,
    device: r.device,
    browser: r.browser,
    os: r.os,
  };
}

/** The latest visits, newest first (the live list). */
export async function recentSessions(d1: D1Database, siteId: string, limit: number): Promise<SessionDTO[]> {
  const { results } = await d1.prepare(`SELECT * FROM web_sessions WHERE site_id = ?1 ORDER BY last_seen_at DESC LIMIT ${Math.floor(limit)}`).bind(siteId).all<SessionRow>();
  return results.map(sessionDTO);
}

export async function visitorProfile(d1: D1Database, site: SiteDTO, visitorId: string): Promise<VisitorProfileDTO> {
  const [who, sessions, pays] = await d1.batch<Record<string, unknown>>([
    d1.prepare("SELECT email, name FROM web_visitors WHERE site_id = ?1 AND id = ?2").bind(site.id, visitorId),
    d1.prepare("SELECT * FROM web_sessions WHERE site_id = ?1 AND visitor_id = ?2 ORDER BY started_at DESC LIMIT 200").bind(site.id, visitorId),
    d1.prepare(`${PAYMENTS_SELECT} WHERE p.site_id = ?1 AND p.visitor_id = ?2 ORDER BY p.occurred_at DESC LIMIT 200`).bind(site.id, visitorId),
  ]);
  const w = (who?.results[0] ?? {}) as { email?: string | null; name?: string | null };
  return {
    siteId: site.id,
    visitorId,
    email: w.email ?? null,
    name: w.name ?? null,
    sessions: ((sessions?.results ?? []) as unknown as SessionRow[]).map(sessionDTO),
    payments: ((pays?.results ?? []) as unknown as PaymentJoinRow[]).map(paymentDTO),
  };
}

// ---- Subscriptions -----------------------------------------------------------------------

export async function subscriptionStats(d1: D1Database, site: SiteDTO, w: Window): Promise<SubscriptionStatsDTO> {
  const [mrr, started, canceled, split] = await d1.batch<Record<string, number | null>>([
    // MRR of live subscriptions; where the provider gave no price (Lemon Squeezy), the latest payment counts as a month.
    d1
      .prepare(
        `SELECT COUNT(*) AS active, SUM(COALESCE(sub.mrr_site_minor,
           (SELECT p.amount_site_minor FROM payments p WHERE p.site_id = sub.site_id AND p.provider = sub.provider AND p.kind = 'charge'
              AND p.subscription_id = substr(sub.id, length(sub.provider) + 2) ORDER BY p.occurred_at DESC LIMIT 1), 0)) AS mrr
         FROM subscriptions sub WHERE sub.site_id = ?1 AND sub.status IN ('active', 'past_due')`,
      )
      .bind(site.id),
    d1.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3").bind(site.id, w.start, w.end),
    d1.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE site_id = ?1 AND COALESCE(canceled_at, ended_at) >= ?2 AND COALESCE(canceled_at, ended_at) < ?3 AND status IN ('canceled', 'ended')").bind(site.id, w.start, w.end),
    d1
      .prepare(
        `SELECT SUM(CASE WHEN billing = 'sub_renewal' THEN 0 ELSE COALESCE(amount_site_minor, 0) END) AS new_revenue,
                SUM(CASE WHEN billing = 'sub_renewal' THEN COALESCE(amount_site_minor, 0) ELSE 0 END) AS renewal_revenue
         FROM payments WHERE site_id = ?1 AND kind = 'charge' AND test_mode = 0 AND occurred_at >= ?2 AND occurred_at < ?3`,
      )
      .bind(site.id, w.start, w.end),
  ]);
  const m = mrr?.results[0] ?? {};
  const active = Number(m.active ?? 0);
  const startedN = Number(started?.results[0]?.n ?? 0);
  const canceledN = Number(canceled?.results[0]?.n ?? 0);
  const atStart = Math.max(0, active + canceledN - startedN);
  return {
    mrr: Number(m.mrr ?? 0),
    active,
    started: startedN,
    canceled: canceledN,
    churnRate: atStart ? canceledN / atStart : 0,
    newRevenue: Number(split?.results[0]?.new_revenue ?? 0),
    renewalRevenue: Number(split?.results[0]?.renewal_revenue ?? 0),
  };
}

// ---- Short links ---------------------------------------------------------------------------

/** Revenue credited to visits that came from a short link, in each site's currency. */
export async function linkRevenue(d1: D1Database, domain: string, slug: string, since: number): Promise<LinkRevenueDTO> {
  const { results } = await d1
    .prepare(
      `SELECT st.id AS site_id, st.name, st.currency,
         (SELECT COUNT(*) FROM web_sessions s WHERE s.site_id = st.id AND s.link_domain = ?1 AND s.link_slug = ?2 AND s.started_at >= ?3) AS sessions,
         (SELECT SUM(${AMOUNT}) FROM payments p JOIN web_sessions s ON s.id = p.credited_session_id
            WHERE p.site_id = st.id AND s.link_domain = ?1 AND s.link_slug = ?2 AND p.test_mode = 0 AND p.occurred_at >= ?3) AS revenue,
         (SELECT COUNT(*) FROM payments p JOIN web_sessions s ON s.id = p.credited_session_id
            WHERE p.site_id = st.id AND s.link_domain = ?1 AND s.link_slug = ?2 AND p.kind = 'charge' AND p.test_mode = 0 AND p.occurred_at >= ?3) AS payments,
         (SELECT COUNT(DISTINCT ${CUSTOMER}) FROM payments p JOIN web_sessions s ON s.id = p.credited_session_id
            WHERE p.site_id = st.id AND s.link_domain = ?1 AND s.link_slug = ?2 AND ${NEW_CHARGE} AND p.test_mode = 0 AND p.occurred_at >= ?3) AS customers
       FROM sites st`,
    )
    .bind(domain, slug, since)
    .all<{ site_id: string; name: string; currency: string; sessions: number; revenue: number | null; payments: number; customers: number }>();
  const bySite = results
    .filter((r) => r.sessions || r.payments)
    .map((r) => ({ siteId: r.site_id, name: r.name, currency: r.currency, revenue: r.revenue ?? 0, payments: r.payments, sessions: r.sessions, customers: r.customers }));
  return {
    revenue: bySite.reduce((s, r) => s + r.revenue, 0),
    payments: bySite.reduce((s, r) => s + r.payments, 0),
    customers: bySite.reduce((s, r) => s + r.customers, 0),
    sessions: bySite.reduce((s, r) => s + r.sessions, 0),
    bySite: bySite.map(({ customers: _c, ...r }) => r),
  };
}

/** Per site: visitors of the last 24 hours, online now, revenue of the last 30 days. */
/** The websites list: a week of traffic against the week before, two weeks of daily visits, a month of revenue. */
export async function siteSummaries(d1: D1Database, sites: SiteDTO[], now = Math.floor(Date.now() / 1000)): Promise<Map<string, SiteSummary>> {
  const DAY = 86400;
  const [traffic, hourly, sources, seen, money] = await d1.batch<Record<string, string | number | null>>([
    d1
      .prepare(
        `SELECT site_id,
           COUNT(DISTINCT CASE WHEN started_at >= ?2 THEN visitor_id END) AS v24,
           COUNT(DISTINCT CASE WHEN last_seen_at > ?3 THEN visitor_id END) AS online,
           COUNT(DISTINCT CASE WHEN started_at >= ?4 THEN visitor_id END) AS v7,
           COUNT(DISTINCT CASE WHEN started_at >= ?5 AND started_at < ?4 THEN visitor_id END) AS prev7,
           COUNT(DISTINCT visitor_id) AS v30
         FROM web_sessions WHERE started_at >= ?1 GROUP BY site_id`,
      )
      .bind(now - 30 * DAY, now - DAY, now - ONLINE_SEC, now - 7 * DAY, now - 14 * DAY),
    // Hours, so each site's days can be cut in its own time zone below.
    d1.prepare("SELECT site_id, started_at / 3600 AS h, COUNT(*) AS n FROM web_sessions WHERE started_at >= ?1 GROUP BY site_id, h").bind(now - 15 * DAY),
    d1.prepare("SELECT site_id, source, COUNT(*) AS n FROM web_sessions WHERE started_at >= ?1 GROUP BY site_id, source").bind(now - 7 * DAY),
    d1.prepare("SELECT site_id, MAX(last_seen_at) AS at FROM web_sessions GROUP BY site_id"),
    d1
      .prepare(
        `SELECT p.site_id AS site_id,
           SUM(CASE WHEN p.occurred_at >= ?2 THEN ${AMOUNT} ELSE 0 END) AS revenue,
           SUM(CASE WHEN p.occurred_at < ?2 THEN ${AMOUNT} ELSE 0 END) AS prev,
           COUNT(DISTINCT CASE WHEN p.occurred_at >= ?2 AND ${NEW_CHARGE} THEN ${CUSTOMER} END) AS customers
         FROM payments p WHERE p.occurred_at >= ?1 AND p.test_mode = 0 GROUP BY p.site_id`,
      )
      .bind(now - 60 * DAY, now - 30 * DAY),
  ]);
  const out = new Map<string, SiteSummary>();
  for (const site of sites) {
    // The last 14 days in the site's own calendar, today last.
    const today = localDate(now, site.timezone);
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) days.push(addDays(today, -i));
    out.set(site.id, {
      visitors24h: 0,
      online: 0,
      visitors7d: 0,
      visitorsPrev7d: 0,
      visitors30d: 0,
      visitsDaily: days.map((day) => ({ day, visits: 0 })),
      topSource: null,
      lastSeenAt: null,
      revenue30d: 0,
      revenuePrev30d: 0,
      customers30d: 0,
    });
  }
  const tzOf = new Map(sites.map((s) => [s.id, s.timezone]));
  const n = (v: string | number | null | undefined) => Number(v ?? 0) || 0;
  for (const r of traffic?.results ?? []) {
    const e = out.get(String(r.site_id));
    if (e) Object.assign(e, { visitors24h: n(r.v24), online: n(r.online), visitors7d: n(r.v7), visitorsPrev7d: n(r.prev7), visitors30d: n(r.v30) });
  }
  for (const r of hourly?.results ?? []) {
    const e = out.get(String(r.site_id));
    if (!e) continue;
    const day = localDate(n(r.h) * 3600, tzOf.get(String(r.site_id))!);
    const bucket = e.visitsDaily.find((d) => d.day === day);
    if (bucket) bucket.visits += n(r.n);
  }
  const totals = new Map<string, number>();
  for (const r of sources?.results ?? []) totals.set(String(r.site_id), (totals.get(String(r.site_id)) ?? 0) + n(r.n));
  for (const r of sources?.results ?? []) {
    const e = out.get(String(r.site_id));
    const share = n(r.n) / (totals.get(String(r.site_id)) || 1);
    if (e && (!e.topSource || share > e.topSource.share)) e.topSource = { name: String(r.source || "Direct"), share };
  }
  for (const r of seen?.results ?? []) {
    const e = out.get(String(r.site_id));
    if (e && r.at !== null) e.lastSeenAt = n(r.at);
  }
  for (const r of money?.results ?? []) {
    const e = out.get(String(r.site_id));
    if (e) Object.assign(e, { revenue30d: n(r.revenue), revenuePrev30d: n(r.prev), customers30d: n(r.customers) });
  }
  return out;
}

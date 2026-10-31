// Data for the analytics home. Each query uses the same call, key and options
// as the other pages that show it, so they share one cache entry.

import { useQueries, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { utcDate } from "../../shared/dates";
import type { SiteBreakdownRow, SiteListItem, SiteOverviewDTO } from "../../shared/sites";
import { RANGES, type Period, type Range, type SeriesPoint } from "../../shared/types";
import { api, call, keys } from "../api";
import { periodQuery } from "../lib/period";
import { liveInterval } from "./hits/freshness";
import { day } from "../lib/format";
import { useCan } from "../lib/me";
import { viewQuery } from "../lib/sites";

// ---- Period, kept in the URL so it survives a reload ----

export function usePeriod(): [Period, (p: Period) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("range") ?? "";
  const range: Range = (RANGES as readonly string[]).includes(raw) ? (raw as Range) : "30d";
  const period: Period = range === "custom" ? { range, from: params.get("from") ?? undefined, to: params.get("to") ?? undefined } : { range };
  const set = (p: Period) => {
    const next = new URLSearchParams(params);
    next.delete("from");
    next.delete("to");
    if (p.range === "30d") next.delete("range");
    else next.set("range", p.range);
    if (p.range === "custom" && p.from && p.to) {
      next.set("from", p.from);
      next.set("to", p.to);
    }
    setParams(next, { replace: true });
  };
  return [period, set];
}

// ---- Link statistics ----

/** The account's statistics: overview plus every dimension. */
export function useAccount(period: Period) {
  return useQuery({ queryKey: keys.account(period), queryFn: () => call(api.stats.account.$get({ query: periodQuery(period) })), refetchInterval: liveInterval(period) });
}

/** Recent hits of all links. */
export function useRecent() {
  return useQuery({ queryKey: keys.recent(), queryFn: () => call(api.stats.recent.$get({ query: { limit: "50" } })), refetchInterval: liveInterval({ range: "7d" }) });
}

/** Link health: broken destinations and missed visits in the last 7 days. */
export function useLinkHealth() {
  const health = useCan()("health.manage");
  const misses = useQuery({ queryKey: keys.misses({ range: "7d" }), queryFn: () => call(api.stats.misses.$get({ query: { range: "7d" } })), enabled: health });
  const checks = useQuery({ queryKey: keys.checks, queryFn: () => call(api.checks.$get()), enabled: health });
  if (!health) return null;
  const items = checks.data?.items ?? [];
  return {
    loading: misses.isPending || checks.isPending,
    error: misses.isError || checks.isError,
    retry: () => {
      void misses.refetch();
      void checks.refetch();
    },
    checked: items.length,
    down: items.filter((i) => i.state === "down").length,
    warning: items.filter((i) => i.state === "warning").length,
    // People's misses only: scanner probes aren't a link anyone needs.
    misses: misses.data?.rows.filter((r) => r.hits > 0 && !r.probe) ?? [],
  };
}

// ---- Chart buckets ----

export type Metric = "clicks" | "uniques" | "bots" | "revenue";

export interface Bucket {
  label: string;
  title: string;
  dates: string[];
  clicks: number;
  uniques: number;
  bots: number;
  revenue: number;
  prev?: { clicks: number; uniques: number; bots: number; title: string };
  prevRevenue?: number;
}

/** Days, or weeks once a period passes 120 days. */
function bucketize(series: SeriesPoint[]) {
  if (series.length <= 120) return series.map((p) => ({ ...p, dates: [p.date], label: day(p.date), title: day(p.date) }));
  const out: { dates: string[]; label: string; title: string; clicks: number; uniques: number; bots: number }[] = [];
  for (let i = 0; i < series.length; i += 7) {
    const week = series.slice(i, i + 7);
    const first = week[0]!;
    out.push({
      dates: week.map((p) => p.date),
      label: day(first.date),
      title: `Week of ${day(first.date)}`,
      clicks: week.reduce((s, p) => s + p.clicks, 0),
      uniques: week.reduce((s, p) => s + p.uniques, 0),
      bots: week.reduce((s, p) => s + p.bots, 0),
    });
  }
  return out;
}

export function buildBuckets(series: SeriesPoint[], previous: SeriesPoint[] | null | undefined, liveAvailable: boolean, money: Money | null): { buckets: Bucket[]; weekly: boolean } {
  const today = utcDate();
  // Without Analytics Engine today has no saved data yet.
  const available = liveAvailable ? series : series.filter((p) => p.date < today);
  const cur = bucketize(available);
  const prev = previous?.length ? bucketize(previous) : null;
  const buckets = cur.map((b, i): Bucket => {
    const p = prev?.[i];
    const revenue = money ? b.dates.reduce((s, d) => s + (money.byDate.get(d) ?? 0), 0) : 0;
    const prevRevenue = money?.hasPrevious ? b.dates.reduce((s, d) => s + (money.prevByDate.get(d) ?? 0), 0) : undefined;
    return { ...b, revenue, prevRevenue, prev: p ? { clicks: p.clicks, uniques: p.uniques, bots: p.bots, title: p.title } : undefined };
  });
  return { buckets, weekly: cur.length !== available.length };
}

// ---- Revenue, from the websites the workspace tracks ----

export interface SiteMoney {
  id: string;
  name: string;
  currency: string;
  revenue: number;
  previous: number | null;
  customers: number;
  payments: number;
  visitors: number;
  tracking: boolean;
}

export interface Money {
  currency: string;
  revenue: number;
  previous: number | null;
  customers: number;
  payments: number;
  sites: SiteMoney[];
  /** Net revenue per day (site time zone), minor units. */
  byDate: Map<string, number>;
  prevByDate: Map<string, number>;
  hasPrevious: boolean;
  /** Revenue credited to each short link, "domain/slug" → minor units. */
  byLink: Map<string, { revenue: number; visitors: number; customers: number }>;
  linksLoading: boolean;
  /** Other currencies, which can't be added to this one. */
  others: { currency: string; revenue: number; sites: number }[];
}

export type RevenueState =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "error"; retry: () => void }
  | { state: "no-sites" }
  | { state: "ready"; money: Money };

const dayIn = new Map<string, Intl.DateTimeFormat>();
function dateIn(t: number, timeZone: string): string {
  let f = dayIn.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
    }
    dayIn.set(timeZone, f);
  }
  return f.format(new Date(t * 1000));
}

/**
 * Net revenue for the same period, added up across websites per currency.
 * Reuses the Website dashboard's own overview and "Short links" queries with
 * its default view, so the cache is shared.
 */
export function useRevenue(period: Period): RevenueState {
  const can = useCan();
  const allowed = can("revenue.view") && can("stats.view");
  const sites = useQuery({ queryKey: keys.sites, queryFn: () => call(api.sites.$get()), refetchInterval: 60_000, enabled: allowed });
  const list: SiteListItem[] = sites.data?.sites ?? [];
  const query = viewQuery({ period, granularity: undefined, filters: {} });
  const overviews = useQueries({
    queries: list.map((s) => ({
      queryKey: keys.siteData(s.id, "overview", query),
      queryFn: () => call(api.sites[":id"].overview.$get({ param: { id: s.id }, query })),
      refetchInterval: 60_000,
      enabled: allowed,
    })),
  });
  const linkQuery = { ...query, dim: "link" as const };
  const links = useQueries({
    queries: list.map((s) => ({
      queryKey: keys.siteData(s.id, "breakdown", linkQuery),
      queryFn: () => call(api.sites[":id"].breakdown.$get({ param: { id: s.id }, query: linkQuery })),
      enabled: allowed,
    })),
  });

  if (!allowed) return { state: "hidden" };
  if (sites.isPending) return { state: "loading" };
  if (sites.isError) return { state: "error", retry: () => void sites.refetch() };
  if (!list.length) return { state: "no-sites" };
  if (overviews.some((q) => q.isPending)) return { state: "loading" };
  if (overviews.some((q) => q.isError)) return { state: "error", retry: () => overviews.forEach((q) => q.isError && void q.refetch()) };

  const data = overviews.map((q) => q.data as SiteOverviewDTO);
  // Pick the currency that carries the most money; others are listed beside it.
  const byCurrency = new Map<string, number>();
  for (const o of data) byCurrency.set(o.site.currency, (byCurrency.get(o.site.currency) ?? 0) + o.totals.revenue);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? list[0]!.currency;

  const mine = data.filter((o) => o.site.currency === currency);
  const byDate = new Map<string, number>();
  const prevByDate = new Map<string, number>();
  let hasPrevious = false;
  for (const o of mine) {
    o.series.forEach((p, i) => {
      const d = dateIn(p.t, o.site.timezone);
      byDate.set(d, (byDate.get(d) ?? 0) + p.revenue);
      const prev = o.previousSeries?.[i];
      if (prev) {
        hasPrevious = true;
        prevByDate.set(d, (prevByDate.get(d) ?? 0) + prev.revenue);
      }
    });
  }

  const byLink = new Map<string, { revenue: number; visitors: number; customers: number }>();
  list.forEach((s, i) => {
    if (s.currency !== currency) return;
    const rows: SiteBreakdownRow[] = links[i]?.data?.rows ?? [];
    for (const r of rows) {
      if (!r.value || r.value === "(not matched)") continue;
      const cur = byLink.get(r.value) ?? { revenue: 0, visitors: 0, customers: 0 };
      byLink.set(r.value, { revenue: cur.revenue + r.revenue, visitors: cur.visitors + r.visitors, customers: cur.customers + r.customers });
    }
  });

  const siteMoney: SiteMoney[] = data
    .map((o) => ({
      id: o.site.id,
      name: o.site.name,
      currency: o.site.currency,
      revenue: o.totals.revenue,
      previous: o.previous ? o.previous.revenue : null,
      customers: o.totals.customers,
      payments: o.totals.payments,
      visitors: o.totals.visitors,
      tracking: o.site.tracking,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors);

  const sum = (f: (o: SiteOverviewDTO) => number) => mine.reduce((s, o) => s + f(o), 0);
  const prevKnown = mine.some((o) => o.previous);
  return {
    state: "ready",
    money: {
      currency,
      revenue: sum((o) => o.totals.revenue),
      previous: prevKnown ? sum((o) => o.previous?.revenue ?? 0) : null,
      customers: sum((o) => o.totals.customers),
      payments: sum((o) => o.totals.payments),
      sites: siteMoney,
      byDate,
      prevByDate,
      hasPrevious,
      byLink,
      linksLoading: links.some((q) => q.isPending),
      others: [...byCurrency.entries()]
        .filter(([c]) => c !== currency)
        .map(([c, revenue]) => ({ currency: c, revenue, sites: data.filter((o) => o.site.currency === c).length })),
    },
  };
}

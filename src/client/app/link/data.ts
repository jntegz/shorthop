// Data for the link page. Revenue for the period comes from the Website
// dashboard's own overview query with the link filter, so the two share a
// cache entry.

import { useQueries, useQuery } from "@tanstack/react-query";
import type { SiteOverviewDTO } from "../../../shared/sites";
import type { LinkDTO, Period } from "../../../shared/types";
import { api, call, keys } from "../../api";
import { periodQuery } from "../../lib/period";
import { liveInterval } from "../hits/freshness";
import { useCan } from "../../lib/me";
import { viewQuery } from "../../lib/sites";

const is404 = (err: unknown) => err instanceof Error && "status" in err && (err as { status: number }).status === 404;

/** The link itself: no retry on 404. */
export function useLink(domain: string, slug: string) {
  return useQuery({
    queryKey: keys.link(domain, slug),
    queryFn: () => call(api.links[":domain"][":slug"].$get({ param: { domain, slug } })),
    retry: (count, err) => !is404(err) && count < 2,
  });
}

export function isNotFound(err: unknown): boolean {
  return is404(err);
}

/** Clicks for the period. */
export function useLinkStats(domain: string, slug: string, period: Period, enabled: boolean) {
  return useQuery({
    queryKey: keys.linkStats(domain, slug, period),
    queryFn: () => call(api.stats.links[":domain"][":slug"].$get({ param: { domain, slug }, query: periodQuery(period) })),
    refetchInterval: liveInterval(period),
    enabled,
  });
}

/** The latest 25 hits of this link. */
export function useLinkRecent(domain: string, slug: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.recent(domain, slug),
    queryFn: () => call(api.stats.recent.$get({ query: { domain, slug, limit: "25" } })),
    refetchInterval: liveInterval({ range: "7d" }),
    enabled,
  });
}

/** Links that send visitors here as their replacement; asked only before a delete. */
export function useDependents(domain: string, slug: string, enabled: boolean) {
  return useQuery({
    queryKey: [...keys.link(domain, slug), "dependents"],
    queryFn: () => call(api.links[":domain"][":slug"].dependents.$get({ param: { domain, slug } })),
    enabled,
  });
}

/** Visits used of the visit limit. */
export function useCap(domain: string, slug: string, enabled: boolean) {
  return useQuery({ queryKey: keys.cap(domain, slug), queryFn: () => call(api.links[":domain"][":slug"].cap.$get({ param: { domain, slug } })), enabled });
}

/** The destination check, keyed by updatedAt so a save refetches it. */
export function linkCheckKey(link: Pick<LinkDTO, "domain" | "slug" | "updatedAt">) {
  return [...keys.linkCheck(link.domain, link.slug), link.updatedAt] as const;
}
export function useLinkCheck(link: LinkDTO) {
  const { domain, slug } = link;
  return useQuery({
    queryKey: linkCheckKey(link),
    queryFn: () => call(api.checks.links[":domain"][":slug"].$get({ param: { domain, slug } })),
  });
}

/** Revenue per site over the last 12 months. */
export function useLinkRevenueYear(domain: string, slug: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.linkRevenue(domain, slug),
    queryFn: () => call(api.sites["by-link"][":domain"][":slug"].$get({ param: { domain, slug }, query: {} })),
    enabled,
  });
}

// ---- Revenue in the chosen period ----

export interface LinkSiteMoney {
  id: string;
  name: string;
  currency: string;
  revenue: number;
  previous: number | null;
  payments: number;
  customers: number;
  visitors: number;
}

export type LinkMoney =
  | { state: "hidden" }
  | { state: "loading" }
  | { state: "error"; error: unknown; retry: () => void }
  /** The link sent no visitors to a tracked website in the last 12 months. */
  | { state: "none" }
  | {
      state: "ready";
      currency: string;
      revenue: number;
      previous: number | null;
      customers: number;
      payments: number;
      visitors: number;
      /** Sites in the main currency, most money first. */
      sites: LinkSiteMoney[];
      /** Other currencies: named, never added. */
      others: LinkSiteMoney[];
      byDate: Map<string, number>;
      prevByDate: Map<string, number>;
      hasPrevious: boolean;
    };

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

export function linkFilter(domain: string, slug: string) {
  return `${domain}/${slug}`;
}

/**
 * What this link earned in the period: the sites it led to in the last 12
 * months, each read with the Website dashboard's
 * overview filtered to the link.
 */
export function useLinkMoney(domain: string, slug: string, period: Period): LinkMoney {
  const can = useCan();
  const allowed = can("revenue.view") && can("stats.view");
  const year = useLinkRevenueYear(domain, slug, can("revenue.view"));
  const sites = year.data?.bySite ?? [];
  const query = viewQuery({ period, granularity: undefined, filters: { link: linkFilter(domain, slug) } });
  const overviews = useQueries({
    queries: sites.map((s) => ({
      queryKey: keys.siteData(s.siteId, "overview", query),
      queryFn: () => call(api.sites[":id"].overview.$get({ param: { id: s.siteId }, query })),
      enabled: allowed,
    })),
  });

  if (!allowed) return { state: "hidden" };
  if (year.isPending) return { state: "loading" };
  if (year.isError) return { state: "error", error: year.error, retry: () => void year.refetch() };
  if (!sites.length) return { state: "none" };
  if (overviews.some((q) => q.isPending)) return { state: "loading" };
  const failed = overviews.find((q) => q.isError);
  if (failed) return { state: "error", error: failed.error, retry: () => overviews.forEach((q) => q.isError && void q.refetch()) };

  const data = overviews.map((q) => q.data as SiteOverviewDTO);
  const rows: LinkSiteMoney[] = data.map((o) => ({
    id: o.site.id,
    name: o.site.name,
    currency: o.site.currency,
    revenue: o.totals.revenue,
    previous: o.previous ? o.previous.revenue : null,
    payments: o.totals.payments,
    customers: o.totals.customers,
    visitors: o.totals.visitors,
  }));
  // The currency that carries the most money leads; the 12-month list breaks a tie.
  const byCurrency = new Map<string, number>();
  for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.revenue);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? sites[0]!.currency;
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
  const main = rows.filter((r) => r.currency === currency);
  const sum = (f: (r: LinkSiteMoney) => number) => main.reduce((s, r) => s + f(r), 0);
  return {
    state: "ready",
    currency,
    revenue: sum((r) => r.revenue),
    previous: main.some((r) => r.previous !== null) ? sum((r) => r.previous ?? 0) : null,
    customers: sum((r) => r.customers),
    payments: sum((r) => r.payments),
    visitors: sum((r) => r.visitors),
    sites: main.filter((r) => r.revenue !== 0 || r.visitors > 0).sort((a, b) => b.revenue - a.revenue || b.visitors - a.visitors),
    others: rows.filter((r) => r.currency !== currency && r.revenue !== 0),
    byDate,
    prevByDate,
    hasPrevious,
  };
}

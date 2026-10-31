// The merged analytics home (Overview + Full statistics) as sections that
// Analytics.tsx arranges. Data: data.ts; look: home.css and ui.css.

import { Download } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { downloadFile } from "../api";
import { periodParams } from "../lib/period";
import type { AccountStatsDTO, Period } from "../../shared/types";
import { day, hostOf, num, pct, sourceLabel, countryName, when } from "../lib/format";
import { linkPath, useLinkLabel } from "../lib/links";
import { useCan } from "../lib/me";
import { cn } from "../lib/utils";
import { buildBuckets, useAccount, useLinkHealth, usePeriod, useRecent, useRevenue, type Metric, type Money, type RevenueState } from "./data";
import { breakdownItems, Delta, LiveDataLine, NoneValue, moneyShort as fmtMoney, ErrorState, PeriodBar, rangeLabel, ribbonParts, Rows, RowsSkeleton, Skeleton, SourceRibbon, sourceParts, TabbedPanel, TrendBlock, withSwatches, type RowItem } from "./parts";
import { includesToday, StatsFreshness } from "./hits/freshness";
import { Button, errorText, StatStrip, StatStripSkeleton, type StatItem } from "./ui";
import { sitePath } from "../lib/sites";

export function useHome() {
  const [period, setPeriod] = usePeriod();
  const stats = useAccount(period);
  const revenue = useRevenue(period);
  const health = useLinkHealth();
  const recent = useRecent();
  const [picked, setPicked] = useState<Metric>("clicks");
  const money = revenue.state === "ready" ? revenue.money : null;
  const metric: Metric = picked === "revenue" && !money ? "clicks" : picked;
  const s = stats.data;
  const chart = useMemo(() => (s ? buildBuckets(s.series, s.comparison?.series, s.aeAvailable, money) : null), [s, money]);
  return { period, setPeriod, stats, s, revenue, money, health, recent, metric, setMetric: setPicked, chart };
}
export type Home = ReturnType<typeof useHome>;

const fmtRange = (s: AccountStatsDTO) => rangeLabel(s.from, s.to);

// ---- Header ----

export function ExportButton({ period }: { period: Period }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      icon={Download}
      loading={busy}
      title="Saved daily statistics, completed days only"
      aria-label="Export CSV"
      onClick={() => {
        setBusy(true);
        downloadFile(`/_admin/api/stats/export.csv?${periodParams(period)}`)
          .catch((e: unknown) => toast.error(errorText(e) ?? "The export failed."))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Exporting…" : "Export CSV"}
    </Button>
  );
}

/** "Oct 2 – Oct 31, UTC. Saved days only; today's clicks appear tomorrow." (inside the PeriodBar) */
export function RangeLine({ h }: { h: Home }) {
  const can = useCan();
  if (h.stats.isError) return null;
  if (!h.s) return <Skeleton className="ui-skel-text" style={{ width: 180 }} />;
  return (
    <>
      <span>{fmtRange(h.s)}, UTC.</span>{" "}
      {h.s.aeAvailable ? (
        includesToday(h.period) ? <StatsFreshness updatedAt={h.stats.dataUpdatedAt} fetching={h.stats.isFetching} onRefresh={() => void h.stats.refetch()} className="ui-fresh" /> : null
      ) : (
        <span className="ui-range-note">
          Saved days only; today’s clicks appear tomorrow.{" "}
          {can("settings.manage") ? <Link to="/settings#statistics">Connect live data</Link> : null}
        </span>
      )}
    </>
  );
}

export function HealthLine({ h }: { h: Home }) {
  const label = useLinkLabel();
  const x = h.health;
  if (!x) return null;
  if (x.loading) return <p className="ui-health"><Skeleton className="ui-skel-text" style={{ width: 260 }} /></p>;
  if (x.error) return <p className="ui-health" data-tone="warn">Link health couldn’t load. <button type="button" className="ui-link-btn" onClick={x.retry}>Try again</button></p>;
  const parts: ReactNode[] = [];
  if (x.down) parts.push(<Link key="d" to="/health?state=down" data-tone="bad">{num(x.down)} {x.down === 1 ? "destination is down" : "destinations are down"}</Link>);
  else if (x.warning) parts.push(<Link key="w" to="/health?state=warning" data-tone="warn">{num(x.warning)} {x.warning === 1 ? "destination is being rechecked" : "destinations are being rechecked"}</Link>);
  else if (x.checked) parts.push(<Link key="ok" to="/health">All {num(x.checked)} checked destinations load</Link>);
  if (x.misses.length) {
    const top = x.misses[0]!;
    parts.push(
      <Link key="m" to="/misses" data-tone="warn">
        {x.misses.length === 1 ? `${label(top)} doesn’t exist but got ${num(top.hits)} visits this week` : `${x.misses.length} missing links got visits this week, most of all ${label(top)}`}
      </Link>,
    );
  }
  if (!parts.length) return null;
  return (
    <p className="ui-health">
      {parts.map((p, i) => (
        <span key={i}>
          {i ? <span className="ui-health-sep">. </span> : null}
          {p}
        </span>
      ))}
      .
    </p>
  );
}

// ---- KPI strip: each number is a tab that switches the chart ----

type Kpi = StatItem<Metric>;

function revenueKpi(r: RevenueState, empty: boolean): Kpi | null {
  if (r.state === "hidden") return null;
  if (r.state === "loading") return { id: "revenue", label: "Revenue", value: <Skeleton className="ui-skel-num" />, note: <Skeleton className="ui-skel-text" style={{ width: 90 }} />, disabled: true };
  if (r.state === "error")
    return { id: "revenue", label: "Revenue", value: <span className="ui-kpi-na">Not loaded</span>, note: <button type="button" className="ui-link-btn" onClick={(e) => { e.stopPropagation(); r.retry(); }}>Try again</button>, disabled: true };
  if (r.state === "no-sites")
    return { id: "revenue", label: "Revenue", value: <span className="ui-kpi-na">No website yet</span>, note: <Link to="/sites" onClick={(e) => e.stopPropagation()}>Add a website to see sales</Link>, disabled: true };
  const m = r.money;
  const other = m.others.filter((o) => o.revenue > 0);
  return {
    id: "revenue",
    label: "Revenue",
    value: empty && !m.payments && !m.revenue ? <NoneValue /> : fmtMoney(m.revenue, m.currency, true),
    delta: <Delta current={m.revenue} previous={m.previous} />,
    note: other.length
      ? `${num(m.customers)} ${m.customers === 1 ? "customer" : "customers"}, plus ${other.map((o) => fmtMoney(o.revenue, o.currency, true)).join(", ")}`
      : m.payments
        ? `${num(m.customers)} ${m.customers === 1 ? "customer" : "customers"} from ${num(m.payments)} ${m.payments === 1 ? "payment" : "payments"}`
        : "No sales in this period",
  };
}

export function useKpis(h: Home): Kpi[] | null {
  const s = h.s;
  if (!s) return null;
  const cmp = s.comparison;
  const all = s.totals.clicks + s.totals.bots;
  // A period without a single hit: dashes, not zeros; "yet" only for all time.
  const empty = all === 0;
  const count = (n: number) => (empty ? <NoneValue /> : num(n));
  const rev = revenueKpi(h.revenue, empty);
  return [
    { id: "clicks", label: "Human clicks", value: count(s.totals.clicks), delta: cmp && <Delta current={cmp.current.clicks} previous={cmp.previous.clicks} />, note: all ? `${pct(s.totals.clicks, all)} of all hits` : h.period.range === "all" ? "No hits yet" : "No hits in this period" },
    { id: "uniques", label: "Unique visitors", value: count(s.totals.uniques), delta: cmp && <Delta current={cmp.current.uniques} previous={cmp.previous.uniques} />, note: "Counted once a day" },
    ...(rev ? [rev] : []),
    { id: "bots", label: "Bots and previews", value: count(s.totals.bots), delta: cmp && <Delta current={cmp.current.bots} previous={cmp.previous.bots} good={false} />, note: "Not counted as clicks", quiet: true },
  ];
}

export function KpiStrip({ h, className }: { h: Home; className?: string }) {
  const kpis = useKpis(h);
  if (!kpis) return <StatStripSkeleton count={h.revenue.state === "hidden" ? 3 : 4} className={className} aria-busy />;
  return <StatStrip items={kpis} value={h.metric} onChange={h.setMetric} className={className} />;
}

// ---- Chart ----

const CHART_TITLE: Record<Metric, string> = { clicks: "Human clicks", uniques: "Unique visitors", bots: "Bots and previews", revenue: "Net revenue" };

export function ChartBlock({ h, height, className }: { h: Home; height: number; className?: string }) {
  const m = h.metric;
  const ready = h.chart && h.s ? h.chart : null;
  const canCompare = m === "revenue" ? Boolean(h.money?.hasPrevious) : Boolean(h.s?.comparison?.series.length);
  return <TrendBlock title={CHART_TITLE[m]} buckets={ready?.buckets ?? null} weekly={ready?.weekly ?? false} metric={m} currency={h.money?.currency} canCompare={canCompare} height={height} className={className} />;
}

// ---- Breakdown panels ----

function splitKey(v: string) {
  const i = v.indexOf("/");
  return { domain: v.slice(0, i), slug: v.slice(i + 1) };
}

export function TopLinks({ h, limit = 8, title = "Top links" }: { h: Home; limit?: number; title?: string }) {
  const label = useLinkLabel();
  const m = h.money;
  const top = h.s?.topLinks ?? [];
  const earnedBy = (l: { domain: string; slug: string }) => m?.byLink.get(`${l.domain}/${l.slug}`);
  // A Revenue column only when at least two rows have a value; one sale moves
  // into its row's sub line ("$49 from 1 customer"), none drops the column.
  const earners = m ? top.filter((l) => (earnedBy(l)?.revenue ?? 0) > 0).length : 0;
  const money = earners >= 2 ? m : null;
  const items: RowItem[] = top.map((l) => {
    const r = earnedBy(l);
    const host = `${l.target ? hostOf(l.target) : "Deleted link"} · ${num(l.uniques)} unique`;
    return {
      key: `${l.domain}/${l.slug}`,
      label: label(l),
      sub: m && !money && r?.revenue ? `${host} · ${fmtMoney(r.revenue, m.currency, true)} from ${num(r.customers)} ${r.customers === 1 ? "customer" : "customers"}` : host,
      value: l.clicks,
      to: linkPath(l),
      extra: money ? <span className={cn("ui-row-money", !r?.revenue && "is-none")}>{r?.revenue ? fmtMoney(r.revenue, money.currency, true) : "–"}</span> : undefined,
    };
  });
  return (
    <TabbedPanel
      title={title}
      tabs={[{ id: "links", label: title }]}
      className="ui-panel-links"
      aside={<Link to="/links" className="ui-panel-link">All links</Link>}
      render={() =>
        !h.s ? <RowsSkeleton rows={limit} /> : (
          <>
            <div className={cn("ui-cols", money && "has-money")} aria-hidden>
              <span>Link</span>
              {money ? <span>Revenue</span> : null}
              <span>Share</span>
              <span>Clicks</span>
            </div>
            <Rows items={items} limit={limit} emptyText="No link got a click in this period." />
          </>
        )
      }
    />
  );
}

const SOURCE_TABS = [
  { id: "source", label: "Sources" },
  { id: "referrer", label: "Referrers" },
];
const PLACE_TABS = [
  { id: "country", label: "Countries" },
  { id: "region", label: "Regions" },
  { id: "city", label: "Cities" },
  { id: "language", label: "Languages" },
];
const DEVICE_TABS = [
  { id: "device", label: "Devices" },
  { id: "os", label: "Systems" },
  { id: "browser", label: "Browsers" },
];
const OTHER_TABS = [
  { id: "org", label: "Networks" },
  { id: "bot", label: "Bots and previews" },
];

function DimPanel({ h, title, tabs, limit = 8, className, lead, swatch }: { h: Home; title: string; tabs: { id: string; label: string }[]; limit?: number; className?: string; lead?: ReactNode; swatch?: Map<string, string> }) {
  return (
    <TabbedPanel
      title={title}
      tabs={tabs}
      className={className}
      lead={lead}
      render={(tab) => {
        if (!h.s) return <RowsSkeleton rows={limit} />;
        const dim = tab as keyof AccountStatsDTO["dims"];
        const rows = h.s.dims[dim] ?? [];
        const kind = tab === "country" ? "country" : tab === "source" ? "source" : tab === "referrer" ? "referrer" : tab === "device" ? "device" : tab === "language" ? "language" : "plain";
        const metric = tab === "bot" ? "bots" : "clicks";
        const items = breakdownItems(rows, kind, metric);
        return <Rows items={tab === "source" && swatch ? withSwatches(items, swatch) : items} limit={limit} unit={metric === "bots" ? "bot hits" : "clicks"} emptyText="Nothing in this period." />;
      }}
    />
  );
}

/** Sources, headed by the signature ribbon: the list under it is its legend (each source row carries its segment's swatch). */
export const SourcesPanel = (p: { h: Home; limit?: number; className?: string }) => {
  const parts = p.h.s ? sourceParts(p.h.s.dims.source) : null;
  const lead = !parts ? <div className="ui-ribbon is-skel"><Skeleton className="ui-skel-ribbon" /></div> : <SourceRibbon items={parts} label="Where human clicks came from, by source" />;
  return <DimPanel {...p} title="Sources" tabs={SOURCE_TABS} lead={lead} swatch={parts ? ribbonParts(parts).swatch : undefined} />;
};
export const PlacesPanel = (p: { h: Home; limit?: number; className?: string }) => <DimPanel {...p} title="Locations" tabs={PLACE_TABS} />;
export const DevicesPanel = (p: { h: Home; limit?: number; className?: string }) => <DimPanel {...p} title="Devices" tabs={DEVICE_TABS} />;
/** Hidden when neither networks nor bots have a row: a titled "Nothing in this period" is a hole, not news. */
export const OtherPanel = (p: { h: Home; limit?: number; className?: string }) => {
  const d = p.h.s?.dims;
  const tabs = d ? OTHER_TABS.filter((t) => (t.id === "org" ? (d.org ?? []).some((r) => r.clicks > 0) : (d.bot ?? []).some((r) => r.bots > 0))) : OTHER_TABS;
  if (!tabs.length) return null;
  return <DimPanel {...p} key={tabs.length} title={tabs.length === 2 ? "Networks and bots" : tabs[0]!.label} tabs={tabs} />;
};

// ---- Money ----

function siteItems(m: Money): RowItem[] {
  return m.sites
    .filter((s) => s.currency === m.currency && (s.revenue !== 0 || s.tracking))
    .map((s) => ({
      key: s.id,
      label: s.name,
      sub: s.revenue ? `${num(s.customers)} ${s.customers === 1 ? "customer" : "customers"}, ${num(s.visitors)} visitors` : s.tracking ? `${num(s.visitors)} visitors, no sales yet` : "Tracking paused",
      value: Math.max(0, s.revenue),
      display: fmtMoney(s.revenue, s.currency, true),
      extra: <Delta current={s.revenue} previous={s.previous} className="ui-row-delta" />,
      to: sitePath(s.id),
    }));
}

export function earningLinkItems(m: Money, label: (l: { domain: string; slug: string }) => string): RowItem[] {
  return [...m.byLink.entries()]
    .filter(([, v]) => v.revenue > 0)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([k, v]) => {
      const l = splitKey(k);
      return {
        key: k,
        label: label(l),
        sub: `${num(v.customers)} ${v.customers === 1 ? "customer" : "customers"} from ${num(v.visitors)} visitors`,
        value: v.revenue,
        display: fmtMoney(v.revenue, m.currency, true),
        to: linkPath(l),
      };
    });
}

/** Revenue by website, in the main currency; other currencies are named, not added. */
export function MoneyPanel({ h, tabs = "sites", className }: { h: Home; tabs?: "sites" | "both"; className?: string }) {
  const label = useLinkLabel();
  const r = h.revenue;
  if (r.state === "hidden") return null;
  const list = tabs === "both" ? [{ id: "links", label: "Links that earned" }, { id: "sites", label: "Websites" }] : [{ id: "sites", label: "Revenue by website" }];
  return (
    <TabbedPanel
      title={tabs === "both" ? "Money" : "Revenue by website"}
      tabs={list}
      className={cn("ui-panel-money", className)}
      render={(tab) => {
        if (r.state === "loading") return <RowsSkeleton rows={3} />;
        if (r.state === "error") return <ErrorState what="Revenue" onRetry={r.retry} compact />;
        if (r.state === "no-sites")
          return (
            <div className="ui-state is-compact">
              <p className="ui-state-title">No website is tracked yet.</p>
              <p className="ui-state-body">Add your site and connect Stripe or another provider; sales then show here next to the links that brought them.</p>
              <Button asChild size="sm"><Link to="/sites">Add a website</Link></Button>
            </div>
          );
        const m = r.money;
        const items = tab === "links" ? earningLinkItems(m, label) : siteItems(m);
        const others = m.sites.filter((s) => s.currency !== m.currency && s.revenue !== 0);
        return (
          <>
            {tab === "links" && m.linksLoading ? <RowsSkeleton rows={3} /> : (
              <Rows items={items} limit={5} unit={m.currency} showShare={tab === "links"} total={tab === "links" ? m.revenue : undefined} emptyText={tab === "links" ? "No sale came through a short link in this period." : "No sales in this period."} />
            )}
            {others.length ? (
              <p className="ui-panel-foot">
                Not added to the total, other currency: {others.map((s, i) => (
                  <span key={s.id}>{i ? ", " : ""}<Link to={sitePath(s.id)}>{s.name}</Link> {fmtMoney(s.revenue, s.currency, true)}</span>
                ))}.
              </p>
            ) : null}
          </>
        );
      }}
    />
  );
}

// ---- Latest hits (Analytics Engine) ----

export function LatestHits({ h, className }: { h: Home; className?: string }) {
  const label = useLinkLabel();
  const q = h.recent;
  return (
    <TabbedPanel
      title="Latest hits"
      tabs={[{ id: "hits", label: "Latest hits" }]}
      className={cn("ui-panel-hits", className)}
      aside={<Link className="ui-panel-link" to="/hits">Live map and filters</Link>}
      render={() => {
        if (q.isPending) return <RowsSkeleton rows={4} />;
        if (q.isError || q.data.error) return <ErrorState what="Latest hits" error={q.isError ? q.error : new Error(q.data.error)} onRetry={() => void q.refetch()} compact />;
        // Unavailable, so one quiet line rather than a state block (the range line above links the setup).
        if (!q.data.aeAvailable) return <LiveDataLine />;
        if (!q.data.hits.length) return <p className="ui-rows-empty">No hits in the last 7 days.</p>;
        return (
          <div className="ui-table-wrap">
            <table className="ui-table is-hits">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Link</th>
                  <th scope="col">From</th>
                  <th scope="col">Where</th>
                </tr>
              </thead>
              <tbody>
                {q.data.hits.slice(0, 8).map((x, i) => (
                  <tr key={`${x.time}-${i}`} data-event={x.event}>
                    <td>{when(x.time)}</td>
                    <td>{x.event === "miss" ? <span>{label(x)} (missing)</span> : <Link to={linkPath(x)}>{label(x)}</Link>}{x.event === "bot" ? <span className="ui-bot"> {x.botName || "bot"}</span> : null}</td>
                    <td>{sourceLabel(x.source || "direct")}</td>
                    <td>{[x.city, countryName(x.country)].filter(Boolean).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }}
    />
  );
}

// ---- Page-level states ----

/** One message for a period with no clicks at all, instead of a page of empty boxes. */
export function EmptyNotice({ h }: { h: Home }) {
  if (!h.s || h.s.totals.clicks + h.s.totals.bots > 0) return null;
  const longer: Period["range"] = h.period.range === "today" ? "7d" : h.period.range === "7d" ? "30d" : h.period.range === "30d" ? "90d" : "all";
  return (
    <div className="ui-empty-notice" role="status">
      <p>
        <strong>{h.s.from === h.s.to ? `No clicks on ${day(h.s.from)}.` : `No clicks between ${day(h.s.from)} and ${day(h.s.to)}.`}</strong> Share a link, or look at a longer period.
      </p>
      <Button size="sm" onClick={() => h.setPeriod({ range: longer })}>
        Show {longer === "all" ? "all time" : longer === "7d" ? "7 days" : longer === "30d" ? "30 days" : "90 days"}
      </Button>
    </div>
  );
}

export function StatsError({ h }: { h: Home }) {
  return <ErrorState what="Your link statistics" error={h.stats.error} onRetry={() => void h.stats.refetch()} />;
}

/** The page header (title left, actions right), then the PeriodBar: the same two rows as the link page and the website dashboard. */
export function Header({ h, children }: { h: Home; children?: ReactNode }) {
  return (
    <>
      <header className="ui-head">
        <div className="ui-head-main">
          <h1 className="ui-h1">Analytics</h1>
          <p className="ui-head-sub">Every short link in this workspace.</p>
        </div>
        <div className="ui-head-tools">
          <ExportButton period={h.period} />
          {children}
        </div>
      </header>
      <PeriodBar value={h.period} onChange={h.setPeriod} custom>
        <RangeLine h={h} />
      </PeriodBar>
    </>
  );
}

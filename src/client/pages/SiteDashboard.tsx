import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronRight, CircleDollarSign, Filter, Link2, Radio, RefreshCw, Search, Settings2, X } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { toast } from "sonner";
import { GOAL_NAME_RE, type EventList, type Granularity, type SiteBreakdownRow, type SiteDim, type SiteDTO, type SitePaymentDTO, type SitePoint, type SiteSpikeDTO, type SiteTotals } from "../../shared/sites";
import { api, call, keys } from "../api";
import { DownloadButton } from "../components/DownloadButton";
import { FunnelsCard } from "../components/Funnels";
import { EngagementCard, LifetimeValueCard, PageSpeedCard, PeakHoursCard, PurchasePathCard } from "../components/site/Insights";
import { PeriodPicker } from "../components/PeriodPicker";
import { Badge, Button, Card, CardHeader, Dialog, Empty, Input, Notice, PageHeader, Pagination, Segmented, Spinner } from "../components/ui";
import { savedPageSize, savePageSize, type PageSize } from "../lib/table";
import { ago, change, countryName, day, flag, num, whenFull } from "../lib/format";
import { useCan } from "../lib/me";
import { DIM_LABELS, dimValue, duration, sourceHint, GRANULARITY_LABELS, confidenceMeaning, matchLabel, money, percent, useSiteView, viewQuery, type SiteView } from "../lib/sites";
import { linkPath, useLinkLabel } from "../lib/links";
import { cn } from "../lib/utils";

export function SiteDashboard() {
  const { id = "" } = useParams();
  const can = useCan();
  const [view, setView] = useSiteView();
  const query = viewQuery(view);
  const overview = useQuery({
    queryKey: keys.siteData(id, "overview", query),
    queryFn: () => call(api.sites[":id"].overview.$get({ param: { id }, query })),
    refetchInterval: 60_000,
  });
  const o = overview.data;
  const site = o?.site;
  const revenue = can("revenue.view");
  const filters = Object.entries(view.filters) as [SiteDim, string][];
  const addFilter = (dim: SiteDim, value: string) => setView({ filters: { ...view.filters, [dim]: value } });

  return (
    <>
      <Link to="/sites" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Websites
      </Link>
      <PageHeader
        title={site?.name ?? "Website"}
        description={site ? site.domains.join(", ") : undefined}
        actions={
          <>
            {o ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted" title="Visitors active in the last 5 minutes">
                <span className={cn("size-2 rounded-full", o.online ? "animate-pulse bg-good" : "bg-subtle")} aria-hidden /> {o.online} online
              </span>
            ) : null}
            <Link to={`/sites/${id}/guide`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2">
              <BookOpen className="size-4" /> Guide
            </Link>
            {can("sites.manage") ? (
              <Link to={`/sites/${id}/settings`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2">
                <Settings2 className="size-4" /> Settings &amp; setup
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PeriodPicker value={view.period} onChange={(period) => setView({ period, granularity: undefined })} />
        <Segmented
          label="Chart buckets"
          value={view.granularity ?? o?.granularity ?? "day"}
          onChange={(g: Granularity) => setView({ granularity: g })}
          options={(["hour", "day", "week", "month"] as const).map((g) => ({ value: g, label: GRANULARITY_LABELS[g] }))}
        />
        {o ? <span className="text-xs text-muted">{day(o.from)} – {day(o.to)} · {site?.timezone}</span> : null}
      </div>

      {filters.length ? (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <Filter className="size-4 text-muted" aria-hidden />
          {filters.map(([dim, value]) => (
            <button
              key={dim}
              type="button"
              onClick={() => {
                const next = { ...view.filters };
                delete next[dim];
                setView({ filters: next });
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-medium text-accent hover:border-accent"
              title="Remove filter"
            >
              {DIM_LABELS[dim]}: {dimValue(dim, value)} <X className="size-3" />
            </button>
          ))}
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setView({ filters: {} })}>Clear all</button>
        </div>
      ) : null}

      {overview.isPending ? (
        <div className="flex justify-center py-24"><Spinner /></div>
      ) : overview.isError ? (
        <Notice tone="danger">{overview.error.message}</Notice>
      ) : o && site ? (
        <div className="space-y-4">
          {!site.tracking ? (
            <Notice>
              Tracking is paused: visits aren’t recorded and short links aren’t tagged. Payments still are.{" "}
              {can("sites.manage") ? <Link to={`/sites/${id}/settings`} className="font-medium underline">Turn it back on</Link> : null}
            </Notice>
          ) : o.totals.sessions === 0 && !filters.length && view.period.range !== "today" && o.totals.payments === 0 ? (
            <Notice tone="accent">
              No visits recorded in this period yet. {can("sites.manage") ? <Link to={`/sites/${id}/settings`} className="font-medium underline">Install the script</Link> : "Install the script"} on {site.domains[0]} to start.
            </Notice>
          ) : null}
          {revenue && o.unmatched ? (
            <Notice>
              {o.unmatched} payment{o.unmatched === 1 ? "" : "s"} in this period couldn't be matched to a visit, so {o.unmatched === 1 ? "it counts" : "they count"} in the total but not by source. See Payments below for why.
            </Notice>
          ) : null}

          <PathToMoney totals={o.totals} previous={o.previous} currency={site.currency} revenue={revenue} />
          <VisitStats totals={o.totals} previous={o.previous} />
          <SiteChart series={o.series} previous={o.previousSeries} spikes={o.spikes} granularity={o.granularity} site={site} revenue={revenue} />

          <div className="grid gap-4 lg:grid-cols-2">
            <LinksPanel siteId={id} view={view} site={site} revenue={revenue} totalRevenue={o.totals.revenue} onPick={addFilter} />
            <DimPanel siteId={id} view={view} site={site} revenue={revenue} title="Acquisition" tabs={["channel", "source", "campaign", "referrer", "utm_medium", "utm_term", "utm_content"]} onPick={addFilter} />
            <AiPanel siteId={id} view={view} site={site} revenue={revenue} onPick={addFilter} />
            <PagesPanel siteId={id} view={view} site={site} revenue={revenue} onPick={addFilter} />
            <DimPanel siteId={id} view={view} site={site} revenue={revenue} title="Location" tabs={["country", "region", "city", "continent", "timezone"]} onPick={addFilter} />
            <DimPanel
              siteId={id}
              view={view}
              site={site}
              revenue={revenue}
              title="Devices and visitors"
              tabs={["device", "screen", "browser", "os", "language", "visitor_type"]}
              onPick={addFilter}
              notes={{
                visitor_type:
                  site.idMode === "cookieless"
                    ? "Without cookies a visitor is recognised for one day only, so “returning” means they came back the same day."
                    : "Returning: the visitor had an earlier visit, on any day.",
              }}
            />
            <DimPanel
              siteId={id}
              view={view}
              site={site}
              revenue={revenue}
              title="Networks"
              tabs={["org"]}
              onPick={addFilter}
              notes={{ org: "Who runs the visitor's network, from Cloudflare: usually an internet provider, sometimes a company's or university's own network. Visits from before this was collected show as Unknown." }}
            />
          </div>

          <PeakHoursCard siteId={id} view={view} site={site} revenue={revenue} />
          <EngagementCard siteId={id} view={view} revenue={revenue} aeAvailable={o.aeAvailable} />
          <PageSpeedCard siteId={id} view={view} aeAvailable={o.aeAvailable} />
          <EventsCard siteId={id} view={view} list="goals" title="Goals" description="Clicks on elements with data-sh-goal, elements scrolled into view with data-sh-scroll, and shorthop('goal', …) calls." totalVisitors={o.totals.visitors} aeAvailable={o.aeAvailable} />
          <FunnelsCard site={site} view={view} revenue={revenue} />
          {revenue ? <SubscriptionsCard siteId={id} view={view} site={site} /> : null}
          {revenue ? <PurchasePathCard siteId={id} view={view} site={site} /> : null}
          {revenue ? <LifetimeValueCard siteId={id} view={view} site={site} /> : null}
          {revenue ? <PaymentsCard siteId={id} view={view} site={site} /> : null}
          <LiveCard siteId={id} />
        </div>
      ) : null}
    </>
  );
}

// ---- Tiles and chart -----------------------------------------------------------------------

function Chip({ current, previous, good = true }: { current: number; previous: number | undefined; good?: boolean }) {
  if (previous === undefined) return null;
  const c = change(current, previous);
  if (!c) return null;
  const Icon = c.dir === "down" ? ArrowDownRight : ArrowUpRight;
  const better = good ? c.dir === "up" : c.dir === "down";
  const tone = c.dir === "flat" ? "bg-surface-2 text-muted" : better ? "bg-good-soft text-good" : "bg-danger-soft text-danger";
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular", tone)} title={`${c.title} against the previous period`}>
      {c.dir === "flat" ? null : <Icon className="size-3" aria-hidden />}
      {c.text}
    </span>
  );
}

interface Step {
  key: string;
  label: string;
  hint: string;
  value: number;
  previous?: number;
}

/**
 * The period read as a journey: everyone who came, who did something, who
 * reached a checkout, who paid. Each step is a share of the visitors, and the
 * arrow between two steps says how many made it from one to the next.
 */
function PathToMoney({ totals: t, previous: p, currency, revenue }: { totals: SiteTotals; previous: SiteTotals | null; currency: string; revenue: boolean }) {
  const steps: Step[] = [
    { key: "visitors", label: "Came", hint: "Unique visitors in this period.", value: t.visitors, previous: p?.visitors },
    { key: "goal", label: "Took an action", hint: "Completed at least one goal: a click, a scroll or a shorthop('goal') call.", value: t.goalVisitors, previous: p?.goalVisitors },
  ];
  // Checkouts the script can't see (created on your server) would make this step look like a leak.
  if (t.checkoutVisitors > 0 || !revenue || t.customers === 0) {
    steps.push({ key: "checkout", label: "Reached checkout", hint: "Clicked a hosted checkout link (Stripe, Lemon Squeezy, Paddle…). Checkouts your server creates aren't counted here.", value: t.checkoutVisitors, previous: p?.checkoutVisitors });
  }
  if (revenue) steps.push({ key: "paid", label: "Paid", hint: "New customers credited to a visit in this period (renewals aren't counted).", value: t.customers, previous: p?.customers });
  const base = Math.max(1, t.visitors);

  return (
    <Card className={cn("grid overflow-hidden", revenue && "lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]")}>
      {revenue ? (
        <div className="flex flex-col justify-between gap-5 border-b border-line bg-surface-2 px-5 py-5 lg:border-r lg:border-b-0">
          <div>
            <p className="text-xs font-medium text-muted">Net revenue</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="tabular text-[34px] leading-tight font-semibold tracking-[-0.03em] text-fg">{money(t.revenue, currency, true)}</span>
              <Chip current={t.revenue} previous={p?.revenue} />
            </div>
            <p className="mt-1 text-xs text-muted">
              {num(t.payments)} payment{t.payments === 1 ? "" : "s"}
              {t.refunds ? ` · ${money(t.refunds, currency, true)} refunded` : ""}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-3 border-t border-line pt-4">
            <div>
              <dt className="text-xs text-muted">Per visitor</dt>
              <dd className="tabular mt-0.5 text-base font-semibold text-fg">{money(t.revenuePerVisitor, currency)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Visitors who paid</dt>
              <dd className="tabular mt-0.5 text-base font-semibold text-fg">{percent(t.conversion)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
      <div className="min-w-0 px-5 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-base font-semibold tracking-tight text-fg">Path to {revenue ? "money" : "action"}</h2>
          <p className="text-xs text-muted">Each step as a share of everyone who came</p>
        </div>
        <ol className={cn("mt-4 grid gap-x-3 gap-y-5", steps.length === 4 ? "grid-cols-2 md:grid-cols-4" : "grid-cols-1 sm:grid-cols-3")}>
          {steps.map((s, i) => {
            const share = s.value / base;
            const from = i > 0 ? steps[i - 1]!.value : 0;
            return (
              <li key={s.key} className="min-w-0" title={s.hint}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-medium text-muted">{s.label}</span>
                  {i > 0 ? (
                    <span className="tabular shrink-0 text-subtle" title={`${percent(from ? s.value / from : 0)} of the step before`}>
                      <ArrowRight className="mr-0.5 inline size-3 align-[-2px]" aria-hidden />
                      {from ? percent(Math.min(1, s.value / from)) : "–"}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="tabular text-2xl font-semibold tracking-[-0.02em] text-fg">{num(s.value)}</span>
                  <Chip current={s.value} previous={s.previous} />
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <div className="h-full rounded-full bg-series-1" style={{ width: `${Math.max(s.value ? 2 : 0, Math.min(100, share * 100))}%`, opacity: 1 - i * 0.18 }} />
                </div>
                <p className="tabular mt-1 text-xs text-muted">{i === 0 ? "100%" : `${percent(Math.min(1, share))} of visitors`}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </Card>
  );
}

/** The quieter numbers about how visits went, in one line under the path. */
function VisitStats({ totals: t, previous: p }: { totals: SiteTotals; previous: SiteTotals | null }) {
  const stats: { label: string; value: string; hint: string; chip?: ReactNode }[] = [
    { label: "Visits", value: num(t.sessions), hint: "A visit ends after 30 minutes without activity.", chip: <Chip current={t.sessions} previous={p?.sessions} /> },
    { label: "Pages per visit", value: t.sessions ? (t.pageviews / t.sessions).toFixed(1) : "0", hint: `${num(t.pageviews)} pageviews in all.` },
    { label: "Engaged time", value: duration(t.avgEngagedSec), hint: "Average time per visit with the tab visible and the visitor active.", chip: <Chip current={t.avgEngagedSec} previous={p?.avgEngagedSec} /> },
    { label: "Left after one page", value: percent(t.bounceRate), hint: "Visits with one page and no goal.", chip: <Chip current={t.bounceRate} previous={p?.bounceRate} good={false} /> },
    { label: "Came through short links", value: num(t.linkVisitors), hint: "Visitors whose visit started with a click on one of your short links.", chip: <Chip current={t.linkVisitors} previous={p?.linkVisitors} /> },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line bg-surface px-5 py-3 sm:grid-cols-3 lg:grid-cols-5">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0" title={s.hint}>
          <dt className="truncate text-xs text-muted">{s.label}</dt>
          <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
            <span className="tabular text-base font-semibold text-fg">{s.value}</span>
            {s.chip}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function bucketLabel(t: number, g: Granularity, tz: string, long = false): string {
  const opts: Intl.DateTimeFormatOptions =
    g === "hour" ? { hour: "2-digit", minute: "2-digit", ...(long ? { day: "numeric", month: "short" } : {}) } : g === "month" ? { month: "short", year: "numeric" } : { day: "numeric", month: "short", ...(long ? { year: "numeric" } : {}) };
  const s = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(new Date(t * 1000));
  return g === "week" && long ? `Week of ${s}` : s;
}

/**
 * Visitors and revenue as two charts on one time axis (small multiples): each
 * has its own scale, so neither is squashed, and hovering one marks the same
 * bucket in the other. A table view gives every number.
 */
type ChartMetric = "visitors" | "sessions" | "pageviews" | "engaged" | "conversion";

const CHART_METRICS: readonly { value: ChartMetric; label: string }[] = [
  { value: "visitors", label: "Visitors" },
  { value: "sessions", label: "Visits" },
  { value: "pageviews", label: "Pageviews" },
  { value: "engaged", label: "Time per visit" },
  { value: "conversion", label: "Goal conversion" },
];

const metricLabel = (m: ChartMetric) => CHART_METRICS.find((x) => x.value === m)!.label;

/** A bucket's value of the chosen metric: counts, seconds of engaged time per visit, or the share of visits with a goal. */
function metricOf(m: ChartMetric, p: SitePoint): number {
  if (m === "engaged") return p.sessions ? Math.round(p.engagedMs / p.sessions / 1000) : 0;
  if (m === "conversion") return p.sessions ? p.goalSessions / p.sessions : 0;
  return p[m];
}

/** The metric over the whole period: a sum for counts, an average for the rates. */
function metricTotal(m: ChartMetric, points: SitePoint[]): number {
  const sum = (k: "sessions" | "engagedMs" | "goalSessions" | "visitors" | "pageviews") => points.reduce((a, p) => a + p[k], 0);
  if (m === "engaged") return sum("sessions") ? Math.round(sum("engagedMs") / sum("sessions") / 1000) : 0;
  if (m === "conversion") return sum("sessions") ? sum("goalSessions") / sum("sessions") : 0;
  return sum(m);
}

function formatMetric(m: ChartMetric, v: number): string {
  if (m === "engaged") return duration(v);
  if (m === "conversion") return percent(v);
  return num(v);
}

function SiteChart({
  series,
  previous,
  spikes,
  granularity,
  site,
  revenue,
}: {
  series: SitePoint[];
  previous: SitePoint[] | null;
  spikes: SiteSpikeDTO[];
  granularity: Granularity;
  site: SiteDTO;
  revenue: boolean;
}) {
  const syncId = useId();
  const gradient = useId();
  const [table, setTable] = useState(false);
  const [metric, setMetric] = useState<ChartMetric>("visitors");
  const [comparePrev, setComparePrev] = useState(true);
  const data = useMemo(
    () =>
      series.map((p, i) => {
        const before = previous?.[i];
        return {
          ...p,
          value: metricOf(metric, p),
          prev: before ? metricOf(metric, before) : null,
          prevTitle: before ? bucketLabel(before.t, granularity, site.timezone, true) : null,
          label: bucketLabel(p.t, granularity, site.timezone),
          title: bucketLabel(p.t, granularity, site.timezone, true),
        };
      }),
    [series, previous, metric, granularity, site.timezone],
  );
  // Each spike sits on the bucket it happened in.
  const marks = useMemo(() => {
    const out: { label: string; lines: string[] }[] = [];
    for (const sp of spikes) {
      let i = -1;
      for (let j = 0; j < data.length; j++) if (data[j]!.t <= sp.t) i = j;
      if (i < 0) continue;
      const label = data[i]!.label;
      const line = `${sp.source || "Direct"}: ${num(sp.visits)} visits in an hour (usually ${num(Math.round(sp.baseline))})`;
      const existing = out.find((m) => m.label === label);
      if (existing) existing.lines.push(line);
      else out.push({ label, lines: [line] });
    }
    return out;
  }, [spikes, data]);
  const total = metricTotal(metric, series);
  const prevTotal = previous ? metricTotal(metric, previous) : undefined;
  const totalRevenue = data.reduce((sum, d) => sum + d.revenue, 0);
  const showPrev = comparePrev && previous !== null;
  const Tip = ({ active, payload }: TooltipContentProps) => {
    if (!active || !payload?.length) return null;
    const b = payload[0]?.payload as (typeof data)[number] | undefined;
    if (!b) return null;
    const spike = marks.find((m) => m.label === b.label);
    return (
      <div className="max-w-xs rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
        <div className="mb-1 font-medium text-fg">{b.title}</div>
        <TipRow label={metricLabel(metric)} value={formatMetric(metric, b.value)} />
        {showPrev && b.prev !== null ? <TipRow label={`Before (${b.prevTitle})`} value={formatMetric(metric, b.prev)} /> : null}
        {metric !== "visitors" ? <TipRow label="Visitors" value={num(b.visitors)} /> : null}
        {revenue ? <TipRow label="Revenue" value={money(b.revenue, site.currency)} /> : null}
        {revenue ? <TipRow label="Payments" value={num(b.payments)} /> : null}
        {spike ? spike.lines.map((l) => <p key={l} className="mt-1 text-warn">Spike · {l}</p>) : null}
      </div>
    );
  };
  const axisX = <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--line)" }} tick={{ fill: "var(--subtle)", fontSize: 11 }} minTickGap={24} interval="preserveStartEnd" />;
  const panelHead = (label: string, value: string, chip?: ReactNode) => (
    <div className="flex items-baseline justify-between gap-2 px-4 pt-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="flex items-center gap-2">
        {chip}
        <span className="tabular text-sm font-semibold text-fg">{value}</span>
      </span>
    </div>
  );
  const rate = metric === "engaged" || metric === "conversion";
  return (
    <Card>
      <CardHeader
        title={revenue ? "Visitors and revenue" : "Visitors"}
        description={`${GRANULARITY_LABELS[granularity]} · ${site.timezone}${revenue ? ` · ${site.currency}` : ""}`}
        action={
          <button type="button" className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => setTable((v) => !v)}>
            {table ? "Chart" : "Table"}
          </button>
        }
      />
      {table ? (
        <div className="max-h-80 overflow-auto px-4 pb-4">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th className="py-1.5 font-medium">When</th>
                <th className="py-1.5 text-right font-medium">Visitors</th>
                <th className="py-1.5 text-right font-medium">Visits</th>
                <th className="py-1.5 text-right font-medium">Pageviews</th>
                <th className="py-1.5 text-right font-medium">Time per visit</th>
                <th className="py-1.5 text-right font-medium">Goal conversion</th>
                {revenue ? <th className="py-1.5 text-right font-medium">Revenue</th> : null}
                {revenue ? <th className="py-1.5 text-right font-medium">Payments</th> : null}
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.t} className="border-t border-line">
                  <td className="py-1.5">{d.title}</td>
                  <td className="tabular py-1.5 text-right">{num(d.visitors)}</td>
                  <td className="tabular py-1.5 text-right text-muted">{num(d.sessions)}</td>
                  <td className="tabular py-1.5 text-right text-muted">{num(d.pageviews)}</td>
                  <td className="tabular py-1.5 text-right text-muted">{formatMetric("engaged", metricOf("engaged", d))}</td>
                  <td className="tabular py-1.5 text-right text-muted">{formatMetric("conversion", metricOf("conversion", d))}</td>
                  {revenue ? <td className="tabular py-1.5 text-right">{money(d.revenue, site.currency)}</td> : null}
                  {revenue ? <td className="tabular py-1.5 text-right text-muted">{num(d.payments)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2">
            <Segmented label="Chart metric" value={metric} onChange={setMetric} options={CHART_METRICS} />
            {previous ? (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={comparePrev} onChange={(e) => setComparePrev(e.target.checked)} />
                Compare with the period before
              </label>
            ) : null}
          </div>
          {panelHead(rate ? `${metricLabel(metric)}, average` : metricLabel(metric), formatMetric(metric, total), <Chip current={total} previous={prevTotal} />)}
          <div className={cn("px-2", revenue ? "h-48" : "h-72")}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart accessibilityLayer syncId={syncId} data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                {revenue ? <XAxis dataKey="label" hide /> : axisX}
                <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--subtle)", fontSize: 11 }} tickFormatter={(v: number) => formatMetric(metric, v)} allowDecimals={metric === "conversion"} width={56} />
                <Tooltip content={Tip} cursor={{ stroke: "var(--subtle)", strokeDasharray: "3 3" }} isAnimationActive={false} />
                {marks.map((m) => (
                  <ReferenceLine key={m.label} x={m.label} stroke="var(--warn)" strokeDasharray="3 3" />
                ))}
                {showPrev ? <Line type="monotone" dataKey="prev" name="Period before" stroke="var(--subtle)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false} isAnimationActive={false} /> : null}
                <Area type="monotone" dataKey="value" name={metricLabel(metric)} stroke="var(--series-1)" strokeWidth={2} fill={`url(#${gradient})`} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {marks.length || showPrev ? (
            <div className="flex flex-wrap gap-4 px-4 pt-1 text-xs text-muted">
              {showPrev ? <span>Dashed line: the period before</span> : null}
              {marks.length ? <span className="text-warn">Orange lines: traffic spikes (hover for details)</span> : null}
            </div>
          ) : null}
          {revenue ? (
            <>
              <div className="mx-4 my-2 border-t border-line" />
              {panelHead("Revenue", money(totalRevenue, site.currency))}
              <div className="h-40 px-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart accessibilityLayer syncId={syncId} data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="20%">
                    <CartesianGrid vertical={false} stroke="var(--grid)" />
                    {axisX}
                    <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--subtle)", fontSize: 11 }} tickFormatter={(v: number) => money(v, site.currency, true)} width={56} />
                    <Tooltip content={Tip} cursor={{ fill: "var(--surface-2)" }} isAnimationActive={false} />
                    <Bar dataKey="revenue" name="Revenue" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function TipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-muted">
      <span>{label}</span>
      <span className="tabular ml-auto pl-4 font-medium text-fg">{value}</span>
    </div>
  );
}

// ---- Breakdowns -------------------------------------------------------------------------------

function Rows({
  rows,
  dim,
  site,
  revenue,
  sort,
  onPick,
  limit = 8,
}: {
  rows: SiteBreakdownRow[];
  dim: SiteDim;
  site: SiteDTO;
  revenue: boolean;
  sort: "visitors" | "revenue";
  onPick?: (value: string) => void;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...rows].filter((r) => r.visitors > 0 || r.revenue !== 0).sort((a, b) => b[sort] - a[sort] || b.visitors - a.visitors);
  const shown = expanded ? sorted : sorted.slice(0, limit);
  const maxV = Math.max(1, ...sorted.map((r) => r.visitors));
  if (!shown.length) return <Empty title="No data in this period" />;
  return (
    <>
      <ul className="space-y-1.5 px-4 pb-4">
        {shown.map((r) => {
          const pickable = onPick && r.value !== "(not matched)";
          const content = (
            <>
              <div className="absolute inset-y-0 left-0 rounded-md bg-series-1 opacity-[0.09]" style={{ width: `${(r.visitors / maxV) * 100}%` }} aria-hidden />
              <span className="relative min-w-0 flex-1 truncate text-left text-fg">{dimValue(dim, r.value)}</span>
              <span className="tabular relative w-14 text-right text-muted">{num(r.visitors)}</span>
              {revenue ? <span className={cn("tabular relative w-20 text-right font-medium", r.revenue ? "text-fg" : "text-subtle")}>{r.revenue ? money(r.revenue, site.currency, true) : "–"}</span> : null}
            </>
          );
          return (
            <li key={r.value} className="relative">
              {pickable ? (
                <button type="button" onClick={() => onPick(r.value)} title={`Filter by ${dimValue(dim, r.value)} · ${num(r.customers)} customers${dim === "source" && sourceHint(r.value) ? `
${sourceHint(r.value)}` : ""}`} className="relative flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2">
                  {content}
                </button>
              ) : (
                <div className="relative flex items-center gap-2 px-3 py-2 text-sm">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {sorted.length > limit ? (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-auto border-t border-line px-4 py-2 text-left text-xs text-muted hover:text-fg">
          {expanded ? "Show less" : `Show all ${sorted.length}`}
        </button>
      ) : null}
    </>
  );
}

function PanelHead({ title, tab, tabs, labels, onTab, sort, onSort, revenue }: { title: string; tab: string; tabs: readonly string[]; labels: Record<string, string>; onTab: (t: string) => void; sort: "visitors" | "revenue"; onSort: (s: "visitors" | "revenue") => void; revenue: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-3">
      <h2 className="text-base font-semibold tracking-tight text-fg">{title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        {tabs.length > 1 ? <Segmented label={`${title} view`} value={tab} onChange={onTab} options={tabs.map((t) => ({ value: t, label: labels[t] ?? t }))} /> : null}
        {revenue ? (
          <button type="button" className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline" onClick={() => onSort(sort === "visitors" ? "revenue" : "visitors")}>
            Sort: {sort}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DimPanel({
  siteId,
  view,
  site,
  revenue,
  title,
  tabs,
  onPick,
  notes,
}: {
  siteId: string;
  view: SiteView;
  site: SiteDTO;
  revenue: boolean;
  title: string;
  tabs: SiteDim[];
  onPick: (dim: SiteDim, v: string) => void;
  /** A line under the tabs for some of them. */
  notes?: Partial<Record<SiteDim, string>>;
}) {
  const [tab, setTab] = useState<SiteDim>(tabs[0]!);
  const [sort, setSort] = useState<"visitors" | "revenue">("visitors");
  const query = { ...viewQuery(view), dim: tab };
  const data = useQuery({ queryKey: keys.siteData(siteId, "breakdown", query), queryFn: () => call(api.sites[":id"].breakdown.$get({ param: { id: siteId }, query })) });
  return (
    <Card className="flex flex-col">
      <PanelHead title={title} tab={tab} tabs={tabs} labels={DIM_LABELS} onTab={(t) => setTab(t as SiteDim)} sort={sort} onSort={setSort} revenue={revenue} />
      {notes?.[tab] ? <p className="-mt-1 px-4 pb-2 text-xs text-muted">{notes[tab]}</p> : null}
      <ColumnHead revenue={revenue} />
      {data.isPending ? <div className="flex justify-center py-10"><Spinner /></div> : data.isError ? <p className="px-4 pb-4 text-sm text-danger">{data.error.message}</p> : <Rows rows={data.data.rows} dim={tab} site={site} revenue={revenue} sort={sort} onPick={view.filters[tab] === undefined ? (v) => onPick(tab, v) : undefined} />}
    </Card>
  );
}

/** Your short links that sent visitors here, best earners first, each opening its link page. */
function LinksPanel({ siteId, view, site, revenue, totalRevenue, onPick }: { siteId: string; view: SiteView; site: SiteDTO; revenue: boolean; totalRevenue: number; onPick: (dim: SiteDim, v: string) => void }) {
  const label = useLinkLabel();
  const [expanded, setExpanded] = useState(false);
  const query = { ...viewQuery(view), dim: "link" as const };
  const data = useQuery({ queryKey: keys.siteData(siteId, "breakdown", query), queryFn: () => call(api.sites[":id"].breakdown.$get({ param: { id: siteId }, query })) });
  const rows = (data.data?.rows ?? []).filter((r) => r.value && r.value !== "(not matched)" && (r.visitors > 0 || r.revenue !== 0)).sort((a, b) => (revenue ? b.revenue - a.revenue : 0) || b.visitors - a.visitors);
  const linkRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const shown = expanded ? rows : rows.slice(0, 8);
  const maxV = Math.max(1, ...rows.map((r) => r.visitors));
  const split = (v: string) => ({ domain: v.slice(0, v.indexOf("/")), slug: v.slice(v.indexOf("/") + 1) });
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Short links"
        description={
          revenue && totalRevenue > 0 && linkRevenue > 0
            ? `${percent(Math.min(1, linkRevenue / totalRevenue))} of this period's revenue came through them.`
            : "Clicks on your short links to this site are credited automatically."
        }
      />
      {data.isPending ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : data.isError ? (
        <p className="px-4 pb-4 text-sm text-danger">{data.error.message}</p>
      ) : !rows.length ? (
        <Empty icon={<Link2 />} title="No short-link visits in this period">
          Share a short link that points to {site.domains[0]}; its visits{revenue ? " and sales" : ""} show up here.
        </Empty>
      ) : (
        <>
          <ColumnHead revenue={revenue} />
          <ul className="space-y-1.5 px-4 pb-4">
            {shown.map((r) => {
              const l = split(r.value);
              return (
                <li key={r.value} className="relative flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2">
                  <div className="absolute inset-y-0 left-0 rounded-md bg-series-1 opacity-[0.09]" style={{ width: `${(r.visitors / maxV) * 100}%` }} aria-hidden />
                  <Link to={linkPath(l)} className="relative min-w-0 flex-1 truncate font-mono text-xs text-fg hover:text-accent hover:underline" title={`Open ${label(l)}`}>{label(l)}</Link>
                  {view.filters.link === undefined ? (
                    <button type="button" onClick={() => onPick("link", r.value)} className="relative rounded p-1 text-subtle hover:bg-surface hover:text-fg" aria-label={`Filter by ${label(l)}`} title="Filter the dashboard by this link">
                      <Filter className="size-3.5" />
                    </button>
                  ) : null}
                  <span className="tabular relative w-14 text-right text-muted">{num(r.visitors)}</span>
                  {revenue ? <span className={cn("tabular relative w-20 text-right font-medium", r.revenue ? "text-fg" : "text-subtle")}>{r.revenue ? money(r.revenue, site.currency, true) : "–"}</span> : null}
                </li>
              );
            })}
          </ul>
          {rows.length > 8 ? (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-auto border-t border-line px-4 py-2 text-left text-xs text-muted hover:text-fg">
              {expanded ? "Show less" : `Show all ${rows.length}`}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ColumnHead({ revenue, first = "Visitors" }: { revenue: boolean; first?: string }) {
  return (
    <div className="flex items-center gap-2 px-7 pb-1 text-xs text-subtle">
      <span className="flex-1" />
      <span className="w-14 text-right">{first}</span>
      {revenue ? <span className="w-20 text-right">Revenue</span> : null}
    </div>
  );
}

const PAGE_TABS = { pages: "Pages", entry: "Landing pages", exit: "Exit pages", outbound: "Outbound" } as const;

function PagesPanel({ siteId, view, site, revenue, onPick }: { siteId: string; view: SiteView; site: SiteDTO; revenue: boolean; onPick: (dim: SiteDim, v: string) => void }) {
  const [tab, setTab] = useState<keyof typeof PAGE_TABS>("pages");
  const [sort, setSort] = useState<"visitors" | "revenue">("visitors");
  const isEvent = tab === "pages" || tab === "outbound";
  const query = isEvent ? { ...viewQuery(view), list: tab } : { ...viewQuery(view), dim: tab };
  const data = useQuery({
    queryKey: keys.siteData(siteId, isEvent ? "events" : "breakdown", query),
    queryFn: async () => {
      if (tab === "pages" || tab === "outbound") {
        const r = await call(api.sites[":id"].events.$get({ param: { id: siteId }, query: { ...viewQuery(view), list: tab } }));
        return { available: r.available, rows: r.rows.map((x) => ({ value: x.value, visitors: x.visitors, sessions: x.count, pageviews: x.count, revenue: x.revenue ?? 0, customers: 0 })) };
      }
      const r = await call(api.sites[":id"].breakdown.$get({ param: { id: siteId }, query: { ...viewQuery(view), dim: tab } }));
      return { available: true, rows: r.rows };
    },
  });
  return (
    <Card className="flex flex-col">
      <PanelHead title="Content" tab={tab} tabs={Object.keys(PAGE_TABS)} labels={PAGE_TABS} onTab={(t) => setTab(t as keyof typeof PAGE_TABS)} sort={sort} onSort={setSort} revenue={revenue && tab !== "outbound"} />
      {tab === "pages" ? <p className="-mt-1 px-4 pb-2 text-xs text-muted">Revenue here is from visits that landed on the page, so it adds up to the total. Not filtered.</p> : null}
      <ColumnHead revenue={revenue && tab !== "outbound"} first={tab === "outbound" ? "Clicks" : "Visitors"} />
      {data.isPending ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : data.isError ? (
        <p className="px-4 pb-4 text-sm text-danger">{data.error.message}</p>
      ) : !data.data.available ? (
        <Empty title="Needs Analytics Engine">Page and outbound lists are read from Analytics Engine; set CF_ANALYTICS_TOKEN.</Empty>
      ) : (
        <Rows rows={data.data.rows} dim={tab === "pages" || tab === "outbound" ? "entry" : tab} site={site} revenue={revenue && tab !== "outbound"} sort={sort} onPick={tab === "entry" || tab === "exit" ? (v) => onPick(tab, v) : undefined} />
      )}
    </Card>
  );
}

/** Where visitors from AI assistants landed, per assistant: the closest signal to what they asked. Hidden when none came. */
function AiPanel({ siteId, view, site, revenue, onPick }: { siteId: string; view: SiteView; site: SiteDTO; revenue: boolean; onPick: (dim: SiteDim, v: string) => void }) {
  const [tab, setTab] = useState("all");
  const [sort, setSort] = useState<"visitors" | "revenue">("visitors");
  const otherChannel = view.filters.channel !== undefined && view.filters.channel !== "AI";
  const base = { ...viewQuery(view), f_channel: "AI" };
  const sourcesQuery = { ...base, dim: "source" as const };
  const sources = useQuery({ queryKey: keys.siteData(siteId, "breakdown", sourcesQuery), queryFn: () => call(api.sites[":id"].breakdown.$get({ param: { id: siteId }, query: sourcesQuery })), enabled: !otherChannel });
  const assistants = (sources.data?.rows ?? []).filter((r) => r.visitors > 0).sort((a, b) => b.visitors - a.visitors).map((r) => r.value);
  const current = tab !== "all" && assistants.includes(tab) ? tab : "all";
  const query = { ...base, ...(current === "all" ? {} : { f_source: current }), dim: "entry" as const };
  const data = useQuery({ queryKey: keys.siteData(siteId, "breakdown", query), queryFn: () => call(api.sites[":id"].breakdown.$get({ param: { id: siteId }, query })), enabled: assistants.length > 0 });
  if (otherChannel || !assistants.length) return null;
  const tabs = assistants.length > 1 ? ["all", ...assistants] : assistants;
  const labels = Object.fromEntries([["all", "All AI"], ...assistants.map((a) => [a, a])]);
  return (
    <Card className="flex flex-col">
      <PanelHead title="AI landing pages" tab={assistants.length > 1 ? current : assistants[0]!} tabs={tabs} labels={labels} onTab={setTab} sort={sort} onSort={setSort} revenue={revenue} />
      <p className="-mt-1 px-4 pb-2 text-xs text-muted">AI assistants don't share what people asked. The page they land on is the closest signal.</p>
      <ColumnHead revenue={revenue} />
      {data.isPending ? <div className="flex justify-center py-10"><Spinner /></div> : data.isError ? <p className="px-4 pb-4 text-sm text-danger">{data.error.message}</p> : <Rows rows={data.data.rows} dim="entry" site={site} revenue={revenue} sort={sort} onPick={view.filters.entry === undefined ? (v) => onPick("entry", v) : undefined} />}
    </Card>
  );
}

function EventsCard({ siteId, view, list, title, description, totalVisitors, aeAvailable }: { siteId: string; view: SiteView; list: EventList; title: string; description: string; totalVisitors: number; aeAvailable: boolean }) {
  const query = { ...viewQuery(view), list };
  const data = useQuery({ queryKey: keys.siteData(siteId, "events", query), queryFn: () => call(api.sites[":id"].events.$get({ param: { id: siteId }, query })), enabled: aeAvailable });
  const rows = data.data?.rows ?? [];
  const [openGoal, setOpenGoal] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title={title} description={`${description} Click a goal to see the properties sent with it.`} />
      {!aeAvailable ? (
        <Empty title="Needs Analytics Engine" />
      ) : data.isPending ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : !rows.length ? (
        <Empty title="No goals completed in this period">Add data-sh-goal="signup" to a button, or call shorthop("goal", "signup"). <Link to={`/sites/${siteId}/guide#goals`} className="font-medium text-accent underline underline-offset-2">How goals work</Link></Empty>
      ) : (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr><th className="py-1.5 font-medium">Goal</th><th className="py-1.5 text-right font-medium">Visitors</th><th className="py-1.5 text-right font-medium">Completions</th><th className="py-1.5 text-right font-medium">Conversion</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.value}>
                  <tr className="border-t border-line">
                    <td className="py-2 font-medium">
                      <button type="button" className="inline-flex items-center gap-1 text-left hover:text-accent" aria-expanded={openGoal === r.value} onClick={() => setOpenGoal(openGoal === r.value ? null : r.value)}>
                        <ChevronRight className={cn("size-3.5 shrink-0 text-subtle transition-transform", openGoal === r.value && "rotate-90")} aria-hidden />
                        {r.value}
                      </button>
                    </td>
                    <td className="tabular py-2 text-right">{num(r.visitors)}</td>
                    <td className="tabular py-2 text-right">{num(r.count)}</td>
                    <td className="tabular py-2 text-right">{totalVisitors ? percent(Math.min(1, r.visitors / totalVisitors)) : "–"}</td>
                  </tr>
                  {openGoal === r.value ? (
                    <tr>
                      <td colSpan={4} className="pb-3 pl-5">
                        <GoalProps siteId={siteId} view={view} name={r.value} completions={r.count} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The properties sent with one goal: data-sh-goal-<prop> attributes or shorthop("goal", name, props). */
function GoalProps({ siteId, view, name, completions }: { siteId: string; view: SiteView; name: string; completions: number }) {
  const query = { ...viewQuery(view), name };
  const valid = GOAL_NAME_RE.test(name);
  const data = useQuery({ queryKey: keys.siteData(siteId, "goal-props", query), queryFn: () => call(api.sites[":id"]["goal-props"].$get({ param: { id: siteId }, query })), enabled: valid });
  if (!valid) return <p className="text-xs text-muted">Properties can't be listed for a goal with this name.</p>;
  if (data.isPending) return <Spinner className="size-4" />;
  if (data.isError) return <p className="text-xs text-danger">{data.error.message}</p>;
  const rows = data.data.rows;
  if (!rows.length) {
    return (
      <p className="text-xs text-muted">
        No properties were sent with this goal. Add them as <code className="font-mono">data-sh-goal-plan="pro"</code>, or as the third argument of <code className="font-mono">shorthop("goal", …)</code>.
      </p>
    );
  }
  const keysOf = [...new Set(rows.map((r) => r.key))];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {keysOf.map((k) => {
        const values = rows.filter((r) => r.key === k).slice(0, 10);
        return (
          <div key={k} className="rounded-md border border-line p-2">
            <p className="mb-1 font-mono text-xs font-medium text-fg">{k}</p>
            <ul className="space-y-0.5 text-xs">
              {values.map((v) => (
                <li key={v.value} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate text-fg" title={v.value}>{v.value || "(empty)"}</span>
                  <span className="tabular text-muted">{num(v.count)}</span>
                  <span className="tabular w-12 text-right text-subtle">{completions ? percent(Math.min(1, v.count / completions)) : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ---- Revenue ----------------------------------------------------------------------------------------

function SubscriptionsCard({ siteId, view, site }: { siteId: string; view: SiteView; site: SiteDTO }) {
  const query = viewQuery(view);
  const data = useQuery({ queryKey: keys.siteData(siteId, "subscriptions", query), queryFn: () => call(api.sites[":id"].subscriptions.$get({ param: { id: siteId }, query })) });
  const s = data.data;
  if (!s || (!s.active && !s.started && !s.canceled && !s.renewalRevenue)) return null;
  const items = [
    { label: "MRR", value: money(s.mrr, site.currency), note: `${num(s.active)} active subscription${s.active === 1 ? "" : "s"}` },
    { label: "New subscriptions", value: num(s.started), note: "Started in this period" },
    { label: "Churn", value: percent(s.churnRate), note: `${num(s.canceled)} canceled in this period` },
    { label: "New vs renewal revenue", value: `${money(s.newRevenue, site.currency, true)} / ${money(s.renewalRevenue, site.currency, true)}`, note: "First payments / renewals" },
  ];
  return (
    <Card>
      <CardHeader title="Subscriptions" description="From the providers' subscription events. MRR is now; the rest is for this period." />
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((i) => (
          <div key={i.label} className="rounded-md border border-line px-4 py-3">
            <p className="text-xs text-muted">{i.label}</p>
            <p className="tabular mt-1 text-xl font-semibold tracking-tight">{i.value}</p>
            <p className="mt-0.5 text-xs text-muted">{i.note}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

const CONFIDENCE_TONE = { high: "good", medium: "accent", low: "warn" } as const;

function PaymentsCard({ siteId, view, site }: { siteId: string; view: SiteView; site: SiteDTO }) {
  const can = useCan();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"all" | "matched" | "unmatched">("all");
  const [visitor, setVisitor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<PageSize>(() => savedPageSize("payments"));
  // Searching waits for a pause in typing, and any change of filter goes back to page 1.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const filterKey = JSON.stringify([viewQuery(view), status, q, size]);
  useEffect(() => setPage(1), [filterKey]);
  const base = { ...viewQuery(view), status, ...(q ? { q } : {}) };
  const query = { ...base, limit: String(size), offset: String((page - 1) * size) };
  const data = useQuery({
    queryKey: keys.siteData(siteId, "payments", query),
    queryFn: () => call(api.sites[":id"].payments.$get({ param: { id: siteId }, query })),
    placeholderData: (prev) => prev,
  });
  const rematch = useMutation({
    mutationFn: () => call(api.sites[":id"].rematch.$post({ param: { id: siteId } })),
    onSuccess: (r) => {
      toast.success(r.matched ? `Matched ${r.matched} of ${r.tried} payments` : `None of ${r.tried} payments could be matched yet`);
      void qc.invalidateQueries({ queryKey: keys.site(siteId) });
    },
  });
  const list = data.data?.payments ?? [];
  const total = data.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const csvQuery = new URLSearchParams(base).toString();

  return (
    <Card>
      <CardHeader
        title="Payments"
        description="Each payment, the visit it was matched to, and the visit the attribution model credits."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Payments shown" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "matched", label: "Matched" }, { value: "unmatched", label: "Not matched" }]} />
            {can("sites.manage") ? <Button size="sm" variant="outline" onClick={() => rematch.mutate()} loading={rematch.isPending}><RefreshCw /> Match again</Button> : null}
            <DownloadButton href={`/_admin/api/sites/${siteId}/payments.csv?${csvQuery}`} title="Download every payment of the period as CSV">CSV</DownloadButton>
          </div>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
          <Input aria-label="Search payments" placeholder="Search email, customer or payment id" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 pl-9 text-sm" />
        </div>
        {data.data ? (
          <p className="tabular text-xs text-muted">
            {num(total)} payment{total === 1 ? "" : "s"}{q ? " found" : " in this period"} · net {money(data.data.net, site.currency)}
          </p>
        ) : null}
      </div>
      {data.isPending ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : !list.length ? (
        <Empty icon={<CircleDollarSign />} title={q ? "No payment matches that search" : "No payments in this period"}>{q ? "Try part of the email or the provider's payment id." : "Connect a payment provider in Settings & setup."}</Empty>
      ) : (
        <div className={cn("px-4 pb-4 transition-opacity", data.isPlaceholderData && "opacity-60")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1.5 font-medium">When</th>
                  <th className="py-1.5 text-right font-medium">Amount</th>
                  <th className="py-1.5 pl-4 font-medium">Customer</th>
                  <th className="py-1.5 font-medium">Credited to</th>
                  <th className="py-1.5 font-medium">Matched by</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => <PaymentRow key={p.id} p={p} site={site} onVisitor={setVisitor} />)}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pages={pages}
            size={size}
            total={total}
            onPage={setPage}
            onSize={(s) => {
              setSize(s);
              savePageSize("payments", s);
            }}
          />
        </div>
      )}
      <VisitorDialog siteId={siteId} visitorId={visitor} site={site} onClose={() => setVisitor(null)} />
    </Card>
  );
}

function PaymentRow({ p, site, onVisitor }: { p: SitePaymentDTO; site: SiteDTO; onVisitor: (id: string) => void }) {
  const c = p.credited;
  const kind = p.kind === "charge" ? (p.billing === "sub_renewal" ? "Renewal" : p.billing === "sub_new" ? "New subscription" : "One-time") : p.kind === "refund" ? "Refund" : p.kind === "dispute" ? "Dispute" : "Dispute won";
  return (
    <tr className="border-t border-line align-top">
      <td className="py-2.5 pr-3 whitespace-nowrap">
        <div>{whenFull(p.occurredAt)}</div>
        <div className="text-xs text-muted">{p.provider} · {kind}{p.testMode ? " · test" : ""}</div>
      </td>
      <td className={cn("tabular py-2.5 text-right font-medium whitespace-nowrap", p.amountMinor < 0 && "text-danger")}>
        <div>{money(p.amountMinor, p.currency)}</div>
        {p.currency !== site.currency && p.amountSiteMinor !== null ? <div className="text-xs font-normal text-muted">{money(p.amountSiteMinor, site.currency)}</div> : null}
        {p.amountSiteMinor === null ? <div className="text-xs font-normal text-warn">Rate pending</div> : null}
      </td>
      <td className="max-w-48 truncate py-2.5 pl-4 text-muted">{p.email ?? p.customerId ?? "–"}</td>
      <td className="py-2.5 pr-3">
        {c ? (
          <button type="button" className="text-left hover:underline" onClick={() => p.visitorId && onVisitor(p.visitorId)} title="Show the customer's journey">
            <div className="font-medium">{c.link ? `🔗 ${c.link}` : c.source || c.channel}</div>
            <div className="text-xs text-muted">{[c.channel, c.campaign, c.entry, c.country && `${flag(c.country)} ${countryName(c.country)}`].filter(Boolean).join(" · ")}</div>
          </button>
        ) : (
          <span className="text-muted">–</span>
        )}
      </td>
      <td className="py-2.5">
        {p.matchedBy ? (
          <Badge tone={CONFIDENCE_TONE[(p.confidence ?? "low") as keyof typeof CONFIDENCE_TONE] ?? "neutral"} title={confidenceMeaning(p.confidence)}>
            {matchLabel(p.matchedBy)} · {p.confidence ?? "low"}
          </Badge>
        ) : p.kind === "charge" ? (
          <span className="text-xs text-warn" title={p.unmatchedReason ?? undefined}>{p.unmatchedReason ?? "Not matched"}</span>
        ) : (
          <span className="text-xs text-muted">Follows its charge</span>
        )}
      </td>
    </tr>
  );
}

function VisitorDialog({ siteId, visitorId, site, onClose }: { siteId: string; visitorId: string | null; site: SiteDTO; onClose: () => void }) {
  const profile = useQuery({
    queryKey: keys.siteData(siteId, "visitor", { visitorId }),
    queryFn: () => call(api.sites[":id"].visitors[":visitor"].$get({ param: { id: siteId, visitor: visitorId! } })),
    enabled: Boolean(visitorId),
  });
  const v = profile.data;
  return (
    <Dialog open={Boolean(visitorId)} onOpenChange={(o) => !o && onClose()} title={v?.email ?? v?.name ?? "Customer journey"} description="Every visit and payment of this visitor, newest first." wide>
      {!v ? (
        <div className="flex justify-center py-10">{profile.isError ? <p className="text-sm text-danger">{profile.error.message}</p> : <Spinner />}</div>
      ) : (
        <ol className="space-y-3">
          {[...v.payments.map((p) => ({ t: p.occurredAt, kind: "payment" as const, p })), ...v.sessions.map((s) => ({ t: s.startedAt, kind: "visit" as const, s }))]
            .sort((a, b) => b.t - a.t)
            .map((e) =>
              e.kind === "payment" ? (
                <li key={`p${e.p.id}`} className="flex items-center gap-3 rounded-md border border-good/30 bg-good-soft px-3 py-2 text-sm">
                  <CircleDollarSign className="size-4 text-good" />
                  <span className="font-medium">{money(e.p.amountMinor, e.p.currency)}</span>
                  <span className="text-muted">{e.p.provider} · {whenFull(e.t)}</span>
                </li>
              ) : (
                <li key={`s${e.s.id}`} className="rounded-md border border-line px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.s.link ? `🔗 ${e.s.link}` : e.s.source}</span>
                    <Badge>{e.s.channel}</Badge>
                    {e.s.campaign ? <Badge tone="accent">{e.s.campaign}</Badge> : null}
                    <span className="ml-auto text-xs text-muted">{whenFull(e.t)}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    {e.s.entry} → {e.s.exit} · {num(e.s.pageviews)} pages · {duration(e.s.engagedSec)} · {flag(e.s.country)} {e.s.city || countryName(e.s.country)} · {e.s.device}, {e.s.browser}
                  </div>
                </li>
              ),
            )}
        </ol>
      )}
      <p className="mt-4 text-xs text-muted">Visits of {site.idMode === "cookieless" ? "cookieless sites can only be linked within one day" : "this visitor on this browser"}.</p>
    </Dialog>
  );
}

function LiveCard({ siteId }: { siteId: string }) {
  const live = useQuery({ queryKey: keys.siteData(siteId, "live", {}), queryFn: () => call(api.sites[":id"].live.$get({ param: { id: siteId } })), refetchInterval: 15_000 });
  const list = live.data?.sessions.slice(0, 12) ?? [];
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Radio className="size-4 text-accent" /> Latest visits</span>} description="Refreshes every 15 seconds." />
      {!list.length ? (
        <Empty title="No visits yet" />
      ) : (
        <ul className="divide-y divide-line px-4 pb-2">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span aria-hidden>{flag(s.country)}</span>
              <span className="font-medium">{s.link ? `🔗 ${s.link}` : s.source}</span>
              <span className="text-xs text-muted">{s.channel}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{s.entry}{s.exit !== s.entry ? ` → ${s.exit}` : ""} · {num(s.pageviews)} pages</span>
              <span className="text-xs text-subtle">{ago(s.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

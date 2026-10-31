// The website dashboard (/sites/:id). One page, read top to
// bottom: header with a site switcher → KPI strip (revenue first; each KPI is
// a tab that switches the chart) → chart → path to money → open two-column
// lists → full-width reports → payments → latest visits. The view (period,
// filters) lives in the URL (lib/sites useSiteView).

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, X } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { GRANULARITIES, type Granularity, type SiteListItem } from "../../../shared/sites";
import { api, ApiError, call, keys } from "../../api";
import { day, num } from "../../lib/format";
import { DIM_LABELS, duration, GRANULARITY_LABELS, percent, sitePath } from "../../lib/sites";
import { NoneValue, PeriodBar, rangeLabel } from "../parts";
import { Badge, Button, Columns, ErrorState, Menu, Notice, Section, Select, Skeleton, StatStrip, StatStripSkeleton, type StatItem } from "../ui";
import { buildSiteBuckets, METRIC_LABEL, metricTotal, SiteTrend, SiteTrendTable, type SiteMetric } from "./chart";
import { moneyShort, sitePages, RowsSkeleton, SiteDelta, useSiteDashboard, valueLabel, type Dash, type DeltaKind } from "./common";
import { CustomerValue, PathToMoney, Payments, PurchasePath, Subscriptions } from "./money";
import { Funnels, LatestVisits, PageSpeed, PeakHours, Reading } from "./insights";
import { AcquisitionPanel, AiPanel, ContentPanel, DevicesPanel, GoalsPanel, LinksPanel, LocationPanel } from "./panels";

export function SitePage() {
  const d = useSiteDashboard();
  const sites = useQuery({ queryKey: keys.sites, queryFn: () => call(api.sites.$get()), refetchInterval: 60_000 });
  const listed = sites.data?.sites.find((s) => s.id === d.id);
  const o = d.o;
  const notFound = d.overview.error instanceof ApiError && d.overview.error.status === 404;
  return (
    <div className="ui-page ui-site">
      <SiteHeader d={d} sites={sites.data?.sites} listed={listed} />
      <FilterChips d={d} />
      {d.overview.isPending ? (
        <DashboardSkeleton revenue={d.revenue} />
      ) : notFound ? (
        <div className="ui-state">
          <p className="ui-state-title">This website doesn’t exist.</p>
          <p className="ui-state-body">It may have been deleted, or the address is mistyped.</p>
          <Button asChild variant="primary">
            <Link to="/sites?list">All websites</Link>
          </Button>
        </div>
      ) : d.overview.isError ? (
        <ErrorState what="This website’s dashboard" error={d.overview.error} onRetry={() => void d.overview.refetch()} retrying={d.overview.isFetching} />
      ) : o ? (
        <Dashboard d={d} listed={listed} />
      ) : null}
    </div>
  );
}

// ---- Header ----

function SiteSwitcher({ current, sites }: { current: string; sites: SiteListItem[] | undefined }) {
  const navigate = useNavigate();
  const others = (sites ?? []).filter((s) => s.id !== current);
  return (
    <Menu
      label="Websites"
      align="start"
      trigger={
        <button type="button" className="ui-site-switch" aria-label="Switch website">
          <ChevronDown aria-hidden />
        </button>
      }
      items={[
        ...(sites ?? [])
          .filter((s) => s.id === current)
          .map((s) => ({ label: s.name, icon: Check, onSelect: () => undefined })),
        ...others.map((s) => ({ label: s.name, onSelect: () => navigate(sitePath(s.id)) })),
        ...(sites?.length ? (["separator"] as const) : []),
        { label: "All websites", onSelect: () => navigate("/sites?list") },
      ]}
    />
  );
}

function SiteHeader({ d, sites, listed }: { d: Dash; sites: SiteListItem[] | undefined; listed: SiteListItem | undefined }) {
  const o = d.o;
  const site = o?.site ?? listed;
  return (
    <>
      <header className="ui-head ui-site-head">
        <div className="ui-head-main">
          <div className="ui-site-title">
            <h1 className="ui-h1">{site ? site.name : d.overview.isError ? "Website" : <Skeleton className="ui-skel-text" style={{ width: 200, height: 28 }} />}</h1>
            <SiteSwitcher current={d.id} sites={sites} />
          </div>
          <p className="ui-head-sub ui-site-range">
            {site ? (
              <>
                <span className="ui-site-domains" title={site.domains.join(", ")} translate="no">
                  {site.domains[0]}
                  {site.domains.length > 1 ? ` +${site.domains.length - 1}` : ""}
                </span>
                {o?.online ? (
                  <Badge tone="good" className="ui-site-online">
                    {num(o.online)} online now
                  </Badge>
                ) : null}
              </>
            ) : (
              <Skeleton className="ui-skel-text" style={{ width: 260 }} />
            )}
          </p>
        </div>
        <div className="ui-head-tools">
          <Button asChild variant="ghost">
            <Link to={sitePages.guide(d.id)}>Guide</Link>
          </Button>
          {d.manage ? (
            <Button asChild variant="ghost">
              <Link to={sitePages.settings(d.id)}>Settings</Link>
            </Button>
          ) : null}
        </div>
      </header>
      <PeriodBar value={d.view.period} onChange={(period) => d.setView({ period, granularity: undefined })} custom>
        {o && site ? (
          <span>
            {rangeLabel(o.from, o.to)}, {site.timezone.replaceAll("_", " ")}.
          </span>
        ) : d.overview.isError ? null : (
          <Skeleton className="ui-skel-text" style={{ width: 200 }} />
        )}
      </PeriodBar>
    </>
  );
}

function FilterChips({ d }: { d: Dash }) {
  if (!d.filters.length) return null;
  return (
    <div className="ui-site-filters" role="group" aria-label="Filters">
      <span className="ui-site-filters-label">Filtered to</span>
      {d.filters.map(([dim, value]) => {
        const label = valueLabel(dim, value);
        return (
          <button key={dim} type="button" className="ui-site-chip" onClick={() => d.removeFilter(dim)} aria-label={`Remove filter ${DIM_LABELS[dim]}: ${label}`}>
            <span className="ui-site-chip-dim">{DIM_LABELS[dim]}</span>
            <span className="ui-site-chip-val">{label}</span>
            <X aria-hidden />
          </button>
        );
      })}
      {d.filters.length > 1 ? (
        <button type="button" className="ui-link-btn ui-site-clear" onClick={() => d.setView({ filters: {} })}>
          Clear all
        </button>
      ) : null}
    </div>
  );
}

// ---- Loading ----

function DashboardSkeleton({ revenue }: { revenue: boolean }) {
  const n = revenue ? 5 : 4;
  return (
    <div aria-busy aria-label="Loading the dashboard">
      <StatStripSkeleton count={n} className="ui-site-kpis" />
      <Skeleton className="ui-skel-chart" style={{ height: 260, marginBottom: 40 }} />
      <div className="ui-columns">
        <RowsSkeleton rows={6} />
        <RowsSkeleton rows={6} />
      </div>
    </div>
  );
}

// ---- The dashboard ----

function useKpis(d: Dash): StatItem<SiteMetric>[] {
  const o = d.o!;
  const t = o.totals;
  const p = o.previous;
  const cur = o.site.currency;
  const conv = metricTotal("conversion", o.series);
  const prevConv = o.previousSeries ? metricTotal("conversion", o.previousSeries) : null;
  const delta = (kind: DeltaKind, c: number, pv: number | undefined | null, good = true) => <SiteDelta kind={kind} current={c} previous={pv} good={good} currency={cur} />;
  // Paused by the owner: a drop in visits is the pause, not news. No red deltas, one plain note.
  const paused = !o.site.tracking;
  const visit = (kind: DeltaKind, c: number, pv: number | undefined | null) => (paused ? undefined : delta(kind, c, pv));
  const visitNote = (note: string) => (paused ? "Tracking paused" : note);
  // Nothing was measured: a big "0s" or "0%" would read as data. Time and
  // conversion need visits; while paused, a zero count isn't a measurement.
  const untracked = paused && t.sessions === 0;
  const notMeasured = <span className="ui-kpi-na">{paused ? "Not tracked" : "No visits"}</span>;
  // A period with no visits and no payments: dashes, not zeros.
  const none = t.sessions === 0 && t.payments === 0;
  const count = (n: number) => (none ? <NoneValue /> : num(n));
  return [
    ...(d.revenue
      ? [
          {
            id: "revenue" as const,
            label: "Net revenue",
            value: none && !t.revenue ? <NoneValue /> : moneyShort(t.revenue, cur, true),
            delta: delta("money", t.revenue, p?.revenue),
            note: t.payments ? `${num(t.payments)} ${t.payments === 1 ? "payment" : "payments"}${t.refunds ? `, ${moneyShort(t.refunds, cur)} refunded` : ""}` : "No payments in this period",
          },
        ]
      : []),
    { id: "visitors", label: "Visitors", value: untracked ? notMeasured : count(t.visitors), delta: visit("count", t.visitors, p?.visitors), note: visitNote(none ? "No visits in this period" : `${num(t.linkVisitors)} via short links`) },
    { id: "sessions", label: "Visits", value: untracked ? notMeasured : count(t.sessions), delta: visit("count", t.sessions, p?.sessions), note: visitNote(none ? "No visits in this period" : `${t.sessions ? (t.pageviews / t.sessions).toFixed(1) : "0"} pages per visit`) },
    { id: "engaged", label: "Time per visit", value: t.sessions ? duration(t.avgEngagedSec) : notMeasured, delta: t.sessions ? visit("duration", t.avgEngagedSec, p?.avgEngagedSec) : undefined, note: visitNote("Engaged, tab in view") },
    { id: "conversion", label: "Goal conversion", value: t.sessions ? percent(conv) : notMeasured, delta: t.sessions ? visit("rate", conv, prevConv) : undefined, note: visitNote("Visits with a goal") },
  ];
}

function KpiStrip({ d, metric, setMetric, still }: { d: Dash; metric: SiteMetric; setMetric: (m: SiteMetric) => void; still?: boolean }) {
  const kpis = useKpis(d);
  // Nothing to chart: the numbers are plain, not tabs.
  return <StatStrip items={kpis} value={metric} onChange={still ? undefined : setMetric} className="ui-site-kpis" />;
}

/** The quieter numbers about how visits went, in one line under the strip. */
function VisitFacts({ d }: { d: Dash }) {
  const o = d.o!;
  const t = o.totals;
  const p = o.previous;
  const cur = o.site.currency;
  const paused = !o.site.tracking;
  const facts: { label: string; value: string; delta?: ReactNode; title: string }[] = [
    { label: "Left after one page", value: percent(t.bounceRate), delta: paused ? null : <SiteDelta kind="rate" current={t.bounceRate} previous={p?.bounceRate} good={false} />, title: "Visits with one page and no goal. Lower is better; the change is in percentage points." },
    { label: "Pageviews", value: num(t.pageviews), delta: paused ? null : <SiteDelta current={t.pageviews} previous={p?.pageviews} />, title: "Every page loaded in the period." },
    ...(d.revenue
      ? [
          { label: "Per visitor", value: moneyShort(t.revenuePerVisitor, cur, false), delta: <SiteDelta kind="money" current={t.revenuePerVisitor} previous={p?.revenuePerVisitor} currency={cur} />, title: "Net revenue divided by visitors." },
          { label: "Visitors who paid", value: percent(t.conversion), delta: <SiteDelta kind="rate" current={t.conversion} previous={p?.conversion} />, title: "New customers as a share of visitors; the change is in percentage points." },
        ]
      : []),
  ];
  return (
    <dl className="ui-site-facts ui-site-visitfacts">
      {facts.map((f) => (
        <div key={f.label} title={f.title}>
          <dt>{f.label}</dt>
          <dd>
            <span className="ui-site-fact-value">{f.value}</span>
            {f.delta}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const BY: Record<Granularity, string> = { hour: "by hour", day: "by day", week: "by week", month: "by month" };

function ChartBlock({ d, metric }: { d: Dash; metric: SiteMetric }) {
  const o = d.o!;
  const [table, setTable] = useState(false);
  const [compare, setCompare] = useState(true);
  const id = useId();
  const buckets = useMemo(() => buildSiteBuckets(o.series, o.previousSeries, o.spikes, o.granularity, o.site.timezone), [o]);
  const hasSpikes = buckets.some((b) => b.spikes.length);
  const g = d.view.granularity ?? o.granularity;
  return (
    <section className="ui-chart-block ui-site-chart" aria-labelledby={`${id}-t`}>
      <header className="ui-chart-head">
        <h2 id={`${id}-t`} className="ui-h2">
          {METRIC_LABEL[metric]}, {BY[o.granularity]}
</h2>
        <div className="ui-chart-tools">
          <Select
            label="Chart buckets"
            hideLabel
            className="ui-site-buckets"
            value={g}
            onChange={(e) => d.setView({ granularity: e.target.value as Granularity })}
            options={GRANULARITIES.map((x) => ({ value: x, label: `${GRANULARITY_LABELS[x]} buckets` }))}
          />
          {o.previousSeries ? (
            <label className="ui-check">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
              <span className="ui-legend-prev" aria-hidden />
              Previous period
            </label>
          ) : null}
          <button type="button" className="ui-link-btn" onClick={() => setTable((v) => !v)} aria-pressed={table}>
            {table ? "Show chart" : "Show table"}
          </button>
        </div>
      </header>
      {table ? (
        <SiteTrendTable buckets={buckets} currency={o.site.currency} revenue={d.revenue} />
      ) : (
        <SiteTrend buckets={buckets} metric={metric} currency={o.site.currency} height={252} compare={compare && Boolean(o.previousSeries)} revenue={d.revenue} labelledBy={`${id}-t`} />
      )}
      {hasSpikes && !table ? (
        <p className="ui-chart-note">
          <span className="ui-site-spike-key" aria-hidden /> Traffic spike: one source sent at least 4× its usual hourly visits. Hover or use the arrow keys for details.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Everything that needs Cloudflare Analytics Engine, named once in one quiet
 * line instead of a "needs live data" block per section. Each section comes
 * back on its own once the data exists.
 */
function LiveDataNotice({ d }: { d: Dash }) {
  const o = d.o!;
  if (o.aeAvailable) return null;
  return (
    <Notice
      className="ui-site-notice ui-site-live-notice"
      title="Pages, goals, funnel reports, reading and page speed need live data from Cloudflare Analytics Engine."
      action={
        d.can("settings.manage") ? (
          <Button asChild size="sm">
            <a href="/_admin/settings#statistics">Connect in Settings</a>
          </Button>
        ) : undefined
      }
    />
  );
}

function Dashboard({ d, listed }: { d: Dash; listed: SiteListItem | undefined }) {
  const o = d.o!;
  const site = o.site;
  const t = o.totals;
  const [metric, setMetric] = useState<SiteMetric>("visitors");
  const nothing = t.sessions === 0 && t.payments === 0;
  const longer = d.view.period.range === "today" ? "7d" : d.view.period.range === "7d" ? "30d" : d.view.period.range === "30d" ? "90d" : "all";
  const installSeen = listed ? listed.lastSeenAt !== null : true;
  return (
    <>
      {!site.tracking ? (
        <Notice
          tone="warn"
          className="ui-site-notice"
          title="Tracking is paused."
          action={
            d.manage ? (
              <Button asChild size="sm">
                <Link to={sitePages.settings(d.id)}>Turn it back on</Link>
              </Button>
            ) : undefined
          }
        >
          Visits aren’t recorded and short links aren’t tagged. Payments still are.
        </Notice>
      ) : null}
      {nothing && d.filters.length ? (
        <Notice
          className="ui-site-notice"
          title="No visits match these filters."
          action={
            <Button size="sm" onClick={() => d.setView({ filters: {} })}>
              Clear filters
            </Button>
          }
        >
          Nothing between {day(o.from)} and {day(o.to)} fits every filter above.
        </Notice>
      ) : nothing && site.tracking && !installSeen ? (
        <Notice
          className="ui-site-notice"
          title={`No visits have arrived from ${site.domains[0] ?? "this site"} yet.`}
          action={
            <Button asChild size="sm" variant="primary">
              <Link to={sitePages.guide(d.id)}>Open the install guide</Link>
            </Button>
          }
        >
          Add the tracking script to the site; visits show up here within seconds.
        </Notice>
      ) : nothing && site.tracking ? (
        <Notice
          className="ui-site-notice"
          title={`No visits between ${day(o.from)} and ${day(o.to)}.`}
          action={
            <Button size="sm" onClick={() => d.setView({ period: { range: longer }, granularity: undefined })}>
              Show {longer === "all" ? "all time" : longer === "7d" ? "7 days" : longer === "30d" ? "30 days" : "90 days"}
            </Button>
          }
        >
          The script is installed; this period simply had no traffic.
        </Notice>
      ) : null}

      <KpiStrip d={d} metric={metric} setMetric={setMetric} still={nothing} />
      {nothing ? null : (
        <>
          <VisitFacts d={d} />
          <ChartBlock d={d} metric={metric} />

          <LiveDataNotice d={d} />

          <Section title={d.revenue ? "Path to money" : "Path to action"} sub="Each step as a share of everyone who came, and how many made it from the step before." className="ui-site-path-section">
            <PathToMoney t={t} p={site.tracking ? o.previous : null} revenue={d.revenue} />
            {d.revenue ? <Subscriptions d={d} /> : null}
            {d.revenue && o.unmatched ? (
              <p className="ui-site-note">
                {num(o.unmatched)} {o.unmatched === 1 ? "payment" : "payments"} in this period couldn’t be matched to a visit, so {o.unmatched === 1 ? "it counts" : "they count"} in the total but not by source.{" "}
                <a href="#ui-site-payments">See why under Payments</a>.
              </p>
            ) : null}
          </Section>

          <Columns className="ui-site-columns">
            <LinksPanel d={d} />
            <AcquisitionPanel d={d} />
            <ContentPanel d={d} />
            <AiPanel d={d} />
            <LocationPanel d={d} />
            <DevicesPanel d={d} />
            {o.aeAvailable ? <GoalsPanel d={d} /> : null}
          </Columns>

          {d.revenue ? <PurchasePath d={d} /> : null}
          {d.revenue ? <CustomerValue d={d} /> : null}
        </>
      )}
      {/* Kept with no visits in the period: payments can arrive without a visit, funnels are set up ahead of traffic. */}
      {d.revenue ? (
        <div id="ui-site-payments">
          <Payments d={d} />
        </div>
      ) : null}
      <Funnels d={d} live={o.aeAvailable} />
      <PeakHours d={d} />
      {nothing ? null : (
        <>
          {o.aeAvailable ? <Reading d={d} /> : null}
          {o.aeAvailable ? <PageSpeed d={d} /> : null}
        </>
      )}
      <LatestVisits d={d} />
    </>
  );
}

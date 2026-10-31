// "How is this link doing": KPI strip (each number switches the chart), the
// trend chart, routing results, breakdown lists and the latest hits. Built
// from the shared analytics pieces (parts.tsx, ui/); the look is home.css +
// ui.css, with link.css for what's new here.

import { AlertTriangle } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { utcDate } from "../../../shared/dates";
import { describeConditions, type Routing } from "../../../shared/routing";
import { IMPORT_SOURCE_LABEL, type BreakdownRow, type LinkDTO, type LinkStatsDTO, type Period } from "../../../shared/types";
import { routeCountryName } from "../../lib/countries";
import { countryName, day, hostOf, num, pct, sourceLabel, when, whenFull } from "../../lib/format";
import { buildBuckets, type Bucket, type Metric } from "../data";
import { breakdownItems, Delta, ErrorState, LiveDataLine, labelOf, NoneValue, moneyShort, rangeLabel, ribbonParts, Rows, RowsSkeleton, Skeleton, SourceRibbon, sourceParts, TabbedPanel, TrendBlock, withSwatches, type RowItem } from "../parts";
import { Badge, Button, Notice, Section, StatStrip, Table, TD, TextButton, TH, type StatItem } from "../ui";
import { linkFilter, type LinkMoney, type useLinkRecent } from "./data";
import { sitePath } from "../../lib/sites";

// ---- KPI strip ----

type Kpi = StatItem<Metric>;

function importedNote(link: LinkDTO): string | null {
  if (link.importedClicks === null) return null;
  const vendor = link.importFrom ?? "csv";
  const name = IMPORT_SOURCE_LABEL[vendor];
  return vendor === "csv" || vendor === "json" ? `${num(link.importedClicks)} before the import` : `Plus ${num(link.importedClicks)} in ${name} before the move`;
}

function revenueKpi(m: LinkMoney, empty: boolean): Kpi | null {
  if (m.state === "hidden") return null;
  if (m.state === "loading") return { id: "revenue", label: "Revenue", value: <Skeleton className="ui-skel-num" />, note: <Skeleton className="ui-skel-text" style={{ width: 90 }} />, disabled: true };
  if (m.state === "error")
    return {
      id: "revenue",
      label: "Revenue",
      value: <span className="ui-kpi-na">Not loaded</span>,
      note: <button type="button" className="ui-link-btn" onClick={(e) => { e.stopPropagation(); m.retry(); }}>Try again</button>,
      disabled: true,
    };
  if (m.state === "none") return { id: "revenue", label: "Revenue", value: <span className="ui-kpi-na">No sales tracked</span>, note: "No visits to your websites in 12 months", disabled: true };
  const other = m.others.map((o) => moneyShort(o.revenue, o.currency, true));
  return {
    id: "revenue",
    label: "Revenue",
    value: empty && !m.revenue && !m.customers ? <NoneValue /> : moneyShort(m.revenue, m.currency, true),
    delta: <Delta current={m.revenue} previous={m.previous} />,
    note: other.length
      ? `${num(m.customers)} ${m.customers === 1 ? "customer" : "customers"}, plus ${other.join(", ")}`
      : m.customers || m.revenue
        ? `${num(m.customers)} ${m.customers === 1 ? "customer" : "customers"} from ${num(m.visitors)} ${m.visitors === 1 ? "visit" : "visits"}`
        : "No sales in this period",
  };
}

function kpisOf(s: LinkStatsDTO, link: LinkDTO, money: LinkMoney, period: Period): Kpi[] {
  const cmp = s.comparison;
  const all = s.totals.clicks + s.totals.bots;
  // A period without a single hit: dashes, not zeros; "yet" only for all time.
  const empty = all === 0;
  const count = (n: number) => (empty ? <NoneValue /> : num(n));
  const rev = revenueKpi(money, empty);
  return [
    {
      id: "clicks",
      label: "Human clicks",
      value: count(s.totals.clicks),
      delta: cmp && <Delta current={cmp.current.clicks} previous={cmp.previous.clicks} />,
      note: importedNote(link) ?? (all ? `${pct(s.totals.clicks, all)} of all hits` : period.range === "all" ? "No hits yet" : "No hits in this period"),
    },
    { id: "uniques", label: "Unique visitors", value: count(s.totals.uniques), delta: cmp && <Delta current={cmp.current.uniques} previous={cmp.previous.uniques} />, note: "Counted once a day" },
    ...(rev ? [rev] : []),
    { id: "bots", label: "Bots and previews", value: count(s.totals.bots), delta: cmp && <Delta current={cmp.current.bots} previous={cmp.previous.bots} good={false} />, note: "Not counted as clicks", quiet: true },
  ];
}

export function LinkKpis({ s, link, money, metric, onMetric, period }: { s: LinkStatsDTO; link: LinkDTO; money: LinkMoney; metric: Metric; onMetric: (m: Metric) => void; period: Period }) {
  return <StatStrip items={kpisOf(s, link, money, period)} value={metric} onChange={onMetric} />;
}

// ---- Chart ----

/** Day buckets from the link's series, with this link's revenue added per day. */
export function useLinkBuckets(s: LinkStatsDTO | undefined, money: LinkMoney) {
  return useMemo(() => {
    if (!s) return null;
    const { buckets, weekly } = buildBuckets(s.series, s.comparison?.series, s.aeAvailable, null);
    if (money.state !== "ready") return { buckets, weekly };
    const withMoney: Bucket[] = buckets.map((b) => ({
      ...b,
      revenue: b.dates.reduce((sum, d) => sum + (money.byDate.get(d) ?? 0), 0),
      prevRevenue: money.hasPrevious ? b.dates.reduce((sum, d) => sum + (money.prevByDate.get(d) ?? 0), 0) : undefined,
    }));
    return { buckets: withMoney, weekly };
  }, [s, money]);
}

const CHART_TITLE: Record<Metric, string> = { clicks: "Human clicks", uniques: "Unique visitors", bots: "Bots and previews", revenue: "Revenue from this link" };

export function LinkChart({ s, chart, metric, money }: { s: LinkStatsDTO; chart: { buckets: Bucket[]; weekly: boolean }; metric: Metric; money: LinkMoney }) {
  const ready = money.state === "ready" ? money : null;
  const canCompare = metric === "revenue" ? Boolean(ready?.hasPrevious) : Boolean(s.comparison?.series.length);
  return <TrendBlock title={CHART_TITLE[metric]} buckets={chart.buckets} weekly={chart.weekly} metric={metric} currency={ready?.currency} canCompare={canCompare} height={232} />;
}

// ---- Breakdown panels ----

type DimId = keyof LinkStatsDTO["dims"];
const KIND: Partial<Record<DimId, Parameters<typeof labelOf>[0]>> = { country: "country", source: "source", referrer: "referrer", device: "device", language: "language" };
const FOOT: Partial<Record<DimId, string>> = {
  source: "Worked out from the link’s source tag, the app it was opened in, or the page it came from.",
  referrer: "Most apps and email clients send no referrer.",
  org: "Who runs the visitor’s network: usually an internet provider, sometimes a company.",
  bot: "Still redirected, never counted as clicks.",
};

function DimPanel({ s, title, tabs, limit = 8, lead, swatch }: { s: LinkStatsDTO; title: string; tabs: { id: DimId; label: string }[]; limit?: number; lead?: ReactNode; swatch?: Map<string, string> }) {
  return (
    <TabbedPanel
      title={title}
      tabs={tabs}
      lead={lead}
      render={(tab) => {
        const dim = tab as DimId;
        const metric = dim === "bot" ? "bots" : "clicks";
        const rows = breakdownItems(s.dims[dim] ?? [], KIND[dim] ?? "plain", metric).map((r) => (dim === "bot" ? { ...r, quiet: true } : r));
        const items = dim === "source" && swatch ? withSwatches(rows, swatch) : rows;
        return (
          <>
            <Rows items={items} limit={limit} unit={metric === "bots" ? "bot hits" : "clicks"} emptyText="Nothing in this period." />
            {FOOT[dim] && items.length ? <p className="ui-panel-foot">{FOOT[dim]}</p> : null}
          </>
        );
      }}
    />
  );
}

/** Sources, headed by the signature ribbon; the list under it is its legend. */
export function SourcesPanel({ s }: { s: LinkStatsDTO }) {
  const parts = sourceParts(s.dims.source);
  return (
    <DimPanel
      s={s}
      title="Sources"
      tabs={[{ id: "source", label: "Sources" }, { id: "referrer", label: "Referrers" }]}
      lead={<SourceRibbon items={parts} label="Where this link’s human clicks came from, by source" />}
      swatch={ribbonParts(parts).swatch}
    />
  );
}
export function PlacesPanel({ s }: { s: LinkStatsDTO }) {
  return (
    <DimPanel
      s={s}
      title="Locations"
      limit={6}
      tabs={[
        { id: "country", label: "Countries" },
        { id: "region", label: "Regions" },
        { id: "city", label: "Cities" },
        { id: "language", label: "Languages" },
      ]}
    />
  );
}
export function DevicesPanel({ s }: { s: LinkStatsDTO }) {
  return <DimPanel s={s} title="Devices" limit={6} tabs={[{ id: "device", label: "Devices" }, { id: "os", label: "Systems" }, { id: "browser", label: "Browsers" }]} />;
}
/** Only the tabs that have rows; nothing at all when both are empty (a titled "Nothing in this period" is a hole, not news). */
export function OtherPanel({ s }: { s: LinkStatsDTO }) {
  const tabs = [
    ...((s.dims.org ?? []).some((r) => r.clicks > 0) ? [{ id: "org" as const, label: "Networks" }] : []),
    ...((s.dims.bot ?? []).some((r) => r.bots > 0) ? [{ id: "bot" as const, label: "Bots and previews" }] : []),
  ];
  if (!tabs.length) return null;
  return <DimPanel key={tabs.length} s={s} title={tabs.length === 2 ? "Networks and bots" : tabs[0]!.label} limit={6} tabs={tabs} />;
}

/** Revenue by website for this link in the period; rows open the site filtered to the link. */
export function MoneyPanel({ money, period, domain, slug }: { money: LinkMoney; period: Period; domain: string; slug: string }) {
  if (money.state === "hidden" || money.state === "none") return null;
  const view = (id: string) => {
    const q = new URLSearchParams({ range: period.range, f_link: linkFilter(domain, slug) });
    if (period.range === "custom" && period.from && period.to) {
      q.set("from", period.from);
      q.set("to", period.to);
    }
    return `${sitePath(id)}?${q}`;
  };
  return (
    <TabbedPanel
      title="Revenue by website"
      tabs={[{ id: "sites", label: "Revenue by website" }]}
      className="ui-panel-money"
      render={() => {
        if (money.state === "loading") return <RowsSkeleton rows={2} />;
        if (money.state === "error") return <ErrorState what="Revenue" error={money.error} onRetry={money.retry} compact />;
        const items: RowItem[] = money.sites.map((x) => ({
          key: x.id,
          label: x.name,
          sub: `${num(x.payments)} ${x.payments === 1 ? "payment" : "payments"} from ${num(x.visitors)} ${x.visitors === 1 ? "visit" : "visits"}`,
          value: Math.max(0, x.revenue),
          display: moneyShort(x.revenue, x.currency, true),
          extra: <Delta current={x.revenue} previous={x.previous} className="ui-row-delta" />,
          to: view(x.id),
        }));
        return (
          <>
            <Rows items={items} limit={5} unit={money.currency} showShare={false} emptyText="This link brought no visits to your websites in this period." />
            {money.others.length ? (
              <p className="ui-panel-foot">
                Not added to the total, other currency:{" "}
                {money.others.map((o, i) => (
                  <span key={o.id}>
                    {i ? ", " : ""}
                    <Link to={view(o.id)}>{o.name}</Link> {moneyShort(o.revenue, o.currency, true)}
                  </span>
                ))}
                .
              </p>
            ) : null}
          </>
        );
      }}
    />
  );
}

// ---- Smart routing results ----

/** Below this many clicks in a split, shares can stray far from the weights by chance alone. */
const SMALL_SAMPLE = 100;

export function RoutingPanel({ routing, rows, period, from, onPeriod }: { routing: Routing; rows: BreakdownRow[]; period: Period; from: string; onPeriod: (p: Period) => void }) {
  const clicks = new Map(rows.map((r) => [r.value, r.clicks]));
  const total = rows.reduce((s, r) => s + r.clicks, 0);
  const ruleClicks = (rid: string) => rows.filter((r) => r.value === rid || r.value.startsWith(`${rid}.`)).reduce((s, r) => s + r.clicks, 0);
  const known = new Set(routing.rules.flatMap((r) => [r.id, ...r.variants.map((v) => `${r.id}.${v.id}`)]));
  const fallback = clicks.get("-") ?? 0;
  const earlier = rows.filter((r) => r.value !== "-" && !known.has(r.value)).reduce((s, r) => s + r.clicks, 0);
  const changedDay = utcDate(new Date(Number(routing.changedAt) * 1000));
  const mixed = Number(routing.changedAt) > 0 && changedDay > from;
  const share = (n: number) => (total ? pct(n, total) : "–");
  const [open, setOpen] = useState(false);
  const splits = routing.rules.filter((r) => r.variants.length > 1).length;
  const setup = `${num(routing.rules.length)} ${routing.rules.length === 1 ? "rule" : "rules"}${splits ? `, ${num(splits)} ${splits === 1 ? "split" : "splits"}` : ""}`;

  // Nothing routed in the period: one line, the rules behind "Show rules".
  if (!total)
    return (
      <Section
        title="Smart routing"
        className="ui-ld-routing is-compact"
        sub={`${setup} · no routed clicks in this period.`}
        aside={
          <TextButton onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide rules" : "Show rules"}
          </TextButton>
        }
      >
        {open ? <RuleList routing={routing} ruleClicks={ruleClicks} clicks={clicks} fallback={fallback} share={share} /> : null}
      </Section>
    );

  return (
    <Section
      title="Smart routing"
      className="ui-ld-routing"
      sub={`Where ${num(total)} human ${total === 1 ? "click" : "clicks"} went in this period (${setup}). Bots and previews always get the default destination.`}
    >
      {mixed ? (
        <Notice
          className="ui-ld-notice"
          action={
            period.range !== "custom" || period.from !== changedDay ? (
              <Button size="sm" onClick={() => onPeriod({ range: "custom", from: changedDay, to: utcDate() })}>
                Show results since then
              </Button>
            ) : undefined
          }
        >
          The destinations or shares changed on {whenFull(Number(routing.changedAt))}, so this period mixes two setups.
        </Notice>
      ) : null}
      <RuleList routing={routing} ruleClicks={ruleClicks} clicks={clicks} fallback={fallback} share={share} />
      {earlier ? <p className="ui-panel-foot">{num(earlier)} {earlier === 1 ? "click" : "clicks"} went through rules or destinations that have since been removed.</p> : null}
    </Section>
  );
}

/** The rules with their clicks and, for splits, observed against set shares. */
function RuleList({ routing, ruleClicks, clicks, fallback, share }: { routing: Routing; ruleClicks: (rid: string) => number; clicks: Map<string, number>; fallback: number; share: (n: number) => string }) {
  return (
    <ol className="ui-ld-rules">
      {routing.rules.map((r, i) => {
        const n = ruleClicks(r.id);
        const split = r.variants.length > 1;
        const cond = describeConditions(r, routeCountryName);
        return (
          <li key={r.id} className="ui-ld-rule">
            <div className="ui-ld-rule-head">
              <span className="ui-ld-rule-n" aria-hidden>{i + 1}</span>
              <span className="ui-ld-rule-name">
                <span className="ui-ld-rule-title">{r.name || cond}</span>
                {r.name ? <span className="ui-ld-rule-cond">{cond}</span> : null}
                {!r.enabled ? <Badge>Paused</Badge> : null}
              </span>
              <span className="ui-row-share">{share(n)}</span>
              <span className="ui-row-value">
                {num(n)}
                <span className="ui-sr"> clicks</span>
              </span>
            </div>
            {split ? (
              <div className="ui-ld-variants">
                {r.variants.map((v) => {
                  const c = clicks.get(`${r.id}.${v.id}`) ?? 0;
                  const observed = n ? (c / n) * 100 : 0;
                  return (
                    <div key={v.id} className="ui-ld-variant">
                      <span className="ui-ld-variant-name" title={v.url}>
                        <strong>{v.label || "Variant"}</strong> {hostOf(v.url)}
                      </span>
                      <span className="ui-ld-split" aria-hidden>
                        <span className="ui-ld-split-bar" style={{ width: `${Math.min(100, observed)}%` }} />
                        <span className="ui-ld-split-tick" style={{ left: `${v.weight}%` }} />
                      </span>
                      <span className="ui-ld-variant-num">
                        <strong>{n ? `${Math.round(observed)}%` : "–"}</strong> of {v.weight}% set · {num(c)}
                      </span>
                    </div>
                  );
                })}
                {n > 0 && n < SMALL_SAMPLE ? (
                  <p className="ui-ld-small">
                    <AlertTriangle aria-hidden /> Only {num(n)} clicks so far: shares can differ from the split by chance. Wait for at least {SMALL_SAMPLE}.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="ui-ld-rule-to" title={r.variants[0]?.url}>
                To {r.variants[0]?.url}
              </p>
            )}
          </li>
        );
      })}
      <li className="ui-ld-rule">
        <div className="ui-ld-rule-head">
          <span className="ui-ld-rule-n is-rest" aria-hidden>·</span>
          <span className="ui-ld-rule-name">
            <span className="ui-ld-rule-title">Everyone else</span>
            <span className="ui-ld-rule-cond">the default destination</span>
          </span>
          <span className="ui-row-share">{share(fallback)}</span>
          <span className="ui-row-value">
            {num(fallback)}
            <span className="ui-sr"> clicks</span>
          </span>
        </div>
      </li>
    </ol>
  );
}

// ---- Latest hits (Analytics Engine) ----

export function LatestHits({ q, domain, slug }: { q: ReturnType<typeof useLinkRecent>; domain: string; slug: string }) {
  const more = `/hits?${new URLSearchParams({ domain, slug })}`;
  let body: ReactNode;
  if (q.isPending) body = <RowsSkeleton rows={4} />;
  else if (q.isError || q.data.error) body = <ErrorState what="Latest hits" error={q.isError ? q.error : new Error(q.data.error)} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />;
  else if (!q.data.aeAvailable) body = <LiveDataLine />;
  else if (!q.data.hits.length) body = <p className="ui-rows-empty">No hits in the last 7 days.</p>;
  else
    body = (
      <Table label="Latest hits of this link" dense className="ui-ld-hits">
        <thead>
          <tr>
            <TH>Time</TH>
            <TH>Type</TH>
            <TH>Location</TH>
            <TH>Device</TH>
            <TH>Source</TH>
            <TH>Referrer</TH>
          </tr>
        </thead>
        <tbody>
          {q.data.hits.map((h, i) => (
            <tr key={`${h.time}-${i}`}>
              <TD className="ui-ld-nowrap">{when(h.time)}</TD>
              <TD>{h.event === "bot" ? <Badge tone="warn">{h.botName || "Bot"}</Badge> : <span className="ui-ld-quiet">Click</span>}</TD>
              <TD>{[h.city, countryName(h.country)].filter(Boolean).join(", ")}</TD>
              <TD className="ui-ld-quiet">{[h.device, h.os, h.browser].filter(Boolean).join(" · ")}</TD>
              <TD>{sourceLabel(h.source || "direct")}</TD>
              <TD className="ui-ld-quiet ui-ld-ref">{h.referrer || "–"}</TD>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  return (
    <Section
      title="Latest hits"
      sub="The last 7 days, newest first."
      aside={
        <Link to={more} className="ui-panel-link">
          Filter and see more
        </Link>
      }
    >
      {body}
    </Section>
  );
}

// ---- Empty period ----

export function EmptyPeriod({ s, period, onPeriod }: { s: LinkStatsDTO; period: Period; onPeriod: (p: Period) => void }) {
  const longer: Period["range"] = period.range === "today" ? "7d" : period.range === "7d" ? "30d" : period.range === "30d" ? "90d" : "all";
  const label = longer === "all" ? "all time" : longer === "7d" ? "7 days" : longer === "30d" ? "30 days" : "90 days";
  return (
    <div className="ui-empty-notice" role="status">
      <p>
        <strong>{s.from === s.to ? `No clicks on ${day(s.from)}.` : `No clicks between ${day(s.from)} and ${day(s.to)}.`}</strong>{" "}
        {period.range === "all" ? "Share the link and the first clicks show up here." : "Share the link, or look at a longer period."}
      </p>
      {period.range !== "all" ? (
        <Button size="sm" onClick={() => onPeriod({ range: longer })}>
          Show {label}
        </Button>
      ) : null}
    </div>
  );
}

/** "2 Oct – 31 Oct, UTC. Saved days only…" */
export function rangeText(s: LinkStatsDTO): string {
  return rangeLabel(s.from, s.to);
}

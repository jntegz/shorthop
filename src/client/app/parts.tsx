// Analytics building blocks shared by the home, the link page and the website
// dashboard: period, deltas, breakdown helpers, the source ribbon and the
// trend chart. Generic components live in ui/; the look is in the CSS files.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { utcDate } from "../../shared/dates";
import type { BreakdownRow, Period, Range } from "../../shared/types";
import { change, countryName, day, fullNum, languageName, num, pct, sourceLabel } from "../lib/format";
import { useMe } from "../lib/me";
import { money } from "../lib/sites";
import { cn } from "../lib/utils";
import type { Bucket, Metric } from "./data";
import { BreakdownList, Button, Dialog, Input, Segmented, Skeleton, Tabs, type BreakdownItem, type SegmentedOption } from "./ui";

// ---- Period ----

type PeriodOption = Range | "pick";

const QUICK: SegmentedOption<PeriodOption>[] = [
  { value: "today", label: "Today", short: "Today" },
  { value: "7d", label: "7 days", short: "7d" },
  { value: "30d", label: "30 days", short: "30d" },
  { value: "90d", label: "90 days", short: "90d" },
  { value: "365d", label: "12 months", short: "12m" },
  { value: "all", label: "All time", short: "All" },
];
const LONGER: { range: Range; label: string }[] = [
  { range: "180d", label: "6 months" },
  { range: "270d", label: "9 months" },
];

function customLabel(p: Period): string {
  if (p.range === "custom" && p.from && p.to) return p.from === p.to ? day(p.from) : `${day(p.from)} – ${day(p.to)}`;
  return LONGER.find((l) => l.range === p.range)?.label ?? "Custom";
}

/**
 * The period as a segmented radio group. With `custom`, a last option
 * "Custom…" opens a dialog with longer ranges and any from–to dates (UTC).
 * Without it, a range from the URL that isn't a
 * quick one shows as one more (chosen) option.
 */
export function PeriodControl({ value, onChange, custom = false }: { value: Period; onChange: (p: Period) => void; custom?: boolean }) {
  const quick = QUICK.some((q) => q.value === value.range);
  const extra: SegmentedOption<PeriodOption>[] = custom
    ? [{ value: "pick", label: quick ? "Custom…" : customLabel(value), short: "Custom" }]
    : quick
      ? []
      : [{ value: value.range, label: customLabel(value), short: "Custom" }];
  const [open, setOpen] = useState(false);
  return (
    <>
      <Segmented<PeriodOption>
        label="Period"
        options={[...QUICK, ...extra]}
        value={custom && !quick ? "pick" : value.range}
        onChange={(v) => (v === "pick" ? setOpen(true) : v !== "custom" && onChange({ range: v }))}
        className="ui-period"
      />
      {custom ? <PeriodDialog open={open} onOpenChange={setOpen} value={value} onChange={onChange} /> : null}
    </>
  );
}

/**
 * The second header row of every analytics page (home, link, website): the
 * period on the left, the range it resolves to (dates, time zone, freshness)
 * right after it. Same place, same order on all three pages (DESIGN §6).
 */
export function PeriodBar({ value, onChange, custom, children, className }: { value: Period; onChange: (p: Period) => void; custom?: boolean; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("ui-period-bar", className)}>
      <PeriodControl value={value} onChange={onChange} custom={custom} />
      {children ? <div className="ui-range">{children}</div> : null}
    </div>
  );
}

/** One date range format everywhere: "Oct 2 – Oct 31" (the browser's locale, like the chart ticks). */
export function rangeLabel(from: string, to: string): string {
  return from === to ? day(from) : `${day(from)} – ${day(to)}`;
}

function PeriodDialog({ open, onOpenChange, value, onChange }: { open: boolean; onOpenChange: (open: boolean) => void; value: Period; onChange: (p: Period) => void }) {
  const today = utcDate();
  const since = useMe().data?.workspace.statsSince ?? undefined;
  const [from, setFrom] = useState(value.from ?? "");
  const [to, setTo] = useState(value.to ?? today);
  useEffect(() => {
    if (!open) return;
    setFrom(value.from ?? since ?? "");
    setTo(value.to ?? today);
  }, [open, value.from, value.to, since, today]);
  const error = !from || !to ? "Choose both dates." : from > to ? "The start date must be on or before the end date." : to > today ? "The end date can’t be in the future." : null;
  const pick = (p: Period) => {
    onChange(p);
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Choose a period"
      description="A longer range, or any dates you like. Days are in UTC."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => pick({ range: "custom", from, to })} disabled={Boolean(error)}>
            Show these dates
          </Button>
        </>
      }
    >
      <div className="ui-period-longer">
        {LONGER.map((l) => (
          <Button key={l.range} size="sm" variant={value.range === l.range ? "primary" : "secondary"} onClick={() => pick({ range: l.range })}>
            {l.label}
          </Button>
        ))}
      </div>
      <div className="ui-period-dates">
        <Input label="From" name="from" autoComplete="off" type="date" min={since} max={to || today} value={from} onChange={(e) => setFrom(e.target.value)} hint={since ? `Your stats start ${day(since)}.` : undefined} />
        <Input label="To" name="to" autoComplete="off" type="date" min={from || since} max={today} value={to} onChange={(e) => setTo(e.target.value)} error={error && (from || to) ? error : undefined} />
      </div>
    </Dialog>
  );
}

// ---- Numbers ----

/** "+18%" / "−4" in good or bad colour, plain when more isn't better or worse. */
export function Delta({ current, previous, good = true, className }: { current: number; previous: number | null | undefined; good?: boolean; className?: string }) {
  if (previous === null || previous === undefined) return null;
  const c = change(current, previous);
  if (!c) return null;
  const tone = !good || c.dir === "flat" ? "flat" : c.dir === "up" ? "good" : "bad";
  return (
    <span className={cn("ui-delta", className)} data-tone={tone} title={`${c.title} in the previous period`}>
      <span aria-hidden>{c.dir === "up" ? "↑" : c.dir === "down" ? "↓" : ""}</span>
      {c.text}
      <span className="ui-sr"> compared with the previous period</span>
    </span>
  );
}

/** Money without ".00" on whole amounts, so one column never mixes "$49.00" and "$1,033". */
export function moneyShort(minor: number, currency: string, compact = true): string {
  const s = money(minor, currency, compact);
  return /[.,]00(?!\d)/.test(s) ? s.replace(/[.,]00(?!\d)/, "") : s;
}

export function formatMetric(metric: Metric, v: number, currency?: string, compact = true): string {
  if (metric === "revenue") return moneyShort(v, currency ?? "USD", compact);
  return compact ? num(v) : fullNum(v);
}

/** A count in a period with no hits at all: "—" in the not-available style, not a big "0" that reads as broken data. */
export function NoneValue() {
  return (
    <span className="ui-kpi-na is-none">
      <span aria-hidden>—</span>
      <span className="ui-sr">None</span>
    </span>
  );
}

// ---- Loading, empty, error (ui/feedback.tsx) ----

export { ErrorState, Skeleton } from "./ui";

/** The one "needs live data" line (latest hits on the home and the link page): same words, same quiet style. */
export function LiveDataLine() {
  return <p className="ui-rows-empty">Needs live data: each click shows up here within a minute once Cloudflare Analytics Engine is connected.</p>;
}

/** A breakdown list's shape while it loads: rows of shrinking text bars. */
export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ol className="ui-rows" aria-busy aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="ui-row">
          <div className="ui-row-inner">
            <Skeleton className="ui-skel-text" style={{ width: `${72 - i * 8}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---- Breakdown lists ----

export type Kind = "country" | "source" | "referrer" | "device" | "language" | "plain";

export function labelOf(kind: Kind, value: string): string {
  if (kind === "country") return countryName(value);
  if (kind === "source") return sourceLabel(value || "direct");
  if (kind === "referrer") return value || "No referrer";
  if (kind === "device") return value ? value[0]!.toUpperCase() + value.slice(1) : "Unknown";
  if (kind === "language") return value ? languageName(value) : "Not sent";
  if (value === "(other)") return "Everything else";
  return value || "Unknown";
}

export type RowItem = BreakdownItem;
/** The ranked list with underline bars (ui/data.tsx). */
export const Rows = BreakdownList;

export function breakdownItems(rows: BreakdownRow[], kind: Kind, metric: "clicks" | "bots" = "clicks"): RowItem[] {
  return rows
    .filter((r) => r[metric] > 0)
    .map((r) => {
      const label = labelOf(kind, r.value);
      return { key: r.value || "(none)", label, title: r.value || label, value: r[metric] };
    });
}

/** A titled list with underline tabs (Sources | Referrers …), ui/choice.tsx. `lead` sits between the title and the tabs (the source ribbon). */
export function TabbedPanel({ title, tabs, className, render, aside, lead }: { title: string; tabs: { id: string; label: string }[]; className?: string; render: (id: string) => ReactNode; aside?: ReactNode; lead?: ReactNode }) {
  const [tab, setTab] = useState(tabs[0]!.id);
  const base = useId();
  return (
    <section className={cn("ui-panel", className)} aria-labelledby={`${base}-h`}>
      <header className="ui-panel-head">
        <h2 id={`${base}-h`} className="ui-h2">{title}</h2>
        {tabs.length > 1 ? null : aside}
      </header>
      {lead}
      {tabs.length > 1 ? (
        <Tabs label={title} items={tabs.map((t) => ({ value: t.id, label: t.label }))} value={tab} onValueChange={setTab} aside={aside}>
          {render}
        </Tabs>
      ) : (
        render(tab)
      )}
    </section>
  );
}

// ---- The source ribbon (the signature) ----

export interface RibbonPart {
  key: string;
  label: string;
  value: number;
}

/** The ribbon's parts: the five biggest, then "Everything else". `swatch` maps a row key to its segment (data-i), so a list below can act as the legend. */
export function ribbonParts(items: RibbonPart[]): { parts: (RibbonPart & { i: string })[]; total: number; swatch: Map<string, string> } {
  const rows = items.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const top = rows.slice(0, 5);
  const rest = rows.slice(5);
  const restSum = rest.reduce((s, r) => s + r.value, 0);
  const parts = [...top.map((r, i) => ({ ...r, i: String(i) })), ...(restSum ? [{ key: "(rest)", label: "Everything else", value: restSum, i: "rest" }] : [])];
  const swatch = new Map<string, string>([...top.map((r, i) => [r.key, String(i)] as const), ...rest.map((r) => [r.key, "rest"] as const)]);
  return { parts, total, swatch };
}

/** Rows of a source breakdown as ribbon parts (same keys as breakdownItems). */
export function sourceParts(rows: BreakdownRow[]): RibbonPart[] {
  return rows.filter((r) => r.clicks > 0).map((r) => ({ key: r.value || "(none)", label: labelOf("source", r.value), value: r.clicks }));
}

/** Gives each row of a list the swatch of its ribbon segment: the list under the ribbon is its legend. */
export function withSwatches<T extends { key: string }>(items: T[], swatch: Map<string, string>): (T & { swatch?: string })[] {
  return items.map((r) => ({ ...r, swatch: swatch.get(r.key) }));
}

/**
 * The signature: shares as one 100 % ribbon (human clicks by source, or a
 * website's visitors by channel). It heads its section; the list right under
 * it names the parts (each row carries its segment's swatch), so there is no
 * separate legend. Screen readers get the parts as a list.
 */
export function SourceRibbon({ items, label, className }: { items: RibbonPart[]; label: string; className?: string }) {
  const { parts, total } = ribbonParts(items);
  if (!total) return null;
  return (
    <figure className={cn("ui-ribbon", className)}>
      <figcaption className="ui-sr">{label}</figcaption>
      <div className="ui-ribbon-bar" aria-hidden>
        {parts.map((s) => (
          <span key={s.key} className="ui-ribbon-seg" data-i={s.i} data-wide={s.value / total >= 0.18 ? "" : undefined} style={{ flexGrow: s.value }} title={`${s.label}: ${pct(s.value, total)}`}>
            {s.value / total >= 0.1 ? <span className="ui-ribbon-in">{pct(s.value, total)}</span> : null}
          </span>
        ))}
      </div>
      <ol className="ui-sr">
        {parts.map((s) => (
          <li key={s.key}>
            {s.label}: {pct(s.value, total)}
          </li>
        ))}
      </ol>
    </figure>
  );
}

// ---- Trend chart ----

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const METRIC_NAME: Record<Metric, string> = { clicks: "Human clicks", uniques: "Daily unique visitors", bots: "Bots and previews", revenue: "Net revenue" };

/**
 * One metric over time, drawn by hand in SVG as a line, the previous period
 * dashed.
 * Hover or arrow keys move a readout; the peak is labelled on the chart.
 */
export function TrendChart({ buckets, metric, currency, height, compare, labelledBy }: { buckets: Bucket[]; metric: Metric; currency?: string; height: number; compare: boolean; labelledBy?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const values = buckets.map((b) => b[metric]);
  const prevValues = buckets.map((b) => (metric === "revenue" ? b.prevRevenue : b.prev?.[metric]));
  const hasPrev = compare && prevValues.some((v) => v !== undefined);
  const top = niceMax(Math.max(1, ...values, ...(hasPrev ? prevValues.map((v) => v ?? 0) : [])));
  const padL = 44;
  const padR = 8;
  const padT = 18;
  const padB = 24;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = height - padT - padB;
  const n = Math.max(1, buckets.length);
  const step = innerW / n;
  const x = (i: number) => padL + step * i + step / 2;
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  const peak = values.reduce((best, v, i) => (v > (values[best] ?? 0) ? i : best), 0);
  const empty = values.every((v) => v === 0);
  const fmt = (v: number) => formatMetric(metric, v, currency);
  const ticks = [0, top / 2, top];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 72))));

  useEffect(() => setHover(null), [metric, buckets.length]);

  const onMove = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - padL) / step);
    setHover(i >= 0 && i < n ? i : null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const cur = hover ?? (e.key === "ArrowRight" ? -1 : n);
      setHover(Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Home") {
      setHover(0);
    } else if (e.key === "End") {
      setHover(n - 1);
    }
  };

  const shown = hover ?? (focused ? n - 1 : null);
  const b = shown !== null ? buckets[shown] : undefined;
  const line = (vals: (number | undefined)[]) =>
    vals
      .map((v, i) => (v === undefined ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");

  return (
    <div
      ref={ref}
      className="ui-chart"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : `${METRIC_NAME[metric]} over time`}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setHover(null);
      }}
    >
      {width > 0 ? (
        <svg className="ui-chart-svg" width={width} height={height} aria-hidden>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} className={t === 0 ? "ui-axis" : "ui-grid"} />
              <text x={padL - 8} y={y(t)} dy="0.32em" textAnchor="end" className="ui-tick">{fmt(t)}</text>
            </g>
          ))}
          {buckets.map((bk, i) =>
            i % labelEvery === 0 ? (
              <text key={bk.title} x={x(i)} y={height - 6} textAnchor="middle" className="ui-tick">{bk.label}</text>
            ) : null,
          )}
          {shown !== null ? <rect x={padL + step * shown} y={padT} width={step} height={innerH} className="ui-chart-hover" /> : null}
          {hasPrev ? <polyline points={line(prevValues)} className="ui-line-prev" /> : null}
          <polyline points={line(values)} className="ui-line" />
          {shown !== null && values[shown] !== undefined ? <circle cx={x(shown)} cy={y(values[shown]!)} r={4} className="ui-line-dot" /> : null}
          {!empty ? <circle cx={x(n - 1)} cy={y(values[n - 1] ?? 0)} r={3} className="ui-line-end" /> : null}
          {!empty && shown === null ? (
            <g className="ui-peak" transform={`translate(${Math.min(Math.max(x(peak), padL + 40), width - padR - 40)},${Math.max(12, y(values[peak] ?? 0) - 8)})`}>
              <text textAnchor="middle" className="ui-peak-text">{`Peak ${fmt(values[peak] ?? 0)} on ${buckets[peak]?.label ?? ""}`}</text>
            </g>
          ) : null}
        </svg>
      ) : null}
      {empty ? <p className="ui-chart-empty">{metric === "revenue" ? "No revenue in this period" : "No clicks in this period"}</p> : null}
      {b ? (
        <div className="ui-readout" style={{ left: Math.min(Math.max(x(shown!), 90), width - 90) }} role="status">
          <span className="ui-readout-date">{b.title}</span>
          <span className="ui-readout-row">
            <span>{METRIC_NAME[metric]}</span>
            <strong>{formatMetric(metric, b[metric], currency, false)}</strong>
          </span>
          {hasPrev ? (
            <span className="ui-readout-row is-prev">
              <span>{metric === "revenue" ? "Previous period" : `Previous: ${b.prev?.title ?? "–"}`}</span>
              <strong>{(() => {
                const pv = metric === "revenue" ? b.prevRevenue : b.prev?.[metric];
                return pv === undefined ? "–" : formatMetric(metric, pv, currency, false);
              })()}</strong>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The same numbers as a table, for screen readers and exact values. */
export function TrendTable({ buckets, metric, currency, compare }: { buckets: Bucket[]; metric: Metric; currency?: string; compare: boolean }) {
  const rows = useMemo(() => [...buckets].reverse(), [buckets]);
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col" className="is-num">{METRIC_NAME[metric]}</th>
            {compare ? <th scope="col" className="is-num">Previous period</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => {
            const pv = metric === "revenue" ? b.prevRevenue : b.prev?.[metric];
            return (
              <tr key={b.title}>
                <td>{b.title}</td>
                <td className="is-num">{formatMetric(metric, b[metric], currency, false)}</td>
                {compare ? <td className="is-num">{pv === undefined ? "–" : formatMetric(metric, pv, currency, false)}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The chart section under a KPI strip: "{title}, by day|week", a "Previous
 * period" toggle (when there is one to compare) and Show table / Show chart.
 * `buckets: null` shows the chart's shape while loading; the toggles keep
 * their state across reloads.
 */
export function TrendBlock({ title, buckets, weekly, metric, currency, canCompare, height, className }: { title: string; buckets: Bucket[] | null; weekly: boolean; metric: Metric; currency?: string; canCompare: boolean; height: number; className?: string }) {
  const [table, setTable] = useState(false);
  const [compare, setCompare] = useState(true);
  const id = useId();
  if (!buckets) return <div className={cn("ui-chart-block", className)}><Skeleton className="ui-skel-chart" style={{ height }} /></div>;
  const comparing = compare && canCompare;
  return (
    <section className={cn("ui-chart-block", className)} aria-labelledby={`${id}-t`}>
      <header className="ui-chart-head">
        <h2 id={`${id}-t`} className="ui-h2">
          {title}, {weekly ? "by week" : "by day"}
        </h2>
        <div className="ui-chart-tools">
          {canCompare ? (
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
        <TrendTable buckets={buckets} metric={metric} currency={currency} compare={comparing} />
      ) : (
        <TrendChart buckets={buckets} metric={metric} currency={currency} height={height} compare={comparing} labelledBy={`${id}-t`} />
      )}
      {metric === "revenue" ? <p className="ui-chart-note">Revenue days follow each website’s time zone; clicks are counted in UTC.</p> : null}
    </section>
  );
}

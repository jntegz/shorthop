// The website trend: one metric over time on one axis (the KPI strip picks
// it), the period before as a dashed line, traffic spikes as warn ticks on
// the time axis. Hand-drawn SVG like parts.tsx TrendChart, but for the site's
// metrics (counts, money, durations and rates) and its own time zone buckets.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Granularity, SitePoint, SiteSpikeDTO } from "../../../shared/sites";
import { num } from "../../lib/format";
import { duration, percent } from "../../lib/sites";
import { cn } from "../../lib/utils";
import { moneyShort } from "./common";

export type SiteMetric = "revenue" | "visitors" | "sessions" | "pageviews" | "engaged" | "conversion";

export const METRIC_LABEL: Record<SiteMetric, string> = {
  revenue: "Net revenue",
  visitors: "Visitors",
  sessions: "Visits",
  pageviews: "Pageviews",
  engaged: "Time per visit",
  conversion: "Goal conversion",
};

/** A bucket's value: counts and money as they are, engaged seconds per visit, or the share of visits with a goal. */
export function metricOf(m: SiteMetric, p: SitePoint): number {
  if (m === "engaged") return p.sessions ? Math.round(p.engagedMs / p.sessions / 1000) : 0;
  if (m === "conversion") return p.sessions ? p.goalSessions / p.sessions : 0;
  return p[m];
}

/** The metric over the whole period: a sum for counts, an average for the rates. */
export function metricTotal(m: SiteMetric, points: SitePoint[]): number {
  const sum = (k: "sessions" | "engagedMs" | "goalSessions" | "visitors" | "pageviews" | "revenue") => points.reduce((a, p) => a + p[k], 0);
  if (m === "engaged") return sum("sessions") ? Math.round(sum("engagedMs") / sum("sessions") / 1000) : 0;
  if (m === "conversion") return sum("sessions") ? sum("goalSessions") / sum("sessions") : 0;
  return sum(m);
}

export function formatSiteMetric(m: SiteMetric, v: number, currency: string, compact = true): string {
  if (m === "revenue") return moneyShort(v, currency, compact);
  if (m === "engaged") return duration(Math.round(v));
  if (m === "conversion") return percent(v);
  return compact ? num(v) : new Intl.NumberFormat("en").format(v);
}

export function bucketLabel(t: number, g: Granularity, tz: string, long = false): string {
  const opts: Intl.DateTimeFormatOptions =
    g === "hour" ? { hour: "2-digit", minute: "2-digit", ...(long ? { day: "numeric", month: "short" } : {}) } : g === "month" ? { month: "short", year: "numeric" } : { day: "numeric", month: "short", ...(long ? { year: "numeric" } : {}) };
  let s: string;
  try {
    // The browser's locale, like lib/format day(): one date format on every page.
    s = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(new Date(t * 1000));
  } catch {
    s = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" }).format(new Date(t * 1000));
  }
  return g === "week" && long ? `Week of ${s}` : s;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
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

export interface SiteBucket {
  t: number;
  label: string;
  title: string;
  point: SitePoint;
  prev?: SitePoint;
  prevTitle?: string;
  spikes: string[];
}

export function buildSiteBuckets(series: SitePoint[], previous: SitePoint[] | null, spikes: SiteSpikeDTO[], g: Granularity, tz: string): SiteBucket[] {
  const out: SiteBucket[] = series.map((p, i) => {
    const before = previous?.[i];
    return { t: p.t, label: bucketLabel(p.t, g, tz), title: bucketLabel(p.t, g, tz, true), point: p, prev: before, prevTitle: before ? bucketLabel(before.t, g, tz, true) : undefined, spikes: [] };
  });
  // Each spike sits on the bucket it happened in.
  for (const sp of spikes) {
    let i = -1;
    for (let j = 0; j < out.length; j++) if (out[j]!.t <= sp.t) i = j;
    if (i >= 0) out[i]!.spikes.push(`${sp.source || "Direct"}: ${num(sp.visits)} visits in an hour (usually ${num(Math.round(sp.baseline))})`);
  }
  return out;
}

export function SiteTrend({ buckets, metric, currency, height, compare, revenue, labelledBy }: { buckets: SiteBucket[]; metric: SiteMetric; currency: string; height: number; compare: boolean; revenue: boolean; labelledBy: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const values = useMemo(() => buckets.map((b) => metricOf(metric, b.point)), [buckets, metric]);
  const prevValues = useMemo(() => buckets.map((b) => (b.prev ? metricOf(metric, b.prev) : undefined)), [buckets, metric]);
  const hasPrev = compare && prevValues.some((v) => v !== undefined);
  const lowest = Math.min(0, ...values);
  const top = niceMax(Math.max(metric === "conversion" ? 0.01 : 1, ...values, ...(hasPrev ? prevValues.map((v) => v ?? 0) : [])));
  const padL = metric === "revenue" || metric === "engaged" ? 56 : 44;
  const padR = 8;
  const padT = 18;
  const padB = 26;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = height - padT - padB;
  const n = Math.max(1, buckets.length);
  const step = innerW / n;
  const bottom = lowest < 0 ? lowest : 0;
  const x = (i: number) => padL + step * i + step / 2;
  const y = (v: number) => padT + innerH - ((v - bottom) / (top - bottom)) * innerH;
  const empty = values.every((v) => v === 0);
  const peak = values.reduce((best, v, i) => (v > (values[best] ?? 0) ? i : best), 0);
  const fmt = (v: number) => formatSiteMetric(metric, v, currency);
  const ticks = [0, top / 2, top];
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 76))));
  const bars = metric === "revenue";
  const barW = Math.max(1, Math.min(18, step * (n > 60 ? 0.6 : 0.56)));

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
      e.preventDefault();
      setHover(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHover(n - 1);
    } else if (e.key === "Escape") {
      setHover(null);
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
      className={cn("ui-chart", bars ? "is-bars" : "is-line")}
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-labelledby={labelledBy}
      aria-describedby={`${labelledBy}-hint`}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        setHover(null);
      }}
    >
      <span id={`${labelledBy}-hint`} className="ui-sr">Use the left and right arrow keys to read each {buckets.length > 1 ? "bucket" : "value"}; Show table lists every number.</span>
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
              <text key={bk.t} x={x(i)} y={height - 6} textAnchor="middle" className="ui-tick">{bk.label}</text>
            ) : null,
          )}
          {shown !== null ? <rect x={padL + step * shown} y={padT} width={step} height={innerH} className="ui-chart-hover" /> : null}
          {/* Spikes: a warn tick under the axis, so the line itself stays clean. */}
          {buckets.map((bk, i) => (bk.spikes.length ? <path key={`s${bk.t}`} d={`M${x(i)},${padT + innerH + 1} l-4,7 h8 z`} className="ui-site-spike" /> : null))}
          {bars ? (
            <>
              {values.map((v, i) => (
                <rect key={i} x={x(i) - barW / 2} y={Math.min(y(v), y(0))} width={barW} height={Math.abs(y(0) - y(v))} rx={Math.min(2, barW / 2)} className={cn("ui-bar", i === shown && "is-on")} />
              ))}
              {hasPrev ? prevValues.map((v, i) => (v === undefined ? null : <line key={`p${i}`} x1={x(i) - barW / 2 - 1} x2={x(i) + barW / 2 + 1} y1={y(v)} y2={y(v)} className="ui-ghost" />)) : null}
            </>
          ) : (
            <>
              {hasPrev ? <polyline points={line(prevValues)} className="ui-line-prev" /> : null}
              <polyline points={line(values)} className="ui-line" />
              {shown !== null ? <circle cx={x(shown)} cy={y(values[shown] ?? 0)} r={4} className="ui-line-dot" /> : null}
              {!empty ? <circle cx={x(n - 1)} cy={y(values[n - 1] ?? 0)} r={3} className="ui-line-end" /> : null}
            </>
          )}
          {!empty && shown === null ? (
            <text x={Math.min(Math.max(x(peak), padL + 50), width - padR - 50)} y={Math.max(12, y(values[peak] ?? 0) - 8)} textAnchor="middle" className="ui-peak-text">
              {`Peak ${fmt(values[peak] ?? 0)} on ${buckets[peak]?.label ?? ""}`}
            </text>
          ) : null}
        </svg>
      ) : null}
      {empty ? <p className="ui-chart-empty">{metric === "revenue" ? "No revenue in this period" : "No visits in this period"}</p> : null}
      {b ? (
        <div className="ui-readout" style={{ left: Math.min(Math.max(x(shown!), 100), width - 100) }} role="status">
          <span className="ui-readout-date">{b.title}</span>
          <span className="ui-readout-row">
            <span>{METRIC_LABEL[metric]}</span>
            <strong>{formatSiteMetric(metric, values[shown!] ?? 0, currency, false)}</strong>
          </span>
          {hasPrev && b.prev ? (
            <span className="ui-readout-row is-prev">
              <span>Before: {b.prevTitle}</span>
              <strong>{formatSiteMetric(metric, prevValues[shown!] ?? 0, currency, false)}</strong>
            </span>
          ) : null}
          {metric !== "visitors" ? (
            <span className="ui-readout-row is-prev">
              <span>Visitors</span>
              <strong>{num(b.point.visitors)}</strong>
            </span>
          ) : null}
          {revenue && metric !== "revenue" && b.point.revenue ? (
            <span className="ui-readout-row is-prev">
              <span>Revenue</span>
              <strong>{moneyShort(b.point.revenue, currency, false)}</strong>
            </span>
          ) : null}
          {b.spikes.map((s) => (
            <span key={s} className="ui-site-readout-spike">Spike: {s}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Every bucket and every metric, newest first: the exact numbers and the screen-reader view. */
export function SiteTrendTable({ buckets, currency, revenue }: { buckets: SiteBucket[]; currency: string; revenue: boolean }) {
  const rows = useMemo(() => [...buckets].reverse(), [buckets]);
  const metrics: SiteMetric[] = ["visitors", "sessions", "pageviews", "engaged", "conversion", ...(revenue ? (["revenue"] as const) : [])];
  return (
    <div className="ui-table-wrap" tabIndex={0} role="region" aria-label="Every bucket of the period">
      <table className="ui-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            {metrics.map((m) => (
              <th key={m} scope="col" className="is-num">{METRIC_LABEL[m]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.t}>
              <td>{b.title}{b.spikes.length ? <span className="ui-site-spike-note"> spike</span> : null}</td>
              {metrics.map((m) => (
                <td key={m} className="is-num">{formatSiteMetric(m, metricOf(m, b.point), currency, false)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

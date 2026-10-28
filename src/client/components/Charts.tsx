import { useId, useMemo, useState, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { ArrowDownRight, ArrowUpRight, Bot, MousePointer2, Users, BarChart3 } from "lucide-react";
import { utcDate } from "../../shared/dates";
import type { BreakdownRow, ComparisonDTO, SeriesPoint, Totals } from "../../shared/types";
import { change, countryName, day, flag, fullNum, languageName, num, pct, sourceLabel } from "../lib/format";
import { cn } from "../lib/utils";
import { Card, CardHeader, Empty } from "./ui";

interface Bucket extends Totals {
  label: string;
  /** "19 Oct" or "Week of 13 Oct" for the tooltip. */
  title: string;
  /** The same position in the previous period, when comparing. */
  prev?: number;
  prevTitle?: string;
}

/** Long ranges are summed into weeks so bars stay readable. */
function bucketize(series: SeriesPoint[]): Bucket[] {
  if (series.length <= 120) {
    return series.map((p) => ({ ...p, label: day(p.date), title: day(p.date) }));
  }
  const out: Bucket[] = [];
  for (let i = 0; i < series.length; i += 7) {
    const week = series.slice(i, i + 7);
    const first = week[0]!;
    out.push({
      label: day(first.date),
      title: `Week of ${day(first.date)}`,
      clicks: week.reduce((s, p) => s + p.clicks, 0),
      uniques: week.reduce((s, p) => s + p.uniques, 0),
      bots: week.reduce((s, p) => s + p.bots, 0),
    });
  }
  return out;
}

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const b = payload[0]?.payload as Bucket | undefined;
  if (!b) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-fg">{b.title}</div>
      <Row swatch="bg-series-1" label="Human clicks" value={fullNum(b.clicks)} />
      <Row swatch="bg-series-2" label="Bots & previews" value={fullNum(b.bots)} />
      {b.prev !== undefined ? <Row swatch="bg-subtle" label={`Previous: ${b.prevTitle}`} value={fullNum(b.prev)} /> : null}
      <div className="mt-1 border-t border-line pt-1 text-muted">Daily uniques: {fullNum(b.uniques)}</div>
    </div>
  );
}

function Row({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-muted">
      <span className={cn("size-2 rounded-sm", swatch)} aria-hidden />
      <span>{label}</span>
      <span className="tabular ml-auto pl-4 font-medium text-fg">{value}</span>
    </div>
  );
}

function Legend({ comparing }: { comparing: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-series-1" aria-hidden /> Human clicks
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-series-2" aria-hidden /> Bots &amp; previews
      </span>
      {comparing ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3 border-t-2 border-dotted border-subtle" aria-hidden /> Previous period
        </span>
      ) : null}
    </div>
  );
}

export function ClicksChart({
  series,
  title = "Clicks over time",
  liveAvailable = true,
  previous,
}: {
  series: SeriesPoint[];
  title?: string;
  liveAvailable?: boolean;
  /** The previous period's days, overlaid day by day. */
  previous?: SeriesPoint[] | null;
}) {
  const gradientId = useId();
  const today = utcDate();
  const [compare, setCompare] = useState(true);
  const comparing = compare && Boolean(previous?.length);
  const available = useMemo(() => liveAvailable ? series : series.filter((point) => point.date < today), [series, liveAvailable, today]);
  const data = useMemo(() => {
    const buckets = bucketize(available);
    if (!comparing || !previous) return buckets;
    // Day 1 against day 1 of the previous period, and so on.
    const prev = bucketize(previous);
    return buckets.map((b, i) => (prev[i] ? { ...b, prev: prev[i]!.clicks, prevTitle: prev[i]!.title } : b));
  }, [available, comparing, previous]);
  const [showTable, setShowTable] = useState(false);
  const empty = data.every((d) => d.clicks === 0 && d.bots === 0);

  return (
    <Card>
      <CardHeader
        title={title}
        description={`${data.length !== available.length ? "Weekly" : "Daily"} totals, UTC${liveAvailable ? "" : " · Saved days only"}`}
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Legend comparing={comparing} />
            {previous?.length ? (
              <label className="inline-flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="accent-[var(--accent)]" />
                Compare
              </label>
            ) : null}
            <button type="button" className="text-xs text-muted underline-offset-2 hover:underline" onClick={() => setShowTable((v) => !v)}>
              {showTable ? "Chart" : "Table"}
            </button>
          </div>
        }
      />
      {showTable ? (
        <div className="max-h-72 overflow-auto px-4 pb-4">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th className="py-1.5 font-medium">Date</th>
                <th className="py-1.5 text-right font-medium">Clicks</th>
                <th className="py-1.5 text-right font-medium">Daily uniques</th>
                <th className="py-1.5 text-right font-medium">Bots</th>
                {comparing ? <th className="py-1.5 text-right font-medium">Previous</th> : null}
              </tr>
            </thead>
            <tbody className="tabular">
              {[...data].reverse().map((d) => (
                <tr key={d.title} className="border-t border-line">
                  <td className="py-1.5">{d.title}</td>
                  <td className="tabular py-1.5 text-right">{fullNum(d.clicks)}</td>
                  <td className="tabular py-1.5 text-right">{fullNum(d.uniques)}</td>
                  <td className="tabular py-1.5 text-right text-muted">{fullNum(d.bots)}</td>
                  {comparing ? <td className="tabular py-1.5 text-right text-muted">{d.prev === undefined ? "–" : fullNum(d.prev)}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative h-72 px-3 pb-5 sm:h-80">
          {empty ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">{liveAvailable ? "No clicks in this period yet" : "No saved click data in this period"}</div>
          ) : null}
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart accessibilityLayer data={data} margin={{ top: 20, right: 16, bottom: 0, left: 0 }}>
              <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.20} /><stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.01} /></linearGradient></defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} strokeDasharray="3 5" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={{ stroke: "var(--line)" }}
                tick={{ fill: "var(--subtle)", fontSize: 11 }}
                minTickGap={24}
                interval="preserveStartEnd"
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--subtle)", fontSize: 11 }}
                tickFormatter={(v: number) => num(v)}
                allowDecimals={false}
                width={40}
              />
              <Tooltip content={ChartTooltip} cursor={{ fill: "var(--surface-2)" }} isAnimationActive={false} />
              <Area type="monotone" dataKey="clicks" name="Human clicks" stroke="var(--series-1)" strokeWidth={2.5} fill={`url(#${gradientId})`} isAnimationActive={false} />
              {comparing ? <Area type="monotone" dataKey="prev" name="Previous period" stroke="var(--subtle)" strokeWidth={1.5} strokeDasharray="2 4" fill="transparent" isAnimationActive={false} /> : null}
              <Area type="monotone" dataKey="bots" name="Bots & previews" stroke="var(--series-2)" strokeWidth={1.5} strokeDasharray="4 4" fill="transparent" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/** "+12%" against the previous period; green or red where more is better, grey otherwise. */
function ChangeChip({ current, previous, good }: { current: number; previous: number; good: boolean }) {
  const c = change(current, previous);
  if (!c) return null;
  const Icon = c.dir === "down" ? ArrowDownRight : ArrowUpRight;
  const tone = !good || c.dir === "flat" ? "bg-surface-2 text-muted" : c.dir === "up" ? "bg-good-soft text-good" : "bg-danger-soft text-danger";
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium tabular", tone)} title={`${c.title} in the previous period`}>
      {c.dir === "flat" ? null : <Icon className="size-3" aria-hidden />}
      {c.text}
    </span>
  );
}

export function StatTiles({ totals, extra, comparison }: { totals: Totals; extra?: { label: string; value: string; note?: string }; comparison?: ComparisonDTO | null }) {
  const all = totals.clicks + totals.bots;
  const cmp = comparison ?? null;
  const tiles = [
    { icon: MousePointer2, label: "Human clicks", value: num(totals.clicks), note: all ? `${pct(totals.clicks, all)} of all hits` : undefined, chip: cmp && <ChangeChip current={cmp.current.clicks} previous={cmp.previous.clicks} good /> },
    { icon: Users, label: "Daily unique visitors", value: num(totals.uniques), note: "Visitors counted once per day", chip: cmp && <ChangeChip current={cmp.current.uniques} previous={cmp.previous.uniques} good /> },
    { icon: Bot, label: "Bots & previews", value: num(totals.bots), note: "Not counted as clicks", chip: cmp && <ChangeChip current={cmp.current.bots} previous={cmp.previous.bots} good={false} /> },
    ...(extra ? [{ ...extra, icon: BarChart3, chip: null }] : []),
  ];
  return (
    <div className={cn("grid gap-4", tiles.length === 4 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-3")}>
      {tiles.map((t) => (
        <Card key={t.label} className="relative overflow-hidden px-5 py-5">
          <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted">{t.label}</span><span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent"><t.icon className="size-4" /></span></div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="tabular text-[36px] font-semibold tracking-[-0.04em] text-fg">{t.value}</span>
            {t.chip}
          </div>
          {t.note ? <div className="mt-1 text-xs text-muted">{t.note}</div> : null}
        </Card>
      ))}
      {cmp ? (
        <p className="col-span-full -mt-1 text-xs text-muted">
          Changes compare {cmp.current.from === cmp.current.to ? day(cmp.current.from) : `${day(cmp.current.from)} – ${day(cmp.current.to)}`} with{" "}
          {cmp.previous.from === cmp.previous.to ? day(cmp.previous.from) : `${day(cmp.previous.from)} – ${day(cmp.previous.to)}`}: completed days only, so today doesn't count until it's over.
        </p>
      ) : null}
    </div>
  );
}

export type BreakdownKind = "country" | "source" | "plain" | "referrer" | "device" | "language";

function labelFor(kind: BreakdownKind, value: string): ReactNode {
  if (kind === "country") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden>{flag(value)}</span>
        {countryName(value)}
      </span>
    );
  }
  if (kind === "source") return sourceLabel(value || "direct");
  if (kind === "referrer") return value || "No referrer";
  if (kind === "device") return value ? value[0]!.toUpperCase() + value.slice(1) : "Unknown";
  if (kind === "language") return value ? languageName(value) : "Not sent";
  if (value === "(other)") return "Everything else";
  return value || "Unknown";
}

/** A ranked list with inline bars: single series, so one color and visible values. */
export function Breakdown({
  title,
  description,
  rows,
  kind = "plain",
  metric = "clicks",
  limit = 8,
}: {
  title: string;
  description?: string;
  rows: BreakdownRow[];
  kind?: BreakdownKind;
  metric?: "clicks" | "bots";
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = rows.filter((r) => r[metric] > 0);
  const shown = expanded ? visible : visible.slice(0, limit);
  const max = Math.max(1, ...visible.map((r) => r[metric]));
  const total = visible.reduce((s, r) => s + r[metric], 0);

  return (
    <Card className="flex flex-col">
      <CardHeader title={title} description={description} />
      {shown.length === 0 ? (
        <Empty title="No data yet" />
      ) : (
        <ul className="space-y-2 px-4 pb-4">
          {shown.map((r) => (
            <li key={r.value} className="group relative">
              <div
                className={cn("absolute inset-y-0 left-0 rounded-lg opacity-[0.08]", metric === "bots" ? "bg-series-2" : "bg-series-1")}
                style={{ width: `${(r[metric] / max) * 100}%` }}
                aria-hidden
              />
              <div className="relative flex items-center gap-2 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-fg" title={r.value}>
                  {labelFor(kind, r.value)}
                </span>
                <span className="tabular text-xs text-subtle">{pct(r[metric], total)}</span>
                <span className="tabular w-12 text-right font-medium text-fg">{num(r[metric])}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {visible.length > limit ? (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-auto border-t border-line px-4 py-2 text-left text-xs text-muted hover:text-fg">
          {expanded ? "Show less" : `Show all ${visible.length}`}
        </button>
      ) : null}
    </Card>
  );
}

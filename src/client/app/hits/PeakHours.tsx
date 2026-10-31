// "When people click" on the analytics home: every link's clicks by weekday
// and hour in the viewer's time zone, drawn as the neutral rank-stepped
// heatmap of docs/DESIGN.md (the website dashboard's, sites/insights.tsx),
// with a 3-hour grid on phones. Look: home.css, "home-" block.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, call } from "../../api";
import { num } from "../../lib/format";
import { cn } from "../../lib/utils";
import { RowsSkeleton } from "../parts";
import { Button, ErrorState, Notice, Section, Segmented } from "../ui";

const SPANS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "89", label: "90 days" },
] as const;
type Span = (typeof SPANS)[number]["value"];

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Five steps by rank among the cells that had any clicks: the quietest 40 %
 * are step 1, then 25 / 15 / 10 %, and only the busiest 10 % reach ink; equal
 * values share a step. Returns the upper bounds of steps 1–4 and a value's level.
 */
function heatScale(values: number[]): { bounds: number[]; level: (v: number) => number } {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))] ?? 0;
  const bounds = [at(0.4), at(0.65), at(0.8), at(0.9)];
  return { bounds, level: (v) => (v <= 0 ? 0 : 1 + bounds.filter((b) => v > b).length) };
}

function HeatLegend({ min, max, bounds, unit, className }: { min: number; max: number; bounds: number[]; unit: string; className?: string }) {
  const range = (l: number) => {
    const lo = l === 1 ? min : bounds[l - 2]!;
    const hi = l === 5 ? max : bounds[l - 1]!;
    return l === 1 ? `${num(lo)}–${num(hi)}` : `more than ${num(lo)}${l === 5 ? "" : `, up to ${num(hi)}`}`;
  };
  return (
    <div className={cn("home-heat-legend", className)}>
      <span className="home-heat-key">
        <span className="home-heat-end">{num(min)}</span>
        <span className="home-heat-steps" aria-hidden>
          {[1, 2, 3, 4, 5].map((l) => (
            <span key={l} data-l={l} title={range(l)} />
          ))}
        </span>
        <span className="home-heat-end">{num(max)}</span>
        <span className="home-heat-unit">{unit}</span>
      </span>
      <span className="home-heat-key">
        <span className="home-heat-top" aria-hidden />
        Busiest
      </span>
    </div>
  );
}

type Top = { day: number; hour: number; value: number };

function HeatGrid({ cells, top }: { cells: number[][]; top: Top[] }) {
  const flat = cells.flat();
  const max = Math.max(0, ...flat);
  const min = Math.min(...flat.filter((v) => v > 0), max);
  const scale = heatScale(flat);
  return (
    <>
      <div className="home-heat-scroll is-wide" tabIndex={0} role="region" aria-label="Peak hours grid, scrolls sideways">
        <table className="home-heat" aria-label="Clicks by weekday and hour">
          <thead>
            <tr>
              <td />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} scope="col">
                  {h % 3 === 0 ? h : <span className="ui-sr">{h}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, day) => (
              <tr key={day}>
                <th scope="row">{DAYS[day]}</th>
                {row.map((v, hour) => {
                  const isTop = top.some((t) => t.day === day && t.hour === hour);
                  return (
                    <td key={hour} title={`${DAYS[day]} ${hourLabel(hour)}: ${num(v)}`} className={cn(isTop && "is-top")} data-l={scale.level(v)}>
                      <span className="ui-sr">{num(v)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <HeatLegend min={min} max={max} bounds={scale.bounds} unit="clicks an hour" className="is-wide" />
      <HeatBlocks cells={cells} top={top} />
    </>
  );
}

/** Phones: the same week in 3-hour blocks (8 columns), with its own scale, so it fits without a sideways scroll. */
function HeatBlocks({ cells, top }: { cells: number[][]; top: Top[] }) {
  const blocks = cells.map((row) => Array.from({ length: 8 }, (_, b) => row.slice(b * 3, b * 3 + 3).reduce((a, v) => a + v, 0)));
  const flat = blocks.flat();
  const max = Math.max(0, ...flat);
  const min = Math.min(...flat.filter((v) => v > 0), max);
  const scale = heatScale(flat);
  const span = (b: number) => `${hourLabel(b * 3)}–${hourLabel((b * 3 + 3) % 24)}`;
  return (
    <div className="home-heat-scroll is-narrow">
      <table className="home-heat is-blocks" aria-label="Clicks by weekday, in 3-hour blocks">
        <thead>
          <tr>
            <td />
            {Array.from({ length: 8 }, (_, b) => (
              <th key={b} scope="col">
                {b % 2 === 0 ? b * 3 : <span className="ui-sr">{b * 3}</span>}
                <span className="ui-sr">:00 to {(b * 3 + 3) % 24}:00</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {blocks.map((row, day) => (
            <tr key={day}>
              <th scope="row">{DAYS[day]}</th>
              {row.map((v, b) => {
                const isTop = top.some((t) => t.day === day && Math.floor(t.hour / 3) === b);
                return (
                  <td key={b} title={`${DAYS[day]} ${span(b)}: ${num(v)}`} className={cn(isTop && "is-top")} data-l={scale.level(v)}>
                    <span className="ui-sr">{num(v)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <HeatLegend min={min} max={max} bounds={scale.bounds} unit="clicks per 3 hours" />
    </div>
  );
}

/**
 * When clicks come in, for every link (the home) or one link (its page). Shown
 * only when Analytics Engine is connected; draws nothing if the answer says it isn't.
 */
export function PeakHours({ link, className }: { link?: { domain: string; slug: string }; className?: string }) {
  const [days, setDays] = useState<Span>("30");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const query = { tz, days };
  const data = useQuery({
    queryKey: ["stats", "peak-hours", link?.domain ?? "", link?.slug ?? "", query],
    queryFn: () =>
      link
        ? call(api.stats.links[":domain"][":slug"]["peak-hours"].$get({ param: link, query }))
        : call(api.stats["peak-hours"].$get({ query })),
  });
  const d = data.data;
  if (d && !d.aeAvailable) return null;
  const failed = d && "error" in d && typeof d.error === "string" ? d.error : null;
  const first = d?.top[0];
  return (
    <Section
      title="When people click"
      className={className ? `home-peak ${className}` : "home-peak"}
      foldOnPhone={first ? `Busiest: ${DAYS[first.day]} ${hourLabel(first.hour)}.` : "Clicks by weekday and hour."}
      sub={`Clicks by weekday and hour, in your time zone (${tz.replaceAll("_", " ")}). From Analytics Engine, so the last 90 days at most.`}
      aside={<Segmented<Span> label="Peak hours span" size="sm" value={days} onChange={setDays} options={SPANS.map((s) => ({ value: s.value, label: s.label }))} />}
    >
      {data.isPending ? (
        <RowsSkeleton rows={4} />
      ) : data.isError && !d ? (
        <ErrorState compact what="Peak hours" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : failed ? (
        <Notice tone="warn" title="Analytics Engine didn’t answer." action={<Button size="sm" onClick={() => void data.refetch()} loading={data.isFetching}>Try again</Button>}>
          Peak hours couldn’t be read just now. Try again in a moment.
        </Notice>
      ) : !d || !d.total ? (
        <p className="ui-rows-empty">No clicks in the last {SPANS.find((s) => s.value === days)!.label}.</p>
      ) : (
        <>
          <HeatGrid cells={d.cells} top={d.top} />
          <p className="home-note">
            Busiest:{" "}
            {d.top.map((t, i) => (
              <span key={`${t.day}-${t.hour}`}>
                {i ? ", " : ""}
                <strong>
                  {DAYS[t.day]} {hourLabel(t.hour)}
                </strong>{" "}
                <span className="home-note-num">({num(t.value)})</span>
              </span>
            ))}
            {first ? `. Sharing an hour or two before ${DAYS[first.day]} ${hourLabel(first.hour)} catches the rise.` : "."}
          </p>
        </>
      )}
    </Section>
  );
}

import { AlertTriangle, Split } from "lucide-react";
import { utcDate } from "../../shared/dates";
import { describeConditions, type Routing } from "../../shared/routing";
import type { BreakdownRow, Period } from "../../shared/types";
import { routeCountryName } from "../lib/countries";
import { hostOf, num, pct, whenFull } from "../lib/format";
import { cn } from "../lib/utils";
import { Badge, Card, CardHeader, Notice } from "./ui";

/** Below this many clicks in a split, shares can stray far from the weights by chance alone. */
const SMALL_SAMPLE = 100;

/** Configured share (the tick) against observed share (the bar). */
function ShareBar({ observed, configured, tone }: { observed: number; configured?: number; tone: string }) {
  return (
    <div className="relative h-2 rounded-full bg-surface-2" aria-hidden>
      <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, observed)}%` }} />
      {configured !== undefined ? <div className="absolute -top-1 h-4 w-0.5 rounded bg-fg/60" style={{ left: `calc(${configured}% - 1px)` }} /> : null}
    </div>
  );
}

/**
 * Link page → where routed visitors went in the period: clicks per rule, and
 * for splits the configured share next to the observed one.
 */
export function RoutingResults({ routing, rows, period, from, onPeriod }: { routing: Routing; rows: BreakdownRow[]; period: Period; from: string; onPeriod: (p: Period) => void }) {
  const clicks = new Map(rows.map((r) => [r.value, r.clicks]));
  const total = rows.reduce((s, r) => s + r.clicks, 0);
  const ruleClicks = (id: string) => rows.filter((r) => r.value === id || r.value.startsWith(`${id}.`)).reduce((s, r) => s + r.clicks, 0);
  const known = new Set(routing.rules.flatMap((r) => [r.id, ...r.variants.map((v) => `${r.id}.${v.id}`)]));
  const fallback = clicks.get("-") ?? 0;
  const earlier = rows.filter((r) => r.value !== "-" && !known.has(r.value)).reduce((s, r) => s + r.clicks, 0);
  const changedDay = utcDate(new Date(routing.changedAt * 1000));
  const mixed = routing.changedAt > 0 && changedDay > from;

  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Split className="size-4 text-accent" /> Smart routing
          </span>
        }
        description={total ? `Where ${num(total)} human ${total === 1 ? "click" : "clicks"} went in this period. Bots and previews always get the default destination.` : "No routed clicks in this period yet."}
      />
      {mixed ? (
        <div className="px-5 pb-3">
          <Notice tone="accent">
            The destinations or shares changed on {whenFull(routing.changedAt)}, so this period mixes two setups.{" "}
            {period.range !== "custom" || period.from !== changedDay ? (
              <button type="button" className="font-medium underline underline-offset-2" onClick={() => onPeriod({ range: "custom", from: changedDay, to: utcDate() })}>
                Show results since then
              </button>
            ) : null}
          </Notice>
        </div>
      ) : null}
      <ol className="divide-y divide-line border-t border-line">
        {routing.rules.map((r, i) => {
          const n = ruleClicks(r.id);
          const split = r.variants.length > 1;
          return (
            <li key={r.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-xs font-semibold text-accent tabular">{i + 1}</span>
                <span className="text-sm font-medium text-fg">{r.name || describeConditions(r, routeCountryName)}</span>
                {r.name ? <span className="text-xs text-muted">{describeConditions(r, routeCountryName)}</span> : null}
                {!r.enabled ? <Badge>Paused</Badge> : null}
                <span className="ml-auto text-sm text-fg tabular">
                  {num(n)} <span className="text-xs text-muted">{total ? `· ${pct(n, total)}` : ""}</span>
                </span>
              </div>
              {split ? (
                <div className="mt-3 space-y-2.5 sm:pl-8">
                  {r.variants.map((v, j) => {
                    const c = clicks.get(`${r.id}.${v.id}`) ?? 0;
                    const share = n ? (c / n) * 100 : 0;
                    return (
                      <div key={v.id} className="grid items-center gap-x-3 gap-y-1 text-xs sm:grid-cols-[minmax(0,10rem)_1fr_7rem]">
                        <span className="min-w-0 truncate" title={v.url}>
                          <span className="font-medium text-fg">{v.label}</span> <span className="text-muted">· {hostOf(v.url)}</span>
                        </span>
                        <ShareBar observed={share} configured={v.weight} tone={j % 2 ? "bg-series-2" : "bg-series-1"} />
                        <span className="text-muted tabular sm:text-right">
                          <span className="font-medium text-fg">{n ? `${Math.round(share)}%` : "–"}</span> of {v.weight}% · {num(c)}
                        </span>
                      </div>
                    );
                  })}
                  {n > 0 && n < SMALL_SAMPLE ? (
                    <p className="flex items-center gap-1.5 text-xs text-warn">
                      <AlertTriangle className="size-3.5" /> Only {num(n)} clicks so far: shares can differ from the split by chance. Wait for at least {SMALL_SAMPLE}.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-1 truncate text-xs text-muted sm:pl-8" title={r.variants[0]?.url}>
                  → {r.variants[0]?.url}
                </p>
              )}
            </li>
          );
        })}
        <li className="flex flex-wrap items-center gap-2 px-5 py-4">
          <span className="flex size-6 items-center justify-center rounded-md bg-surface-2 text-xs text-muted">·</span>
          <span className="text-sm font-medium text-fg">Everyone else</span>
          <span className="text-xs text-muted">the default destination</span>
          <span className="ml-auto text-sm text-fg tabular">
            {num(fallback)} <span className="text-xs text-muted">{total ? `· ${pct(fallback, total)}` : ""}</span>
          </span>
        </li>
        {earlier ? (
          <li className="px-5 py-3 text-xs text-muted">
            {num(earlier)} {earlier === 1 ? "click" : "clicks"} went through rules or destinations that have since been removed.
          </li>
        ) : null}
      </ol>
    </Card>
  );
}

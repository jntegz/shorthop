import { RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { utcDate } from "../../shared/dates";
import type { Period } from "../../shared/types";
import { ago } from "../lib/format";
import { STATS_HELP } from "../lib/help";
import { cn } from "../lib/utils";
import { InfoTip } from "./ui";

const LIVE_INTERVAL_MS = 60_000;
/** Polling stops after this long without anyone using the page: Analytics Engine queries are rationed (10,000 a day on Free). */
const IDLE_AFTER_MS = 10 * 60_000;

let lastActive = Date.now();
const touch = () => {
  if (document.visibilityState === "visible") lastActive = Date.now();
};
for (const ev of ["pointerdown", "keydown", "focus"] as const) window.addEventListener(ev, touch, { passive: true });
document.addEventListener("visibilitychange", touch);

/** Whether the period reaches today, so new clicks can still appear in it. */
export function includesToday(p: Period): boolean {
  return p.range !== "custom" || !p.to || p.to >= utcDate();
}

/** For useQuery's refetchInterval: every minute while the period includes today and the page is in use. */
export function liveInterval(p: Period): (() => number | false) | false {
  return includesToday(p) ? () => (Date.now() - lastActive < IDLE_AFTER_MS ? LIVE_INTERVAL_MS : false) : false;
}

/** "Updated 20 seconds ago · New clicks take a minute or two to appear · Refresh". `note` replaces the middle part (null hides it). */
export function StatsFreshness({
  updatedAt,
  fetching,
  onRefresh,
  className,
  note,
}: {
  updatedAt: number;
  fetching: boolean;
  onRefresh: () => void;
  className?: string;
  note?: ReactNode;
}) {
  // Re-render now and then so "20 seconds ago" stays true.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!updatedAt) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted", className)} aria-live="polite">
      <span>{fetching ? "Updating…" : `Updated ${ago(Math.floor(updatedAt / 1000))}`}</span>
      {note === null ? null : (
        <>
          <span aria-hidden>·</span>
          {note ?? (
            <span className="inline-flex items-center gap-1">
              New clicks take a minute or two to appear
              <InfoTip help={STATS_HELP.live} />
            </span>
          )}
        </>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={fetching}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft disabled:opacity-60"
      >
        <RefreshCw className={cn("size-3", fetching && "animate-spin")} aria-hidden /> Refresh
      </button>
    </div>
  );
}

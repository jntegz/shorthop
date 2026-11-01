// Shared pieces of the website pages: the dashboard's state, deltas that
// know their unit (rates change in percentage points, not "+0.009"), value
// labels without emoji, and the clickable breakdown list (a row filters the
// dashboard). Look: sites.css, plus the list/KPI classes of ui.css.
//
// Section and RowsSkeleton are shared (ui/layout.tsx, parts.tsx). SiteDelta
// (unit-aware delta) and PickRows (BreakdownList whose rows are buttons) stay
// here: no other page needs them yet.

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import type { SiteDim } from "../../../shared/sites";
import { api, call, keys } from "../../api";
import { change, countryName, num, pct } from "../../lib/format";
import { useCan } from "../../lib/me";
import { duration, percent, sourceHint, useSiteView, viewQuery, type SiteView } from "../../lib/sites";
import { cn } from "../../lib/utils";
import { moneyShort, RowsSkeleton } from "../parts";
import { barWidth, useNarrow } from "../ui";

export { moneyShort, RowsSkeleton };

/**
 * The money format of a table column. One rule on every page (DESIGN §6
 * "Formats"): whole amounts drop ".00" ("$199", never "$199.00"), cents stay
 * where there are cents; right-aligned tabular figures keep the column
 * readable. `values` is kept so call sites read as "this column's format".
 */
export function moneyColumn(_values: number[], currency: string): (v: number) => string {
  return (v) => moneyShort(v, currency, false);
}

// ---- State ----

/** The dashboard's URL state and overview. */
export function useSiteDashboard() {
  const { id = "" } = useParams();
  const can = useCan();
  const [view, setView] = useSiteView();
  const query = viewQuery(view);
  const overview = useQuery({
    queryKey: keys.siteData(id, "overview", query),
    queryFn: () => call(api.sites[":id"].overview.$get({ param: { id }, query })),
    refetchInterval: 60_000,
  });
  const filters = Object.entries(view.filters) as [SiteDim, string][];
  const addFilter = (dim: SiteDim, value: string) => setView({ filters: { ...view.filters, [dim]: value } });
  const removeFilter = (dim: SiteDim) => {
    const next = { ...view.filters };
    delete next[dim];
    setView({ filters: next });
  };
  return { id, can, view, setView, query, overview, o: overview.data, revenue: can("revenue.view"), manage: can("sites.manage"), filters, addFilter, removeFilter };
}
export type Dash = ReturnType<typeof useSiteDashboard>;

/** A website's own pages besides the dashboard: its guide and its settings (next/sitepages). */
export const sitePages = {
  guide: (id: string, hash = "") => `/sites/${encodeURIComponent(id)}/guide${hash}`,
  settings: (id: string, hash = "") => `/sites/${encodeURIComponent(id)}/settings${hash}`,
};

// ---- Deltas ----

export type DeltaKind = "count" | "rate" | "duration" | "money";

/**
 * A change against the previous period in the metric's own unit: counts as
 * "+18%" (or "+4" from under 20), rates as "+1.2 pts", durations as "+4s"
 * from small bases, money as a percentage. `good = false` when less is better
 * (bounce); then up is red. Flat or unknown shows nothing.
 */
export function SiteDelta({ kind = "count", current, previous, good = true, currency, className }: { kind?: DeltaKind; current: number; previous: number | null | undefined; good?: boolean; currency?: string; className?: string }) {
  if (previous === null || previous === undefined) return null;
  let text: string;
  let dir: "up" | "down" | "flat";
  let title: string;
  if (kind === "rate") {
    const pts = (current - previous) * 100;
    const r = Math.round(pts * 10) / 10;
    if (current === 0 && previous === 0) return null;
    dir = r > 0 ? "up" : r < 0 ? "down" : "flat";
    text = r === 0 ? "±0 pts" : `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1).replace(/\.0$/, "")} pts`;
    title = `${percent(current)} vs ${percent(previous)}; a change in percentage points`;
  } else if (kind === "money") {
    if (current === 0 && previous === 0) return null;
    const c = currency ?? "USD";
    title = `${moneyShort(current, c, false)} vs ${moneyShort(previous, c, false)}`;
    if (previous <= 0) {
      const diff = current - previous;
      dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
      text = previous === 0 ? "New" : `${diff > 0 ? "+" : "−"}${moneyShort(Math.abs(diff), c)}`;
    } else {
      const p = Math.round(((current - previous) / previous) * 100);
      dir = p > 0 ? "up" : p < 0 ? "down" : "flat";
      text = p === 0 ? "±0%" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`;
    }
  } else {
    const c = change(current, previous);
    if (!c) return null;
    dir = c.dir;
    title = kind === "duration" ? `${duration(current)} vs ${duration(previous)}` : c.title;
    text = kind === "duration" && previous < 20 && !c.text.endsWith("%") ? `${c.text}s` : c.text;
  }
  const tone = dir === "flat" ? "flat" : (dir === "up") === good ? "good" : "bad";
  return (
    <span className={cn("ui-delta", className)} data-tone={tone} title={`${title} in the previous period`}>
      <span aria-hidden>{dir === "up" ? "↑" : dir === "down" ? "↓" : ""}</span>
      {text}
      <span className="ui-sr"> compared with the previous period</span>
    </span>
  );
}

// ---- Labels ----

const CONTINENTS: Record<string, string> = { AF: "Africa", AN: "Antarctica", AS: "Asia", EU: "Europe", NA: "North America", OC: "Oceania", SA: "South America" };
const SCREENS: Record<string, string> = { phone: "Phone (under 600 px)", tablet: "Tablet (600–1023 px)", laptop: "Laptop (1024–1599 px)", wide: "Wide (1600 px and up)" };

/** How a dimension's value reads in a list. Countries by name: no flag emoji, emoji aren't icons here. */
export function valueLabel(dim: SiteDim | "pages" | "goals" | "outbound", value: string): string {
  if (value === "(not matched)") return "Not matched to a visit";
  if (dim === "country") return value ? countryName(value) : "Unknown";
  if (dim === "device") return value ? value[0]!.toUpperCase() + value.slice(1) : "Unknown";
  if (dim === "link") return value || "Not from a short link";
  if (dim === "campaign" || dim.startsWith("utm_")) return value || "(none)";
  if (dim === "referrer") return value || "No referrer";
  if (dim === "continent") return Object.hasOwn(CONTINENTS, value) ? CONTINENTS[value]! : value || "Unknown";
  if (dim === "screen") return Object.hasOwn(SCREENS, value) ? SCREENS[value]! : value || "Unknown";
  if (dim === "visitor_type") return value === "returning" ? "Returning" : "New";
  if (dim === "timezone") return value ? value.replaceAll("_", " ") : "Unknown";
  return value || "Unknown";
}

export const splitLink = (v: string) => ({ domain: v.slice(0, v.indexOf("/")), slug: v.slice(v.indexOf("/") + 1) });

// ---- Breakdown rows that filter the dashboard ----

export interface PickItem {
  key: string;
  label: string;
  /** Full text, when the label is shortened or explained (source hints). */
  title?: string;
  value: number;
  revenue?: number;
  /** Clicking the row adds this filter. */
  onPick?: () => void;
  /** Or the row's name opens this route. */
  to?: string;
  /** A small action at the end of the name (filter by this link). */
  action?: ReactNode;
  quiet?: boolean;
  /** Paths and URLs: wrap on phones instead of cutting off. */
  path?: boolean;
  /** The ribbon segment this row is (the list under the channel ribbon is its legend). */
  swatch?: string;
}

/**
 * Ranked rows with the underline bar (share of the total, ui/data.tsx barWidth), visitors and, when
 * the viewer sees money, revenue as right-aligned tabular columns. Rows with
 * onPick are buttons that filter the page; their name says so to screen readers.
 */
export function PickRows({
  items,
  limit = 6,
  revenue,
  currency,
  unit = "Visitors",
  emptyText = "Nothing in this period.",
  sort = "value",
  onSort,
}: {
  items: PickItem[];
  limit?: number;
  /** Show a revenue column. */
  revenue?: boolean;
  currency: string;
  unit?: string;
  emptyText?: ReactNode;
  sort?: "value" | "revenue";
  /** Sortable columns: the Visitors and Revenue heads become buttons. */
  onSort?: (s: "value" | "revenue") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Phones show 5 rows + "Show all N", so the dashboard stays a short scroll.
  const narrow = useNarrow();
  const max = narrow ? Math.min(limit, 5) : limit;
  const sorted = [...items].sort((a, b) => (sort === "revenue" ? (b.revenue ?? 0) - (a.revenue ?? 0) : 0) || b.value - a.value);
  const shown = expanded ? sorted : sorted.slice(0, max);
  const total = sorted.reduce((s, r) => s + r.value, 0);
  if (!sorted.length) return <p className="ui-rows-empty">{emptyText}</p>;
  return (
    <div className={cn("ui-pick", revenue && "has-money")}>
      {revenue && onSort ? (
        <div className="ui-cols">
          <span />
          <span className="ui-pick-share" aria-hidden>Share</span>
          <button type="button" className="ui-pick-sort" aria-pressed={sort === "value"} onClick={() => onSort("value")}>
            <span className="ui-sr">Sort by </span>
            {unit}
            <span aria-hidden>{sort === "value" ? " ↓" : ""}</span>
          </button>
          <button type="button" className="ui-pick-sort" aria-pressed={sort === "revenue"} onClick={() => onSort("revenue")}>
            <span className="ui-sr">Sort by </span>
            Revenue
            <span aria-hidden>{sort === "revenue" ? " ↓" : ""}</span>
          </button>
        </div>
      ) : (
        <div className="ui-cols" aria-hidden>
          <span />
          <span className="ui-pick-share">Share</span>
          <span>{unit}</span>
          {revenue ? <span>Revenue</span> : null}
        </div>
      )}
      <ol className="ui-rows">
        {shown.map((r) => {
          const cells = (
            <>
              <span className="ui-row-bar" style={{ "--w": barWidth(r.value, total) } as React.CSSProperties} aria-hidden />
              <span className="ui-row-label" title={r.title ?? r.label}>
                {r.swatch ? <span className="ui-row-swatch" data-i={r.swatch} aria-hidden /> : null}
                {r.to ? (
                  <Link to={r.to} className={cn("ui-row-name ui-pick-link", r.path && "is-path")}>{r.label}</Link>
                ) : (
                  <span className={cn("ui-row-name", r.path && "is-path")}>{r.label}</span>
                )}
                {r.action}
              </span>
              <span className="ui-row-share ui-pick-share">{pct(r.value, total)}</span>
              <span className="ui-row-value">
                {num(r.value)}
                <span className="ui-sr"> {unit.toLowerCase()}</span>
              </span>
              {revenue ? (
                <span className={cn("ui-row-money", !r.revenue && "is-none")}>
                  {r.revenue ? moneyShort(r.revenue, currency) : "–"}
                  {r.revenue ? <span className="ui-sr"> revenue</span> : <span className="ui-sr">no revenue</span>}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={r.key} className={cn("ui-row", r.quiet && "is-quiet")}>
              {r.onPick && !r.to ? (
                <button type="button" className="ui-row-inner is-link ui-pick-btn" onClick={r.onPick}>
                  {cells}
                  <span className="ui-sr">, filter the dashboard by this</span>
                </button>
              ) : (
                <div className="ui-row-inner">{cells}</div>
              )}
            </li>
          );
        })}
      </ol>
      {sorted.length > max ? (
        <button type="button" className="ui-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Show fewer" : `Show all ${num(sorted.length)}`}
        </button>
      ) : null}
    </div>
  );
}

/** The honest "this needs Analytics Engine" state, with where to connect it. */
export function NeedsAE({ what, error }: { what: string; error?: string }) {
  const can = useCan();
  return (
    <div className="ui-state is-compact">
      <p className="ui-state-title">{what} need live data.</p>
      <p className="ui-state-body">
        {error ?? "They’re read from Cloudflare Analytics Engine, which isn’t connected to this workspace."}{" "}
        {can("settings.manage") ? <><a href="/_admin/settings#statistics">Connect it in Settings</a>.</> : "An admin can connect it in Settings."}
      </p>
    </div>
  );
}

/** A row's title text: the full value, plus what a Direct source means. */
export function rowTitle(dim: SiteDim, value: string, label: string): string {
  const hint = dim === "source" ? sourceHint(value) : null;
  return hint ? `${label}: ${hint}` : label;
}

export type { SiteView };

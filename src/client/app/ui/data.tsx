// Showing numbers: tables, ranked breakdown lists, KPI stats and status badges.
// Numbers are tabular and right-aligned everywhere. No cards: rows sit on the
// page, separated by hairlines or space.

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { forwardRef, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode, type TdHTMLAttributes, type ThHTMLAttributes } from "react";
import { Link } from "react-router";
import { fullNum, num, pct } from "../../lib/format";
import { PAGE_SIZES, type PageSize, type SortDir } from "../../lib/table";
import { cn } from "../../lib/utils";
import { IconButton } from "./button";
import { Skeleton } from "./feedback";
import { Select } from "./form";

// ---- Table ----

/**
 * A table with keyboard row navigation when `rowNav` is set: ↑/↓ or j/k move
 * focus between rows, Enter opens the row's main link ([data-row-link]),
 * Space toggles its checkbox ([data-row-select]). Rows are focusable with a
 * roving tabindex, so Tab enters the table once and leaves it once.
 */
export function Table({ label, rowNav, className, children, dense }: { label: string; rowNav?: boolean; className?: string; children: ReactNode; dense?: boolean }) {
  const ref = useRef<HTMLTableElement>(null);
  const onKey = (e: KeyboardEvent<HTMLTableElement>) => {
    if (!rowNav) return;
    const row = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-row]");
    if (!row || e.target !== row) return;
    const rows = Array.from(ref.current?.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row]") ?? []);
    const i = rows.indexOf(row);
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!next) return;
      for (const r of rows) r.tabIndex = r === next ? 0 : -1;
      next.focus();
    };
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      move(i + 1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      move(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(0);
    } else if (e.key === "End") {
      e.preventDefault();
      move(rows.length - 1);
    } else if (e.key === "Enter") {
      row.querySelector<HTMLElement>("[data-row-link]")?.click();
    } else if (e.key === " ") {
      const box = row.querySelector<HTMLElement>("[data-row-select]");
      if (box) {
        e.preventDefault();
        box.click();
      }
    }
  };
  return (
    <div className="ui-table-scroll">
      <table ref={ref} className={cn("ui-table", dense && "is-dense", className)} aria-label={label} onKeyDown={onKey}>
        {children}
      </table>
    </div>
  );
}

export function TH({ numeric, className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th scope="col" className={cn(numeric && "is-num", className)} {...rest}>
      {children}
    </th>
  );
}

/**
 * A sortable column head: the whole label is a button, `aria-sort` on the
 * cell; the arrow shows on the active column (and on hover). `short` is the
 * label on phones ("7d" for "7 days").
 */
export function SortTH({ label, short, active, dir, onSort, numeric, className }: { label: string; short?: string; active: boolean; dir: SortDir; onSort: () => void; numeric?: boolean; className?: string }) {
  const Arrow = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TH numeric={numeric} className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" className="ui-sort" data-active={active ? "" : undefined} onClick={onSort}>
        {short ? (
          <span>
            <span className="ui-sort-long">{label}</span>
            <span className="ui-sort-short" aria-hidden>{short}</span>
          </span>
        ) : (
          <span>{label}</span>
        )}
        <Arrow aria-hidden className="ui-sort-arrow" />
      </button>
    </TH>
  );
}

export function TD({ numeric, className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td className={cn(numeric && "is-num", className)} {...rest}>
      {children}
    </td>
  );
}

/**
 * A body row. With `focusable` it joins the table's row navigation (the first
 * row gets tabIndex 0). `selected` marks it for bulk actions.
 */
export const TR = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement> & { focusable?: boolean; first?: boolean; selected?: boolean; "data-demo"?: string }>(function TR(
  { focusable, first, selected, className, children, ...rest },
  ref,
) {
  return (
    <tr
      ref={ref}
      data-row={focusable ? "" : undefined}
      tabIndex={focusable ? (first ? 0 : -1) : undefined}
      aria-selected={selected === undefined ? undefined : selected}
      className={cn(selected && "is-selected", className)}
      {...rest}
    >
      {children}
    </tr>
  );
});

// ---- Pager ----

/** Range, rows per page and previous/next under a paged table. `onSize` is the caller's (it saves the choice). */
export function Pager({ page, pages, size, total, onPage, onSize, className }: { page: number; pages: number; size: PageSize; total: number; onPage: (p: number) => void; onSize: (s: PageSize) => void; className?: string }) {
  const from = (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  return (
    <nav className={cn("ui-pager", className)} aria-label="Pages">
      <span className="ui-pager-range" aria-live="polite">
        {fullNum(from)}–{fullNum(to)} of {fullNum(total)}
      </span>
      <Select
        label="Rows per page"
        className="ui-pager-size"
        value={String(size)}
        onChange={(e) => onSize(Number(e.target.value) as PageSize)}
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} per page` }))}
        hideLabel
      />
      <span className="ui-pager-step">
        <IconButton label="Previous page" icon={ChevronLeft} size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <span className="ui-pager-page">
          Page {page} of {pages}
        </span>
        <IconButton label="Next page" icon={ChevronRight} size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)} />
      </span>
    </nav>
  );
}

// ---- Breakdown list ----

/** One rule for every bar in the admin: the share of the list's total, at least a hairline. */
export function barWidth(value: number, total: number): string {
  if (!total || value <= 0) return "0%";
  return `${Math.max(1, Math.min(100, (value / total) * 100))}%`;
}

export interface BreakdownItem {
  key: string;
  label: ReactNode;
  title?: string;
  value: number;
  /** Shown instead of the formatted value (money, for example). */
  display?: string;
  sub?: ReactNode;
  /** An extra right-aligned column before the share (revenue, a delta). */
  extra?: ReactNode;
  /** A route inside the admin: the row opens it. */
  to?: string;
  /** Quieter row: bots, previews, "everything else". */
  quiet?: boolean;
  /** The ribbon segment this row is (data-i: "0"…"4", "rest"): the list under a ribbon is its legend. */
  swatch?: string;
}

/**
 * Ranked rows, each with a 6 px bar on a full-width track under it, sized to
 * the row's share of the total (not to the largest row), then share and value
 * as right-aligned tabular numbers (the Plausible list). The bar is ink at
 * ≥ 3:1 on the canvas in both themes; a linked row's bar takes the accent on
 * hover or focus.
 */
export function BreakdownList({
  items,
  limit = 8,
  unit = "clicks",
  emptyText = "Nothing in this period",
  total: totalIn,
  showShare = true,
  className,
  demo,
}: {
  items: BreakdownItem[];
  limit?: number;
  unit?: string;
  emptyText?: string;
  total?: number;
  showShare?: boolean;
  className?: string;
  /** Kit only: force a state on one row. */
  demo?: { index: number; state: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, limit);
  const total = totalIn ?? items.reduce((s, r) => s + r.value, 0);
  if (!items.length) return <p className="ui-rows-empty">{emptyText}</p>;
  return (
    <>
      {/* One row is 100 % of itself: no bar, it would say nothing. */}
      <ol className={cn("ui-rows", items.length === 1 && "is-single", className)}>
        {shown.map((r, i) => {
          const inner = (
            <>
              <span className="ui-row-bar" style={{ "--w": barWidth(r.value, total) } as React.CSSProperties} aria-hidden />
              <span className="ui-row-label" title={r.title}>
                {r.swatch ? <span className="ui-row-swatch" data-i={r.swatch} aria-hidden /> : null}
                <span className="ui-row-name">{r.label}</span>
                {r.sub ? <span className="ui-row-sub">{r.sub}</span> : null}
              </span>
              {r.extra}
              {showShare ? <span className="ui-row-share">{pct(r.value, total)}</span> : null}
              <span className="ui-row-value">
                {r.display ?? num(r.value)}
                <span className="ui-sr"> {unit}</span>
              </span>
            </>
          );
          const demoState = demo?.index === i ? demo.state : undefined;
          return (
            <li key={r.key} className={cn("ui-row", r.quiet && "is-quiet")}>
              {r.to ? (
                <Link className="ui-row-inner is-link" to={r.to} data-demo={demoState}>{inner}</Link>
              ) : (
                <div className="ui-row-inner">{inner}</div>
              )}
            </li>
          );
        })}
      </ol>
      {items.length > limit ? (
        <button type="button" className="ui-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Show fewer" : `Show all ${num(items.length)}`}
        </button>
      ) : null}
    </>
  );
}

// ---- KPI stat ----

/**
 * One headline number: label, value (Hanken, tabular), then delta and a
 * note. Pass role="tab" etc. to make a row of them switch a chart.
 */
export const Stat = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { label: ReactNode; value: ReactNode; delta?: ReactNode; note?: ReactNode; quiet?: boolean; disabled?: boolean; "data-demo"?: string }>(
  function Stat({ label, value, delta, note, quiet, disabled, className, ...rest }, ref) {
    return (
      <div ref={ref} className={cn("ui-kpi", quiet && "is-quiet", disabled && "is-disabled", className)} {...rest}>
        <span className="ui-kpi-label">{label}</span>
        <span className="ui-kpi-value">{value}</span>
        <span className="ui-kpi-foot">
          {delta}
          {note ? <span className="ui-kpi-note">{note}</span> : null}
        </span>
      </div>
    );
  },
);

// ---- KPI strip ----

export interface StatItem<T extends string = string> {
  id: T;
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  note?: ReactNode;
  quiet?: boolean;
  /** Not choosable (loading, not available); arrow keys skip it. */
  disabled?: boolean;
  className?: string;
}

/**
 * A row of Stats. With `onChange` it is a tab list that switches a chart:
 * ←/→ move and choose (skipping disabled ones), Home/End jump, Enter/Space
 * choose; one roving tab stop. Without it the numbers are plain.
 */
export function StatStrip<T extends string>({ items, value, onChange, label = "Chart metric", className }: { items: StatItem<T>[]; value?: T; onChange?: (id: T) => void; label?: string; className?: string }) {
  const base = useId();
  const style = { "--n": items.length } as React.CSSProperties;
  if (!onChange)
    return (
      <div className={cn("ui-kpis", className)} style={style}>
        {items.map((k) => (
          <Stat key={k.id} className={k.className} quiet={k.quiet} disabled={k.disabled} label={k.label} value={k.value} delta={k.delta} note={k.note} />
        ))}
      </div>
    );
  const choose = (k: StatItem<T> | undefined, focus: boolean) => {
    if (!k) return;
    onChange(k.id);
    if (focus) document.getElementById(`${base}-${k.id}`)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const enabled = items.filter((k) => !k.disabled);
    if (!enabled.length) return;
    const i = enabled.findIndex((k) => k.id === value);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? enabled.length - 1 : step ? (i + step + enabled.length) % enabled.length : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(enabled[to], true);
  };
  return (
    <div className={cn("ui-kpis", className)} role="tablist" aria-label={label} onKeyDown={onKey} style={style}>
      {items.map((k) => (
        <Stat
          key={k.id}
          id={`${base}-${k.id}`}
          role="tab"
          aria-selected={k.id === value}
          aria-disabled={k.disabled || undefined}
          tabIndex={k.id === value ? 0 : -1}
          className={k.className}
          quiet={k.quiet}
          disabled={k.disabled}
          label={k.label}
          value={k.value}
          delta={k.delta}
          note={k.note}
          onClick={() => !k.disabled && choose(k, false)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !k.disabled) {
              e.preventDefault();
              choose(k, false);
            }
          }}
        />
      ))}
    </div>
  );
}

/** The strip's shape while its numbers load. */
export function StatStripSkeleton({ count, className, ...rest }: { count: number; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("ui-kpis", className)} style={{ "--n": count } as React.CSSProperties} {...rest}>
      {Array.from({ length: count }, (_, i) => (
        <Stat key={i} className="is-skel" label={<Skeleton className="ui-skel-text" style={{ width: 84 }} />} value={<Skeleton className="ui-skel-num" />} note={<Skeleton className="ui-skel-text" style={{ width: 110 }} />} />
      ))}
    </div>
  );
}

// ---- Badge ----

export type BadgeTone = "good" | "warn" | "danger" | "neutral";

/** A status word with a dot. Only for state that means something (Active, Down, Paused). */
export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("ui-badge", className)} data-tone={tone}>
      <span className="ui-badge-dot" aria-hidden />
      {children}
    </span>
  );
}

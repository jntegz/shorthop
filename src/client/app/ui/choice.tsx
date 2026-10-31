// Picking one of a few: Segmented (a radio group, e.g. the period) and Tabs
// (underline tabs over a panel, Radix). Both move with the arrow keys.

import { Tabs as RTabs } from "radix-ui";
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** A shorter label for phones, e.g. "7d" for "7 days". */
  short?: string;
  disabled?: boolean;
}

/**
 * A radio group drawn as one pill. Roving tabindex: Tab enters on the chosen
 * option, arrows move and choose at once (the ARIA radio pattern).
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = "md",
  className,
  demo,
}: {
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  /** Kit only: force a visual state on one option, e.g. { index: 1, state: "hover" }. */
  demo?: { index: number; state: string };
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    let next = index;
    for (let i = 0; i < options.length; i++) {
      next = (next + step + options.length) % options.length;
      if (!options[next]!.disabled) break;
    }
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div className={cn("ui-segmented", className)} data-size={size} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          disabled={o.disabled}
          className="ui-segmented-opt"
          onClick={() => onChange(o.value)}
          title={o.short ? o.label : undefined}
          data-demo={demo?.index === i ? demo.state : undefined}
        >
          {o.short ? (
            <>
              <span className="ui-seg-long">{o.label}</span>
              <span className="ui-seg-short" aria-hidden>{o.short}</span>
            </>
          ) : (
            o.label
          )}
        </button>
      ))}
    </div>
  );
}

export interface TabItem {
  value: string;
  label: string;
  /** A count shown after the label, e.g. the number of rows. */
  count?: number | string;
  disabled?: boolean;
  /** Kit only: force a visual state. */
  demo?: string;
}

/** Underline tabs (Radix: arrow keys, Home/End, automatic activation). */
export function Tabs({
  label,
  items,
  value,
  onValueChange,
  children,
  className,
  listClassName,
  aside,
}: {
  label: string;
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** The panel for the current tab. */
  children: (value: string) => ReactNode;
  className?: string;
  listClassName?: string;
  /** Sits at the end of the tab row (a link or a small control). */
  aside?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  // A row wider than its column (phones) scrolls; a fade at the cut edge says
  // there is more ("Medium…", "Time zones"), instead of a silent clip.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const update = () => {
      const more = el.scrollWidth - el.clientWidth;
      const start = el.scrollLeft > 2;
      const end = more - el.scrollLeft > 2;
      el.dataset.fade = start && end ? "both" : start ? "start" : end ? "end" : "";
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [items.length]);
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className={cn("ui-tabs", className)}>
      <div className="ui-tabs-row">
        <RTabs.List ref={list} aria-label={label} className={cn("ui-tablist", listClassName)}>
          {items.map((t) => (
            <RTabs.Trigger key={t.value} value={t.value} disabled={t.disabled} className="ui-tab" data-demo={t.demo}>
              {t.label}
              {t.count !== undefined ? <span className="ui-tab-count">{t.count}</span> : null}
            </RTabs.Trigger>
          ))}
        </RTabs.List>
        {aside}
      </div>
      {items.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className="ui-tabpanel">
          {t.value === value ? children(t.value) : null}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}

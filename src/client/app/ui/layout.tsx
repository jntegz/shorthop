// Page structure. No cards: a section is a top rule, a title, an optional
// line under it, tools on the right, then its content.

import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

const PHONE = "(max-width: 767px)";
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** True under 768 px (phones): for layout decisions CSS can't make, such as how many rows a list shows. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

/**
 * A page section: 1 px top rule, h2, an optional sub line, tools on the
 * right. With `foldOnPhone` (a one-line summary), a rarely used section
 * starts closed on phones: the title becomes a disclosure button with the
 * summary under it, and the tools and content appear when it opens. Wide
 * screens always show it open. Nothing is removed, only folded.
 */
export function Section({ title, sub, aside, children, className, id, foldOnPhone }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string; foldOnPhone?: ReactNode }) {
  const h = useId();
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  if (foldOnPhone && narrow)
    return (
      <section className={cn("ui-section is-fold", open && "is-open", className)} aria-labelledby={`${h}-t`} id={id}>
        <header className="ui-section-head">
          <div className="ui-section-title">
            <h2 id={`${h}-t`} className="ui-h2">
              <button type="button" className="ui-fold-btn" aria-expanded={open} aria-controls={`${h}-c`} onClick={() => setOpen((v) => !v)}>
                <span>{title}</span>
                <ChevronDown aria-hidden className="ui-fold-chevron" />
              </button>
            </h2>
            <p className="ui-section-sub">{open ? sub : foldOnPhone}</p>
          </div>
          {aside ? <div className="ui-section-tools" hidden={!open}>{aside}</div> : null}
        </header>
        <div id={`${h}-c`} hidden={!open}>
          {children}
        </div>
      </section>
    );
  return (
    <section className={cn("ui-section", className)} aria-labelledby={`${h}-t`} id={id}>
      <header className="ui-section-head">
        <div className="ui-section-title">
          <h2 id={`${h}-t`} className="ui-h2">{title}</h2>
          {sub ? <p className="ui-section-sub">{sub}</p> : null}
        </div>
        {aside ? <div className="ui-section-tools">{aside}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Row gap between packed sections (ui.css .ui-columns.is-packed); --ui-s-6. */
const PACK_GAP = 40;

/** Which column each section goes to: the split with the most even column heights (the first section stays left). */
function balance(heights: number[]): (1 | 2)[] {
  const n = heights.length;
  let best = 0;
  let bestMax = Infinity;
  // Bit i set = section i goes right. Up to ~8 sections: 128 splits.
  for (let mask = 0; mask < 1 << n; mask += 2) {
    let l = 0;
    let r = 0;
    heights.forEach((h, i) => (mask & (1 << i) ? (r += h) : (l += h)));
    const max = Math.max(l, r);
    if (max < bestMax - 8) {
      bestMax = max;
      best = mask;
    }
  }
  return heights.map((_, i) => (best & (1 << i) ? 2 : 1));
}

/**
 * Two open columns of sections (breakdown lists) without half-empty rows.
 * At ≥ 1024 px the sections are split between the two columns so their
 * heights come out as even as possible (each column keeps source order;
 * a CSS grid with 1 px rows, each section spanning its measured height), so
 * a short list never leaves a hole beside a long one. The split is made
 * when the content arrives and is kept once you interact (a tab switch or
 * "Show all" re-measures, but never moves a section to the other column
 * under your pointer). Below 1024 px: one column in source order.
 */
export function Columns({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    let frozen = false;
    const kids = () => Array.from(el.children) as HTMLElement[];
    const apply = () => {
      const on = mq.matches && el.children.length > 1;
      el.classList.toggle("is-packed", on);
      const list = kids();
      const heights = list.map((c) => Math.ceil(c.getBoundingClientRect().height) + PACK_GAP);
      const lanes = on && !frozen ? balance(heights) : null;
      list.forEach((c, i) => {
        c.style.gridRowEnd = on ? `span ${heights[i]}` : "";
        if (!on) c.style.gridColumn = "";
        else if (lanes) c.style.gridColumn = String(lanes[i]);
      });
    };
    const freeze = () => {
      frozen = true;
    };
    const ro = new ResizeObserver(apply);
    const watch = () => {
      frozen = false;
      ro.disconnect();
      for (const c of kids()) ro.observe(c);
      apply();
    };
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    mq.addEventListener("change", apply);
    el.addEventListener("pointerdown", freeze);
    el.addEventListener("keydown", freeze);
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", apply);
      el.removeEventListener("pointerdown", freeze);
      el.removeEventListener("keydown", freeze);
    };
  }, []);
  return (
    <div ref={ref} className={cn("ui-columns", className)}>
      {children}
    </div>
  );
}

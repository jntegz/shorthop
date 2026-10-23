// Period-over-period change, as shown on the stat tiles.

const full = new Intl.NumberFormat("en");

export interface Change {
  /** "+12%", "−3", "New". */
  text: string;
  dir: "up" | "down" | "flat";
  /** "1,240 vs 1,105". */
  title: string;
}

/**
 * The change between two periods, as a percentage only when that means
 * something: from fewer than 20, a percentage swings wildly, so it's shown as
 * a plain difference; from nothing, it's "New".
 */
export function change(current: number, previous: number): Change | null {
  if (current === 0 && previous === 0) return null;
  const title = `${full.format(current)} vs ${full.format(previous)}`;
  if (previous === 0) return { text: "New", dir: "up", title };
  const diff = current - previous;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  if (previous < 20) return { text: diff === 0 ? "±0" : `${diff > 0 ? "+" : "−"}${full.format(Math.abs(diff))}`, dir, title };
  const p = Math.round((diff / previous) * 100);
  return { text: p === 0 ? "±0%" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`, dir: p === 0 ? "flat" : dir, title };
}

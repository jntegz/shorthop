// Client-side sorting and paging for the admin tables (the lists are already fully loaded).

export type SortDir = "asc" | "desc";

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export function parsePageSize(v: string | number | null | undefined): PageSize | null {
  const n = Number(v);
  return PAGE_SIZES.find((s) => s === n) ?? null;
}

/** The page size this browser last picked for a table; 25 when unknown or storage is blocked. */
export function savedPageSize(table: string): PageSize {
  try {
    return parsePageSize(localStorage.getItem(`pageSize:${table}`)) ?? PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
}

export function savePageSize(table: string, size: PageSize): void {
  try {
    localStorage.setItem(`pageSize:${table}`, String(size));
  } catch {
    // Private window or blocked storage: the choice just isn't remembered.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sorts a copy; ties keep their incoming order. */
export function sortRows<T>(rows: readonly T[], value: (row: T) => string | number, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : collator.compare(String(a.v), String(b.v));
      return c * sign || a.i - b.i;
    })
    .map((x) => x.row);
}

/** One page of rows, with the page clamped into range (a filter can shrink the list under you). */
export function pageOf<T>(rows: readonly T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages };
}

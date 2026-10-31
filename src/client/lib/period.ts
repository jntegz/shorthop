// A period (shared/types Period) as the API takes it.

import type { Period, Range } from "../../shared/types";

/** The API's period query: only the fields that are set. */
export function periodQuery(p: Period): { range: Range; from?: string; to?: string } {
  return p.range === "custom" && p.from && p.to ? { range: "custom", from: p.from, to: p.to } : { range: p.range };
}

/** "range=custom&from=…&to=…", for download links. */
export function periodParams(p: Period): string {
  return new URLSearchParams(periodQuery(p)).toString();
}

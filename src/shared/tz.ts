// Time zone arithmetic for the site dashboards, which count days in the
// site's own zone. Offsets are worked out for each instant, so periods that
// cross a daylight-saving change stay right.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallTime(sec: number, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(sec * 1000))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour! % 24, mi: parts.minute!, s: parts.second! };
}

/** Seconds the zone is ahead of UTC at that instant (CET in winter: 3600). */
export function tzOffsetSec(tz: string, sec: number): number {
  const w = wallTime(sec, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) / 1000 - Math.floor(sec);
}

/** The instant a wall-clock time happens in the zone (the earlier one in a repeated hour). */
export function zonedToUtc(tz: string, y: number, m: number, d: number, h = 0): number {
  const guess = Date.UTC(y, m - 1, d, h) / 1000;
  const first = guess - tzOffsetSec(tz, guess);
  const second = guess - tzOffsetSec(tz, first);
  return Math.min(first, second);
}

/** The local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(sec: number, tz: string): string {
  const w = wallTime(sec, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Unix seconds of local midnight starting a YYYY-MM-DD date. */
export function localMidnight(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return zonedToUtc(tz, y, m, d);
}

function addLocalDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

export type BucketSize = "hour" | "day" | "week" | "month";

/**
 * Bucket start instants covering the local dates from..to (inclusive), plus the
 * end of the last bucket. Weeks start on Monday; the first and last buckets are
 * cut to the period.
 */
export function bucketEdges(from: string, to: string, tz: string, size: BucketSize): number[] {
  const end = localMidnight(addLocalDays(to, 1), tz);
  const edges: number[] = [];
  if (size === "hour") {
    for (let t = localMidnight(from, tz); t < end; t += 3600) edges.push(t);
  } else {
    let date = from;
    while (date <= to) {
      edges.push(localMidnight(date, tz));
      if (size === "day") date = addLocalDays(date, 1);
      else if (size === "week") {
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
        date = addLocalDays(date, 8 - dow);
      } else {
        const [y, m] = date.split("-").map(Number) as [number, number];
        date = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
      }
    }
  }
  edges.push(end);
  return edges;
}

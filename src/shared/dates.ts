// UTC calendar-day helpers. All stats use UTC days.

import type { Range } from "./types";

const DAY_MS = 86_400_000;

export function utcDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return utcDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS));
}

/** Unix seconds at 00:00 UTC of a YYYY-MM-DD date. */
export function dayStartSec(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

export function dateFromDaySec(sec: number): string {
  return utcDate(new Date(sec * 1000));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Inclusive date bounds for a range ending today. */
export function rangeBounds(range: Range, now: Date = new Date()): { from: string; to: string } {
  const to = utcDate(now);
  const span: Record<Range, number> = { today: 0, "7d": 6, "14d": 13, "30d": 29, "90d": 89, "180d": 179, "365d": 364, all: 0 };
  if (range === "all") return { from: "2000-01-01", to };
  return { from: addDays(to, -span[range]), to };
}

/** ISO 8601 week key such as "2026-W43". */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

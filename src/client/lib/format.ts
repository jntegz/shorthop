const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");

export function num(n: number): string {
  return Math.abs(n) >= 10_000 ? compact.format(n) : full.format(n);
}

export function fullNum(n: number): string {
  return full.format(n);
}

export { change, type Change } from "../../shared/change";

export function pct(part: number, total: number): string {
  if (!total) return "0%";
  const p = (part / total) * 100;
  return `${p < 1 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const shortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const dateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Unix seconds → "19 Oct 2026". */
export function date(sec: number): string {
  return dateFmt.format(new Date(sec * 1000));
}

/** "2026-10-19" (UTC day) → "19 Oct". */
export function day(iso: string): string {
  return shortDate.format(new Date(`${iso}T00:00:00Z`));
}

export function when(isoOrSec: string | number): string {
  const d = typeof isoOrSec === "number" ? new Date(isoOrSec * 1000) : new Date(isoOrSec);
  return dateTime.format(d);
}

const dateTimeYear = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Unix seconds → "Dec 31, 2026, 11:00 PM": for moments that may be in another year. */
export function whenFull(sec: number): string {
  return dateTimeYear.format(new Date(sec * 1000));
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function ago(sec: number): string {
  const diff = sec - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return date(sec);
}

let regionNames: Intl.DisplayNames | null = null;
try {
  regionNames = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  regionNames = null;
}

export function countryName(code: string): string {
  if (!code) return "Unknown";
  if (code === "T1") return "Tor network";
  if (code === "XX") return "Unknown";
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

let languageNames: Intl.DisplayNames | null = null;
try {
  languageNames = new Intl.DisplayNames(["en"], { type: "language" });
} catch {
  languageNames = null;
}

/** "en-us" → "English (United States)". */
export function languageName(tag: string): string {
  try {
    return languageNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function flag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return "🌐";
  return String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const SOURCE_LABELS: Record<string, string> = {
  li: "LinkedIn",
  nl: "Newsletter",
  qr: "QR code",
  x: "X / Twitter",
  fb: "Facebook",
  ig: "Instagram",
  yt: "YouTube",
  bsky: "Bluesky",
  threads: "Threads",
  reddit: "Reddit",
  hn: "Hacker News",
  email: "Webmail",
  google: "Google",
  bing: "Bing",
  ddg: "DuckDuckGo",
  site: "Your website",
  referral: "Other websites",
  direct: "Direct / unknown",
};

export function sourceLabel(s: string): string {
  return SOURCE_LABELS[s] ?? s;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** For <input type="datetime-local">: unix seconds ↔ local "YYYY-MM-DDTHH:mm". */
export function toLocalInput(sec: number | null): string {
  if (sec === null) return "";
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

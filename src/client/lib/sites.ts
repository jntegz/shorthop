// Site dashboard state (period, granularity, filters) kept in the URL, so a
// view can be bookmarked and shared, plus labels for dimensions and money.

import { useSearchParams } from "react-router";
import { formatMoney, FX_CURRENCIES, GRANULARITIES, SITE_DIMS, type Granularity, type SiteDim } from "../../shared/sites";
import type { ComboOption } from "../components/ui";
import { RANGES, type Period, type Range } from "../../shared/types";
import { countryName, flag } from "./format";

export const DIM_LABELS: Record<SiteDim, string> = {
  channel: "Channel",
  source: "Source",
  referrer: "Referrer",
  campaign: "Campaign",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  utm_term: "Keyword",
  utm_content: "UTM content",
  link: "Short link",
  entry: "Landing page",
  exit: "Exit page",
  hostname: "Hostname",
  country: "Country",
  region: "Region",
  city: "City",
  device: "Device",
  os: "OS",
  browser: "Browser",
  language: "Language",
  org: "Network",
  continent: "Continent",
  timezone: "Time zone",
  screen: "Screen",
  visitor_type: "New vs returning",
};

const CONTINENTS: Record<string, string> = { AF: "Africa", AN: "Antarctica", AS: "Asia", EU: "Europe", NA: "North America", OC: "Oceania", SA: "South America" };
const SCREENS: Record<string, string> = { phone: "Phone (under 600 px)", tablet: "Tablet (600–1023 px)", laptop: "Laptop (1024–1599 px)", wide: "Wide (1600 px and up)" };

export const GRANULARITY_LABELS: Record<Granularity, string> = { hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly" };

export interface SiteView {
  period: Period;
  granularity: Granularity | undefined;
  filters: Partial<Record<SiteDim, string>>;
}

/** The dashboard's view, read from and written to the URL's query string. */
export function useSiteView(): [SiteView, (next: Partial<SiteView>) => void] {
  const [params, setParams] = useSearchParams();
  const range = (RANGES as readonly string[]).includes(params.get("range") ?? "") ? (params.get("range") as Range) : "30d";
  const g = params.get("granularity");
  const filters: Partial<Record<SiteDim, string>> = {};
  for (const d of SITE_DIMS) {
    const v = params.get(`f_${d}`);
    if (v !== null) filters[d] = v;
  }
  const view: SiteView = {
    period: { range, from: params.get("from") ?? undefined, to: params.get("to") ?? undefined },
    granularity: (GRANULARITIES as readonly string[]).includes(g ?? "") ? (g as Granularity) : undefined,
    filters,
  };
  const update = (next: Partial<SiteView>) => {
    const v = { ...view, ...next };
    const p = new URLSearchParams();
    // The open tab stays; everything else is rewritten from the view.
    if (params.get("tab")) p.set("tab", params.get("tab")!);
    p.set("range", v.period.range);
    if (v.period.range === "custom" && v.period.from && v.period.to) {
      p.set("from", v.period.from);
      p.set("to", v.period.to);
    }
    if (v.granularity) p.set("granularity", v.granularity);
    for (const [d, val] of Object.entries(v.filters)) if (val !== undefined) p.set(`f_${d}`, val);
    setParams(p, { replace: true });
  };
  return [view, update];
}

/** The API query for a view: strings only, unset fields left out. */
export function viewQuery(v: SiteView): Record<string, string> {
  const q: Record<string, string> = { range: v.period.range };
  if (v.period.range === "custom" && v.period.from && v.period.to) {
    q.from = v.period.from;
    q.to = v.period.to;
  }
  if (v.granularity) q.granularity = v.granularity;
  for (const [d, val] of Object.entries(v.filters)) if (val !== undefined) q[`f_${d}`] = val;
  return q;
}

export function money(minor: number, currency: string, compact = false): string {
  return formatMoney(minor, currency, { compact });
}

/** How a dimension's value reads in a list. */
export function dimValue(dim: SiteDim | "pages" | "goals" | "outbound", value: string): string {
  if (value === "(not matched)") return "Not matched to a visit";
  if (dim === "country") return value ? `${flag(value)} ${countryName(value)}` : "Unknown";
  if (dim === "device") return value ? value[0]!.toUpperCase() + value.slice(1) : "Unknown";
  if (dim === "link") return value || "Not from a short link";
  if (dim === "campaign" || dim.startsWith("utm_")) return value || "(none)";
  if (dim === "referrer") return value || "No referrer";
  if (dim === "continent") return CONTINENTS[value] ?? (value || "Unknown");
  if (dim === "screen") return SCREENS[value] ?? (value || "Unknown");
  if (dim === "visitor_type") return value === "returning" ? "Returning" : "New";
  if (dim === "timezone") return value ? value.replaceAll("_", " ") : "Unknown";
  return value || "Unknown";
}

/** What the Direct sources mean (src/worker/web/source.ts), for their tooltips. */
export function sourceHint(value: string): string | null {
  if (value === "Checkout return") return "Came back from a payment page (Stripe, Paddle…) after checkout.";
  if (value === "Shared link") return "Opened a deep link with no referrer: usually pasted into a chat, an email app or a document.";
  if (value === "Typed / bookmark") return "Opened the home page with no referrer: typed, bookmarked or a new tab.";
  if (value.endsWith(" (in-app)")) return `Opened inside the ${value.slice(0, -9)} app's own browser, which sends no referrer.`;
  return null;
}

export function duration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function percent(x: number): string {
  const p = x * 100;
  return `${p > 0 && p < 1 ? p.toFixed(1) : p < 10 ? p.toFixed(1).replace(/\.0$/, "") : Math.round(p)}%`;
}

const MATCH_LABELS: Record<string, string> = {
  ref: "Checkout reference",
  customer: "Same customer",
  claim: "Return page",
  email: "Email",
  timing: "Checkout timing",
};

export function matchLabel(by: string | null): string {
  return by ? (MATCH_LABELS[by] ?? by) : "Not matched";
}

/** What a match's confidence means, for its tooltip. */
const CONFIDENCE_MEANING: Record<string, string> = {
  high: "High confidence: the provider's own data ties this payment to the visit.",
  medium: "Medium confidence: matched by an email your server reported for this visitor.",
  low: "Low confidence: an educated guess (an email the browser reported, or the only visit that went to checkout shortly before). Anyone can send browser events, so treat it as likely, not certain.",
};

export function confidenceMeaning(confidence: string | null): string {
  return CONFIDENCE_MEANING[confidence ?? "low"] ?? CONFIDENCE_MEANING.low!;
}

/** The browser's own zone, a sensible default for a new site. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** IANA zones the browser knows, for the time zone picker. */
export function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

/** The most used first, in the picker's empty state. */
const POPULAR = ["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "CZK", "PLN", "SEK", "INR", "BRL"];

/**
 * Every ISO 4217 currency the browser knows, for the currency picker. Ones
 * without a daily ECB rate are marked: payments in other currencies can't be
 * converted into them (payments in that same currency still count).
 */
export function currencyOptions(): ComboOption[] {
  let codes: string[];
  try {
    codes = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("currency");
  } catch {
    codes = [...FX_CURRENCIES];
  }
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "currency" });
  } catch {
    names = null;
  }
  const fx = new Set<string>(FX_CURRENCIES);
  const rank = (c: string) => (POPULAR.includes(c) ? POPULAR.indexOf(c) : fx.has(c) ? 100 : 200);
  return [...new Set([...codes, ...FX_CURRENCIES])]
    .filter((c) => /^[A-Z]{3}$/.test(c))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((c) => ({ value: c, label: c, detail: names?.of(c) ?? c, note: fx.has(c) ? undefined : "no daily rate" }));
}

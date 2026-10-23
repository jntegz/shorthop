// Smart routing: ordered rules that send visitors to different destinations
// by device and country, optionally split between weighted variants (A/B
// tests, rotations). The link's own target is the fallback for everyone no
// rule matches. Pure code, shared by the redirect, the API and the admin's
// simulator, so all three always agree.

import { normalizeTarget } from "./target";

export const ROUTE_DEVICES = ["ios", "android", "desktop", "other"] as const;
export type RouteDevice = (typeof ROUTE_DEVICES)[number];

export const DEVICE_LABEL: Record<RouteDevice, string> = {
  ios: "iPhone & iPad",
  android: "Android",
  desktop: "Desktop",
  other: "Other devices",
};

/** Country code for requests Cloudflare can't place (no data, or Tor). */
export const UNKNOWN_COUNTRY = "XX";

export const MAX_RULES = 10;
export const MAX_VARIANTS = 10;
const ID_RE = /^[a-z0-9]{1,8}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

export interface RouteVariant {
  /** Stable id: analytics count clicks by it, so it never changes once saved. */
  id: string;
  /** "A", "B", "Czech page": shown in stats, available to UTM as {variant}. */
  label: string;
  url: string;
  /** Percent of the rule's traffic; the variants of a rule total 100. */
  weight: number;
}

export interface RouteRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Empty: any device. */
  devices: RouteDevice[];
  /** ISO 3166-1 alpha-2 codes, plus XX for unknown. Empty: any country. */
  countries: string[];
  /** Whether `countries` lists where the rule applies, or where it doesn't. */
  countryMode: "in" | "not_in";
  variants: RouteVariant[];
}

export interface Routing {
  rules: RouteRule[];
  /** Unix seconds when the destinations or weights last changed: results before it mix two setups. */
  changedAt: number;
}

export interface RouteContext {
  device: RouteDevice;
  /** Two-letter code, or XX. */
  country: string;
}

/** The part of a rule the redirect needs (labels and names stay in D1). */
export type MatchableRule = Pick<RouteRule, "id" | "devices" | "countries" | "countryMode"> & { variants: Pick<RouteVariant, "id" | "url" | "weight">[] };

/** The device class rules match on, from the OS and form factor analytics already detect. */
export function routeDevice(os: string, formFactor: string): RouteDevice {
  if (os === "iOS") return "ios";
  if (os === "Android") return "android";
  return formFactor === "desktop" ? "desktop" : "other";
}

/** A country as rules see it: unknown, Tor and malformed all become XX. */
export function routeCountry(cf: string | null | undefined): string {
  const c = (cf ?? "").toUpperCase();
  return COUNTRY_RE.test(c) && c !== "T1" ? c : UNKNOWN_COUNTRY;
}

export function ruleMatches(rule: Pick<RouteRule, "devices" | "countries" | "countryMode">, ctx: RouteContext): boolean {
  if (rule.devices.length && !rule.devices.includes(ctx.device)) return false;
  if (rule.countries.length) {
    const listed = rule.countries.includes(ctx.country);
    if (rule.countryMode === "in" ? !listed : listed) return false;
  }
  return true;
}

/** Whether a rule matches everyone: anything after it can never run. */
export function isCatchAll(rule: Pick<RouteRule, "devices" | "countries">): boolean {
  return rule.devices.length === 0 && rule.countries.length === 0;
}

/**
 * The destination for one request: the first matching rule, then a variant
 * by weight (`rand` in [0, 1)). Null means the fallback (the link's target).
 * `key` is what analytics record: the rule id, plus ".variant" for a split.
 */
export function pickRoute(rules: readonly MatchableRule[], ctx: RouteContext, rand: number): { url: string; key: string; ruleId: string; variantId: string } | null {
  for (const rule of rules) {
    if (!ruleMatches(rule, ctx)) continue;
    const vs = rule.variants;
    if (!vs.length) return null;
    let point = rand * 100;
    let chosen = vs[vs.length - 1]!;
    for (const v of vs) {
      if (point < v.weight) {
        chosen = v;
        break;
      }
      point -= v.weight;
    }
    return { url: chosen.url, key: vs.length > 1 ? `${rule.id}.${chosen.id}` : rule.id, ruleId: rule.id, variantId: chosen.id };
  }
  return null;
}

/** The first enabled rule that matches, for the simulator. */
export function matchingRule(routing: Routing | null, ctx: RouteContext): { rule: RouteRule; index: number } | null {
  if (!routing) return null;
  const index = routing.rules.findIndex((r) => r.enabled && ruleMatches(r, ctx));
  return index === -1 ? null : { rule: routing.rules[index]!, index };
}

/** Problems that make a routing setup unsavable, with the rule they belong to (-1: the whole setup). */
export interface RoutingError {
  rule: number;
  message: string;
}

/**
 * Validates and normalizes a routing setup. Destinations go through the same
 * rules as a link's own target. Returns the cleaned setup, or the errors.
 */
export function validateRouting(
  input: Omit<Routing, "changedAt">,
  opts: { selfHosts?: readonly string[] } = {},
): { ok: true; rules: RouteRule[] } | { ok: false; errors: RoutingError[] } {
  const errors: RoutingError[] = [];
  const err = (rule: number, message: string) => errors.push({ rule, message });
  if (input.rules.length > MAX_RULES) err(-1, `Use at most ${MAX_RULES} rules.`);
  const ruleIds = new Set<string>();
  let catchAllAt = -1;
  const rules = input.rules.map((r, i): RouteRule => {
    if (!ID_RE.test(r.id) || ruleIds.has(r.id)) err(i, "Rule has an invalid or repeated id.");
    ruleIds.add(r.id);
    const devices = [...new Set(r.devices)].filter((d): d is RouteDevice => (ROUTE_DEVICES as readonly string[]).includes(d));
    const countries = [...new Set(r.countries.map((c) => c.trim().toUpperCase()))];
    if (countries.some((c) => !COUNTRY_RE.test(c))) err(i, "Countries must be two-letter codes such as CZ.");
    if (devices.length === ROUTE_DEVICES.length) err(i, "Every device is selected: clear them to mean any device.");
    if (r.enabled && isCatchAll({ devices, countries }) && catchAllAt === -1) catchAllAt = i;
    if (!r.variants.length) err(i, "Add a destination.");
    if (r.variants.length > MAX_VARIANTS) err(i, `Use at most ${MAX_VARIANTS} destinations in one rule.`);
    const variantIds = new Set<string>();
    const variants = r.variants.map((v) => {
      if (!ID_RE.test(v.id) || variantIds.has(v.id)) err(i, "A destination has an invalid or repeated id.");
      variantIds.add(v.id);
      const target = normalizeTarget(v.url, { selfHosts: opts.selfHosts });
      if (!v.url.trim()) err(i, r.variants.length > 1 ? `Enter the URL for ${v.label || "each destination"}.` : "Enter the URL to send these visitors to.");
      else if (!target.ok) err(i, `${r.variants.length > 1 ? `${v.label || "Destination"}: ` : ""}${target.error}`);
      if (!Number.isInteger(v.weight) || v.weight < 1 || v.weight > 100) err(i, "Each share must be a whole number from 1 to 100.");
      return { id: v.id, label: v.label.trim().slice(0, 40), url: target.ok ? target.url : v.url, weight: r.variants.length === 1 ? 100 : v.weight };
    });
    if (variants.length > 1 && variants.reduce((s, v) => s + v.weight, 0) !== 100) err(i, "The shares must add up to 100%.");
    if (variants.length > 1 && variants.some((v) => !v.label)) err(i, "Name each destination of a split, such as A and B.");
    return { id: r.id, name: r.name.trim().slice(0, 60), enabled: r.enabled, devices, countries, countryMode: r.countryMode === "not_in" ? "not_in" : "in", variants };
  });
  if (catchAllAt !== -1) {
    const shadowed = rules.findIndex((r, i) => i > catchAllAt && r.enabled);
    if (shadowed !== -1) err(shadowed, `Rule ${catchAllAt + 1} matches everyone, so this rule never runs. Move it above, or add conditions to rule ${catchAllAt + 1}.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, rules };
}

/** Rules that can never match because an earlier rule covers all their cases. */
export function shadowedRules(rules: readonly RouteRule[]): Set<number> {
  const out = new Set<number>();
  rules.forEach((r, i) => {
    if (!r.enabled) return;
    for (let j = 0; j < i; j++) {
      const e = rules[j]!;
      if (!e.enabled) continue;
      const devicesCovered = e.devices.length === 0 || (r.devices.length > 0 && r.devices.every((d) => e.devices.includes(d)));
      const countriesCovered =
        e.countries.length === 0 ||
        (r.countries.length > 0 && r.countryMode === "in" && e.countryMode === "in" && r.countries.every((c) => e.countries.includes(c)));
      if (devicesCovered && countriesCovered) {
        out.add(i);
        return;
      }
    }
  });
  return out;
}

/** Whether destinations or weights differ, which starts a new results period. */
export function splitChanged(a: readonly RouteRule[], b: readonly RouteRule[]): boolean {
  const sig = (rules: readonly RouteRule[]) =>
    JSON.stringify(rules.map((r) => [r.id, r.enabled, r.devices, r.countries, r.countryMode, r.variants.map((v) => [v.id, v.url, v.weight])]));
  return sig(a) !== sig(b);
}

/** "iPhone & iPad in Czechia or Slovakia", "Everyone": conditions in words. `country` names a code. */
export function describeConditions(rule: Pick<RouteRule, "devices" | "countries" | "countryMode">, country: (code: string) => string = (c) => c): string {
  const who = rule.devices.length ? rule.devices.map((d) => DEVICE_LABEL[d]).join(" or ") : "";
  const list = rule.countries.map((c) => (c === UNKNOWN_COUNTRY ? "an unknown country" : country(c)));
  const joined = list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list.at(-1)}` : (list[0] ?? "");
  const where = rule.countries.length ? (rule.countryMode === "in" ? `in ${joined}` : `outside ${joined}`) : "";
  if (!who && !where) return "Everyone";
  return [who || "Anyone", where].filter(Boolean).join(" ");
}

/** A one-line summary of a whole setup, for history entries. */
export function describeRouting(routing: Pick<Routing, "rules"> | null): string {
  if (!routing || routing.rules.length === 0) return "Off";
  const active = routing.rules.filter((r) => r.enabled);
  const splits = active.filter((r) => r.variants.length > 1).length;
  const parts = [`${active.length} ${active.length === 1 ? "rule" : "rules"}`];
  if (splits) parts.push(`${splits} ${splits === 1 ? "split" : "splits"}`);
  if (active.length < routing.rules.length) parts.push(`${routing.rules.length - active.length} paused`);
  return parts.join(", ");
}

/** A short random id for a new rule or variant. */
export function newRouteId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("").slice(0, 6);
}

/** Parses a stored setup; anything malformed counts as no routing. */
export function parseRouting(json: string | null | undefined): Routing | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Routing;
    return Array.isArray(r?.rules) && r.rules.length ? r : null;
  } catch {
    return null;
  }
}

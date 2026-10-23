// UTM builder: turns the stored template ("utm_source=x&utm_campaign={slug}")
// into fields and back, and previews the final URL. The template stays the
// storage format, so the redirect path is unchanged.

import { buildLocation, renderUtm, validateUtmTemplate } from "./target";

export const UTM_FIELDS = [
  { key: "utm_source", label: "Source", hint: "Where the traffic comes from", example: "linkedin" },
  { key: "utm_medium", label: "Medium", hint: "The kind of channel", example: "social" },
  { key: "utm_campaign", label: "Campaign", hint: "What you're promoting", example: "{slug}" },
  { key: "utm_content", label: "Content", hint: "Which post, ad or A/B side", example: "{variant}" },
  { key: "utm_term", label: "Term", hint: "Paid search keywords", example: "" },
] as const;
export type UtmKey = (typeof UTM_FIELDS)[number]["key"];

export const UTM_PLACEHOLDERS = [
  { token: "{slug}", label: "slug", description: "The short link's slug" },
  { token: "{source}", label: "source", description: "The ?s= tag, qr for QR scans, the app or referrer, or direct" },
  { token: "{domain}", label: "domain", description: "The short domain the link is on" },
  { token: "{variant}", label: "variant", description: "The smart-routing destination's name, or default" },
] as const;

export const MAX_PRESETS = 50;
export const PRESET_NAME_MAX = 40;

export interface UtmParts {
  /** Values as people type them (decoded), by UTM key. */
  fields: Record<UtmKey, string>;
  /** Other parameters, in order. */
  extra: { key: string; value: string }[];
}

const KEY_RE = /^[A-Za-z0-9_.~-]+$/;
const isUtmKey = (k: string): k is UtmKey => UTM_FIELDS.some((f) => f.key === k);

export function emptyParts(): UtmParts {
  return { fields: { utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "" }, extra: [] };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replaceAll("+", " "));
  } catch {
    return s;
  }
}

/** Encodes a value for the template, leaving {placeholders} as they are. */
export function encodeValue(v: string): string {
  return v
    .split(/(\{[a-z]+\})/)
    .map((part) => (/^\{[a-z]+\}$/.test(part) ? part : encodeURIComponent(part)))
    .join("");
}

export function parseTemplate(template: string): UtmParts {
  const parts = emptyParts();
  for (const pair of template.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = safeDecode(eq === -1 ? "" : pair.slice(eq + 1));
    if (isUtmKey(key) && !parts.fields[key]) parts.fields[key] = value;
    else parts.extra.push({ key, value });
  }
  return parts;
}

/** The template for the fields; empty fields and unnamed extras are left out. */
export function buildTemplate(parts: UtmParts): string {
  const pairs: string[] = [];
  for (const f of UTM_FIELDS) {
    const v = parts.fields[f.key].trim();
    if (v) pairs.push(`${f.key}=${encodeValue(v)}`);
  }
  for (const e of parts.extra) {
    const k = e.key.trim();
    if (k) pairs.push(`${k}=${encodeValue(e.value.trim())}`);
  }
  return pairs.join("&");
}

/** Why the fields can't be saved, or null. */
export function partsProblem(parts: UtmParts): string | null {
  const keys = parts.extra.map((e) => e.key.trim()).filter(Boolean);
  const bad = keys.find((k) => !KEY_RE.test(k));
  if (bad) return `"${bad}" isn't a valid parameter name: use letters, digits, _ - . or ~.`;
  const dup = keys.find((k, i) => keys.indexOf(k) !== i || isUtmKey(k));
  if (dup) return `${dup} is set twice.`;
  const t = buildTemplate(parts);
  if (!t) return "Fill in at least one parameter.";
  return validateUtmTemplate(t);
}

export interface UtmPreview {
  url: string;
  /** Template parameters left out because the destination already has them. */
  kept: string[];
}

/**
 * The URL a visitor would land on. `kept` names parameters the destination
 * already sets: its own value wins, the template's is skipped.
 */
export function previewUtm(target: string, template: string, vars: { slug: string; source: string; domain?: string; variant?: string }): UtmPreview {
  const rendered = renderUtm(template, { ...vars, domain: vars.domain ?? "" });
  let existing = new Set<string>();
  try {
    existing = new Set(new URL(target).searchParams.keys());
  } catch {
    existing = new Set();
  }
  const parts = parseTemplate(template);
  const keys = [...UTM_FIELDS.map((f) => f.key).filter((k) => parts.fields[k]), ...parts.extra.map((e) => e.key)];
  const kept = keys.filter((k) => existing.has(k));
  let url = target;
  try {
    url = buildLocation(target, [], rendered);
  } catch {
    url = target;
  }
  return { url, kept };
}

// Target URL validation (write time) and Location building (redirect time).
// Building uses string operations only, so a stored target is returned
// byte-for-byte when nothing needs to be appended.

const MAX_TARGET_LENGTH = 2048;
const MAX_TEMPLATE_LENGTH = 512;

export type TargetResult = { ok: true; url: string } | { ok: false; error: string };

export interface TargetOptions {
  /** Allow http:// (only for links imported from another shortener). */
  allowHttp?: boolean;
  /** Hostnames that must never be targets (the shortener itself). */
  selfHosts?: readonly string[];
}

/** Validates a target and returns its normalized, ASCII-only href. */
export function normalizeTarget(input: string, opts: TargetOptions = {}): TargetResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Target URL is required." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Target is not a valid URL." };
  }
  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    return { ok: false, error: opts.allowHttp ? "Target must be http(s)." : "Target must start with https://." };
  }
  if (url.username || url.password) return { ok: false, error: "Target must not contain credentials." };
  // "sh.example." is the same host as "sh.example": drop the root dot before comparing.
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".")) return { ok: false, error: "Target host looks invalid." };
  if (opts.selfHosts?.some((h) => host === h || host === `www.${h}`)) {
    return { ok: false, error: "Target can't point back at the shortener." };
  }
  const href = url.href;
  if (href.length > MAX_TARGET_LENGTH) return { ok: false, error: "Target is longer than 2048 characters." };
  return { ok: true, url: href };
}

/** Validates a UTM template such as "utm_source={domain}&utm_campaign={slug}". */
export function validateUtmTemplate(template: string): string | null {
  const t = template.trim();
  if (!t) return "Template is empty.";
  if (t.length > MAX_TEMPLATE_LENGTH) return "Template is longer than 512 characters.";
  if (/[\s#?]/.test(t) || !/^[\x21-\x7E]+$/.test(t)) {
    return "Template must be ASCII key=value pairs joined by '&', without '?', '#' or spaces.";
  }
  for (const pair of t.split("&")) {
    const [key, value] = pair.split("=");
    if (!key || value === undefined || pair.split("=").length !== 2) return `"${pair}" is not a key=value pair.`;
  }
  return null;
}

/** Fills the {slug}, {source} and {domain} placeholders. */
export function renderUtm(template: string, vars: { slug: string; source: string; domain: string }): string {
  return template
    .replaceAll("{slug}", encodeURIComponent(vars.slug))
    .replaceAll("{domain}", encodeURIComponent(vars.domain))
    .replaceAll("{source}", encodeURIComponent(vars.source));
}

export interface OwnParams {
  /** Raw value of ?s= (unsanitized), if present. */
  sourceTag: string | null;
  /** True when ?q=1 was present. */
  qr: boolean;
  /** Remaining "k=v" pairs, raw, in their original order and encoding. */
  passthrough: string[];
}

/** Splits a query string into the Worker's own params and everything else. */
export function splitOwnParams(search: string): OwnParams {
  const result: OwnParams = { sourceTag: null, qr: false, passthrough: [] };
  if (search.length <= 1) return result;
  for (const pair of search.slice(1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const key = safeDecode(rawKey);
    if (key === "s") {
      result.sourceTag ??= safeDecode(rawValue);
      continue;
    }
    if (key === "q" && rawValue === "1") {
      result.qr = true;
      continue;
    }
    result.passthrough.push(pair);
  }
  return result;
}

/**
 * Appends params to a target before any fragment. UTM pairs whose key already
 * exists in the target or in the passed-through params are skipped.
 */
export function buildLocation(target: string, passthrough: readonly string[], utm: string | null): string {
  if (passthrough.length === 0 && !utm) return target;

  const hashIndex = target.indexOf("#");
  const base = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : target.slice(hashIndex);
  const queryIndex = base.indexOf("?");

  const existingKeys = new Set<string>();
  const collect = (pairs: Iterable<string>) => {
    for (const pair of pairs) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      existingKeys.add(safeDecode(eq === -1 ? pair : pair.slice(0, eq)));
    }
  };
  if (queryIndex !== -1) collect(base.slice(queryIndex + 1).split("&"));
  collect(passthrough);

  const extra = [...passthrough];
  if (utm) {
    for (const pair of utm.split("&")) {
      const key = safeDecode(pair.slice(0, pair.indexOf("=")));
      if (key && !existingKeys.has(key)) extra.push(pair);
    }
  }
  if (extra.length === 0) return target;

  let joiner = "?";
  if (queryIndex !== -1) joiner = base.endsWith("?") || base.endsWith("&") ? "" : "&";
  return `${base}${joiner}${extra.join("&")}${hash}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replaceAll("+", " "));
  } catch {
    return s;
  }
}

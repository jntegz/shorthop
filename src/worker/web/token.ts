// The short-link click token. A short link whose destination is a tracked
// site gets ?sh_c=<token>; the tracker on that site sends it back with the
// first pageview, so the visit (and any payment it leads to) is credited to
// the link. The token is signed, so nobody can credit a link they didn't use,
// and short-lived. It names the link and where the click came from, nothing
// about the person.

import { fromBase64Url, toBase64Url } from "../../shared/password";

export { CLICK_PARAM } from "../../shared/target";
/** A visit can arrive this long after the click (a tab left open, a saved link). */
export const CLICK_TOKEN_MAX_AGE_SEC = 7 * 86400;
const SIG_BYTES = 8;

let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

function signingKey(secret: string): Promise<CryptoKey> {
  if (cached?.secret === secret) return cached.key;
  const key = (async () => {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("shorthop-click"), info: new TextEncoder().encode("click-token-v1") },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  })();
  cached = { secret, key };
  return key;
}

export interface ClickToken {
  domain: string;
  slug: string;
  /** The source of the click: a ?s= tag, "qr", or inferred ("li", "direct"…). */
  source: string;
  /** Unix seconds of the click. */
  at: number;
  /** The tracked site the link leads to. Tokens from before 2.0.3 have none and are good for any site until they expire. */
  site?: string;
}

export async function signClickToken(secret: string, t: ClickToken): Promise<string> {
  const body = new TextEncoder().encode([t.domain, t.slug, t.source, String(t.at), ...(t.site ? [t.site] : [])].join("\n"));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), body)).slice(0, SIG_BYTES);
  return `${toBase64Url(body)}.${toBase64Url(sig)}`;
}

export interface VerifiedClickToken extends ClickToken {
  /** What the use limit counts by: the signature, in the one spelling verification accepts. */
  id: string;
}

/**
 * The token's contents, or null when it's malformed, forged or too old. Only
 * exactly what signClickToken wrote is accepted: two parts, each in its one
 * base64url spelling. Anything else could be the same token under another name.
 */
export async function verifyClickToken(secret: string, token: string, now: number): Promise<VerifiedClickToken | null> {
  if (token.length > 1200) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [bodyText, sigText] = parts as [string, string];
  const body = fromBase64Url(bodyText);
  const sig = fromBase64Url(sigText);
  if (!body || !sig || sig.length !== SIG_BYTES) return null;
  if (toBase64Url(body) !== bodyText || toBase64Url(sig) !== sigText) return null;
  const full = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), body));
  // Constant-time comparison of the truncated MAC.
  let diff = 0;
  for (let i = 0; i < SIG_BYTES; i++) diff |= full[i]! ^ sig[i]!;
  if (diff !== 0) return null;
  const [domain, slug, source, atText, site] = new TextDecoder().decode(body).split("\n");
  const at = Number(atText);
  if (!domain || !slug || !Number.isFinite(at)) return null;
  if (at > now + 300 || now - at > CLICK_TOKEN_MAX_AGE_SEC) return null;
  return { domain, slug, source: source ?? "", at, ...(site ? { site } : {}), id: sigText };
}

/** Different visitors one token can credit in a window. Reloads and a link passed to a friend or two stay within it. */
const TOKEN_VISITORS = 3;
const TOKEN_WINDOW_SEC = 600;
const TOKEN_MEMORY = 5000;
let tokenUse = new Map<string, { until: number; visitors: Set<string> }>();

/** Tests only. */
export function resetClickTokenUse(): void {
  tokenUse = new Map();
}

/**
 * Whether a valid token may still credit this visitor. A token sits in a URL
 * anyone can copy, so one click can't be turned into any number of credited
 * visits. Counted per Worker isolate: no D1 write per click, and enough to stop
 * a replay from one place, though not one spread over many Cloudflare locations.
 */
export function clickTokenUsable(tokenId: string, visitorId: string, now: number): boolean {
  let use = tokenUse.get(tokenId);
  if (!use || use.until <= now) {
    if (tokenUse.size >= TOKEN_MEMORY) tokenUse = new Map();
    use = { until: now + TOKEN_WINDOW_SEC, visitors: new Set() };
    tokenUse.set(tokenId, use);
  }
  if (use.visitors.has(visitorId)) return true;
  if (use.visitors.size >= TOKEN_VISITORS) return false;
  use.visitors.add(visitorId);
  return true;
}

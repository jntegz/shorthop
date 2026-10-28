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
}

export async function signClickToken(secret: string, t: ClickToken): Promise<string> {
  const body = new TextEncoder().encode([t.domain, t.slug, t.source, String(t.at)].join("\n"));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), body)).slice(0, SIG_BYTES);
  return `${toBase64Url(body)}.${toBase64Url(sig)}`;
}

/** The token's contents, or null when it's malformed, forged or too old. */
export async function verifyClickToken(secret: string, token: string, now: number): Promise<ClickToken | null> {
  if (token.length > 1200) return null;
  const [bodyText, sigText] = token.split(".");
  const body = fromBase64Url(bodyText ?? "");
  const sig = fromBase64Url(sigText ?? "");
  if (!body || !sig || sig.length !== SIG_BYTES) return null;
  const full = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), body));
  // Constant-time comparison of the truncated MAC.
  let diff = 0;
  for (let i = 0; i < SIG_BYTES; i++) diff |= full[i]! ^ sig[i]!;
  if (diff !== 0) return null;
  const [domain, slug, source, atText] = new TextDecoder().decode(body).split("\n");
  const at = Number(atText);
  if (!domain || !slug || !Number.isFinite(at)) return null;
  if (at > now + 300 || now - at > CLICK_TOKEN_MAX_AGE_SEC) return null;
  return { domain, slug, source: source ?? "", at };
}

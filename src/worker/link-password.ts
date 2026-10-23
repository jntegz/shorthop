// Password-protected links: hashing (PBKDF2, like the admin login but lighter),
// the signed cookie that remembers a correct password for one link, and the
// password form's POST.

import { derivePassword, hashPassword, parsePasswordHash, toBase64Url } from "../shared/password";
import { LINK_ACCESS_HOURS, LINK_PASSWORD_ITERATIONS, LINK_PASSWORD_MAX } from "../shared/protection";
import { ipBucket } from "./session";

const COOKIE = "sh_access";

export function hashLinkPassword(password: string): Promise<string> {
  return hashPassword(password, LINK_PASSWORD_ITERATIONS);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function checkLinkPassword(password: string, stored: string): Promise<boolean> {
  const h = parsePasswordHash(stored);
  if (!h || password.length > LINK_PASSWORD_MAX) return false;
  return equal(await derivePassword(password, h.salt, h.iterations), h.hash);
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

/**
 * The access cookie's signature covers the link and the stored hash, so
 * changing the password (or SESSION_SECRET) ends every remembered access.
 */
function signed(env: Env, domain: string, slug: string, hash: string, exp: number): Promise<string> {
  return hmac(env.SESSION_SECRET, `link-access|${domain}/${slug}|${hash}|${exp}`);
}

/** Cookie path: this link only ("/guide" doesn't match "/guide2"). */
const cookiePath = (slug: string) => `/${encodeURIComponent(slug)}`;

export async function accessCookie(env: Env, domain: string, slug: string, hash: string, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + LINK_ACCESS_HOURS * 3600;
  const value = `${exp}.${await signed(env, domain, slug, hash, exp)}`;
  return `${COOKIE}=${value}; Path=${cookiePath(slug)}; Max-Age=${LINK_ACCESS_HOURS * 3600}; HttpOnly; Secure; SameSite=Lax`;
}

export async function hasAccess(request: Request, env: Env, domain: string, slug: string, hash: string): Promise<boolean> {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    if (!part.startsWith(`${COOKIE}=`)) continue;
    const [expText, sig] = part.slice(COOKIE.length + 1).split(".");
    const exp = Number(expText);
    if (!sig || !Number.isInteger(exp) || exp * 1000 < Date.now()) continue;
    const expected = await signed(env, domain, slug, hash, exp);
    if (equal(new TextEncoder().encode(sig), new TextEncoder().encode(expected))) return true;
  }
  return false;
}

export type PasswordAttempt = { ok: true; cookie: string } | { ok: false; reason: "wrong" | "limited" | "bad_request" };

/** Handles the password form: rate limit, size limit, then the check. */
export async function tryPassword(request: Request, env: Env, domain: string, slug: string, hash: string): Promise<PasswordAttempt> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) {
    try {
      const { success } = await env.LINK_PASSWORD_LIMITER.limit({ key: `pw:${ipBucket(ip)}:${domain}/${slug}` });
      if (!success) return { ok: false, reason: "limited" };
    } catch (err) {
      console.error(JSON.stringify({ message: "link password limiter failed", error: String(err) }));
    }
  }
  if (Number(request.headers.get("Content-Length") ?? 0) > 4096) return { ok: false, reason: "bad_request" };
  let password = "";
  try {
    const form = await request.formData();
    password = String(form.get("password") ?? "");
  } catch {
    return { ok: false, reason: "bad_request" };
  }
  if (!password || !(await checkLinkPassword(password, hash))) return { ok: false, reason: "wrong" };
  return { ok: true, cookie: await accessCookie(env, domain, slug, hash) };
}

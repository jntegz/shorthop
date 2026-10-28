// Password-protected links: hashing (PBKDF2, like the admin login but lighter),
// the signed cookie that remembers a correct password for one link, and the
// password form's POST.

import { derivePassword, hashPassword, parsePasswordHash, toBase64Url } from "../shared/password";
import { LINK_ACCESS_HOURS, LINK_PASSWORD_ITERATIONS, LINK_PASSWORD_LOCK_MAX_SEC, LINK_PASSWORD_MAX, LINK_PASSWORD_MAX_FAILS, LINK_PASSWORD_WINDOW_SEC } from "../shared/protection";
import { readCapped } from "./body";
import { nowSec } from "./db";
import { chargeAttempt, clearFailuresStmt, ipBucket, lock } from "./session";

const COOKIE = "sh_access";

export function hashLinkPassword(env: Pick<Env, "WORKERS_PLAN">, password: string): Promise<string> {
  return hashPassword(password, LINK_PASSWORD_ITERATIONS[env.WORKERS_PLAN === "paid" ? "paid" : "free"]);
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
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

export async function hmac(secret: string, message: string): Promise<string> {
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
  const attempt = await checkPasswordForm(request, env, { limitKey: `${domain}/${slug}`, lockKey: `link:${domain}/${slug}`, hash });
  return attempt.ok ? { ok: true, cookie: await accessCookie(env, domain, slug, hash) } : attempt;
}

/**
 * A password form's POST for anything protected by a link-style password:
 * the per-network limiter keyed by `limitKey`, the D1 lock counted across all
 * networks under `lockKey`, then the check.
 */
export async function checkPasswordForm(
  request: Request,
  env: Env,
  { limitKey, lockKey, hash }: { limitKey: string; lockKey: string; hash: string },
): Promise<{ ok: true } | { ok: false; reason: "wrong" | "limited" | "bad_request" }> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) {
    try {
      const { success } = await env.LINK_PASSWORD_LIMITER.limit({ key: `pw:${ipBucket(ip)}:${limitKey}` });
      if (!success) return { ok: false, reason: "limited" };
    } catch (err) {
      console.error(JSON.stringify({ message: "link password limiter failed", error: String(err) }));
    }
  }
  const raw = await readCapped(request, 4096).catch(() => null);
  if (!raw) return { ok: false, reason: "bad_request" };
  let password = "";
  try {
    const form = await new Request(request.url, { method: "POST", headers: request.headers, body: raw }).formData();
    password = String(form.get("password") ?? "");
  } catch {
    return { ok: false, reason: "bad_request" };
  }
  if (!password) return { ok: false, reason: "wrong" };

  // Counted per link across every network before the check (D1 is strongly
  // consistent), so many addresses guessing in parallel still hit the lock.
  const key = lockKey;
  const now = nowSec();
  let state;
  try {
    state = await chargeAttempt(env.DB, key, now, LINK_PASSWORD_WINDOW_SEC);
    if (state.lockedUntil > now) return { ok: false, reason: "limited" };
    if (state.fails > LINK_PASSWORD_MAX_FAILS) {
      await lock(env.DB, key, now, state.lockouts, LINK_PASSWORD_LOCK_MAX_SEC);
      return { ok: false, reason: "limited" };
    }
  } catch (err) {
    console.error(JSON.stringify({ message: "link password counter failed", key, error: String(err) }));
    return { ok: false, reason: "bad_request" };
  }

  if (!(await checkLinkPassword(password, hash))) {
    if (state.fails >= LINK_PASSWORD_MAX_FAILS) await lock(env.DB, key, now, state.lockouts, LINK_PASSWORD_LOCK_MAX_SEC).catch(() => undefined);
    return { ok: false, reason: "wrong" };
  }
  await clearFailuresStmt(env.DB, key)
    .run()
    .catch(() => undefined);
  return { ok: true };
}

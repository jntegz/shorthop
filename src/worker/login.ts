// /_admin/login and /_admin/logout: the password step (behind Cloudflare Access
// unless ADMIN_AUTH is "password").
// Server-rendered forms without JavaScript, so they work under the strictest CSP.

import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { LOCK_BASE_SEC, MAX_FAILS } from "../shared/login-policy";
import { adminAuthMode, isDevBypass, verifyIdentity } from "./auth";
import { readCapped } from "./body";
import { nowSec } from "./db";
import { isLocalHost } from "./domains";
import type { AppEnv } from "./hono";
import { bouncePage, forbiddenPage, loginPage } from "./pages";
import {
  chargeAttempt,
  clearFailuresStmt,
  clearSessionCookie,
  globalLockedUntil,
  ipHash,
  issueSessionCookie,
  lock,
  loginConfig,
  loginEventStmt,
  readSession,
  recordGlobalFailure,
  revokeSession,
  verifyPassword,
} from "./session";

const MAX_BODY_BYTES = 4096;
const DEFAULT_NEXT = "/_admin/";

/** Only same-origin admin pages are valid targets after login. */
export function safeNext(raw: string | null | undefined, origin: string): string {
  if (!raw) return DEFAULT_NEXT;
  try {
    const u = new URL(raw, origin);
    const p = u.pathname;
    if (u.origin !== origin || !(p === "/_admin" || p.startsWith("/_admin/"))) return DEFAULT_NEXT;
    if (/^\/_admin\/(login|logout|api)(\/|$)/.test(p)) return DEFAULT_NEXT;
    return `${p}${u.search}${u.hash}`;
  } catch {
    return DEFAULT_NEXT;
  }
}

function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...headers } });
}

/** 45 → "45 seconds", 60 → "1 minute", 86400 → "24 hours". */
function waitText(sec: number): string {
  const s = Math.max(1, Math.ceil(sec));
  const [n, unit] = s < 60 ? [s, "second"] : s < 5400 ? [Math.ceil(s / 60), "minute"] : [Math.ceil(s / 3600), "hour"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export const loginApp = new Hono<AppEnv>();

// Cross-site form posts are rejected before anything is counted.
loginApp.use("*", csrf());

loginApp.get("/_admin/login", async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const access = await verifyIdentity(req, c.env);
  if (!access.ok) return forbiddenPage(access.reason);
  const next = safeNext(c.req.query("next"), url.origin);
  const cfg = loginConfig(c.env);
  if (!cfg) {
    // Local development without a password: the admin is open on localhost only.
    if (isDevBypass(req, c.env)) return seeOther(next);
    return forbiddenPage("Admin password is not configured.");
  }
  if (await readSession(req, c.env.DB, cfg, access.identity, nowSec())) return seeOther(next);
  if (c.req.header("Sec-Fetch-Site") === "cross-site" && c.req.query("b") !== "1") {
    url.searchParams.set("b", "1");
    return bouncePage(`${url.pathname}${url.search}`);
  }
  return loginPage({ next, email: access.identity, passwordOnly: adminAuthMode(c.env) === "password", status: 200 });
});

loginApp.post("/_admin/login", async (c) => {
  const req = c.req.raw;
  const env = c.env;
  const url = new URL(req.url);
  const access = await verifyIdentity(req, env);
  if (!access.ok) return forbiddenPage(access.reason);
  const cfg = loginConfig(env);
  if (!cfg) return forbiddenPage("Admin password is not configured.");

  if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header("Content-Type") ?? "")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (!raw) return new Response("Payload Too Large", { status: 413 });
  const body = new TextDecoder().decode(raw);
  const form = new URLSearchParams(body);
  const next = safeNext(form.get("next"), url.origin);
  const password = form.get("password") ?? "";

  const now = nowSec();
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  const country = String(cf?.country ?? "");
  const key = await ipHash(cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
  const render = (status: number, error: string, retryAfter?: number) =>
    loginPage({ next, email: access.identity, passwordOnly: adminAuthMode(env) === "password", error, status, retryAfter });

  // Burst brake per Cloudflare location. Best effort: the D1 lockout below is what counts.
  try {
    const { success } = await env.LOGIN_LIMITER.limit({ key });
    if (!success) return render(429, "Too many attempts. Wait a minute, then try again.", 60);
  } catch (err) {
    console.error(JSON.stringify({ message: "login rate limiter failed", error: String(err) }));
  }

  const globalUntil = await globalLockedUntil(env.DB, now);
  if (globalUntil) return render(429, `Logins are paused after many failed attempts. Try again in ${waitText(globalUntil - now)}.`, globalUntil - now);

  const state = await chargeAttempt(env.DB, key, now);
  if (state.lockedUntil > now) {
    return render(429, `Too many wrong passwords. Try again in ${waitText(state.lockedUntil - now)}.`, state.lockedUntil - now);
  }
  // Only reachable by parallel requests that were all counted before a lock was written.
  if (state.fails > MAX_FAILS) {
    const until = await lock(env.DB, key, now, state.lockouts);
    return render(429, `Too many wrong passwords. Try again in ${waitText(until - now)}.`, until - now);
  }

  if (await verifyPassword(password, cfg)) {
    const [{ cookie }] = await Promise.all([
      issueSessionCookie(env.DB, cfg, access.identity, now),
      env.DB.batch([clearFailuresStmt(env.DB, key), loginEventStmt(env.DB, true, key, country, now)]),
    ]);
    console.log(JSON.stringify({ message: "admin login", email: access.identity, ipHash: key, country }));
    return seeOther(next, { "Set-Cookie": cookie });
  }

  // The event first: the global brake counts the networks failures came from.
  await loginEventStmt(env.DB, false, key, country, now).run();
  await recordGlobalFailure(env.DB, now);
  console.warn(
    JSON.stringify({
      message: "admin login failed",
      email: access.identity,
      ipHash: key,
      country,
      asn: cf?.asn ?? null,
      colo: cf?.colo ?? null,
      ua: (c.req.header("User-Agent") ?? "").slice(0, 200),
      fails: state.fails,
    }),
  );
  if (state.fails >= MAX_FAILS) {
    const until = await lock(env.DB, key, now, state.lockouts);
    return render(429, `Too many wrong passwords. Try again in ${waitText(until - now)}.`, until - now);
  }
  const left = MAX_FAILS - state.fails;
  return render(401, `Wrong password. ${left} ${left === 1 ? "attempt" : "attempts"} left before a ${waitText(LOCK_BASE_SEC * 2 ** state.lockouts)} lock.`);
});

loginApp.post("/_admin/logout", async (c) => {
  // Ends this session on the server too, so a copy of the cookie stops working.
  // Only a valid session can be revoked: a stranger's POST changes nothing.
  const cfg = loginConfig(c.env);
  const access = await verifyIdentity(c.req.raw, c.env);
  if (cfg && access.ok) {
    const session = await readSession(c.req.raw, c.env.DB, cfg, access.identity, nowSec());
    if (session) await revokeSession(c.env.DB, session);
  }
  // Ends the Access session too, except where Access isn't in front (local dev hosts, password-only mode).
  const host = new URL(c.req.url).hostname;
  const viaAccess = !isLocalHost(host) && adminAuthMode(c.env) !== "password";
  return seeOther(viaAccess ? "/cdn-cgi/access/logout" : "/_admin/login", { "Set-Cookie": clearSessionCookie() });
});

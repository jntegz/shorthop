// /_admin/login, /_admin/logout and /_admin/invite/<token>: the password step
// (behind Cloudflare Access unless ADMIN_AUTH is "password"). Server-rendered
// forms without JavaScript, so they work under the strictest CSP. Owners
// (ADMIN_EMAIL, or everyone without Access) use ADMIN_PASSWORD_HASH; everyone
// else chooses their own password from an invite link.

import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { LOCK_BASE_SEC, MAX_FAILS } from "../shared/login-policy";
import { hashPassword, MAX_PASSWORD_LENGTH, parsePasswordHash } from "../shared/password";
import { adminAuthMode, NOT_ALLOWED, verifyIdentity, verifySession } from "./auth";
import { readCapped } from "./body";
import { nowSec } from "./db";
import { isLocalHost } from "./domains";
import type { AppEnv } from "./hono";
import { bouncePage, forbiddenPage, invitePage, loginPage, noticePage } from "./pages";
import {
  chargeAttempt,
  clearFailuresStmt,
  clearSessionCookie,
  getEpoch,
  globalLockedUntil,
  ipHash,
  issueSessionCookie,
  lock,
  loginConfig,
  loginEventStmt,
  parseSessionCookie,
  recordGlobalFailure,
  revokeSession,
  verifyPassword,
  verifyPasswordHash,
} from "./session";
import { getUser, INVITE_TOKEN_RE, isPaused, MIN_USER_PASSWORD, OWNER_EPOCH, pausedReason, sha256Hex, type UserRow } from "./users";

const MAX_BODY_BYTES = 4096;
const DEFAULT_NEXT = "/_admin/";

/** Only same-origin admin pages are valid targets after login. */
export function safeNext(raw: string | null | undefined, origin: string): string {
  if (!raw) return DEFAULT_NEXT;
  try {
    const u = new URL(raw, origin);
    const p = u.pathname;
    if (u.origin !== origin || !(p === "/_admin" || p.startsWith("/_admin/"))) return DEFAULT_NEXT;
    if (/^\/_admin\/(login|logout|api|invite)(\/|$)/.test(p)) return DEFAULT_NEXT;
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

/** The posted form, or the response refusing it. */
async function readForm(c: Context<AppEnv>): Promise<URLSearchParams | Response> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header("Content-Type") ?? "")) {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  const raw = await readCapped(c.req.raw, MAX_BODY_BYTES);
  if (!raw) return new Response("Payload Too Large", { status: 413 });
  return new URLSearchParams(new TextDecoder().decode(raw));
}

const choosePasswordFirst = () =>
  noticePage("Choose a password", "Choose your password first", "Open the invite link you were sent to choose a password. If it has expired, ask an admin or manager for a new one.", 403);

const pausedNotice = (user: Pick<UserRow, "paused_until">) => noticePage("Access paused", "Your access is paused", pausedReason(user), 403);

const inviteInvalid = () =>
  noticePage("Invite link", "This invite link doesn't work", "It has expired, was already used, or belongs to a different account. Ask an admin or manager for a new one.", 410);

/** The invited person, if this token is theirs and still valid. */
async function findInvite(db: D1Database, email: string, token: string, now: number): Promise<UserRow | null> {
  if (!INVITE_TOKEN_RE.test(token)) return null;
  return db
    .prepare("SELECT * FROM users WHERE email = ? AND invite_hash = ? AND invite_expires > ?")
    .bind(email, await sha256Hex(token), now)
    .first<UserRow>();
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
  const session = await verifySession(req, c.env, access);
  if (session.ok) return seeOther(next);
  if (session.code === "paused") return noticePage("Access paused", "Your access is paused", session.reason, 403);
  if (session.code !== "login_required") return forbiddenPage(session.reason);
  if (!access.owner && !(await getUser(c.env.DB, access.email))?.password_hash) return choosePasswordFirst();
  if (c.req.header("Sec-Fetch-Site") === "cross-site" && c.req.query("b") !== "1") {
    url.searchParams.set("b", "1");
    return bouncePage(`${url.pathname}${url.search}`);
  }
  return loginPage({ next, email: access.email, passwordOnly: adminAuthMode(c.env) === "password", status: 200 });
});

loginApp.post("/_admin/login", async (c) => {
  const req = c.req.raw;
  const env = c.env;
  const url = new URL(req.url);
  const access = await verifyIdentity(req, env);
  if (!access.ok) return forbiddenPage(access.reason);
  const cfg = loginConfig(env);
  if (!cfg) return forbiddenPage("Admin password is not configured.");
  const user = access.owner ? null : await getUser(env.DB, access.email);
  if (!access.owner && !user) return forbiddenPage(NOT_ALLOWED.reason);

  const form = await readForm(c);
  if (form instanceof Response) return form;
  const next = safeNext(form.get("next"), url.origin);
  const password = form.get("password") ?? "";
  // Nothing to guess yet, or nothing to win: not counted.
  if (user && isPaused(user, nowSec())) return pausedNotice(user);
  if (user && !user.password_hash) return choosePasswordFirst();

  const now = nowSec();
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  const country = String(cf?.country ?? "");
  const key = await ipHash(cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
  const render = (status: number, error: string, retryAfter?: number) =>
    loginPage({ next, email: access.email, passwordOnly: adminAuthMode(env) === "password", error, status, retryAfter });

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

  const stored = user ? parsePasswordHash(user.password_hash ?? "") : null;
  const ok = user ? stored !== null && (await verifyPasswordHash(password, stored)) : await verifyPassword(password, cfg);
  if (ok) {
    const [{ cookie }] = await Promise.all([
      getEpoch(env.DB).then((global) => issueSessionCookie(cfg, access.email, { global, user: user ? user.session_epoch : OWNER_EPOCH }, now)),
      env.DB.batch([
        clearFailuresStmt(env.DB, key),
        loginEventStmt(env.DB, true, key, country, now, access.email),
        ...(user ? [env.DB.prepare("UPDATE users SET last_login_at = ? WHERE email = ?").bind(now, user.email)] : []),
      ]),
    ]);
    console.log(JSON.stringify({ message: "admin login", email: access.email, ipHash: key, country }));
    return seeOther(next, { "Set-Cookie": cookie });
  }

  // The event first: the global brake counts the networks failures came from.
  await loginEventStmt(env.DB, false, key, country, now, access.email).run();
  await recordGlobalFailure(env.DB, now);
  console.warn(
    JSON.stringify({
      message: "admin login failed",
      email: access.email,
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

// Invite links: only the invited Access identity can use one, once, before it
// expires. Opening the page doesn't use it up, so link scanners can't.
loginApp.get("/_admin/invite/:token", async (c) => {
  const access = await verifyIdentity(c.req.raw, c.env);
  if (!access.ok) return forbiddenPage(access.reason);
  if (access.owner) return forbiddenPage("Invite links are for other people. Owners sign in with the admin password.");
  if (!loginConfig(c.env)) return forbiddenPage("Admin password is not configured.");
  const now = nowSec();
  const user = await findInvite(c.env.DB, access.email, c.req.param("token"), now);
  if (!user) return inviteInvalid();
  if (isPaused(user, now)) return pausedNotice(user);
  return invitePage({ action: new URL(c.req.url).pathname, email: access.email, minLength: MIN_USER_PASSWORD, status: 200 });
});

loginApp.post("/_admin/invite/:token", async (c) => {
  const env = c.env;
  const access = await verifyIdentity(c.req.raw, env);
  if (!access.ok) return forbiddenPage(access.reason);
  if (access.owner) return forbiddenPage("Invite links are for other people. Owners sign in with the admin password.");
  const cfg = loginConfig(env);
  if (!cfg) return forbiddenPage("Admin password is not configured.");
  const form = await readForm(c);
  if (form instanceof Response) return form;

  const key = await ipHash(cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
  try {
    const { success } = await env.LOGIN_LIMITER.limit({ key });
    if (!success) return new Response("Too many attempts. Wait a minute, then try again.", { status: 429, headers: { "Retry-After": "60" } });
  } catch (err) {
    console.error(JSON.stringify({ message: "login rate limiter failed", error: String(err) }));
  }

  const token = c.req.param("token");
  const now = nowSec();
  // A cheap check before hashing the password.
  const user = await findInvite(env.DB, access.email, token, now);
  if (!user) return inviteInvalid();
  if (isPaused(user, now)) return pausedNotice(user);
  const action = new URL(c.req.url).pathname;
  const password = form.get("password") ?? "";
  const retry = (error: string) => invitePage({ action, email: access.email, minLength: MIN_USER_PASSWORD, error, status: 400 });
  if (password.length < MIN_USER_PASSWORD) return retry(`Use at least ${MIN_USER_PASSWORD} characters.`);
  if (password.length > MAX_PASSWORD_LENGTH) return retry("That password is too long.");
  if (password !== (form.get("confirm") ?? "")) return retry("The two passwords don't match.");

  // Atomic: of two posts at once, only one uses the invite.
  const epoch = crypto.randomUUID();
  const saved = await env.DB.prepare(
    `UPDATE users SET password_hash = ?1, session_epoch = ?2, invite_hash = NULL, invite_expires = NULL, updated_at = ?3, last_login_at = ?3
     WHERE email = ?4 AND invite_hash = ?5 AND invite_expires > ?3 RETURNING email`,
  )
    .bind(await hashPassword(password), epoch, now, access.email, await sha256Hex(token))
    .first<{ email: string }>();
  if (!saved) return inviteInvalid();

  const cf = c.req.raw.cf as IncomingRequestCfProperties | undefined;
  const [{ cookie }] = await Promise.all([
    getEpoch(env.DB).then((global) => issueSessionCookie(cfg, access.email, { global, user: epoch }, now)),
    loginEventStmt(env.DB, true, key, String(cf?.country ?? ""), now, access.email).run(),
  ]);
  console.log(JSON.stringify({ message: "invite accepted", email: access.email }));
  return seeOther(DEFAULT_NEXT, { "Set-Cookie": cookie });
});

loginApp.post("/_admin/logout", async (c) => {
  // Ends this session on the server too, so a copy of the cookie stops working.
  // Only a validly signed session can be revoked: a stranger's POST changes nothing.
  const cfg = loginConfig(c.env);
  const access = await verifyIdentity(c.req.raw, c.env);
  if (cfg && access.ok) {
    const session = await parseSessionCookie(c.req.raw, cfg, access.email, nowSec());
    if (session) await revokeSession(c.env.DB, session);
  }
  // Ends the Access session too, except where Access isn't in front (local dev hosts, password-only mode).
  const host = new URL(c.req.url).hostname;
  const viaAccess = !isLocalHost(host) && adminAuthMode(c.env) !== "password";
  return seeOther(viaAccess ? "/cdn-cgi/access/logout" : "/_admin/login", { "Set-Cookie": clearSessionCookie() });
});

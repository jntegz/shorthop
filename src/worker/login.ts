// /_admin/login, /_admin/logout, /_admin/forgot, /_admin/invite/<token> and
// /_admin/reset/<token>: the password step (behind Cloudflare Access unless
// ADMIN_AUTH is "password"). Server-rendered forms without JavaScript, so they
// work under the strictest CSP (the optional Turnstile bot check adds only its
// own script). Owners (ADMIN_EMAIL, or everyone without Access) use the admin
// password; everyone else chooses their own password from an invite link, and
// can get a reset link by email.

import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { escapeHtml } from "../shared/html";
import {
  LOCK_BASE_SEC,
  MAX_FAILS,
  RESET_COOLDOWN_SEC,
  RESET_MAX_GLOBAL_HOUR,
  RESET_MAX_PER_DAY,
  RESET_MAX_PER_NETWORK_HOUR,
  RESET_TTL_SEC,
} from "../shared/login-policy";
import { hashPassword, MAX_PASSWORD_LENGTH, parsePasswordHash } from "../shared/password";
import { adminAuthMode, NOT_ALLOWED, verifyAdmin, verifyIdentity, verifySession } from "./auth";
import { readCapped } from "./body";
import { nowSec } from "./db";
import { isLocalHost } from "./domains";
import type { AppEnv } from "./hono";
import { mailerStatus, peopleMailStatus, sendMail, sendPersonMail, withMailSettings } from "./mailer";
import { botCheckPage, bouncePage, choosePasswordPage, forbiddenPage, forgotPage, loginPage, noticePage, type TurnstileWidget } from "./pages";
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
import { activeTurnstile, saveTurnstileStmt, TURNSTILE_FIELD, turnstileSecret, turnstileSettings, verifyTurnstile } from "./turnstile";
import { getUser, INVITE_TOKEN_RE, isPaused, MIN_USER_PASSWORD, OWNER_EPOCH, pausedReason, randomToken, sha256Hex, type UserRow } from "./users";

const MAX_BODY_BYTES = 4096;
const DEFAULT_NEXT = "/_admin/";

/** Only same-origin admin pages are valid targets after login. */
export function safeNext(raw: string | null | undefined, origin: string): string {
  if (!raw) return DEFAULT_NEXT;
  try {
    const u = new URL(raw, origin);
    const p = u.pathname;
    if (u.origin !== origin || !(p === "/_admin" || p.startsWith("/_admin/"))) return DEFAULT_NEXT;
    if (/^\/_admin\/(login|logout|api|invite|forgot|reset)(\/|$)/.test(p)) return DEFAULT_NEXT;
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

/** Burst brake per Cloudflare location. Best effort: the D1 counters are what count. */
async function burstAllowed(env: Env, key: string): Promise<boolean> {
  try {
    return (await env.LOGIN_LIMITER.limit({ key })).success;
  } catch (err) {
    console.error(JSON.stringify({ message: "login rate limiter failed", error: String(err) }));
    return true;
  }
}

/** The optional bot check: the widget to show, and whether the posted form passed it. */
async function botCheck(c: Context<AppEnv>, form: URLSearchParams): Promise<{ widget: TurnstileWidget; error: string | null }> {
  const widget = await activeTurnstile(c.env);
  if (!widget) return { widget, error: null };
  const result = await verifyTurnstile(c.env, form.get(TURNSTILE_FIELD) ?? "", c.req.header("CF-Connecting-IP"));
  return { widget, error: result.ok ? null : result.reason };
}

/** Runs after the response when the runtime allows it (not in some tests). */
function afterResponse(c: Context<AppEnv>, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work;
  }
}

const choosePasswordFirst = () =>
  noticePage("Choose a password", "Choose your password first", "Open the invite link you were sent to choose a password. If it has expired, ask an admin or manager for a new one.", 403);

const pausedNotice = (user: Pick<UserRow, "paused_until">) => noticePage("Access paused", "Your access is paused", pausedReason(user), 403);

const ownerReset = () =>
  noticePage(
    "Forgot password",
    "Owners reset it with a secret",
    "The owners' password is a Worker secret. Run npm run setup -- password, or put a new one in the ADMIN_PASSWORD secret under your Worker's Settings → Variables and Secrets (Deploy to Cloudflare installs).",
    200,
  );

// --- One-time links: invites and password resets ------------------------------

type LinkKind = "invite" | "reset";

const LINK_TEXT: Record<LinkKind, { invalid: () => Response; owners: string }> = {
  invite: {
    invalid: () =>
      noticePage("Invite link", "This invite link doesn't work", "It has expired, was already used, or belongs to a different account. Ask an admin or manager for a new one.", 410),
    owners: "Invite links are for other people. Owners sign in with the admin password.",
  },
  reset: {
    invalid: () =>
      noticePage(
        "Reset link",
        "This reset link doesn't work",
        "It has expired, was already used, or belongs to a different account. Ask for a new one under “Forgot your password?” on the login page.",
        410,
      ),
    owners: "Owners reset their password with npm run setup -- password, or the ADMIN_PASSWORD secret.",
  },
};

/** The person this one-time link belongs to, if it's theirs and still valid. */
async function findLink(db: D1Database, kind: LinkKind, email: string, token: string, now: number): Promise<UserRow | null> {
  if (!INVITE_TOKEN_RE.test(token)) return null;
  const sql =
    kind === "invite"
      ? "SELECT * FROM users WHERE email = ? AND invite_hash = ? AND invite_expires > ?"
      : "SELECT * FROM users WHERE email = ? AND reset_hash = ? AND reset_expires > ?";
  return db.prepare(sql).bind(email, await sha256Hex(token), now).first<UserRow>();
}

// Wrong links count per network like wrong passwords: MAX_FAILS within the
// window lock that network out of these pages, doubling each time.
const tokenKey = (key: string) => `token:${key}`;

async function tokenLockedUntil(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db.prepare("SELECT locked_until FROM auth_failures WHERE key = ?").bind(tokenKey(key)).first<{ locked_until: number }>();
  return row && row.locked_until > now ? row.locked_until : 0;
}

async function chargeBadLink(db: D1Database, key: string, now: number): Promise<void> {
  const state = await chargeAttempt(db, tokenKey(key), now);
  if (state.lockedUntil <= now && state.fails >= MAX_FAILS) await lock(db, tokenKey(key), now, state.lockouts);
}

const tooManyLinks = (wait: number) =>
  noticePage("Too many tries", "Too many links that don't work", `Wait ${waitText(wait)}, then open the link from your email or invite again.`, 429);

// --- Forgot password ------------------------------------------------------------

/** email: a reset link goes to them; admin: email only reaches DIGEST_TO, so an admin is told; none: no email at all. */
function forgotMode(mailEnv: Env): "email" | "admin" | "none" {
  if (!peopleMailStatus(mailEnv).problem) return "email";
  return mailerStatus(mailEnv).problem ? "none" : "admin";
}

/**
 * Charges one reset request to the network, the person (one per cooldown, a
 * few a day) and everyone together. The first limit reached says when to try
 * again; checks after it aren't charged.
 */
async function resetAllowance(db: D1Database, email: string, key: string, now: number): Promise<{ error: string; retryAfter: number } | null> {
  const limits = [
    { key: `reset-ip:${key}`, window: 3600, max: RESET_MAX_PER_NETWORK_HOUR, error: "Too many reset requests from this network." },
    { key: `reset:${email}`, window: RESET_COOLDOWN_SEC, max: 1, error: `You asked less than ${waitText(RESET_COOLDOWN_SEC)} ago.` },
    { key: `reset-day:${email}`, window: 86400, max: RESET_MAX_PER_DAY, error: `That's ${RESET_MAX_PER_DAY} reset requests today.` },
    { key: "reset:*", window: 3600, max: RESET_MAX_GLOBAL_HOUR, error: "Too many password resets right now." },
  ];
  for (const l of limits) {
    const state = await chargeAttempt(db, l.key, now, l.window);
    if (state.fails > l.max) {
      const wait = state.windowStart + l.window - now;
      return { error: `${l.error} Try again in ${waitText(wait)}.`, retryAfter: wait };
    }
  }
  return null;
}

function resetEmail(email: string, url: string) {
  const ttl = waitText(RESET_TTL_SEC);
  return {
    subject: "Choose a new Shorthop password",
    text: `Someone signed in to Cloudflare Access as ${email} asked to reset their Shorthop password.\n\nChoose a new one here. The link works once, for ${ttl}:\n${url}\n\nIf that wasn't you, ignore this email: your password stays as it is. Do tell an admin.`,
    html: `<p>Someone signed in to Cloudflare Access as <strong>${escapeHtml(email)}</strong> asked to reset their Shorthop password.</p>
<p><a href="${escapeHtml(url)}">Choose a new password</a>. The link works once, for ${ttl}.</p>
<p>If that wasn't you, ignore this email: your password stays as it is. Do tell an admin.</p>`,
  };
}

function adminResetNote(user: UserRow) {
  const who = user.name ? `${user.name} (${user.email})` : user.email;
  const steps = "Settings → Access & security → People → their ⋯ menu → Reset password, then send them the new link.";
  return {
    subject: `${user.name || user.email} asked for a new Shorthop password`,
    text: `${who} can't sign in to Shorthop and asked for a password reset. Email can't reach them from Shorthop, so: ${steps}\n\nIf you don't expect this, ignore it: nothing has changed.`,
    html: `<p><strong>${escapeHtml(who)}</strong> can't sign in to Shorthop and asked for a password reset. Email can't reach them from Shorthop, so: ${escapeHtml(steps)}</p>
<p>If you don't expect this, ignore it: nothing has changed.</p>`,
  };
}

function passwordChangedEmail(email: string) {
  const text = `The Shorthop password for ${email} was changed just now with a reset link, and its other sessions ended. If that wasn't you, tell an admin right away.`;
  return { subject: "Your Shorthop password was changed", text, html: `<p>${escapeHtml(text)}</p>` };
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
  return loginPage({ next, email: access.email, passwordOnly: adminAuthMode(c.env) === "password", status: 200, turnstile: await activeTurnstile(c.env) });
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
  let turnstile: TurnstileWidget = null;
  const render = (status: number, error: string, retryAfter?: number) =>
    loginPage({ next, email: access.email, passwordOnly: adminAuthMode(env) === "password", error, status, retryAfter, turnstile });

  if (!(await burstAllowed(env, key))) return render(429, "Too many attempts. Wait a minute, then try again.", 60);
  // A failed bot check isn't a password guess: not counted.
  const bot = await botCheck(c, form);
  turnstile = bot.widget;
  if (bot.error) return render(400, bot.error);

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

// "Forgot your password?": only after Cloudflare Access, so the address is the
// verified Access identity, never typed in. Asking doesn't change the current
// password; the emailed link does.
loginApp.get("/_admin/forgot", async (c) => {
  const env = c.env;
  const access = await verifyIdentity(c.req.raw, env);
  if (!access.ok) return forbiddenPage(access.reason);
  if (!loginConfig(env)) return forbiddenPage("Admin password is not configured.");
  if (access.owner) return ownerReset();
  const user = await getUser(env.DB, access.email);
  if (!user) return forbiddenPage(NOT_ALLOWED.reason);
  if (isPaused(user, nowSec())) return pausedNotice(user);
  if (!user.password_hash) return choosePasswordFirst();
  return forgotPage({ mode: forgotMode(await withMailSettings(env)), email: access.email, status: 200, turnstile: await activeTurnstile(env) });
});

loginApp.post("/_admin/forgot", async (c) => {
  const env = c.env;
  const access = await verifyIdentity(c.req.raw, env);
  if (!access.ok) return forbiddenPage(access.reason);
  const cfg = loginConfig(env);
  if (!cfg) return forbiddenPage("Admin password is not configured.");
  if (access.owner) return ownerReset();
  const user = await getUser(env.DB, access.email);
  if (!user) return forbiddenPage(NOT_ALLOWED.reason);
  const now = nowSec();
  if (isPaused(user, now)) return pausedNotice(user);
  if (!user.password_hash) return choosePasswordFirst();
  const form = await readForm(c);
  if (form instanceof Response) return form;

  const mailEnv = await withMailSettings(env);
  const mode = forgotMode(mailEnv);
  let turnstile: TurnstileWidget = null;
  const render = (status: number, extra: { error?: string; done?: string; retryAfter?: number } = {}) =>
    forgotPage({ mode, email: access.email, status, turnstile, ...extra });
  if (mode === "none") return render(200);

  const key = await ipHash(cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
  if (!(await burstAllowed(env, key))) return render(429, { error: "Too many attempts. Wait a minute, then try again.", retryAfter: 60 });
  const bot = await botCheck(c, form);
  turnstile = bot.widget;
  if (bot.error) return render(400, { error: bot.error });
  const limited = await resetAllowance(env.DB, access.email, key, now);
  if (limited) return render(429, limited);

  const from = { email: mailEnv.DIGEST_FROM, name: "Shorthop" };
  if (mode === "admin") {
    try {
      await sendMail(mailEnv, { from, to: mailEnv.DIGEST_TO, ...adminResetNote(user) });
    } catch (err) {
      console.error(JSON.stringify({ message: "password reset note failed", email: access.email, error: String(err) }));
      return render(502, { error: "The message to an admin couldn't be sent. Ask an admin or manager directly." });
    }
    console.log(JSON.stringify({ message: "password reset requested", email: access.email, via: "admin", ipHash: key }));
    return render(200, { done: "An admin has been told. They'll send you a new link where you choose a new password." });
  }

  const token = randomToken();
  const saved = await env.DB.prepare("UPDATE users SET reset_hash = ?1, reset_expires = ?2 WHERE email = ?3 AND password_hash IS NOT NULL")
    .bind(await sha256Hex(token), now + RESET_TTL_SEC, access.email)
    .run();
  if (!saved.meta.changes) return choosePasswordFirst();
  try {
    await sendPersonMail(mailEnv, user, { from, ...resetEmail(access.email, `${new URL(c.req.url).origin}/_admin/reset/${token}`) });
  } catch (err) {
    console.error(JSON.stringify({ message: "password reset email failed", email: access.email, error: String(err) }));
    return render(502, { error: "The email couldn't be sent. Try again later, or ask an admin or manager to reset your password." });
  }
  console.log(JSON.stringify({ message: "password reset requested", email: access.email, via: "email", ipHash: key }));
  return render(200, {
    done: `Check your inbox at ${access.email}. The link works once, for ${waitText(RESET_TTL_SEC)}. Nothing there? Look in spam, or ask again in ${waitText(RESET_COOLDOWN_SEC)}.`,
  });
});

// Invite and reset links: only the matching Access identity can use one, once,
// before it expires. Opening the page doesn't use it up, so link scanners can't.
for (const kind of ["invite", "reset"] as const) {
  const path = `/_admin/${kind}/:token`;

  loginApp.get(path, async (c) => {
    const env = c.env;
    const access = await verifyIdentity(c.req.raw, env);
    if (!access.ok) return forbiddenPage(access.reason);
    if (access.owner) return forbiddenPage(LINK_TEXT[kind].owners);
    const cfg = loginConfig(env);
    if (!cfg) return forbiddenPage("Admin password is not configured.");
    const now = nowSec();
    const key = await ipHash(cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
    const lockedUntil = await tokenLockedUntil(env.DB, key, now);
    if (lockedUntil) return tooManyLinks(lockedUntil - now);
    const user = await findLink(env.DB, kind, access.email, (c.req.param("token") ?? ""), now);
    if (!user) {
      await chargeBadLink(env.DB, key, now);
      return LINK_TEXT[kind].invalid();
    }
    if (isPaused(user, now)) return pausedNotice(user);
    return choosePasswordPage({ kind, action: new URL(c.req.url).pathname, email: access.email, minLength: MIN_USER_PASSWORD, status: 200, turnstile: await activeTurnstile(env) });
  });

  loginApp.post(path, async (c) => {
    const env = c.env;
    const access = await verifyIdentity(c.req.raw, env);
    if (!access.ok) return forbiddenPage(access.reason);
    if (access.owner) return forbiddenPage(LINK_TEXT[kind].owners);
    const cfg = loginConfig(env);
    if (!cfg) return forbiddenPage("Admin password is not configured.");
    const form = await readForm(c);
    if (form instanceof Response) return form;

    const key = await ipHash(cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
    if (!(await burstAllowed(env, key))) return new Response("Too many attempts. Wait a minute, then try again.", { status: 429, headers: { "Retry-After": "60" } });
    const now = nowSec();
    const lockedUntil = await tokenLockedUntil(env.DB, key, now);
    if (lockedUntil) return tooManyLinks(lockedUntil - now);

    const token = (c.req.param("token") ?? "");
    // A cheap check before hashing the password.
    const user = await findLink(env.DB, kind, access.email, token, now);
    if (!user) {
      await chargeBadLink(env.DB, key, now);
      return LINK_TEXT[kind].invalid();
    }
    if (isPaused(user, now)) return pausedNotice(user);
    const action = new URL(c.req.url).pathname;
    const bot = await botCheck(c, form);
    const retry = (error: string) => choosePasswordPage({ kind, action, email: access.email, minLength: MIN_USER_PASSWORD, error, status: 400, turnstile: bot.widget });
    if (bot.error) return retry(bot.error);
    const password = form.get("password") ?? "";
    if (password.length < MIN_USER_PASSWORD) return retry(`Use at least ${MIN_USER_PASSWORD} characters.`);
    if (password.length > MAX_PASSWORD_LENGTH) return retry("That password is too long.");
    if (password !== (form.get("confirm") ?? "")) return retry("The two passwords don't match.");

    // Atomic: of two posts at once, only one uses the link. A new epoch ends every other session.
    const epoch = crypto.randomUUID();
    const sql =
      kind === "invite"
        ? `UPDATE users SET password_hash = ?1, session_epoch = ?2, invite_hash = NULL, invite_expires = NULL, updated_at = ?3, last_login_at = ?3
           WHERE email = ?4 AND invite_hash = ?5 AND invite_expires > ?3 RETURNING email`
        : `UPDATE users SET password_hash = ?1, session_epoch = ?2, reset_hash = NULL, reset_expires = NULL, updated_at = ?3, last_login_at = ?3
           WHERE email = ?4 AND reset_hash = ?5 AND reset_expires > ?3 RETURNING email`;
    const saved = await env.DB.prepare(sql)
      .bind(await hashPassword(password), epoch, now, access.email, await sha256Hex(token))
      .first<{ email: string }>();
    if (!saved) return LINK_TEXT[kind].invalid();

    const cf = c.req.raw.cf as IncomingRequestCfProperties | undefined;
    const [{ cookie }] = await Promise.all([
      getEpoch(env.DB).then((global) => issueSessionCookie(cfg, access.email, { global, user: epoch }, now)),
      env.DB.batch([clearFailuresStmt(env.DB, key), loginEventStmt(env.DB, true, key, String(cf?.country ?? ""), now, access.email)]),
    ]);
    if (kind === "reset") {
      afterResponse(
        c,
        withMailSettings(env)
          .then((mailEnv) => sendPersonMail(mailEnv, user, { from: { email: mailEnv.DIGEST_FROM, name: "Shorthop" }, ...passwordChangedEmail(access.email) }))
          .catch((err: unknown) => console.error(JSON.stringify({ message: "password changed email failed", email: access.email, error: String(err) }))),
      );
    }
    console.log(JSON.stringify({ message: kind === "invite" ? "invite accepted" : "password reset", email: access.email }));
    return seeOther(DEFAULT_NEXT, { "Set-Cookie": cookie });
  });
}

// Turning the optional bot check on: admins only, with a full session, and only
// when Cloudflare confirms a check made with the saved site key and the secret.
async function botCheckAdmin(c: Context<AppEnv>): Promise<Response | null> {
  const auth = await verifyAdmin(c.req.raw, c.env);
  if (!auth.ok) return auth.code === "login_required" ? seeOther(`/_admin/login?next=${encodeURIComponent("/_admin/bot-check")}`) : forbiddenPage(auth.reason);
  return auth.actor.role === "admin" ? null : forbiddenPage("Only admins can turn on the bot check.");
}

async function botCheckSetup(env: Env): Promise<{ siteKey: string } | Response> {
  const s = await turnstileSettings(env.DB);
  if (!s.siteKey) {
    return noticePage("Bot check", "Save a site key first", "In Settings → Access & security → Bot check, paste your Turnstile site key, then test it from there.", 400);
  }
  if (!turnstileSecret(env)) {
    return noticePage("Bot check", "Set the secret first", "Run npx wrangler secret put TURNSTILE_SECRET with your widget's secret key, then test it again.", 400);
  }
  return { siteKey: s.siteKey };
}

loginApp.get("/_admin/bot-check", async (c) => {
  const refused = await botCheckAdmin(c);
  if (refused) return refused;
  const setup = await botCheckSetup(c.env);
  if (setup instanceof Response) return setup;
  return botCheckPage({ siteKey: setup.siteKey, status: 200 });
});

loginApp.post("/_admin/bot-check", async (c) => {
  const refused = await botCheckAdmin(c);
  if (refused) return refused;
  const setup = await botCheckSetup(c.env);
  if (setup instanceof Response) return setup;
  const form = await readForm(c);
  if (form instanceof Response) return form;
  const result = await verifyTurnstile(c.env, form.get(TURNSTILE_FIELD) ?? "", c.req.header("CF-Connecting-IP"), false);
  if (!result.ok) {
    return botCheckPage({
      siteKey: setup.siteKey,
      error: `${result.reason} Check that the site key and TURNSTILE_SECRET come from the same widget, and that the widget lists ${new URL(c.req.url).hostname}.`,
      status: 400,
    });
  }
  await saveTurnstileStmt(c.env.DB, { enabled: true, siteKey: setup.siteKey }).run();
  console.log(JSON.stringify({ message: "bot check turned on" }));
  return seeOther("/_admin/settings#bot-check");
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

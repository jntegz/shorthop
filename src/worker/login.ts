// /_admin/login, /_admin/logout, /_admin/forgot, /_admin/invite/<token> and
// /_admin/reset/<token>: the password step (behind Cloudflare Access unless
// ADMIN_AUTH is "password"). Server-rendered forms without JavaScript, so they
// work under the strictest CSP (the optional Turnstile bot check adds only its
// own script, on the login and forgot-password pages). Owners (ADMIN_EMAIL, or everyone without Access) use the admin
// password; everyone else chooses their own password from an invite link, and
// can get a reset link by email.
// /_admin/login/2fa and /_admin/login/2fa-setup: the second step, for people
// with two-factor sign-in (or when an admin requires it). No session exists
// until it passes, whichever way the password step was reached.
// /_admin/login/passkey: a passkey instead of the password (and of the second
// step), with one small same-origin script on the pages that offer it.

import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { escapeHtml } from "../shared/html";
import {
  GLOBAL_WINDOW_SEC,
  LOCK_BASE_SEC,
  MAX_FAILS,
  RESET_COOLDOWN_SEC,
  RESET_MAX_GLOBAL_HOUR,
  RESET_MAX_PER_DAY,
  RESET_MAX_PER_NETWORK_HOUR,
  RESET_TTL_SEC,
} from "../shared/login-policy";
import { hashPassword, MAX_PASSWORD_LENGTH, parsePasswordHash } from "../shared/password";
import { passkeyLoginSchema } from "../shared/schemas";
import { adminAuthMode, NOT_ALLOWED, PASSWORD_UNCONFIGURED, verifyAdmin, verifyIdentity, verifySession } from "./auth";
import { readCapped, readTextCapped } from "./body";
import { nowSec } from "./db";
import { isLocalHost } from "./domains";
import type { AppEnv } from "./hono";
import { mailerStatus, peopleMailStatus, sendMail, sendPersonMail, withMailSettings } from "./mailer";
import {
  botCheckPage,
  bouncePage,
  choosePasswordPage,
  forbiddenPage,
  forgotPage,
  loginPage,
  noticePage,
  PASSKEY_SCRIPT,
  recoveryCodesPage,
  twoFactorPage,
  twoFactorSetupPage,
  type TurnstileWidget,
} from "./pages";
import { PASSKEY_LOGIN_JS } from "./passkey-script";
import { loginOptions, passkeyCount, relyingParty, verifyLogin } from "./passkeys";
import { qrSvg } from "./qr-svg";
import {
  chargeAttempt,
  clearFailuresStmt,
  clearMfaCookie,
  clearSessionCookie,
  getEpoch,
  globalLockedUntil,
  ipHash,
  issueMfaCookie,
  knownNetwork,
  issueSessionCookie,
  lock,
  loginConfig,
  loginEventStmt,
  ownerEpochs,
  parseMfaCookie,
  parseSessionCookie,
  recordGlobalFailure,
  revokeSession,
  sessionState,
  verifyPassword,
  verifyPasswordHash,
  type AttemptState,
  type LoginConfig,
  type LoginMethod,
  type SessionEpochs,
} from "./session";
import { normalizeTotp } from "./totp";
import { activeTurnstile, saveTurnstileStmt, TURNSTILE_FIELD, turnstileSecret, turnstileSettings, verifyTurnstile } from "./turnstile";
import {
  confirmTotpSetup,
  newEpochStmt,
  newRecoveryCodes,
  normalizeRecovery,
  pendingTotpSecret,
  sendTwoFactorNotice,
  startTotpSetup,
  totpUri,
  twoFactorStatus,
  useRecoveryCode,
  verifyTotp,
  type TwoFactorStatus,
} from "./two-factor";
import { getUser, INVITE_TOKEN_RE, isPaused, MIN_USER_PASSWORD, pausedReason, personIterations, randomToken, sha256Hex, type UserRow } from "./users";

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

/** A redirect that sets several cookies (a session, and the second step's cookie cleared). */
function seeOtherWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
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

/** A person's wrong passwords, across networks: only caps what they add to the people's brake. */
const personKey = (email: string) => `login:${email}`;

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

// --- The second step ------------------------------------------------------------

const SECOND_STEP = "/_admin/login/2fa";
const SETUP_STEP = "/_admin/login/2fa-setup";

/** Wrong codes count per person (whatever network they come from), like wrong passwords. */
const mfaKey = (email: string) => `mfa:${email}`;

/** The country Cloudflare saw the request from, for the login log. */
const countryOf = (c: Context<AppEnv>) => String((c.req.raw.cf as IncomingRequestCfProperties | undefined)?.country ?? "");

/**
 * The password was right (at the login, or a new one from an invite or reset
 * link). Without two-factor sign-in that's a session. With it, or when an admin
 * requires it, only a short cookie for the second step: `done` runs either way.
 * The successful login event is written only with the session, so knownNetwork
 * never trusts a network that only knew the password.
 */
async function passwordPassed(
  c: Context<AppEnv>,
  p: { cfg: LoginConfig; email: string; epochs: SessionEpochs; next: string; ipKey: string; country: string; now: number; touchUser: boolean; done: D1PreparedStatement[] },
): Promise<Response> {
  const db = c.env.DB;
  const tf = await twoFactorStatus(db, p.email);
  if (tf.factors.length === 0 && !tf.required) {
    const [{ cookie }] = await Promise.all([
      issueSessionCookie(p.cfg, p.email, p.epochs, p.now),
      db.batch([
        ...p.done,
        loginEventStmt(db, true, p.ipKey, p.country, p.now, p.email),
        ...(p.touchUser ? [db.prepare("UPDATE users SET last_login_at = ? WHERE email = ?").bind(p.now, p.email)] : []),
      ]),
    ]);
    console.log(JSON.stringify({ message: "admin login", email: p.email, method: "password", ipHash: p.ipKey, country: p.country }));
    return seeOther(p.next, { "Set-Cookie": cookie });
  }
  const [mfa] = await Promise.all([issueMfaCookie(p.cfg, p.email, p.epochs, p.now), db.batch(p.done)]);
  const step = tf.factors.length ? SECOND_STEP : SETUP_STEP;
  return seeOther(`${step}?next=${encodeURIComponent(p.next)}`, { "Set-Cookie": mfa });
}

interface Pending {
  email: string;
  cfg: LoginConfig;
  user: UserRow | null;
  epochs: SessionEpochs;
  next: string;
  status: TwoFactorStatus;
}

/**
 * Who is at the second step: the same identity whose password passed, with the
 * epochs still current (no password change, sign-out or reset since). Anything
 * else starts again at the password.
 */
async function pendingStep(c: Context<AppEnv>, nextRaw: string | null | undefined): Promise<Pending | Response> {
  const env = c.env;
  const req = c.req.raw;
  const access = await verifyIdentity(req, env);
  if (!access.ok) return forbiddenPage(access.reason);
  const cfg = loginConfig(env);
  if (!cfg) return forbiddenPage(PASSWORD_UNCONFIGURED);
  const next = safeNext(nextRaw, new URL(req.url).origin);
  const now = nowSec();
  const restart = () => seeOther(`/_admin/login?next=${encodeURIComponent(next)}`, { "Set-Cookie": clearMfaCookie() });
  const cookie = await parseMfaCookie(req, cfg, access.email, now);
  if (!cookie) return restart();
  let user: UserRow | null = null;
  let epochs: SessionEpochs;
  if (access.owner) {
    epochs = await ownerEpochs(env.DB, access.email);
  } else {
    const state = await sessionState(env.DB, null, access.email, false);
    if (!state.user) return forbiddenPage(NOT_ALLOWED.reason);
    if (isPaused(state.user, now)) return pausedNotice(state.user);
    user = state.user;
    epochs = { global: state.epoch, user: state.user.session_epoch };
  }
  if (cookie.global !== epochs.global || cookie.user !== epochs.user) return restart();
  return { email: access.email, cfg, user, epochs, next, status: await twoFactorStatus(env.DB, access.email) };
}

/** The session at last, with the second step's cookie cleared. */
async function completeLogin(c: Context<AppEnv>, p: Pending, method: LoginMethod, ipKey: string, now: number): Promise<string[]> {
  const db = c.env.DB;
  const country = countryOf(c);
  const [{ cookie }] = await Promise.all([
    issueSessionCookie(p.cfg, p.email, p.epochs, now),
    db.batch([
      clearFailuresStmt(db, mfaKey(p.email)),
      loginEventStmt(db, true, ipKey, country, now, p.email, method),
      ...(p.user ? [db.prepare("UPDATE users SET last_login_at = ? WHERE email = ?").bind(now, p.email)] : []),
    ]),
  ]);
  console.log(JSON.stringify({ message: "admin login", email: p.email, method, ipHash: ipKey, country }));
  return [cookie, clearMfaCookie()];
}

/** Why a code wasn't checked or didn't work, for the page to show. */
interface Refusal {
  status: number;
  error: string;
  retryAfter?: number;
}

const lockedOut = (wait: number): Refusal => ({ status: 429, error: `Too many wrong codes. Try again in ${waitText(wait)}.`, retryAfter: wait });

/** Counts a code attempt before it's checked, or refuses it while the person is locked out. */
async function chargeCode(env: Env, email: string, ipKey: string, now: number): Promise<{ refusal: Refusal } | { state: AttemptState }> {
  if (!(await burstAllowed(env, ipKey))) return { refusal: { status: 429, error: "Too many attempts. Wait a minute, then try again.", retryAfter: 60 } };
  const state = await chargeAttempt(env.DB, mfaKey(email), now);
  if (state.lockedUntil > now) return { refusal: lockedOut(state.lockedUntil - now) };
  // Only reachable by parallel requests that were all counted before a lock was written.
  if (state.fails > MAX_FAILS) return { refusal: lockedOut((await lock(env.DB, mfaKey(email), now, state.lockouts)) - now) };
  return { state };
}

/**
 * After a wrong code: a lock at the limit, otherwise how many tries are left.
 * A lock means someone had the right password, so the person is told by email.
 */
async function wrongCode(c: Context<AppEnv>, email: string, state: AttemptState, now: number): Promise<Refusal> {
  if (state.fails >= MAX_FAILS) {
    const until = await lock(c.env.DB, mfaKey(email), now, state.lockouts);
    afterResponse(c, sendTwoFactorNotice(c.env, email, { kind: "locked", until }));
    return lockedOut(until - now);
  }
  const left = MAX_FAILS - state.fails;
  return { status: 401, error: `That code didn't work. ${left} ${left === 1 ? "attempt" : "attempts"} left before a ${waitText(LOCK_BASE_SEC * 2 ** state.lockouts)} lock.` };
}

const hasTotp = (p: Pending) => p.status.factors.some((f) => f.kind === "totp");
/** This origin when the person has a passkey (the page offers it), otherwise null. */
const passkeyOn = (c: Context<AppEnv>, p: Pending) => (p.status.factors.some((f) => f.kind === "passkey") ? new URL(c.req.url).origin : null);

/** The setup page for the secret waiting for its first code (a new one when there's none). */
async function setupPage(c: Context<AppEnv>, p: Pending, now: number, refusal?: Refusal): Promise<Response> {
  const host = new URL(c.req.url).hostname;
  const waiting = await pendingTotpSecret(c.env, p.email, now, "totp-setup-login");
  const { secret, uri } = waiting ? { secret: waiting, uri: totpUri(host, p.email, waiting) } : await startTotpSetup(c.env, p.email, host, now, "totp-setup-login");
  return twoFactorSetupPage({ next: p.next, email: p.email, qr: qrSvg(uri, "QR code for your authenticator app"), secret, error: refusal?.error, status: refusal?.status ?? 200 });
}

/** Passkeys sign in without the password, so a new password from a reset removes them (with their challenges, and codes left with nothing to recover). */
function forgetPasskeysStmts(db: D1Database, email: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM auth_factors WHERE email = ?1 AND kind = 'passkey'").bind(email),
    db.prepare("DELETE FROM auth_challenges WHERE email = ?1 AND purpose LIKE 'passkey-%'").bind(email),
    db.prepare("DELETE FROM recovery_codes WHERE email = ?1 AND NOT EXISTS (SELECT 1 FROM auth_factors WHERE email = ?1)").bind(email),
  ];
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
  // ?reauth=1: sign in again on purpose, for changes that need a recent sign-in.
  const reauth = c.req.query("reauth") === "1";
  if (session.ok && !reauth) return seeOther(next);
  const passkey = (await passkeyCount(c.env.DB, access.email)) > 0 ? url.origin : null;
  const passwordOnly = adminAuthMode(c.env) === "password";
  if (session.ok) return loginPage({ next, email: access.email, passwordOnly, status: 200, turnstile: await activeTurnstile(c.env), passkey });
  if (session.code === "paused") return noticePage("Access paused", "Your access is paused", session.reason, 403);
  if (session.code !== "login_required") return forbiddenPage(session.reason);
  if (!access.owner && !(await getUser(c.env.DB, access.email))?.password_hash) return choosePasswordFirst();
  if (c.req.header("Sec-Fetch-Site") === "cross-site" && c.req.query("b") !== "1") {
    url.searchParams.set("b", "1");
    return bouncePage(`${url.pathname}${url.search}`);
  }
  return loginPage({ next, email: access.email, passwordOnly, status: 200, turnstile: await activeTurnstile(c.env), passkey });
});

loginApp.post("/_admin/login", async (c) => {
  const req = c.req.raw;
  const env = c.env;
  const url = new URL(req.url);
  const access = await verifyIdentity(req, env);
  if (!access.ok) return forbiddenPage(access.reason);
  const cfg = loginConfig(env);
  if (!cfg) return forbiddenPage(PASSWORD_UNCONFIGURED);
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
  const passkey = (await passkeyCount(env.DB, access.email)) > 0 ? url.origin : null;
  const render = (status: number, error: string, retryAfter?: number) =>
    loginPage({ next, email: access.email, passwordOnly: adminAuthMode(env) === "password", error, status, retryAfter, turnstile, passkey });

  if (!(await burstAllowed(env, key))) return render(429, "Too many attempts. Wait a minute, then try again.", 60);
  // A failed bot check isn't a password guess: not counted.
  const bot = await botCheck(c, form);
  turnstile = bot.widget;
  if (bot.error) return render(400, bot.error);

  // A network this account signed in from recently goes on to its own limit below: a pause
  // caused by strangers shouldn't lock out the owner.
  const globalUntil = await globalLockedUntil(env.DB, now, access.owner);
  if (globalUntil && !(await knownNetwork(env.DB, key, access.email, now))) {
    // Nothing a stranger can't also send proves this is the owner, so the way past it is outside this page.
    const owners = access.owner ? " The owner can lift the pause from the Cloudflare account: see SECURITY.md." : "";
    return render(429, `Logins are paused after many failed attempts. Try again in ${waitText(globalUntil - now)}.${owners}`, globalUntil - now);
  }

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
    // A hash made for the other Workers plan is redone at the plan's cost, now that the password is known.
    const rehash = user && stored && stored.iterations !== personIterations(env) ? await hashPassword(password, personIterations(env)) : null;
    const epochs = user ? { global: await getEpoch(env.DB), user: user.session_epoch } : await ownerEpochs(env.DB, access.email);
    const done = [
      clearFailuresStmt(env.DB, key),
      ...(user ? [clearFailuresStmt(env.DB, personKey(user.email))] : []),
      ...(user && rehash ? [env.DB.prepare("UPDATE users SET password_hash = ?1 WHERE email = ?2 AND password_hash = ?3").bind(rehash, user.email, user.password_hash)] : []),
    ];
    return passwordPassed(c, { cfg, email: access.email, epochs, next, ipKey: key, country, now, touchUser: Boolean(user), done });
  }

  // The event first: the global brake counts the networks failures came from.
  await loginEventStmt(env.DB, false, key, country, now, access.email).run();
  // One person counts towards the people's brake at most MAX_FAILS times a window, whatever
  // networks they use, so a single account can't keep everyone else's logins paused.
  const mine = user ? await chargeAttempt(env.DB, personKey(user.email), now, GLOBAL_WINDOW_SEC) : null;
  if (!mine || mine.fails <= MAX_FAILS) await recordGlobalFailure(env.DB, now, access.owner);
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

loginApp.get(SECOND_STEP, async (c) => {
  const p = await pendingStep(c, c.req.query("next"));
  if (p instanceof Response) return p;
  if (!p.status.factors.length) return seeOther(`${SETUP_STEP}?next=${encodeURIComponent(p.next)}`);
  return twoFactorPage({ next: p.next, email: p.email, status: 200, hasTotp: hasTotp(p), passkey: passkeyOn(c, p) });
});

loginApp.post(SECOND_STEP, async (c) => {
  const form = await readForm(c);
  if (form instanceof Response) return form;
  const p = await pendingStep(c, form.get("next"));
  if (p instanceof Response) return p;
  if (!p.status.factors.length) return seeOther(`${SETUP_STEP}?next=${encodeURIComponent(p.next)}`);
  const env = c.env;
  const now = nowSec();
  const ipKey = await ipHash(p.cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
  const totp = hasTotp(p);
  const render = (r: Refusal) => twoFactorPage({ next: p.next, email: p.email, error: r.error, status: r.status, retryAfter: r.retryAfter, hasTotp: totp, passkey: passkeyOn(c, p) });
  const charged = await chargeCode(env, p.email, ipKey, now);
  if ("refusal" in charged) return render(charged.refusal);

  const code = form.get("code") ?? "";
  const recovery = normalizeTotp(code) === null && normalizeRecovery(code) !== null;
  let left: number | null = null;
  const ok = recovery ? (left = await useRecoveryCode(env.DB, p.email, code, now)) !== null : totp && (await verifyTotp(env, p.email, code, now));
  const method: LoginMethod = recovery ? "password+recovery" : "password+totp";
  if (ok) {
    const cookies = await completeLogin(c, p, method, ipKey, now);
    if (recovery) afterResponse(c, sendTwoFactorNotice(env, p.email, { kind: "recovery-used", left: left ?? 0 }));
    return seeOtherWithCookies(p.next, cookies);
  }
  await loginEventStmt(env.DB, false, ipKey, countryOf(c), now, p.email, method).run();
  console.warn(JSON.stringify({ message: "admin login second step failed", email: p.email, method, ipHash: ipKey, country: countryOf(c), fails: charged.state.fails }));
  return render(await wrongCode(c, p.email, charged.state, now));
});

// Required, but not set up yet: an authenticator before the first session.
loginApp.get(SETUP_STEP, async (c) => {
  const p = await pendingStep(c, c.req.query("next"));
  if (p instanceof Response) return p;
  if (p.status.factors.length) return seeOther(`${SECOND_STEP}?next=${encodeURIComponent(p.next)}`);
  const now = nowSec();
  if (!p.status.required) {
    // The rule was turned off since the password step: nothing more to ask.
    const ipKey = await ipHash(p.cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
    return seeOtherWithCookies(p.next, await completeLogin(c, p, "password", ipKey, now));
  }
  return setupPage(c, p, now);
});

loginApp.post(SETUP_STEP, async (c) => {
  const form = await readForm(c);
  if (form instanceof Response) return form;
  const p = await pendingStep(c, form.get("next"));
  if (p instanceof Response) return p;
  if (p.status.factors.length) return seeOther(`${SECOND_STEP}?next=${encodeURIComponent(p.next)}`);
  const env = c.env;
  const now = nowSec();
  const ipKey = await ipHash(p.cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
  // A refusal shows the page again, with the secret it's waiting for.
  const charged = await chargeCode(env, p.email, ipKey, now);
  if ("refusal" in charged) return setupPage(c, p, now, charged.refusal);

  const result = await confirmTotpSetup(env, p.email, form.get("code") ?? "", "Authenticator app", now, "totp-setup-login");
  if (!result.ok) {
    if (result.reason === "exists") return seeOther(`${SECOND_STEP}?next=${encodeURIComponent(p.next)}`);
    if (result.reason === "expired") return setupPage(c, p, now, { status: 400, error: "That setup expired. Scan this new code and enter the code it shows." });
    return setupPage(c, p, now, await wrongCode(c, p.email, charged.state, now));
  }
  const { codes, stmts } = await newRecoveryCodes(env.DB, p.email, now);
  // A new personal epoch: sessions from before the second step existed end now.
  const rotated = newEpochStmt(env.DB, p.email, p.user === null, now);
  await env.DB.batch([...stmts, rotated.stmt]);
  const cookies = await completeLogin(c, { ...p, epochs: { ...p.epochs, user: rotated.own } }, "password+totp", ipKey, now);
  afterResponse(c, sendTwoFactorNotice(env, p.email, { kind: "added", factor: "An authenticator app" }));
  console.log(JSON.stringify({ message: "two-factor sign-in set up", email: p.email, at: "login" }));
  const page = recoveryCodesPage({ codes, next: p.next });
  for (const cookie of cookies) page.headers.append("Set-Cookie", cookie);
  return page;
});

// --- Passkeys ----------------------------------------------------------------------
// The script asks for options, the browser asks the passkey, the script posts
// the answer. JSON both ways, and only same-origin: the CSRF check covers
// forms, so the Origin is checked here too.

loginApp.get(PASSKEY_SCRIPT, () =>
  new Response(PASSKEY_LOGIN_JS, {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  }),
);

const MAX_JSON_BYTES = 16 * 1024;

/** The posted JSON, or null when it isn't same-origin JSON of a sensible size (counted as it streams in). */
async function readJson(c: Context<AppEnv>): Promise<unknown> {
  if (c.req.header("Origin") !== new URL(c.req.url).origin) return null;
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return null;
  const text = await readTextCapped(c.req.raw, MAX_JSON_BYTES);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

type PasskeyPerson = { email: string; cfg: LoginConfig; user: UserRow | null };

/** Who may try a passkey: the identity, an owner or someone in People who isn't paused and has chosen a password. */
async function passkeyPerson(c: Context<AppEnv>): Promise<PasskeyPerson | Response> {
  const env = c.env;
  const access = await verifyIdentity(c.req.raw, env);
  if (!access.ok) return c.json({ error: access.reason }, access.status);
  const cfg = loginConfig(env);
  if (!cfg) return c.json({ error: PASSWORD_UNCONFIGURED }, 500);
  if (access.owner) return { email: access.email, cfg, user: null };
  const user = await getUser(env.DB, access.email);
  if (!user) return c.json({ error: NOT_ALLOWED.reason }, 403);
  if (isPaused(user, nowSec())) return c.json({ error: pausedReason(user) }, 403);
  // Waiting on an invite or a reset by an admin: the new password comes first.
  if (!user.password_hash) return c.json({ error: "Choose your password from the invite link first." }, 403);
  return { email: access.email, cfg, user };
}

/**
 * Wrong passkey answers count per network, never per person: the passkey
 * pages ask for no password first, so anyone can post to them (in
 * password-only mode everyone is the owner "admin"). Counted against the
 * person, strangers could keep the owner's second step locked. An answer
 * can't be guessed, so a per-person brake would protect nothing.
 */
export const passkeyKey = (ipKey: string) => `passkey:${ipKey}`;

/** While this network's wrong passkey answers have locked it out, when that lifts. */
async function passkeyLockedUntil(db: D1Database, ipKey: string, now: number): Promise<number> {
  const row = await db.prepare("SELECT locked_until FROM auth_failures WHERE key = ?").bind(passkeyKey(ipKey)).first<{ locked_until: number }>();
  return row && row.locked_until > now ? row.locked_until : 0;
}

loginApp.post("/_admin/login/passkey/options", async (c) => {
  const who = await passkeyPerson(c);
  if (who instanceof Response) return who;
  if ((await readJson(c)) === null) return c.json({ error: "Bad request" }, 400);
  const env = c.env;
  const now = nowSec();
  const ipKey = await ipHash(who.cfg, c.req.header("CF-Connecting-IP") ?? "unknown");
  if (!(await burstAllowed(env, ipKey))) return c.json({ error: "Too many attempts. Wait a minute, then try again." }, 429);
  const until = await passkeyLockedUntil(env.DB, ipKey, now);
  if (until) return c.json({ error: `Too many failed attempts. Try again in ${waitText(until - now)}.` }, 429);
  const options = await loginOptions(env.DB, who.email, relyingParty(c.req.url), now);
  if (!options) return c.json({ error: "This account has no passkey. Use your password." }, 404);
  return c.json({ options });
});

// A passkey stands in for the password and the second step together: it is
// something you have, unlocked by something you are or know.
loginApp.post("/_admin/login/passkey", async (c) => {
  const who = await passkeyPerson(c);
  if (who instanceof Response) return who;
  const parsed = passkeyLoginSchema.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: "Bad request" }, 400);
  const env = c.env;
  const now = nowSec();
  const country = countryOf(c);
  const ipKey = await ipHash(who.cfg, c.req.header("CF-Connecting-IP") ?? "unknown");

  // Counted before the check, per network (passkeyKey), so parallel answers can't go past the limit; a success clears it.
  if (!(await burstAllowed(env, ipKey))) return c.json({ error: "Too many attempts. Wait a minute, then try again." }, 429);
  const state = await chargeAttempt(env.DB, passkeyKey(ipKey), now);
  if (state.lockedUntil > now) return c.json({ error: `Too many failed attempts. Try again in ${waitText(state.lockedUntil - now)}.` }, 429);
  // Only reachable by parallel requests that were all counted before a lock was written.
  if (state.fails > MAX_FAILS) {
    const until = await lock(env.DB, passkeyKey(ipKey), now, state.lockouts);
    return c.json({ error: `Too many failed attempts. Try again in ${waitText(until - now)}.` }, 429);
  }

  const next = safeNext(parsed.data.next, new URL(c.req.url).origin);
  const result = await verifyLogin(env.DB, who.email, parsed.data.response as never, relyingParty(c.req.url), now);
  if (!result.ok) {
    if (state.fails >= MAX_FAILS) await lock(env.DB, passkeyKey(ipKey), now, state.lockouts);
    await loginEventStmt(env.DB, false, ipKey, country, now, who.email, "passkey").run();
    console.warn(JSON.stringify({ message: "admin login passkey failed", email: who.email, reason: result.reason, ipHash: ipKey, country }));
    const error = result.reason === "expired" ? "That took too long. Try again." : "That passkey didn't work. Try again, or use your password.";
    return c.json({ error }, 401);
  }

  const epochs = who.user ? { global: await getEpoch(env.DB), user: who.user.session_epoch } : await ownerEpochs(env.DB, who.email);
  const [{ cookie }] = await Promise.all([
    issueSessionCookie(who.cfg, who.email, epochs, now),
    env.DB.batch([
      clearFailuresStmt(env.DB, passkeyKey(ipKey)),
      loginEventStmt(env.DB, true, ipKey, country, now, who.email, "passkey"),
      ...(who.user ? [env.DB.prepare("UPDATE users SET last_login_at = ? WHERE email = ?").bind(now, who.email)] : []),
    ]),
  ]);
  console.log(JSON.stringify({ message: "admin login", email: who.email, method: "passkey", ipHash: ipKey, country }));
  c.header("Set-Cookie", cookie, { append: true });
  c.header("Set-Cookie", clearMfaCookie(), { append: true });
  c.header("Cache-Control", "no-store");
  return c.json({ next });
});

// "Forgot your password?": only after Cloudflare Access, so the address is the
// verified Access identity, never typed in. Asking doesn't change the current
// password; the emailed link does.
loginApp.get("/_admin/forgot", async (c) => {
  const env = c.env;
  const access = await verifyIdentity(c.req.raw, env);
  if (!access.ok) return forbiddenPage(access.reason);
  if (!loginConfig(env)) return forbiddenPage(PASSWORD_UNCONFIGURED);
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
  if (!cfg) return forbiddenPage(PASSWORD_UNCONFIGURED);
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
  // Nothing went out, so the cooldown shouldn't make them wait to try again (the other limits stay charged).
  const refund = (...more: D1PreparedStatement[]) => env.DB.batch([clearFailuresStmt(env.DB, `reset:${access.email}`), ...more]);
  if (mode === "admin") {
    try {
      await sendMail(mailEnv, { from, to: mailEnv.DIGEST_TO, ...adminResetNote(user) });
    } catch (err) {
      console.error(JSON.stringify({ message: "password reset note failed", email: access.email, error: String(err) }));
      await refund();
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
    await refund(env.DB.prepare("UPDATE users SET reset_hash = NULL, reset_expires = NULL WHERE email = ?").bind(access.email));
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
    if (!cfg) return forbiddenPage(PASSWORD_UNCONFIGURED);
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
    // No bot check here: the link's token already can't be guessed, and it shouldn't sit in a page that loads a third party's script.
    return choosePasswordPage({ kind, action: new URL(c.req.url).pathname, email: access.email, minLength: MIN_USER_PASSWORD, status: 200 });
  });

  loginApp.post(path, async (c) => {
    const env = c.env;
    const access = await verifyIdentity(c.req.raw, env);
    if (!access.ok) return forbiddenPage(access.reason);
    if (access.owner) return forbiddenPage(LINK_TEXT[kind].owners);
    const cfg = loginConfig(env);
    if (!cfg) return forbiddenPage(PASSWORD_UNCONFIGURED);
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
    const retry = (error: string) => choosePasswordPage({ kind, action, email: access.email, minLength: MIN_USER_PASSWORD, error, status: 400 });
    const password = form.get("password") ?? "";
    if (password.length < MIN_USER_PASSWORD) return retry(`Use at least ${MIN_USER_PASSWORD} characters.`);
    if (password.length > MAX_PASSWORD_LENGTH) return retry("That password is too long.");
    if (password !== (form.get("confirm") ?? "")) return retry("The two passwords don't match.");

    // Atomic: of two posts at once, only one uses the link. A new epoch ends every other session,
    // and the other kind of link, if one is still waiting, ends with this password too.
    const epoch = crypto.randomUUID();
    const set = "password_hash = ?1, session_epoch = ?2, invite_hash = NULL, invite_expires = NULL, reset_hash = NULL, reset_expires = NULL, updated_at = ?3, last_login_at = ?3";
    const sql =
      kind === "invite"
        ? `UPDATE users SET ${set} WHERE email = ?4 AND invite_hash = ?5 AND invite_expires > ?3 RETURNING email`
        : `UPDATE users SET ${set} WHERE email = ?4 AND reset_hash = ?5 AND reset_expires > ?3 RETURNING email`;
    const saved = await env.DB.prepare(sql)
      .bind(await hashPassword(password, personIterations(env)), epoch, now, access.email, await sha256Hex(token))
      .first<{ email: string }>();
    if (!saved) return LINK_TEXT[kind].invalid();

    // A new password doesn't skip two-factor sign-in: the second step comes next, as at any login.
    // A reset by email also removes passkeys: each signs in without the password, so one added by
    // whoever had the account would outlive it. An authenticator app stays (it needs the password too).
    const response = await passwordPassed(c, {
      cfg,
      email: access.email,
      epochs: { global: await getEpoch(env.DB), user: epoch },
      next: DEFAULT_NEXT,
      ipKey: key,
      country: countryOf(c),
      now,
      touchUser: false,
      done: [clearFailuresStmt(env.DB, tokenKey(key)), ...(kind === "reset" ? forgetPasskeysStmts(env.DB, access.email) : [])],
    });
    if (kind === "reset") {
      afterResponse(
        c,
        withMailSettings(env)
          .then((mailEnv) => sendPersonMail(mailEnv, user, { from: { email: mailEnv.DIGEST_FROM, name: "Shorthop" }, ...passwordChangedEmail(access.email) }))
          .catch((err: unknown) => console.error(JSON.stringify({ message: "password changed email failed", email: access.email, error: String(err) }))),
      );
    }
    console.log(JSON.stringify({ message: kind === "invite" ? "invite accepted" : "password reset", email: access.email }));
    return response;
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
  return seeOtherWithCookies(viaAccess ? "/cdn-cgi/access/logout" : "/_admin/login", [clearSessionCookie(), clearMfaCookie()]);
});

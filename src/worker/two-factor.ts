// Two-factor sign-in: the factors each person has (an authenticator app and
// passkeys), one-time recovery codes, and the workspace rule that requires a
// factor. Stored per identity, so owners (no users row) have them too, and so
// does the "admin" of password-only mode. Login pages (login.ts) ask for a
// factor after the password; the settings API (api/me.ts) lets each person
// manage their own.

import { APP_NAME } from "../shared/brand";
import { escapeHtml } from "../shared/html";
import { RECOVERY_CODE_COUNT, REAUTH_WINDOW_SEC, SESSION_TTL_SEC } from "../shared/login-policy";
import type { TwoFactorFactorDTO } from "../shared/types";
import { getSetting, setSettingStmt } from "./db";
import { adminAuthMode } from "./auth";
import { sendMail, sendPersonMail, withMailSettings } from "./mailer";
import { getEpoch, issueSessionCookie, ownerEpochKey, type LoginConfig } from "./session";
import { matchTotp, newTotpSecret, otpauthUri } from "./totp";
import { ownerEmails, PASSWORD_IDENTITY, randomToken, sha256Hex } from "./users";
import { decryptSecret, encryptSecret } from "./webhooks";

export type FactorKind = "totp" | "passkey";

export interface FactorRow {
  id: string;
  email: string;
  kind: FactorKind;
  name: string;
  secret_enc: string | null;
  credential_id: string | null;
  public_key: string | null;
  sign_count: number;
  transports: string | null;
  last_step: number | null;
  created_at: number;
  last_used_at: number | null;
}

export const REQUIRE_2FA_KEY = "require_2fa";

/** Where an authenticator is being set up: Settings, or the login page when it's required. Kept apart, so neither shows the other's secret. */
export type SetupFlow = "totp-setup" | "totp-setup-login";
/** How long a new authenticator secret waits for its first code. */
const TOTP_SETUP_TTL_SEC = 10 * 60;

export function factorDTO(f: FactorRow): TwoFactorFactorDTO {
  return { id: f.id, kind: f.kind, name: f.name, createdAt: f.created_at, lastUsedAt: f.last_used_at };
}

export async function twoFactorRequired(db: D1Database): Promise<boolean> {
  return (await getSetting(db, REQUIRE_2FA_KEY)) === "1";
}

export function setTwoFactorRequiredStmt(db: D1Database, on: boolean): D1PreparedStatement {
  return on ? setSettingStmt(db, REQUIRE_2FA_KEY, "1") : db.prepare("DELETE FROM settings WHERE key = ?").bind(REQUIRE_2FA_KEY);
}

export interface TwoFactorStatus {
  factors: FactorRow[];
  required: boolean;
  recoveryLeft: number;
}

/** One person's factors, unused recovery codes and the workspace rule, in one D1 round trip. */
export async function twoFactorStatus(db: D1Database, email: string): Promise<TwoFactorStatus> {
  const [factors, codes, rule] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM auth_factors WHERE email = ? ORDER BY created_at, id").bind(email),
    db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE email = ? AND used_at IS NULL").bind(email),
    db.prepare("SELECT value FROM settings WHERE key = ?").bind(REQUIRE_2FA_KEY),
  ]);
  return {
    factors: (factors?.results ?? []) as unknown as FactorRow[],
    recoveryLeft: Number(codes?.results[0]?.n ?? 0),
    required: rule?.results[0]?.value === "1",
  };
}

// --- Authenticator app (TOTP) ---------------------------------------------------

/** The name an authenticator app shows for this account. */
function issuer(host: string): string {
  return host ? `Shorthop (${host})` : "Shorthop";
}

/**
 * A new secret waiting for its first code (replacing any earlier one). Only
 * once a code from it is confirmed does it become a factor.
 */
export async function startTotpSetup(env: Env, email: string, host: string, now: number, flow: SetupFlow = "totp-setup"): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE email = ? AND purpose = ?").bind(email, flow),
    env.DB.prepare("INSERT INTO auth_challenges (id, email, purpose, value, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      randomToken(16),
      email,
      flow,
      await encryptSecret(env, "totp", secret),
      now + TOTP_SETUP_TTL_SEC,
    ),
  ]);
  return { secret, uri: totpUri(host, email, secret) };
}

export const totpUri = (host: string, email: string, secret: string) => otpauthUri({ issuer: issuer(host), account: email, secret });

/** The secret waiting for its first code, if it hasn't expired. */
export async function pendingTotpSecret(env: Env, email: string, now: number, flow: SetupFlow = "totp-setup"): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM auth_challenges WHERE email = ? AND purpose = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
    .bind(email, flow, now)
    .first<{ value: string }>();
  return row ? decryptSecret(env, "totp", row.value) : null;
}

export type ConfirmResult = { ok: true; factor: FactorRow } | { ok: false; reason: "expired" | "wrong" | "exists" };

/** Saves the waiting secret as this person's authenticator, if the code is from it. */
export async function confirmTotpSetup(env: Env, email: string, code: string, name: string, now: number, flow: SetupFlow = "totp-setup"): Promise<ConfirmResult> {
  const secret = await pendingTotpSecret(env, email, now, flow);
  if (!secret) return { ok: false, reason: "expired" };
  const step = await matchTotp(secret, code, now);
  if (step === null) return { ok: false, reason: "wrong" };
  const factor: FactorRow = {
    id: randomToken(12),
    email,
    kind: "totp",
    name: name.trim().slice(0, 60) || "Authenticator app",
    secret_enc: await encryptSecret(env, "totp", secret),
    credential_id: null,
    public_key: null,
    sign_count: 0,
    transports: null,
    last_step: step,
    created_at: now,
    last_used_at: now,
  };
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_factors (id, email, kind, name, secret_enc, last_step, created_at, last_used_at) VALUES (?1, ?2, 'totp', ?3, ?4, ?5, ?6, ?6)",
      ).bind(factor.id, email, factor.name, factor.secret_enc, step, now),
      env.DB.prepare("DELETE FROM auth_challenges WHERE email = ? AND purpose = ?").bind(email, flow),
    ]);
  } catch (err) {
    // The unique index: one authenticator per person (a second confirm racing this one).
    if (/UNIQUE/i.test(String(err))) return { ok: false, reason: "exists" };
    throw err;
  }
  return { ok: true, factor };
}

/** Whether the code is from this person's authenticator, and not used before. Uses it up. */
export async function verifyTotp(env: Env, email: string, code: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id, secret_enc, last_step FROM auth_factors WHERE email = ? AND kind = 'totp'")
    .bind(email)
    .first<Pick<FactorRow, "id" | "secret_enc" | "last_step">>();
  if (!row?.secret_enc) return false;
  const secret = await decryptSecret(env, "totp", row.secret_enc);
  if (!secret) {
    console.error(JSON.stringify({ message: "authenticator secret unreadable", email }));
    return false;
  }
  const step = await matchTotp(secret, code, now, row.last_step);
  if (step === null) return false;
  // Atomic: of two logins with the same code, only one wins the step.
  const res = await env.DB.prepare("UPDATE auth_factors SET last_step = ?1, last_used_at = ?2 WHERE id = ?3 AND (last_step IS NULL OR last_step < ?1)")
    .bind(step, now, row.id)
    .run();
  return res.meta.changes > 0;
}

// --- Recovery codes -------------------------------------------------------------

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Lowercase, without spaces or dashes; null when it can't be one. */
export function normalizeRecovery(code: string): string | null {
  const c = code.toLowerCase().replace(/[\s-]/g, "");
  return /^[a-z0-9]{10}$/.test(c) ? c : null;
}

const recoveryHash = (email: string, normalized: string) => sha256Hex(`recovery|${email}|${normalized}`);

function newRecoveryCode(): string {
  // 31 symbols, 10 of them: about 50 bits. Rejection sampling keeps each symbol equally likely.
  let out = "";
  while (out.length < 10) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && out.length < 10) out += RECOVERY_ALPHABET[b % 31];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** A new set of codes (shown once) and the statements that replace the old set. */
export async function newRecoveryCodes(db: D1Database, email: string, now: number): Promise<{ codes: string[]; stmts: D1PreparedStatement[] }> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const stmts = [db.prepare("DELETE FROM recovery_codes WHERE email = ?").bind(email)];
  for (const code of codes) {
    stmts.push(db.prepare("INSERT INTO recovery_codes (email, hash, created_at) VALUES (?, ?, ?)").bind(email, await recoveryHash(email, normalizeRecovery(code)!), now));
  }
  return { codes, stmts };
}

/** Uses one recovery code: the number left afterwards, or null when it isn't one of theirs (or was used). */
export async function useRecoveryCode(db: D1Database, email: string, code: string, now: number): Promise<number | null> {
  const c = normalizeRecovery(code);
  if (!c) return null;
  const [used, left] = await db.batch<{ n: number }>([
    db.prepare("UPDATE recovery_codes SET used_at = ?1 WHERE email = ?2 AND hash = ?3 AND used_at IS NULL").bind(now, email, await recoveryHash(email, c)),
    db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE email = ? AND used_at IS NULL").bind(email),
  ]);
  return used?.meta.changes ? Number(left?.results[0]?.n ?? 0) : null;
}

/** Everything two-factor for one person: factors, codes, anything waiting. */
export function forgetTwoFactorStmts(db: D1Database, email: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM auth_factors WHERE email = ?").bind(email),
    db.prepare("DELETE FROM recovery_codes WHERE email = ?").bind(email),
    db.prepare("DELETE FROM auth_challenges WHERE email = ?").bind(email),
  ];
}

// --- Sessions -------------------------------------------------------------------

/** When this session signed in: its end minus the session lifetime. */
export function signedInAt(sessionExp: number): number {
  return sessionExp - SESSION_TTL_SEC;
}

/** Whether the session signed in recently enough to change two-factor sign-in. */
export function recentSignIn(sessionExp: number | undefined, now: number): boolean {
  return sessionExp !== undefined && now - signedInAt(sessionExp) <= REAUTH_WINDOW_SEC;
}

/**
 * A new personal epoch, which ends this person's other sessions: users get a
 * new session_epoch, owners a new stored epoch of their own (ownerEpochKey).
 */
export function newEpochStmt(db: D1Database, email: string, owner: boolean, now: number): { own: string; stmt: D1PreparedStatement } {
  const own = crypto.randomUUID();
  return {
    own,
    stmt: owner
      ? setSettingStmt(db, ownerEpochKey(email), own)
      : db.prepare("UPDATE users SET session_epoch = ?1, updated_at = ?2 WHERE email = ?3").bind(own, now, email),
  };
}

/** The cookie that keeps this session going after newEpochStmt, with the same end (and sign-in time). */
export async function reissueSession(db: D1Database, cfg: LoginConfig, email: string, own: string, sessionExp: number | undefined, now: number): Promise<string> {
  const { cookie } = await issueSessionCookie(cfg, email, { global: await getEpoch(db), user: own }, now, sessionExp);
  return cookie;
}

// --- Admins' view ---------------------------------------------------------------

/** Who can sign in (owners and people with a password; without Access only "admin") but has no factor yet. */
export async function peopleWithoutTwoFactor(env: Env): Promise<number> {
  const [people, withFactor] = await env.DB.batch<{ email: string }>([
    env.DB.prepare("SELECT email FROM users WHERE password_hash IS NOT NULL"),
    env.DB.prepare("SELECT DISTINCT email FROM auth_factors"),
  ]);
  const has = new Set((withFactor?.results ?? []).map((r) => r.email));
  const everyone = new Set(adminAuthMode(env) === "password" ? [PASSWORD_IDENTITY] : [...ownerEmails(env), ...(people?.results ?? []).map((r) => r.email)]);
  return [...everyone].filter((e) => !has.has(e)).length;
}

// --- Emails ---------------------------------------------------------------------

export type TwoFactorNotice =
  | { kind: "added"; factor: string }
  | { kind: "removed"; factor: string }
  | { kind: "codes" }
  | { kind: "recovery-used"; left: number }
  | { kind: "locked"; until: number }
  | { kind: "reset"; by: string };

function noticeText(email: string, n: TwoFactorNotice): { subject: string; text: string } {
  const notYou = "If that wasn't you, tell an admin right away.";
  switch (n.kind) {
    case "added":
      return { subject: "Two-factor sign-in: new sign-in method", text: `${n.factor} was just added to the ${APP_NAME} sign-in of ${email}. ${notYou}` };
    case "removed":
      return { subject: "Two-factor sign-in: method removed", text: `${n.factor} was just removed from the ${APP_NAME} sign-in of ${email}. ${notYou}` };
    case "codes":
      return { subject: `New ${APP_NAME} recovery codes`, text: `New recovery codes were just made for ${email}; the old ones stopped working. ${notYou}` };
    case "recovery-used":
      return {
        subject: `A ${APP_NAME} recovery code was used`,
        text: `Someone signed in to ${APP_NAME} as ${email} with a recovery code. ${n.left} ${n.left === 1 ? "code is" : "codes are"} left. ${notYou}`,
      };
    case "locked":
      return {
        subject: `Someone tried to sign in to ${APP_NAME} as you`,
        text: `Someone entered the right ${APP_NAME} password for ${email}, then the wrong two-factor code several times, so the second step is locked until ${new Date(n.until * 1000).toUTCString()}. If that wasn't you, your password is known to someone: change it now, and tell an admin.`,
      };
    case "reset":
      return {
        subject: `Your ${APP_NAME} two-factor sign-in was reset`,
        text: `${n.by} reset the two-factor sign-in of ${email}: your authenticator, passkeys and recovery codes were removed, and your sessions ended. Set it up again in Settings → Access & security. ${notYou}`,
      };
  }
}

/**
 * Best effort: a security notice to the person's own address, when email can
 * reach them. The "admin" of password-only mode has no address of its own:
 * theirs goes to DIGEST_TO, like the other notices for the owner.
 */
export async function sendTwoFactorNotice(env: Env, email: string, notice: TwoFactorNotice): Promise<void> {
  try {
    const mailEnv = await withMailSettings(env);
    const { subject, text } = noticeText(email, notice);
    const msg = { from: { email: mailEnv.DIGEST_FROM, name: APP_NAME }, subject, text, html: `<p>${escapeHtml(text)}</p>` };
    if (email.includes("@")) await sendPersonMail(mailEnv, { email }, msg);
    else await sendMail(mailEnv, { ...msg, to: mailEnv.DIGEST_TO });
  } catch (err) {
    console.warn(JSON.stringify({ message: "two-factor notice not sent", email, kind: notice.kind, error: String(err) }));
  }
}

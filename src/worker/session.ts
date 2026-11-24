// Admin password sessions, verification and brute-force state. A session is
// only valid together with the identity it was issued to (the Access login, or
// the fixed password-only identity when Access is off), the global epoch ("Log
// out everyone"), the person's own epoch (removed, reset or changed password)
// and the admin password hash, and until it is logged out.

import {
  GLOBAL_LOCK_SEC,
  GLOBAL_MAX_FAILS,
  GLOBAL_MIN_NETWORKS,
  GLOBAL_WINDOW_SEC,
  KNOWN_NETWORK_SEC,
  LOCK_BASE_SEC,
  LOCK_MAX_SEC,
  LOGIN_EVENT_RETENTION_SEC,
  MFA_COOKIE,
  MFA_TTL_SEC,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  WINDOW_SEC,
} from "../shared/login-policy";
import { derivePassword, fromBase64Url, MAX_PASSWORD_LENGTH, MIN_ADMIN_PASSWORD_LENGTH, parsePasswordHash, toBase64Url, type PasswordHash } from "../shared/password";
import { getSetting, setSettingStmt } from "./db";
import { OWNER_EPOCH, type UserRow } from "./users";

export interface LoginConfig {
  /** The owners' password: the ADMIN_PASSWORD_HASH hash, or the ADMIN_PASSWORD secret itself. */
  password: PasswordHash | { plain: string };
  /**
   * Changes whenever the owners' password does, and is signed into every
   * session so a new password ends them all. Only ever part of the HMAC input,
   * never sent anywhere.
   */
  fingerprint: string;
  secret: string;
}

const MIN_SECRET_LENGTH = 32;
const VERSION = "v2";
const GLOBAL_KEY = "*";
/** The people's own brake: their failures pause only their logins, so no one can lock the owners out. */
const PEOPLE_GLOBAL_KEY = "*people";

/** The ADMIN_PASSWORD secret (Deploy to Cloudflare installs), read loosely: it's optional. */
export function plainAdminPassword(env: Env): string {
  return env.ADMIN_PASSWORD ?? "";
}

/**
 * The password login settings, or null when they're missing or malformed
 * (callers fail closed). ADMIN_PASSWORD_HASH wins; without it, an
 * ADMIN_PASSWORD of at least MIN_ADMIN_PASSWORD_LENGTH characters is used.
 */
export function loginConfig(env: Env): LoginConfig | null {
  const secret = env.SESSION_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return null;
  const hash = parsePasswordHash(env.ADMIN_PASSWORD_HASH ?? "");
  if (hash) return { password: hash, fingerprint: toBase64Url(hash.hash), secret };
  const plain = plainAdminPassword(env);
  if (plain.length < MIN_ADMIN_PASSWORD_LENGTH || plain.length > MAX_PASSWORD_LENGTH) return null;
  return { password: { plain }, fingerprint: `plain|${plain}`, secret };
}

const encoder = new TextEncoder();

// Imported once per isolate and secret.
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    hmacKeys.set(secret, key);
  }
  return key;
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data)));
}

/** Constant-time password check against a stored PBKDF2 hash. */
export async function verifyPasswordHash(password: string, stored: PasswordHash): Promise<boolean> {
  if (!password || password.length > MAX_PASSWORD_LENGTH) return false;
  const derived = await derivePassword(password, stored.salt, stored.iterations);
  return crypto.subtle.timingSafeEqual(derived, stored.hash);
}

/** The owners' password: ADMIN_PASSWORD_HASH, or ADMIN_PASSWORD compared in constant time. */
export async function verifyPassword(password: string, cfg: LoginConfig): Promise<boolean> {
  if (!("plain" in cfg.password)) return verifyPasswordHash(password, cfg.password);
  if (!password || password.length > MAX_PASSWORD_LENGTH) return false;
  // Hash both sides so the lengths always match.
  const digest = (s: string) => crypto.subtle.digest("SHA-256", encoder.encode(s));
  const [a, b] = await Promise.all([digest(password), digest(cfg.password.plain)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// --- Sessions -----------------------------------------------------------------

export async function getEpoch(db: D1Database): Promise<string> {
  return (await getSetting(db, "session_epoch")) ?? "0";
}

/** Invalidates every session at once: the epoch is part of each signed cookie. */
export async function revokeAllSessions(db: D1Database): Promise<void> {
  await setSettingStmt(db, "session_epoch", crypto.randomUUID()).run();
}

/**
 * The settings key of one owner's own epoch (owners have no users row). Set
 * when their two-factor sign-in changes, to end only their other sessions;
 * without one it is OWNER_EPOCH, so sessions made before it existed stay valid.
 */
export const ownerEpochKey = (identity: string) => `owner_epoch:${identity}`;

/** Both epochs of an owner's session, in one D1 read. */
export async function ownerEpochs(db: D1Database, identity: string): Promise<SessionEpochs> {
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key IN ('session_epoch', ?)").bind(ownerEpochKey(identity)).all<{ key: string; value: string }>();
  return { global: results.find((r) => r.key === "session_epoch")?.value ?? "0", user: results.find((r) => r.key !== "session_epoch")?.value ?? OWNER_EPOCH };
}

/** The two epochs a session is bound to: global, and the person's own (an owner's from ownerEpochKey). */
export interface SessionEpochs {
  global: string;
  user: string;
}

/** Settings key prefix of sessions ended by logging out, kept until they would have expired. */
const REVOKED_PREFIX = "revoked_session:";

// The owners' password is signed in too (cfg.fingerprint), so changing it ends every session.
const sessionPayload = (cfg: LoginConfig, exp: number, e: SessionEpochs, email: string) =>
  `${VERSION}|${exp}|${e.global}|${e.user}|${cfg.fingerprint}|${email}`;

/**
 * A new session cookie. `keepExp` reissues one for new epochs without moving
 * its end, so the time it was signed in (exp - SESSION_TTL_SEC) stays true for
 * the checks that need a recent sign-in.
 */
export async function issueSessionCookie(cfg: LoginConfig, email: string, epochs: SessionEpochs, now: number, keepExp?: number): Promise<{ cookie: string; exp: number }> {
  const exp = keepExp && keepExp > now && keepExp <= now + SESSION_TTL_SEC ? keepExp : now + SESSION_TTL_SEC;
  const mac = toBase64Url(await sign(cfg.secret, sessionPayload(cfg, exp, epochs, email)));
  return {
    cookie: `${SESSION_COOKIE}=${VERSION}.${exp}.${epochs.global}.${epochs.user}.${mac}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${exp - now}`,
    exp,
  };
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The session cookie, if its signature is valid for this identity and it
 * hasn't expired. CPU only: the caller checks the epochs and logouts with
 * sessionState, so junk cookies never cost a database read.
 */
export async function parseSessionCookie(
  request: Request,
  cfg: LoginConfig,
  email: string,
  now: number,
): Promise<({ exp: number; mac: string } & SessionEpochs) | null> {
  const raw = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!raw) return null;
  const [version, expRaw, global, user, macRaw, ...rest] = raw.split(".");
  if (version !== VERSION || !expRaw || !global || !user || !macRaw || rest.length) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= now || exp > now + SESSION_TTL_SEC) return null;
  const mac = fromBase64Url(macRaw);
  // Only the canonical spelling: base64url's spare last bits would otherwise give one MAC
  // four spellings, and a logout (keyed on the spelling) would miss the other three.
  if (!mac || toBase64Url(mac) !== macRaw) return null;
  const epochs = { global, user };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(cfg.secret), mac, encoder.encode(sessionPayload(cfg, exp, epochs, email)));
  return valid ? { exp, mac: macRaw, ...epochs } : null;
}

export interface SessionState {
  epoch: string;
  revoked: boolean;
  /** An owner's own epoch (ownerEpochKey), OWNER_EPOCH when none is stored. */
  ownerEpoch: string;
  /** Someone other than an owner: their users row. */
  user: UserRow | null;
  /** Two-factor sign-in is required for everyone and this identity has no method yet. */
  needsTwoFactor: boolean;
}

/**
 * What a session is checked against, in one D1 round trip: the global epoch,
 * whether this session was logged out (`mac`, when there is a cookie), the
 * owner's own epoch or, for someone else, their users row, and whether the
 * workspace requires two-factor sign-in they don't have.
 */
export async function sessionState(db: D1Database, mac: string | null, identity: string, owner: boolean): Promise<SessionState> {
  const [settings, factors, user] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT key, value FROM settings WHERE key IN ('session_epoch', 'require_2fa', ?1, ?2)").bind(mac ? REVOKED_PREFIX + mac : "session_epoch", owner ? ownerEpochKey(identity) : "session_epoch"),
    db.prepare("SELECT EXISTS (SELECT 1 FROM auth_factors WHERE email = ?) AS n").bind(identity),
    ...(owner ? [] : [db.prepare("SELECT * FROM users WHERE email = ?").bind(identity)]),
  ]);
  const rows = (settings?.results ?? []) as { key: string; value: string }[];
  const required = rows.some((r) => r.key === "require_2fa" && r.value === "1");
  return {
    epoch: rows.find((r) => r.key === "session_epoch")?.value ?? "0",
    revoked: rows.some((r) => r.key.startsWith(REVOKED_PREFIX)),
    ownerEpoch: rows.find((r) => r.key.startsWith("owner_epoch:"))?.value ?? OWNER_EPOCH,
    user: (user?.results[0] as UserRow | undefined) ?? null,
    needsTwoFactor: required && !Number(factors?.results[0]?.n ?? 0),
  };
}

/** Ends one session (logging out), leaving the others signed in. */
export async function revokeSession(db: D1Database, session: { exp: number; mac: string }): Promise<void> {
  await setSettingStmt(db, REVOKED_PREFIX + session.mac, String(session.exp)).run();
}

// --- The second step ------------------------------------------------------------
// After the right password, someone with two-factor sign-in gets this short
// cookie instead of a session: proof that the password step passed, for this
// identity, these epochs and this owners' password. Only the second step's
// pages read it.

const MFA_VERSION = "m1";
const mfaPayload = (cfg: LoginConfig, exp: number, e: SessionEpochs, email: string) => `${MFA_VERSION}|${exp}|${e.global}|${e.user}|${cfg.fingerprint}|${email}`;

export async function issueMfaCookie(cfg: LoginConfig, email: string, epochs: SessionEpochs, now: number): Promise<string> {
  const exp = now + MFA_TTL_SEC;
  const mac = toBase64Url(await sign(cfg.secret, mfaPayload(cfg, exp, epochs, email)));
  return `${MFA_COOKIE}=${MFA_VERSION}.${exp}.${epochs.global}.${epochs.user}.${mac}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MFA_TTL_SEC}`;
}

export function clearMfaCookie(): string {
  return `${MFA_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** The pending second step, if its cookie is valid for this identity. The caller compares the epochs. */
export async function parseMfaCookie(request: Request, cfg: LoginConfig, email: string, now: number): Promise<({ exp: number } & SessionEpochs) | null> {
  const raw = cookieValue(request.headers.get("Cookie"), MFA_COOKIE);
  if (!raw) return null;
  const [version, expRaw, global, user, macRaw, ...rest] = raw.split(".");
  if (version !== MFA_VERSION || !expRaw || !global || !user || !macRaw || rest.length) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= now || exp > now + MFA_TTL_SEC) return null;
  const mac = fromBase64Url(macRaw);
  if (!mac || toBase64Url(mac) !== macRaw) return null;
  const epochs = { global, user };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(cfg.secret), mac, encoder.encode(mfaPayload(cfg, exp, epochs, email)));
  return valid ? { exp, ...epochs } : null;
}

// --- Client networks ----------------------------------------------------------

/** The client's network: the full IPv4 address, or the /64 of an IPv6 address. */
export function ipBucket(ip: string): string {
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return v;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped?.[1]) return mapped[1];
  const [head = "", tail] = v.split("::", 2);
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * A rate limiter's key for one client network: the scope and a keyed hash, so
 * the limiter never holds the address. The same network always gets the same
 * key. Without a secret to key it (D1 unreadable on a button install) it is a
 * plain hash, which still keeps the limit working.
 */
export async function limiterKey(env: Pick<Env, "SESSION_SECRET">, scope: string, ip: string): Promise<string> {
  const data = `limiter|${scope}|${ipBucket(ip)}`;
  const mac = env.SESSION_SECRET ? await sign(env.SESSION_SECRET, data) : new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
  let hex = "";
  for (const b of mac.slice(0, 16)) hex += b.toString(16).padStart(2, "0");
  return `${scope}:${hex}`;
}

/** Keyed hash of the client network: never reversible to the IP without the secret. */
export async function ipHash(cfg: LoginConfig, ip: string): Promise<string> {
  const mac = await sign(cfg.secret, `login-ip|${ipBucket(ip)}`);
  let hex = "";
  for (const b of mac.slice(0, 16)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// --- Brute-force state (D1 is strongly consistent, unlike the rate limiter) ---

export interface AttemptState {
  fails: number;
  lockedUntil: number;
  lockouts: number;
  /** When the current counting window began. */
  windowStart: number;
}

// Counts an attempt atomically before the password is checked, so parallel
// guesses can't all slip in under the limit. A locked key isn't written at all
// (the WHERE), so hammering a lock costs no D1 writes; lockouts reset after a
// day that was quiet since the lock ended.
const CHARGE = `INSERT INTO auth_failures (key, fails, window_start, locked_until, lockouts, updated_at)
VALUES (?1, ?4, ?2, 0, 0, ?2)
ON CONFLICT (key) DO UPDATE SET
  lockouts     = CASE WHEN ?2 - MAX(updated_at, locked_until) > 86400 THEN 0 ELSE lockouts END,
  fails        = CASE WHEN ?2 - window_start > ?3 THEN ?4 ELSE fails + ?4 END,
  window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END,
  updated_at   = ?2
WHERE locked_until <= ?2
RETURNING fails, locked_until, lockouts, window_start`;

export async function chargeAttempt(db: D1Database, key: string, now: number, windowSec = WINDOW_SEC, count = 1): Promise<AttemptState> {
  type Row = { fails: number; locked_until: number; lockouts: number; window_start: number };
  // No row back means the key is locked and was left alone: read how it stands.
  const row =
    (await db.prepare(CHARGE).bind(key, now, windowSec, count).first<Row>()) ??
    (await db.prepare("SELECT fails, locked_until, lockouts, window_start FROM auth_failures WHERE key = ?").bind(key).first<Row>());
  return { fails: row?.fails ?? 1, lockedUntil: row?.locked_until ?? 0, lockouts: row?.lockouts ?? 0, windowStart: row?.window_start ?? now };
}

/** Locks a key: 1 minute, doubling with every lockout in a row, at most `maxSec` (a day). Returns the unlock time. */
export async function lock(db: D1Database, key: string, now: number, lockouts: number, maxSec = LOCK_MAX_SEC): Promise<number> {
  const until = now + Math.min(LOCK_BASE_SEC * 2 ** lockouts, maxSec);
  await db
    .prepare("UPDATE auth_failures SET locked_until = ?2, lockouts = lockouts + 1, fails = 0, window_start = ?3, updated_at = ?3 WHERE key = ?1")
    .bind(key, until, now)
    .run();
  return until;
}

export function clearFailuresStmt(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare("DELETE FROM auth_failures WHERE key = ?").bind(key);
}

/**
 * When the global brake is on for this kind of login, the time it lifts;
 * otherwise 0. Failures at the owners' password pause everyone; the people's
 * failures pause only the people.
 */
export async function globalLockedUntil(db: D1Database, now: number, owner: boolean): Promise<number> {
  const { results } = await db
    .prepare("SELECT locked_until FROM auth_failures WHERE key IN (?1, ?2)")
    .bind(GLOBAL_KEY, owner ? GLOBAL_KEY : PEOPLE_GLOBAL_KEY)
    .all<{ locked_until: number }>();
  const until = Math.max(0, ...results.map((r) => r.locked_until));
  return until > now ? until : 0;
}

/**
 * Whether this network (its keyed hash, from login_events) signed in to this
 * account recently. Such a network skips the global brake and keeps its own
 * per-network lockout, so the owner gets back in during an attack.
 */
export async function knownNetwork(db: D1Database, ipHashHex: string, email: string, now: number): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS ok FROM login_events WHERE ok = 1 AND ip_hash = ?1 AND email = ?2 AND ts > ?3 LIMIT 1").bind(ipHashHex, email, now - KNOWN_NETWORK_SEC).first();
  return row !== null;
}

/**
 * Counts a failure towards its global brake (the owners' or the people's) and
 * applies it at the threshold. Only failures from several networks count: one
 * network is already held back by its own lockout, and must not be able to
 * lock the owner out everywhere. Call it after the failure's login event is written.
 */
export async function recordGlobalFailure(db: D1Database, now: number, owner: boolean): Promise<void> {
  const key = owner ? GLOBAL_KEY : PEOPLE_GLOBAL_KEY;
  const state = await chargeAttempt(db, key, now, GLOBAL_WINDOW_SEC);
  if (state.lockedUntil > now || state.fails < GLOBAL_MAX_FAILS) return;
  const networks = await db
    .prepare("SELECT COUNT(DISTINCT ip_hash) AS n FROM login_events WHERE ok = 0 AND ts > ?")
    .bind(now - GLOBAL_WINDOW_SEC)
    .first<{ n: number }>();
  if ((networks?.n ?? 0) >= GLOBAL_MIN_NETWORKS) {
    await db
      .prepare("UPDATE auth_failures SET locked_until = ?2, fails = 0, window_start = ?3, updated_at = ?3 WHERE key = ?1")
      .bind(key, now + GLOBAL_LOCK_SEC, now)
      .run();
    console.warn(JSON.stringify({ message: "admin login paused", reason: owner ? "global failure limit" : "people's failure limit", until: now + GLOBAL_LOCK_SEC }));
  }
}

/** How a login was completed (or, when it failed, what was tried). */
export type LoginMethod = "password" | "password+totp" | "password+recovery" | "passkey";

/**
 * One login event. Write a successful one only when a session is issued:
 * knownNetwork trusts networks with one, so a network that only knew the
 * password must not get one.
 */
export function loginEventStmt(db: D1Database, ok: boolean, ipHashHex: string, country: string, now: number, email: string, method: LoginMethod = "password"): D1PreparedStatement {
  return db
    .prepare("INSERT INTO login_events (ts, ok, ip_hash, country, email, method) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(now, ok ? 1 : 0, ipHashHex, country, email, method);
}

/** Daily cleanup: old login events, lockout rows nobody has touched for two days, expired sign-in challenges. */
export async function pruneLoginState(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM login_events WHERE ts < ?").bind(now - LOGIN_EVENT_RETENTION_SEC),
    db.prepare("DELETE FROM auth_failures WHERE locked_until <= ?1 AND updated_at < ?2").bind(now, now - 2 * 86400),
    db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    // The prefix range uses the settings primary key; values are expiry times.
    db.prepare("DELETE FROM settings WHERE key >= ?1 AND key < ?2 AND CAST(value AS INTEGER) <= ?3").bind(REVOKED_PREFIX, `${REVOKED_PREFIX}~`, now),
  ]);
}

export interface SecuritySummary {
  failedLogins24h: number;
  lockedNetworks: number;
  globalLockedUntil: number | null;
  recent: { at: number; ok: boolean; country: string; email: string | null; method: LoginMethod | null }[];
  sharedSignIns: { email: string; networks: number }[];
}

export async function securitySummary(db: D1Database, now: number): Promise<SecuritySummary> {
  const [failed, locked, global, recent, shared] = await db.batch<Record<string, number | string>>([
    db.prepare("SELECT COUNT(*) AS n FROM login_events WHERE ok = 0 AND ts >= ?").bind(now - 86400),
    db.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE key NOT LIKE '*%' AND key NOT LIKE 'api:%' AND key NOT LIKE 'pw:%' AND key NOT LIKE 'link:%' AND key NOT LIKE 'share:%' AND key NOT LIKE 'login:%' AND key NOT LIKE 'mfa:%' AND key NOT LIKE 'passkey:%' AND locked_until > ?1").bind(now),
    db.prepare("SELECT locked_until FROM auth_failures WHERE key = ?1 AND locked_until > ?2").bind(GLOBAL_KEY, now),
    db.prepare("SELECT ts, ok, country, email, method FROM login_events ORDER BY ts DESC LIMIT 10"),
    db
      .prepare("SELECT email, COUNT(DISTINCT ip_hash) AS n FROM login_events WHERE ok = 1 AND email IS NOT NULL AND ts >= ?1 GROUP BY email HAVING n > 1 ORDER BY n DESC LIMIT 5")
      .bind(now - KNOWN_NETWORK_SEC),
  ]);
  const until = Number(global?.results[0]?.locked_until ?? 0);
  return {
    failedLogins24h: Number(failed?.results[0]?.n ?? 0),
    lockedNetworks: Number(locked?.results[0]?.n ?? 0),
    globalLockedUntil: until > 0 ? until : null,
    recent: (recent?.results ?? []).map((r) => ({ at: Number(r.ts), ok: Number(r.ok) === 1, country: String(r.country ?? ""), email: r.email ? String(r.email) : null, method: r.method ? (String(r.method) as LoginMethod) : null })),
    sharedSignIns: (shared?.results ?? []).map((r) => ({ email: String(r.email), networks: Number(r.n) })),
  };
}

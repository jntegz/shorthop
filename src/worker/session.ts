// Admin password sessions, verification and brute-force state.
// A session is only valid together with the identity it was issued to: the
// Access login, or the fixed password-only identity when Access is off.

import {
  GLOBAL_LOCK_SEC,
  GLOBAL_MAX_FAILS,
  GLOBAL_WINDOW_SEC,
  LOCK_BASE_SEC,
  LOCK_MAX_SEC,
  LOGIN_EVENT_RETENTION_SEC,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  WINDOW_SEC,
} from "../shared/login-policy";
import { derivePassword, fromBase64Url, MAX_PASSWORD_LENGTH, parsePasswordHash, toBase64Url, type PasswordHash } from "../shared/password";
import { getSetting, setSettingStmt } from "./db";

export interface LoginConfig {
  password: PasswordHash;
  secret: string;
}

const MIN_SECRET_LENGTH = 32;
const VERSION = "v1";
const GLOBAL_KEY = "*";

/** The password login settings, or null when they're missing or malformed (callers fail closed). */
export function loginConfig(env: Env): LoginConfig | null {
  const secret = env.SESSION_SECRET ?? "";
  const password = parsePasswordHash(env.ADMIN_PASSWORD_HASH ?? "");
  if (secret.length < MIN_SECRET_LENGTH || !password) return null;
  return { password, secret };
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

/** Constant-time password check against the stored PBKDF2 hash. */
export async function verifyPassword(password: string, cfg: LoginConfig): Promise<boolean> {
  if (!password || password.length > MAX_PASSWORD_LENGTH) return false;
  const derived = await derivePassword(password, cfg.password.salt, cfg.password.iterations);
  return crypto.subtle.timingSafeEqual(derived, cfg.password.hash);
}

// --- Sessions -----------------------------------------------------------------

async function getEpoch(db: D1Database): Promise<string> {
  return (await getSetting(db, "session_epoch")) ?? "0";
}

/** Invalidates every session at once: the epoch is part of each signed cookie. */
export async function revokeAllSessions(db: D1Database): Promise<void> {
  await setSettingStmt(db, "session_epoch", crypto.randomUUID()).run();
}

const sessionPayload = (exp: number, epoch: string, email: string) => `${VERSION}|${exp}|${epoch}|${email}`;

export async function issueSessionCookie(
  db: D1Database,
  cfg: LoginConfig,
  email: string,
  now: number,
): Promise<{ cookie: string; exp: number }> {
  const exp = now + SESSION_TTL_SEC;
  const epoch = await getEpoch(db);
  const mac = toBase64Url(await sign(cfg.secret, sessionPayload(exp, epoch, email)));
  return {
    cookie: `${SESSION_COOKIE}=${VERSION}.${exp}.${epoch}.${mac}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}`,
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

/** Returns the session's expiry if the cookie is valid for this identity. */
export async function readSession(
  request: Request,
  db: D1Database,
  cfg: LoginConfig,
  email: string,
  now: number,
): Promise<{ exp: number } | null> {
  const raw = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!raw) return null;
  const [version, expRaw, epoch, macRaw, ...rest] = raw.split(".");
  if (version !== VERSION || !expRaw || !epoch || !macRaw || rest.length) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= now || exp > now + SESSION_TTL_SEC) return null;
  const mac = fromBase64Url(macRaw);
  if (!mac) return null;
  // The MAC is checked first (constant time), so junk cookies never reach D1.
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(cfg.secret), mac, encoder.encode(sessionPayload(exp, epoch, email)));
  if (!valid || epoch !== (await getEpoch(db))) return null;
  return { exp };
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
}

// Counts an attempt atomically before the password is checked, so parallel
// guesses can't all slip in under the limit. Attempts made while a key is
// locked aren't counted; lockouts reset after a quiet day.
const CHARGE = `INSERT INTO auth_failures (key, fails, window_start, locked_until, lockouts, updated_at)
VALUES (?1, 1, ?2, 0, 0, ?2)
ON CONFLICT (key) DO UPDATE SET
  lockouts     = CASE WHEN ?2 - updated_at > 86400 THEN 0 ELSE lockouts END,
  fails        = CASE WHEN locked_until > ?2 THEN fails WHEN ?2 - window_start > ?3 THEN 1 ELSE fails + 1 END,
  window_start = CASE WHEN locked_until > ?2 THEN window_start WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END,
  updated_at   = ?2
RETURNING fails, locked_until, lockouts`;

export async function chargeAttempt(db: D1Database, key: string, now: number, windowSec = WINDOW_SEC): Promise<AttemptState> {
  const row = await db
    .prepare(CHARGE)
    .bind(key, now, windowSec)
    .first<{ fails: number; locked_until: number; lockouts: number }>();
  return { fails: row?.fails ?? 1, lockedUntil: row?.locked_until ?? 0, lockouts: row?.lockouts ?? 0 };
}

/** Locks a key: 1 minute, doubling with every lockout in a row, at most a day. Returns the unlock time. */
export async function lock(db: D1Database, key: string, now: number, lockouts: number): Promise<number> {
  const until = now + Math.min(LOCK_BASE_SEC * 2 ** lockouts, LOCK_MAX_SEC);
  await db
    .prepare("UPDATE auth_failures SET locked_until = ?2, lockouts = lockouts + 1, fails = 0, window_start = ?3, updated_at = ?3 WHERE key = ?1")
    .bind(key, until, now)
    .run();
  return until;
}

export function clearFailuresStmt(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare("DELETE FROM auth_failures WHERE key = ?").bind(key);
}

/** When the global brake is on, the time it lifts; otherwise 0. */
export async function globalLockedUntil(db: D1Database, now: number): Promise<number> {
  const row = await db.prepare("SELECT locked_until FROM auth_failures WHERE key = ?").bind(GLOBAL_KEY).first<{ locked_until: number }>();
  return row && row.locked_until > now ? row.locked_until : 0;
}

/** Counts a failure towards the global brake and applies it at the threshold. */
export async function recordGlobalFailure(db: D1Database, now: number): Promise<void> {
  const state = await chargeAttempt(db, GLOBAL_KEY, now, GLOBAL_WINDOW_SEC);
  if (state.lockedUntil <= now && state.fails >= GLOBAL_MAX_FAILS) {
    await db
      .prepare("UPDATE auth_failures SET locked_until = ?2, fails = 0, window_start = ?3, updated_at = ?3 WHERE key = ?1")
      .bind(GLOBAL_KEY, now + GLOBAL_LOCK_SEC, now)
      .run();
    console.warn(JSON.stringify({ message: "admin login paused", reason: "global failure limit", until: now + GLOBAL_LOCK_SEC }));
  }
}

export function loginEventStmt(db: D1Database, ok: boolean, ipHashHex: string, country: string, now: number): D1PreparedStatement {
  return db.prepare("INSERT INTO login_events (ts, ok, ip_hash, country) VALUES (?, ?, ?, ?)").bind(now, ok ? 1 : 0, ipHashHex, country);
}

/** Daily cleanup: old login events and lockout rows nobody has touched for two days. */
export async function pruneLoginState(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM login_events WHERE ts < ?").bind(now - LOGIN_EVENT_RETENTION_SEC),
    db.prepare("DELETE FROM auth_failures WHERE locked_until <= ?1 AND updated_at < ?2").bind(now, now - 2 * 86400),
  ]);
}

export interface SecuritySummary {
  failedLogins24h: number;
  lockedNetworks: number;
  globalLockedUntil: number | null;
  recent: { at: number; ok: boolean; country: string }[];
}

export async function securitySummary(db: D1Database, now: number): Promise<SecuritySummary> {
  const [failed, locked, global, recent] = await db.batch<Record<string, number | string>>([
    db.prepare("SELECT COUNT(*) AS n FROM login_events WHERE ok = 0 AND ts >= ?").bind(now - 86400),
    db.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE key != ?1 AND locked_until > ?2").bind(GLOBAL_KEY, now),
    db.prepare("SELECT locked_until FROM auth_failures WHERE key = ?1 AND locked_until > ?2").bind(GLOBAL_KEY, now),
    db.prepare("SELECT ts, ok, country FROM login_events ORDER BY ts DESC LIMIT 8"),
  ]);
  const until = Number(global?.results[0]?.locked_until ?? 0);
  return {
    failedLogins24h: Number(failed?.results[0]?.n ?? 0),
    lockedNetworks: Number(locked?.results[0]?.n ?? 0),
    globalLockedUntil: until > 0 ? until : null,
    recent: (recent?.results ?? []).map((r) => ({ at: Number(r.ts), ok: Number(r.ok) === 1, country: String(r.country ?? "") })),
  };
}

// Admin authentication. Every path is verified here in the Worker, never
// only at the edge, and all of them fail closed when configuration is missing.
//   /_admin, /_admin/api  Cloudflare Access JWT + password session (owners and
//                         the people in the users table), or the owner's
//                         password session alone when ADMIN_AUTH is "password"
//   /api                  Bearer: a personal API key, or the API_TOKEN secret

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { API_MAX_FAILS, API_WINDOW_SEC } from "../shared/login-policy";
import { PERMISSIONS, type Actor } from "../shared/permissions";
import { nowSec } from "./db";
import { isLocalHost } from "./domains";
import { chargeAttempt, ipBucket, lock, loginConfig, parseSessionCookie, sessionState } from "./session";
import { actorLabel, findApiKey, OWNER_EPOCH, ownerActor, ownerEmails, PASSWORD_IDENTITY, touchApiKeyStmt, userActor } from "./users";

type AuthFailure = { ok: false; status: 401 | 403 | 429 | 500; reason: string; code?: "login_required" | "not_allowed" };

export type AuthResult = { ok: true; actor: Actor; identity: string; sessionExp?: number } | AuthFailure;

/** Enough of an execution context to finish work after the response. */
export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/** Who is asking, before the password. Whether they're let in is decided afterwards. */
export type AccessResult = { ok: true; email: string; owner: boolean } | AuthFailure;

// Cached per team domain for the life of the isolate (keys, not request state).
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function teamOrigin(domain: string): string | null {
  const host = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) ? `https://${host}` : null;
}

function jwksFor(origin: string): JWTVerifyGetKey {
  let jwks = jwksByTeam.get(origin);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${origin}/cdn-cgi/access/certs`));
    jwksByTeam.set(origin, jwks);
  }
  return jwks;
}

function splitList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Local development only: requires both a localhost URL and the explicit flag. */
export function isDevBypass(request: Request, env: Env): boolean {
  return env.DEV_AUTH_BYPASS === "1" && isLocalHost(new URL(request.url).hostname);
}

export const NOT_ALLOWED: AuthFailure = { ok: false, status: 403, reason: "This account is not allowed.", code: "not_allowed" };
const LOGIN_REQUIRED: AuthFailure = { ok: false, status: 401, reason: "Log in with your password.", code: "login_required" };

const DEV_IDENTITY = "dev@localhost";

export type AdminAuthMode = "access+password" | "password";

/**
 * ADMIN_AUTH: empty or "access+password" keeps Cloudflare Access in front of the
 * password; only the exact value "password" turns Access off. Anything else is
 * a typo, and null makes every admin request fail.
 */
export function adminAuthMode(env: Env): AdminAuthMode | null {
  const v = env.ADMIN_AUTH ?? "";
  if (v === "" || v === "access+password") return "access+password";
  if (v === "password") return "password";
  return null;
}

/** All Access settings are present (they may still be wrong). */
export function accessConfigured(env: Env): boolean {
  return Boolean(teamOrigin(env.ACCESS_TEAM_DOMAIN ?? "") && splitList(env.ACCESS_AUD).length && splitList(env.ADMIN_EMAIL).length);
}

/**
 * Who is asking, before the password: the dev bypass on localhost (an owner,
 * or DEV_AUTH_EMAIL to try someone else's view), the owner when Access is off
 * (people can only be told apart by their Access email), or the Access login.
 */
export async function verifyIdentity(request: Request, env: Env): Promise<AccessResult> {
  if (isDevBypass(request, env)) {
    const email = (env.DEV_AUTH_EMAIL ?? "").trim().toLowerCase() || DEV_IDENTITY;
    return { ok: true, email, owner: email === DEV_IDENTITY || ownerEmails(env).includes(email) };
  }
  const mode = adminAuthMode(env);
  if (!mode) return { ok: false, status: 500, reason: 'ADMIN_AUTH must be empty, "access+password" or "password".' };
  if (mode === "password") return { ok: true, email: PASSWORD_IDENTITY, owner: true };
  return verifyAccess(request, env);
}

/**
 * Verifies the Cloudflare Access JWT. Owners (ADMIN_EMAIL) are marked; anyone
 * else must also have a users row, which the session check reads.
 */
async function verifyAccess(request: Request, env: Env): Promise<AccessResult> {
  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN ?? "");
  const audiences = splitList(env.ACCESS_AUD);
  const owners = ownerEmails(env);
  if (!origin || audiences.length === 0 || owners.length === 0) {
    return { ok: false, status: 500, reason: "Admin access is not configured." };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, reason: "Missing Cloudflare Access token." };

  try {
    const { payload } = await jwtVerify(token, jwksFor(origin), { issuer: origin, audience: audiences, algorithms: ["RS256"] });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) return NOT_ALLOWED;
    return { ok: true, email, owner: owners.includes(email) };
  } catch {
    return { ok: false, status: 401, reason: "Invalid Cloudflare Access token." };
  }
}

/**
 * The password session for an identity, with one D1 round trip: the global
 * epoch, whether this session was logged out, and the person's row unless
 * they're an owner. Roles and permissions are read on every request, so
 * changes apply at once. On localhost with the dev bypass, the password is
 * still required when ADMIN_PASSWORD_HASH is set, so the login can be tested.
 */
export async function verifySession(request: Request, env: Env, access: { email: string; owner: boolean }): Promise<AuthResult> {
  const cfg = loginConfig(env);
  // Local development without a password: the admin is open on localhost only.
  const unconfigured: AuthFailure | null = cfg || isDevBypass(request, env) ? null : { ok: false, status: 500, reason: "Admin password is not configured." };
  const cookie = cfg ? await parseSessionCookie(request, cfg, access.email, nowSec()) : null;

  if (access.owner) {
    if (!cfg) return unconfigured ?? { ok: true, actor: ownerActor(access.email), identity: access.email };
    if (!cookie || cookie.user !== OWNER_EPOCH) return LOGIN_REQUIRED;
    const { epoch, revoked } = await sessionState(env.DB, cookie.mac, null);
    if (revoked || cookie.global !== epoch) return LOGIN_REQUIRED;
    return { ok: true, actor: ownerActor(access.email), identity: access.email, sessionExp: cookie.exp };
  }

  const { epoch, revoked, user } = await sessionState(env.DB, cookie?.mac ?? null, access.email);
  if (!user) return NOT_ALLOWED;
  if (!cfg) return unconfigured ?? { ok: true, actor: userActor(user), identity: user.email };
  if (!cookie || revoked || cookie.global !== epoch || cookie.user !== user.session_epoch) return LOGIN_REQUIRED;
  return { ok: true, actor: userActor(user), identity: user.email, sessionExp: cookie.exp };
}

/** The admin check: the identity first (Cloudflare Access unless turned off), then the password session bound to it. */
export async function verifyAdmin(request: Request, env: Env): Promise<AuthResult> {
  const access = await verifyIdentity(request, env);
  if (!access.ok) return access;
  return verifySession(request, env, access);
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

/** Constant-time comparison: hash both sides so lengths always match. */
export async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  if (!expected || expected.length < 16) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The API_TOKEN secret: optional since personal keys exist, so it's read loosely. */
export function legacyApiToken(env: Env): string {
  return (env as unknown as { API_TOKEN?: string }).API_TOKEN ?? "";
}

/** The auth_failures key of a client network: a keyed hash, so no IP address is stored. */
async function apiFailureKey(env: Env, ip: string): Promise<string> {
  const digest = new Uint8Array(await sha256(`api-ip|${env.SESSION_SECRET ?? ""}|${legacyApiToken(env)}|${ip}`));
  let hex = "";
  for (const b of digest.slice(0, 16)) hex += b.toString(16).padStart(2, "0");
  return `api:${hex}`;
}

const TOO_MANY = "Too many failed attempts. Try again later.";

/**
 * Verifies "Authorization: Bearer …": a personal key (shp_…) or the API_TOKEN
 * secret. A network that sent too many wrong credentials is locked in D1 and
 * refused before anything is even compared, so it can't keep guessing.
 */
export async function verifyBearer(request: Request, env: Env, ctx?: WaitUntil): Promise<AuthResult> {
  // Per /64 for IPv6, so rotating addresses inside one allocation doesn't escape the limit.
  const ip = ipBucket(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const key = await apiFailureKey(env, ip);
  const now = nowSec();
  const locked = await env.DB.prepare("SELECT locked_until FROM auth_failures WHERE key = ?").bind(key).first<{ locked_until: number }>();
  if (locked && locked.locked_until > now) return { ok: false, status: 429, reason: TOO_MANY };

  const header = request.headers.get("Authorization") ?? "";
  const presented = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? "";
  if (presented.startsWith("shp_")) {
    const found = await findApiKey(env, presented, now);
    if (found) {
      const { actor, lastUsedAt } = found;
      if (actor.key && (lastUsedAt === null || lastUsedAt < now - 3600)) {
        const touch = touchApiKeyStmt(env.DB, actor.key.id, now).run();
        if (ctx) ctx.waitUntil(touch);
        else await touch;
      }
      return { ok: true, actor, identity: actorLabel(actor) };
    }
  } else if (presented && (await tokenMatches(presented, legacyApiToken(env)))) {
    const actor: Actor = { email: "api-token", name: "API token", role: "admin", owner: true, permissions: [...PERMISSIONS], via: "token" };
    return { ok: true, actor, identity: actorLabel(actor) };
  }

  // A burst brake per location, then the lock that counts.
  try {
    const { success } = await env.AUTH_LIMITER.limit({ key: `auth:${ip}` });
    if (!success) return { ok: false, status: 429, reason: TOO_MANY };
  } catch (err) {
    console.error(JSON.stringify({ message: "rate limiter failed", error: String(err) }));
  }
  // The failure that reaches the limit locks the network; its next request gets a 429.
  const state = await chargeAttempt(env.DB, key, now, API_WINDOW_SEC);
  if (state.fails >= API_MAX_FAILS) await lock(env.DB, key, now, state.lockouts);
  return { ok: false, status: 401, reason: "Missing or invalid API key." };
}

/**
 * API_TOKEN_SCOPE: only the exact value "full" lets the API_TOKEN secret change
 * and delete links and settings. Anything else keeps the default: read, create
 * links, import new ones and send a test digest. Personal keys carry their own
 * permissions instead.
 */
export function fullTokenScope(env: Env): boolean {
  return env.API_TOKEN_SCOPE === "full";
}

export const TOKEN_SCOPE_ERROR = 'Not available with the API token, which can read and create links. Use the admin, a personal API key, or set API_TOKEN_SCOPE to "full".';

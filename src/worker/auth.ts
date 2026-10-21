// Admin authentication. Every path is verified here in the Worker, never
// only at the edge, and all of them fail closed when configuration is missing.
//   /_admin, /_admin/api  Cloudflare Access JWT + admin password session, or the
//                         password session alone when ADMIN_AUTH is "password"
//   /api                  Bearer token

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { nowSec } from "./db";
import { isLocalHost } from "./domains";
import { ipBucket, loginConfig, readSession } from "./session";

export type AuthResult =
  | { ok: true; identity: string; sessionExp?: number }
  | { ok: false; status: 401 | 403 | 429 | 500; reason: string; code?: "login_required" };

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

const DEV_IDENTITY = "dev@localhost";
/** The identity of password-only sessions. Not an email, so it never matches an Access login. */
const PASSWORD_IDENTITY = "admin";

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
 * Who is asking, before the password: the dev bypass on localhost, the fixed
 * password-only identity, or the Cloudflare Access login.
 */
export async function verifyIdentity(request: Request, env: Env): Promise<AuthResult> {
  if (isDevBypass(request, env)) return { ok: true, identity: DEV_IDENTITY };
  const mode = adminAuthMode(env);
  if (!mode) return { ok: false, status: 500, reason: 'ADMIN_AUTH must be empty, "access+password" or "password".' };
  if (mode === "password") return { ok: true, identity: PASSWORD_IDENTITY };
  return verifyAccess(request, env);
}

/** Verifies the Cloudflare Access JWT and that it belongs to the admin. */
async function verifyAccess(request: Request, env: Env): Promise<AuthResult> {
  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN ?? "");
  const audiences = splitList(env.ACCESS_AUD);
  const admins = splitList(env.ADMIN_EMAIL).map((e) => e.toLowerCase());
  if (!origin || audiences.length === 0 || admins.length === 0) {
    return { ok: false, status: 500, reason: "Admin access is not configured." };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 401, reason: "Missing Cloudflare Access token." };

  try {
    const { payload } = await jwtVerify(token, jwksFor(origin), { issuer: origin, audience: audiences, algorithms: ["RS256"] });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email || !admins.includes(email)) return { ok: false, status: 403, reason: "This account is not allowed." };
    return { ok: true, identity: email };
  } catch {
    return { ok: false, status: 401, reason: "Invalid Cloudflare Access token." };
  }
}

/**
 * The admin check: the identity first (Cloudflare Access unless turned off),
 * then the password session bound to that identity. On localhost with the dev
 * bypass, the password is still required when ADMIN_PASSWORD_HASH is set, so
 * the login can be tested locally.
 */
export async function verifyAdmin(request: Request, env: Env): Promise<AuthResult> {
  const access = await verifyIdentity(request, env);
  if (!access.ok) return access;
  const cfg = loginConfig(env);
  if (!cfg) {
    if (isDevBypass(request, env)) return access;
    return { ok: false, status: 500, reason: "Admin password is not configured." };
  }
  const session = await readSession(request, env.DB, cfg, access.identity, nowSec());
  if (!session) return { ok: false, status: 401, reason: "Log in with your admin password.", code: "login_required" };
  return { ok: true, identity: access.identity, sessionExp: session.exp };
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

/** Constant-time comparison: hash both sides so lengths always match. */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  if (!expected || expected.length < 16) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Verifies "Authorization: Bearer <API_TOKEN>", rate-limiting failures per IP. */
export async function verifyBearer(request: Request, env: Env): Promise<AuthResult> {
  if (!env.API_TOKEN || env.API_TOKEN.length < 16) {
    return { ok: false, status: 500, reason: "API token is not configured." };
  }
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (match?.[1] && (await tokenMatches(match[1], env.API_TOKEN))) return { ok: true, identity: "api-token" };

  // Per /64 for IPv6, so rotating addresses inside one allocation doesn't escape the limit.
  const ip = ipBucket(request.headers.get("CF-Connecting-IP") ?? "unknown");
  try {
    const { success } = await env.AUTH_LIMITER.limit({ key: `auth:${ip}` });
    if (!success) return { ok: false, status: 429, reason: "Too many failed attempts. Try again in a minute." };
  } catch (err) {
    console.error(JSON.stringify({ message: "rate limiter failed", error: String(err) }));
  }
  return { ok: false, status: 401, reason: "Missing or invalid API token." };
}

/**
 * API_TOKEN_SCOPE: only the exact value "full" lets the token change and delete
 * links and settings. Anything else keeps the default: read, create links,
 * import new ones and send a test digest.
 */
export function fullTokenScope(env: Env): boolean {
  return env.API_TOKEN_SCOPE === "full";
}

export const TOKEN_SCOPE_ERROR = 'Not available with the API token, which can read and create links. Use the admin, or set API_TOKEN_SCOPE to "full".';

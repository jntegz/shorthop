// Cloudflare Access and login helpers for the sign-in tests: signed Access
// JWTs (certs served by a mocked fetch), form posts, admin API calls with a
// session cookie, and the cookies a response sets.

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { hashPassword } from "../src/shared/password";
import { call, ORIGIN, resetData } from "./helpers";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-123";
export const OWNER = "owner@example.com";
export const PERSON = "ana@example.com";
export const PASSWORD = "correct-horse-battery-staple-2026"; // gitleaks:allow (test fixture)
const ALLOW_ALL = { limit: async () => ({ success: true }) } as RateLimit;

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };
/** Access and the owners' password configured; the burst limiter open. */
export let LOGIN_ENV: Partial<Env>;

/** Call once per test file: keys, env, a data reset and the mocked Access certs before each test. */
export function useAccess(): void {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
    LOGIN_ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: OWNER, ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD, 10_000), LOGIN_LIMITER: ALLOW_ALL };
  });
  beforeEach(async () => {
    await resetData();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify(jwks), { headers: { "Content-Type": "application/json" } });
      return real(input, init);
    });
  });
  afterEach(() => vi.restoreAllMocks());
}

export const jwtFor = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("1h").sign(privateKey);

/** "name=value" of every cookie a response sets, by name. */
export function cookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0]!;
    out[pair.slice(0, pair.indexOf("="))] = pair;
  }
  return out;
}

export function form(path: string, jwt: string, fields: Record<string, string>, cookie = ""): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": jwt,
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
      "CF-Connecting-IP": "203.0.113.50",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

export function page(path: string, jwt: string, cookie = ""): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { "Cf-Access-Jwt-Assertion": jwt, ...(cookie ? { Cookie: cookie } : {}) } });
}

/** Same-origin JSON to a login page endpoint (the passkey sign-in). */
export function loginJson(path: string, jwt: string, body: unknown, cookie = ""): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": jwt, Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.50", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

export function api(path: string, jwt: string, cookie: string, init: { method?: string; body?: unknown } = {}): Request {
  return new Request(`${ORIGIN}/_admin/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Cf-Access-Jwt-Assertion": jwt, Cookie: cookie, Origin: ORIGIN, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export const run = (req: Request) => call(req, undefined, LOGIN_ENV);

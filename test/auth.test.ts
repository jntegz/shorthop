import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { API_LOCK_MAX_SEC, SESSION_TTL_SEC } from "../src/shared/login-policy";
import { hashPassword } from "../src/shared/password";
import { nowSec } from "../src/worker/db";
import { safeNext } from "../src/worker/login";
import { getEpoch, globalLockedUntil, ipBucket, issueSessionCookie, lock, loginConfig, loginEventStmt, recordGlobalFailure } from "../src/worker/session";
import { OWNER_EPOCH } from "../src/worker/users";
import { bearer, call, ORIGIN, resetData } from "./helpers";
import { addKey } from "./people";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const ACCESS_ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: "Owner@Example.com" };
const PASSWORD = "correct-horse-battery-staple-2026"; // gitleaks:allow (test fixture)
const ALLOW_ALL = { limit: async () => ({ success: true }) } as RateLimit;

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };
let HASH: string;
/** Access + password configured; the burst limiter is opened unless a test needs it. */
let LOGIN_ENV: Partial<Env>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
  HASH = await hashPassword(PASSWORD, 10_000);
  LOGIN_ENV = { ...ACCESS_ENV, ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: ALLOW_ALL };
});

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

function mockCerts() {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify(jwks), { headers: { "Content-Type": "application/json" } });
    }
    return real(input, init);
  });
}

async function token(claims: { email?: string; aud?: string; iss?: string; exp?: string }) {
  return new SignJWT({ email: claims.email ?? "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(claims.exp ?? "1h")
    .sign(privateKey);
}

const admin = (jwt?: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}/_admin/api/links`, {
    ...init,
    headers: { ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}), ...(init.headers as Record<string, string>) },
  });

function loginRequest(jwt: string | undefined, password: string, opts: { ip?: string; next?: string; headers?: Record<string, string> } = {}) {
  return new Request(`${ORIGIN}/_admin/login`, {
    method: "POST",
    headers: {
      ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {}),
      "Content-Type": "application/x-www-form-urlencoded",
      "Sec-Fetch-Site": "same-origin",
      "CF-Connecting-IP": opts.ip ?? "203.0.113.50",
      ...opts.headers,
    },
    body: new URLSearchParams({ password, next: opts.next ?? "/_admin/links" }).toString(),
  });
}

/** Logs in and returns the "name=value" part of the session cookie. */
async function sessionCookie(jwt: string, envOverride: Partial<Env> = LOGIN_ENV): Promise<string> {
  const res = await call(loginRequest(jwt, PASSWORD), undefined, envOverride);
  expect(res.status).toBe(303);
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
}

const withCookie = (cookie: string, jwt: string, init: RequestInit = {}) =>
  admin(jwt, { ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });

async function failureRows() {
  return (await env.DB.prepare("SELECT * FROM auth_failures").all()).results;
}

describe("Cloudflare Access", () => {
  it("fails closed when Access is not configured, even with the dev flag off-localhost", async () => {
    expect((await call(admin())).status).toBe(500);
    expect((await call(admin(), undefined, { DEV_AUTH_BYPASS: "1" })).status).toBe(500);
    const shell = await call(`${ORIGIN}/_admin/`, undefined, { DEV_AUTH_BYPASS: "1" });
    expect(shell.status).toBe(403);
  });

  it("allows the dev bypass only on localhost", async () => {
    const res = await call(new Request("http://localhost:5173/_admin/api/links"), undefined, { DEV_AUTH_BYPASS: "1" });
    expect(res.status).toBe(200);
  });

  it("accepts a valid token plus password session for the admin email (case-insensitive)", async () => {
    mockCerts();
    const jwt = await token({});
    const cookie = await sessionCookie(jwt);
    const res = await call(withCookie(cookie, jwt), undefined, LOGIN_ENV);
    expect(res.status).toBe(200);
  });

  it("rejects missing, foreign, expired or mis-addressed tokens", async () => {
    mockCerts();
    expect((await call(admin(), undefined, ACCESS_ENV)).status).toBe(401);
    expect((await call(admin(await token({ email: "someone@else.com" })), undefined, ACCESS_ENV)).status).toBe(403);
    expect((await call(admin(await token({ aud: "other" })), undefined, ACCESS_ENV)).status).toBe(401);
    expect((await call(admin(await token({ iss: "https://evil.cloudflareaccess.com" })), undefined, ACCESS_ENV)).status).toBe(401);
    expect((await call(admin(await token({ exp: "-1m" })), undefined, ACCESS_ENV)).status).toBe(401);
    expect((await call(admin("not.a.jwt"), undefined, ACCESS_ENV)).status).toBe(401);
  });

  it("blocks cross-site form posts (CSRF)", async () => {
    mockCerts();
    const jwt = await token({});
    const res = await call(
      admin(jwt, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "text/plain" }, body: "{}" }),
      undefined,
      LOGIN_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("does not accept the API token on the admin path", async () => {
    const res = await call(
      new Request(`${ORIGIN}/_admin/api/links`, { headers: { Authorization: "Bearer test-api-token-0123456789abcdef" } }),
      undefined,
      ACCESS_ENV,
    );
    expect(res.status).toBe(401);
  });
});

describe("admin password", () => {
  it("requires a password session after Access, on the API and the shell", async () => {
    mockCerts();
    const jwt = await token({});
    const api = await call(admin(jwt), undefined, LOGIN_ENV);
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ code: "login_required" });

    const shell = await call(new Request(`${ORIGIN}/_admin/links?q=x`, { headers: { "Cf-Access-Jwt-Assertion": jwt } }), undefined, LOGIN_ENV);
    expect(shell.status).toBe(303);
    expect(shell.headers.get("Location")).toBe("/_admin/login?next=%2F_admin%2Flinks%3Fq%3Dx");
  });

  it("logs in with the right password and sets a strict session cookie", async () => {
    mockCerts();
    const jwt = await token({});
    const res = await call(loginRequest(jwt, PASSWORD), undefined, LOGIN_ENV);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/_admin/links");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^__Host-sh_admin=v2\./);
    for (const flag of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", `Max-Age=${SESSION_TTL_SEC}`]) expect(cookie).toContain(flag);

    const events = await env.DB.prepare("SELECT ok FROM login_events").all<{ ok: number }>();
    expect(events.results).toEqual([{ ok: 1 }]);
  });

  it("only accepts the session together with the Access identity it was issued to", async () => {
    mockCerts();
    const twoAdmins = { ...LOGIN_ENV, ADMIN_EMAIL: "owner@example.com,other@example.com" };
    const cookie = await sessionCookie(await token({}), twoAdmins);
    const res = await call(withCookie(cookie, await token({ email: "other@example.com" })), undefined, twoAdmins);
    expect(res.status).toBe(401);
  });

  it("rejects tampered and expired cookies", async () => {
    mockCerts();
    const jwt = await token({});
    const cookie = await sessionCookie(jwt);
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA");
    expect((await call(withCookie(tampered, jwt), undefined, LOGIN_ENV)).status).toBe(401);

    const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
    const old = await issueSessionCookie(cfg, "owner@example.com", { global: await getEpoch(env.DB), user: OWNER_EPOCH }, nowSec() - SESSION_TTL_SEC - 10);
    expect((await call(withCookie(old.cookie.split(";")[0]!, jwt), undefined, LOGIN_ENV)).status).toBe(401);
  });

  it("rejects a wrong password and logs it without the IP address", async () => {
    mockCerts();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call(loginRequest(await token({}), "wrong-password", { ip: "198.51.100.23" }), undefined, LOGIN_ENV);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("4 attempts left");

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("admin login failed");
    expect(logged).toContain("ipHash");
    expect(logged).not.toContain("198.51.100.23");
    const stored = JSON.stringify([await failureRows(), (await env.DB.prepare("SELECT * FROM login_events").all()).results]);
    expect(stored).not.toContain("198.51.100.23");
  });

  it("locks a network after 5 wrong passwords, doubling with each lockout", async () => {
    mockCerts();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const jwt = await token({});
    const attempt = (pw: string) => call(loginRequest(jwt, pw, { ip: "198.51.100.7" }), undefined, LOGIN_ENV);

    for (let i = 0; i < 4; i++) expect((await attempt("nope")).status).toBe(401);
    const locked = await attempt("nope");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThanOrEqual(59);
    expect(Number(locked.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
    // Even the right password waits out the lock.
    expect((await attempt(PASSWORD)).status).toBe(429);

    // The lock ends: five more wrong passwords lock for twice as long.
    await env.DB.prepare("UPDATE auth_failures SET locked_until = 0 WHERE key != '*'").run();
    for (let i = 0; i < 4; i++) expect((await attempt("nope")).status).toBe(401);
    const second = await attempt("nope");
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThanOrEqual(119);

    // Other networks can still log in; a success clears the network's record.
    expect((await call(loginRequest(jwt, PASSWORD, { ip: "198.51.100.8" }), undefined, LOGIN_ENV)).status).toBe(303);
    await env.DB.prepare("UPDATE auth_failures SET locked_until = 0 WHERE key != '*'").run();
    expect((await attempt(PASSWORD)).status).toBe(303);
    const rows = (await failureRows()) as { key: string }[];
    expect(rows.filter((r) => r.key !== "*")).toEqual([]);
  });

  it("pauses every login after 30 failures in an hour", async () => {
    mockCerts();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const jwt = await token({});
    for (let i = 0; i < 30; i++) {
      expect((await call(loginRequest(jwt, "nope", { ip: `192.0.2.${i + 1}` }), undefined, LOGIN_ENV)).status).toBe(401);
    }
    const res = await call(loginRequest(jwt, PASSWORD, { ip: "192.0.2.200" }), undefined, LOGIN_ENV);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Logins are paused");
  });

  it("brakes bursts per location with the rate-limit binding", async () => {
    mockCerts();
    const jwt = await token({});
    const withLimiter = { ...LOGIN_ENV, LOGIN_LIMITER: env.LOGIN_LIMITER };
    for (let i = 0; i < 5; i++) {
      expect((await call(loginRequest(jwt, PASSWORD, { ip: "198.51.100.99" }), undefined, withLimiter)).status).toBe(303);
    }
    expect((await call(loginRequest(jwt, PASSWORD, { ip: "198.51.100.99" }), undefined, withLimiter)).status).toBe(429);
  });

  it("doesn't count cross-site posts or requests without Access", async () => {
    mockCerts();
    const jwt = await token({});
    const crossSite = await call(
      loginRequest(jwt, "nope", { headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } }),
      undefined,
      LOGIN_ENV,
    );
    expect(crossSite.status).toBe(403);
    expect((await call(loginRequest(undefined, "nope"), undefined, LOGIN_ENV)).status).toBe(403);
    expect(await failureRows()).toEqual([]);
  });

  it("logs out everywhere, but not with the API token", async () => {
    mockCerts();
    const jwt = await token({});
    const cookie = await sessionCookie(jwt);
    const revoke = await call(
      new Request(`${ORIGIN}/_admin/api/settings/sessions/revoke`, {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": jwt, Cookie: cookie, Origin: ORIGIN },
      }),
      undefined,
      LOGIN_ENV,
    );
    expect(revoke.status).toBe(200);
    expect(revoke.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call(withCookie(cookie, jwt), undefined, LOGIN_ENV)).status).toBe(401);

    const viaToken = await call(`${ORIGIN}/api/settings/sessions/revoke`, {
      method: "POST",
      headers: { Authorization: "Bearer test-api-token-0123456789abcdef" },
    });
    expect(viaToken.status).toBe(403);
  });

  it("fails closed when the password settings are missing or invalid", async () => {
    mockCerts();
    const jwt = await token({});
    const broken: Partial<Env>[] = [
      { ADMIN_PASSWORD_HASH: "" },
      { ADMIN_PASSWORD_HASH: "pbkdf2-sha256:200000:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { ADMIN_PASSWORD_HASH: "plaintext-password" },
      { SESSION_SECRET: "too-short" },
    ];
    for (const override of broken) {
      const e = { ...LOGIN_ENV, ...override };
      expect((await call(admin(jwt), undefined, e)).status).toBe(500);
      expect((await call(loginRequest(jwt, PASSWORD), undefined, e)).status).toBe(403);
    }
  });

  it("still asks for the password on localhost when one is set", async () => {
    const local = { DEV_AUTH_BYPASS: "1", ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: ALLOW_ALL };
    const api = await call(new Request("http://localhost:5173/_admin/api/links"), undefined, local);
    expect(api.status).toBe(401);
    const res = await call(
      new Request("http://localhost:5173/_admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
        body: new URLSearchParams({ password: PASSWORD }).toString(),
      }),
      undefined,
      local,
    );
    expect(res.status).toBe(303);
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
    const ok = await call(new Request("http://localhost:5173/_admin/api/links", { headers: { Cookie: cookie } }), undefined, local);
    expect(ok.status).toBe(200);
  });

  it("serves the login form with strict headers and bounces cross-site arrivals", async () => {
    mockCerts();
    const jwt = await token({});
    const get = (path: string, headers: Record<string, string> = {}) =>
      call(new Request(`${ORIGIN}${path}`, { headers: { "Cf-Access-Jwt-Assertion": jwt, ...headers } }), undefined, LOGIN_ENV);

    const form = await get("/_admin/login?next=%2F_admin%2Fsettings");
    expect(form.status).toBe(200);
    expect(form.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(form.headers.get("Cache-Control")).toBe("no-store");
    const html = await form.text();
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('value="/_admin/settings"');

    const bounce = await get("/_admin/login?next=%2F_admin%2F", { "Sec-Fetch-Site": "cross-site" });
    expect(await bounce.text()).toContain('http-equiv="refresh" content="0;url=/_admin/login?next=%2F_admin%2F&#38;b=1"');

    const cookie = await sessionCookie(jwt);
    const already = await get("/_admin/login?next=%2F_admin%2Fsettings", { Cookie: cookie, "Sec-Fetch-Site": "same-origin" });
    expect(already.status).toBe(303);
    expect(already.headers.get("Location")).toBe("/_admin/settings");
  });

  it("logs out by clearing the cookie and ending the Access session", async () => {
    const res = await call(
      new Request(`${ORIGIN}/_admin/logout`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" } }),
      undefined,
      LOGIN_ENV,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/cdn-cgi/access/logout");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("only returns to admin pages after login", () => {
    for (const bad of ["https://evil.com/_admin/", "//evil.com/_admin/", "/\\evil.com", "/api/links", "/_admin/login", "/_admin/api/links", "javascript:alert(1)", "/x/../_admin/login"]) {
      expect(safeNext(bad, ORIGIN), bad).toBe("/_admin/");
    }
    expect(safeNext("/_admin/links?q=x", ORIGIN)).toBe("/_admin/links?q=x");
    expect(safeNext("/_admin", ORIGIN)).toBe("/_admin");
  });

  it("groups IPv6 clients by /64 and keeps IPv4 addresses whole", () => {
    expect(ipBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucket("2001:db8::1")).toBe(ipBucket("2001:0db8:0:0:ffff::2"));
    expect(ipBucket("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
  });
});

describe("password-only mode (ADMIN_AUTH=password)", () => {
  /** No Access settings at all, only the opt-out and the password. */
  const pwEnv = () => ({ ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: ALLOW_ALL }) as Partial<Env>;
  const pwCookie = async (e: Partial<Env> = pwEnv()) => {
    const res = await call(loginRequest(undefined, PASSWORD), undefined, e);
    expect(res.status).toBe(303);
    return (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  };

  it("logs in and serves the admin with the password alone", async () => {
    const before = await call(admin(), undefined, pwEnv());
    expect(before.status).toBe(401);
    expect(await before.json()).toMatchObject({ code: "login_required" });
    const cookie = await pwCookie();
    expect((await call(admin(undefined, { headers: { Cookie: cookie } }), undefined, pwEnv())).status).toBe(200);
    const settings = await call(new Request(`${ORIGIN}/_admin/api/settings`, { headers: { Cookie: cookie } }), undefined, pwEnv());
    expect(await settings.json()).toMatchObject({ security: { email: "admin", mode: "password", accessConfigured: false } });
  });

  it("still fails closed without a password", async () => {
    const e = { ADMIN_AUTH: "password" };
    expect((await call(admin(), undefined, e)).status).toBe(500);
    expect((await call(loginRequest(undefined, PASSWORD), undefined, e)).status).toBe(403);
  });

  it("keeps Access on when ADMIN_AUTH is empty, and refuses values that aren't exact", async () => {
    // Empty Access vars without the opt-out: the admin stays closed.
    const noOptOut = { ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: ALLOW_ALL };
    expect((await call(admin(), undefined, noOptOut)).status).toBe(500);
    expect((await call(loginRequest(undefined, PASSWORD), undefined, noOptOut)).status).toBe(403);
    for (const typo of ["Password", "password ", "off", "none", "access"]) {
      const e = { ...noOptOut, ADMIN_AUTH: typo };
      expect((await call(admin(), undefined, e)).status, typo).toBe(500);
      expect((await call(loginRequest(undefined, PASSWORD), undefined, e)).status, typo).toBe(403);
    }
    mockCerts();
    const jwt = await token({});
    const explicit = { ...LOGIN_ENV, ADMIN_AUTH: "access+password" };
    expect((await call(withCookie(await sessionCookie(jwt, explicit), jwt), undefined, explicit)).status).toBe(200);
  });

  it("never lets a password-only session into an Access-mode admin", async () => {
    const cookie = await pwCookie({ ...pwEnv(), ...ACCESS_ENV });
    mockCerts();
    const jwt = await token({});
    expect((await call(withCookie(cookie, jwt), undefined, LOGIN_ENV)).status).toBe(401);
    expect((await call(admin(undefined, { headers: { Cookie: cookie } }), undefined, LOGIN_ENV)).status).toBe(401);
  });

  it("grants nothing for a forged Access header in either mode", async () => {
    const forged = await new SignJWT({ email: "owner@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("attacker-chosen-secret-0123456789"));
    mockCerts();
    expect((await call(admin(forged), undefined, LOGIN_ENV)).status).toBe(401);
    // Without Access the header is ignored: the password is still required.
    const res = await call(admin(forged), undefined, { ...pwEnv(), ...ACCESS_ENV });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_required" });
  });

  it("refuses an oversized login body even without Content-Length", async () => {
    const chunk = new TextEncoder().encode(`password=${"x".repeat(2048)}`);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.close();
      },
    });
    const req = new Request(`${ORIGIN}/_admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
      body,
    });
    expect(req.headers.get("Content-Length")).toBeNull();
    expect((await call(req, undefined, pwEnv())).status).toBe(413);
  });

  it("logs out to the login page instead of Access", async () => {
    const res = await call(
      new Request(`${ORIGIN}/_admin/logout`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" } }),
      undefined,
      pwEnv(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/_admin/login");
  });

  it("is owner-only: people can't be added, and /me says why", async () => {
    const cookie = await pwCookie();
    const api = (path: string, init: RequestInit = {}) =>
      call(new Request(`${ORIGIN}/_admin/api${path}`, { ...init, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", ...init.headers } }), undefined, pwEnv());
    expect(await (await api("/me")).json()).toMatchObject({ email: "admin", owner: true, role: "admin", authMode: "password" });
    const add = await api("/users", { method: "POST", body: JSON.stringify({ email: "someone@example.com", name: "Someone", role: "user", permissions: [] }) });
    expect(add.status).toBe(409);
    expect(await add.json()).toMatchObject({ error: expect.stringMatching(/Cloudflare Access/) });
    expect(await env.DB.prepare("SELECT 1 FROM users").first()).toBeNull();
  });

  it("lets the owner's personal key work only while Access is off", async () => {
    const { auth } = await addKey("admin", ["links.create"]);
    const create = (e: Partial<Env>) => call(`${ORIGIN}/api/links`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com/k" }) }, e);
    expect((await create(pwEnv())).status).toBe(201);
    // Once Access is on, "admin" is nobody: the key stops working.
    expect((await create(LOGIN_ENV)).status).toBe(401);
  });

  it("shows a login page without Access wording", async () => {
    const html = await (await call(new Request(`${ORIGIN}/_admin/login`), undefined, pwEnv())).text();
    expect(html).toContain('autocomplete="current-password"');
    expect(html).not.toContain("Access");
    mockCerts();
    const accessHtml = await (await call(new Request(`${ORIGIN}/_admin/login`, { headers: { "Cf-Access-Jwt-Assertion": await token({}) } }), undefined, LOGIN_ENV)).text();
    expect(accessHtml).toContain("Access account");
  });
});

describe("API token", () => {
  it("accepts the right token and rejects others", async () => {
    const ok = await call(`${ORIGIN}/api/links`, { headers: { Authorization: "Bearer test-api-token-0123456789abcdef" } });
    expect(ok.status).toBe(200);
    const bad = await call(`${ORIGIN}/api/links`, { headers: { Authorization: "Bearer wrong", "CF-Connecting-IP": "203.0.113.1" } });
    expect(bad.status).toBe(401);
  });

  it("rate-limits repeated failures per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await call(`${ORIGIN}/api/links`, { headers: { Authorization: "Bearer nope", "CF-Connecting-IP": "203.0.113.9" } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("refuses everything when no token is configured", async () => {
    const noToken = { API_TOKEN: "" } as Partial<Env>;
    expect((await call(`${ORIGIN}/api/links`, { headers: { Authorization: "Bearer " } }, noToken)).status).toBe(401);
    const res = await call(`${ORIGIN}/api/links`, { headers: { Authorization: "Bearer test-api-token-0123456789abcdef" } }, noToken);
    expect(res.status).toBe(401);
  });

  describe("default scope", () => {
    const CREATE = { API_TOKEN_SCOPE: "create" };
    const auth = { Authorization: "Bearer test-api-token-0123456789abcdef", "Content-Type": "application/json" };
    const send = (method: string, path: string, body?: unknown, scope: Partial<Env> = CREATE) =>
      call(`${ORIGIN}/api${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) }, scope);

    it("reads, creates links and imports new ones", async () => {
      expect((await send("GET", "/links")).status).toBe(200);
      expect((await send("GET", "/settings")).status).toBe(200);
      // The mail setup (which secrets are set) is for the admin only, whatever the scope.
      expect((await send("GET", "/settings/mail")).status).toBe(403);
      expect((await send("POST", "/links", { url: "https://example.com/a", slug: "a" })).status).toBe(201);
      const imported = await send("POST", "/import", { rows: [{ slug: "b", target: "https://example.com/b" }] });
      expect(imported.status).toBe(200);
      expect((await imported.json<{ created: number }>()).created).toBe(1);
    });

    it("can't change or delete existing links, or change settings", async () => {
      await send("POST", "/links", { url: "https://example.com/a", slug: "a" });
      const refused = [
        await send("PATCH", "/links/sh.example/a", { target: "https://other.example/" }),
        await send("DELETE", "/links/sh.example/a"),
        await send("POST", "/import", { rows: [{ slug: "a", target: "https://other.example/" }], mode: "overwrite" }),
        await send("PUT", "/settings", { defaultUtm: "utm_source=x" }),
        await send("POST", "/resync"),
        await send("POST", "/stats/misses/clear", {}),
        await send("PUT", "/settings/mail", { provider: "webhook", from: "x@sh.example" }),
        await send("DELETE", "/settings/mail"),
      ];
      for (const res of refused) {
        expect(res.status).toBe(403);
        expect((await res.json<{ error: string }>()).error).toMatch(/API_TOKEN_SCOPE/);
      }
      expect((await env.DB.prepare("SELECT target FROM links WHERE slug = 'a'").first<{ target: string }>())?.target).toBe("https://example.com/a");
      expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'mail'").first()).toBeNull();
    });

    it("reads the newer endpoints but can't use their writes", async () => {
      await send("POST", "/links", { url: "https://example.com/a", slug: "a" });
      for (const path of ["/checks", "/checks/links/sh.example/a", "/links/sh.example/a/history", "/deleted", "/links/sh.example/a/cap", "/utm-presets", "/qr/default"]) {
        expect((await send("GET", path)).status, path).toBe(200);
      }
      const refused: [string, string, unknown?][] = [
        ["POST", "/links/sh.example/a/history/1/restore"],
        ["POST", "/deleted/sh.example/a/restore"],
        ["POST", "/checks/links/sh.example/a"],
        ["POST", "/links/sh.example/a/cap/reset"],
        ["POST", "/utm-presets", { name: "x", template: "utm_source=x" }],
        ["PUT", "/qr/default", {}],
        ["POST", "/webhooks", { url: "https://example.com/hook", events: ["link.created"] }],
        ["POST", "/previews/fetch", { url: "https://example.com/" }],
      ];
      for (const [method, path, body] of refused) {
        const res = await send(method, path, body ?? {});
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json<{ error: string }>()).error, `${method} ${path}`).toMatch(/API_TOKEN_SCOPE/);
      }
    });

    it("needs the full scope for webhook deliveries, which hold link destinations", async () => {
      expect((await send("GET", "/webhooks")).status).toBe(200);
      const res = await send("GET", "/webhooks/abc123/deliveries");
      expect(res.status).toBe(403);
      expect((await res.json<{ error: string }>()).error).toMatch(/API_TOKEN_SCOPE/);
      expect((await send("GET", "/webhooks/abc123/deliveries", undefined, { API_TOKEN_SCOPE: "full" })).status).not.toBe(403);
    });

    it("doesn't limit personal API keys, which carry their own permissions", async () => {
      await send("POST", "/links", { url: "https://example.com/a", slug: "a" });
      const { auth: key } = await addKey("owner@example.com", ["links.edit"]);
      const res = await call(`${ORIGIN}/api/links/sh.example/a`, { method: "PATCH", headers: { ...key, "Content-Type": "application/json" }, body: JSON.stringify({ target: "https://example.com/b" }) }, CREATE);
      expect(res.status).toBe(200);
    });

    it('treats anything but the exact value "full" as the default', async () => {
      await send("POST", "/links", { url: "https://example.com/a", slug: "a" });
      expect((await send("DELETE", "/links/sh.example/a", undefined, { API_TOKEN_SCOPE: "Full" })).status).toBe(403);
      expect((await send("DELETE", "/links/sh.example/a", undefined, { API_TOKEN_SCOPE: "full" })).status).toBe(200);
    });
  });
});

describe("password hashes", () => {
  it("round-trips and rejects out-of-range costs", async () => {
    const cfg = loginConfig({ ...env, ADMIN_PASSWORD_HASH: HASH } as Env);
    expect(cfg && "iterations" in cfg.password ? cfg.password.iterations : null).toBe(10_000);
    expect(HASH).toMatch(/^pbkdf2-sha256:10000:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    await expect(hashPassword(PASSWORD, 100_001)).rejects.toThrow();
    expect(loginConfig({ ...env, ADMIN_PASSWORD_HASH: HASH.replace(":10000:", ":9999:") } as Env)).toBeNull();
  });
});

describe("sessions end", () => {
  const logout = (cookie: string, jwt: string) =>
    new Request(`${ORIGIN}/_admin/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "Cf-Access-Jwt-Assertion": jwt, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" },
    });

  it("on logout, for a copy of the cookie too, but not for other sessions", async () => {
    mockCerts();
    const jwt = await token({});
    // Issued a minute earlier: two logins in the same second get the same cookie.
    const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
    const kept = (await issueSessionCookie(cfg, "owner@example.com", { global: await getEpoch(env.DB), user: OWNER_EPOCH }, nowSec() - 60)).cookie.split(";")[0]!;
    const cookie = await sessionCookie(jwt);
    expect((await call(logout(cookie, jwt), undefined, LOGIN_ENV)).status).toBe(303);
    expect((await call(withCookie(cookie, jwt), undefined, LOGIN_ENV)).status).toBe(401);
    expect((await call(withCookie(kept, jwt), undefined, LOGIN_ENV)).status).toBe(200);
  });

  it("when the password changes", async () => {
    mockCerts();
    const jwt = await token({});
    const cookie = await sessionCookie(jwt);
    const changed = { ...LOGIN_ENV, ADMIN_PASSWORD_HASH: await hashPassword("another-long-password-2026", 10_000) };
    expect((await call(withCookie(cookie, jwt), undefined, changed)).status).toBe(401);
  });
});

describe("abuse limits", () => {
  it("doesn't pause logins for failures from a single network", async () => {
    const now = nowSec();
    for (let i = 0; i < 40; i++) {
      await loginEventStmt(env.DB, false, "one-network", "", now, "owner@example.com").run();
      await recordGlobalFailure(env.DB, now, true);
    }
    expect(await globalLockedUntil(env.DB, now, true)).toBe(0);
  });

  it("refuses a locked network before comparing its API token", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.77" };
    for (let i = 0; i < 10; i++) await call(`${ORIGIN}/api/links`, { headers: { Authorization: "Bearer nope", ...ip } }, { AUTH_LIMITER: ALLOW_ALL });
    const right = await call(`${ORIGIN}/api/links`, { headers: { ...bearer, ...ip } }, { AUTH_LIMITER: ALLOW_ALL });
    expect(right.status).toBe(429);
    expect((await call(`${ORIGIN}/api/links`, { headers: { ...bearer, "CF-Connecting-IP": "203.0.113.78" } })).status).toBe(200);
  });

  it("doesn't count requests without any token towards the lock, and caps API lockouts at an hour", async () => {
    const ip = { "CF-Connecting-IP": "203.0.113.90" };
    for (let i = 0; i < 12; i++) expect((await call(`${ORIGIN}/api/links`, { headers: ip })).status).toBe(401);
    expect((await call(`${ORIGIN}/api/links`, { headers: { ...bearer, ...ip } })).status).toBe(200);
    const now = nowSec();
    expect(await lock(env.DB, "api:test", now, 20, API_LOCK_MAX_SEC)).toBe(now + API_LOCK_MAX_SEC);
    expect(await lock(env.DB, "login:test", now, 20)).toBe(now + 86400);
  });

  it("hides login activity and the recipient from the API token", async () => {
    const s = await (await call(`${ORIGIN}/api/settings`, { headers: bearer })).json<{ security: unknown; digestTo: unknown }>();
    expect(s.security).toBeNull();
    expect(s.digestTo).toBeNull();
  });

  it("sends at most one test digest a minute", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const send = () => call(`${ORIGIN}/api/settings/digest/test`, { method: "POST", headers: bearer });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});

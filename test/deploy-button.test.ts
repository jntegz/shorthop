// What a Deploy to Cloudflare install relies on: a plain ADMIN_PASSWORD secret,
// SESSION_SECRET and VISITOR_SALT generated in D1, and no short domain yet.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetGeneratedSecretsCache } from "../src/worker/secrets";
import { API, call, json, ORIGIN, resetData } from "./helpers";

const PASSWORD = "a-long-button-password-2026"; // gitleaks:allow (test fixture)
const ALLOW_ALL = { limit: async () => ({ success: true }) } as RateLimit;
/** A button install: password-only sign-in, ADMIN_PASSWORD, and no SESSION_SECRET or VISITOR_SALT. */
const BUTTON = { ADMIN_AUTH: "password", ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: "", VISITOR_SALT: "", LOGIN_LIMITER: ALLOW_ALL } as Partial<Env>;

beforeEach(async () => {
  await resetData();
  resetGeneratedSecretsCache();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'generated_%'").run();
});

function login(password: string, e: Partial<Env> = BUTTON) {
  return call(
    new Request(`${ORIGIN}/_admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": "203.0.113.9" },
      body: new URLSearchParams({ password, next: "/_admin/" }),
    }),
    undefined,
    e,
  );
}

const adminLinks = (cookie: string, e: Partial<Env> = BUTTON) => call(new Request(`${ORIGIN}/_admin/api/links`, { headers: { Cookie: cookie } }), undefined, e);
const cookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;

describe("ADMIN_PASSWORD", () => {
  it("signs in with the right password and refuses a wrong one", async () => {
    const ok = await login(PASSWORD);
    expect(ok.status).toBe(303);
    expect((await adminLinks(cookieOf(ok))).status).toBe(200);
    expect((await login("not-the-password")).status).toBe(401);
  });

  it("keeps the admin closed when it's shorter than 9 characters", async () => {
    const short = { ...BUTTON, ADMIN_PASSWORD: "12345678" };
    expect((await login("12345678", short)).status).toBe(403);
    expect((await adminLinks("", short)).status).toBe(500);
  });

  it("loses to ADMIN_PASSWORD_HASH when both are set", async () => {
    const both = { ...BUTTON, ADMIN_PASSWORD_HASH: "pbkdf2-sha256:10000:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    expect((await login(PASSWORD, both)).status).toBe(401);
  });

  it("ends every session when it changes", async () => {
    const cookie = cookieOf(await login(PASSWORD));
    expect((await adminLinks(cookie, { ...BUTTON, ADMIN_PASSWORD: "another-long-password-2026" })).status).toBe(401);
  });
});

describe("generated secrets", () => {
  it("creates SESSION_SECRET and VISITOR_SALT once in D1 and keeps using them", async () => {
    const cookie = cookieOf(await login(PASSWORD));
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'generated_%' ORDER BY key").all<{ key: string; value: string }>();
    expect(results.map((r) => r.key)).toEqual(["generated_session_secret", "generated_visitor_salt"]);
    expect(results.every((r) => r.value.length >= 32)).toBe(true);
    // A fresh isolate reads the same values back: the session still works.
    resetGeneratedSecretsCache();
    expect((await adminLinks(cookie)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'generated_%'").first<{ n: number }>())?.n).toBe(2);
  });

  it("are never used when the Wrangler secrets are set", async () => {
    const res = await login(PASSWORD, { ...BUTTON, SESSION_SECRET: "a-real-session-secret-0123456789abcdef", VISITOR_SALT: "a-real-visitor-salt-0123456789" });
    expect(res.status).toBe(303);
    expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key LIKE 'generated_%'").first()).toBeNull();
  });
});

describe("no short domain yet", () => {
  const NO_DOMAIN = { SHORT_DOMAINS: "" } as Partial<Env>;
  const WORKERS_DEV = "https://shorthop.someone.workers.dev";

  it("refuses to create or import links, and says why", async () => {
    const created = await call(`${WORKERS_DEV}/api/links`, json({ url: "https://example.com/a" }), NO_DOMAIN);
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({ code: "no_domain", error: expect.stringMatching(/SHORT_DOMAINS/) });
    const imported = await call(`${WORKERS_DEV}/api/import`, json({ rows: [{ slug: "b", target: "https://example.com/b" }] }), NO_DOMAIN);
    expect(imported.status).toBe(409);
    expect(await env.DB.prepare("SELECT 1 FROM links").first()).toBeNull();
  });

  it("reports no domains rather than the placeholder", async () => {
    const me = await (await call(`${WORKERS_DEV}/api/me`, { headers: json({}).headers }, NO_DOMAIN)).json<{ workspace: { domains: string[]; primaryDomain: string; adminHost: string } }>();
    expect(me.workspace).toMatchObject({ domains: [], primaryDomain: "", adminHost: "" });
  });

  it("still creates links once a domain is set", async () => {
    expect((await call(`${API}/links`, json({ url: "https://example.com/a" }))).status).toBe(201);
  });
});

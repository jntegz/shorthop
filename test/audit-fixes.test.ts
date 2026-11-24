// Fixes from the November 2026 security audits that have no other natural home:
// the Gumroad token in webhook addresses, the digest preview, the domain check's
// limit, cross-site posts to password forms, the people's login brake, payment
// matches over the API, API keys under the two-factor rule, who may change the
// email setup, and stored secrets without a key.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GLOBAL_MAX_FAILS, MAX_FAILS } from "../src/shared/login-policy";
import { hashPassword } from "../src/shared/password";
import type { ConnectionDTO, SiteDTO } from "../src/shared/sites";
import { nowSec } from "../src/worker/db";
import { globalLockedUntil } from "../src/worker/session";
import { decryptSecret, encryptSecret } from "../src/worker/webhooks";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";
import { addKey, addUser, adminCall, as, LOCAL } from "./people";

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

const ALLOW_ALL = { limit: async () => ({ success: true }) } as RateLimit;

describe("a Gumroad connection's webhook address", () => {
  it("carries its token only for people who see revenue", async () => {
    const site = await (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json<SiteDTO>();
    const created = await adminCall("", `/sites/${site.id}/connections`, { body: { provider: "gumroad" } });
    expect(created.status).toBe(201);
    const token = new URL((await created.json<ConnectionDTO>()).webhookUrl).searchParams.get("token");
    expect(token).toBeTruthy();

    await addUser("manager@example.com", "user", ["sites.manage", "stats.view"]);
    await addUser("money@example.com", "user", ["sites.manage", "revenue.view", "stats.view"]);
    const list = async (who: string) => (await (await adminCall(who, `/sites/${site.id}/connections`)).json<{ connections: ConnectionDTO[] }>()).connections[0]!;
    expect((await list("manager@example.com")).webhookUrl).not.toContain("token=");
    expect((await list("money@example.com")).webhookUrl).toContain(`token=${token}`);

    // Adding or changing one doesn't hand it out either.
    const added = await adminCall("manager@example.com", `/sites/${site.id}/connections`, { body: { provider: "gumroad" } });
    expect(added.status).toBe(201);
    const conn = await added.json<ConnectionDTO>();
    expect(conn.webhookUrl).not.toContain("token=");
    const changed = await adminCall("manager@example.com", `/sites/${site.id}/connections/${conn.id}`, { method: "PATCH", body: { label: "Renamed" } });
    expect((await changed.json<ConnectionDTO>()).webhookUrl).not.toContain("token=");
  });
});

describe("the digest preview", () => {
  it("shows websites' revenue only to people who see revenue", async () => {
    await call(`${API}/sites`, json({ name: "Moneymaker Store", domains: ["shop.example.com"] }));
    await addUser("digest@example.com", "user", ["settings.manage", "stats.view"]);
    await addUser("money@example.com", "user", ["settings.manage", "stats.view", "revenue.view"]);
    const without = await adminCall("digest@example.com", "/settings/digest/preview");
    expect(without.status).toBe(200);
    expect(await without.text()).not.toContain("Moneymaker Store");
    expect(await (await adminCall("money@example.com", "/settings/digest/preview")).text()).toContain("Moneymaker Store");
  });

  it("shows missed visits only to people who see Link health", async () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, 'sh.example', 'secret-launch', 'miss', '', 9, 0, 0)").bind(yesterday).run();
    await addUser("digest@example.com", "user", ["settings.manage", "stats.view"]);
    await addUser("health@example.com", "user", ["settings.manage", "stats.view", "health.manage"]);
    const without = await adminCall("digest@example.com", "/settings/digest/preview");
    expect(without.status).toBe(200);
    expect(await without.text()).not.toContain("secret-launch");
    expect(await (await adminCall("health@example.com", "/settings/digest/preview")).text()).toContain("secret-launch");
  });
});

describe("payments sent over the API", () => {
  it("say how they matched only to people who see revenue", async () => {
    const site = await (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json<SiteDTO>();
    await addUser("billing@example.com", "user", ["sites.manage", "stats.view"]);
    await addUser("money@example.com", "user", ["sites.manage", "stats.view", "revenue.view"]);
    const send = (who: string, id: string) => adminCall(who, `/sites/${site.id}/payments`, { body: { id, amount: 10, currency: "USD", email: "pat@example.com" } });
    const plain = await send("billing@example.com", "probe-1");
    expect(plain.status).toBe(201);
    expect(Object.keys((await plain.json<{ payment: Record<string, unknown> }>()).payment)).toEqual(["id"]);
    const full = await (await send("money@example.com", "probe-2")).json<{ payment: Record<string, unknown> }>();
    expect(full.payment).toHaveProperty("matched_by");
  });
});

describe("personal API keys under the two-factor rule", () => {
  it("wait while their owner has no two-factor sign-in and it's required", async () => {
    await addUser("ben@example.com", "user", ["api.use"]);
    const { auth } = await addKey("ben@example.com", []);
    expect((await call(`${API}/me`, { headers: auth })).status).toBe(200);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('require_2fa', '1')").run();
    expect((await call(`${API}/me`, { headers: auth })).status).toBe(401);
    await env.DB.prepare("INSERT INTO auth_factors (id, email, kind, name, created_at) VALUES ('f1', 'ben@example.com', 'passkey', 'Key', ?)").bind(nowSec()).run();
    expect((await call(`${API}/me`, { headers: auth })).status).toBe(200);
  });
});

describe("the email setup", () => {
  it("is changed by admins only: off, it would silence everyone's security notices", async () => {
    await addUser("settings@example.com", "user", ["settings.manage"]);
    expect((await adminCall("settings@example.com", "/settings/mail")).status).toBe(200);
    expect((await adminCall("settings@example.com", "/settings/mail", { method: "PUT", body: { provider: "off", from: "" } })).status).toBe(403);
    expect((await adminCall("settings@example.com", "/settings/mail", { method: "DELETE" })).status).toBe(403);
    expect((await adminCall("", "/settings/mail", { method: "PUT", body: { provider: "off", from: "" } })).status).toBe(200);
  });
});

describe("stored secrets", () => {
  it("are never encrypted with a key derived from nothing", async () => {
    const keyless = { ...env, SESSION_SECRET: "", ENCRYPTION_KEY: "" } as Env;
    await expect(encryptSecret(keyless, "tracking:ip", "198.51.100.7")).rejects.toThrow(/No key/);
    const stored = await encryptSecret(env, "tracking:ip", "198.51.100.7");
    expect(await decryptSecret(keyless, "tracking:ip", stored)).toBeNull();
    expect(await decryptSecret(keyless, "tracking:ip", "v1:aaaa:bbbb")).toBeNull();
  });
});

describe("the domain setup check", () => {
  it("is limited per person", async () => {
    let calls = 0;
    const limiter = { limit: async () => ({ success: ++calls <= 1 }) } as RateLimit;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("offline");
    });
    const check = () => call(`${API}/settings/domains/check?domain=links.example.com`, { headers: bearer }, { PUBLIC_LIMITER: limiter });
    expect((await check()).status).toBe(200);
    expect((await check()).status).toBe(429);
  });
});

describe("password forms of links", () => {
  it("refuse posts from other sites before anything is counted", async () => {
    expect((await call(`${API}/links`, json({ slug: "secret", target: "https://example.com/private-doc", password: "open sesame" }))).status).toBe(201);
    const post = (headers: Record<string, string>) =>
      call(
        new Request(`${ORIGIN}/secret`, {
          method: "POST",
          headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "CF-Connecting-IP": "198.51.100.7", "Content-Type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams({ password: "wrong guess" }),
        }),
        undefined,
        { LINK_PASSWORD_LIMITER: ALLOW_ALL },
      );
    const foreign: Record<string, string>[] = [{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.example" }];
    for (const headers of foreign) {
      // Refused as a bad request, not checked as a guess.
      expect(await (await post(headers)).text(), JSON.stringify(headers)).toContain("Something went wrong");
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures").first<{ n: number }>())?.n).toBe(0);
    // The page's own form still counts.
    expect(await (await post({ "Sec-Fetch-Site": "same-origin", Origin: ORIGIN })).text()).toContain("That password isn&#39;t right");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures").first<{ n: number }>())?.n).toBeGreaterThan(0);
  });
});

describe("the people's login brake", () => {
  const PASSWORD = "a-long-enough-password";
  /** A password attempt by `email` from a network of its own each time. */
  async function attempt(email: string, password: string, n: number): Promise<Response> {
    const extra = as(email, { ADMIN_PASSWORD_HASH: await hashPassword("owner-password-0123", 10_000), LOGIN_LIMITER: ALLOW_ALL });
    return call(
      new Request(`${LOCAL}/_admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": `2001:db8:${n.toString(16)}::1` },
        body: new URLSearchParams({ password }).toString(),
      }),
      undefined,
      extra,
    );
  }

  it("can't be held on by one person guessing from many networks", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await addUser("ana@example.com", "user", [], { password: PASSWORD });
    await addUser("bo@example.com", "user", [], { password: PASSWORD });
    for (let i = 0; i < GLOBAL_MAX_FAILS + 5; i++) expect((await attempt("ana@example.com", "wrong", i)).status).toBe(401);
    // Only their first MAX_FAILS counted towards everyone's brake.
    expect(await globalLockedUntil(env.DB, nowSec(), false)).toBe(0);
    expect((await env.DB.prepare("SELECT fails FROM auth_failures WHERE key = '*people'").first<{ fails: number }>())?.fails).toBe(MAX_FAILS);
    // Someone else still signs in, from a network nobody used.
    expect((await attempt("bo@example.com", PASSWORD, 999)).status).toBe(303);
  });

  it("still pauses people's logins when many accounts fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const people = Array.from({ length: Math.ceil(GLOBAL_MAX_FAILS / MAX_FAILS) }, (_, i) => `p${i}@example.com`);
    for (const p of people) await addUser(p, "user", [], { password: PASSWORD });
    let n = 0;
    // Each from its own networks, so the brake's several-networks rule is met too.
    for (const p of people) for (let i = 0; i < MAX_FAILS; i++) await attempt(p, "wrong", n++);
    expect(await globalLockedUntil(env.DB, nowSec(), false)).toBeGreaterThan(nowSec());
  });

  it("clears a person's count when they sign in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await addUser("ana@example.com", "user", [], { password: PASSWORD });
    await attempt("ana@example.com", "wrong", 1);
    expect(await env.DB.prepare("SELECT 1 FROM auth_failures WHERE key = 'login:ana@example.com'").first()).not.toBeNull();
    expect((await attempt("ana@example.com", PASSWORD, 2)).status).toBe(303);
    expect(await env.DB.prepare("SELECT 1 FROM auth_failures WHERE key = 'login:ana@example.com'").first()).toBeNull();
  });
});

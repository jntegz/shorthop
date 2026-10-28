// Regression tests for the security review's findings: one block per finding.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDTO, SiteDTO } from "../src/shared/sites";
import { splitOwnParams } from "../src/shared/target";
import { readCapped } from "../src/worker/body";
import { findMatch, rematchAll, tokenLike, type PaymentRow } from "../src/worker/revenue/match";
import { globalLockedUntil, loginEventStmt, recordGlobalFailure } from "../src/worker/session";
import { GLOBAL_MIN_NETWORKS } from "../src/shared/login-policy";
import { listSites } from "../src/worker/web/sites";
import { API, call, json, ORIGIN, putLink, resetData } from "./helpers";
import { addUser, adminCall } from "./people";

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetData();
  await env.DB.batch([env.DB.prepare("DELETE FROM auth_failures"), env.DB.prepare("DELETE FROM users")]);
});

const now = () => Math.floor(Date.now() / 1000);

async function createSite(): Promise<SiteDTO> {
  return (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json<SiteDTO>();
}

async function connect(site: SiteDTO, body: Record<string, unknown>): Promise<Response> {
  return call(`${API}/sites/${site.id}/connections`, json(body));
}

async function addPayment(site: SiteDTO, id: string, fields: Partial<Record<"occurred_at" | "email" | "order_ref" | "last_match_at", string | number>> = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, provider, kind, occurred_at, amount_minor, currency, email, order_ref, last_match_at, created_at)
     VALUES (?1, ?2, 'stripe', 'charge', ?3, 1000, 'EUR', ?4, ?5, ?6, ?7)`,
  )
    .bind(id, site.id, fields.occurred_at ?? now(), fields.email ?? null, fields.order_ref ?? null, fields.last_match_at ?? null, now())
    .run();
}

describe("payment connection secrets", () => {
  it("only sends a Paddle import's API key to Paddle", async () => {
    const site = await createSite();
    const conn = await (await connect(site, { provider: "paddle", webhookSecret: "pdl_ntfset_secret", apiKey: "pdl_live_apikey_0123456789" })).json<ConnectionDTO>(); // gitleaks:allow (test fixture)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: [], meta: { pagination: { has_more: false } } }));
    for (const cursor of ["https://api.paddle.com.attacker.example/transactions", "https://api.paddle.com@attacker.example/transactions", "https://user:pw@api.paddle.com/transactions", "not a url"]) {
      const res = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30, cursor }));
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("Bad cursor");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // Paddle's own next-page address still works.
    const ok = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30, cursor: "https://api.paddle.com/transactions?after=txn_1" }));
    expect(ok.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.paddle.com/transactions?after=txn_1");
  });

  it("never puts a value read from a named Worker secret in a Gumroad webhook address", async () => {
    const site = await createSite();
    const secretEnv = { OTHER_SHOP_API_KEY: "sk_live_must_not_leak" } as Partial<Env>;
    expect((await call(`${API}/sites/${site.id}/connections`, json({ provider: "gumroad", webhookSecretRef: "OTHER_SHOP_API_KEY" }), secretEnv)).status).toBe(400);

    const conn = await (await connect(site, { provider: "gumroad" })).json<ConnectionDTO>();
    const patched = await call(`${API}/sites/${site.id}/connections/${conn.id}`, { ...json({ webhookSecretRef: "OTHER_SHOP_API_KEY" }), method: "PATCH" }, secretEnv);
    expect(patched.status).toBe(400);

    // A row saved with a name before this check existed: the address is shown without the value.
    await env.DB.prepare("UPDATE payment_connections SET webhook_secret = NULL, webhook_secret_ref = 'OTHER_SHOP_API_KEY' WHERE id = ?1").bind(conn.id).run();
    const listed = await call(`${API}/sites/${site.id}/connections`, { headers: json({}).headers }, secretEnv);
    expect(await listed.text()).not.toContain("sk_live_must_not_leak");
  });

  it("lets only owners point a connection at a Worker secret by name", async () => {
    const site = await createSite();
    await addUser("manager@example.com", "user", ["sites.manage"]);
    const path = `/sites/${site.id}/connections`;
    const named = await adminCall("manager@example.com", path, { body: { provider: "stripe", webhookSecretRef: "STRIPE_WEBHOOK_SECRET_SHOP" } });
    expect(named.status).toBe(403);
    // Pasting a value is still theirs to do, and so is clearing a name.
    const pasted = await adminCall("manager@example.com", path, { body: { provider: "stripe", webhookSecret: "whsec_pasted_value" } });
    expect(pasted.status).toBe(201);
    const conn = await pasted.json<ConnectionDTO>();
    expect((await adminCall("manager@example.com", `${path}/${conn.id}`, { method: "PATCH", body: { apiKeyRef: "STRIPE_API_KEY_OTHER" } })).status).toBe(403);
    expect((await adminCall("manager@example.com", `${path}/${conn.id}`, { method: "PATCH", body: { apiKeyRef: null } })).status).toBe(200);
    // An owner may.
    expect((await adminCall("", `${path}/${conn.id}`, { method: "PATCH", body: { apiKeyRef: "STRIPE_API_KEY_SHOP" } })).status).toBe(200);
  });
});

describe("payment matching", () => {
  it("treats _ and % in a ref as themselves", async () => {
    const like = (value: string, ref: string) => env.DB.prepare("SELECT (' ' || ?1 || ' ') LIKE ?2 ESCAPE '!' AS m").bind(value, tokenLike(ref)).first<{ m: number }>();
    expect((await like("abcd cs_123", "____"))?.m).toBe(0);
    expect((await like("abcd cs_123", "cs%"))?.m).toBe(0);
    expect((await like("abcd cs_123", "cs_123"))?.m).toBe(1);
    expect((await like("a!b", "a!b"))?.m).toBe(1);
  });

  it("gives every unmatched payment its turn, not the same newest ones every day", async () => {
    const site = await createSite();
    await addPayment(site, "stripe:charge:new", { occurred_at: now() - 60 });
    await addPayment(site, "stripe:charge:old", { occurred_at: now() - 86400 });
    const sites = await listSites(env.DB);
    await rematchAll(env.DB, sites, 1);
    await rematchAll(env.DB, sites, 1);
    const { results } = await env.DB.prepare("SELECT id, last_match_at FROM payments ORDER BY id").all<{ id: string; last_match_at: number | null }>();
    expect(results.every((r) => r.last_match_at !== null)).toBe(true);
  });

  it("only credits a browser-reported email to a visit in the day before the payment", async () => {
    const site = await createSite();
    const t = now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) VALUES ('ws_old', ?1, 'v1', ?2, ?2)").bind(site.id, t - 3 * 86400),
      env.DB.prepare("INSERT INTO web_visitors (site_id, id, first_seen, email, trust) VALUES (?1, 'v1', ?2, 'buyer@example.com', 'client')").bind(site.id, t - 3 * 86400),
    ]);
    const payment: PaymentRow = { id: "stripe:charge:p1", site_id: site.id, provider: "stripe", kind: "charge", occurred_at: t, customer_id: null, email: "buyer@example.com", subscription_id: null, order_ref: null, ref: null, session_id: null };
    expect(await findMatch(env.DB, payment)).toHaveProperty("reason");
    // The same visitor reported by the site's own server still counts.
    await env.DB.prepare("UPDATE web_visitors SET trust = 'server' WHERE id = 'v1'").run();
    expect(await findMatch(env.DB, payment)).toMatchObject({ by: "email", confidence: "medium" });
    // And a browser report on a visit shortly before does too.
    await env.DB.batch([
      env.DB.prepare("UPDATE web_visitors SET trust = 'client' WHERE id = 'v1'"),
      env.DB.prepare("UPDATE web_sessions SET started_at = ?1 WHERE id = 'ws_old'").bind(t - 3600),
    ]);
    expect(await findMatch(env.DB, payment)).toMatchObject({ by: "email", confidence: "low" });
  });

  it("ignores browser-reported emails on a site that trusts only its server's", async () => {
    const site = await createSite();
    const res = await call(`${API}/sites/${site.id}`, { ...json({ serverEmailsOnly: true }), method: "PATCH" });
    expect(await res.json()).toMatchObject({ serverEmailsOnly: true });
    const t = now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) VALUES ('ws_1', ?1, 'v1', ?2, ?2)").bind(site.id, t - 600),
      env.DB.prepare("INSERT INTO web_visitors (site_id, id, first_seen, email, trust) VALUES (?1, 'v1', ?2, 'buyer@example.com', 'client')").bind(site.id, t - 600),
    ]);
    await addPayment(site, "stripe:charge:p2", { email: "buyer@example.com", occurred_at: t });
    await rematchAll(env.DB, await listSites(env.DB), 10);
    expect(await env.DB.prepare("SELECT session_id FROM payments WHERE id = 'stripe:charge:p2'").first()).toEqual({ session_id: null });
    // The same email from the site's server matches.
    await env.DB.prepare("UPDATE web_visitors SET trust = 'server' WHERE id = 'v1'").run();
    await env.DB.prepare("UPDATE payments SET last_match_at = NULL").run();
    await rematchAll(env.DB, await listSites(env.DB), 10);
    expect(await env.DB.prepare("SELECT session_id, confidence FROM payments WHERE id = 'stripe:charge:p2'").first()).toEqual({ session_id: "ws_1", confidence: "medium" });
  });
});

describe("public endpoints", () => {
  it("drops a visitor's own click token instead of passing it on", () => {
    expect(splitOwnParams("?sh_c=forged.token&a=1&s=x").passthrough).toEqual(["a=1"]);
  });

  it("caps a body by its bytes, with or without Content-Length", async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(1024));
          c.close();
        },
      });
    expect(await readCapped(new Request(ORIGIN, { method: "POST", body: stream() }), 2048)).toBeNull();
    expect((await readCapped(new Request(ORIGIN, { method: "POST", body: stream() }), 8192))?.byteLength).toBe(4096);
    expect(await readCapped(new Request(ORIGIN, { method: "POST", headers: { "Content-Length": "999999" }, body: "x" }), 1024)).toBeNull();
    // Multibyte characters count as their bytes.
    expect(await readCapped(new Request(ORIGIN, { method: "POST", body: "é".repeat(600) }), 1000)).toBeNull();
  });
});

describe("admin access", () => {
  it("lets failed logins by people pause only people, never the owners", async () => {
    const t = now();
    // Failures from several networks: one network alone never trips a global brake.
    for (let i = 0; i < GLOBAL_MIN_NETWORKS; i++) await loginEventStmt(env.DB, false, `network-${i}`, "", t, "anna@example.com").run();
    for (let i = 0; i < 30; i++) await recordGlobalFailure(env.DB, t, false);
    expect(await globalLockedUntil(env.DB, t, false)).toBeGreaterThan(t);
    expect(await globalLockedUntil(env.DB, t, true)).toBe(0);
    // Guessing at the owners' password still pauses everyone.
    for (let i = 0; i < 30; i++) await recordGlobalFailure(env.DB, t, true);
    expect(await globalLockedUntil(env.DB, t, true)).toBeGreaterThan(t);
  });

  it("shows click counts only to people who may see statistics", async () => {
    await putLink("x", { u: "https://example.com" });
    await env.DB.prepare("INSERT INTO links (domain, slug, target, created_at, updated_at) VALUES ('sh.example', 'x', 'https://example.com', ?1, ?1)").bind(now()).run();
    await addUser("editor@example.com", "user", ["links.edit", "settings.manage"]);
    const res = await adminCall("editor@example.com", "/links?period=all");
    expect(res.status).toBe(200);
    const { links } = await res.json<{ links: { clicksTotal: number }[] }>();
    expect(links.every((l) => l.clicksTotal === 0)).toBe(true);
    expect((await adminCall("editor@example.com", "/settings/digest/preview")).status).toBe(403);
  });
});

// Requests from visitors and customers: lookup, export and erasure of one
// person, customer data retention, and who may do them.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivacyCountsDTO, PrivacyEraseDTO, PrivacyRequestDTO, SiteDTO, SiteOverviewDTO } from "../src/shared/sites";
import { storeSubscription } from "../src/worker/revenue/ingest";
import { pruneCustomerData } from "../src/worker/web/privacy";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";
import { addKey, addUser, adminCall } from "./people";

beforeEach(async () => {
  await resetData();
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input instanceof Request ? input.url : input).includes("frankfurter") ? Promise.resolve(new Response("offline", { status: 503 })) : realFetch(input, init),
  );
});

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ALICE = "alice-visitor-0001";
const BOB = "bob-visitor-000002";
const now = () => Math.floor(Date.now() / 1000);

async function createSite(body: Record<string, unknown> = {}): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"], idMode: "persistent", ...body }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

/** A pageview by a persistent visitor; returns the visit (session) id. */
async function visit(site: SiteDTO, visitorId: string, url = `${SITE_ORIGIN}/`): Promise<string> {
  const res = await call(`${ORIGIN}/_t/e`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ s: site.id, t: "pageview", u: url, r: "", w: 1440, v: visitorId }),
  });
  expect(res.status).toBe(200);
  return (await res.json<{ s: string }>()).s;
}

async function pay(site: SiteDTO, body: Record<string, unknown>): Promise<void> {
  const res = await call(`${API}/sites/${site.id}/payments`, json({ amount: 50, currency: "USD", ...body }));
  expect(res.status).toBe(201);
}

const privacy = (site: SiteDTO, what: string, body: Record<string, unknown>) => call(`${API}/sites/${site.id}/privacy/${what}`, json(body));
const counts = async (site: SiteDTO, body: Record<string, unknown>) => (await privacy(site, "lookup", body)).json<PrivacyCountsDTO>();
const row = <T>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<T>();
const revenue = async (site: SiteDTO) =>
  (await (await call(`${API}/sites/${site.id}/overview?range=7d`, { headers: json({}).headers })).json<SiteOverviewDTO>()).totals.revenue;

/** Alice: identified, two visits, a charge credited to the second, a refund, and another payment as the same customer. Bob: a customer too. */
async function people(site: SiteDTO) {
  const first = await visit(site, ALICE);
  const second = await visit(site, ALICE, `${SITE_ORIGIN}/pricing?utm_source=newsletter&utm_medium=email`);
  expect(second).not.toBe(first);
  expect((await call(`${API}/sites/${site.id}/identify`, json({ visitorId: ALICE, email: "alice@example.com", name: "Alice" }))).status).toBe(200);
  await pay(site, { id: "a1", ref: first, email: "Alice@Example.com", customerId: "cus_A" });
  await pay(site, { id: "a1-refund", kind: "refund", amount: 10, parentId: "a1" });
  await pay(site, { id: "a2", customerId: "cus_A", amount: 20 });
  await visit(site, BOB);
  await pay(site, { id: "b1", email: "bob@example.com", customerId: "cus_B", visitorId: BOB });
  return { first, second };
}

describe("finding a person", () => {
  it("finds the same records by email, visitor id or payment id, and nobody else's", async () => {
    const site = await createSite();
    await people(site);
    const alice = { identities: 1, visits: 2, payments: 3, subscriptions: 0, activeSubscriptions: 0 };
    expect(await counts(site, { email: "ALICE@example.com" })).toEqual(alice);
    expect(await counts(site, { visitorId: ALICE })).toEqual(alice);
    expect(await counts(site, { paymentId: "api:charge:a1" })).toEqual(alice);
    expect(await counts(site, { email: "nobody@example.com" })).toMatchObject({ identities: 0, visits: 0, payments: 0 });
    expect(await counts(site, { paymentId: "api:charge:b1" })).toMatchObject({ identities: 1, visits: 1, payments: 1 });
  });

  it("names exactly one of email, visitor id or payment id, in the body", async () => {
    const site = await createSite();
    expect((await privacy(site, "lookup", {})).status).toBe(400);
    expect((await privacy(site, "lookup", { email: "a@example.com", visitorId: ALICE })).status).toBe(400);
    expect((await call(`${API}/sites/${site.id}/privacy/lookup?email=a@example.com`, { method: "POST", headers: json({}).headers })).status).toBe(400);
  });

  it("stays within the site", async () => {
    const site = await createSite();
    await people(site);
    const other = await createSite({ name: "Other", domains: ["other.example.com"] });
    expect(await counts(other, { email: "alice@example.com" })).toMatchObject({ identities: 0, visits: 0, payments: 0 });
    expect(await counts(other, { paymentId: "api:charge:a1" })).toMatchObject({ payments: 0 });
  });
});

describe("exporting", () => {
  it("downloads everything stored, and logs the request without naming the person", async () => {
    const site = await createSite();
    await people(site);
    const res = await privacy(site, "export", { email: "alice@example.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(new RegExp(`^attachment; filename="shorthop-${site.id}-person-\\d{4}-\\d{2}-\\d{2}\\.json"$`));
    const data = await res.json<{ identities: { email: string }[]; visits: unknown[]; payments: { id: string }[]; notes: string[] }>();
    expect(data.identities.map((i) => i.email)).toEqual(["alice@example.com"]);
    expect(data.visits).toHaveLength(2);
    expect(data.payments.map((p) => p.id).sort()).toEqual(["api:charge:a1", "api:charge:a2", "api:refund:a1-refund"]);
    expect(data.notes.join(" ")).toContain("Analytics Engine");

    const { requests } = await (await call(`${API}/sites/${site.id}/privacy/requests`, { headers: json({}).headers })).json<{ requests: PrivacyRequestDTO[] }>();
    expect(requests).toEqual([expect.objectContaining({ kind: "export", counts: expect.objectContaining({ payments: 3 }) })]);
    const stored = JSON.stringify(await env.DB.prepare("SELECT kind, by_identity, created_at, counts FROM privacy_requests").all());
    expect(stored).not.toMatch(/alice|cus_A|a1/i);
  });
});

describe("erasing", () => {
  it("removes the person and keeps the money, credited to an anonymous visit", async () => {
    const site = await createSite();
    const { first, second } = await people(site);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at) VALUES (?1, 'cs_test_1', ?2, ?3)").bind(site.id, first, now()),
      ...[site.id, "st_someothersite"].map((siteId, i) =>
        env.DB.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, created_at) VALUES (?1, 1, 'evt', 'site.payment', ?2, 'delivered', 0)").bind(
          `dlv_${i}`,
          JSON.stringify({ data: { site: { id: siteId }, payment: { id: "api:charge:a1", email: "alice@example.com" } } }),
        ),
      ),
    ]);
    const before = await revenue(site);
    expect(before).toBeGreaterThan(0);
    const credited = await row<{ credited_session_id: string }>("SELECT credited_session_id FROM payments WHERE id = 'api:charge:a1'");
    expect(credited?.credited_session_id).toBe(second);

    expect((await privacy(site, "erase", { email: "alice@example.com" })).status).toBe(400);
    const res = await privacy(site, "erase", { email: "alice@example.com", confirm: true });
    expect(res.status).toBe(200);
    expect((await res.json<PrivacyEraseDTO>()).counts).toMatchObject({ identities: 1, visits: 2, payments: 3, anonymizedVisits: 1, webhookDeliveries: 1 });

    expect(await row("SELECT 1 FROM web_visitors WHERE site_id = ?1 AND id = ?2", site.id, ALICE)).toBeNull();
    expect(await row("SELECT 1 FROM web_sessions WHERE visitor_id = ?1", ALICE)).toBeNull();
    expect(await row("SELECT 1 FROM web_sessions WHERE id = ?1", first)).toBeNull();
    expect(await row("SELECT visitor_id, city, timezone FROM web_sessions WHERE id = ?1", second)).toMatchObject({ visitor_id: expect.stringMatching(/^erased_/), city: "", timezone: "" });
    const { results: pays } = await env.DB.prepare("SELECT * FROM payments WHERE id IN ('api:charge:a1', 'api:charge:a2', 'api:refund:a1-refund')").all<Record<string, unknown>>();
    for (const p of pays) expect(p).toMatchObject({ email: null, customer_id: null, visitor_id: null, ref: null, personal_cleared_at: expect.any(Number) });
    expect(pays.find((p) => p.id === "api:charge:a1")).toMatchObject({ credited_session_id: second, amount_minor: 5000 });
    expect(await revenue(site)).toBe(before);
    expect(await row("SELECT 1 FROM payment_claims WHERE session_id = ?1", first)).toBeNull();
    expect((await env.DB.prepare("SELECT id FROM webhook_deliveries").all<{ id: string }>()).results.map((r) => r.id)).toEqual(["dlv_1"]);
    // Bob is untouched.
    expect(await row("SELECT email FROM payments WHERE id = 'api:charge:b1'")).toEqual({ email: "bob@example.com" });
    expect(await counts(site, { visitorId: BOB })).toMatchObject({ visits: 1, payments: 1 });
  });

  it("stays erased: no re-matching, re-sent events or later refunds bring the person back", async () => {
    const site = await createSite();
    await people(site);
    await privacy(site, "erase", { email: "alice@example.com", confirm: true });

    expect((await call(`${API}/sites/${site.id}/rematch`, json({}))).status).toBe(200);
    expect(await row("SELECT visitor_id, unmatched_reason FROM payments WHERE id = 'api:charge:a2'")).toEqual({ visitor_id: null, unmatched_reason: null });

    // The same charge sent again, and a new refund of it, both naming her.
    await pay(site, { id: "a1", email: "alice@example.com", customerId: "cus_A", visitorId: ALICE });
    await pay(site, { id: "a1-refund-2", kind: "refund", amount: 5, parentId: "a1", email: "alice@example.com", customerId: "cus_A" });
    expect(await row("SELECT email, customer_id FROM payments WHERE id = 'api:charge:a1'")).toEqual({ email: null, customer_id: null });
    expect(await row("SELECT email, customer_id, personal_cleared_at FROM payments WHERE id = 'api:refund:a1-refund-2'")).toMatchObject({
      email: null,
      customer_id: null,
      personal_cleared_at: expect.any(Number),
    });

    // She can come back as a new visitor and be identified as usual.
    await visit(site, ALICE);
    expect((await call(`${API}/sites/${site.id}/identify`, json({ visitorId: ALICE, email: "alice@example.com" }))).status).toBe(200);
    expect(await row("SELECT email FROM web_visitors WHERE site_id = ?1 AND id = ?2", site.id, ALICE)).toEqual({ email: "alice@example.com" });
  });

  it("keeps erased payments' credit when the attribution model changes", async () => {
    const site = await createSite();
    const { second } = await people(site);
    await privacy(site, "erase", { visitorId: ALICE, confirm: true });
    expect((await call(`${API}/sites/${site.id}`, { ...json({ attributionModel: "first_touch" }), method: "PATCH" })).status).toBe(200);
    expect(await row("SELECT credited_session_id FROM payments WHERE id = 'api:charge:a1'")).toEqual({ credited_session_id: second });
  });

  it("warns about active subscriptions", async () => {
    const site = await createSite();
    await people(site);
    await env.DB.prepare("INSERT INTO subscriptions (id, site_id, provider, customer_id, status, started_at, updated_at) VALUES ('api:sub_1', ?1, 'api', 'cus_A', 'active', 0, 0)")
      .bind(site.id)
      .run();
    const res = await (await privacy(site, "erase", { paymentId: "api:charge:a2", confirm: true })).json<PrivacyEraseDTO>();
    expect(res.counts).toMatchObject({ subscriptions: 1, activeSubscriptions: 1 });
    expect(res.warnings.join(" ")).toContain("still active");
    expect(await row("SELECT customer_id FROM subscriptions WHERE id = 'api:sub_1'")).toEqual({ customer_id: null });
  });
});

describe("customer data retention", () => {
  it("clears old payments' details on sites that set it, and forgets old identities", async () => {
    const site = await createSite();
    const keepAll = await createSite({ name: "Keep", domains: ["keep.example.com"] });
    expect((await call(`${API}/sites/${site.id}`, { ...json({ customerRetentionMonths: 6 }), method: "PATCH" })).status).toBe(400);
    const patched = await call(`${API}/sites/${site.id}`, { ...json({ customerRetentionMonths: 12 }), method: "PATCH" });
    expect((await patched.json<SiteDTO>()).customerRetentionMonths).toBe(12);

    const old = now() - 400 * 86400;
    await pay(site, { id: "old", email: "old@example.com", customerId: "cus_old", occurredAt: old });
    await pay(site, { id: "new", email: "new@example.com", customerId: "cus_new" });
    await pay(keepAll, { id: "old-kept", email: "kept@example.com", occurredAt: old });
    await visit(site, BOB);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO web_visitors (site_id, id, first_seen, email) VALUES (?1, 'gone-visitor-00001', ?2, 'gone@example.com')").bind(site.id, old),
      env.DB.prepare("INSERT INTO web_visitors (site_id, id, first_seen, email) VALUES (?1, ?2, ?3, 'bob@example.com')").bind(site.id, BOB, old),
      env.DB.prepare("INSERT INTO subscriptions (id, site_id, provider, customer_id, status, started_at, ended_at, updated_at) VALUES ('api:old_sub', ?1, 'api', 'cus_old', 'ended', ?2, ?2, 0)").bind(site.id, old),
    ]);

    await pruneCustomerData(env.DB);
    expect(await row("SELECT email, customer_id, personal_cleared_at FROM payments WHERE id = 'api:charge:old'")).toMatchObject({ email: null, customer_id: null, personal_cleared_at: expect.any(Number) });
    expect(await row("SELECT email, personal_cleared_at FROM payments WHERE id = 'api:charge:new'")).toEqual({ email: "new@example.com", personal_cleared_at: null });
    expect(await row("SELECT email FROM payments WHERE id = 'api:charge:old-kept'")).toEqual({ email: "kept@example.com" });
    expect(await row("SELECT 1 FROM web_visitors WHERE id = 'gone-visitor-00001'")).toBeNull();
    expect(await row("SELECT email FROM web_visitors WHERE id = ?1", BOB)).toEqual({ email: "bob@example.com" });
    expect(await row("SELECT customer_id FROM subscriptions WHERE id = 'api:old_sub'")).toEqual({ customer_id: null });
  });
});

describe("who may", () => {
  it("needs both Manage websites and See revenue, from a session or an API key", async () => {
    const site = await createSite();
    await addUser("manager@example.com", "user", ["sites.manage", "stats.view"]);
    await addUser("both@example.com", "user", ["sites.manage", "revenue.view", "stats.view", "api.use"]);
    const body = { email: "alice@example.com" };
    expect((await adminCall("manager@example.com", `/sites/${site.id}/privacy/lookup`, { body })).status).toBe(403);
    expect((await adminCall("manager@example.com", `/sites/${site.id}/privacy/requests`)).status).toBe(403);
    expect((await adminCall("both@example.com", `/sites/${site.id}/privacy/lookup`, { body })).status).toBe(200);
    const key = await addKey("both@example.com", ["sites.manage", "revenue.view"]);
    expect((await call(`${API}/sites/${site.id}/privacy/lookup`, json(body, key.auth))).status).toBe(200);
    const viewOnly = await addKey("both@example.com", ["sites.manage"]);
    expect((await call(`${API}/sites/${site.id}/privacy/erase`, json({ ...body, confirm: true }, viewOnly.auth))).status).toBe(403);
  });
});

describe("deleting a site", () => {
  it("removes its spikes, daily event totals and privacy requests too", async () => {
    const site = await createSite();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO site_spikes (site_id, source, detected_at, visits, baseline) VALUES (?1, 'x', 1, 1, 1)").bind(site.id),
      env.DB.prepare("INSERT INTO web_daily_events (site_id, day, kind, name, events, visitors) VALUES (?1, '2026-01-01', 'pageview', '/', 1, 1)").bind(site.id),
      env.DB.prepare("INSERT INTO privacy_requests (id, site_id, kind, by_identity, created_at, counts) VALUES ('pr_1', ?1, 'export', 'x', 0, '{}')").bind(site.id),
    ]);
    expect((await call(`${API}/sites/${site.id}`, { method: "DELETE", headers: json({}).headers })).status).toBe(200);
    for (const table of ["site_spikes", "web_daily_events", "privacy_requests"]) expect(await row(`SELECT 1 FROM ${table} WHERE site_id = ?1`, site.id), table).toBeNull();
  });

  it("deletes the site's payment webhooks with it", async () => {
    const site = await createSite();
    await env.DB.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, created_at) VALUES ('dlv_x', 1, 'evt', 'site.payment', ?1, 'delivered', 0)")
      .bind(JSON.stringify({ data: { site: { id: site.id }, payment: { id: "p", email: "x@example.com" } } }))
      .run();
    await call(`${API}/sites/${site.id}`, { method: "DELETE", headers: json({}).headers });
    expect(await row("SELECT 1 FROM webhook_deliveries WHERE id = 'dlv_x'")).toBeNull();
  });
});

// ---- Regressions from the security review of this feature ----------------------------------

/** Any collector event by a persistent visitor (checkout, identify…). */
async function event(site: SiteDTO, visitorId: string, payload: Record<string, unknown>): Promise<void> {
  const res = await call(`${ORIGIN}/_t/e`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ s: site.id, u: `${SITE_ORIGIN}/`, r: "", w: 1440, v: visitorId, ...payload }),
  });
  expect(res.status).toBe(200);
}

describe("erasure and matching, after the security review", () => {
  it("doesn't fail a renewal of an erased subscription, and the daily retry carries on", async () => {
    const site = await createSite();
    const first = await visit(site, ALICE);
    await pay(site, { id: "s1", ref: first, email: "alice@example.com", subscriptionId: "sub_1" });
    await privacy(site, "erase", { email: "alice@example.com", confirm: true });
    // The renewal names the subscription only: the erased charge must not hand it a missing visitor.
    const renewal = await call(`${API}/sites/${site.id}/payments`, json({ id: "s2", amount: 50, currency: "USD", subscriptionId: "sub_1", renewal: true }));
    expect(renewal.status).toBe(201);
    expect(await row("SELECT visitor_id FROM payments WHERE id = 'api:charge:s2'")).toEqual({ visitor_id: null });
    expect((await call(`${API}/sites/${site.id}/rematch`, json({}))).status).toBe(200);
  });

  it("never treats someone else's payment, guessed onto the person's visit by checkout timing, as theirs", async () => {
    const site = await createSite();
    await visit(site, ALICE);
    await event(site, ALICE, { t: "checkout" });
    // Bob pays right then with no reference: matched to Alice's visit by timing, then his next payment by customer.
    await pay(site, { id: "bob1", email: "bob@example.com", customerId: "cus_B" });
    await pay(site, { id: "bob2", email: "bob2@example.com", customerId: "cus_B" });
    expect(await row("SELECT visitor_id, matched_by FROM payments WHERE id = 'api:charge:bob1'")).toEqual({ visitor_id: ALICE, matched_by: "timing" });
    expect(await row("SELECT matched_by, confidence FROM payments WHERE id = 'api:charge:bob2'")).toEqual({ matched_by: "customer", confidence: "low" });

    const exported = await (await privacy(site, "export", { visitorId: ALICE })).json<{ payments: unknown[] }>();
    expect(exported.payments).toEqual([]);
    // Erasing Bob leaves Alice's visit.
    await privacy(site, "erase", { email: "bob@example.com", confirm: true });
    expect(await counts(site, { visitorId: ALICE })).toMatchObject({ visits: 1 });
  });

  it("unlinks, without clearing, someone else's payment guessed onto an erased visitor", async () => {
    const site = await createSite();
    await visit(site, ALICE);
    await event(site, ALICE, { t: "checkout" });
    await pay(site, { id: "carol1", email: "carol@example.com", customerId: "cus_C" });
    expect(await row("SELECT visitor_id FROM payments WHERE id = 'api:charge:carol1'")).toEqual({ visitor_id: ALICE });
    await privacy(site, "erase", { visitorId: ALICE, confirm: true });
    expect(await row("SELECT email, visitor_id, matched_by, personal_cleared_at FROM payments WHERE id = 'api:charge:carol1'")).toEqual({
      email: "carol@example.com",
      visitor_id: null,
      matched_by: null,
      personal_cleared_at: null,
    });
  });

  it("doesn't let an email a browser claimed lead to that email's real owner", async () => {
    const site = await createSite();
    const victimVisit = await visit(site, BOB);
    await pay(site, { id: "v1", ref: victimVisit, email: "victim@example.com", customerId: "cus_V" });
    const mallory = "mallory-visitor-01";
    await visit(site, mallory);
    await event(site, mallory, { t: "identify", e: { email: "victim@example.com" } });

    const exported = await (await privacy(site, "export", { visitorId: mallory })).json<{ payments: unknown[] }>();
    expect(exported.payments).toEqual([]);
    await privacy(site, "erase", { visitorId: mallory, confirm: true });
    expect(await row("SELECT email FROM payments WHERE id = 'api:charge:v1'")).toEqual({ email: "victim@example.com" });
    // The victim's own request does reach an identity planted with their email.
    await event(site, mallory, { t: "identify", e: { email: "victim@example.com" } });
    expect(await counts(site, { email: "victim@example.com" })).toMatchObject({ identities: 2, payments: 1 });
  });

  it("keeps anonymized visits anonymous: later payments and identify can't name them", async () => {
    const site = await createSite();
    const { second } = await people(site);
    await privacy(site, "erase", { email: "alice@example.com", confirm: true });
    await pay(site, { id: "late", ref: second, email: "alice@example.com" });
    expect((await call(`${API}/sites/${site.id}/identify`, json({ ref: second, email: "alice@example.com" }))).status).toBe(404);
    expect(await row("SELECT id FROM web_visitors WHERE id LIKE 'erased_%'")).toBeNull();
    expect(await row("SELECT session_id FROM payments WHERE id = 'api:charge:late'")).toEqual({ session_id: null });
  });

  it("keeps a subscription's customer id gone when the provider sends it again", async () => {
    const site = await createSite();
    await people(site);
    await env.DB.prepare("INSERT INTO subscriptions (id, site_id, provider, customer_id, status, started_at, updated_at) VALUES ('api:sub_9', ?1, 'api', 'cus_A', 'canceled', 0, 0)")
      .bind(site.id)
      .run();
    await privacy(site, "erase", { email: "alice@example.com", confirm: true });
    await storeSubscription(env.DB, site, "api", { providerId: "sub_9", status: "canceled", customerId: "cus_A" });
    expect(await row("SELECT customer_id FROM subscriptions WHERE id = 'api:sub_9'")).toEqual({ customer_id: null });
  });

  it("follows a sure match to the person's second visitor and its payments", async () => {
    const site = await createSite();
    const other = "alice-other-device1";
    const visitB = await visit(site, other);
    await pay(site, { id: "x1", ref: visitB, email: "alice@example.com" });
    const visitB2 = await visit(site, other, `${SITE_ORIGIN}/?utm_source=ads&utm_medium=cpc`);
    await pay(site, { id: "x2", ref: visitB2 });
    expect(await counts(site, { email: "alice@example.com" })).toMatchObject({ visits: 2, payments: 2 });
    await privacy(site, "erase", { email: "alice@example.com", confirm: true });
    expect(await row("SELECT visitor_id, ref, personal_cleared_at FROM payments WHERE id = 'api:charge:x2'")).toMatchObject({ visitor_id: null, ref: null, personal_cleared_at: expect.any(Number) });
  });

  it("refuses lesser permissions, the default API token, and retention changes without See revenue", async () => {
    const site = await createSite();
    await addUser("viewer@example.com", "user", ["stats.view"]);
    await addUser("money@example.com", "user", ["revenue.view", "stats.view"]);
    await addUser("manager@example.com", "user", ["sites.manage", "stats.view"]);
    for (const who of ["viewer@example.com", "money@example.com", "manager@example.com"]) {
      for (const what of ["lookup", "export", "erase"]) {
        expect((await adminCall(who, `/sites/${site.id}/privacy/${what}`, { body: { email: "a@example.com", confirm: true } })).status, `${who} ${what}`).toBe(403);
      }
    }
    const token = bearer;
    for (const what of ["lookup", "export", "erase"]) expect((await call(`${API}/sites/${site.id}/privacy/${what}`, json({ email: "a@example.com", confirm: true }, token), { API_TOKEN_SCOPE: "create" })).status).toBe(403);
    expect((await adminCall("manager@example.com", `/sites/${site.id}`, { method: "PATCH", body: { customerRetentionMonths: 12 } })).status).toBe(403);
    expect((await adminCall("manager@example.com", `/sites/${site.id}`, { method: "PATCH", body: { name: "Renamed" } })).status).toBe(200);
  });
});

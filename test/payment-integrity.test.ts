// Payments that can't be forged or misfiled quietly: browser claims, checkout
// references, Gumroad's word over a ping's, payment ids across sites, the order
// of subscription events, refund limits, click tokens, the collector's budget,
// CSV cells and searches that keep emails out of URLs.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import checksMigration from "../migrations/0040_payment_checks.sql?raw";
import subscriptionMigration from "../migrations/0041_subscription_order.sql?raw";
import { csv, csvCell } from "../src/shared/csv";
import { buildLocation } from "../src/shared/target";
import type { ConnectionDTO, SiteDTO, SiteOverviewDTO, SitePaymentDTO } from "../src/shared/sites";
import type { SystemHealthDTO } from "../src/shared/types";
import { FREE } from "../src/worker/plan";
import { bytesToBase64, bytesToHex, sign } from "../src/worker/revenue/crypto";
import { fetchRates, reconvertSite } from "../src/worker/revenue/fx";
import { storePayment, storeSubscription } from "../src/worker/revenue/ingest";
import { claimRefs } from "../src/worker/revenue/match";
import { announcePayments } from "../src/worker/revenue/notify";
import { ADAPTERS } from "../src/worker/revenue/providers";
import type { NormalizedPayment } from "../src/worker/revenue/types";
import { budgetKey, chargeCollectBudget, collectBudgetAllows, DEFAULT_EVENT_ROWS, FLUSH_ROWS, MAX_EVENT_ROWS, resetCollectBudget } from "../src/worker/web/budget";
import { resolvePerson } from "../src/worker/web/privacy";
import { resetSiteCaches } from "../src/worker/web/sites";
import { signClickToken, verifyClickToken } from "../src/worker/web/token";
import { API, call, json, ORIGIN, putLink, resetData } from "./helpers";
import { adminCall } from "./people";

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const DAY = 86400;
const headers = json({}).headers;
const now = () => Math.floor(Date.now() / 1000);

/** Sales Gumroad's API knows, and how often it was asked. */
let gumroadSales: Record<string, Record<string, unknown>> = {};
let gumroadCalls: string[] = [];
/** Set: how Gumroad's API answers instead of looking the sale up. */
let gumroadOutage: (() => Response) | null = null;
let fxResponses: Record<string, Record<string, number>> = {};

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetData();
  await env.DB.exec("DELETE FROM link_clicks");
  resetSiteCaches();
  resetCollectBudget();
  gumroadSales = {};
  gumroadCalls = [];
  gumroadOutage = null;
  fxResponses = {};
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("frankfurter")) {
      const day = new URL(url).pathname.split("/").pop()!;
      const rates = fxResponses[day];
      return rates ? Response.json({ date: day, rates }) : new Response("offline", { status: 503 });
    }
    if (url.startsWith("https://api.gumroad.com/v2/sales?")) return gumroadOutage ? gumroadOutage() : Response.json({ success: true, sales: [] });
    if (url.startsWith("https://api.gumroad.com/v2/sales/")) {
      const id = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      gumroadCalls.push(id);
      if (gumroadOutage) return gumroadOutage();
      const sale = gumroadSales[id];
      return sale ? Response.json({ success: true, sale }) : Response.json({ success: false }, { status: 404 });
    }
    if (url.startsWith("https://hooks.example.com/")) return new Response("ok");
    return realFetch(input, init);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function createSite(domain = "shop.example.com"): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: [domain] }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

async function connect(site: SiteDTO, body: Record<string, unknown>): Promise<ConnectionDTO> {
  const res = await call(`${API}/sites/${site.id}/connections`, json(body));
  expect(res.status).toBe(201);
  resetSiteCaches();
  return res.json<ConnectionDTO>();
}

function collect(site: SiteDTO, payload: Record<string, unknown> = {}, ip = "203.0.113.7", origin = SITE_ORIGIN, extraEnv: Partial<Env> = {}): Promise<Response> {
  return call(
    `${ORIGIN}/_t/e`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: origin, "User-Agent": UA, "CF-Connecting-IP": ip },
      body: JSON.stringify({ s: site.id, t: "pageview", u: `${origin}/`, r: "", w: 1440, ...payload }),
    },
    extraEnv,
  );
}

async function visit(site: SiteDTO, payload: Record<string, unknown> = {}, ip?: string, origin?: string): Promise<string> {
  const res = await collect(site, payload, ip, origin);
  expect(res.status).toBe(200);
  return (await res.json<{ s: string }>()).s;
}

const pay = (site: SiteDTO, body: Record<string, unknown>) => call(`${API}/sites/${site.id}/payments`, json({ amount: 10, currency: "USD", ...body }));
const row = <T = Record<string, unknown>>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<T>();
const paymentRow = (id: string) => row<{ session_id: string | null; matched_by: string | null; confidence: string | null; amount_minor: number; anomaly: string | null; unverified: number; site_id: string; email: string | null }>("SELECT * FROM payments WHERE id = ?1", id);
const visitorOf = async (session: string) => (await row<{ visitor_id: string }>("SELECT visitor_id FROM web_sessions WHERE id = ?1", session))!.visitor_id;
const emailOf = async (site: SiteDTO, visitor: string) => (await row<{ email: string | null }>("SELECT email FROM web_visitors WHERE site_id = ?1 AND id = ?2", site.id, visitor))?.email ?? null;
const list = async (site: SiteDTO) => (await (await call(`${API}/sites/${site.id}/payments?range=7d`, { headers })).json<{ payments: SitePaymentDTO[] }>()).payments;
const health = async () => (await adminCall("", "/settings/health")).json<SystemHealthDTO>();
/** As if the delivery was made over a minute ago, so its retry may take it over. */
const ageEvents = () => env.DB.prepare("UPDATE payment_events SET received_at = received_at - 120 WHERE processed_at IS NULL").run();
const stripeBody = (id: string, type: string, object: Record<string, unknown>, created = now()) => JSON.stringify({ id, type, livemode: true, created, data: { object } });
async function sendStripe(conn: ConnectionDTO, body: string): Promise<Response> {
  const t = now();
  return call(`${ORIGIN}/_pay/stripe/${conn.id}`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${bytesToHex(await sign("whsec_test", `${t}.${body}`))}` }, body });
}

describe("what a browser claims about a payment", () => {
  it("doesn't reach a payment older than a day, on any path", async () => {
    const site = await createSite();
    expect((await pay(site, { id: "sale-old", email: "buyer@example.com", occurredAt: now() - 3 * DAY })).status).toBe(201);
    const claimer = await visit(site, { k: ["sale-old"] });

    // The sweep on the claim itself, the rematch button, a server identify, a later event of the same sale.
    await call(`${API}/sites/${site.id}/rematch`, { method: "POST", headers });
    await call(`${API}/sites/${site.id}/identify`, json({ ref: claimer, email: "someone@example.com" }));
    await pay(site, { id: "sale-old", email: "buyer@example.com", occurredAt: now() - 3 * DAY });

    expect(await paymentRow("api:charge:sale-old")).toMatchObject({ session_id: null, matched_by: null });
    expect(await emailOf(site, await visitorOf(claimer))).toBe("someone@example.com");
  });

  it("matches a timely return page, but never says who the buyer is", async () => {
    const site = await createSite();
    await pay(site, { id: "sale-new", email: "buyer@example.com", occurredAt: now() - 120 });
    const claimer = await visit(site, { k: ["sale-new"] });
    expect(await paymentRow("api:charge:sale-new")).toMatchObject({ session_id: claimer, matched_by: "claim", confidence: "low" });
    const visitor = await visitorOf(claimer);
    expect(await emailOf(site, visitor)).toBeNull();
    // A rights request for the buyer doesn't take in whoever claimed the payment.
    const person = await resolvePerson(env.DB, site, { email: "buyer@example.com" });
    expect(person.paymentIds).toContain("api:charge:sale-new");
    expect(person.visitorIds).not.toContain(visitor);
  });

  it("lets the buyer's own return page replace one planted before the sale", async () => {
    const site = await createSite();
    const planted = await visit(site, { k: ["sale-squat"] }, "198.51.100.1");
    // Planted a while ago, and again shortly before the sale.
    await env.DB.prepare("UPDATE payment_claims SET claimed_at = ?1 WHERE ref = 'sale-squat'").bind(now() - 2 * DAY).run();
    await pay(site, { id: "sale-squat", email: "buyer@example.com", occurredAt: now() - 60 });
    expect((await paymentRow("api:charge:sale-squat"))!.session_id).toBeNull();

    const genuine = await visit(site, { k: ["sale-squat"] }, "198.51.100.2");
    expect(genuine).not.toBe(planted);
    expect(await paymentRow("api:charge:sale-squat")).toMatchObject({ session_id: genuine, matched_by: "claim", confidence: "low" });
    expect(await row("SELECT session_id, source FROM payment_claims WHERE ref = 'sale-squat'")).toEqual({ session_id: genuine, source: "browser" });
    expect(await emailOf(site, await visitorOf(planted))).toBeNull();
  });

  it("doesn't count a claim made long before the payment", async () => {
    const site = await createSite();
    await visit(site, { k: ["sale-early"] });
    await env.DB.prepare("UPDATE payment_claims SET claimed_at = ?1 WHERE ref = 'sale-early'").bind(now() - 2 * 3600).run();
    await pay(site, { id: "sale-early", email: "b@example.com", occurredAt: now() });
    expect((await paymentRow("api:charge:sale-early"))!.matched_by).toBeNull();
  });

  it("treats claims from before this version like a browser's", async () => {
    const site = await createSite();
    const session = await visit(site);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at) VALUES (?1, 'old-claim', ?2, ?3)").bind(site.id, session, now() - 5 * DAY),
      env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at) VALUES (?1, 'near-claim', ?2, ?3)").bind(site.id, session, now() - 60),
    ]);
    await pay(site, { id: "old-claim", email: "a@example.com", occurredAt: now() });
    await pay(site, { id: "near-claim", email: "b@example.com", occurredAt: now() - 120 });
    expect((await paymentRow("api:charge:old-claim"))!.session_id).toBeNull();
    expect(await paymentRow("api:charge:near-claim")).toMatchObject({ session_id: session, confidence: "low" });
  });

  it("counts a return page for a bank debit that settles days after its checkout", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const buyer = await visit(site, { k: ["cs_debit"] });
    const started = now() - 3 * DAY;
    await env.DB.prepare("UPDATE payment_claims SET claimed_at = ?1 WHERE ref = 'cs_debit'").bind(started + 60).run();
    const session = { id: "cs_debit", created: started, mode: "payment", payment_status: "paid", payment_intent: "pi_debit", amount_total: 4900, currency: "usd" };
    expect((await sendStripe(conn, stripeBody("evt_debit", "checkout.session.async_payment_succeeded", session))).status).toBe(200);
    expect(await paymentRow("stripe:charge:pi_debit")).toMatchObject({ session_id: buyer, matched_by: "claim", confidence: "low" });
  });

  it("still ignores a return page far from both the checkout and the payment", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
    await visit(site, { k: ["cs_far"] });
    await env.DB.prepare("UPDATE payment_claims SET claimed_at = ?1 WHERE ref = 'cs_far'").bind(now() - 10 * DAY).run();
    const session = { id: "cs_far", created: now() - 3 * DAY, mode: "payment", payment_status: "paid", payment_intent: "pi_far", amount_total: 4900, currency: "usd" };
    await sendStripe(conn, stripeBody("evt_far", "checkout.session.async_payment_succeeded", session));
    expect((await paymentRow("stripe:charge:pi_far"))!.session_id).toBeNull();
  });

  it("matches a late claim through the sweep when the payment was begun near it", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const session = { id: "cs_sweep", created: now() - 3600, mode: "payment", payment_status: "paid", payment_intent: "pi_sweep", amount_total: 100, currency: "usd" };
    await sendStripe(conn, stripeBody("evt_sweep", "checkout.session.async_payment_succeeded", session, now() + 2 * 3600));
    expect((await paymentRow("stripe:charge:pi_sweep"))!.session_id).toBeNull();
    const buyer = await visit(site, { k: ["cs_sweep"] });
    expect(await paymentRow("stripe:charge:pi_sweep")).toMatchObject({ session_id: buyer, confidence: "low" });
  });

  it("keeps a trial's claim from before this version for its subscription, at low confidence", async () => {
    const site = await createSite();
    const session = await visit(site);
    await env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at) VALUES (?1, 'sub_trial', ?2, ?3)").bind(site.id, session, now() - 14 * DAY).run();
    await pay(site, { id: "in-first", subscriptionId: "sub_trial", email: "t@example.com" });
    expect(await paymentRow("api:charge:in-first")).toMatchObject({ session_id: session, matched_by: "claim", confidence: "low" });
    expect(await emailOf(site, await visitorOf(session))).toBeNull();
  });

  it("doesn't extend that to what a browser claimed since, or to other ids", async () => {
    const site = await createSite();
    const session = await visit(site);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at, source) VALUES (?1, 'sub_browser', ?2, ?3, 'browser')").bind(site.id, session, now() - 14 * DAY),
      env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at) VALUES (?1, 'cus_old', ?2, ?3)").bind(site.id, session, now() - 14 * DAY),
    ]);
    await pay(site, { id: "in-b", subscriptionId: "sub_browser" });
    await pay(site, { id: "in-c", customerId: "cus_old" });
    expect((await paymentRow("api:charge:in-b"))!.session_id).toBeNull();
    expect((await paymentRow("api:charge:in-c"))!.session_id).toBeNull();
  });

  it("keeps a claim from a signed webhook above any browser's", async () => {
    const site = await createSite();
    const real = await visit(site, {}, "198.51.100.3");
    const other = await visit(site, {}, "198.51.100.4");
    await claimRefs(env, site, real, ["sub_signed"], now() - 5 * DAY, "provider");
    await claimRefs(env, site, other, ["sub_signed"], now(), "browser");
    expect(await row("SELECT session_id, source FROM payment_claims WHERE ref = 'sub_signed'")).toEqual({ session_id: real, source: "provider" });
    // However long after the checkout. It credits the visit, but only repeats a reference anyone can put on a checkout address.
    await pay(site, { id: "inv-1", subscriptionId: "sub_signed", email: "sub@example.com" });
    expect(await paymentRow("api:charge:inv-1")).toMatchObject({ session_id: real, matched_by: "claim", confidence: "high" });
    expect(await emailOf(site, await visitorOf(real))).toBeNull();
  });

  it("doesn't name the customer through a renewal of a claimed payment", async () => {
    const site = await createSite();
    await pay(site, { id: "first", customerId: "cus_1", occurredAt: now() - 60 });
    const claimer = await visit(site, { k: ["first"] });
    await env.DB.prepare("UPDATE payments SET confidence = 'high' WHERE id = 'api:charge:first'").run(); // As an older version stored it.
    await pay(site, { id: "second", customerId: "cus_1", email: "paying@example.com" });
    expect((await paymentRow("api:charge:second"))!.matched_by).toBe("customer");
    expect(await emailOf(site, await visitorOf(claimer))).toBeNull();
  });
});

describe("references on checkout links", () => {
  const go = async (path: string) => {
    const res = await call(`${ORIGIN}/${path}`, { headers: { "User-Agent": UA }, redirect: "manual" });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("Location")!);
  };

  it("doesn't let a visitor set the reference of a pass-through checkout link", async () => {
    const site = await createSite();
    await connect(site, { provider: "gumroad" });
    await putLink("buy", { u: "https://jan.gumroad.com/l/book?plan=gold", qp: 1 });
    for (const param of ["sh_ref=attackerref123456", "sh%5Fref=attackerref123456"]) {
      const url = await go(`buy?${param}&plan=free&color=red`);
      const refs = url.searchParams.getAll("sh_ref");
      expect(refs).toHaveLength(1);
      expect(refs[0]).not.toBe("attackerref123456");
      // The owner's parameter stands, an unrelated one passes.
      expect(url.searchParams.getAll("plan")).toEqual(["gold"]);
      expect(url.searchParams.get("color")).toBe("red");
      await vi.waitFor(async () => expect(await row("SELECT 1 AS ok FROM link_clicks WHERE ref = ?1", refs[0])).toEqual({ ok: 1 }));
    }
  });

  it("keeps a reference the owner put in the link", async () => {
    const site = await createSite();
    await connect(site, { provider: "gumroad" });
    await putLink("own", { u: "https://jan.gumroad.com/l/book?sh_ref=ownersref12345", qp: 1 });
    expect((await go("own?sh_ref=attackerref123456")).searchParams.getAll("sh_ref")).toEqual(["ownersref12345"]);
    expect(await row("SELECT COUNT(*) AS n FROM link_clicks")).toEqual({ n: 0 });
  });

  it("leaves the same names alone on other destinations", () => {
    expect(buildLocation("https://example.com/p?a=1", ["a=2", "client_reference_id=x", "b=3"], null)).toBe("https://example.com/p?a=1&client_reference_id=x&b=3");
  });

  it("only credits a click to a payment of the provider it was made for", async () => {
    const site = await createSite();
    await env.DB.prepare("INSERT INTO link_clicks (ref, domain, slug, provider, source, clicked_at) VALUES ('clickref12345678', 'sh.example', 'buy', 'stripe', '', ?1)").bind(now()).run();
    const p: NormalizedPayment = { kind: "charge", providerId: "s-1", occurredAt: now(), amountMinor: 100, currency: "USD", billing: "one_time", refs: [], ref: "clickref12345678", productIds: [], testMode: false };
    await storePayment(env.DB, site, "gumroad", null, p);
    expect((await paymentRow("gumroad:charge:s-1"))!.session_id).toBeNull();
    await storePayment(env.DB, site, "stripe", null, { ...p, providerId: "s-2" });
    expect((await paymentRow("stripe:charge:s-2"))!.session_id).toBe("clickref12345678");
  });
});

describe("Gumroad", () => {
  const ping = (conn: ConnectionDTO, fields: Record<string, string>) =>
    call(conn.webhookUrl.replace("https://sh.example", ORIGIN), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

  it("stores the sale as the API has it, not as the ping says", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    expect(conn.unverified).toBe(false);
    gumroadSales.s1 = { id: "s1", price: 1000, email: "real@example.com", purchaser_id: "p-real", product_id: "prod", created_at: new Date((now() - 60) * 1000).toISOString() };
    expect((await ping(conn, { sale_id: "s1", price: "1", email: "fake@example.com", purchaser_id: "p-fake", sale_timestamp: new Date().toISOString() })).status).toBe(200);
    expect(await paymentRow("gumroad:charge:s1")).toMatchObject({ amount_minor: 1000, email: "real@example.com", unverified: 0 });
    // verify and parse share one request.
    expect(gumroadCalls).toEqual(["s1"]);
    expect((await ping(conn, { sale_id: "unknown", price: "100" })).status).toBe(401);
  });

  it("keeps a refund or dispute the sale doesn't show yet, unverified, and confirms it on the retry", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    gumroadSales.s2 = { id: "s2", price: 500, refunded: false, partially_refunded: false, disputed: false, chargedback: false };
    expect((await ping(conn, { sale_id: "s2", price: "500" })).status).toBe(200);
    expect((await ping(conn, { resource_name: "refund", sale_id: "s2", price: "500" })).status).toBe(503);
    expect((await ping(conn, { resource_name: "dispute", sale_id: "s2", price: "500" })).status).toBe(503);
    expect(await paymentRow("gumroad:refund:s2")).toMatchObject({ amount_minor: -500, unverified: 1 });
    expect(await paymentRow("gumroad:dispute:s2")).toMatchObject({ amount_minor: -500, unverified: 1 });

    // Gumroad has caught up by the retry: it was a partial refund, and Gumroad's figure replaces the ping's.
    Object.assign(gumroadSales.s2, { partially_refunded: true, currency_symbol: "$", amount_refundable_in_currency: "3.00" });
    await ageEvents();
    expect((await ping(conn, { resource_name: "refund", sale_id: "s2", price: "500", refunded: "false" })).status).toBe(200);
    expect(await paymentRow("gumroad:refund:s2")).toMatchObject({ amount_minor: -200, unverified: 0 });
  });

  it.each([
    ["a server error", () => new Response("Bad gateway", { status: 502 }), 503],
    ["rate limiting", () => new Response("slow down", { status: 429 }), 503],
    ["a token that can't read sales", () => Response.json({ success: false, message: "scope" }, { status: 403 }), 200],
    ["a 404 that isn't Gumroad's", () => new Response("<html>not here</html>", { status: 404 }), 200],
    ["a timeout", () => { throw new DOMException("timed out", "TimeoutError"); }, 503],
  ] as const)("doesn't lose a sale to %s", async (_name, outage, status) => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    gumroadOutage = outage;
    expect((await ping(conn, { sale_id: "s-out", price: "1500", email: "b@example.com", sale_timestamp: new Date().toISOString() })).status).toBe(status);
    expect(await paymentRow("gumroad:charge:s-out")).toMatchObject({ amount_minor: 1500, unverified: 1 });
    expect((await row<{ last_error: string }>("SELECT last_error FROM payment_connections WHERE id = ?1", conn.id))!.last_error).toContain("s-out");
    expect((await list(site))[0]).toMatchObject({ unverified: true });
  });

  it("replaces what an unconfirmed ping said once Gumroad confirms the sale", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    gumroadOutage = () => new Response("down", { status: 503 });
    const fields = { sale_id: "s-fix", price: "1", email: "fake@example.com", sale_timestamp: new Date().toISOString() };
    expect((await ping(conn, fields)).status).toBe(503);
    expect(await paymentRow("gumroad:charge:s-fix")).toMatchObject({ amount_minor: 1, email: "fake@example.com", unverified: 1 });

    gumroadOutage = null;
    gumroadSales["s-fix"] = { id: "s-fix", price: 2500, email: "real@example.com" };
    await ageEvents();
    expect((await ping(conn, fields)).status).toBe(200);
    expect(await paymentRow("gumroad:charge:s-fix")).toMatchObject({ amount_minor: 2500, email: "real@example.com", unverified: 0 });
    expect((await row<{ last_error: string | null }>("SELECT last_error FROM payment_connections WHERE id = ?1", conn.id))!.last_error).toBeNull();
    // Announced once, however often it was delivered.
    expect(await row("SELECT processed_at IS NOT NULL AS done FROM payment_events WHERE connection_id = ?1", conn.id)).toEqual({ done: 1 });
  });

  it("still refuses a sale Gumroad says doesn't exist", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    for (const resource_name of ["sale", "refund", "dispute"]) expect((await ping(conn, { resource_name, sale_id: "made-up", price: "100" })).status).toBe(401);
    expect(await row("SELECT COUNT(*) AS n FROM payments")).toEqual({ n: 0 });
  });

  it("checks that the access token can read sales", async () => {
    gumroadOutage = () => Response.json({ success: false }, { status: 403 });
    expect(await ADAPTERS.gumroad.testApiKey!("tok", {})).toContain("403");
    gumroadOutage = null;
    expect(await ADAPTERS.gumroad.testApiKey!("tok", {})).toBeNull();
  });

  it("stores a partial refund at the refunded amount, and each later one as a new total", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    gumroadSales.s6 = { id: "s6", price: 10000, currency_symbol: "$", refunded: false, partially_refunded: false };
    await ping(conn, { sale_id: "s6", price: "10000" });
    Object.assign(gumroadSales.s6, { partially_refunded: true, amount_refundable_in_currency: "99.00" });
    expect((await ping(conn, { resource_name: "refund", sale_id: "s6", price: "10000", refunded: "false" })).status).toBe(200);
    expect(await paymentRow("gumroad:refund:s6")).toMatchObject({ amount_minor: -100, anomaly: null, unverified: 0 });

    gumroadSales.s6.amount_refundable_in_currency = "50.00";
    expect(await (await ping(conn, { resource_name: "refund", sale_id: "s6", price: "10000", refunded: "false" })).json()).not.toMatchObject({ duplicate: true });
    expect(await paymentRow("gumroad:refund:s6")).toMatchObject({ amount_minor: -5000 });

    Object.assign(gumroadSales.s6, { partially_refunded: false, refunded: true });
    await ping(conn, { resource_name: "refund", sale_id: "s6", price: "10000", refunded: "true" });
    expect(await paymentRow("gumroad:refund:s6")).toMatchObject({ amount_minor: -10000 });
  });

  it.each([
    ["another currency", { currency_symbol: "€", amount_refundable_in_currency: "5.00" }],
    ["no refundable amount", { currency_symbol: "$" }],
    ["an amount it can't read", { currency_symbol: "$", amount_refundable_in_currency: "1,000.00" }],
  ])("flags a partial refund it can't size (%s) instead of counting the whole sale", async (_name, fields) => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    gumroadSales.s7 = { id: "s7", price: 10000, refunded: false, partially_refunded: true, ...fields };
    await ping(conn, { sale_id: "s7", price: "10000" });
    expect((await ping(conn, { resource_name: "refund", sale_id: "s7", price: "10000", refunded: "false" })).status).toBe(200);
    expect(await paymentRow("gumroad:refund:s7")).toMatchObject({ amount_minor: 0, anomaly: "refund_unknown" });
    expect((await list(site)).find((p) => p.kind === "refund")).toMatchObject({ anomaly: "refund_unknown" });
    expect((await health()).checks.find((c) => c.id === "payments")?.detail).toContain("without");
  });

  it("without a token, trusts `refunded` to tell a whole refund from a partial one", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad" });
    await ping(conn, { sale_id: "s8", price: "4000" });
    await ping(conn, { resource_name: "refund", sale_id: "s8", price: "4000", refunded: "false" });
    expect(await paymentRow("gumroad:refund:s8")).toMatchObject({ amount_minor: 0, anomaly: "refund_unknown", unverified: 1 });
    // Fully refunded later: the amount is known, and the flag goes.
    await ping(conn, { resource_name: "refund", sale_id: "s8", price: "4000", refunded: "true" });
    expect(await paymentRow("gumroad:refund:s8")).toMatchObject({ amount_minor: -4000, anomaly: null });
  });

  it("confirms a cancellation through the subscription's sales", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    gumroadSales.s3 = { id: "s3", price: 900, subscription_id: "sub-g", cancelled: false, ended: false };
    expect((await ping(conn, { sale_id: "s3", price: "900", subscription_id: "sub-g" })).status).toBe(200);
    await storeSubscription(env.DB, site, "gumroad", { providerId: "sub-g", status: "active" });
    const status = async () => (await row<{ status: string }>("SELECT status FROM subscriptions WHERE id = 'gumroad:sub-g'"))!.status;

    // No sale id in the ping: the stored sale is looked up, and Gumroad says it isn't canceled.
    gumroadCalls = [];
    expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-g" })).status).toBe(503);
    expect(gumroadCalls).toEqual(["s3"]);
    expect(await status()).toBe("active");
    expect(await row("SELECT unconfirmed_end FROM subscriptions WHERE id = 'gumroad:sub-g'")).toEqual({ unconfirmed_end: "canceled" });

    // The event stays open: once Gumroad shows it, the retry goes through.
    gumroadSales.s3.cancelled = true;
    await ageEvents();
    expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-g" })).status).toBe(200);
    expect(await status()).toBe("canceled");
    expect(await row("SELECT unconfirmed_end FROM subscriptions WHERE id = 'gumroad:sub-g'")).toEqual({ unconfirmed_end: null });
  });

  describe("a ping nothing backs", () => {
    const revenue = async (site: SiteDTO) => (await (await call(`${API}/sites/${site.id}/overview?range=7d`, { headers })).json<SiteOverviewDTO>()).totals.revenue;
    const sale = async (conn: ConnectionDTO, id: string, fields: Record<string, unknown> = {}) => {
      gumroadSales[id] = { id, price: 1000, ...fields };
      expect((await ping(conn, { sale_id: id, price: "1000" })).status).toBe(200);
    };
    const lastError = async (conn: ConnectionDTO) => (await row<{ last_error: string | null }>("SELECT last_error FROM payment_connections WHERE id = ?1", conn.id))!.last_error;

    it.each([
      ["says no in one field and is silent in the other", { disputed: false }, 503],
      ["says nothing at all", {}, 200],
    ])("doesn't verify a dispute when the sale %s", async (_name, fields, status) => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await sale(conn, "d1", fields);
      expect((await ping(conn, { resource_name: "dispute", sale_id: "d1", price: "1000" })).status).toBe(status);
      expect(await paymentRow("gumroad:dispute:d1")).toMatchObject({ amount_minor: -1000, unverified: 1 });
      expect(await lastError(conn)).toContain("d1");
      expect(await revenue(site)).toBe(1000);
    });

    it.each([["disputed"], ["chargedback"]])("verifies a dispute when `%s` says so", async (field) => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await sale(conn, "d2", { [field]: true });
      expect((await ping(conn, { resource_name: "dispute", sale_id: "d2", price: "1000" })).status).toBe(200);
      expect(await paymentRow("gumroad:dispute:d2")).toMatchObject({ amount_minor: -1000, unverified: 0 });
      expect(await revenue(site)).toBe(0);
    });

    it("doesn't verify a refund or a won dispute the sale is silent about", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await sale(conn, "r1");
      expect((await ping(conn, { resource_name: "refund", sale_id: "r1", price: "1000" })).status).toBe(200);
      expect((await ping(conn, { resource_name: "dispute_won", sale_id: "r1", price: "1000" })).status).toBe(200);
      expect(await paymentRow("gumroad:refund:r1")).toMatchObject({ unverified: 1 });
      expect(await paymentRow("gumroad:dispute_won:r1")).toMatchObject({ unverified: 1 });
      expect(await revenue(site)).toBe(1000);
    });

    it("counts a held refund once Gumroad confirms it", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await sale(conn, "r2", { refunded: false, partially_refunded: false });
      expect((await ping(conn, { resource_name: "refund", sale_id: "r2", price: "1000" })).status).toBe(503);
      expect(await revenue(site)).toBe(1000);
      gumroadSales.r2!.refunded = true;
      await ageEvents();
      expect((await ping(conn, { resource_name: "refund", sale_id: "r2", price: "1000" })).status).toBe(200);
      expect(await paymentRow("gumroad:refund:r2")).toMatchObject({ amount_minor: -1000, unverified: 0 });
      expect(await revenue(site)).toBe(0);
    });

    it("can't use up what a real refund may take, or change a confirmed one", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await sale(conn, "r3", { partially_refunded: true, currency_symbol: "$", amount_refundable_in_currency: "6.00" });
      expect((await ping(conn, { resource_name: "refund", sale_id: "r3", price: "1000", refunded: "false" })).status).toBe(200);
      expect(await paymentRow("gumroad:refund:r3")).toMatchObject({ amount_minor: -400, unverified: 0 });
      // Gumroad stops answering, and a forged, bigger "total" arrives.
      gumroadOutage = () => new Response("down", { status: 503 });
      expect((await ping(conn, { resource_name: "refund", sale_id: "r3", price: "1000", refunded: "true" })).status).toBe(503);
      expect(await paymentRow("gumroad:refund:r3")).toMatchObject({ amount_minor: -400, unverified: 0 });
      expect(await revenue(site)).toBe(600);

      gumroadOutage = null;
      await sale(conn, "r4");
      await storePayment(env.DB, site, "gumroad", conn.id, { kind: "refund", providerId: "forged", occurredAt: now() - 50, amountMinor: 1000, currency: "USD", billing: null, refs: [], parentRef: "r4", productIds: [], testMode: false, unverified: true });
      await storePayment(env.DB, site, "gumroad", conn.id, { kind: "refund", providerId: "real", occurredAt: now(), amountMinor: 700, currency: "USD", billing: null, refs: [], parentRef: "r4", productIds: [], testMode: false });
      expect(await paymentRow("gumroad:refund:real")).toMatchObject({ amount_minor: -700, anomaly: null });
    });

    it("keeps a held refund at 0 when the site's currency changes", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await sale(conn, "r5", { refunded: false });
      await ping(conn, { resource_name: "refund", sale_id: "r5", price: "1000" });
      await reconvertSite(env.DB, site.id, "USD");
      expect(await row("SELECT amount_site_minor FROM payments WHERE id = 'gumroad:refund:r5'")).toEqual({ amount_site_minor: 0 });
    });

    it("without a token a refund still counts against its equally unverified sale, up to what was paid", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad" });
      await ping(conn, { sale_id: "n1", price: "1000" });
      await ping(conn, { resource_name: "refund", sale_id: "n1", price: "1000" });
      expect(await revenue(site)).toBe(0);
      await ping(conn, { resource_name: "dispute", sale_id: "n1", price: "1000" });
      expect(await paymentRow("gumroad:dispute:n1")).toMatchObject({ unverified: 1 });
      expect(await revenue(site)).toBe(0);
      // With no sale at all, it counts for nothing.
      await ping(conn, { resource_name: "refund", sale_id: "n2", price: "5000" });
      expect(await paymentRow("gumroad:refund:n2")).toMatchObject({ amount_minor: -5000, anomaly: "no_charge" });
      expect(await revenue(site)).toBe(0);
    });

    const subRow = (id: string) => row<{ status: string; unconfirmed_end: string | null; canceled_at: number | null; last_event_at: number | null }>("SELECT status, unconfirmed_end, canceled_at, last_event_at FROM subscriptions WHERE id = ?1", `gumroad:${id}`);

    it("leaves an active subscription alone when a cancellation has no sale to check", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      const before = now() - 100;
      await storeSubscription(env.DB, site, "gumroad", { providerId: "sub-a", status: "active", eventAt: before });
      const res = await ping(conn, { resource_name: "cancellation", subscription_id: "sub-a", cancelled_at: new Date().toISOString() });
      expect(res.status).toBe(200);
      expect(gumroadCalls).toEqual([]);
      expect(await subRow("sub-a")).toMatchObject({ status: "active", unconfirmed_end: "canceled", canceled_at: null, last_event_at: before });
      expect(await lastError(conn)).toContain("sub-a");
      expect((await health()).checks.find((c) => c.id === "payments")?.detail).toContain("couldn't be confirmed");

      // The provider's confirmed word settles it, either way.
      await storeSubscription(env.DB, site, "gumroad", { providerId: "sub-a", status: "active", eventAt: now() });
      expect(await subRow("sub-a")).toMatchObject({ status: "active", unconfirmed_end: null });
    });

    it("doesn't let a forged cancellation shut out the real one", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await storeSubscription(env.DB, site, "gumroad", { providerId: "sub-r", status: "active" });
      expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-r" })).status).toBe(200);
      expect(await subRow("sub-r")).toMatchObject({ status: "active", unconfirmed_end: "canceled" });

      // Gumroad's own ping for the same subscription has the same event id, and names a sale.
      await sale(conn, "real-sale", { subscription_id: "sub-r", cancelled: true });
      await ageEvents();
      const real = await ping(conn, { resource_name: "cancellation", subscription_id: "sub-r", "purchase_ids[]": "real-sale" });
      expect(await real.json()).toEqual({ ok: true });
      expect(await subRow("sub-r")).toMatchObject({ status: "canceled", unconfirmed_end: null });
    });

    it("records a cancellation of an unknown subscription without counting it", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-new" })).status).toBe(200);
      expect(await subRow("sub-new")).toMatchObject({ status: "unconfirmed", unconfirmed_end: "canceled" });
      const stats = await (await call(`${API}/sites/${site.id}/subscriptions?range=7d`, { headers })).json<{ active: number; started: number; canceled: number }>();
      expect(stats).toMatchObject({ active: 0, started: 0, canceled: 0 });
    });

    it("waits for Gumroad when it can't be asked, and a sale of another subscription proves nothing", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
      await storeSubscription(env.DB, site, "gumroad", { providerId: "sub-b", status: "active" });
      await sale(conn, "of-other", { subscription_id: "sub-other", cancelled: true });
      await sale(conn, "of-nobody", { cancelled: true });
      expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-b", "purchase_ids[]": "of-other" })).status).toBe(200);
      expect((await ping(conn, { resource_name: "subscription_ended", subscription_id: "sub-b", "purchase_ids[]": "of-nobody" })).status).toBe(200);
      expect(await subRow("sub-b")).toMatchObject({ status: "active" });

      await sale(conn, "of-b", { subscription_id: "sub-b" });
      gumroadOutage = () => new Response("down", { status: 503 });
      await env.DB.exec("DELETE FROM payment_events");
      expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-b", "purchase_ids[]": "of-b" })).status).toBe(503);
      expect(await subRow("sub-b")).toMatchObject({ status: "active", unconfirmed_end: "canceled" });

      gumroadOutage = null;
      gumroadSales["of-b"]!.cancelled = true;
      await ageEvents();
      expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-b", "purchase_ids[]": "of-b" })).status).toBe(200);
      expect(await subRow("sub-b")).toMatchObject({ status: "canceled", unconfirmed_end: null });
    });

    it("without a token a cancellation still applies, on a connection labelled unverified", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "gumroad" });
      expect((await ping(conn, { resource_name: "cancellation", subscription_id: "sub-t" })).status).toBe(200);
      expect(await subRow("sub-t")).toMatchObject({ status: "canceled", unconfirmed_end: null });
    });
  });

  it("labels what arrives without an access token, and says so", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad" });
    expect(conn.unverified).toBe(true);
    expect((await ping(conn, { sale_id: "s4", price: "700", sale_timestamp: new Date().toISOString() })).status).toBe(200);
    expect(gumroadCalls).toEqual([]);
    expect((await paymentRow("gumroad:charge:s4"))!.unverified).toBe(1);
    expect((await list(site))[0]).toMatchObject({ unverified: true });
    const overview = await (await call(`${API}/sites/${site.id}/overview?range=7d`, { headers })).json<SiteOverviewDTO>();
    expect(overview.unverified).toBe(1);
    expect((await health()).checks.find((c) => c.id === "gumroad")).toMatchObject({ status: "warn", advisory: true });
    const file = await (await call(`${API}/sites/${site.id}/payments.csv?range=7d`, { headers })).text();
    expect(file.split("\r\n")[0]).toContain(",flag,unverified");
    expect(file.split("\r\n")[1]).toMatch(/,yes$/);
  });

  it("refuses a short pasted token, and can make a new one", async () => {
    const site = await createSite();
    expect((await call(`${API}/sites/${site.id}/connections`, json({ provider: "gumroad", webhookSecret: "short" }))).status).toBe(400);
    const conn = await connect(site, { provider: "gumroad" });
    const res = await call(`${API}/sites/${site.id}/connections/${conn.id}`, { ...json({ rotateWebhookToken: true }), method: "PATCH" });
    expect(res.status).toBe(200);
    const next = await res.json<ConnectionDTO>();
    expect(next.webhookUrl).not.toBe(conn.webhookUrl);
    expect((await ping(conn, { sale_id: "s5", price: "1" })).status).toBe(401);
    expect((await ping(next, { sale_id: "s5", price: "1" })).status).toBe(200);
  });
});

describe("the same payment id on two sites", () => {
  it("refuses the second site's write and leaves the first site's row alone", async () => {
    const a = await createSite();
    const b = await createSite("other.example.com");
    expect((await pay(a, { id: "dup", email: "a@example.com", amount: 10 })).status).toBe(201);
    const res = await pay(b, { id: "dup", email: "b@example.com", amount: 99 });
    expect(res.status).toBe(409);
    expect(await paymentRow("api:charge:dup")).toMatchObject({ site_id: a.id, email: "a@example.com", amount_minor: 1000 });
    expect(await list(b)).toEqual([]);
    expect(await row("SELECT count, detail FROM payment_anomalies WHERE site_id = ?1 AND kind = 'id_conflict'", b.id)).toEqual({ count: 1, detail: "api:charge:dup" });
    expect((await health()).checks.find((c) => c.id === "payments")).toMatchObject({ status: "warn", detail: expect.stringContaining("another site") });
  });

  it("only announces a site's own payments", async () => {
    const a = await createSite();
    const b = await createSite("other.example.com");
    expect((await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/x", events: ["site.payment"] }))).status).toBe(201);
    await pay(a, { id: "own", email: "a@example.com" });
    await env.DB.exec("DELETE FROM webhook_deliveries");
    await announcePayments(env, b, ["api:charge:own"]);
    expect(await row("SELECT COUNT(*) AS n FROM webhook_deliveries")).toEqual({ n: 0 });
    await announcePayments(env, a, ["api:charge:own"]);
    expect(await row("SELECT COUNT(*) AS n FROM webhook_deliveries")).toEqual({ n: 1 });
  });

  it("keeps subscriptions apart too", async () => {
    const a = await createSite();
    const b = await createSite("other.example.com");
    await storeSubscription(env.DB, a, "stripe", { providerId: "sub_x", status: "active", eventAt: now() - 100 });
    await storeSubscription(env.DB, b, "stripe", { providerId: "sub_x", status: "canceled", eventAt: now() });
    expect(await row("SELECT site_id, status FROM subscriptions WHERE id = 'stripe:sub_x'")).toEqual({ site_id: a.id, status: "active" });
    expect(await row("SELECT count FROM payment_anomalies WHERE site_id = ?1 AND kind = 'id_conflict'", b.id)).toEqual({ count: 1 });
  });
});

describe("sites sharing one provider account", () => {
  const checkout = (id: string, extra: Record<string, unknown> = {}) => stripeBody(`evt_${id}`, "checkout.session.completed", { id: `cs_${id}`, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 5000, currency: "usd", ...extra });
  const refund = (id: string) => stripeBody(`evt_r_${id}`, "charge.refunded", { id: `ch_${id}`, payment_intent: `pi_${id}`, amount: 5000, amount_refunded: 5000, currency: "usd" });
  const setup = async (filterA: string[] = [], filterB: string[] = []) => {
    const a = await createSite();
    const b = await createSite("other.example.com");
    const connA = await connect(a, { provider: "stripe", webhookSecret: "whsec_test", productFilter: filterA });
    const connB = await connect(b, { provider: "stripe", webhookSecret: "whsec_test", productFilter: filterB });
    return { a, b, connA, connB };
  };
  const conflicts = async () => (await row<{ n: number }>("SELECT COALESCE(SUM(count), 0) AS n FROM payment_anomalies WHERE kind = 'id_conflict'"))!.n;

  it("gives a charge to the site its visit belongs to, when the other site's webhook comes first", async () => {
    const { a, b, connA, connB } = await setup();
    const visitOnB = await visit(b, {}, "198.51.100.60", "https://other.example.com");
    const body = checkout("one", { client_reference_id: `sh_${visitOnB}` });
    expect((await sendStripe(connA, body)).status).toBe(200);
    expect(await paymentRow("stripe:charge:pi_one")).toMatchObject({ site_id: a.id, session_id: null });
    expect((await sendStripe(connB, body)).status).toBe(200);
    expect(await paymentRow("stripe:charge:pi_one")).toMatchObject({ site_id: b.id, session_id: visitOnB, matched_by: "ref" });
    expect(await list(a)).toEqual([]);
    expect(await conflicts()).toBe(0);
  });

  it("leaves it there when that site's webhook comes first", async () => {
    const { b, connA, connB } = await setup();
    const visitOnB = await visit(b, {}, "198.51.100.61", "https://other.example.com");
    const body = checkout("two", { client_reference_id: `sh_${visitOnB}` });
    await sendStripe(connB, body);
    expect((await sendStripe(connA, body)).status).toBe(200);
    expect(await paymentRow("stripe:charge:pi_two")).toMatchObject({ site_id: b.id, session_id: visitOnB });
    expect(await conflicts()).toBe(0);
  });

  it("brings a charge's refund along when the charge moves", async () => {
    const { a, b, connA, connB } = await setup();
    const visitOnB = await visit(b, {}, "198.51.100.62", "https://other.example.com");
    const body = checkout("three", { client_reference_id: `sh_${visitOnB}` });
    await sendStripe(connA, body);
    await sendStripe(connA, refund("three"));
    expect(await paymentRow("stripe:refund:ch_three")).toMatchObject({ site_id: a.id });
    await sendStripe(connB, body);
    expect(await paymentRow("stripe:refund:ch_three")).toMatchObject({ site_id: b.id, session_id: visitOnB });
  });

  it("gives a refund to the site that has the charge, in either order", async () => {
    const { a, b, connA, connB } = await setup();
    await sendStripe(connA, checkout("four"));
    await sendStripe(connB, checkout("four")); // Can't tell: the first keeps it, and this one counts.
    expect(await conflicts()).toBe(1);

    // The other site's webhook is first, and it has no charge.
    await sendStripe(connB, refund("four"));
    expect(await paymentRow("stripe:refund:ch_four")).toMatchObject({ site_id: b.id, anomaly: "no_charge" });
    await sendStripe(connA, refund("four"));
    expect(await paymentRow("stripe:refund:ch_four")).toMatchObject({ site_id: a.id, amount_minor: -5000, anomaly: null });
    expect(await list(b)).toEqual([]);

    // And the charge's own site first: the other has nothing to add, and nothing to report.
    await sendStripe(connA, checkout("five"));
    await sendStripe(connA, refund("five"));
    await sendStripe(connB, refund("five"));
    expect(await paymentRow("stripe:refund:ch_five")).toMatchObject({ site_id: a.id });
    expect(await conflicts()).toBe(1);
  });

  it("refuses and counts when the event can't tell", async () => {
    const { a, connA, connB } = await setup();
    await sendStripe(connA, checkout("six"));
    await sendStripe(connB, checkout("six"));
    expect(await paymentRow("stripe:charge:pi_six")).toMatchObject({ site_id: a.id });
    expect(await conflicts()).toBe(1);
  });

  it("never moves a charge already matched to a visit", async () => {
    const { a, b, connA, connB } = await setup();
    const onA = await visit(a, {}, "198.51.100.63");
    const onB = await visit(b, {}, "198.51.100.64", "https://other.example.com");
    await sendStripe(connA, checkout("seven", { client_reference_id: `sh_${onA}` }));
    await sendStripe(connB, checkout("seven", { client_reference_id: `sh_${onB}` }));
    expect(await paymentRow("stripe:charge:pi_seven")).toMatchObject({ site_id: a.id, session_id: onA });
    expect(await conflicts()).toBe(1);
  });

  describe("one site's signed event against another site's row", () => {
    const withEmail = { customer_details: { email: "buyer@example.com" } };

    it("can't take an unmatched row by naming one of its own visits", async () => {
      const { a, b, connA, connB } = await setup();
      const onB = await visit(b, {}, "198.51.100.70", "https://other.example.com");
      await sendStripe(connA, checkout("t1", withEmail));
      expect((await sendStripe(connB, checkout("t1", { client_reference_id: `sh_${onB}`, amount_total: 1 }))).status).toBe(200);
      expect(await paymentRow("stripe:charge:pi_t1")).toMatchObject({ site_id: a.id, email: "buyer@example.com", amount_minor: 5000, session_id: null });
      expect(await list(b)).toEqual([]);
      expect(await conflicts()).toBe(1);
    });

    it("can't take it with the same amount either, when the row doesn't name that visit", async () => {
      const { a, b, connA, connB } = await setup();
      const onB = await visit(b, {}, "198.51.100.71", "https://other.example.com");
      await sendStripe(connA, checkout("t2", withEmail));
      await sendStripe(connB, checkout("t2", { client_reference_id: `sh_${onB}` }));
      expect(await paymentRow("stripe:charge:pi_t2")).toMatchObject({ site_id: a.id, email: "buyer@example.com" });
    });

    it("can't take a row that names its visit for another amount", async () => {
      const { a, b, connA, connB } = await setup();
      const onB = await visit(b, {}, "198.51.100.72", "https://other.example.com");
      await sendStripe(connA, checkout("t3", { client_reference_id: `sh_${onB}` }));
      await sendStripe(connB, checkout("t3", { client_reference_id: `sh_${onB}`, amount_total: 9 }));
      expect(await paymentRow("stripe:charge:pi_t3")).toMatchObject({ site_id: a.id, amount_minor: 5000 });
    });

    it("moves a shared account's charge without the email stored with it", async () => {
      const { a, b, connA, connB } = await setup();
      const onB = await visit(b, {}, "198.51.100.73", "https://other.example.com");
      await sendStripe(connA, checkout("t4", { client_reference_id: `sh_${onB}`, ...withEmail }));
      await env.DB.prepare("UPDATE payments SET customer_id = 'cus_a' WHERE id = 'stripe:charge:pi_t4'").run();
      await sendStripe(connB, checkout("t4", { client_reference_id: `sh_${onB}` }));
      expect(await paymentRow("stripe:charge:pi_t4")).toMatchObject({ site_id: b.id, session_id: onB, email: null });
      expect(await row("SELECT customer_id FROM payments WHERE id = 'stripe:charge:pi_t4'")).toEqual({ customer_id: null });
      expect(await list(a)).toEqual([]);
    });

    it("can't take a waiting refund it doesn't match", async () => {
      const { a, connA, connB } = await setup();
      await sendStripe(connB, checkout("t5"));
      await sendStripe(connA, refund("t5"));
      expect(await paymentRow("stripe:refund:ch_t5")).toMatchObject({ site_id: a.id, anomaly: "no_charge" });
      const other = stripeBody("evt_r_t5b", "charge.refunded", { id: "ch_t5", payment_intent: "pi_t5", amount: 5000, amount_refunded: 100, currency: "usd" });
      await sendStripe(connB, other);
      expect(await paymentRow("stripe:refund:ch_t5")).toMatchObject({ site_id: a.id, amount_minor: -5000 });
    });

    it("can't take a waiting refund that doesn't name its charge", async () => {
      const { a, connA, connB } = await setup();
      await sendStripe(connB, checkout("t6"));
      await sendStripe(connA, refund("t6"));
      await env.DB.exec("UPDATE payments SET order_ref = 'ch_t6' WHERE id = 'stripe:refund:ch_t6'");
      await sendStripe(connB, stripeBody("evt_r_t6b", "charge.refunded", { id: "ch_t6", payment_intent: "pi_t6", amount: 5000, amount_refunded: 5000, currency: "usd" }));
      expect(await paymentRow("stripe:refund:ch_t6")).toMatchObject({ site_id: a.id });
      expect(await conflicts()).toBe(1);
    });
  });

  it("doesn't let the API take a row from another site by naming its own visit", async () => {
    const a = await createSite();
    const b = await createSite("other.example.com");
    await pay(a, { id: "held" });
    const onB = await visit(b, {}, "198.51.100.65", "https://other.example.com");
    expect((await pay(b, { id: "held", ref: onB })).status).toBe(409);
    expect(await paymentRow("api:charge:held")).toMatchObject({ site_id: a.id });
  });

  it("a filtered connection leaves a payment with no product to the site that takes everything", async () => {
    const { a, b, connA, connB } = await setup(["prod_a"]);
    await sendStripe(connA, checkout("eight"));
    expect(await paymentRow("stripe:charge:pi_eight")).toBeNull();
    await sendStripe(connB, checkout("eight"));
    expect(await paymentRow("stripe:charge:pi_eight")).toMatchObject({ site_id: b.id });
    expect(await conflicts()).toBe(0);

    // Its own visit says it is this site's, filter or not.
    const onA = await visit(a, {}, "198.51.100.66");
    await sendStripe(connA, checkout("nine", { client_reference_id: `sh_${onA}` }));
    expect(await paymentRow("stripe:charge:pi_nine")).toMatchObject({ site_id: a.id, session_id: onA });
  });

  it("a filter alone on the account changes nothing for payments with no product", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test", productFilter: ["prod_a"] });
    await sendStripe(conn, checkout("ten"));
    expect(await paymentRow("stripe:charge:pi_ten")).toMatchObject({ site_id: site.id });
  });
});

describe("a webhook carrying many payments on Workers Free", () => {
  const order = (n: number) => ({ id: `ev${n}`, type: "order.completed", live: true, created: Date.now(), data: { id: `ord${n}`, currency: "USD", total: 10, items: [{ product: "pro" }] } });

  /** Counts D1 calls the way the platform does: each statement run and each batch is one subrequest. */
  function counted(): { db: D1Database; calls: () => number; reset: () => void } {
    let n = 0;
    const raw = new WeakMap<object, D1PreparedStatement>();
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
      const proxy = new Proxy(stmt, {
        get(t, k) {
          const v = Reflect.get(t, k) as (...a: unknown[]) => unknown;
          if (typeof v !== "function") return v;
          if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
          return (...a: unknown[]) => (n++, v.apply(t, a));
        },
      });
      raw.set(proxy, stmt);
      return proxy;
    };
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
        if (k === "batch") return (stmts: D1PreparedStatement[]) => (n++, t.batch(stmts.map((s) => raw.get(s) ?? s)));
        const v = Reflect.get(t, k) as (...a: unknown[]) => unknown;
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { db, calls: () => n, reset: () => void (n = 0) };
  }

  it("stays under 50 D1 calls per delivery, and finishes over the retries", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "fastspring", webhookSecret: "fs-secret" });
    const body = JSON.stringify({ events: Array.from({ length: 8 }, (_, i) => order(i)) });
    const signature = bytesToBase64(await sign("fs-secret", body));
    const counter = counted();
    const send = () => call(`${ORIGIN}/_pay/fastspring/${conn.id}`, { method: "POST", headers: { "X-FS-Signature": signature }, body }, { WORKERS_PLAN: "free", DB: counter.db });
    const stored = async () => (await row<{ n: number }>("SELECT COUNT(*) AS n FROM payments"))!.n;

    const seen: number[] = [];
    let res = await send();
    expect(res.status).toBe(503);
    for (let i = 0; i < 8 && res.status === 503; i++) {
      expect(counter.calls()).toBeLessThanOrEqual(50);
      seen.push(await stored());
      expect((await row<{ last_error: string }>("SELECT last_error FROM payment_connections WHERE id = ?1", conn.id))!.last_error).toContain("wait for");
      counter.reset();
      await ageEvents();
      res = await send();
    }
    expect(res.status).toBe(200);
    expect(counter.calls()).toBeLessThanOrEqual(50);
    expect(await stored()).toBe(8);
    // Every delivery got further than the one before.
    expect(new Set(seen).size).toBe(seen.length);
    expect((await row<{ last_error: string | null }>("SELECT last_error FROM payment_connections WHERE id = ?1", conn.id))!.last_error).toBeNull();
    // Nothing is left behind, and a repeat is a duplicate.
    expect(await row("SELECT COUNT(*) AS n FROM payment_events WHERE connection_id = ?1", conn.id)).toEqual({ n: 1 });
    expect(await (await send()).json()).toMatchObject({ duplicate: true });
  });

  it("handles a small batch in one go", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "fastspring", webhookSecret: "fs-secret" });
    const body = JSON.stringify({ events: [order(1), order(2)] });
    const res = await call(`${ORIGIN}/_pay/fastspring/${conn.id}`, { method: "POST", headers: { "X-FS-Signature": bytesToBase64(await sign("fs-secret", body)) }, body }, { WORKERS_PLAN: "free" });
    expect(res.status).toBe(200);
    expect(await row("SELECT COUNT(*) AS n FROM payments")).toEqual({ n: 2 });
  });
});

describe("refunds of a proven match", () => {
  it("say the same as their charge, whichever came first", async () => {
    const site = await createSite();
    const session = await visit(site);
    await call(`${API}/sites/${site.id}/identify`, json({ ref: session, email: "known@example.com" }));
    await pay(site, { id: "c-proven", email: "known@example.com", occurredAt: now() });
    expect(await row("SELECT matched_by, proves_identity FROM payments WHERE id = 'api:charge:c-proven'")).toEqual({ matched_by: "email", proves_identity: 1 });
    await pay(site, { id: "r-proven", kind: "refund", parentId: "c-proven", amount: 1 });
    expect(await row("SELECT matched_by, proves_identity FROM payments WHERE id = 'api:refund:r-proven'")).toEqual({ matched_by: "email", proves_identity: 1 });
  });
});

describe("PayPal subscription dates", () => {
  const event = (resource: Record<string, unknown>, create_time = "2026-11-10T00:00:00Z") =>
    ADAPTERS.paypal.parse(JSON.stringify({ id: "WH-1", event_type: "BILLING.SUBSCRIPTION.CANCELLED", create_time, resource: { id: "I-1", status: "CANCELLED", create_time: "2024-01-01T00:00:00Z", start_time: "2024-01-01T00:00:00Z", ...resource } }), new Headers(), { apiKey: null, settings: {} });
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  it("dates a cancellation when it happened, not when the subscription began", async () => {
    expect((await event({})).subscriptions[0]).toMatchObject({ canceledAt: at("2026-11-10T00:00:00Z"), eventAt: at("2026-11-10T00:00:00Z"), startedAt: at("2024-01-01T00:00:00Z") });
    expect((await event({ status_update_time: "2026-11-09T12:00:00Z" })).subscriptions[0]).toMatchObject({ canceledAt: at("2026-11-09T12:00:00Z") });
    expect((await event({ status: "EXPIRED" })).subscriptions[0]).toMatchObject({ canceledAt: null, endedAt: at("2026-11-10T00:00:00Z") });
  });
});

describe("the order of subscription events", () => {
  const send = async (conn: ConnectionDTO, id: string, type: string, status: string, created: number) => {
    const body = JSON.stringify({ id, type, livemode: true, created, data: { object: { id: "sub_o", status, customer: "cus_o", items: { data: [{ quantity: 1, price: { unit_amount: 1000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } } } });
    const t = now();
    const res = await call(`${ORIGIN}/_pay/stripe/${conn.id}`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${bytesToHex(await sign("whsec_test", `${t}.${body}`))}` }, body });
    expect(res.status).toBe(200);
  };
  const status = async () => (await row<{ status: string }>("SELECT status FROM subscriptions WHERE id = 'stripe:sub_o'"))!.status;

  it("ignores an older event under a new id, and follows a newer one", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const t = now() - 1000;
    await send(conn, "evt_1", "customer.subscription.created", "active", t);
    await send(conn, "evt_2", "customer.subscription.deleted", "canceled", t + 100);
    // Delivered late, about an earlier moment.
    await send(conn, "evt_3", "customer.subscription.updated", "active", t + 50);
    expect(await status()).toBe("canceled");
    // The same second as the cancellation doesn't bring it back either.
    await send(conn, "evt_4", "customer.subscription.updated", "active", t + 100);
    expect(await status()).toBe("canceled");
    // Really later: reactivated.
    await send(conn, "evt_5", "customer.subscription.updated", "active", t + 200);
    expect(await status()).toBe("active");
  });

  it("keeps an old event out even after its id was pruned", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const t = now() - 1000;
    await send(conn, "evt_a", "customer.subscription.updated", "active", t);
    await send(conn, "evt_b", "customer.subscription.deleted", "canceled", t + 10);
    await env.DB.exec("DELETE FROM payment_events");
    await send(conn, "evt_a", "customer.subscription.updated", "active", t);
    expect(await status()).toBe("canceled");
  });

  it("doesn't let an event without a time bring back a canceled subscription", async () => {
    const site = await createSite();
    await storeSubscription(env.DB, site, "gumroad", { providerId: "sub_n", status: "canceled", eventAt: now() });
    await storeSubscription(env.DB, site, "gumroad", { providerId: "sub_n", status: "active" });
    expect(await row("SELECT status FROM subscriptions WHERE id = 'gumroad:sub_n'")).toEqual({ status: "canceled" });
  });
});

describe("refunds against their charge", () => {
  const charge = (site: SiteDTO, id: string, amountMinor: number, currency = "USD") =>
    storePayment(env.DB, site, "gumroad", null, { kind: "charge", providerId: id, occurredAt: now() - 100, amountMinor, currency, billing: "one_time", refs: [], productIds: [], testMode: false });
  const refund = (site: SiteDTO, id: string, parentRef: string, amountMinor: number, extra: Partial<NormalizedPayment> = {}) =>
    storePayment(env.DB, site, "gumroad", null, { kind: "refund", providerId: id, occurredAt: now(), amountMinor, currency: "USD", billing: null, refs: [], parentRef, productIds: [], testMode: false, ...extra });

  it("caps refunds at the charge, together, and says so", async () => {
    const site = await createSite();
    await charge(site, "c1", 1000);
    await refund(site, "r1", "c1", 400);
    expect(await paymentRow("gumroad:refund:r1")).toMatchObject({ amount_minor: -400, anomaly: null });
    await refund(site, "r2", "c1", 900);
    expect(await paymentRow("gumroad:refund:r2")).toMatchObject({ amount_minor: -600, anomaly: "refund_capped" });
    expect(await row("SELECT count FROM payment_anomalies WHERE site_id = ?1 AND kind = 'refund_capped'", site.id)).toEqual({ count: 1 });
    expect((await health()).checks.find((c) => c.id === "payments")?.detail).toContain("capped");
    expect((await list(site)).find((p) => p.id === "gumroad:refund:r2")).toMatchObject({ anomaly: "refund_capped" });
  });

  it("caps a running total at the charge, and a later smaller one changes nothing", async () => {
    const site = await createSite();
    await charge(site, "c2", 500);
    await refund(site, "c2", "c2", 800, { cumulative: true });
    expect(await paymentRow("gumroad:refund:c2")).toMatchObject({ amount_minor: -500, anomaly: "refund_capped" });
    await refund(site, "c2", "c2", 100, { cumulative: true });
    expect(await paymentRow("gumroad:refund:c2")).toMatchObject({ amount_minor: -500, anomaly: "refund_capped" });
  });

  it("leaves ordinary refunds alone", async () => {
    const site = await createSite();
    await charge(site, "c3", 1000);
    await refund(site, "c3", "c3", 300, { cumulative: true });
    await refund(site, "c3", "c3", 1000, { cumulative: true });
    expect(await paymentRow("gumroad:refund:c3")).toMatchObject({ amount_minor: -1000, anomaly: null });
    expect(await row("SELECT COUNT(*) AS n FROM payment_anomalies")).toEqual({ n: 0 });
  });

  it("flags a refund in another currency, or with no charge, and keeps it", async () => {
    const site = await createSite();
    await charge(site, "c4", 1000, "EUR");
    await refund(site, "r4", "c4", 5000);
    expect(await paymentRow("gumroad:refund:r4")).toMatchObject({ amount_minor: -5000, anomaly: "refund_currency" });
    await refund(site, "r5", "nothing", 700);
    expect(await paymentRow("gumroad:refund:r5")).toMatchObject({ amount_minor: -700, anomaly: "no_charge" });
    // Its charge turns up and the event is sent again: no longer flagged.
    await charge(site, "nothing", 1000);
    await refund(site, "r5", "nothing", 700);
    expect(await paymentRow("gumroad:refund:r5")).toMatchObject({ amount_minor: -700, anomaly: null });
    // A missing charge alone is common and doesn't raise a warning.
    await env.DB.exec("DELETE FROM payment_anomalies WHERE kind != 'no_charge'");
    expect((await health()).checks.find((c) => c.id === "payments")).toBeUndefined();
  });

  describe("that arrive before it", () => {
    const net = async (site: SiteDTO) => (await (await call(`${API}/sites/${site.id}/overview?range=7d`, { headers })).json<SiteOverviewDTO>()).totals.revenue;
    const capped = async () => (await row<{ n: number }>("SELECT COALESCE(SUM(count), 0) AS n FROM payment_anomalies WHERE kind = 'refund_capped'"))!.n;

    it("are capped when the charge comes, and a repeat changes nothing", async () => {
      const site = await createSite();
      await refund(site, "e1", "late", 90000);
      expect(await paymentRow("gumroad:refund:e1")).toMatchObject({ amount_minor: -90000, anomaly: "no_charge" });
      await charge(site, "late", 500);
      expect(await row("SELECT amount_minor, amount_site_minor, parent_id, anomaly FROM payments WHERE id = 'gumroad:refund:e1'")).toEqual({ amount_minor: -500, amount_site_minor: -500, parent_id: "gumroad:charge:late", anomaly: "refund_capped" });
      expect(await net(site)).toBe(0);
      expect(await capped()).toBe(1);

      await charge(site, "late", 500);
      await refund(site, "e1", "late", 90000);
      expect(await paymentRow("gumroad:refund:e1")).toMatchObject({ amount_minor: -500, anomaly: "refund_capped" });
      expect(await net(site)).toBe(0);
    });

    it("are capped together, oldest first, without counting anything twice", async () => {
      const site = await createSite();
      await refund(site, "t1", "tog", 700, { occurredAt: now() - 30 });
      await refund(site, "t2", "tog", 700, { occurredAt: now() - 20 });
      await refund(site, "t3", "tog", 700, { occurredAt: now() - 10 });
      await charge(site, "tog", 1000);
      expect(await paymentRow("gumroad:refund:t1")).toMatchObject({ amount_minor: -700, anomaly: null });
      expect(await paymentRow("gumroad:refund:t2")).toMatchObject({ amount_minor: -300, anomaly: "refund_capped" });
      expect(await paymentRow("gumroad:refund:t3")).toMatchObject({ amount_minor: 0, anomaly: "refund_capped" });
      expect(await net(site)).toBe(0);
      for (const id of ["t1", "t2", "t3"]) await refund(site, id, "tog", 700);
      expect(await row("SELECT SUM(amount_minor) AS n FROM payments WHERE kind = 'refund'")).toEqual({ n: -1000 });
    });

    it("catches up with one stored before these checks when it is sent again", async () => {
      const site = await createSite();
      await refund(site, "o1", "gone", 90000);
      await env.DB.exec("UPDATE payments SET order_ref = 'o1' WHERE id = 'gumroad:refund:o1'");
      await charge(site, "gone", 500);
      expect(await paymentRow("gumroad:refund:o1")).toMatchObject({ amount_minor: -90000, anomaly: "no_charge" });
      await refund(site, "o1", "gone", 90000);
      expect(await row("SELECT amount_minor, amount_site_minor, parent_id, anomaly FROM payments WHERE id = 'gumroad:refund:o1'")).toEqual({ amount_minor: -500, amount_site_minor: -500, parent_id: "gumroad:charge:gone", anomaly: "refund_capped" });
      expect(await net(site)).toBe(0);
    });

    it("leave what fits alone", async () => {
      const site = await createSite();
      await refund(site, "f1", "fits", 300);
      await charge(site, "fits", 1000);
      expect(await paymentRow("gumroad:refund:f1")).toMatchObject({ amount_minor: -300, anomaly: null });
      expect(await net(site)).toBe(700);
    });

    it("lets a running total stand in for the single refunds it covers", async () => {
      const site = await createSite();
      const at = now() - 100;
      await refund(site, "p1", "tc", 400, { partOfTotal: true, occurredAt: at });
      await refund(site, "tc", "tc", 900, { cumulative: true, ofParent: true, occurredAt: at + 10, totalAt: at + 10 });
      await charge(site, "tc", 600);
      expect(await paymentRow("gumroad:refund:p1")).toBeNull();
      expect(await paymentRow("gumroad:refund:tc")).toMatchObject({ amount_minor: -600, anomaly: "refund_capped" });
      expect(await net(site)).toBe(0);
    });

    it("holds a dispute to the charge, and flags another currency", async () => {
      const site = await createSite();
      await storePayment(env.DB, site, "gumroad", null, { kind: "dispute", providerId: "dp", occurredAt: now(), amountMinor: 5000, currency: "USD", billing: null, refs: [], parentRef: "dc", productIds: [], testMode: false });
      await refund(site, "fx", "dc", 5000, { currency: "EUR" });
      await charge(site, "dc", 800);
      expect(await paymentRow("gumroad:dispute:dp")).toMatchObject({ amount_minor: -800, anomaly: "refund_capped" });
      expect(await paymentRow("gumroad:refund:fx")).toMatchObject({ amount_minor: -5000, anomaly: "refund_currency" });
    });

    it("finds a charge that learns the id later", async () => {
      const site = await createSite();
      const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
      const t = now();
      await sendStripe(conn, stripeBody("evt_rf", "charge.refunded", { id: "ch_l", payment_intent: "pi_l", amount: 500, amount_refunded: 90000, currency: "usd" }, t));
      expect(await paymentRow("stripe:refund:ch_l")).toMatchObject({ amount_minor: -90000, anomaly: "no_charge" });
      await sendStripe(conn, stripeBody("evt_inv", "invoice.paid", { id: "in_l", amount_paid: 500, currency: "usd", customer: "cus_l" }, t));
      await sendStripe(conn, stripeBody("evt_ip", "invoice_payment.paid", { invoice: "in_l", status: "paid", payment: { payment_intent: "pi_l" } }, t));
      expect(await paymentRow("stripe:refund:ch_l")).toMatchObject({ amount_minor: -500, anomaly: "refund_capped" });
      expect(await net(site)).toBe(0);
    });

    it("stay out of another site's charge", async () => {
      const a = await createSite();
      const b = await createSite("other.example.com");
      await refund(a, "x1", "shared-ref", 900);
      await charge(b, "shared-ref", 100);
      expect(await paymentRow("gumroad:refund:x1")).toMatchObject({ site_id: a.id, amount_minor: -900, anomaly: "no_charge" });
    });
  });
});

describe("exchange rates", () => {
  const stored = (currency: string, date: string) => row<{ rate: number }>("SELECT rate FROM fx_rates WHERE currency = ?1 AND date = ?2", currency, date);

  it("stores a rate far from the last one, and reports it", async () => {
    await env.DB.prepare("INSERT INTO fx_rates (date, currency, rate) VALUES ('2026-11-02', 'USD', 1.1), ('2026-11-02', 'JPY', 160)").run();
    fxResponses["2026-11-03"] = { USD: 11, JPY: 161 };
    expect(await fetchRates(env.DB, "2026-11-03")).toBe("2026-11-03");
    expect(await stored("USD", "2026-11-03")).toEqual({ rate: 11 });
    expect(await row("SELECT count, detail FROM payment_anomalies WHERE site_id = '' AND kind = 'fx_rate'")).toEqual({ count: 1, detail: "2026-11-03: USD" });
  });

  it("doesn't store what can't be a rate, and accepts a very weak currency", async () => {
    fxResponses["2026-11-04"] = { IDR: 17_000, BAD: 1e12, TOO: 1e-9 };
    await fetchRates(env.DB, "2026-11-04");
    expect(await stored("IDR", "2026-11-04")).toEqual({ rate: 17_000 });
    expect(await stored("BAD", "2026-11-04")).toBeNull();
    expect(await stored("TOO", "2026-11-04")).toBeNull();
    expect((await row<{ detail: string }>("SELECT detail FROM payment_anomalies WHERE kind = 'fx_rate'"))!.detail).toContain("BAD, TOO");
  });
});

describe("click tokens", () => {
  const SECRET = "test-session-secret";
  const asLink = (session: string) => row<{ channel: string; link_slug: string }>("SELECT channel, link_slug FROM web_sessions WHERE id = ?1", session);
  const withSecret = { SESSION_SECRET: SECRET } as Partial<Env>;
  const visitWith = async (site: SiteDTO, token: string, ip: string, origin = SITE_ORIGIN) => {
    const res = await collect(site, { c: token }, ip, origin, withSecret);
    expect(res.status).toBe(200);
    return asLink((await res.json<{ s: string }>()).s);
  };

  it("counts only on the site it was made for", async () => {
    const a = await createSite();
    const b = await createSite("other.example.com");
    const token = await signClickToken(SECRET, { domain: "sh.example", slug: "promo", source: "li", at: now(), site: a.id });
    expect(await visitWith(b, token, "198.51.100.20", "https://other.example.com")).toMatchObject({ link_slug: "" });
    expect(await visitWith(a, token, "198.51.100.21")).toMatchObject({ channel: "Short link", link_slug: "promo" });
  });

  it("names the closest tracked site when one lives under another's domain", async () => {
    const parent = await createSite("example.com");
    const blog = await createSite("blog.example.com");
    await putLink("post", { u: "https://blog.example.com/hello" });
    resetSiteCaches();
    const res = await call(`${ORIGIN}/post`, { headers: { "User-Agent": UA }, redirect: "manual" }, withSecret);
    const token = new URL(res.headers.get("Location")!).searchParams.get("sh_c")!;
    expect(await visitWith(blog, token, "198.51.100.25", "https://blog.example.com")).toMatchObject({ link_slug: "post" });
    expect(await visitWith(parent, token, "198.51.100.26", "https://example.com")).toMatchObject({ link_slug: "" });
  });

  it("still accepts a token from before this version on any site", async () => {
    const site = await createSite();
    const token = await signClickToken(SECRET, { domain: "sh.example", slug: "older", source: "", at: now() });
    expect(await visitWith(site, token, "198.51.100.22")).toMatchObject({ link_slug: "older" });
  });

  it("credits only a few visitors per token", async () => {
    const site = await createSite();
    const token = await signClickToken(SECRET, { domain: "sh.example", slug: "promo", source: "", at: now(), site: site.id });
    const slugs: string[] = [];
    for (let i = 0; i < 5; i++) slugs.push((await visitWith(site, token, `198.51.100.${30 + i}`))!.link_slug);
    expect(slugs).toEqual(["promo", "promo", "promo", "", ""]);
    // The first visitor coming back still counts.
    expect(await visitWith(site, token, "198.51.100.30")).toMatchObject({ link_slug: "promo" });
  });

  it("is one token however it is written", async () => {
    const site = await createSite();
    const token = await signClickToken(SECRET, { domain: "sh.example", slug: "promo", source: "", at: now(), site: site.id });
    const [body, sig] = token.split(".") as [string, string];
    // The last character of 8 bytes in base64 has two spare bits: these decode to the same signature.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respelled = sig.slice(0, -1) + ALPHABET[ALPHABET.indexOf(sig.at(-1)!) + 1]!;
    const variants = [`${token}.x`, `${token}.`, `${body}.${sig}.y.z`, `${body}.${respelled}`, `${body}=.${sig}`, `${token}=`];
    for (const variant of variants) expect(await verifyClickToken(SECRET, variant, now()), variant).toBeNull();
    expect(await verifyClickToken(SECRET, token, now())).toMatchObject({ slug: "promo", id: sig });

    for (let i = 0; i < variants.length; i++) expect(await visitWith(site, variants[i]!, `198.51.100.${40 + i}`)).toMatchObject({ link_slug: "" });
    const slugs: string[] = [];
    for (let i = 0; i < 5; i++) slugs.push((await visitWith(site, token, `198.51.100.${50 + i}`))!.link_slug);
    expect(slugs).toEqual(["promo", "promo", "promo", "", ""]);
  });
});

describe("the collector's budget counts rows", () => {
  const FREE_ENV = { ...env, WORKERS_PLAN: "free" } as Env;
  const counted = async () => Number((await row<{ value: string }>("SELECT value FROM settings WHERE key = ?1", budgetKey(new Date().toISOString().slice(0, 10))))?.value ?? 0);

  it("charges what an event wrote, return-page references included", async () => {
    const site = await createSite();
    const res = await collect(site, { k: ["ref-aaaa", "ref-bbbb", "ref-cccc", "ref-dddd", "ref-eeee"] }, "198.51.100.40", SITE_ORIGIN, { WORKERS_PLAN: "free" });
    expect(res.status).toBe(200);
    expect(await row("SELECT COUNT(*) AS n FROM payment_claims")).toEqual({ n: 5 });
    // Nothing is in D1 until a flush: a charge that alone can't reach one shows what the event left waiting.
    expect(MAX_EVENT_ROWS).toBeLessThan(FLUSH_ROWS);
    await chargeCollectBudget(FREE_ENV, now(), FLUSH_ROWS - 10);
    // A new visit is several rows, and each of the five references at least one.
    expect(await counted()).toBeGreaterThanOrEqual(FLUSH_ROWS);
  });

  it("stops at the budget, and payments are still recorded", async () => {
    const site = await createSite();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)").bind(budgetKey(new Date().toISOString().slice(0, 10)), String(FREE.collectRows)).run();
    expect((await collect(site, {}, "198.51.100.41", SITE_ORIGIN, { WORKERS_PLAN: "free" })).status).toBe(202);
    expect(await row("SELECT COUNT(*) AS n FROM web_sessions")).toEqual({ n: 0 });
    expect((await pay(site, { id: "after-budget" })).status).toBe(201);
  });

  it("charges a default when D1 reports nothing, and caps a wild figure", async () => {
    await chargeCollectBudget(FREE_ENV, now(), 0);
    await chargeCollectBudget(FREE_ENV, now(), Number.NaN);
    await chargeCollectBudget(FREE_ENV, now(), 1e9);
    await chargeCollectBudget(FREE_ENV, now(), 1e9);
    expect(await counted()).toBe(2 * DEFAULT_EVENT_ROWS + 2 * MAX_EVENT_ROWS);
  });

  it("never stops a visit because the counter fails", async () => {
    const broken = { ...FREE_ENV, DB: { prepare: () => { throw new Error("D1 is down"); } } as unknown as D1Database };
    expect(await collectBudgetAllows(broken, now())).toBe(true);
    for (let i = 0; i < 5; i++) await expect(chargeCollectBudget(broken, now(), MAX_EVENT_ROWS)).resolves.toBeUndefined();
    expect(await collectBudgetAllows(broken, now())).toBe(true);
  });

  it("limits how many references one visit can store, and keeps the visit", async () => {
    const site = await createSite();
    for (let i = 0; i < 4; i++) expect((await collect(site, { k: [1, 2, 3, 4, 5].map((n) => `claim-${i}-${n}`) })).status).toBe(200);
    expect(await row("SELECT COUNT(*) AS n FROM payment_claims")).toEqual({ n: 10 });
    expect(await row("SELECT pageviews FROM web_sessions")).toEqual({ pageviews: 4 });
  });
});

describe("CSV cells", () => {
  it("keeps amounts as numbers, refunds too", () => {
    expect(csvCell("-5.00")).toBe("-5.00");
    expect(csvCell(-12)).toBe("-12");
    expect(csvCell("19.99")).toBe("19.99");
  });

  it.each(["=1+1", "+1", "-1+2", "-5.00 ", "-5,00", "@SUM(A1)", "\tcmd", "\rcmd", "\ncmd", "-"])("makes %j harmless", (value) => {
    expect(csvCell(value).replace(/^"/, "").startsWith("'")).toBe(true);
  });

  it("is the same rule with either line ending", () => {
    expect(csv([["a", "\t=1"], ["-1", 'q"']], "\n")).toBe('a,\'\t=1\n-1,"q"""\n');
    expect(csv([["a"]])).toBe("a\r\n");
  });

  it("puts refund amounts in the payments export as numbers", async () => {
    const site = await createSite();
    await pay(site, { id: "c-csv", amount: 10 });
    await pay(site, { id: "r-csv", kind: "refund", amount: 4, parentId: "c-csv" });
    const file = await (await call(`${API}/sites/${site.id}/payments.csv?range=7d`, { headers })).text();
    expect(file).toContain(",refund,one_time,-4.00,USD,");
  });
});

describe("searching payments", () => {
  it("takes the term in the body, never the URL", async () => {
    const site = await createSite();
    await pay(site, { id: "p-1", email: "needle@example.com" });
    await pay(site, { id: "p-2", email: "other@example.com" });
    const found = await (await call(`${API}/sites/${site.id}/payments/search`, json({ range: "7d", q: "needle@example.com" }))).json<{ payments: { id: string }[]; total: number }>();
    expect(found).toMatchObject({ total: 1, payments: [{ id: "api:charge:p-1" }] });

    const file = await call(`${API}/sites/${site.id}/payments/search.csv`, json({ range: "7d", q: "needle@example.com" }));
    expect(file.headers.get("Content-Type")).toContain("text/csv");
    const text = await file.text();
    expect(text).toContain("needle@example.com");
    expect(text).not.toContain("other@example.com");

    for (const path of ["payments", "payments.csv"]) {
      const res = await call(`${API}/sites/${site.id}/${path}?range=7d&q=needle%40example.com`, { headers });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("POST");
    }
  });
});

describe("upgrading a database with payments in it", () => {
  /** The data statements of a migration: its ALTER and CREATE have run already. */
  const updates = (sql: string) => sql.split(";").map((s) => s.replace(/--.*$/gm, "").trim()).filter((s) => s.startsWith("UPDATE"));

  it("protects subscriptions that already ended, and leaves the others free", async () => {
    const site = await createSite();
    const t = now() - 1000;
    await env.DB.batch(
      [
        ["ended", "canceled", t, null, t + 500],
        ["future", "ended", null, t + 90 * DAY, t + 500],
        ["live", "active", t, null, t + 500],
      ].map(([id, status, canceled, ended, updated]) =>
        env.DB.prepare("INSERT INTO subscriptions (id, site_id, provider, status, started_at, canceled_at, ended_at, updated_at) VALUES (?1, ?2, 'stripe', ?3, 0, ?4, ?5, ?6)").bind(`stripe:${id}`, site.id, status, canceled, ended, updated),
      ),
    );
    for (const sql of updates(subscriptionMigration)) await env.DB.exec(sql.replace(/\s+/g, " "));
    const at = async (id: string) => (await row<{ last_event_at: number | null }>("SELECT last_event_at FROM subscriptions WHERE id = ?1", `stripe:${id}`))!.last_event_at;
    expect(await at("ended")).toBe(t);
    expect(await at("future")).toBe(t + 500); // Not a date in the future: real events after it still apply.
    expect(await at("live")).toBeNull();
    // An older event can't reopen the one that ended; a later one can.
    await storeSubscription(env.DB, site, "stripe", { providerId: "ended", status: "active", eventAt: t - 10 });
    expect(await row("SELECT status FROM subscriptions WHERE id = 'stripe:ended'")).toEqual({ status: "canceled" });
    await storeSubscription(env.DB, site, "stripe", { providerId: "ended", status: "active", eventAt: t + 10 });
    expect(await row("SELECT status FROM subscriptions WHERE id = 'stripe:ended'")).toEqual({ status: "active" });
  });

  it("redates PayPal cancellations that carry the subscription's creation date", async () => {
    const site = await createSite();
    const created = now() - 400 * DAY;
    const canceled = now() - 1000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO subscriptions (id, site_id, provider, status, started_at, canceled_at, updated_at) VALUES ('paypal:I-1', ?1, 'paypal', 'canceled', ?2, ?2, ?3)").bind(site.id, created, canceled),
      env.DB.prepare("INSERT INTO subscriptions (id, site_id, provider, status, started_at, canceled_at, updated_at) VALUES ('stripe:sub_kept', ?1, 'stripe', 'canceled', ?2, ?2, ?3)").bind(site.id, created, canceled),
    ]);
    for (const sql of updates(subscriptionMigration)) await env.DB.exec(sql.replace(/\s+/g, " "));
    expect(await row("SELECT canceled_at, last_event_at FROM subscriptions WHERE id = 'paypal:I-1'")).toEqual({ canceled_at: canceled, last_event_at: canceled });
    expect(await row("SELECT canceled_at FROM subscriptions WHERE id = 'stripe:sub_kept'")).toEqual({ canceled_at: created });
    // An event from before the cancellation can no longer bring it back.
    await storeSubscription(env.DB, site, "paypal", { providerId: "I-1", status: "active", eventAt: canceled - 60 });
    expect(await row("SELECT status FROM subscriptions WHERE id = 'paypal:I-1'")).toEqual({ status: "canceled" });
  });

  it("labels Gumroad payments received without an access token, and nothing else", async () => {
    const site = await createSite();
    const bare = await connect(site, { provider: "gumroad" });
    const keyed = await connect(site, { provider: "gumroad", apiKey: "tok" });
    const insert = (id: string, provider: string, connection: string | null) =>
      env.DB.prepare("INSERT INTO payments (id, site_id, connection_id, provider, kind, occurred_at, amount_minor, currency, created_at) VALUES (?1, ?2, ?3, ?4, 'charge', 1, 100, 'USD', 1)").bind(id, site.id, connection, provider);
    await env.DB.batch([insert("g1", "gumroad", bare.id), insert("g2", "gumroad", keyed.id), insert("s1", "stripe", null)]);
    for (const sql of updates(checksMigration)) await env.DB.exec(sql.replace(/\s+/g, " "));
    const { results } = await env.DB.prepare("SELECT id, unverified FROM payments ORDER BY id").all();
    expect(results).toEqual([
      { id: "g1", unverified: 1 },
      { id: "g2", unverified: 0 },
      { id: "s1", unverified: 0 },
    ]);
  });
});

describe("what the adapters do with amounts and test mode (their code, not the providers' documentation)", () => {
  it("Stripe: amounts stay in the provider's minor units, and livemode false is a test", async () => {
    const body = JSON.stringify({ id: "evt_f", type: "checkout.session.completed", livemode: false, created: 1_800_000_000, data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 1500, currency: "jpy" } } });
    const event = await ADAPTERS.stripe.parse(body, new Headers(), { apiKey: null, settings: {} });
    expect(event.payments[0]).toMatchObject({ amountMinor: 1500, currency: "JPY", testMode: true });
  });

  it.each(["paddle", "dodo"] as const)("%s: every event counts as live (no test flag is read)", async (provider) => {
    const body =
      provider === "paddle"
        ? JSON.stringify({ event_id: "e1", event_type: "transaction.completed", occurred_at: "2026-01-01T00:00:00Z", data: { id: "txn_1", currency_code: "USD", details: { totals: { grand_total: "1000" } } } })
        : JSON.stringify({ type: "payment.succeeded", timestamp: "2026-01-01T00:00:00Z", data: { payment_id: "pay_1", total_amount: 1000, currency: "USD" } });
    const event = await ADAPTERS[provider].parse(body, new Headers({ "webhook-id": "w1" }), { apiKey: null, settings: {} });
    expect(event.payments[0]).toMatchObject({ amountMinor: 1000, testMode: false });
  });
});

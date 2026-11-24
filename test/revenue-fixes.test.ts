import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDTO, SiteDTO, SiteOverviewDTO, SitePaymentDTO } from "../src/shared/sites";
import { bytesToHex, sign } from "../src/worker/revenue/crypto";
import { recreditSite } from "../src/worker/revenue/attribute";
import { refreshFx } from "../src/worker/revenue/fx";
import { storePayment } from "../src/worker/revenue/ingest";
import { resetPaypalTokens } from "../src/worker/revenue/providers/paypal";
import type { NormalizedPayment } from "../src/worker/revenue/types";
import { siteSummaries } from "../src/worker/web/queries";
import tracker from "../src/tracker/tracker.js?raw";
import { API, call, json, ORIGIN, resetData } from "./helpers";

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const DAY = 86400;

/** What the exchange-rate API answers per day ("latest" too); a day not listed is offline. */
let fxDays: Record<string, Record<string, number>> = {};
let fxAsked: string[] = [];

beforeEach(async () => {
  vi.restoreAllMocks();
  resetPaypalTokens();
  await resetData();
  fxDays = {};
  fxAsked = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("frankfurter")) return realFetch(input, init);
    const day = new URL(url).pathname.split("/").pop()!;
    fxAsked.push(day);
    const rates = fxDays[day];
    return Promise.resolve(rates ? Response.json({ date: day === "latest" ? new Date().toISOString().slice(0, 10) : day, rates }) : new Response("offline", { status: 503 }));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const now = () => Math.floor(Date.now() / 1000);
const dayOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

async function createSite(body: Record<string, unknown> = {}): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"], ...body }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

function collect(site: SiteDTO, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> {
  return call(`${ORIGIN}/_t/e`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/`, r: "", w: 1440, ...payload }),
  });
}

async function visit(site: SiteDTO, payload: Record<string, unknown> = {}): Promise<string> {
  const res = await collect(site, payload);
  expect(res.status).toBe(200);
  return (await res.json<{ s: string }>()).s;
}

async function addConnection(site: SiteDTO, body: Record<string, unknown>): Promise<ConnectionDTO> {
  const res = await call(`${API}/sites/${site.id}/connections`, json(body));
  expect(res.status).toBe(201);
  return res.json<ConnectionDTO>();
}

function hook(conn: ConnectionDTO, body: string, headers: Record<string, string>): Promise<Response> {
  return call(`${ORIGIN}/_pay/${conn.provider}/${conn.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

async function stripeSend(conn: ConnectionDTO, event: object): Promise<Response> {
  const body = JSON.stringify(event);
  const t = now();
  return hook(conn, body, { "Stripe-Signature": `t=${t},v1=${bytesToHex(await sign("whsec_test", `${t}.${body}`))}` });
}

async function sitePayments(site: SiteDTO, range = "7d"): Promise<SitePaymentDTO[]> {
  const res = await call(`${API}/sites/${site.id}/payments?range=${range}`, { headers: json({}).headers });
  return (await res.json<{ payments: SitePaymentDTO[] }>()).payments;
}

async function overview(site: SiteDTO): Promise<SiteOverviewDTO> {
  return (await call(`${API}/sites/${site.id}/overview?range=7d`, { headers: json({}).headers })).json<SiteOverviewDTO>();
}

const charge = (id: string, extra: Partial<NormalizedPayment> = {}): NormalizedPayment => ({
  kind: "charge",
  providerId: id,
  occurredAt: now() - 3600,
  amountMinor: 1000,
  currency: "USD",
  billing: "one_time",
  refs: [],
  productIds: [],
  testMode: false,
  ...extra,
});

const rate = (date: string, currency: string, value: number) => env.DB.prepare("INSERT INTO fx_rates (date, currency, rate) VALUES (?1, ?2, ?3)").bind(date, currency, value).run();

const paidCheckout = (id: string, extra: Record<string, unknown> = {}) => ({
  id: `evt_${id}`,
  type: "checkout.session.completed",
  livemode: true,
  created: now(),
  data: { object: { id: `cs_${id}`, mode: "payment", payment_status: "paid", payment_intent: `pi_${id}`, amount_total: 4900, currency: "usd", ...extra } },
});

describe("payment webhooks that fail halfway", () => {
  it("asks for a retry while an event is being processed, and takes over one left unfinished", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const event = paidCheckout("1");

    // Another delivery of the same event started a moment ago and hasn't finished.
    await env.DB.prepare("INSERT INTO payment_events (connection_id, event_id, received_at, type) VALUES (?1, 'evt_1', ?2, 'checkout.session.completed')").bind(conn.id, now() - 5).run();
    const busy = await stripeSend(conn, event);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("60");
    expect(await sitePayments(site)).toEqual([]);

    // It never finished (the Worker died, or the cleanup failed too): the provider's retry stores the payment.
    await env.DB.prepare("UPDATE payment_events SET received_at = ?1").bind(now() - 120).run();
    const retry = await stripeSend(conn, event);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    expect((await sitePayments(site)).map((p) => p.amountMinor)).toEqual([4900]);
    expect(await env.DB.prepare("SELECT processed_at FROM payment_events").first("processed_at")).toBeGreaterThan(0);

    // Finished: only now is a further delivery a duplicate.
    expect(await (await stripeSend(conn, event)).json()).toMatchObject({ duplicate: true });
  });

  it("stores nothing twice when an event that was partly stored is processed again", async () => {
    const site = await createSite();
    const ref = await visit(site);
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const paid = paidCheckout("2", { client_reference_id: `sh_${ref}`, customer: "cus_2" });
    const refunded = { id: "evt_refund", type: "charge.refunded", livemode: true, created: now(), data: { object: { id: "ch_2", payment_intent: "pi_2", amount: 4900, amount_refunded: 900, currency: "usd" } } };
    expect((await stripeSend(conn, paid)).status).toBe(200);
    expect((await stripeSend(conn, refunded)).status).toBe(200);
    const before = await env.DB.prepare("SELECT id, amount_minor, session_id, credited_session_id FROM payments ORDER BY id").all();

    // As if both had stored their payments and then failed before being marked finished.
    await env.DB.prepare("UPDATE payment_events SET processed_at = NULL, received_at = ?1").bind(now() - 300).run();
    expect((await stripeSend(conn, paid)).status).toBe(200);
    expect((await stripeSend(conn, refunded)).status).toBe(200);
    const after = await env.DB.prepare("SELECT id, amount_minor, session_id, credited_session_id FROM payments ORDER BY id").all();
    expect(after.results).toEqual(before.results);
    expect(after.results).toHaveLength(2);
    expect((await overview(site)).totals).toMatchObject({ revenue: 4000, payments: 1 });
  });
});

describe("exchange rates", () => {
  it("converts what it can, however many newer payments can never be converted", async () => {
    const site = await createSite({ currency: "USD" });
    const old = now() - 3 * DAY;
    // No exchange rate exists for these, and they are the newest.
    for (const id of ["a", "b", "c"]) await storePayment(env.DB, site, "api", null, charge(`aed_${id}`, { currency: "AED" }));
    await storePayment(env.DB, site, "api", null, charge("eur_1", { currency: "EUR", occurredAt: old }));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE amount_site_minor IS NULL").first("n")).toBe(4);
    expect((await overview(site)).unconverted).toBe(4);

    await rate(dayOf(old), "USD", 1.25);
    // A batch of two, as on the Free plan: the three unconvertible ones used to fill it for good.
    expect(await refreshFx(env.DB, 10, site.id, 2)).toEqual({ converted: 1 });
    expect(await env.DB.prepare("SELECT amount_site_minor FROM payments WHERE id = 'api:charge:eur_1'").first("amount_site_minor")).toBe(1250);
    expect((await overview(site)).unconverted).toBe(3);
  });

  it("fetches a day's rates when the currency a payment needs is missing, even if others are stored", async () => {
    const site = await createSite({ currency: "USD" });
    const at = now() - 2 * DAY;
    const day = dayOf(at);
    // The day has a rate, but not the pound's.
    await rate(day, "USD", 1.2);
    await storePayment(env.DB, site, "api", null, charge("gbp_1", { currency: "GBP", occurredAt: at }));
    expect(await env.DB.prepare("SELECT amount_site_minor FROM payments").first("amount_site_minor")).toBeNull();

    fxDays[day] = { USD: 1.2, GBP: 0.8 };
    fxAsked = [];
    expect(await refreshFx(env.DB, 10, site.id)).toEqual({ converted: 1 });
    expect(fxAsked).toContain(day);
    expect(await env.DB.prepare("SELECT amount_site_minor FROM payments").first("amount_site_minor")).toBe(1500);
  });

  it("gives every waiting payment its turn, and never makes a same-currency payment wait", async () => {
    const site = await createSite({ currency: "USD" });
    // Rates are offline: two newer payments can't be converted yet, and would stay first in line.
    await storePayment(env.DB, site, "api", null, charge("gbp_new_1", { currency: "GBP", occurredAt: now() - 100 }));
    await storePayment(env.DB, site, "api", null, charge("gbp_new_2", { currency: "GBP", occurredAt: now() - 200 }));
    const old = now() - 20 * DAY;
    await storePayment(env.DB, site, "api", null, charge("gbp_old", { currency: "GBP", occurredAt: old }));
    await rate(dayOf(old), "USD", 1.2);
    await rate(dayOf(old), "GBP", 0.8);
    // In the site's own currency, left without an amount (as after a failed write).
    await storePayment(env.DB, site, "api", null, charge("usd_1", { occurredAt: now() - 21 * DAY }));
    await env.DB.prepare("UPDATE payments SET amount_site_minor = NULL WHERE id = 'api:charge:usd_1'").run();

    expect(await refreshFx(env.DB, 10, site.id, 2)).toEqual({ converted: 0 });
    expect(await refreshFx(env.DB, 10, site.id, 2)).toEqual({ converted: 2 });
    const rows = await env.DB.prepare("SELECT id, amount_site_minor FROM payments ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: "api:charge:gbp_new_1", amount_site_minor: null },
      { id: "api:charge:gbp_new_2", amount_site_minor: null },
      { id: "api:charge:gbp_old", amount_site_minor: 1500 },
      { id: "api:charge:usd_1", amount_site_minor: 1000 },
    ]);
  });

  it("puts subscriptions' monthly value into the new currency when the site's currency changes", async () => {
    const site = await createSite({ currency: "USD" });
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const sub = (id: string, amount: number, interval: string) => ({
      id: `evt_${id}`,
      type: "customer.subscription.updated",
      livemode: true,
      created: now(),
      data: { object: { id, status: "active", customer: "cus_1", items: { data: [{ quantity: 1, price: { unit_amount: amount, currency: "usd", recurring: { interval, interval_count: 1 } } }] } } },
    });
    expect((await stripeSend(conn, sub("sub_month", 2000, "month"))).status).toBe(200);
    expect((await stripeSend(conn, sub("sub_year", 12000, "year"))).status).toBe(200);
    const mrr = async () => (await (await call(`${API}/sites/${site.id}/subscriptions?range=7d`, { headers: json({}).headers })).json<{ mrr: number }>()).mrr;
    expect(await mrr()).toBe(3000);

    await rate(dayOf(now()), "USD", 1.25);
    expect((await call(`${API}/sites/${site.id}`, { ...json({ currency: "EUR" }), method: "PATCH" })).status).toBe(200);
    // 30 USD a month at 1.25 USD to the euro.
    expect(await mrr()).toBe(2400);
    const rows = await env.DB.prepare("SELECT id, mrr_site_minor FROM subscriptions ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: "stripe:sub_month", mrr_site_minor: 1600 },
      { id: "stripe:sub_year", mrr_site_minor: 800 },
    ]);
  });

  it("doesn't leave MRR in the old currency when no rate is known, and fills it in once one is", async () => {
    const site = await createSite({ currency: "USD" });
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    await stripeSend(conn, {
      id: "evt_s",
      type: "customer.subscription.updated",
      livemode: true,
      created: now(),
      data: { object: { id: "sub_1", status: "active", customer: "cus_1", items: { data: [{ quantity: 1, price: { unit_amount: 2000, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] } } },
    });
    await call(`${API}/sites/${site.id}`, { ...json({ currency: "EUR" }), method: "PATCH" });
    expect(await env.DB.prepare("SELECT mrr_site_minor FROM subscriptions").first("mrr_site_minor")).toBeNull();
    fxDays.latest = { USD: 1.25 };
    await refreshFx(env.DB, 10, site.id);
    expect(await env.DB.prepare("SELECT mrr_site_minor FROM subscriptions").first("mrr_site_minor")).toBe(1600);
  });

  it("converts an older subscription's MRR behind 200 newer ones in a currency without rates", async () => {
    const site = await createSite({ currency: "EUR" });
    const insert = (id: string, currency: string, updatedAt: number) =>
      env.DB.prepare("INSERT INTO subscriptions (id, site_id, provider, status, interval_unit, amount_minor, currency, started_at, updated_at) VALUES (?1, ?2, 'api', 'active', 'month', 2000, ?3, 0, ?4)").bind(id, site.id, currency, updatedAt);
    await env.DB.batch(Array.from({ length: 200 }, (_, i) => insert(`api:sub_xyz_${i}`, "XYZ", now())));
    await insert("api:sub_usd", "USD", now() - DAY).run();
    fxDays.latest = { USD: 1.25 };
    await refreshFx(env.DB, 10, site.id);
    expect(await env.DB.prepare("SELECT mrr_site_minor FROM subscriptions WHERE id = 'api:sub_usd'").first("mrr_site_minor")).toBe(1600);
  });
});

describe("crediting renewals", () => {
  /** A visit some days ago, written directly: the collector only records the present. */
  async function pastVisit(site: SiteDTO, id: string, visitor: string, daysAgo: number, source: { channel: string; source: string }): Promise<void> {
    const at = now() - daysAgo * DAY;
    await env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews, source, channel) VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5, ?6)")
      .bind(id, site.id, visitor, at, source.source, source.channel)
      .run();
  }

  const invoice = (id: string, daysAgo: number, reason: string, extra: Record<string, unknown> = {}) => ({
    id: `evt_${id}`,
    type: "invoice.paid",
    livemode: true,
    created: now() - daysAgo * DAY,
    data: { object: { id, amount_paid: 1500, currency: "usd", customer: "cus_1", subscription: "sub_1", billing_reason: reason, status_transitions: { paid_at: now() - daysAgo * DAY }, ...extra } },
  });

  it("credits a renewal to the visit its first payment was credited to, not to a recent direct visit", async () => {
    const site = await createSite({ idMode: "persistent" });
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const visitor = "visitor_abcdefghijklmnop";
    await pastVisit(site, "sessGoogle000001", visitor, 45, { channel: "Paid", source: "Google" });
    // The customer comes back directly to use the product, shortly before each renewal.
    await pastVisit(site, "sessDirect000001", visitor, 14, { channel: "Direct", source: "" });
    await pastVisit(site, "sessDirect000002", visitor, 1, { channel: "Direct", source: "" });

    expect((await stripeSend(conn, invoice("in_1", 44, "subscription_create", { subscription_details: { subscription: "sub_1", metadata: { sh_ref: "sessGoogle000001" } } }))).status).toBe(200);
    // One renewal knows only its customer; the other carries the checkout's reference again.
    expect((await stripeSend(conn, invoice("in_2", 13, "subscription_cycle"))).status).toBe(200);
    expect((await stripeSend(conn, invoice("in_3", 0, "subscription_cycle", { subscription_details: { subscription: "sub_1", metadata: { sh_ref: "sessGoogle000001" } } }))).status).toBe(200);

    const credits = async () => (await sitePayments(site, "90d")).map((p) => [p.id, p.matchedBy, p.credited?.id]);
    expect(await credits()).toEqual([
      ["stripe:charge:in_3", "ref", "sessGoogle000001"],
      ["stripe:charge:in_2", "customer", "sessGoogle000001"],
      ["stripe:charge:in_1", "ref", "sessGoogle000001"],
    ]);

    // Crediting everything again under another model keeps the renewals with their first payment.
    expect((await call(`${API}/sites/${site.id}`, { ...json({ attributionModel: "last_touch" }), method: "PATCH" })).status).toBe(200);
    expect((await credits()).map((c) => c[2])).toEqual(["sessGoogle000001", "sessGoogle000001", "sessGoogle000001"]);

    // The renewals find their first payment without a query each: two reads, and one for the payment of its own.
    const selects: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (/^\s*SELECT/i.test(sql)) selects.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(await recreditSite(db, { ...site, attributionModel: "first_touch" })).toBe(3);
    expect(selects).toHaveLength(3);
    expect((await credits()).map((c) => c[2])).toEqual(["sessGoogle000001", "sessGoogle000001", "sessGoogle000001"]);
  });

  it("credits two payments of the same second in order, not each from the other", async () => {
    const site = await createSite({ idMode: "persistent" });
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const visitor = "visitor_abcdefghijklmnop";
    await pastVisit(site, "sessGoogle000001", visitor, 10, { channel: "Paid", source: "Google" });
    await pastVisit(site, "sessDirect000001", visitor, 3, { channel: "Direct", source: "" });
    const meta = { subscription_details: { subscription: "sub_1", metadata: { sh_ref: "sessDirect000001" } } };
    // Paid in the same second: an import, or a provider that reports whole seconds.
    expect((await stripeSend(conn, invoice("in_1", 2, "subscription_create", meta))).status).toBe(200);
    expect((await stripeSend(conn, invoice("in_2", 2, "subscription_cycle", meta))).status).toBe(200);
    const credits = async () => Object.fromEntries((await sitePayments(site, "90d")).map((p) => [p.id, p.credited?.id]));
    // Last non-direct (the default): the visit that brought the customer.
    expect(await credits()).toEqual({ "stripe:charge:in_1": "sessGoogle000001", "stripe:charge:in_2": "sessGoogle000001" });

    // Last touch: the first of the two is credited by the model, the other follows it.
    expect((await call(`${API}/sites/${site.id}`, { ...json({ attributionModel: "last_touch" }), method: "PATCH" })).status).toBe(200);
    expect(await credits()).toEqual({ "stripe:charge:in_1": "sessDirect000001", "stripe:charge:in_2": "sessDirect000001" });
  });

  it("still credits a payment of its own by the site's model", async () => {
    const site = await createSite({ idMode: "persistent" });
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    const visitor = "visitor_abcdefghijklmnop";
    await pastVisit(site, "sessGoogle000001", visitor, 3, { channel: "Paid", source: "Google" });
    await pastVisit(site, "sessDirect000001", visitor, 1, { channel: "Direct", source: "" });
    await stripeSend(conn, paidCheckout("own", { client_reference_id: "sh_sessDirect000001" }));
    // Last non-direct: matched to the direct visit, credited to the one that brought the visitor.
    expect((await sitePayments(site))[0]).toMatchObject({ matchedBy: "ref", session: { id: "sessDirect000001" }, credited: { id: "sessGoogle000001" } });
  });
});

describe("one visitor, one visit", () => {
  it("keeps the visit and its source when consent turns the daily hash into a first-party id", async () => {
    const site = await createSite({ idMode: "consent" });
    const vid = "visitor_abcdefghijklmnop";
    // Before consent the id the tracker sends is ignored.
    const first = await visit(site, { u: `${SITE_ORIGIN}/?utm_source=newsletter&utm_medium=email`, v: vid });
    await collect(site, { t: "identify", v: vid, e: { email: "anna@example.com" } });
    const hash = await env.DB.prepare("SELECT visitor_id FROM web_sessions").first<string>("visitor_id");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);

    const second = await visit(site, { u: `${SITE_ORIGIN}/pricing`, v: vid, cs: 1 });
    expect(second).toBe(first);
    const rows = await env.DB.prepare("SELECT id, visitor_id, channel, pageviews FROM web_sessions").all();
    expect(rows.results).toEqual([{ id: first, visitor_id: vid, channel: "Email", pageviews: 2 }]);
    // Who the daily hash said it was stays with the hash: someone else on the same network and
    // browser shares it, and the first-party id is kept for good.
    expect(await env.DB.prepare("SELECT email FROM web_visitors WHERE id = ?1").bind(vid).first("email")).toBeNull();
  });

  it("doesn't hand a returning visitor someone else's open visit", async () => {
    const site = await createSite({ idMode: "consent" });
    const vid = "visitor_abcdefghijklmnop";
    await env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews) VALUES ('sessOld000000001', ?1, ?2, ?3, ?3, 1)").bind(site.id, vid, now() - 5 * DAY).run();
    // Someone else on the same network and browser, who hasn't consented.
    const other = await visit(site);
    const mine = await visit(site, { v: vid, cs: 1 });
    expect(mine).not.toBe(other);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions").first("n")).toBe(3);
  });

  it("continues a cookieless visit over midnight UTC, and starts a new one after the usual gap", async () => {
    const site = await createSite();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T23:50:00Z"));
    const first = await visit(site, { u: `${SITE_ORIGIN}/?utm_source=google&utm_medium=cpc` });
    await collect(site, { t: "identify", e: { email: "anna@example.com" } });
    vi.setSystemTime(new Date("2026-03-11T00:05:00Z"));
    expect(await visit(site, { u: `${SITE_ORIGIN}/pricing` })).toBe(first);
    // From one day's hash to the next, who they said they were comes along.
    const today = await env.DB.prepare("SELECT visitor_id FROM web_sessions WHERE id = ?1").bind(first).first<string>("visitor_id");
    expect(await env.DB.prepare("SELECT email FROM web_visitors WHERE id = ?1").bind(today).first("email")).toBe("anna@example.com");
    vi.setSystemTime(new Date("2026-03-11T00:20:00Z"));
    expect((await collect(site, { t: "goal", n: "signup" })).status).toBe(200);
    const rows = await env.DB.prepare("SELECT id, channel, pageviews, goals FROM web_sessions").all();
    expect(rows.results).toEqual([{ id: first, channel: "Paid", pageviews: 2, goals: 1 }]);

    // 40 minutes without an event: a new visit, as always.
    vi.setSystemTime(new Date("2026-03-11T01:00:00Z"));
    expect(await visit(site)).not.toBe(first);
  });

  it("doesn't continue yesterday's visit once it has ended", async () => {
    const site = await createSite();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T23:20:00Z"));
    const first = await visit(site);
    vi.setSystemTime(new Date("2026-03-11T00:05:00Z"));
    expect(await visit(site)).not.toBe(first);
  });

  it("starts one visit when a page's first events arrive together", async () => {
    const site = await createSite();
    // The tracker fires goals queued before it loaded right after the first pageview.
    const sent = await Promise.all([collect(site), collect(site, { t: "goal", n: "signup" }), collect(site, { t: "goal", n: "cta" }), collect(site, { t: "checkout", n: "https://buy.stripe.com/x" })]);
    expect(sent.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const refs = await Promise.all(sent.map(async (r) => (await r.json<{ s: string }>()).s));
    expect(new Set(refs).size).toBe(1);
    const rows = await env.DB.prepare("SELECT pageviews, goals, checkout_at IS NOT NULL AS checkout FROM web_sessions").all();
    expect(rows.results).toEqual([{ pageviews: 1, goals: 2, checkout: 1 }]);
  });

  it("still starts a new visit after 30 minutes, and for a new campaign", async () => {
    const site = await createSite();
    const first = await visit(site);
    const campaign = await visit(site, { u: `${SITE_ORIGIN}/?utm_source=x&utm_campaign=one` });
    expect(campaign).not.toBe(first);
    await env.DB.prepare("UPDATE web_sessions SET last_seen_at = last_seen_at - 1900, started_at = started_at - 1900").run();
    const later = await visit(site);
    expect([first, campaign]).not.toContain(later);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions").first("n")).toBe(3);
  });
});

describe("provider edge cases", () => {
  it("PayPal: sends the event back for verification exactly as it arrived", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "paypal", apiKey: "client-secret", settings: { clientId: "cid", webhookId: "WH-1", sandbox: "1" } });
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "A21", expires_in: 3600 });
      if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
        sent.push(String(init?.body));
        return Response.json({ verification_status: "SUCCESS" });
      }
      return real(input, init);
    });
    // Spacing, a trailing zero, an escaped slash and a non-ASCII escape: none survives JSON.parse and JSON.stringify.
    const body = `{"id": "WH-EVT-9",  "event_type":"PAYMENT.CAPTURE.COMPLETED", "summary":"Caf\\u00e9 5\\/5", "resource":{"id":"CAP9","amount":{"value":"10.00","currency_code":"USD"},"fee":1.50}}`;
    expect(JSON.stringify(JSON.parse(body))).not.toBe(body);
    const res = await call(`${ORIGIN}/_pay/paypal/${conn.id}`, { method: "POST", headers: {
        "PAYPAL-TRANSMISSION-SIG": "sig",
        "PAYPAL-TRANSMISSION-ID": "t1",
        "PAYPAL-TRANSMISSION-TIME": new Date().toISOString(),
        "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
        "PAYPAL-AUTH-ALGO": "SHA256withRSA",
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`"webhook_event":${body}}`);
    expect(JSON.parse(sent[0]!)).toMatchObject({ webhook_id: "WH-1", transmission_sig: "sig", transmission_id: "t1", auth_algo: "SHA256withRSA", webhook_event: { id: "WH-EVT-9" } });
    expect((await sitePayments(site))[0]).toMatchObject({ amountMinor: 1000, currency: "USD" });
  });

  it("Stripe: a refund finds an invoice that names no PaymentIntent, and a later dispute does too", async () => {
    const site = await createSite();
    const ref = await visit(site);
    // A product filter drops a refund whose charge isn't found: it must be found.
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test", productFilter: ["prod_mine"] });
    const lines = { data: [{ pricing: { price_details: { product: "prod_mine" } } }] };
    // Newer API versions: no payment_intent or charge on the invoice, the subscription under parent.
    const inv = (id: string, amount: number) => ({
      id: `evt_${id}`,
      type: "invoice.paid",
      livemode: true,
      created: now(),
      data: { object: { id, amount_paid: amount, currency: "usd", customer: "cus_1", billing_reason: "subscription_create", lines, parent: { subscription_details: { subscription: `sub_${id}`, metadata: { sh_ref: ref } } } } },
    });
    expect((await stripeSend(conn, inv("in_1", 2900))).status).toBe(200);
    expect((await stripeSend(conn, inv("in_2", 9900))).status).toBe(200);

    const refund = (total: number) => ({
      id: `evt_refund_${total}`,
      type: "charge.refunded",
      livemode: true,
      created: now(),
      data: { object: { id: "ch_1", payment_intent: "pi_1", customer: "cus_1", amount: 2900, amount_refunded: total, currency: "usd", created: now() - 30 } },
    });
    expect((await stripeSend(conn, refund(1000))).status).toBe(200);
    expect((await stripeSend(conn, refund(2900))).status).toBe(200);
    expect((await stripeSend(conn, { id: "evt_dp", type: "charge.dispute.created", livemode: true, created: now(), data: { object: { id: "dp_1", charge: "ch_1", payment_intent: "pi_1", amount: 2900, currency: "usd" } } })).status).toBe(200);

    const rows = await env.DB.prepare("SELECT id, amount_minor, parent_id, credited_session_id FROM payments WHERE kind != 'charge' ORDER BY id").all();
    expect(rows.results).toEqual([
      { id: "stripe:dispute:dp_1", amount_minor: -2900, parent_id: "stripe:charge:in_1", credited_session_id: ref },
      { id: "stripe:refund:ch_1", amount_minor: -2900, parent_id: "stripe:charge:in_1", credited_session_id: ref },
    ]);
    // The refund and the dispute both take the first invoice's money back.
    expect((await overview(site)).totals).toMatchObject({ grossRevenue: 12800, refunds: 5800 });
  });

  it("Stripe: reads an invoice's payment ids from its payments list, and leaves other customers' invoices alone", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    await stripeSend(conn, {
      id: "evt_in",
      type: "invoice.paid",
      livemode: true,
      created: now(),
      data: { object: { id: "in_5", amount_paid: 2900, currency: "usd", customer: "cus_5", payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_5" } }] }, parent: { subscription_details: { subscription: "sub_5" } } } },
    });
    expect(await env.DB.prepare("SELECT order_ref FROM payments").first("order_ref")).toBe("in_5 pi_5");
    // A dispute needs nothing else to find it.
    await stripeSend(conn, { id: "evt_dp", type: "charge.dispute.created", livemode: true, created: now(), data: { object: { id: "dp_5", charge: "ch_5", payment_intent: "pi_5", amount: 2900, currency: "usd" } } });
    expect(await env.DB.prepare("SELECT parent_id FROM payments WHERE kind = 'dispute'").first("parent_id")).toBe("stripe:charge:in_5");
    // Same amount, another customer, and this invoice's PaymentIntent is known to be a different one: not its refund.
    await stripeSend(conn, { id: "evt_rf", type: "charge.refunded", livemode: true, created: now(), data: { object: { id: "ch_7", payment_intent: "pi_7", customer: "cus_5", amount: 2900, amount_refunded: 2900, currency: "usd", created: now() } } });
    expect(await env.DB.prepare("SELECT parent_id FROM payments WHERE kind = 'refund'").first("parent_id")).toBeNull();
  });

  it("Creem: a refund seen by the webhook and by the import is counted once", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "creem", webhookSecret: "creem_secret", apiKey: "creem_key" });
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      return hook(conn, text, { "creem-signature": bytesToHex(await sign("creem_secret", text)) });
    };
    const at = now() - 3600;
    expect((await send({ id: "evt_1", eventType: "checkout.completed", object: { id: "ch_1", customer: { id: "cust_1" }, order: { id: "ord_1", transaction: "tran_1", amount: 1900, currency: "EUR" } } })).status).toBe(200);
    const refund = (id: string, amount: number, total: number) => ({
      id: `evt_${id}`,
      eventType: "refund.created",
      object: { id, refund_amount: amount, refund_currency: "EUR", transaction: { id: "tran_1", amount: 1900, refunded_amount: total, status: "partialRefund" }, order: { id: "ord_1" } },
    });
    expect((await send(refund("ref_1", 500, 500))).status).toBe(200);
    expect((await send(refund("ref_2", 400, 900))).status).toBe(200);
    const refunds = () => env.DB.prepare("SELECT id, amount_minor, parent_id FROM payments WHERE kind = 'refund'").all();
    expect((await refunds()).results).toEqual([{ id: "creem:refund:tran_1", amount_minor: -900, parent_id: "creem:charge:tran_1" }]);

    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("creem.io")) return real(input, init);
      return Response.json({ items: [{ id: "tran_1", status: "partialRefund", amount: 1900, amount_paid: 1900, refunded_amount: 900, currency: "EUR", order: "ord_1", customer: "cust_1", created_at: at * 1000 }], pagination: { total_pages: 1 } });
    });
    const res = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30 }));
    expect(res.status).toBe(200);
    expect((await refunds()).results).toEqual([{ id: "creem:refund:tran_1", amount_minor: -900, parent_id: "creem:charge:tran_1" }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE kind = 'charge'").first("n")).toBe(1);
  });

  it("Creem: the import replaces refunds stored one by one under their own ids", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "creem", webhookSecret: "creem_secret", apiKey: "creem_key" });
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      return hook(conn, text, { "creem-signature": bytesToHex(await sign("creem_secret", text)) });
    };
    await send({ id: "evt_1", eventType: "checkout.completed", object: { id: "ch_1", customer: { id: "cust_1" }, order: { id: "ord_1", transaction: "tran_1", amount: 1900, currency: "EUR" } } });
    // Only the transaction's id, no running total: each refund stands alone.
    await send({ id: "evt_2", eventType: "refund.created", object: { id: "ref_1", refund_amount: 500, refund_currency: "EUR", transaction: "tran_1" } });
    await send({ id: "evt_3", eventType: "refund.created", object: { id: "ref_2", refund_amount: 400, refund_currency: "EUR", transaction: "tran_1" } });
    expect(await env.DB.prepare("SELECT SUM(amount_minor) AS n FROM payments WHERE kind = 'refund'").first("n")).toBe(-900);

    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("creem.io")) return real(input, init);
      return Response.json({ items: [{ id: "tran_1", status: "partialRefund", amount: 1900, refunded_amount: 900, currency: "EUR", order: "ord_1", created_at: Date.now() - 60_000 }], pagination: { total_pages: 1 } });
    });
    await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30 }));
    const rows = await env.DB.prepare("SELECT id, amount_minor FROM payments WHERE kind = 'refund'").all();
    expect(rows.results).toEqual([{ id: "creem:refund:tran_1", amount_minor: -900 }]);
  });

  it("Creem: a refund stored before its charge was known is replaced by the charge's total, not counted twice", async () => {
    const site = await createSite();
    // No API key: a refund without a running total can't be completed through the API.
    const conn = await addConnection(site, { provider: "creem", webhookSecret: "creem_secret" });
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      return hook(conn, text, { "creem-signature": bytesToHex(await sign("creem_secret", text)) });
    };
    const at = now() - 600;
    // The refund comes first: its charge isn't stored yet, so it is kept on its own.
    expect((await send({ id: "evt_r1", eventType: "refund.created", object: { id: "ref_1", refund_amount: 500, refund_currency: "EUR", transaction: "tran_1", created_at: (at - 60) * 1000 } })).status).toBe(200);
    expect(await env.DB.prepare("SELECT id, parent_id FROM payments WHERE kind = 'refund'").all()).toMatchObject({ results: [{ id: "creem:refund:ref_1", parent_id: null }] });
    await send({ id: "evt_1", eventType: "checkout.completed", object: { id: "ch_1", customer: { id: "cust_1" }, order: { id: "ord_1", transaction: "tran_1", amount: 1900, currency: "EUR" } } });
    // A later refund reports the transaction's total, the first one included.
    await send({
      id: "evt_r2",
      eventType: "refund.created",
      object: { id: "ref_2", refund_amount: 400, refund_currency: "EUR", created_at: at * 1000, transaction: { id: "tran_1", amount: 1900, refunded_amount: 900, status: "partialRefund" } },
    });
    const rows = await env.DB.prepare("SELECT id, amount_minor FROM payments WHERE kind = 'refund'").all();
    expect(rows.results).toEqual([{ id: "creem:refund:tran_1", amount_minor: -900 }]);
  });

  it("Lemon Squeezy: a refund of a subscription's first invoice finds the order it was stored as", async () => {
    const site = await createSite();
    const ref = await visit(site);
    const conn = await addConnection(site, { provider: "lemonsqueezy", webhookSecret: "my-ls-secret" });
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      return hook(conn, text, { "X-Signature": bytesToHex(await sign("my-ls-secret", text)) });
    };
    await send({ meta: { event_name: "order_created", custom_data: { sh_ref: ref } }, data: { id: "77", attributes: { status: "paid", total: 1200, currency: "USD", customer_id: 5 } } });
    await send({ meta: { event_name: "subscription_created" }, data: { id: "300", attributes: { status: "active", customer_id: 5, order_id: 77 } } });
    await send({ meta: { event_name: "subscription_payment_success" }, data: { id: "501", attributes: { billing_reason: "renewal", total: 1200, currency: "USD", customer_id: 5, subscription_id: 300 } } });

    // The first invoice (500) was never stored as a charge: its payment is order 77.
    expect((await send({ meta: { event_name: "subscription_payment_refunded" }, data: { id: "500", attributes: { billing_reason: "initial", refunded_amount: 1200, currency: "USD", customer_id: 5, subscription_id: 300 } } })).status).toBe(200);
    const refunds = () => env.DB.prepare("SELECT id, amount_minor, parent_id, credited_session_id FROM payments WHERE kind = 'refund' ORDER BY id").all();
    const first = { id: "lemonsqueezy:refund:order:77", amount_minor: -1200, parent_id: "lemonsqueezy:charge:order:77", credited_session_id: ref };
    expect((await refunds()).results).toEqual([first]);

    // The order's own refund event reports the same money.
    await send({ meta: { event_name: "order_refunded" }, data: { id: "77", attributes: { status: "refunded", refunded_amount: 1200, currency: "USD", customer_id: 5 } } });
    expect((await refunds()).results).toEqual([first]);

    // A renewal's refund still belongs to that renewal.
    await send({ meta: { event_name: "subscription_payment_refunded" }, data: { id: "501", attributes: { billing_reason: "renewal", refunded_amount: 300, currency: "USD", customer_id: 5, subscription_id: 300 } } });
    expect((await refunds()).results).toEqual([{ id: "lemonsqueezy:refund:invoice:501", amount_minor: -300, parent_id: "lemonsqueezy:charge:invoice:501", credited_session_id: ref }, first]);
  });
});

describe("tracker", () => {
  it("counts a page restored from the back/forward cache, and only that pageshow", () => {
    expect(tracker).toMatch(/addEventListener\("pageshow", function \(e\) \{ if \(e\.persisted\) pageview\(true\); \}\)/);
    // Still a small script (the README says about 7 KB compressed).
    expect(tracker.length).toBeLessThan(26_000);
  });
});

describe("indexes", () => {
  const plan = async (sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map((r) => r.detail).join("\n");

  it("reads the live numbers and the daily rollup's day through an index", async () => {
    expect(await plan("SELECT COUNT(DISTINCT visitor_id) FROM web_sessions s WHERE site_id = ?1 AND last_seen_at > ?2 AND s.via = ''", "st_x", 0)).toContain("web_sessions_site_seen");
    expect(await plan("SELECT * FROM web_sessions s WHERE site_id = ?1 AND s.via = '' ORDER BY last_seen_at DESC LIMIT 20", "st_x")).toContain("web_sessions_site_seen");
    expect(await plan("DELETE FROM web_daily_events WHERE day = ?", "2026-01-01")).toContain("web_daily_events_day");
    const pending = await plan("SELECT id FROM payments p WHERE p.amount_site_minor IS NULL ORDER BY p.fx_tried_at IS NOT NULL, p.fx_tried_at LIMIT 5");
    expect(pending).toContain("payments_unconverted");
  });

  it("summarises the websites list site by site", async () => {
    const site = await createSite();
    const other = await createSite({ name: "Other", domains: ["other.example.com"] });
    await visit(site);
    await storePayment(env.DB, site, "api", null, charge("p1"));
    const summaries = await siteSummaries(env.DB, [site, other]);
    expect(summaries.get(site.id)).toMatchObject({ visitors24h: 1, online: 1, visitors7d: 1, revenue30d: 1000, topSource: { share: 1 } });
    expect(summaries.get(site.id)!.lastSeenAt).toBeGreaterThan(0);
    expect(summaries.get(site.id)!.visitsDaily.at(-1)!.visits).toBe(1);
    expect(summaries.get(other.id)).toMatchObject({ visitors24h: 0, online: 0, revenue30d: 0, lastSeenAt: null });
    // A site not asked for is not read.
    expect((await siteSummaries(env.DB, [other])).has(site.id)).toBe(false);
  });
});

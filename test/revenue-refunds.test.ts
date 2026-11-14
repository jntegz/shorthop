// Refunds and disputes find the charge they belong to by ids the providers
// document, and the same refund reported twice is one row.
//
// The payloads below follow the providers' published object shapes. The docs
// sites could not be fetched while this was written, so the shapes were taken
// from the providers' own SDK type definitions, which are generated from the
// same API descriptions:
//   Stripe         stripe@23.1.0: InvoicePayment, InvoicePaymentPaidEvent, Charge, Dispute
//                  (https://docs.stripe.com/api/invoice-payment/object,
//                   https://docs.stripe.com/api/events/types#event_types-invoice_payment.paid)
//   Creem          creem@1.14.0: WebhookRefundCreatedEventEntity, RefundEntity, TransactionEntity
//                  (https://docs.creem.io/code/webhooks)
//   Lemon Squeezy  @lemonsqueezy/lemonsqueezy.js@4.0.0: Order, Subscription, SubscriptionInvoice
//                  (https://docs.lemonsqueezy.com/api/subscription-invoices/the-subscription-invoice-object,
//                   https://docs.lemonsqueezy.com/help/webhooks/event-types)

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDTO, SiteDTO } from "../src/shared/sites";
import { PROVIDER_INFO } from "../src/shared/sites";
import { bytesToHex, sign } from "../src/worker/revenue/crypto";
import { storeSubscription } from "../src/worker/revenue/ingest";
import { API, call, json, ORIGIN, resetData } from "./helpers";

/** Answers for the providers' APIs: the first whose key is in the URL. Anything else is offline. */
let api: Record<string, (url: URL) => Response> = {};
let asked: string[] = [];

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetData();
  await env.DB.prepare("DELETE FROM payment_links").run();
  api = {};
  asked = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.keys(api).find((k) => url.includes(k));
    if (hit) asked.push(url);
    return Promise.resolve(hit ? api[hit]!(new URL(url)) : new Response("offline", { status: 503 }));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const now = () => Math.floor(Date.now() / 1000);

async function createSite(): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

async function addConnection(site: SiteDTO, body: Record<string, unknown>): Promise<ConnectionDTO> {
  const res = await call(`${API}/sites/${site.id}/connections`, json(body));
  expect(res.status).toBe(201);
  return res.json<ConnectionDTO>();
}

async function send(conn: ConnectionDTO, body: string, headers: Record<string, string>): Promise<void> {
  const res = await call(`${ORIGIN}/_pay/${conn.provider}/${conn.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
  expect(res.status).toBe(200);
}

const importPast = async (site: SiteDTO, conn: ConnectionDTO) => {
  const res = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30 }));
  expect(res.status).toBe(200);
  return res.json<{ imported: number; next: string | null }>();
};

const rows = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const refunds = () => rows("SELECT id, amount_minor, parent_id FROM payments WHERE kind = 'refund' ORDER BY id");

describe("Stripe: invoices that don't name their PaymentIntent (API 2025-03-31 and later)", () => {
  let n = 0;
  const stripeSend = async (conn: ConnectionDTO, type: string, object: object) => {
    const body = JSON.stringify({ id: `evt_${++n}`, object: "event", type, livemode: true, created: now(), data: { object } });
    const t = now();
    await send(conn, body, { "Stripe-Signature": `t=${t},v1=${bytesToHex(await sign("whsec_test", `${t}.${body}`))}` });
  };
  // An Invoice as these API versions send it: no payment_intent, no charge, the subscription under parent.
  const invoice = (id: string, customer = "cus_1", amount = 2900) => ({
    id,
    object: "invoice",
    amount_paid: amount,
    currency: "usd",
    customer,
    billing_reason: "subscription_cycle",
    status: "paid",
    status_transitions: { paid_at: now() - 60 },
    parent: { type: "subscription_details", quote_details: null, subscription_details: { subscription: `sub_${id}`, metadata: {} } },
  });
  // https://docs.stripe.com/api/invoice-payment/object
  const invoicePayment = (id: string, inv: string, pi: string, amount = 2900) => ({
    id,
    object: "invoice_payment",
    amount_paid: amount,
    amount_requested: amount,
    created: now() - 60,
    currency: "usd",
    invoice: inv,
    is_default: true,
    livemode: true,
    payment: { type: "payment_intent", payment_intent: pi },
    status: "paid",
    status_transitions: { canceled_at: null, paid_at: now() - 60 },
  });
  // A Charge names its PaymentIntent and customer, not its invoice.
  const charge = (id: string, pi: string, refunded: number, customer = "cus_1") => ({
    id,
    object: "charge",
    amount: 2900,
    amount_captured: 2900,
    amount_refunded: refunded,
    created: now() - 60,
    currency: "usd",
    customer,
    paid: true,
    payment_intent: pi,
    refunded: refunded === 2900,
    status: "succeeded",
  });
  // A Dispute names the charge and the PaymentIntent, no customer.
  const dispute = (id: string, ch: string, pi: string) => ({ id, object: "dispute", amount: 2900, charge: ch, created: now(), currency: "usd", payment_intent: pi, reason: "fraudulent", status: "needs_response" });

  it("lists invoice_payment.paid among the events to subscribe to", () => {
    expect(PROVIDER_INFO.stripe.events).toContain("invoice_payment.paid");
  });

  it("a dispute finds its invoice through invoice_payment.paid, with no refund before it", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    await stripeSend(conn, "invoice.paid", invoice("in_1"));
    await stripeSend(conn, "invoice_payment.paid", invoicePayment("inpay_1", "in_1", "pi_1"));
    expect(await rows("SELECT id, order_ref FROM payments")).toEqual([{ id: "stripe:charge:in_1", order_ref: "in_1 pi_1" }]);
    expect(await rows("SELECT * FROM payment_links")).toEqual([]);

    await stripeSend(conn, "charge.dispute.created", dispute("dp_1", "ch_1", "pi_1"));
    expect(await rows("SELECT id, parent_id FROM payments WHERE kind = 'dispute'")).toEqual([{ id: "stripe:dispute:dp_1", parent_id: "stripe:charge:in_1" }]);
    expect(asked).toEqual([]);
  });

  it("tells two identical invoices apart, whichever of invoice.paid and invoice_payment.paid came first", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    // Same customer, amount, currency and time: the amount guess could not choose.
    await stripeSend(conn, "invoice_payment.paid", invoicePayment("inpay_1", "in_1", "pi_1"));
    expect(await rows("SELECT charge_ref, ref FROM payment_links")).toEqual([{ charge_ref: "in_1", ref: "pi_1" }]);
    await stripeSend(conn, "invoice.paid", invoice("in_1"));
    await stripeSend(conn, "invoice.paid", invoice("in_2"));
    await stripeSend(conn, "invoice_payment.paid", invoicePayment("inpay_2", "in_2", "pi_2"));
    expect(await rows("SELECT id, order_ref FROM payments ORDER BY id")).toEqual([
      { id: "stripe:charge:in_1", order_ref: "in_1 pi_1" },
      { id: "stripe:charge:in_2", order_ref: "in_2 pi_2" },
    ]);
    expect(await rows("SELECT * FROM payment_links")).toEqual([]);

    await stripeSend(conn, "charge.refunded", charge("ch_2", "pi_2", 1000));
    await stripeSend(conn, "charge.refunded", charge("ch_2", "pi_2", 2900));
    await stripeSend(conn, "charge.dispute.created", dispute("dp_1", "ch_1", "pi_1"));
    expect(await rows("SELECT id, amount_minor, parent_id FROM payments WHERE kind != 'charge' ORDER BY id")).toEqual([
      { id: "stripe:dispute:dp_1", amount_minor: -2900, parent_id: "stripe:charge:in_1" },
      { id: "stripe:refund:ch_2", amount_minor: -2900, parent_id: "stripe:charge:in_2" },
    ]);
  });

  it("refuses to guess between two identical invoices: the refund is stored without a charge", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    await stripeSend(conn, "invoice.paid", invoice("in_1"));
    await stripeSend(conn, "invoice.paid", invoice("in_2"));
    await stripeSend(conn, "charge.refunded", charge("ch_2", "pi_2", 2900));
    expect(await refunds()).toEqual([{ id: "stripe:refund:ch_2", amount_minor: -2900, parent_id: null }]);
    // Neither invoice was taught an id that isn't known to be its own.
    expect(await rows("SELECT order_ref FROM payments WHERE kind = 'charge' ORDER BY id")).toEqual([{ order_ref: "in_1" }, { order_ref: "in_2" }]);

    // The link arrives after all: the same refund reported again finds its invoice.
    await stripeSend(conn, "invoice_payment.paid", invoicePayment("inpay_2", "in_2", "pi_2"));
    await stripeSend(conn, "charge.refunded", charge("ch_2", "pi_2", 2900));
    expect(await refunds()).toEqual([{ id: "stripe:refund:ch_2", amount_minor: -2900, parent_id: "stripe:charge:in_2" }]);
  });

  it("with an API key, asks Stripe for the PaymentIntent's invoice before guessing", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test", apiKey: "rk_test_1" });
    await stripeSend(conn, "invoice.paid", invoice("in_1"));
    await stripeSend(conn, "invoice.paid", invoice("in_2"));
    // GET /v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=pi_2
    api["api.stripe.com/v1/invoice_payments"] = (url) =>
      Response.json({ object: "list", has_more: false, data: url.searchParams.get("payment[payment_intent]") === "pi_2" ? [invoicePayment("inpay_2", "in_2", "pi_2")] : [] });

    await stripeSend(conn, "charge.dispute.created", dispute("dp_2", "ch_2", "pi_2"));
    expect(await rows("SELECT id, parent_id FROM payments WHERE kind = 'dispute'")).toEqual([{ id: "stripe:dispute:dp_2", parent_id: "stripe:charge:in_2" }]);
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]!).searchParams.get("payment[type]")).toBe("payment_intent");
    // The invoice learned the ids: the refund needs neither Stripe nor a guess.
    expect(await env.DB.prepare("SELECT order_ref FROM payments WHERE id = 'stripe:charge:in_2'").first("order_ref")).toBe("in_2 pi_2 ch_2");
    await stripeSend(conn, "charge.refunded", charge("ch_2", "pi_2", 2900));
    expect(await refunds()).toEqual([{ id: "stripe:refund:ch_2", amount_minor: -2900, parent_id: "stripe:charge:in_2" }]);
    expect(asked).toHaveLength(1);

    // Stripe knows no invoice for it and two invoices fit the amount: stored without a charge.
    await stripeSend(conn, "invoice.paid", invoice("in_3"));
    await stripeSend(conn, "charge.refunded", charge("ch_9", "pi_9", 2900));
    expect((await refunds())[1]).toEqual({ id: "stripe:refund:ch_9", amount_minor: -2900, parent_id: null });
  });

  it("still finds the only invoice that fits when Stripe can't be asked", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test", apiKey: "rk_test_1" });
    await stripeSend(conn, "invoice.paid", invoice("in_1"));
    api["api.stripe.com/v1/invoice_payments"] = () => new Response("{}", { status: 403 });
    await stripeSend(conn, "charge.refunded", charge("ch_1", "pi_1", 2900));
    expect(await refunds()).toEqual([{ id: "stripe:refund:ch_1", amount_minor: -2900, parent_id: "stripe:charge:in_1" }]);
  });

  it("imports what paid each invoice, so imported refunds find their invoices", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test", apiKey: "rk_test_1" });
    const list = (data: object[]) => Response.json({ object: "list", has_more: false, data });
    api["api.stripe.com/v1/checkout/sessions"] = () => list([]);
    api["api.stripe.com/v1/invoices"] = () => list([invoice("in_1"), invoice("in_2")]);
    const listed: URL[] = [];
    api["api.stripe.com/v1/invoice_payments"] = (url) => {
      listed.push(url);
      // An open one (a payment attempt still pending) names no money that came in.
      return list([invoicePayment("inpay_1", "in_1", "pi_1"), invoicePayment("inpay_2", "in_2", "pi_2"), { ...invoicePayment("inpay_3", "in_1", "pi_open"), status: "open" }]);
    };
    api["api.stripe.com/v1/charges"] = () => list([charge("ch_1", "pi_1", 0), charge("ch_2", "pi_2", 2900)]);
    let page = await importPast(site, conn);
    while (page.next) {
      const res = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30, cursor: page.next }));
      page = await res.json();
    }
    expect(await refunds()).toEqual([{ id: "stripe:refund:ch_2", amount_minor: -2900, parent_id: "stripe:charge:in_2" }]);
    // No status filter: only newer API versions know it, and an older one would refuse the whole list.
    expect(listed.length).toBeGreaterThan(0);
    for (const url of listed) expect(url.searchParams.has("status")).toBe(false);
    expect(await env.DB.prepare("SELECT order_ref FROM payments WHERE id = 'stripe:charge:in_1'").first("order_ref")).not.toContain("pi_open");
  });

  it("imports the rest when the account has no invoice payments list", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test", apiKey: "rk_test_1" });
    const list = (data: object[]) => Response.json({ object: "list", has_more: false, data });
    api["api.stripe.com/v1/checkout/sessions"] = () => list([]);
    // An older API version: the invoice names its PaymentIntent itself.
    api["api.stripe.com/v1/invoices"] = () => list([{ ...invoice("in_1"), payment_intent: "pi_1", charge: "ch_1" }]);
    api["api.stripe.com/v1/invoice_payments"] = () => new Response('{"error":{"message":"Unrecognized request URL"}}', { status: 404 });
    api["api.stripe.com/v1/charges"] = () => list([{ ...charge("ch_1", "pi_1", 500), invoice: "in_1" }]);
    let page = await importPast(site, conn);
    while (page.next) {
      const res = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30, cursor: page.next }));
      expect(res.status).toBe(200);
      page = await res.json();
    }
    expect(await refunds()).toEqual([{ id: "stripe:refund:ch_1", amount_minor: -500, parent_id: "stripe:charge:in_1" }]);
  });

  it("stops the import when Stripe rejects a parameter of the invoice payments list, instead of skipping it", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test", apiKey: "rk_test_1" });
    const list = (data: object[]) => Response.json({ object: "list", has_more: false, data });
    api["api.stripe.com/v1/checkout/sessions"] = () => list([]);
    api["api.stripe.com/v1/invoices"] = () => list([invoice("in_1")]);
    api["api.stripe.com/v1/invoice_payments"] = () =>
      Response.json({ error: { code: "parameter_unknown", doc_url: "https://stripe.com/docs/error-codes/parameter-unknown", message: "Received unknown parameter: created", param: "created", type: "invalid_request_error" } }, { status: 400 });
    api["api.stripe.com/v1/charges"] = () => list([]);
    let res = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30 }));
    let page = await res.json<{ next: string | null; error?: string }>();
    while (res.status === 200 && page.next) {
      res = await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30, cursor: page.next }));
      page = await res.json();
    }
    expect(res.status).toBe(502);
    expect(page.error).toContain("parameter_unknown");
  });

  it("erases a refund stored before its charge was found when it joins an erased charge", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "stripe", webhookSecret: "whsec_test" });
    await stripeSend(conn, "invoice.paid", invoice("in_1"));
    await stripeSend(conn, "invoice.paid", invoice("in_2"));
    // Its customer isn't the invoice's, so erasing the invoice's person doesn't reach it.
    await stripeSend(conn, "charge.refunded", charge("ch_2", "pi_2", 2900, "cus_other"));
    expect(await rows("SELECT parent_id, customer_id FROM payments WHERE kind = 'refund'")).toEqual([{ parent_id: null, customer_id: "cus_other" }]);
    const erased = await call(`${API}/sites/${site.id}/privacy/erase`, json({ paymentId: "stripe:charge:in_2", confirm: true }));
    expect(erased.status).toBe(200);

    await stripeSend(conn, "invoice_payment.paid", invoicePayment("inpay_2", "in_2", "pi_2"));
    await stripeSend(conn, "charge.refunded", charge("ch_2", "pi_2", 2900, "cus_other"));
    expect(await rows("SELECT parent_id, customer_id, email, ref, personal_cleared_at IS NOT NULL AS cleared FROM payments WHERE kind = 'refund'")).toEqual([
      { parent_id: "stripe:charge:in_2", customer_id: null, email: null, ref: null, cleared: 1 },
    ]);
  });
});

describe("Creem: refund.created", () => {
  const creemSend = async (conn: ConnectionDTO, body: object) => {
    const text = JSON.stringify(body);
    await send(conn, text, { "creem-signature": bytesToHex(await sign("creem_secret", text)) });
  };
  const checkout = { id: "evt_co", eventType: "checkout.completed", created_at: Date.now(), object: { id: "ch_1", object: "checkout", customer: { id: "cust_1" }, order: { id: "ord_1", transaction: "tran_1", amount: 1900, amount_paid: 1900, currency: "EUR", status: "paid" }, status: "completed", mode: "live" } };
  // TransactionEntity; refunded_amount is optional.
  const transaction = (refunded: number | null) => ({
    id: "tran_1",
    mode: "live",
    object: "transaction",
    amount: 1900,
    amount_paid: 1900,
    currency: "EUR",
    type: "payment",
    status: refunded === 1900 ? "refunded" : refunded ? "partialRefund" : "paid",
    ...(refunded === null ? {} : { refunded_amount: refunded }),
    order: "ord_1",
    customer: "cust_1",
    created_at: Date.now() - 3600_000,
  });
  // WebhookRefundCreatedEventEntity wrapping a RefundEntity.
  const refund = (id: string, amount: number, total: number | null, extra: Record<string, unknown> = {}) => ({
    id: `evt_${id}_${Date.now()}`,
    eventType: "refund.created",
    created_at: Date.now(),
    object: { id, mode: "live", object: "refund", status: "succeeded", refund_amount: amount, refund_currency: "EUR", reason: "requested_by_customer", transaction: transaction(total), order: { id: "ord_1", object: "order" }, customer: "cust_1", created_at: Date.now(), ...extra },
  });
  const listing = (refunded: number) => () => Response.json({ items: [transaction(refunded)], pagination: { total_records: 1, total_pages: 1, current_page: 1, next_page: null, prev_page: null } });
  const one = (amount: number) => [{ id: "creem:refund:tran_1", amount_minor: -amount, parent_id: "creem:charge:tran_1" }];

  it("sums a partial refund and the next under the transaction, and the import agrees on that row", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "creem", webhookSecret: "creem_secret", apiKey: "creem_key" });
    await creemSend(conn, checkout);
    await creemSend(conn, refund("ref_1", 500, 500));
    expect(await refunds()).toEqual(one(500));
    await creemSend(conn, refund("ref_2", 400, 900));
    expect(await refunds()).toEqual(one(900));
    // Nothing was missing from the events: the API wasn't asked.
    expect(asked).toEqual([]);

    api["creem.io/v1/transactions/search"] = listing(900);
    await importPast(site, conn);
    expect(await refunds()).toEqual(one(900));
    // And the other way round: the webhook's total after the import's.
    await creemSend(conn, refund("ref_3", 1000, 1900));
    expect(await refunds()).toEqual(one(1900));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM payments WHERE kind = 'charge'").first("n")).toBe(1);
  });

  it("without a total or a key, counts each refund once however webhook and import interleave", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T10:00:00Z"));
    const site = await createSite();
    const conn = await addConnection(site, { provider: "creem", webhookSecret: "creem_secret" });
    await creemSend(conn, checkout);
    const first = refund("ref_1", 500, null);
    await creemSend(conn, first);
    vi.setSystemTime(new Date("2026-06-01T10:05:00Z"));
    // Only the transaction's id this time.
    await creemSend(conn, refund("ref_2", 400, null, { transaction: "tran_1" }));
    expect(await refunds()).toEqual([
      { id: "creem:refund:ref_1", amount_minor: -500, parent_id: "creem:charge:tran_1" },
      { id: "creem:refund:ref_2", amount_minor: -400, parent_id: "creem:charge:tran_1" },
    ]);

    // A key is added and past payments imported: the transaction's total takes their place.
    await call(`${API}/sites/${site.id}/connections/${conn.id}`, { ...json({ apiKey: "creem_key" }), method: "PATCH" });
    vi.setSystemTime(new Date("2026-06-01T10:10:00Z"));
    api["creem.io/v1/transactions/search"] = listing(900);
    await importPast(site, conn);
    expect(await refunds()).toEqual(one(900));

    // The first refund delivered again under a new event id, with the key gone again: it is inside the total.
    await env.DB.prepare("UPDATE payment_connections SET api_key = NULL, api_key_ref = NULL").run();
    await creemSend(conn, { ...first, id: "evt_again" });
    expect(await refunds()).toEqual(one(900));

    // A refund made after the import is not: it is added.
    vi.setSystemTime(new Date("2026-06-01T10:20:00Z"));
    await creemSend(conn, refund("ref_3", 300, null));
    expect(await env.DB.prepare("SELECT SUM(amount_minor) AS n FROM payments WHERE kind = 'refund'").first("n")).toBe(-1200);
  });

  it("with a key, reads the transaction's total when the event has none", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "creem", webhookSecret: "creem_secret", apiKey: "creem_key" });
    await creemSend(conn, checkout);
    await creemSend(conn, refund("ref_1", 500, null));
    // The API was offline: the refund stands alone for now.
    expect(await refunds()).toEqual([{ id: "creem:refund:ref_1", amount_minor: -500, parent_id: "creem:charge:tran_1" }]);

    api["creem.io/v1/transactions?transaction_id=tran_1"] = () => Response.json(transaction(900));
    await creemSend(conn, refund("ref_2", 400, null));
    expect(await refunds()).toEqual(one(900));
  });

  it("ignores a refund that failed", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "creem", webhookSecret: "creem_secret" });
    await creemSend(conn, checkout);
    await creemSend(conn, refund("ref_1", 500, 0, { status: "failed" }));
    expect(await refunds()).toEqual([]);
  });
});

describe("Lemon Squeezy: refunds of a subscription's first payment", () => {
  const lsSend = async (conn: ConnectionDTO, event: string, data: object) => {
    const text = JSON.stringify({ meta: { test_mode: false, event_name: event }, data });
    await send(conn, text, { "X-Signature": bytesToHex(await sign("my-ls-secret", text)) });
  };
  const order = (refunded: number) => ({
    type: "orders",
    id: "77",
    attributes: { store_id: 1, customer_id: 5, identifier: "104e18a2-d755-4d4b-80c4-a6c1dcbe1c10", order_number: 1, user_email: "buyer@example.com", currency: "USD", total: 1200, refunded_amount: refunded, status: refunded === 1200 ? "refunded" : "paid", refunded: refunded > 0, refunded_at: refunded ? "2026-06-02T10:00:00.000000Z" : null, first_order_item: { product_id: 9, variant_id: 11 }, created_at: "2026-06-01T10:00:00.000000Z", updated_at: "2026-06-02T10:00:00.000000Z", test_mode: false },
  });
  // A Subscription names its order; https://docs.lemonsqueezy.com/api/subscriptions/the-subscription-object
  const subscription = (status = "active") => ({
    type: "subscriptions",
    id: "300",
    attributes: { store_id: 1, customer_id: 5, order_id: 77, order_item_id: 1, product_id: 9, variant_id: 11, user_email: "buyer@example.com", status, cancelled: status !== "active", created_at: "2026-06-01T10:00:01.000000Z", updated_at: "2026-06-02T10:00:00.000000Z", ends_at: null, test_mode: false },
  });
  // A Subscription Invoice names its subscription, never an order.
  const invoice = (id: string, reason: "initial" | "renewal" | "updated", refunded: number, status = refunded ? "refunded" : "paid") => ({
    type: "subscription-invoices",
    id,
    attributes: { store_id: 1, subscription_id: 300, customer_id: 5, user_email: "buyer@example.com", billing_reason: reason, currency: "USD", status, refunded: refunded > 0, refunded_at: refunded ? "2026-06-02T10:00:00.000000Z" : null, total: 1200, refunded_amount: refunded, created_at: "2026-06-01T10:00:02.000000Z", updated_at: "2026-06-02T10:00:00.000000Z", test_mode: false },
  });
  const orderRefund = (amount: number) => [{ id: "lemonsqueezy:refund:order:77", amount_minor: -amount, parent_id: "lemonsqueezy:charge:order:77" }];

  it("marks the first order once: later subscription events don't scan the payments again", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "lemonsqueezy", webhookSecret: "my-ls-secret" });
    await lsSend(conn, "order_created", order(0));
    await lsSend(conn, "subscription_created", subscription());
    expect(await rows("SELECT billing, subscription_id FROM payments")).toEqual([{ billing: "sub_new", subscription_id: "300" }]);

    const statements: string[] = [];
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await storeSubscription(db, site, "lemonsqueezy", { providerId: "300", status: "past_due", customerId: "5", firstOrderRef: "order:77" });
    expect(statements.filter((q) => /^\s*UPDATE payments/.test(q) || q.includes("parent_id IS NULL"))).toEqual([]);
    expect(await env.DB.prepare("SELECT status FROM subscriptions WHERE id = 'lemonsqueezy:300'").first("status")).toBe("past_due");
  });

  it("counts a refund reported by order_refunded and subscription_payment_refunded once, in either order", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "lemonsqueezy", webhookSecret: "my-ls-secret" });
    await lsSend(conn, "order_created", order(0));
    await lsSend(conn, "subscription_created", subscription());
    await lsSend(conn, "subscription_payment_success", invoice("500", "initial", 0));
    expect(await rows("SELECT id, billing, subscription_id FROM payments")).toEqual([{ id: "lemonsqueezy:charge:order:77", billing: "sub_new", subscription_id: "300" }]);

    await lsSend(conn, "order_refunded", order(400));
    await lsSend(conn, "subscription_payment_refunded", invoice("500", "initial", 400, "paid"));
    expect(await refunds()).toEqual(orderRefund(400));
    // The rest is refunded; the invoice's event comes first this time.
    await lsSend(conn, "subscription_payment_refunded", invoice("500", "initial", 1200));
    await lsSend(conn, "order_refunded", order(1200));
    expect(await refunds()).toEqual(orderRefund(1200));
  });

  it("joins the two once a subscription event names the order, when none had before the refund", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "lemonsqueezy", webhookSecret: "my-ls-secret" });
    // The order was stored (say, imported) without its subscription_created.
    await lsSend(conn, "order_created", order(0));
    await lsSend(conn, "subscription_payment_refunded", invoice("500", "initial", 1200));
    await lsSend(conn, "order_refunded", order(1200));
    expect(await refunds()).toEqual([
      { id: "lemonsqueezy:refund:invoice:500", amount_minor: -1200, parent_id: null },
      { id: "lemonsqueezy:refund:order:77", amount_minor: -1200, parent_id: "lemonsqueezy:charge:order:77" },
    ]);

    await lsSend(conn, "subscription_updated", subscription("cancelled"));
    expect(await refunds()).toEqual(orderRefund(1200));
  });

  it("adopts a waiting refund as the order's when order_refunded never comes", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "lemonsqueezy", webhookSecret: "my-ls-secret" });
    await lsSend(conn, "order_created", order(0));
    await lsSend(conn, "subscription_payment_refunded", invoice("500", "initial", 700, "paid"));
    await lsSend(conn, "subscription_updated", subscription());
    expect(await refunds()).toEqual(orderRefund(700));
    // The next total replaces it.
    await lsSend(conn, "subscription_payment_refunded", invoice("500", "initial", 1200));
    expect(await refunds()).toEqual(orderRefund(1200));
  });

  it("with an API key, reads the subscription's order when no event has named it", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "lemonsqueezy", webhookSecret: "my-ls-secret", apiKey: "ls_key" });
    await lsSend(conn, "order_created", order(0));
    api["api.lemonsqueezy.com/v1/subscriptions/300"] = () => Response.json({ data: subscription() });
    await lsSend(conn, "subscription_payment_refunded", invoice("500", "initial", 1200));
    await lsSend(conn, "order_refunded", order(1200));
    expect(await refunds()).toEqual(orderRefund(1200));
    expect(asked).toHaveLength(1);
  });

  it("keeps a renewal's refund on the renewal, and reads no subscription out of an invoice event", async () => {
    const site = await createSite();
    const conn = await addConnection(site, { provider: "lemonsqueezy", webhookSecret: "my-ls-secret" });
    await lsSend(conn, "order_created", order(0));
    await lsSend(conn, "subscription_created", subscription());
    await lsSend(conn, "subscription_payment_success", invoice("501", "renewal", 0));
    await lsSend(conn, "subscription_payment_failed", invoice("502", "renewal", 0, "pending"));
    await lsSend(conn, "subscription_payment_refunded", invoice("501", "renewal", 300, "paid"));
    expect(await refunds()).toEqual([{ id: "lemonsqueezy:refund:invoice:501", amount_minor: -300, parent_id: "lemonsqueezy:charge:invoice:501" }]);
    expect(await rows("SELECT id FROM subscriptions")).toEqual([{ id: "lemonsqueezy:300" }]);
  });
});

// Paddle Billing. Signature: Paddle-Signature "ts=<unix>;h1=<hex>[;h1=…]",
// HMAC-SHA256 of "<ts>:<body>" keyed with the destination's secret as text.
//
// transaction.completed is every payment (origin tells a renewal apart);
// adjustment.* carries refunds and chargebacks, counted once approved;
// subscription.* keeps the subscription state. Paddle doesn't put the
// customer's email in the webhook: with an API key it's looked up.

import type { NormalizedEvent, NormalizedSubscription, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { bytesToHex, hexToBytes, hmacKey, sign, TOLERANCE_SEC, verifyAny } from "../crypto";
import { apiCheck, TEST_BODY, testContext } from "./check";
import { arr, compact, currency, email, num, obj, parseJson, sec, str, visitRef } from "../read";

const SUB_STATUS: Record<string, NormalizedSubscription["status"]> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  paused: "past_due",
  canceled: "canceled",
};

const INTERVALS = new Set(["day", "week", "month", "year"]);

/** The customer's email through the API (sandbox keys go to the sandbox). */
async function customerEmail(apiKey: string, customerId: string): Promise<string | null> {
  const base = apiKey.includes("_sdbx_") ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
  try {
    const res = await fetch(`${base}/customers/${encodeURIComponent(customerId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return email(obj(obj(await res.json()).data).email);
  } catch {
    return null;
  }
}

export const paddle: ProviderAdapter = {
  provider: "paddle",

  async testSignature(secret, settings) {
    const ts = Math.floor(Date.now() / 1000);
    const h1 = bytesToHex(await sign(secret, `${ts}:${TEST_BODY}`));
    return this.verify(new Headers({ "Paddle-Signature": `ts=${ts};h1=${h1}` }), TEST_BODY, secret, ts, testContext(settings));
  },

  testApiKey: (key) => apiCheck(`${key.includes("_sdbx_") ? "https://sandbox-api.paddle.com" : "https://api.paddle.com"}/event-types`, { Authorization: `Bearer ${key}` }),

  async verify(headers, body, secret, now) {
    if (!secret) return "No signing secret";
    const header = headers.get("Paddle-Signature");
    if (!header) return "Missing Paddle-Signature header";
    let ts = 0;
    const sigs: string[] = [];
    for (const part of header.split(";")) {
      const [k, v] = part.split("=", 2);
      if (k?.trim() === "ts") ts = Number(v);
      else if (k?.trim() === "h1" && v) sigs.push(v.trim());
    }
    if (!ts || !sigs.length) return "Malformed Paddle-Signature header";
    if (Math.abs(now - ts) > TOLERANCE_SEC) return "Signature timestamp is too old";
    const ok = await verifyAny(await hmacKey(secret), `${ts}:${body}`, sigs.map(hexToBytes));
    return ok ? null : "Signature doesn't match the secret key";
  },

  async parse(body, _headers, ctx) {
    const evt = parseJson(body);
    const type = str(evt.event_type) ?? "";
    const out: NormalizedEvent = emptyEvent(str(evt.event_id) ?? str(evt.notification_id) ?? "", type);
    const d = obj(evt.data);
    const at = sec(evt.occurred_at) ?? Math.floor(Date.now() / 1000);

    if (type === "transaction.completed") {
      const totals = obj(obj(d.details).totals);
      const sub = str(d.subscription_id);
      const origin = str(d.origin);
      const customerId = str(d.customer_id);
      out.payments.push({
        kind: "charge",
        providerId: str(d.id) ?? "",
        occurredAt: sec(d.billed_at) ?? sec(d.updated_at) ?? at,
        amountMinor: num(totals.grand_total) ?? num(totals.total) ?? 0,
        currency: currency(d.currency_code) ?? currency(totals.currency_code) ?? "USD",
        billing: !sub ? "one_time" : origin === "subscription_recurring" ? "sub_renewal" : origin === "web" || origin === "api" ? "sub_new" : null,
        customerId,
        email: ctx.apiKey && customerId ? await customerEmail(ctx.apiKey, customerId) : null,
        subscriptionId: sub,
        refs: compact([str(d.id), str(d.invoice_id), str(d.checkout && obj(d.checkout).id)]),
        ref: visitRef(d.custom_data),
        productIds: compact(arr(d.items).map((i) => str(obj(obj(i).price).product_id))),
        testMode: false,
      });
      return out;
    }

    if (type === "adjustment.created" || type === "adjustment.updated") {
      if (str(d.status) !== "approved") return out;
      const action = str(d.action);
      const kind = action === "refund" ? "refund" : action === "chargeback" ? "dispute" : action === "chargeback_reverse" ? "dispute_won" : null;
      if (!kind) return out;
      const totals = obj(d.totals);
      out.payments.push({
        kind,
        providerId: str(d.id) ?? "",
        occurredAt: sec(d.updated_at) ?? at,
        amountMinor: Math.abs(num(totals.total) ?? 0),
        currency: currency(d.currency_code) ?? currency(totals.currency_code) ?? "USD",
        billing: null,
        customerId: str(d.customer_id),
        subscriptionId: str(d.subscription_id),
        refs: [],
        parentRef: str(d.transaction_id),
        productIds: [],
        testMode: false,
      });
      return out;
    }

    if (type.startsWith("subscription.")) {
      const item = obj(arr(d.items)[0]);
      const price = obj(item.price);
      const unitPrice = obj(price.unit_price);
      const cycle = obj(d.billing_cycle);
      const unit = str(cycle.interval);
      const status = SUB_STATUS[str(d.status) ?? ""] ?? "active";
      out.subscriptions.push({
        providerId: str(d.id) ?? "",
        status,
        customerId: str(d.customer_id),
        intervalUnit: unit && INTERVALS.has(unit) ? (unit as "day" | "week" | "month" | "year") : null,
        intervalCount: num(cycle.frequency) ?? 1,
        amountMinor: num(unitPrice.amount) === null ? null : num(unitPrice.amount)! * (num(item.quantity) ?? 1),
        currency: currency(d.currency_code) ?? currency(unitPrice.currency_code),
        startedAt: sec(d.started_at) ?? sec(d.created_at),
        canceledAt: sec(d.canceled_at),
        endedAt: status === "canceled" ? sec(d.canceled_at) : null,
      });
    }
    return out;
  },
};

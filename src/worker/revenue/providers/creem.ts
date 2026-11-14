// Creem. Signature: creem-signature, hex HMAC-SHA256 of the body keyed with
// the webhook secret. No signed timestamp: replays are stopped by
// de-duplicating on the event id.
//
// checkout.completed is the first payment; subscription.paid is each payment
// of a subscription (the first one too, which is recognised by its
// transaction id and counted once); refund.created and dispute.created take
// money back.
//
// A refund (id, refund_amount, refund_currency, status) carries its
// transaction, whose refunded_amount is the total refunded so far. That total
// is stored once per transaction: the row the import of past payments writes
// from the same field, so a refund seen by both is counted once, and a second
// partial refund replaces the total. refunded_amount is optional: without it
// (or with only the transaction's id) the transaction is read through the API
// when there is a key; failing that the refund is stored on its own, and a
// total read later takes its place while one read earlier does not hide it.
//
// Metadata from checkout (?metadata[sh_ref]=) is on the checkout and repeated
// on the subscription.

import type { NormalizedEvent, NormalizedSubscription, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { bytesToHex, hexToBytes, hmacKey, sign, verifyAny } from "../crypto";
import { apiCheck, TEST_BODY, testContext } from "./check";
import { compact, currency, email, idOf, num, obj, parseJson, sec, str, visitRef, type Obj } from "../read";

const SUB_STATUS: Record<string, NormalizedSubscription["status"]> = {
  active: "active",
  trialing: "trialing",
  paid: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "past_due",
  scheduled_cancel: "active",
  canceled: "canceled",
  expired: "ended",
};

const PERIODS: Record<string, { unit: "month" | "year"; count: number }> = {
  "every-month": { unit: "month", count: 1 },
  "every-three-months": { unit: "month", count: 3 },
  "every-six-months": { unit: "month", count: 6 },
  "every-year": { unit: "year", count: 1 },
};

/** A transaction's amounts, when the webhook doesn't carry them. */
async function transactionAmount(apiKey: string, transactionId: string, test: boolean): Promise<{ amount: number; currency: string; refunded: number | null } | null> {
  const base = test ? "https://test-api.creem.io" : "https://api.creem.io";
  try {
    const res = await fetch(`${base}/v1/transactions?transaction_id=${encodeURIComponent(transactionId)}`, {
      headers: { "x-api-key": apiKey },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const t = obj(await res.json());
    const amount = num(t.amount_paid) ?? num(t.amount);
    const cur = currency(t.currency);
    return amount !== null && cur ? { amount, currency: cur, refunded: num(t.refunded_amount) } : null;
  } catch {
    return null;
  }
}

function productId(o: Obj): string | null {
  return idOf(o.product) ?? str(obj(o.order).product);
}

export const creem: ProviderAdapter = {
  provider: "creem",

  async testSignature(secret, settings) {
    const sig = bytesToHex(await sign(secret, TEST_BODY));
    return this.verify(new Headers({ "creem-signature": sig }), TEST_BODY, secret, 0, testContext(settings));
  },

  testApiKey: (key, settings) => apiCheck(`${settings.test ? "https://test-api.creem.io" : "https://api.creem.io"}/v1/transactions/search?page_size=1`, { "x-api-key": key }),

  async verify(headers, body, secret) {
    if (!secret) return "No signing secret";
    const sig = headers.get("creem-signature");
    if (!sig) return "Missing creem-signature header";
    const ok = await verifyAny(await hmacKey(secret), body, [hexToBytes(sig.trim())]);
    return ok ? null : "Signature doesn't match the webhook secret";
  },

  async parse(body, _headers, ctx) {
    const evt = parseJson(body);
    const type = str(evt.eventType) ?? str(evt.event_type) ?? "";
    const out: NormalizedEvent = emptyEvent(str(evt.id) ?? "", type);
    const o = obj(evt.object);
    const at = sec(evt.created_at) ?? Math.floor(Date.now() / 1000);
    const testMode = o.mode === "test";
    const customer = obj(o.customer);

    if (type === "checkout.completed") {
      const order = obj(o.order);
      const sub = idOf(o.subscription);
      out.payments.push({
        kind: "charge",
        providerId: str(order.transaction) ?? str(order.id) ?? str(o.id) ?? "",
        occurredAt: sec(order.created_at) ?? at,
        amountMinor: num(order.amount_paid) ?? num(order.amount) ?? 0,
        currency: currency(order.currency) ?? "USD",
        billing: sub ? "sub_new" : "one_time",
        customerId: idOf(o.customer),
        email: email(customer.email),
        subscriptionId: sub,
        refs: compact([str(order.id), str(order.transaction), str(o.id), str(o.request_id)]),
        ref: visitRef(o.metadata, obj(o.subscription).metadata),
        productIds: compact([productId(o)]),
        testMode,
      });
      return out;
    }

    if (type === "subscription.paid") {
      const txn = str(o.last_transaction_id);
      const product = obj(o.product);
      let amount = num(product.price);
      let cur = currency(product.currency);
      if (ctx.apiKey && txn) {
        const exact = await transactionAmount(ctx.apiKey, txn, testMode);
        if (exact) {
          amount = exact.amount;
          cur = exact.currency;
        }
      }
      out.payments.push({
        kind: "charge",
        providerId: txn ?? `${str(o.id)}:${sec(o.current_period_start_date) ?? at}`,
        occurredAt: sec(o.last_transaction_date) ?? at,
        amountMinor: amount ?? 0,
        currency: cur ?? "USD",
        billing: null,
        customerId: idOf(o.customer),
        email: email(customer.email),
        subscriptionId: str(o.id),
        refs: compact([txn]),
        ref: visitRef(o.metadata),
        productIds: compact([idOf(o.product)]),
        testMode,
      });
      return out;
    }

    if (type === "refund.created") {
      // A refund that didn't go through takes nothing back.
      const status = str(o.status);
      if (status === "failed" || status === "canceled") return out;
      const txn = idOf(o.transaction);
      const refundedAt = sec(o.created_at) ?? at;
      const cur = currency(o.refund_currency) ?? currency(obj(o.transaction).currency) ?? "USD";
      const parentRefs = compact([idOf(o.order), str(obj(o.transaction).order)]);
      // The transaction's running total, as of this refund.
      let total = num(obj(o.transaction).refunded_amount);
      let totalAt = refundedAt;
      if (!(total !== null && total > 0) && txn && ctx.apiKey) {
        const readAt = Math.floor(Date.now() / 1000);
        total = (await transactionAmount(ctx.apiKey, txn, testMode))?.refunded ?? null;
        totalAt = readAt;
      }
      if (txn && total !== null && total > 0) {
        out.payments.push({ kind: "refund", providerId: txn, occurredAt: refundedAt, amountMinor: total, currency: cur, billing: null, refs: [], parentRef: txn, parentRefs, productIds: [], testMode, cumulative: true, ofParent: true, totalAt });
        return out;
      }
      // No total to be had: this refund alone, under its own id, next to the transaction's others.
      const amount = num(o.refund_amount) ?? 0;
      if (amount <= 0) return out;
      out.payments.push({ kind: "refund", providerId: str(o.id) ?? "", occurredAt: refundedAt, amountMinor: amount, currency: cur, billing: null, refs: [], parentRef: txn ?? parentRefs[0] ?? null, parentRefs, productIds: [], testMode, partOfTotal: true });
      return out;
    }

    if (type === "dispute.created") {
      const txn = idOf(o.transaction);
      out.payments.push({
        kind: "dispute",
        providerId: str(o.id) ?? "",
        occurredAt: sec(o.created_at) ?? at,
        amountMinor: num(o.amount) ?? 0,
        currency: currency(o.currency) ?? "USD",
        billing: null,
        refs: [],
        parentRef: txn ?? idOf(o.order) ?? null,
        parentRefs: compact([idOf(o.order)]),
        productIds: [],
        testMode,
      });
      return out;
    }

    if (type.startsWith("subscription.")) {
      const product = obj(o.product);
      const period = PERIODS[str(product.billing_period) ?? ""];
      const status = SUB_STATUS[str(o.status) ?? type.slice("subscription.".length)] ?? "active";
      out.subscriptions.push({
        providerId: str(o.id) ?? "",
        status,
        customerId: idOf(o.customer),
        intervalUnit: period?.unit ?? null,
        intervalCount: period?.count ?? 1,
        amountMinor: num(product.price),
        currency: currency(product.currency),
        startedAt: sec(o.created_at),
        canceledAt: sec(o.canceled_at),
        endedAt: status === "ended" ? (sec(o.current_period_end_date) ?? at) : null,
      });
    }
    return out;
  },
};

// FastSpring. Signature: X-FS-Signature, base64 HMAC-SHA256 of the raw body
// keyed with the webhook's HMAC secret. One POST can carry several events
// ({ events: [...] }); answering 200 marks them all processed. Amounts are
// decimal major units.
//
// order.completed is a purchase (tags.sh_ref from fastspring.builder.tag);
// subscription.charge.completed each renewal; return.created a refund;
// chargeback.created a dispute; subscription.* the subscription's state.

import { minorFactor } from "../../../shared/sites";
import type { NormalizedEvent, NormalizedPayment, NormalizedSubscription, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { base64ToBytes, bytesToBase64, bytesToHex, hmacKey, sign, verifyAny } from "../crypto";
import { arr, compact, currency, email, num, obj, parseJson, sec, str, visitRef, type Obj } from "../read";
import { apiCheck, TEST_BODY, testContext } from "./check";

export const FASTSPRING_API = "https://api.fastspring.com";

const minor = (v: unknown, cur: string) => Math.round((num(v) ?? 0) * minorFactor(cur));
const idOf = (v: unknown) => (typeof v === "string" ? str(v) : str(obj(v).id));

const SUB_STATUS: Record<string, NormalizedSubscription["status"]> = {
  active: "active",
  trial: "trialing",
  overdue: "past_due",
  canceled: "canceled",
  deactivated: "ended",
};

/** One order (from a webhook or the orders API) as a charge. */
export function orderCharge(d: Obj, live: unknown): NormalizedPayment | null {
  const id = idOf(d.id) ?? str(d.order);
  if (!id) return null;
  const cur = currency(d.currency) ?? "USD";
  const items = arr(d.items).map(obj);
  const sub = items.map((i) => idOf(i.subscription)).find(Boolean) ?? null;
  return {
    kind: "charge",
    providerId: id,
    occurredAt: sec(d.changed) ?? sec(d.created) ?? Math.floor(Date.now() / 1000),
    amountMinor: minor(d.total, cur),
    currency: cur,
    billing: sub ? "sub_new" : "one_time",
    customerId: idOf(d.account),
    email: email(obj(d.customer).email),
    subscriptionId: sub,
    refs: compact([id, str(d.reference)]),
    ref: visitRef(d.tags),
    productIds: compact(items.map((i) => str(i.product))),
    testMode: live === false || d.live === false,
  };
}

export const fastspring: ProviderAdapter = {
  provider: "fastspring",

  async verify(headers, body, secret) {
    if (!secret) return "No HMAC secret";
    const sig = headers.get("X-FS-Signature");
    if (!sig) return "Missing X-FS-Signature header (set the webhook's HMAC SHA256 secret in FastSpring)";
    const ok = await verifyAny(await hmacKey(secret), body, [base64ToBytes(sig.trim())]);
    return ok ? null : "Signature doesn't match the HMAC secret";
  },

  async parse(body) {
    const events = arr(parseJson(body).events).map(obj);
    const ids = events.map((e) => str(e.id) ?? "").sort();
    // Events without ids would all name the same batch, so those batches are told apart by their body.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ids.every(Boolean) ? ids.join(",") : body)));
    const out: NormalizedEvent = emptyEvent(ids.length === 1 ? ids[0]! : `batch:${bytesToHex(digest.slice(0, 12))}`, events.map((e) => str(e.type)).join(",").slice(0, 80));

    for (const e of events) {
      const type = str(e.type) ?? "";
      const d = obj(e.data);
      if (type === "order.completed") {
        const charge = orderCharge(d, e.live);
        if (charge) out.payments.push(charge);
      } else if (type === "subscription.charge.completed") {
        const order = obj(d.order);
        const cur = currency(d.currency) ?? currency(order.currency) ?? "USD";
        const orderId = idOf(d.order);
        out.payments.push({
          kind: "charge",
          providerId: orderId ?? `${idOf(d.subscription)}:${str(e.created)}`,
          occurredAt: sec(e.created) ?? Math.floor(Date.now() / 1000),
          amountMinor: minor(d.total ?? order.total, cur),
          currency: cur,
          billing: "sub_renewal",
          customerId: idOf(d.account),
          subscriptionId: idOf(d.subscription),
          refs: compact([orderId, str(order.reference)]),
          productIds: [],
          testMode: e.live === false,
        });
      } else if (type === "return.created") {
        const cur = currency(d.currency) ?? "USD";
        out.payments.push({
          kind: "refund",
          providerId: idOf(d.return) ?? idOf(d.id) ?? "",
          occurredAt: sec(e.created) ?? Math.floor(Date.now() / 1000),
          amountMinor: minor(d.totalReturn ?? d.total, cur),
          currency: cur,
          billing: null,
          refs: [],
          parentRef: idOf(d.original) ?? str(obj(d.original).reference),
          productIds: [],
          testMode: e.live === false,
        });
      } else if (type === "chargeback.created") {
        const cur = currency(d.currency) ?? "USD";
        out.payments.push({
          kind: "dispute",
          providerId: idOf(d.id) ?? "",
          occurredAt: sec(e.created) ?? Math.floor(Date.now() / 1000),
          amountMinor: minor(d.chargebackAmount, cur),
          currency: cur,
          billing: null,
          refs: [],
          parentRef: idOf(d.order),
          productIds: [],
          testMode: e.live === false,
        });
      } else if (type.startsWith("subscription.")) {
        const unit = (str(d.intervalUnit) ?? "").toLowerCase();
        const state = (str(d.state) ?? "").toLowerCase();
        const cur = currency(d.currency);
        out.subscriptions.push({
          providerId: idOf(d.id) ?? idOf(d.subscription) ?? "",
          status: type === "subscription.deactivated" ? "ended" : type === "subscription.canceled" ? "canceled" : (SUB_STATUS[state] ?? "active"),
          customerId: idOf(d.account),
          intervalUnit: unit === "day" || unit === "week" || unit === "month" || unit === "year" ? unit : null,
          intervalCount: num(d.intervalLength) ?? 1,
          amountMinor: cur ? minor(d.price, cur) : null,
          currency: cur,
          startedAt: sec(d.begin) ?? sec(e.created),
          canceledAt: type === "subscription.canceled" ? (sec(e.created) ?? Math.floor(Date.now() / 1000)) : null,
          endedAt: type === "subscription.deactivated" ? (sec(e.created) ?? Math.floor(Date.now() / 1000)) : null,
        });
      }
    }
    return out;
  },

  async testSignature(secret, settings) {
    const sig = bytesToBase64(await sign(secret, TEST_BODY));
    return this.verify(new Headers({ "X-FS-Signature": sig }), TEST_BODY, secret, 0, testContext(settings));
  },

  testApiKey: (password, settings) => {
    if (!settings.username) return Promise.resolve("Add the API username too");
    return apiCheck(`${FASTSPRING_API}/products`, { Authorization: `Basic ${btoa(`${settings.username}:${password}`)}`, "User-Agent": "shorthop" });
  },
};

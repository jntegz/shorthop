// Lemon Squeezy. Signature: X-Signature, hex HMAC-SHA256 of the body keyed
// with the signing secret you chose. There's no signed timestamp, so replays
// are stopped by de-duplicating on the event (payment_events).
//
// order_created is the first payment (one-time or a subscription's first);
// subscription_payment_success with billing_reason "renewal" (or "updated")
// is each later one. Refunds come as running totals on the order or the
// subscription invoice. custom_data from checkout[custom][sh_ref] is in meta.

import type { NormalizedEvent, NormalizedSubscription, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { bytesToHex, hexToBytes, hmacKey, sign, verifyAny } from "../crypto";
import { apiCheck, TEST_BODY, testContext } from "./check";
import { compact, currency, email, num, obj, parseJson, sec, str, visitRef } from "../read";

const SUB_STATUS: Record<string, NormalizedSubscription["status"]> = {
  on_trial: "trialing",
  active: "active",
  paused: "past_due",
  past_due: "past_due",
  unpaid: "past_due",
  cancelled: "canceled",
  expired: "ended",
};

/** Event id: Lemon Squeezy sends none, so the body's hash stands in (retries resend the same body). */
async function bodyId(body: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).slice(0, 16));
}

export const lemonsqueezy: ProviderAdapter = {
  provider: "lemonsqueezy",

  async testSignature(secret, settings) {
    const sig = bytesToHex(await sign(secret, TEST_BODY));
    return this.verify(new Headers({ "X-Signature": sig }), TEST_BODY, secret, 0, testContext(settings));
  },

  testApiKey: (key) => apiCheck("https://api.lemonsqueezy.com/v1/users/me", { Authorization: `Bearer ${key}`, Accept: "application/vnd.api+json" }),

  async verify(headers, body, secret) {
    if (!secret) return "No signing secret";
    const sig = headers.get("X-Signature");
    if (!sig) return "Missing X-Signature header";
    const ok = await verifyAny(await hmacKey(secret), body, [hexToBytes(sig.trim())]);
    return ok ? null : "Signature doesn't match the signing secret";
  },

  async parse(body) {
    const evt = parseJson(body);
    const meta = obj(evt.meta);
    const type = str(meta.event_name) ?? "";
    const out: NormalizedEvent = emptyEvent(await bodyId(body), type);
    const data = obj(evt.data);
    const a = obj(data.attributes);
    const id = str(data.id) ?? "";
    const testMode = a.test_mode === true || meta.test_mode === true;
    const ref = visitRef(meta.custom_data);

    if (type === "order_created") {
      if (str(a.status) !== "paid") return out;
      const item = obj(a.first_order_item);
      out.payments.push({
        kind: "charge",
        providerId: `order:${id}`,
        occurredAt: sec(a.created_at) ?? Math.floor(Date.now() / 1000),
        amountMinor: num(a.total) ?? 0,
        currency: currency(a.currency) ?? "USD",
        // A subscription_created event may follow and mark it as a subscription's first payment.
        billing: "one_time",
        customerId: str(a.customer_id),
        email: email(a.user_email),
        refs: compact([`order:${id}`, str(a.identifier), str(a.order_number) && `order_number:${str(a.order_number)}`]),
        ref,
        productIds: compact([str(item.product_id), str(item.variant_id)]),
        testMode,
      });
      return out;
    }

    if (type === "subscription_payment_success") {
      const reason = str(a.billing_reason);
      // The first payment is also an order_created; count it once.
      if (reason === "initial") return out;
      out.payments.push({
        kind: "charge",
        providerId: `invoice:${id}`,
        occurredAt: sec(a.created_at) ?? Math.floor(Date.now() / 1000),
        amountMinor: num(a.total) ?? 0,
        currency: currency(a.currency) ?? "USD",
        billing: "sub_renewal",
        customerId: str(a.customer_id),
        email: email(a.user_email),
        subscriptionId: str(a.subscription_id),
        refs: [`invoice:${id}`],
        ref,
        productIds: [],
        testMode,
      });
      return out;
    }

    if (type === "order_refunded" || type === "subscription_payment_refunded") {
      const refunded = num(a.refunded_amount) ?? 0;
      if (refunded <= 0) return out;
      const parent = type === "order_refunded" ? `order:${id}` : `invoice:${id}`;
      out.payments.push({
        kind: "refund",
        providerId: parent,
        occurredAt: sec(a.refunded_at) ?? sec(a.updated_at) ?? Math.floor(Date.now() / 1000),
        amountMinor: refunded,
        currency: currency(a.currency) ?? "USD",
        billing: null,
        customerId: str(a.customer_id),
        refs: [],
        parentRef: parent,
        productIds: [],
        testMode,
        cumulative: true,
      });
      return out;
    }

    if (type.startsWith("subscription_")) {
      const status = SUB_STATUS[str(a.status) ?? ""] ?? "active";
      out.subscriptions.push({
        providerId: id,
        status,
        customerId: str(a.customer_id),
        // Lemon Squeezy's subscription object carries no price or interval; MRR is estimated from its payments.
        intervalUnit: null,
        startedAt: sec(a.created_at),
        canceledAt: status === "canceled" || status === "ended" ? sec(a.updated_at) : null,
        endedAt: sec(a.ends_at) && status === "ended" ? sec(a.ends_at) : null,
        firstOrderRef: type === "subscription_created" && str(a.order_id) ? `order:${str(a.order_id)}` : null,
      });
      if (type === "subscription_created" && ref) out.claims.push({ ref, ids: compact([`order:${str(a.order_id) ?? ""}`, id]) });
    }
    return out;
  },
};

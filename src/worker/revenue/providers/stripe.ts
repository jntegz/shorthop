// Stripe. Signature: Stripe-Signature "t=<unix>,v1=<hex>[,v1=…]", HMAC-SHA256
// of "<t>.<body>" keyed with the endpoint's whsec_ secret as text.
//
// One-time payments come from Checkout (checkout.session.completed once paid,
// or async_payment_succeeded), keyed by their PaymentIntent. Subscription
// payments come from invoice.paid; their checkout only passes the visit
// reference on (as a claim on the subscription). Refunds arrive as a running
// total per charge (charge.refunded), disputes as charge.dispute.*.

import type { Billing, NormalizedEvent, NormalizedSubscription, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { bytesToHex, hexToBytes, hmacKey, sign, TOLERANCE_SEC, verifyAny } from "../crypto";
import { apiCheck, TEST_BODY, testContext } from "./check";
import { arr, compact, currency, email, num, obj, parseJson, sec, str, visitRef, type Obj } from "../read";

const SUB_STATUS: Record<string, NormalizedSubscription["status"]> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  incomplete: "past_due",
  paused: "past_due",
  canceled: "canceled",
  incomplete_expired: "ended",
};

function invoiceSubscription(inv: Obj): string | null {
  return str(inv.subscription) ?? str(obj(obj(inv.parent).subscription_details).subscription) ?? str(obj(inv.subscription_details).subscription);
}

function invoiceMetadata(inv: Obj): unknown[] {
  return [obj(obj(inv.parent).subscription_details).metadata, obj(inv.subscription_details).metadata, inv.metadata];
}

export const stripe: ProviderAdapter = {
  provider: "stripe",

  async testSignature(secret, settings) {
    const t = Math.floor(Date.now() / 1000);
    const sig = bytesToHex(await sign(secret, `${t}.${TEST_BODY}`));
    return this.verify(new Headers({ "Stripe-Signature": `t=${t},v1=${sig}` }), TEST_BODY, secret, t, testContext(settings));
  },

  testApiKey: (key) => apiCheck("https://api.stripe.com/v1/checkout/sessions?limit=1", { Authorization: `Bearer ${key}` }),

  async verify(headers, body, secret, now) {
    if (!secret) return "No signing secret";
    const header = headers.get("Stripe-Signature");
    if (!header) return "Missing Stripe-Signature header";
    let t = 0;
    const sigs: string[] = [];
    for (const part of header.split(",")) {
      const [k, v] = part.split("=", 2);
      if (k?.trim() === "t") t = Number(v);
      else if (k?.trim() === "v1" && v) sigs.push(v.trim());
    }
    if (!t || !sigs.length) return "Malformed Stripe-Signature header";
    if (Math.abs(now - t) > TOLERANCE_SEC) return "Signature timestamp is too old";
    const ok = await verifyAny(await hmacKey(secret), `${t}.${body}`, sigs.map(hexToBytes));
    return ok ? null : "Signature doesn't match the signing secret";
  },

  async parse(body) {
    const evt = parseJson(body);
    const type = str(evt.type) ?? "";
    const out: NormalizedEvent = emptyEvent(str(evt.id) ?? "", type);
    const o = obj(obj(evt.data).object);
    const testMode = evt.livemode === false;
    const at = sec(evt.created) ?? Math.floor(Date.now() / 1000);

    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      const ref = visitRef(o.client_reference_id, o.metadata);
      const customer = str(o.customer);
      if (o.mode === "subscription") {
        // The money comes with invoice.paid; this tells which visit it belongs to.
        if (ref) out.claims.push({ ref, ids: compact([str(o.subscription), str(o.invoice), customer]) });
        return out;
      }
      if (o.payment_status !== "paid") return out;
      const pi = str(o.payment_intent);
      out.payments.push({
        kind: "charge",
        providerId: pi ?? str(o.id) ?? "",
        occurredAt: at,
        amountMinor: num(o.amount_total) ?? 0,
        currency: currency(o.currency) ?? "USD",
        billing: "one_time",
        customerId: customer,
        email: email(obj(o.customer_details).email) ?? email(o.customer_email),
        refs: compact([str(o.id), pi, str(o.invoice)]),
        ref,
        productIds: [],
        testMode,
      });
      return out;
    }

    if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
      const paid = num(o.amount_paid) ?? 0;
      if (paid <= 0) return out;
      const sub = invoiceSubscription(o);
      const reason = str(o.billing_reason);
      const billing: Billing = !sub ? "one_time" : reason === "subscription_create" ? "sub_new" : "sub_renewal";
      out.payments.push({
        kind: "charge",
        providerId: str(o.id) ?? "",
        occurredAt: sec(obj(o.status_transitions).paid_at) ?? at,
        amountMinor: paid,
        currency: currency(o.currency) ?? "USD",
        billing,
        customerId: str(o.customer),
        email: email(o.customer_email),
        subscriptionId: sub,
        refs: compact([str(o.id), str(o.payment_intent), str(o.charge)]),
        ref: visitRef(...invoiceMetadata(o)),
        productIds: compact(arr(obj(o.lines).data).map((l) => str(obj(obj(l).price).product) ?? str(obj(obj(obj(l).pricing).price_details).product))),
        testMode,
      });
      return out;
    }

    if (type === "charge.refunded") {
      const refunded = num(o.amount_refunded) ?? 0;
      if (refunded <= 0) return out;
      out.payments.push({
        kind: "refund",
        providerId: str(o.id) ?? "",
        occurredAt: at,
        amountMinor: refunded,
        currency: currency(o.currency) ?? "USD",
        billing: null,
        customerId: str(o.customer),
        refs: [],
        parentRef: str(o.payment_intent) ?? str(o.invoice) ?? str(o.id),
        productIds: [],
        testMode,
        cumulative: true,
      });
      return out;
    }

    if (type === "charge.dispute.created" || type === "charge.dispute.closed") {
      const won = type === "charge.dispute.closed" && o.status === "won";
      if (type === "charge.dispute.closed" && !won) return out;
      out.payments.push({
        kind: won ? "dispute_won" : "dispute",
        providerId: str(o.id) ?? "",
        occurredAt: at,
        amountMinor: num(o.amount) ?? 0,
        currency: currency(o.currency) ?? "USD",
        billing: null,
        refs: [],
        parentRef: str(o.payment_intent) ?? str(o.charge),
        productIds: [],
        testMode,
      });
      return out;
    }

    if (type.startsWith("customer.subscription.")) {
      const item = obj(arr(obj(o.items).data)[0]);
      const price = obj(item.price);
      const recurring = obj(price.recurring);
      const unit = str(recurring.interval);
      const status = type === "customer.subscription.deleted" ? "canceled" : SUB_STATUS[str(o.status) ?? ""] ?? "active";
      out.subscriptions.push({
        providerId: str(o.id) ?? "",
        status: o.ended_at ? "ended" : status,
        customerId: str(o.customer),
        intervalUnit: unit === "day" || unit === "week" || unit === "month" || unit === "year" ? unit : null,
        intervalCount: num(recurring.interval_count) ?? 1,
        amountMinor: (num(price.unit_amount) ?? 0) * (num(item.quantity) ?? 1),
        currency: currency(price.currency) ?? currency(o.currency),
        startedAt: sec(o.start_date) ?? sec(o.created),
        canceledAt: sec(o.canceled_at),
        endedAt: sec(o.ended_at),
      });
    }
    return out;
  },
};

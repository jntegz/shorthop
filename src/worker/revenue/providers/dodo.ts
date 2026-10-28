// Dodo Payments, which signs with Standard Webhooks: webhook-id,
// webhook-timestamp and webhook-signature ("v1,<base64>" entries, space
// separated), HMAC-SHA256 of "<id>.<timestamp>.<body>" keyed with the
// base64-decoded part of the whsec_ secret.
//
// payment.succeeded is every payment (one-time and each subscription charge);
// refund.succeeded and dispute.* take money back; subscription.* keeps the
// subscription state. Metadata from checkout (?metadata_tl_ref=) rides along.

import type { NormalizedEvent, NormalizedSubscription, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { base64ToBytes, bytesToBase64, hmacKey, sign, TOLERANCE_SEC, verifyAny } from "../crypto";
import { apiCheck, TEST_BODY, testContext } from "./check";
import { arr, compact, currency, email, num, obj, parseJson, sec, str, visitRef } from "../read";

/** Standard Webhooks, shared with any other provider that uses it. */
export async function verifyStandardWebhook(headers: Headers, body: string, secret: string | null, now: number, _ctx?: unknown): Promise<string | null> {
  if (!secret) return "No signing key";
  const id = headers.get("webhook-id");
  const ts = Number(headers.get("webhook-timestamp"));
  const sig = headers.get("webhook-signature");
  if (!id || !ts || !sig) return "Missing webhook-id, webhook-timestamp or webhook-signature header";
  if (Math.abs(now - ts) > TOLERANCE_SEC) return "Signature timestamp is too old";
  const key = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  if (!key?.length) return "The signing secret isn't valid base64 (it should look like whsec_…)";
  const candidates = sig
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => base64ToBytes(s.slice(3)));
  const ok = await verifyAny(await hmacKey(key), `${id}.${ts}.${body}`, candidates);
  return ok ? null : "Signature doesn't match the signing secret";
}

const SUB_STATUS: Record<string, NormalizedSubscription["status"]> = {
  active: "active",
  renewed: "active",
  plan_changed: "active",
  on_hold: "past_due",
  paused: "past_due",
  failed: "past_due",
  cancelled: "canceled",
  expired: "ended",
};

const UNITS: Record<string, "day" | "week" | "month" | "year"> = { day: "day", week: "week", month: "month", year: "year" };

export const dodo: ProviderAdapter = {
  provider: "dodo",

  verify: verifyStandardWebhook,

  async testSignature(secret, settings) {
    const key = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
    if (!key?.length) return "The signing key isn't valid base64 (it should look like whsec_…)";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = bytesToBase64(await sign(key, `msg_check.${ts}.${TEST_BODY}`));
    return verifyStandardWebhook(new Headers({ "webhook-id": "msg_check", "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }), TEST_BODY, secret, Number(ts), testContext(settings));
  },

  testApiKey: (key) => apiCheck("https://live.dodopayments.com/payments?page_size=1", { Authorization: `Bearer ${key}` }),

  async parse(body, headers) {
    const evt = parseJson(body);
    const type = str(evt.type) ?? "";
    const out: NormalizedEvent = emptyEvent(headers.get("webhook-id") ?? "", type);
    const d = obj(evt.data);
    const at = sec(evt.timestamp) ?? Math.floor(Date.now() / 1000);
    const customer = obj(d.customer);

    if (type === "payment.succeeded") {
      const sub = str(d.subscription_id) ?? str(arr(d.subscription_ids)[0]);
      out.payments.push({
        kind: "charge",
        providerId: str(d.payment_id) ?? "",
        occurredAt: sec(d.created_at) ?? at,
        amountMinor: num(d.total_amount) ?? 0,
        currency: currency(d.currency) ?? "USD",
        billing: sub ? null : "one_time",
        customerId: str(customer.customer_id),
        email: email(customer.email),
        subscriptionId: sub,
        refs: compact([str(d.payment_id), str(d.checkout_session_id)]),
        ref: visitRef(d.metadata, customer.metadata),
        productIds: compact(arr(d.product_cart).map((p) => str(obj(p).product_id))),
        testMode: false,
      });
      return out;
    }

    if (type === "refund.succeeded") {
      out.payments.push({
        kind: "refund",
        providerId: str(d.refund_id) ?? "",
        occurredAt: sec(d.created_at) ?? at,
        amountMinor: num(d.amount) ?? 0,
        currency: currency(d.currency) ?? "USD",
        billing: null,
        refs: [],
        parentRef: str(d.payment_id),
        productIds: [],
        testMode: false,
      });
      return out;
    }

    if (type === "dispute.opened" || type === "dispute.won") {
      out.payments.push({
        kind: type === "dispute.won" ? "dispute_won" : "dispute",
        providerId: str(d.dispute_id) ?? "",
        occurredAt: sec(d.created_at) ?? at,
        amountMinor: Math.round(num(d.amount) ?? 0),
        currency: currency(d.currency) ?? "USD",
        billing: null,
        refs: [],
        parentRef: str(d.payment_id),
        productIds: [],
        testMode: false,
      });
      return out;
    }

    if (type.startsWith("subscription.")) {
      const status = SUB_STATUS[str(d.status) ?? type.slice("subscription.".length)] ?? "active";
      const unit = UNITS[(str(d.payment_frequency_interval) ?? "").toLowerCase()] ?? null;
      out.subscriptions.push({
        providerId: str(d.subscription_id) ?? "",
        status,
        customerId: str(customer.customer_id),
        intervalUnit: unit,
        intervalCount: num(d.payment_frequency_count) ?? 1,
        amountMinor: num(d.recurring_pre_tax_amount),
        currency: currency(d.currency),
        startedAt: sec(d.created_at),
        canceledAt: sec(d.cancelled_at),
        endedAt: status === "ended" ? (sec(d.expires_at) ?? at) : null,
      });
    }
    return out;
  },
};

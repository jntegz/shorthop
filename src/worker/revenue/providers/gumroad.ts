// Gumroad. Pings (and API resource subscriptions) are form-encoded and
// unsigned, so the webhook address carries a random token (?token=…) that
// must match, and with an access token each sale is also read back from
// Gumroad's API, as Gumroad recommends. Amounts are always USD cents.
//
// sale: a payment (is_recurring_charge marks renewals); refund, dispute,
// dispute_won: money back and forth; cancellation, subscription_ended: the
// subscription's state. A ?sh_ref= on the product link comes back in
// url_params[sh_ref].

import type { NormalizedEvent, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { compact, email, num, sec, str, visitRef } from "../read";
import { apiCheck } from "./check";

const API = "https://api.gumroad.com/v2";

/** Constant-time string comparison (both sides are short tokens). */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const truthy = (v: string | null) => v === "true" || v === "1";

export const gumroad: ProviderAdapter = {
  provider: "gumroad",

  async verify(_headers, body, secret, _now, ctx) {
    const token = ctx.url.searchParams.get("token");
    if (!secret || !token || !sameToken(token, secret)) return "The token in the webhook address doesn't match";
    // Confirm the sale with Gumroad when we can: a ping alone proves only that the address was known.
    const f = new URLSearchParams(body);
    const saleId = f.get("sale_id");
    if (ctx.apiKey && saleId) {
      const problem = await apiCheck(`${API}/sales/${encodeURIComponent(saleId)}?access_token=${encodeURIComponent(ctx.apiKey)}`, {});
      if (problem) return `Gumroad doesn't know sale ${saleId}: ${problem}`;
    }
    return null;
  },

  async parse(body) {
    const f = new URLSearchParams(body);
    const resource = f.get("resource_name") ?? "sale";
    const saleId = str(f.get("sale_id"));
    const subId = str(f.get("subscription_id"));
    // Gumroad reports every amount in USD cents, whatever the product's currency.
    const price = num(f.get("price")) ?? 0;
    // Each refund ping carries the running total, so a larger one is a new event, not a repeat.
    const out: NormalizedEvent = emptyEvent(`${resource}:${saleId ?? subId ?? ""}${resource === "refund" ? `:${price}` : ""}`, resource);
    const at = sec(f.get("sale_timestamp")) ?? sec(f.get("created_at")) ?? Math.floor(Date.now() / 1000);
    const testMode = truthy(f.get("test"));

    if (resource === "sale" && saleId) {
      out.payments.push({
        kind: "charge",
        providerId: saleId,
        occurredAt: at,
        amountMinor: price,
        currency: "USD",
        billing: subId ? (truthy(f.get("is_recurring_charge")) ? "sub_renewal" : "sub_new") : "one_time",
        customerId: str(f.get("purchaser_id")),
        email: email(f.get("email")),
        subscriptionId: subId,
        refs: compact([saleId, str(f.get("order_number"))]),
        ref: visitRef(f.get("url_params[sh_ref]"), f.get("sh_ref")),
        productIds: compact([str(f.get("product_id")), str(f.get("product_permalink")), str(f.get("short_product_id"))]),
        testMode,
      });
    } else if ((resource === "refund" || resource === "dispute" || resource === "dispute_won") && saleId) {
      out.payments.push({
        kind: resource === "refund" ? "refund" : resource === "dispute" ? "dispute" : "dispute_won",
        providerId: saleId,
        occurredAt: Math.floor(Date.now() / 1000),
        amountMinor: price,
        currency: "USD",
        billing: null,
        refs: [],
        parentRef: saleId,
        productIds: compact([str(f.get("product_id"))]),
        testMode,
        // A later refund ping for the same sale replaces the amount.
        cumulative: resource === "refund",
      });
    } else if ((resource === "cancellation" || resource === "subscription_ended") && subId) {
      out.subscriptions.push({
        providerId: subId,
        status: resource === "subscription_ended" ? "ended" : "canceled",
        customerId: str(f.get("user_id")),
        startedAt: sec(f.get("created_at")),
        canceledAt: sec(f.get("cancelled_at")) ?? Math.floor(Date.now() / 1000),
        endedAt: resource === "subscription_ended" ? (sec(f.get("ended_at")) ?? Math.floor(Date.now() / 1000)) : null,
      });
    }
    return out;
  },

  testApiKey: (key) => apiCheck(`${API}/user?access_token=${encodeURIComponent(key)}`, {}),
};

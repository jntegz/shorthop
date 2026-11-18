// Gumroad. Pings (and API resource subscriptions) are form-encoded and
// unsigned, so the webhook address carries a random token (?token=…) that
// must match. A ping proves only that its sender knew the address. With an
// access token, each sale is therefore read back from Gumroad's API, as
// Gumroad recommends, and what is stored comes from that answer: the ping
// supplies a value only where the API's sale doesn't have the field. Without
// one, its payments are stored marked unverified. Amounts are always USD cents.
//
// Only a clear "this sale doesn't exist" refuses a ping. Gumroad retries a
// failed ping a few times over some minutes at most, so anything less (the API
// is down, rate limited, the token can't read sales, the sale doesn't show a
// refund yet) must not lose the event: it is stored marked unverified, and a
// later delivery or an import that can confirm it replaces it with Gumroad's
// values and clears the mark. Until then an unverified refund or dispute of a
// confirmed sale counts for nothing, and an unconfirmed cancellation leaves the
// subscription as it is (src/worker/revenue/ingest.ts).
//
// sale: a payment (is_recurring_charge marks renewals); refund, dispute,
// dispute_won: money back and forth; cancellation, subscription_ended: the
// subscription's state. A ?sh_ref= on the product link comes back in
// url_params[sh_ref]. The Ping setting sends only sales: the others need API
// resource subscriptions (the setup guide has the command).
//
// A refund ping's price is the sale's price, partial refund or not, and its
// `refunded` is false for a partial one. The amount then comes from the API.
//
// The API's field names here are the ones the import of past sales already
// relies on (src/worker/revenue/backfill.ts). refunded, partially_refunded,
// amount_refundable_in_currency, disputed, chargedback, dispute_won, cancelled,
// ended and currency_symbol are not checked against a live Gumroad account. A ping
// is confirmed only by one of them saying so: a sale without them proves nothing,
// so the event stays unverified, and a partial refund whose size can't be worked
// out is stored as 0 and flagged.

import type { AdapterContext, NormalizedEvent, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { compact, email, num, obj, sec, str, visitRef, type Obj } from "../read";
import { apiCheck } from "./check";

const API = "https://api.gumroad.com/v2";
/** Sales a cancellation is confirmed with, at most: one request each. */
const CONFIRM_SALES = 3;

/** Constant-time string comparison (both sides are short tokens). */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const truthy = (v: string | null) => v === "true" || v === "1";

type SaleAnswer =
  | { sale: Obj }
  /** Gumroad answered that it has no such sale. */
  | { missing: true }
  /** No usable answer, which says nothing about the sale. retry: asking again may help. */
  | { unknown: string; retry: boolean };

/** The sale as Gumroad's API has it, read once per delivery. */
async function readSale(id: string, ctx: AdapterContext): Promise<SaleAnswer> {
  const key = `gumroad:sale:${id}`;
  const known = ctx.memo?.get(key) as SaleAnswer | undefined;
  if (known) return known;
  const url = `${API}/sales/${encodeURIComponent(id)}?access_token=${encodeURIComponent(ctx.apiKey ?? "")}`;
  let answer: SaleAnswer;
  try {
    const res = await fetch(url, { redirect: "manual", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    let body: Obj = {};
    try {
      body = obj(JSON.parse(text));
    } catch {
      // Not JSON: a gateway's page, which says nothing about the sale.
    }
    const sale = obj(body.sale);
    // A bare 404 could come from anything on the way; Gumroad's own carries success: false.
    if (res.status === 404 && body.success === false) answer = { missing: true };
    else if (!res.ok) answer = { unknown: `HTTP ${res.status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 160)}` : ""}`, retry: res.status === 429 || res.status >= 500 };
    else if (!Object.keys(sale).length) answer = { unknown: "its answer holds no sale", retry: false };
    else answer = { sale };
  } catch (err) {
    answer = { unknown: `couldn't reach it (${String(err).slice(0, 120)})`, retry: true };
  }
  ctx.memo?.set(key, answer);
  return answer;
}

/** The fields of a sale that prove each kind of ping, and what the ping claims. */
const PROOF: Record<string, { fields: string[]; claim: string }> = {
  refund: { fields: ["refunded", "partially_refunded"], claim: "a refund" },
  dispute: { fields: ["disputed", "chargedback"], claim: "a dispute" },
  dispute_won: { fields: ["dispute_won"], claim: "a won dispute" },
};

/**
 * Why the sale doesn't back this ping, or null when it does. Only a field saying
 * so counts. A clear "no" may just lag behind the ping, so it is asked again;
 * a sale without the fields can't answer however often it is asked.
 */
function notBacked(resource: string, saleId: string, sale: Obj): { problem: string; retry: boolean } | null {
  const proof = PROOF[resource];
  if (!proof || proof.fields.some((f) => sale[f] === true)) return null;
  return proof.fields.some((f) => sale[f] === false)
    ? { problem: `Gumroad doesn't show ${proof.claim} on sale ${saleId} yet`, retry: true }
    : { problem: `Gumroad's answer says nothing about ${proof.claim} on sale ${saleId}`, retry: false };
}

/** The sale's price in USD cents. A price in another currency can't be stored as those: null, and the ping's amount stays. */
function usdPrice(sale: Obj): number | null {
  const symbol = str(sale.currency_symbol);
  return symbol && symbol !== "$" ? null : num(sale.price);
}

/**
 * How much of a sale has been refunded so far, in USD cents. null: a partial
 * refund, and nothing here says how much.
 */
function refundedCents(f: URLSearchParams, sale: Obj, pingPrice: number): number | null {
  const price = usdPrice(sale);
  if (sale.partially_refunded === true) {
    // What can still be refunded says what already was. It is in the sale's currency, so only for dollars.
    const left = str(sale.currency_symbol) === "$" ? num(sale.amount_refundable_in_currency) : null;
    if (price !== null && left !== null) {
      const refunded = price - Math.round(left * 100);
      if (refunded > 0 && refunded < price) return refunded;
    }
    // A ping naming less than the sale cost is stating the amount.
    return price !== null && pingPrice > 0 && pingPrice < price ? pingPrice : null;
  }
  if (sale.refunded === true) return price ?? pingPrice;
  const flag = f.get("refunded");
  if (flag === "false") return null;
  return flag === null ? pingPrice : (price ?? pingPrice);
}

export const gumroad: ProviderAdapter = {
  provider: "gumroad",

  async verify(_headers, body, secret, _now, ctx) {
    const token = ctx.url.searchParams.get("token");
    if (!secret || !token || !sameToken(token, secret)) return "The token in the webhook address doesn't match";
    // Confirm the sale with Gumroad when we can: a ping alone proves only that the address was known.
    const saleId = str(new URLSearchParams(body).get("sale_id"));
    if (!ctx.apiKey || !saleId) return null;
    const answer = await readSale(saleId, ctx);
    if ("missing" in answer) return `Gumroad has no sale ${saleId}`;
    // Anything short of that is kept and marked (parse).
    const id = "sale" in answer ? str(answer.sale.id) : null;
    return id && id !== saleId ? `Gumroad's sale ${saleId} has another id` : null;
  },

  async parse(body, _headers, ctx) {
    const f = new URLSearchParams(body);
    const resource = f.get("resource_name") ?? "sale";
    const saleId = str(f.get("sale_id"));
    const subId = str(f.get("subscription_id"));
    // Gumroad reports every amount in USD cents, whatever the product's currency.
    const pingPrice = num(f.get("price")) ?? 0;
    const out: NormalizedEvent = emptyEvent(`${resource}:${saleId ?? subId ?? ""}`, resource);
    const at = sec(f.get("sale_timestamp")) ?? sec(f.get("created_at")) ?? Math.floor(Date.now() / 1000);
    const testMode = truthy(f.get("test"));
    const moneyEvent = resource === "sale" || resource === "refund" || resource === "dispute" || resource === "dispute_won";

    // An import's events were read from the API already.
    let sale: Obj = {};
    if (ctx.apiKey && !ctx.fromApi && saleId && moneyEvent) {
      const answer = await readSale(saleId, ctx);
      if ("missing" in answer) throw new Error(`Gumroad has no sale ${saleId}`);
      if ("sale" in answer) {
        sale = answer.sale;
        // Gumroad sends the ping seconds after the change, and its answer can lag behind it.
        const missing = notBacked(resource, saleId, sale);
        if (missing) out.unconfirmed = missing;
      } else {
        out.unconfirmed = { problem: `Couldn't confirm sale ${saleId} with Gumroad: ${answer.unknown}`, retry: answer.retry };
      }
    }
    const unverified = !ctx.apiKey || Boolean(out.unconfirmed);

    if (resource === "sale" && saleId) {
      const subscription = str(sale.subscription_id) ?? subId;
      const apiPrice = usdPrice(sale);
      if (apiPrice !== null && apiPrice !== pingPrice) console.warn(JSON.stringify({ message: "gumroad ping differs from the sale", sale: saleId, field: "price" }));
      out.payments.push({
        kind: "charge",
        providerId: saleId,
        occurredAt: sec(sale.created_at) ?? at,
        amountMinor: apiPrice ?? pingPrice,
        currency: "USD",
        billing: subscription ? (truthy(f.get("is_recurring_charge")) ? "sub_renewal" : "sub_new") : "one_time",
        customerId: str(sale.purchaser_id) ?? str(f.get("purchaser_id")),
        email: email(sale.email) ?? email(f.get("email")),
        subscriptionId: subscription,
        refs: compact([saleId, str(sale.order_id) ?? str(f.get("order_number"))]),
        ref: visitRef(f.get("url_params[sh_ref]"), f.get("sh_ref")),
        productIds: compact([str(sale.product_id) ?? str(f.get("product_id")), str(sale.product_permalink) ?? str(f.get("product_permalink")), str(f.get("short_product_id"))]),
        testMode: typeof sale.test === "boolean" ? sale.test : testMode,
        unverified,
      });
    } else if ((resource === "refund" || resource === "dispute" || resource === "dispute_won") && saleId) {
      const amount = resource === "refund" ? refundedCents(f, sale, pingPrice) : (usdPrice(sale) ?? pingPrice);
      // A larger refund total is a new event, not a repeat.
      if (resource === "refund") out.id = `${out.id}:${amount ?? "unknown"}`;
      out.payments.push({
        kind: resource === "refund" ? "refund" : resource === "dispute" ? "dispute" : "dispute_won",
        providerId: saleId,
        occurredAt: Math.floor(Date.now() / 1000),
        amountMinor: amount ?? 0,
        amountUnknown: amount === null,
        currency: "USD",
        billing: null,
        refs: [],
        parentRef: saleId,
        productIds: compact([str(sale.product_id) ?? str(f.get("product_id"))]),
        testMode,
        unverified,
        // A later refund event for the same sale replaces the amount.
        cumulative: resource === "refund",
      });
    } else if ((resource === "cancellation" || resource === "subscription_ended") && subId) {
      const canceledAt = sec(f.get("cancelled_at"));
      const endedAt = sec(f.get("ended_at"));
      const now = Math.floor(Date.now() / 1000);
      out.subscriptions.push({
        providerId: subId,
        status: resource === "subscription_ended" ? "ended" : "canceled",
        customerId: str(f.get("user_id")),
        startedAt: sec(f.get("created_at")),
        canceledAt: canceledAt ?? now,
        endedAt: resource === "subscription_ended" ? (endedAt ?? now) : null,
        // A ping has no time of its own: these say when it happened, if it came with them.
        eventAt: (resource === "subscription_ended" ? endedAt : null) ?? canceledAt,
        saleRefs: compact([saleId, ...f.getAll("purchase_ids[]").map(str)]),
      });
    }
    return out;
  },

  async confirmEnded(s, saleIds, ctx) {
    let denied = false;
    let retry = false;
    for (const id of saleIds.slice(0, CONFIRM_SALES)) {
      const answer = await readSale(id, ctx);
      if ("unknown" in answer) retry ||= answer.retry;
      if (!("sale" in answer)) continue;
      // Only a sale of this very subscription can speak for it.
      if (str(answer.sale.subscription_id) !== s.providerId) continue;
      if (answer.sale.cancelled === true || answer.sale.ended === true) return true;
      if (answer.sale.cancelled === false || answer.sale.ended === false) denied = true;
    }
    if (denied) return { problem: `Gumroad doesn't show subscription ${s.providerId} as ended yet`, retry: true };
    return { problem: saleIds.length ? `Couldn't confirm with Gumroad that subscription ${s.providerId} ended` : `No sale of subscription ${s.providerId} to confirm its end with`, retry };
  },

  // Reads sales rather than the account: a token without view_sales would pass the other and confirm nothing.
  testApiKey: (key) => apiCheck(`${API}/sales?access_token=${encodeURIComponent(key)}&after=${new Date().toISOString().slice(0, 10)}`, {}),
};

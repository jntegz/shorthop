// PayPal. Webhooks are verified by PayPal itself: the transmission headers
// and the event go to /v1/notifications/verify-webhook-signature with an
// OAuth token from the app's client id and secret, and only SUCCESS passes.
// (Self-verification would mean parsing PayPal's X.509 certificate.)
//
// PAYMENT.CAPTURE.COMPLETED is an order payment (custom_id carries the visit
// reference), PAYMENT.SALE.COMPLETED a subscription payment; *.REFUNDED and
// CUSTOMER.DISPUTE.* take money back; BILLING.SUBSCRIPTION.* the state.
// Amounts are decimal strings.

import { minorFactor } from "../../../shared/sites";
import type { NormalizedEvent, NormalizedSubscription, ProviderAdapter } from "../types";
import { emptyEvent } from "../types";
import { arr, compact, currency, num, obj, parseJson, sec, str, visitRef, type Obj } from "../read";

const base = (settings: Record<string, string>) => (settings.sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com");

const tokens = new Map<string, { token: string; until: number }>();

/** An OAuth access token, cached per isolate until shortly before it expires. */
async function accessToken(clientId: string, secret: string, settings: Record<string, string>): Promise<string> {
  const key = `${base(settings)}|${clientId}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const res = await fetch(`${base(settings)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`PayPal refused the client id and secret (HTTP ${res.status})`);
  const body = obj(await res.json());
  const token = str(body.access_token);
  if (!token) throw new Error("PayPal sent no access token");
  tokens.set(key, { token, until: Date.now() + Math.max(60, (num(body.expires_in) ?? 3600) - 120) * 1000 });
  return token;
}

const money = (amount: Obj) => {
  const cur = currency(amount.currency_code) ?? currency(amount.currency) ?? "USD";
  return { cur, minor: Math.round((num(amount.value) ?? num(amount.total) ?? 0) * minorFactor(cur)) };
};

/** The capture id a refund belongs to, from its "up" link. */
function upId(resource: Obj): string | null {
  const up = arr(resource.links).map(obj).find((l) => l.rel === "up");
  const href = str(up?.href);
  return href ? (href.split("/").pop() ?? null) : null;
}

const SUB_STATUS: Record<string, NormalizedSubscription["status"]> = {
  ACTIVE: "active",
  APPROVED: "active",
  SUSPENDED: "past_due",
  CANCELLED: "canceled",
  EXPIRED: "ended",
};

export const paypal: ProviderAdapter = {
  provider: "paypal",

  async verify(headers, body, _secret, _now, ctx) {
    const { clientId, webhookId } = ctx.settings;
    if (!ctx.apiKey || !clientId || !webhookId) return "Set the client id, client secret and webhook id first";
    const h = (name: string) => headers.get(name) ?? "";
    if (!h("PAYPAL-TRANSMISSION-SIG")) return "Missing PAYPAL-TRANSMISSION-SIG header";
    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      return "Body is not JSON";
    }
    try {
      const token = await accessToken(clientId, ctx.apiKey, ctx.settings);
      const res = await fetch(`${base(ctx.settings)}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          auth_algo: h("PAYPAL-AUTH-ALGO"),
          cert_url: h("PAYPAL-CERT-URL"),
          transmission_id: h("PAYPAL-TRANSMISSION-ID"),
          transmission_sig: h("PAYPAL-TRANSMISSION-SIG"),
          transmission_time: h("PAYPAL-TRANSMISSION-TIME"),
          webhook_id: webhookId,
          webhook_event: event,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return `PayPal couldn't verify it (HTTP ${res.status})`;
      return str(obj(await res.json()).verification_status) === "SUCCESS" ? null : "PayPal says the signature isn't valid for this webhook id";
    } catch (err) {
      return String(err instanceof Error ? err.message : err);
    }
  },

  async parse(body, _headers, ctx) {
    const evt = parseJson(body);
    const type = str(evt.event_type) ?? "";
    const out: NormalizedEvent = emptyEvent(str(evt.id) ?? "", type);
    const r = obj(evt.resource);
    const at = sec(r.create_time) ?? sec(evt.create_time) ?? Math.floor(Date.now() / 1000);
    const testMode = Boolean(ctx.settings.sandbox);

    if (type === "PAYMENT.CAPTURE.COMPLETED" || type === "PAYMENT.SALE.COMPLETED") {
      const { cur, minor } = money(obj(r.amount));
      const sub = str(r.billing_agreement_id);
      out.payments.push({
        kind: "charge",
        providerId: str(r.id) ?? "",
        occurredAt: at,
        amountMinor: minor,
        currency: cur,
        billing: sub ? null : "one_time",
        subscriptionId: sub,
        refs: compact([str(r.id), str(r.invoice_id), str(obj(obj(r.supplementary_data).related_ids).order_id)]),
        ref: visitRef(r.custom_id, r.custom),
        productIds: [],
        testMode,
      });
    } else if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.SALE.REFUNDED") {
      const { cur, minor } = money(obj(r.amount));
      out.payments.push({
        kind: "refund",
        providerId: str(r.id) ?? "",
        occurredAt: at,
        amountMinor: minor,
        currency: cur,
        billing: null,
        refs: [],
        parentRef: str(r.sale_id) ?? upId(r),
        productIds: [],
        testMode,
      });
    } else if (type === "CUSTOMER.DISPUTE.CREATED" || type === "CUSTOMER.DISPUTE.RESOLVED") {
      const won = type === "CUSTOMER.DISPUTE.RESOLVED" && /SELLER_FAVOUR/.test(str(obj(r.dispute_outcome).outcome_code) ?? "");
      if (type === "CUSTOMER.DISPUTE.RESOLVED" && !won) return out;
      const { cur, minor } = money(obj(r.dispute_amount));
      out.payments.push({
        kind: won ? "dispute_won" : "dispute",
        providerId: str(r.dispute_id) ?? "",
        occurredAt: at,
        amountMinor: minor,
        currency: cur,
        billing: null,
        refs: [],
        parentRef: str(obj(arr(r.disputed_transactions)[0]).seller_transaction_id),
        productIds: [],
        testMode,
      });
    } else if (type.startsWith("BILLING.SUBSCRIPTION.")) {
      const id = str(r.id) ?? "";
      out.subscriptions.push({
        providerId: id,
        status: SUB_STATUS[str(r.status) ?? ""] ?? "active",
        customerId: str(obj(r.subscriber).payer_id),
        startedAt: sec(r.start_time) ?? sec(r.create_time),
        canceledAt: str(r.status) === "CANCELLED" ? at : null,
        endedAt: str(r.status) === "EXPIRED" ? at : null,
      });
      // The subscription's custom_id names the visit; its payments (PAYMENT.SALE.*) carry the subscription id.
      const ref = visitRef(r.custom_id);
      if (ref && id) out.claims.push({ ref, ids: [id] });
    }
    return out;
  },

  async testApiKey(secret, settings) {
    if (!settings.clientId) return "Add the client id too";
    try {
      await accessToken(settings.clientId, secret, settings);
      return null;
    } catch (err) {
      return String(err instanceof Error ? err.message : err);
    }
  },
};

export function resetPaypalTokens(): void {
  tokens.clear();
}

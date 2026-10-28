// Payment webhooks: POST /_pay/<provider>/<connection id>.
//
// 1. The connection must exist and be for that provider; its signing secret
//    (stored encrypted) checks the signature against the raw body.
// 2. Each event is recorded once (payment_events): retries and replays of an
//    accepted event are answered 200 and ignored.
// 3. Payments, refunds, disputes and subscription changes are stored, converted
//    to the site currency, and charges are matched to the visit they came from.
// A failure after step 2 forgets the event again, so the provider's retry
// gets another go.

import type { Provider, SiteDTO } from "../../shared/sites";
import { CONNECTION_ID_RE, PROVIDER_INFO, PROVIDERS } from "../../shared/sites";
import { readTextCapped } from "../body";
import { ipBucket } from "../session";
import { getSite } from "../web/sites";
import { connectionSecrets, settingsOf, type ConnectionRow } from "./connections";
import { convert, convertNow } from "./fx";
import { claimRefs, LIKE_ESCAPE, matchPayment, PAYMENT_COLS, tokenLike, type PaymentRow } from "./match";
import { ADAPTERS } from "./providers";
import { announcePayments } from "./notify";
import type { Billing, NormalizedEvent, NormalizedPayment, NormalizedSubscription } from "./types";

export type { ConnectionRow };

export const PAY_PREFIX = "/_pay/";
const MAX_BODY = 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function recordError(db: D1Database, connId: string, error: string): Promise<void> {
  await db.prepare("UPDATE payment_connections SET last_error = ?2, last_error_at = ?3 WHERE id = ?1").bind(connId, error.slice(0, 300), Math.floor(Date.now() / 1000)).run();
}

/**
 * A refused signature: anyone who knows the webhook address can cause one, so
 * it's noted at most every 10 minutes and never replaces a newer, different error.
 */
async function recordRefusal(db: D1Database, connId: string, error: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("UPDATE payment_connections SET last_error = ?2, last_error_at = ?3 WHERE id = ?1 AND (last_error_at IS NULL OR last_error_at < ?3 - 600)")
    .bind(connId, error.slice(0, 300), now)
    .run();
}

/** Per network, before any lookup: made-up addresses can't cost a D1 read or a provider call each. Fails open. */
async function payLimited(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.PUBLIC_LIMITER) return false;
  try {
    return !(await env.PUBLIC_LIMITER.limit({ key: `pay:${ipBucket(ip)}` })).success;
  } catch (err) {
    console.error(JSON.stringify({ message: "payment webhook limiter failed", error: String(err) }));
    return false;
  }
}

export async function handlePaymentWebhook(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const [providerText, connId] = path.slice(PAY_PREFIX.length).split("/");
  if (!PROVIDERS.includes(providerText as Provider) || !connId || !CONNECTION_ID_RE.test(connId)) return json(404, { error: "Unknown webhook address" });
  const provider = providerText as Provider;
  if (await payLimited(request, env)) return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "60" } });

  const conn = await env.DB.prepare("SELECT * FROM payment_connections WHERE id = ?1").bind(connId).first<ConnectionRow>();
  if (!conn || conn.provider !== provider) return json(404, { error: "Unknown webhook address" });

  const body = await readTextCapped(request, MAX_BODY);
  if (body === null) return json(413, { error: "Too large" });

  const info = PROVIDER_INFO[provider];
  const { webhook, apiKey } = await connectionSecrets(env, conn);
  // Providers that sign (or authenticate by URL token) need that secret; PayPal needs its API credentials.
  const needs = info.webhookSecret || info.urlToken ? webhook : info.apiKey?.required ? apiKey : null;
  if (needs && !needs.value) {
    ctx.waitUntil(recordError(env.DB, conn.id, needs.problem ?? "A webhook arrived, but this connection's secret isn't set yet."));
    return json(503, { error: "Not configured" });
  }
  const adapter = ADAPTERS[provider];
  const settings = settingsOf(conn);
  const now = Math.floor(Date.now() / 1000);
  const refused = await adapter.verify(request.headers, body, webhook.value, now, { apiKey: apiKey.value, settings, url: new URL(request.url) });
  if (refused) {
    ctx.waitUntil(recordRefusal(env.DB, conn.id, refused));
    return json(401, { error: "Invalid signature" });
  }
  // Turned off: answered, so the provider doesn't keep retrying, but not recorded.
  if (conn.enabled === 0) return json(200, { ok: true, ignored: "This connection is turned off" });

  let event;
  try {
    event = await adapter.parse(body, request.headers, { apiKey: apiKey.value, settings });
  } catch (err) {
    ctx.waitUntil(recordError(env.DB, conn.id, `Couldn't read the event: ${String(err)}`));
    return json(400, { error: "Unreadable event" });
  }
  if (!event.id) return json(400, { error: "Event has no id" });

  const fresh = await env.DB.prepare("INSERT INTO payment_events (connection_id, event_id, received_at, type) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING")
    .bind(conn.id, event.id, now, event.type.slice(0, 80))
    .run();
  if (!fresh.meta.changes) return json(200, { ok: true, duplicate: true });

  try {
    const site = await getSite(env.DB, conn.site_id);
    if (!site) return json(410, { error: "The site was deleted" });
    const stored = await applyEvent(env, site, provider, conn, event, now);
    await env.DB.prepare("UPDATE payment_connections SET last_event_at = ?2, last_error = NULL, last_error_at = NULL WHERE id = ?1").bind(conn.id, now).run();
    if (stored.length) ctx.waitUntil(announcePayments(env, site, stored, ctx));
  } catch (err) {
    console.error(JSON.stringify({ message: "payment webhook failed", provider, connection: conn.id, event: event.id, error: String(err) }));
    await env.DB.prepare("DELETE FROM payment_events WHERE connection_id = ?1 AND event_id = ?2").bind(conn.id, event.id).run();
    ctx.waitUntil(recordError(env.DB, conn.id, `Processing failed: ${String(err)}`));
    return json(500, { error: "Processing failed" });
  }
  return json(200, { ok: true });
}

/**
 * Stores what one event says (subscriptions, payments, checkout claims), for
 * webhooks and for imports of past payments alike. Returns the new charges.
 */
export async function applyEvent(env: Env, site: SiteDTO, provider: Provider, conn: ConnectionRow, event: NormalizedEvent, now: number): Promise<string[]> {
  const filter = parseFilter(conn.product_filter);
  const charges: string[] = [];
  for (const sub of event.subscriptions) await storeSubscription(env.DB, site, provider, sub);
  for (const p of event.payments) {
    const before = p.kind === "charge" ? await env.DB.prepare("SELECT 1 FROM payments WHERE id = ?1").bind(`${provider}:charge:${p.providerId}`).first() : null;
    const id = await storePayment(env.DB, site, provider, conn.id, p, filter);
    if (id && p.kind === "charge" && !before && !p.testMode && id === `${provider}:charge:${p.providerId}`) charges.push(id);
  }
  for (const c of event.claims) {
    const session = await env.DB.prepare("SELECT visitor_id FROM web_sessions WHERE id = ?1 AND site_id = ?2").bind(c.ref, site.id).first<{ visitor_id: string }>();
    if (session && c.ids.length) await claimRefs(env, site, c.ref, session.visitor_id, c.ids, now);
  }
  return charges;
}

function parseFilter(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const SIGN: Record<NormalizedPayment["kind"], number> = { charge: 1, refund: -1, dispute: -1, dispute_won: 1 };

/** The charge a refund or dispute belongs to: by id, or by one of its other ids. */
async function findParent(db: D1Database, siteId: string, provider: string, ref: string): Promise<{ id: string; session_id: string | null; visitor_id: string | null; credited_session_id: string | null; matched_by: string | null; confidence: string | null } | null> {
  return db
    .prepare(
      `SELECT id, session_id, visitor_id, credited_session_id, matched_by, confidence FROM payments
       WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND (id = ?3 OR (' ' || order_ref || ' ') LIKE ?4 ${LIKE_ESCAPE}) LIMIT 1`,
    )
    .bind(siteId, provider, `${provider}:charge:${ref}`, tokenLike(ref))
    .first();
}

/**
 * Stores one payment (also from the generic API), converts it to the site's
 * currency and matches it. Returns the stored id, or null when it was skipped
 * (another product, or a refund of a charge this site doesn't have).
 */
export async function storePayment(db: D1Database, site: SiteDTO, provider: string, connectionId: string | null, p: NormalizedPayment, productFilter: string[] = []): Promise<string | null> {
  if (!p.providerId || !Number.isFinite(p.amountMinor)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (productFilter.length && p.productIds.length && !p.productIds.some((id) => productFilter.includes(id))) return null;

  const parent = p.kind !== "charge" && p.parentRef ? await findParent(db, site.id, provider, p.parentRef) : null;
  // With a product filter, money taken back counts only for charges this site has.
  if (p.kind !== "charge" && !parent && productFilter.length) return null;

  const refs = [...new Set([p.providerId, ...p.refs])];
  let billing: Billing = p.billing ?? "one_time";
  if (p.kind === "charge") {
    // The same payment reported twice (Creem's checkout and its subscription.paid): merge into the first.
    const twin = await db
      .prepare(`SELECT id FROM payments WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND id != ?3 AND (${refs.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 4} ${LIKE_ESCAPE}`).join(" OR ")}) LIMIT 1`)
      .bind(site.id, provider, `${provider}:charge:${p.providerId}`, ...refs.map(tokenLike))
      .first<{ id: string }>();
    if (twin) {
      await db
        .prepare("UPDATE payments SET ref = COALESCE(ref, ?2), email = COALESCE(email, ?3), subscription_id = COALESCE(subscription_id, ?4), customer_id = COALESCE(customer_id, ?5) WHERE id = ?1")
        .bind(twin.id, p.ref ?? null, p.email ?? null, p.subscriptionId ?? null, p.customerId ?? null)
        .run();
      await rematchIfOpen(db, site, twin.id);
      return twin.id;
    }
    if (p.billing === null && p.subscriptionId) {
      const earlier = await db
        .prepare("SELECT 1 FROM payments WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND subscription_id = ?3 AND occurred_at <= ?4 AND id != ?5 LIMIT 1")
        .bind(site.id, provider, p.subscriptionId, p.occurredAt, `${provider}:charge:${p.providerId}`)
        .first();
      billing = earlier ? "sub_renewal" : "sub_new";
    }
  }

  const id = `${provider}:${p.kind}:${p.providerId}`;
  const amount = SIGN[p.kind] * Math.abs(Math.round(p.amountMinor));
  const day = new Date(p.occurredAt * 1000).toISOString().slice(0, 10);
  const siteAmount = await convertNow(db, amount, p.currency, site.currency, day);

  await db
    .prepare(
      `INSERT INTO payments (id, site_id, connection_id, provider, kind, billing, occurred_at, amount_minor, currency, amount_site_minor,
         customer_id, email, subscription_id, order_ref, parent_id, ref, session_id, visitor_id, credited_session_id, matched_by, confidence, test_mode, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
       ON CONFLICT (id) DO UPDATE SET
         amount_minor = CASE WHEN ?24 = 1 THEN excluded.amount_minor ELSE payments.amount_minor END,
         amount_site_minor = CASE WHEN ?24 = 1 THEN excluded.amount_site_minor ELSE payments.amount_site_minor END,
         occurred_at = CASE WHEN ?24 = 1 THEN excluded.occurred_at ELSE payments.occurred_at END,
         ref = COALESCE(payments.ref, excluded.ref),
         email = COALESCE(payments.email, excluded.email),
         customer_id = COALESCE(payments.customer_id, excluded.customer_id),
         subscription_id = COALESCE(payments.subscription_id, excluded.subscription_id)`,
    )
    .bind(
      id,
      site.id,
      connectionId,
      provider,
      p.kind,
      billing,
      p.occurredAt,
      amount,
      p.currency,
      siteAmount,
      p.customerId ?? null,
      p.email ?? null,
      p.subscriptionId ?? null,
      refs.join(" "),
      parent?.id ?? null,
      p.ref ?? null,
      parent?.session_id ?? null,
      parent?.visitor_id ?? null,
      parent?.credited_session_id ?? null,
      parent?.matched_by ?? null,
      parent?.confidence ?? null,
      p.testMode ? 1 : 0,
      now,
      p.cumulative ? 1 : 0,
    )
    .run();

  if (p.kind === "charge") await rematchIfOpen(db, site, id);
  return id;
}

async function rematchIfOpen(db: D1Database, site: SiteDTO, id: string): Promise<void> {
  const row = await db.prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE id = ?1`).bind(id).first<PaymentRow>();
  if (row && !row.session_id) await matchPayment(db, site, row);
}

/** Subscription state, with its monthly value in the site's currency. */
export async function storeSubscription(db: D1Database, site: SiteDTO, provider: string, s: NormalizedSubscription): Promise<void> {
  if (!s.providerId) return;
  const now = Math.floor(Date.now() / 1000);
  let mrr: number | null = null;
  if (s.amountMinor != null && s.currency && s.intervalUnit) {
    const perMonth = { day: 30.44, week: 4.345, month: 1, year: 1 / 12 }[s.intervalUnit] / Math.max(1, s.intervalCount ?? 1);
    mrr = await convert(db, Math.round(s.amountMinor * perMonth), s.currency, site.currency, new Date().toISOString().slice(0, 10));
  }
  const id = `${provider}:${s.providerId}`;
  await db
    .prepare(
      `INSERT INTO subscriptions (id, site_id, provider, customer_id, status, interval_unit, interval_count, amount_minor, currency, mrr_site_minor, started_at, canceled_at, ended_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         customer_id = COALESCE(excluded.customer_id, subscriptions.customer_id),
         interval_unit = COALESCE(excluded.interval_unit, subscriptions.interval_unit),
         interval_count = CASE WHEN excluded.interval_unit IS NULL THEN subscriptions.interval_count ELSE excluded.interval_count END,
         amount_minor = COALESCE(excluded.amount_minor, subscriptions.amount_minor),
         currency = COALESCE(excluded.currency, subscriptions.currency),
         mrr_site_minor = COALESCE(excluded.mrr_site_minor, subscriptions.mrr_site_minor),
         started_at = MIN(subscriptions.started_at, excluded.started_at),
         canceled_at = COALESCE(excluded.canceled_at, subscriptions.canceled_at),
         ended_at = COALESCE(excluded.ended_at, subscriptions.ended_at),
         updated_at = excluded.updated_at`,
    )
    .bind(id, site.id, provider, s.customerId ?? null, s.status, s.intervalUnit ?? null, s.intervalCount ?? 1, s.amountMinor ?? null, s.currency ?? null, mrr, s.startedAt ?? now, s.canceledAt ?? null, s.endedAt ?? null, now)
    .run();
  if (s.firstOrderRef) {
    // Lemon Squeezy: the order that started it was the subscription's first payment.
    await db
      .prepare(`UPDATE payments SET billing = 'sub_new', subscription_id = COALESCE(subscription_id, ?3) WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND (' ' || order_ref || ' ') LIKE ?4 ${LIKE_ESCAPE}`)
      .bind(site.id, provider, s.providerId, tokenLike(s.firstOrderRef))
      .run();
  }
}

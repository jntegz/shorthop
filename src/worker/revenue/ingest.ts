// Payment webhooks: POST /_pay/<provider>/<connection id>.
//
// 1. The connection must exist and be for that provider; its signing secret
//    (stored encrypted) checks the signature against the raw body.
// 2. Each event is recorded once (payment_events), and marked when it has been
//    stored: retries and replays of a finished event are answered 200 and ignored.
// 3. Payments, refunds, disputes and subscription changes are stored, converted
//    to the site currency, and charges are matched to the visit they came from.
// A failure after step 2 forgets the event again, so the provider's retry
// gets another go. Should that fail too (or the Worker die halfway), the event
// stays unfinished: a retry within a minute is asked to come back later, and
// one after that takes the event over and stores it again, which is safe
// because everything is keyed by the provider's ids.

import type { Provider, SiteDTO } from "../../shared/sites";
import { CONNECTION_ID_RE, PROVIDER_INFO, PROVIDERS } from "../../shared/sites";
import { readTextCapped } from "../body";
import { ipBucket } from "../session";
import { getSite } from "../web/sites";
import { connectionSecrets, settingsOf, type ConnectionRow } from "./connections";
import { convert, convertNow, monthlyMinor } from "./fx";
import { claimRefs, LIKE_ESCAPE, liveSession, matchPayment, PAYMENT_COLS, tokenLike, type PaymentRow } from "./match";
import { ADAPTERS } from "./providers";
import { announcePayments } from "./notify";
import { firstOfRef, partOfRef, type Billing, type NormalizedEvent, type NormalizedLink, type NormalizedPayment, type NormalizedSubscription, type ParentHint } from "./types";

export type { ConnectionRow };

export const PAY_PREFIX = "/_pay/";
const MAX_BODY = 1024 * 1024;
/** An unfinished event younger than this is still being processed; an older one was abandoned. */
const PROCESSING_SEC = 60;

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

/**
 * Records the event, or says why not: "duplicate" when it was stored before,
 * "busy" while another delivery of it is being processed. An unfinished event
 * left behind by a failure is taken over.
 */
async function claimEvent(db: D1Database, connId: string, eventId: string, type: string, now: number): Promise<"new" | "duplicate" | "busy"> {
  const fresh = await db
    .prepare("INSERT INTO payment_events (connection_id, event_id, received_at, type) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING")
    .bind(connId, eventId, now, type.slice(0, 80))
    .run();
  if (fresh.meta.changes) return "new";
  // Only one retry wins this update, so two can't take the same event over.
  const taken = await db
    .prepare("UPDATE payment_events SET received_at = ?3 WHERE connection_id = ?1 AND event_id = ?2 AND processed_at IS NULL AND received_at <= ?3 - ?4")
    .bind(connId, eventId, now, PROCESSING_SEC)
    .run();
  if (taken.meta.changes) return "new";
  const row = await db.prepare("SELECT processed_at FROM payment_events WHERE connection_id = ?1 AND event_id = ?2").bind(connId, eventId).first<{ processed_at: number | null }>();
  return row?.processed_at != null ? "duplicate" : "busy";
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

  const claim = await claimEvent(env.DB, conn.id, event.id, event.type, now);
  if (claim === "duplicate") return json(200, { ok: true, duplicate: true });
  // Not a 2xx, so the provider sends it again: by then it is finished, or free to take over.
  if (claim === "busy") return new Response(JSON.stringify({ error: "Still processing this event, try again shortly" }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(PROCESSING_SEC) } });

  try {
    const site = await getSite(env.DB, conn.site_id);
    if (!site) return json(410, { error: "The site was deleted" });
    const stored = await applyEvent(env, site, provider, conn, event, now, { apiKey: apiKey.value });
    // Finished only now: a failure before this leaves the event open for the retry.
    await env.DB.batch([
      env.DB.prepare("UPDATE payment_events SET processed_at = ?3 WHERE connection_id = ?1 AND event_id = ?2").bind(conn.id, event.id, Math.floor(Date.now() / 1000)),
      env.DB.prepare("UPDATE payment_connections SET last_event_at = ?2, last_error = NULL, last_error_at = NULL WHERE id = ?1").bind(conn.id, now),
    ]);
    if (stored.length) ctx.waitUntil(announcePayments(env, site, stored, ctx));
  } catch (err) {
    console.error(JSON.stringify({ message: "payment webhook failed", provider, connection: conn.id, event: event.id, error: String(err) }));
    // Best effort: if this fails as well, the unfinished row is taken over by a later retry.
    await env.DB.prepare("DELETE FROM payment_events WHERE connection_id = ?1 AND event_id = ?2 AND processed_at IS NULL")
      .bind(conn.id, event.id)
      .run()
      .catch(() => undefined);
    ctx.waitUntil(recordError(env.DB, conn.id, `Processing failed: ${String(err)}`).catch(() => undefined));
    return json(500, { error: "Processing failed" });
  }
  return json(200, { ok: true });
}

/**
 * Stores what one event says (subscriptions, payments, checkout claims), for
 * webhooks and for imports of past payments alike. Returns the new charges.
 */
export async function applyEvent(env: Env, site: SiteDTO, provider: Provider, conn: ConnectionRow, event: NormalizedEvent, now: number, opts: { apiKey?: string | null } = {}): Promise<string[]> {
  const filter = parseFilter(conn.product_filter);
  const charges: string[] = [];
  // With an API key (webhooks only: an import lists the links itself), the provider is asked for a charge nothing stored names.
  const adapter = ADAPTERS[provider];
  const apiKey = opts.apiKey;
  const resolve: ParentResolver | undefined = apiKey && adapter.parentRefs ? (p) => adapter.parentRefs!(p, { apiKey, settings: settingsOf(conn) }) : undefined;
  for (const sub of event.subscriptions) await storeSubscription(env.DB, site, provider, sub);
  for (const link of event.links ?? []) await linkCharge(env.DB, site.id, provider, link, now);
  for (const p of event.payments) {
    const before = p.kind === "charge" ? await env.DB.prepare("SELECT 1 FROM payments WHERE id = ?1").bind(`${provider}:charge:${p.providerId}`).first() : null;
    const id = await storePayment(env.DB, site, provider, conn.id, p, filter, resolve);
    if (id && p.kind === "charge" && !before && !p.testMode && id === `${provider}:charge:${p.providerId}`) charges.push(id);
  }
  for (const c of event.claims) {
    const session = await env.DB.prepare(`SELECT visitor_id FROM web_sessions s WHERE id = ?1 AND site_id = ?2 AND ${liveSession("s")}`).bind(c.ref, site.id).first<{ visitor_id: string }>();
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

interface ParentRow {
  id: string;
  order_ref: string | null;
  session_id: string | null;
  visitor_id: string | null;
  credited_session_id: string | null;
  matched_by: string | null;
  confidence: string | null;
  personal_cleared_at: number | null;
}

const PARENT_COLS = "id, order_ref, session_id, visitor_id, credited_session_id, matched_by, confidence, personal_cleared_at";

/** The charge a refund or dispute belongs to: by id, or by one of its other ids. */
async function findParent(db: D1Database, siteId: string, provider: string, refs: string[]): Promise<ParentRow | null> {
  if (!refs.length) return null;
  const n = refs.length;
  return db
    .prepare(
      `SELECT ${PARENT_COLS} FROM payments
       WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge'
         AND (id IN (${refs.map((_, i) => `?${i + 3}`).join(", ")}) OR ${refs.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 3 + n} ${LIKE_ESCAPE}`).join(" OR ")}) LIMIT 1`,
    )
    .bind(siteId, provider, ...refs.map((r) => `${provider}:charge:${r}`), ...refs.map(tokenLike))
    .first<ParentRow>();
}

/** Adds ids to a charge's own, so what names them later (a refund, a dispute, a return page) finds it directly. */
async function teach(db: D1Database, charge: ParentRow, refs: string[]): Promise<void> {
  const known = new Set((charge.order_ref ?? "").split(" "));
  const fresh = [...new Set(refs)].filter((r) => r && !known.has(r));
  if (!fresh.length) return;
  await db.prepare("UPDATE payments SET order_ref = TRIM(COALESCE(order_ref, '') || ' ' || ?2) WHERE id = ?1").bind(charge.id, fresh.join(" ")).run();
  charge.order_ref = [charge.order_ref, ...fresh].filter(Boolean).join(" ");
}

/** Providers whose events name a charge's other ids apart from the charge (NormalizedLink). */
const LINKING: ReadonlySet<string> = new Set<Provider>(["stripe"]);
/** A link whose charge never arrived (an invoice of another product, a failed delivery) is dropped after this long. */
const LINK_KEEP_SEC = 30 * 86400;

/**
 * More ids of a charge: given to the charge when it is stored, otherwise kept
 * until it is (storePayment picks them up), so the order of the two events
 * doesn't matter.
 */
async function linkCharge(db: D1Database, siteId: string, provider: string, link: NormalizedLink, now: number): Promise<void> {
  const refs = [...new Set(link.refs)].filter((r) => r && r !== link.chargeRef);
  if (!link.chargeRef || !refs.length) return;
  const charge = await findParent(db, siteId, provider, [link.chargeRef]);
  if (charge) return teach(db, charge, refs);
  await db.batch([
    ...refs.map((r) => db.prepare("INSERT INTO payment_links (site_id, provider, charge_ref, ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING").bind(siteId, provider, link.chargeRef, r, now)),
    db.prepare("DELETE FROM payment_links WHERE created_at < ?1").bind(now - LINK_KEEP_SEC),
  ]);
}

/** Looks a refund's or dispute's charge up at the provider: more ids to find it by (ProviderAdapter.parentRefs). */
export type ParentResolver = (p: NormalizedPayment) => Promise<string[]>;

/** A day either side: the provider's charge and our record of its payment are seconds apart. */
const HINT_WINDOW_SEC = 86400;

/**
 * The charge a refund belongs to when none carries its ids (ParentHint in
 * ./types). The amount hint is a guess, so it only answers when a single
 * charge fits: with two alike, the refund is stored without a charge.
 */
async function findParentByHint(db: D1Database, siteId: string, provider: string, hint: ParentHint): Promise<ParentRow | null> {
  if ("firstOf" in hint) {
    return db
      .prepare(`SELECT ${PARENT_COLS} FROM payments WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND subscription_id = ?3 AND billing = 'sub_new' ORDER BY occurred_at LIMIT 1`)
      .bind(siteId, provider, hint.firstOf)
      .first<ParentRow>();
  }
  const { results } = await db
    .prepare(
      `SELECT ${PARENT_COLS} FROM payments
       WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND customer_id = ?3 AND currency = ?4 AND amount_minor = ?5 AND occurred_at BETWEEN ?6 - ${HINT_WINDOW_SEC} AND ?6 + ${HINT_WINDOW_SEC}
       ORDER BY ABS(occurred_at - ?6) LIMIT 50`,
    )
    .bind(siteId, provider, hint.customerId, hint.currency, Math.abs(Math.round(hint.amountMinor)), hint.at)
    .all<ParentRow>();
  const fits = results.filter((r) => !(r.order_ref ?? "").split(" ").some((ref) => hint.lacking.some((prefix) => ref.startsWith(prefix))));
  return fits.length === 1 ? fits[0]! : null;
}

/**
 * Stores one payment (also from the generic API), converts it to the site's
 * currency and matches it. Returns the stored id, or null when it was skipped
 * (another product, or a refund of a charge this site doesn't have).
 */
export async function storePayment(db: D1Database, site: SiteDTO, provider: string, connectionId: string | null, p: NormalizedPayment, productFilter: string[] = [], resolve?: ParentResolver): Promise<string | null> {
  if (!p.providerId || !Number.isFinite(p.amountMinor)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (productFilter.length && p.productIds.length && !p.productIds.some((id) => productFilter.includes(id))) return null;

  let parent: ParentRow | null = null;
  const parentRefs = p.kind === "charge" ? [] : [...new Set([p.parentRef, ...(p.parentRefs ?? [])].filter((r): r is string => Boolean(r)))];
  if (p.kind !== "charge") {
    // By the ids it names; then by what the provider's API says they belong to; only then by a guess.
    parent = await findParent(db, site.id, provider, parentRefs);
    let learn = false;
    const hint = p.parentHint ?? null;
    // What the store itself knows for sure comes before asking the provider.
    if (!parent && hint && "firstOf" in hint) {
      parent = await findParentByHint(db, site.id, provider, hint);
      learn = true;
    }
    if (!parent && resolve) {
      const asked = await resolve(p).catch((err: unknown) => {
        console.error(JSON.stringify({ message: "parent lookup at the provider failed", provider, payment: p.providerId, error: String(err) }));
        return [];
      });
      parent = await findParent(db, site.id, provider, asked);
      learn = true;
    }
    if (!parent && hint && !("firstOf" in hint)) {
      parent = await findParentByHint(db, site.id, provider, hint);
      learn = true;
    }
    // The charge learns these ids, so what follows (a dispute, the next refund total) finds it directly.
    if (parent && learn) await teach(db, parent, parentRefs);
  }
  // With a product filter, money taken back counts only for charges this site has.
  if (p.kind !== "charge" && !parent && productFilter.length) return null;

  let refs = [...new Set([p.providerId, ...p.refs])];
  // A single refund stored before its charge is known keeps the ids it names, so the charge's
  // running total, once it arrives, can take its place (the cleanup after the insert below).
  if (p.kind === "refund" && p.partOfTotal && !parent) refs = [...new Set([...refs, ...parentRefs.map(partOfRef)])];
  let billing: Billing = p.billing ?? "one_time";
  let linked = false;
  if (p.kind === "charge") {
    if (LINKING.has(provider)) {
      // Ids reported for this charge before it arrived (linkCharge).
      const { results } = await db
        .prepare(`SELECT ref FROM payment_links WHERE site_id = ?1 AND provider = ?2 AND charge_ref IN (${refs.map((_, i) => `?${i + 3}`).join(", ")})`)
        .bind(site.id, provider, ...refs)
        .all<{ ref: string }>();
      linked = results.length > 0;
      if (linked) refs = [...new Set([...refs, ...results.map((r) => r.ref)])];
    }
    // The same payment reported twice (Creem's checkout and its subscription.paid): merge into the first.
    const twin = await db
      .prepare(`SELECT id FROM payments WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND id != ?3 AND (${refs.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 4} ${LIKE_ESCAPE}`).join(" OR ")}) LIMIT 1`)
      .bind(site.id, provider, `${provider}:charge:${p.providerId}`, ...refs.map(tokenLike))
      .first<{ id: string }>();
    if (twin) {
      if (linked) {
        const row = await db.prepare(`SELECT ${PARENT_COLS} FROM payments WHERE id = ?1`).bind(twin.id).first<ParentRow>();
        if (row) await teach(db, row, refs);
        await forgetLinks(db, site.id, provider, [p.providerId, ...p.refs]);
      }
      await db
        // An erased payment stays erased (src/worker/web/privacy.ts).
        .prepare("UPDATE payments SET ref = COALESCE(ref, ?2), email = COALESCE(email, ?3), subscription_id = COALESCE(subscription_id, ?4), customer_id = COALESCE(customer_id, ?5) WHERE id = ?1 AND personal_cleared_at IS NULL")
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

  // A refund total of the whole charge is keyed by the charge, whichever id it was reported under.
  const parentKey = parent ? parent.id.slice(`${provider}:charge:`.length) : null;
  const ownId = p.ofParent && parentKey ? parentKey : p.providerId;
  const id = `${provider}:${p.kind}:${ownId}`;
  // When a running total was read: every refund made up to then is inside it.
  const totalAt = p.ofParent && p.cumulative ? (p.totalAt ?? p.occurredAt) : null;
  if (p.partOfTotal && parentKey && p.kind === "refund") {
    const total = await db
      .prepare("SELECT id FROM payments WHERE id = ?1 AND site_id = ?2 AND COALESCE(total_at, occurred_at) >= ?3")
      .bind(`${provider}:refund:${parentKey}`, site.id, p.occurredAt)
      .first<{ id: string }>();
    // Already counted in the charge's total.
    if (total) return total.id;
  }
  const amount = SIGN[p.kind] * Math.abs(Math.round(p.amountMinor));
  const day = new Date(p.occurredAt * 1000).toISOString().slice(0, 10);
  const siteAmount = await convertNow(db, amount, p.currency, site.currency, day);
  // A refund or dispute of an erased charge arrives erased too, so it can't bring the person back.
  const cleared = parent?.personal_cleared_at ? now : null;

  await db
    .prepare(
      `INSERT INTO payments (id, site_id, connection_id, provider, kind, billing, occurred_at, amount_minor, currency, amount_site_minor,
         customer_id, email, subscription_id, order_ref, parent_id, ref, session_id, visitor_id, credited_session_id, matched_by, confidence, test_mode, created_at, personal_cleared_at, total_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?25, ?26)
       ON CONFLICT (id) DO UPDATE SET
         -- A running total only grows, so a replayed older total can't shrink it.
         amount_minor = CASE WHEN ?24 = 1 AND ABS(excluded.amount_minor) >= ABS(payments.amount_minor) THEN excluded.amount_minor ELSE payments.amount_minor END,
         amount_site_minor = CASE WHEN ?24 = 1 AND ABS(excluded.amount_minor) >= ABS(payments.amount_minor) THEN excluded.amount_site_minor ELSE payments.amount_site_minor END,
         occurred_at = CASE WHEN ?24 = 1 AND ABS(excluded.amount_minor) >= ABS(payments.amount_minor) THEN excluded.occurred_at ELSE payments.occurred_at END,
         total_at = NULLIF(MAX(COALESCE(payments.total_at, 0), COALESCE(excluded.total_at, 0)), 0),
         -- A refund or dispute stored before its charge could be found follows it once it is.
         parent_id = COALESCE(payments.parent_id, excluded.parent_id),
         session_id = CASE WHEN payments.parent_id IS NULL AND payments.personal_cleared_at IS NULL THEN COALESCE(payments.session_id, excluded.session_id) ELSE payments.session_id END,
         visitor_id = CASE WHEN payments.parent_id IS NULL AND payments.personal_cleared_at IS NULL THEN COALESCE(payments.visitor_id, excluded.visitor_id) ELSE payments.visitor_id END,
         credited_session_id = CASE WHEN payments.parent_id IS NULL AND payments.personal_cleared_at IS NULL THEN COALESCE(payments.credited_session_id, excluded.credited_session_id) ELSE payments.credited_session_id END,
         matched_by = CASE WHEN payments.parent_id IS NULL THEN COALESCE(payments.matched_by, excluded.matched_by) ELSE payments.matched_by END,
         confidence = CASE WHEN payments.parent_id IS NULL THEN COALESCE(payments.confidence, excluded.confidence) ELSE payments.confidence END,
         -- The same event again after an erasure (a retry or a replay) can't refill what it removed,
         -- and a refund stored before its charge was found is erased with it once it is.
         ref = CASE WHEN payments.personal_cleared_at IS NULL AND excluded.personal_cleared_at IS NULL THEN COALESCE(payments.ref, excluded.ref) END,
         email = CASE WHEN payments.personal_cleared_at IS NULL AND excluded.personal_cleared_at IS NULL THEN COALESCE(payments.email, excluded.email) END,
         customer_id = CASE WHEN payments.personal_cleared_at IS NULL AND excluded.personal_cleared_at IS NULL THEN COALESCE(payments.customer_id, excluded.customer_id) END,
         personal_cleared_at = COALESCE(payments.personal_cleared_at, excluded.personal_cleared_at),
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
      cleared ? null : (p.customerId ?? null),
      cleared ? null : (p.email ?? null),
      p.subscriptionId ?? null,
      refs.join(" "),
      parent?.id ?? null,
      cleared ? null : (p.ref ?? null),
      parent?.session_id ?? null,
      parent?.visitor_id ?? null,
      parent?.credited_session_id ?? null,
      parent?.matched_by ?? null,
      parent?.confidence ?? null,
      p.testMode ? 1 : 0,
      now,
      p.cumulative ? 1 : 0,
      cleared,
      totalAt,
    )
    .run();

  if (linked) await forgetLinks(db, site.id, provider, [p.providerId, ...p.refs]);
  if (p.kind === "charge") await rematchIfOpen(db, site, id);
  // That total replaces the same refund stored before its charge was known, and the charge's
  // refunds stored one by one under their own ids up to when it was read, including ones stored
  // before the charge was (marked with partOfRef). A later one stays: it is not in it.
  if (totalAt !== null && parent && p.kind === "refund") {
    const chargeIds = [...new Set([parentKey ?? "", ...parentRefs, ...(parent.order_ref ?? "").split(" ")].filter(Boolean))];
    const orphans = chargeIds.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 7} ${LIKE_ESCAPE}`).join(" OR ");
    await db
      .prepare(
        `DELETE FROM payments WHERE site_id = ?3 AND kind = 'refund' AND id != ?2
           AND ((parent_id = ?1 AND occurred_at <= ?5) OR id = ?4 OR (parent_id IS NULL AND provider = ?6 AND occurred_at <= ?5 AND (${orphans})))`,
      )
      .bind(parent.id, id, site.id, `${provider}:refund:${p.providerId}`, totalAt, provider, ...chargeIds.map((r) => tokenLike(partOfRef(r))))
      .run();
  }
  return id;
}

async function forgetLinks(db: D1Database, siteId: string, provider: string, chargeRefs: string[]): Promise<void> {
  await db
    .prepare(`DELETE FROM payment_links WHERE site_id = ?1 AND provider = ?2 AND charge_ref IN (${chargeRefs.map((_, i) => `?${i + 3}`).join(", ")})`)
    .bind(siteId, provider, ...chargeRefs)
    .run();
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
    mrr = await convert(db, monthlyMinor(s.amountMinor, s.intervalUnit, s.intervalCount ?? 1), s.currency, site.currency, new Date().toISOString().slice(0, 10));
  }
  const id = `${provider}:${s.providerId}`;
  await db
    .prepare(
      `INSERT INTO subscriptions (id, site_id, provider, customer_id, status, interval_unit, interval_count, amount_minor, currency, mrr_site_minor, started_at, canceled_at, ended_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         -- Erased or past retention: later events don't bring the customer back.
         customer_id = CASE WHEN subscriptions.personal_cleared_at IS NULL THEN COALESCE(excluded.customer_id, subscriptions.customer_id) END,
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
    // Lemon Squeezy: the order that started it was the subscription's first payment. Every subscription
    // event names it; once that order is marked (found through the subscription's index), a refund finds
    // it directly (findParentByHint), so the scans below have nothing left to do.
    const marked = await db
      .prepare(
        `SELECT 1 FROM payments WHERE site_id = ?1 AND provider = ?2 AND subscription_id = ?3 AND kind = 'charge' AND billing = 'sub_new' AND (' ' || order_ref || ' ') LIKE ?4 ${LIKE_ESCAPE} LIMIT 1`,
      )
      .bind(site.id, provider, s.providerId, tokenLike(s.firstOrderRef))
      .first();
    if (!marked) {
      await db
        .prepare(`UPDATE payments SET billing = 'sub_new', subscription_id = COALESCE(subscription_id, ?3) WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND (' ' || order_ref || ' ') LIKE ?4 ${LIKE_ESCAPE}`)
        .bind(site.id, provider, s.providerId, tokenLike(s.firstOrderRef))
        .run();
      await adoptFirstRefunds(db, site.id, provider, s.providerId, s.firstOrderRef);
    }
  }
}

/**
 * Refunds of a subscription's first invoice that arrived before the
 * subscription named its order were stored without a charge. Now that the
 * order is known they become the order's refund total: the row order_refunded
 * writes, so the same money is one row whichever event came first.
 */
async function adoptFirstRefunds(db: D1Database, siteId: string, provider: string, subscriptionId: string, orderRef: string): Promise<void> {
  const { results } = await db
    .prepare(`SELECT id, amount_minor, amount_site_minor, occurred_at FROM payments WHERE site_id = ?1 AND provider = ?2 AND kind = 'refund' AND parent_id IS NULL AND (' ' || order_ref || ' ') LIKE ?3 ${LIKE_ESCAPE}`)
    .bind(siteId, provider, tokenLike(firstOfRef(subscriptionId)))
    .all<{ id: string; amount_minor: number; amount_site_minor: number | null; occurred_at: number }>();
  if (!results.length) return;
  const charge = await findParent(db, siteId, provider, [orderRef]);
  if (!charge) return;
  const target = `${provider}:refund:${charge.id.slice(`${provider}:charge:`.length)}`;
  for (const orphan of results) {
    const moved = await db
      .prepare(
        `UPDATE OR IGNORE payments SET id = ?2, parent_id = ?3, session_id = ?4, visitor_id = ?5, credited_session_id = ?6, matched_by = ?7, confidence = ?8,
           total_at = COALESCE(total_at, occurred_at) WHERE id = ?1`,
      )
      .bind(orphan.id, target, charge.id, charge.session_id, charge.visitor_id, charge.credited_session_id, charge.matched_by, charge.confidence)
      .run();
    if (moved.meta.changes) continue;
    // The order's refund is stored already: both are running totals of the same money, the larger is the later one.
    await db.batch([
      db
        .prepare("UPDATE payments SET amount_minor = ?2, amount_site_minor = ?3, occurred_at = ?4 WHERE id = ?1 AND ABS(amount_minor) < ABS(?2)")
        .bind(target, orphan.amount_minor, orphan.amount_site_minor, orphan.occurred_at),
      db.prepare("DELETE FROM payments WHERE id = ?1").bind(orphan.id),
    ]);
  }
}

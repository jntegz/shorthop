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
//
// Two cases store what they can and still ask for the event again (503, left
// unfinished): a provider that couldn't confirm it yet, and, on Workers Free, a
// delivery with more events than one invocation's 50 D1 calls can store. The
// finished ones of those are remembered (payment_events, "<event id>#<item>"),
// so each retry goes on where the last stopped.
//
// Sites may share a provider account, so each gets the same events, and payment
// ids are global: one row, one site. Who keeps it, when the event can tell:
//   - a connection's product filter decides for a payment that names products;
//   - a charge's visit reference decides for the site that visit belongs to;
//   - a refund or dispute belongs to the site that has its charge;
//   - a charge naming no product and no visit of this site is left by a
//     connection with a filter when another site's connection has none.
// A row another site stored first moves only when that site's own copy says the
// same thing (settleSharedId): one site's webhook proves nothing about another's
// row. It moves without the customer details stored with it. When nothing decides,
// the first webhook keeps the row and the others are refused and counted in
// System status.
//
// A refund or dispute can arrive before its charge. It is kept, naming the charge's
// ids (awaitsRef), and joins the charge when that is stored (settleCharge), which is
// also when it is held to the charge's amount.
//
// "Unverified" events are a ping's word only. A refund or dispute like that is stored
// and shown but counts for nothing against a confirmed charge, or against none, until
// it is confirmed, and a subscription's end like that doesn't change the subscription.

import type { Provider, SiteDTO } from "../../shared/sites";
import { CONNECTION_ID_RE, PROVIDER_INFO, PROVIDERS } from "../../shared/sites";
import { readTextCapped } from "../body";
import { planLimits } from "../plan";
import { limiterKey } from "../session";
import { getSite } from "../web/sites";
import { noteAnomaly, type PaymentAnomaly } from "./anomalies";
import { connectionSecrets, settingsOf, type ConnectionRow } from "./connections";
import { convert, convertNow, monthlyMinor } from "./fx";
import { claimRefs, LIKE_ESCAPE, liveSession, matchPayment, PAYMENT_COLS, tokenLike, type PaymentRow } from "./match";
import { ADAPTERS } from "./providers";
import { announcePayments } from "./notify";
import { awaitsRef, firstOfRef, partOfRef, type Billing, type NormalizedEvent, type NormalizedLink, type NormalizedPayment, type NormalizedSubscription, type ParentHint } from "./types";

export type { ConnectionRow };

export const PAY_PREFIX = "/_pay/";
const MAX_BODY = 1024 * 1024;
/** An unfinished event younger than this is still being processed; an older one was abandoned. */
const PROCESSING_SEC = 60;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/** "Send this again": every provider retries a 503, and Gumroad doesn't retry a 429. */
function sendAgain(error: string, afterSec: number): Response {
  return new Response(JSON.stringify({ error }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(afterSec) } });
}

/** A D1 binding that counts the calls made through it (each is a subrequest; a batch is one). */
function countingDb(db: D1Database): { db: D1Database; calls: () => number } {
  let calls = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const counted = new Proxy(stmt, {
      get(target, key) {
        const value = Reflect.get(target, key) as unknown;
        if (typeof value !== "function") return value;
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        return (...args: unknown[]) => {
          calls++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    real.set(counted, stmt);
    return counted;
  };
  const counted = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          calls++;
          return target.batch(stmts.map((s) => real.get(s) ?? s));
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: counted, calls: () => calls };
}

/** One step through a delivery with several events (top of this file). */
export interface BatchStep {
  /** Items an earlier delivery of this event finished. */
  done: Set<string>;
  /** Items finished by this one. */
  finished: string[];
  /** Items left for the next. */
  waiting: number;
  /** True once no further item may start. */
  spent: () => boolean;
}

/** May this item run now? Items keep their order: after the first that has to wait, all do. */
function admit(step: BatchStep | undefined, item: string): boolean {
  if (!step) return true;
  if (step.done.has(item)) return false;
  if (step.waiting || step.spent()) {
    step.waiting++;
    return false;
  }
  step.finished.push(item);
  return true;
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
    return !(await env.PUBLIC_LIMITER.limit({ key: await limiterKey(env, "pay", ip) })).success;
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
  if (await payLimited(request, env)) return sendAgain("Too many requests", 60);

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
  const memo = new Map<string, unknown>();
  const refused = await adapter.verify(request.headers, body, webhook.value, now, { apiKey: apiKey.value, settings, memo, url: new URL(request.url) });
  if (refused) {
    ctx.waitUntil(recordRefusal(env.DB, conn.id, refused));
    return json(401, { error: "Invalid signature" });
  }
  // Turned off: answered, so the provider doesn't keep retrying, but not recorded.
  if (conn.enabled === 0) return json(200, { ok: true, ignored: "This connection is turned off" });

  let event;
  try {
    event = await adapter.parse(body, request.headers, { apiKey: apiKey.value, settings, memo });
  } catch (err) {
    ctx.waitUntil(recordError(env.DB, conn.id, `Couldn't read the event: ${String(err)}`));
    return json(400, { error: "Unreadable event" });
  }
  if (!event.id) return json(400, { error: "Event has no id" });

  const claim = await claimEvent(env.DB, conn.id, event.id, event.type, now);
  if (claim === "duplicate") return json(200, { ok: true, duplicate: true });
  // Not a 2xx, so the provider sends it again: by then it is finished, or free to take over.
  if (claim === "busy") return sendAgain("Still processing this event, try again shortly", PROCESSING_SEC);

  try {
    const site = await getSite(env.DB, conn.site_id);
    if (!site) return json(410, { error: "The site was deleted" });
    // Several events on a plan that limits D1 calls: as many as fit, the rest on the retry.
    const items = event.payments.length + event.subscriptions.length;
    const budget = planLimits(env).webhookBatchCalls;
    let runEnv = env;
    let step: BatchStep | undefined;
    if (items > 1 && Number.isFinite(budget)) {
      const counter = countingDb(env.DB);
      const { results } = await env.DB.prepare("SELECT event_id FROM payment_events WHERE connection_id = ?1 AND event_id > ?2 AND event_id < ?3")
        .bind(conn.id, `${event.id}#`, `${event.id}$`)
        .all<{ event_id: string }>();
      step = { done: new Set(results.map((r) => r.event_id.slice(event.id.length + 1))), finished: [], waiting: 0, spent: () => counter.calls() > budget };
      runEnv = { ...env, DB: counter.db };
    }
    const stored = await applyEvent(runEnv, site, provider, conn, event, now, { apiKey: apiKey.value, memo, step });
    const waiting = step?.waiting ?? 0;
    const unconfirmed = event.unconfirmed ?? null;
    const again = waiting > 0 || Boolean(unconfirmed?.retry);
    const note = waiting > 0 ? `${waiting} of the ${items} events in one delivery wait for the provider's retry (Workers Free allows 50 database calls per request).` : (unconfirmed?.problem ?? null);
    const at = Math.floor(Date.now() / 1000);
    const db = env.DB;
    await db.batch([
      // Finished only now: a failure before this leaves the event open for the retry, and so
      // does a lack of confirmation, or a forged event would make the real one a duplicate.
      ...(again || unconfirmed ? [] : [db.prepare("UPDATE payment_events SET processed_at = ?3 WHERE connection_id = ?1 AND event_id = ?2").bind(conn.id, event.id, at)]),
      db.prepare("UPDATE payment_connections SET last_event_at = ?2, last_error = ?3, last_error_at = ?4 WHERE id = ?1").bind(conn.id, now, note?.slice(0, 300) ?? null, note ? now : null),
      ...(waiting
        ? (step?.finished ?? []).map((item) => db.prepare("INSERT INTO payment_events (connection_id, event_id, received_at, type, processed_at) VALUES (?1, ?2, ?3, 'batch item', ?3) ON CONFLICT DO NOTHING").bind(conn.id, `${event.id}#${item}`, at))
        : step?.done.size
          ? [db.prepare("DELETE FROM payment_events WHERE connection_id = ?1 AND event_id > ?2 AND event_id < ?3").bind(conn.id, `${event.id}#`, `${event.id}$`)]
          : []),
    ]);
    // In a batch, deliveries wait for the cron: they would take calls the batch has counted on.
    if (stored.length) ctx.waitUntil(announcePayments(env, site, stored, step ? undefined : ctx));
    // Stored either way; the retry confirms it, or carries on with the rest.
    if (again) return sendAgain(waiting > 0 ? "Part of this delivery is stored, send it again for the rest" : "Stored unconfirmed, send it again", PROCESSING_SEC);
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
export async function applyEvent(env: Env, site: SiteDTO, provider: Provider, conn: ConnectionRow, event: NormalizedEvent, now: number, opts: { apiKey?: string | null; memo?: Map<string, unknown>; step?: BatchStep } = {}): Promise<string[]> {
  const filter = parseFilter(conn.product_filter);
  const charges: string[] = [];
  const step = opts.step;
  // With an API key (webhooks only: an import lists the links itself), the provider is asked for a charge nothing stored names.
  const adapter = ADAPTERS[provider];
  const apiKey = opts.apiKey;
  const resolve: ParentResolver | undefined = apiKey && adapter.parentRefs ? (p) => adapter.parentRefs!(p, { apiKey, settings: settingsOf(conn) }) : undefined;
  for (const sub of event.subscriptions) {
    if (!admit(step, `sub:${sub.providerId}:${sub.status}:${sub.eventAt ?? ""}`)) continue;
    if (apiKey && adapter.confirmEnded && (sub.status === "canceled" || sub.status === "ended")) {
      const { results } = await env.DB.prepare("SELECT id FROM payments WHERE site_id = ?1 AND provider = ?2 AND subscription_id = ?3 AND kind = 'charge' ORDER BY occurred_at DESC LIMIT 3")
        .bind(site.id, provider, sub.providerId)
        .all<{ id: string }>();
      const stored = results.map((r) => r.id.slice(`${provider}:charge:`.length));
      const check = await adapter.confirmEnded(sub, [...new Set([...(sub.saleRefs ?? []), ...stored])], { apiKey, settings: settingsOf(conn), memo: opts.memo });
      // No proof it ended: kept beside the subscription, which stays as it is. With `retry` the
      // event stays open, so a later delivery can find it confirmed once the provider shows it.
      if (check !== true) {
        await holdSubscriptionEnd(env.DB, site, provider, sub, now);
        event.unconfirmed = { problem: check.problem, retry: check.retry || Boolean(event.unconfirmed?.retry) };
        continue;
      }
    }
    await storeSubscription(env.DB, site, provider, sub);
  }
  for (const link of event.links ?? []) await linkCharge(env.DB, site, provider, link, now);
  for (const p of event.payments) {
    if (!admit(step, `pay:${p.kind}:${p.providerId}`)) continue;
    // New to this site: a charge taken over from another site's connection is announced here.
    const before = p.kind === "charge" ? await env.DB.prepare("SELECT 1 FROM payments WHERE id = ?1 AND site_id = ?2").bind(`${provider}:charge:${p.providerId}`, site.id).first() : null;
    const id = await storePayment(env.DB, site, provider, conn.id, p, filter, resolve);
    if (id && p.kind === "charge" && !before && !p.testMode && id === `${provider}:charge:${p.providerId}`) charges.push(id);
  }
  for (const c of event.claims) {
    const session = await env.DB.prepare(`SELECT visitor_id FROM web_sessions s WHERE id = ?1 AND site_id = ?2 AND ${liveSession("s")}`).bind(c.ref, site.id).first<{ visitor_id: string }>();
    if (session && c.ids.length) await claimRefs(env, site, c.ref, c.ids, now, "provider");
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
  proves_identity: number;
  personal_cleared_at: number | null;
  amount_minor: number;
  currency: string;
  unverified: number;
}

const PARENT_COLS = "id, order_ref, session_id, visitor_id, credited_session_id, matched_by, confidence, proves_identity, personal_cleared_at, amount_minor, currency, unverified";

/**
 * A refund or dispute against its charge. In the charge's currency, what is
 * taken back can't exceed what was paid: refunds together, a dispute by itself.
 * The excess is cut and flagged. In another currency, or with no charge found,
 * nothing can be compared, so the amount stands and the row is flagged. An
 * unconfirmed refund takes no room from a confirmed one. settleCharge applies
 * the same limits to everything stored under the charge.
 */
async function checkAgainstCharge(db: D1Database, p: NormalizedPayment, parent: ParentRow | null, id: string, totalAt: number | null, amount: number): Promise<{ amount: number; anomaly: PaymentAnomaly | null }> {
  if (!parent) return { amount, anomaly: "no_charge" };
  if (parent.currency !== p.currency) return { amount, anomaly: "refund_currency" };
  let room = Math.abs(parent.amount_minor);
  if (p.kind === "refund") {
    // What a running total replaces (refunds up to when it was read) is not counted beside it.
    const others = await db
      .prepare("SELECT COALESCE(SUM(ABS(amount_minor)), 0) AS n FROM payments WHERE parent_id = ?1 AND kind = 'refund' AND currency = ?2 AND id != ?3 AND (?4 IS NULL OR occurred_at > ?4) AND (?5 = 1 OR unverified = 0)")
      .bind(parent.id, p.currency, id, totalAt, p.unverified ? 1 : 0)
      .first<{ n: number }>();
    room = Math.max(0, room - (others?.n ?? 0));
  }
  return Math.abs(amount) > room ? { amount: Math.sign(amount) * room, anomaly: "refund_capped" } : { amount, anomaly: null };
}

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

const chargeRow = (db: D1Database, id: string) => db.prepare(`SELECT ${PARENT_COLS} FROM payments WHERE id = ?1`).bind(id).first<ParentRow>();

/** The ids a stored charge goes by. */
const chargeIds = (provider: string, charge: ParentRow) => [...new Set([charge.id.slice(`${provider}:charge:`.length), ...(charge.order_ref ?? "").split(" ")])].filter(Boolean);

/** A refund or dispute that rests on a ping alone and has no unconfirmed charge to go with: it is stored, and counts as 0. */
const heldBack = (kind: string, unverified: boolean, parent: Pick<ParentRow, "unverified"> | null) => kind !== "charge" && unverified && parent?.unverified !== 1;

interface TakenBack {
  id: string;
  kind: string;
  amount_minor: number;
  amount_site_minor: number | null;
  currency: string;
  occurred_at: number;
  total_at: number | null;
  unverified: number;
  anomaly: string | null;
}

/**
 * Brings everything stored under a charge in line with it, whichever arrived
 * first: refunds and disputes waiting for it join it, a running total replaces
 * the refunds it covers, and amounts are cut to what the charge allows. Confirmed
 * ones are served first, oldest first; under an unconfirmed charge, unconfirmed
 * ones share what they leave, so forged pings can't take back more than was paid.
 * Amounts only ever go down here, so running it again changes nothing.
 */
async function settleCharge(db: D1Database, site: SiteDTO, provider: string, charge: ParentRow): Promise<void> {
  const ids = chargeIds(provider, charge).slice(0, 20);
  const cleared = charge.personal_cleared_at;
  const [, under] = await db.batch<TakenBack>([
    db
      .prepare(
        `UPDATE payments SET parent_id = ?1, session_id = ?2, visitor_id = ?3, credited_session_id = ?4, matched_by = ?5, confidence = ?6, proves_identity = ?7,
           personal_cleared_at = COALESCE(personal_cleared_at, ?8),
           email = CASE WHEN ?8 IS NULL THEN email END, customer_id = CASE WHEN ?8 IS NULL THEN customer_id END, ref = CASE WHEN ?8 IS NULL THEN ref END
         WHERE site_id = ?9 AND provider = ?10 AND parent_id IS NULL AND kind != 'charge' AND (${ids.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 11} ${LIKE_ESCAPE}`).join(" OR ")})`,
      )
      .bind(charge.id, charge.session_id, charge.visitor_id, charge.credited_session_id, charge.matched_by, charge.confidence, cleared ? 0 : charge.proves_identity, cleared, site.id, provider, ...ids.map((r) => tokenLike(awaitsRef(r)))),
    db.prepare("SELECT id, kind, amount_minor, amount_site_minor, currency, occurred_at, total_at, unverified, anomaly FROM payments WHERE parent_id = ?1 AND site_id = ?2").bind(charge.id, site.id),
  ]);
  const rows = under?.results ?? [];
  if (!rows.length) return;

  const total = rows.filter((r) => r.kind === "refund" && r.total_at !== null && !r.unverified).sort((a, b) => b.total_at! - a.total_at!)[0];
  const covered = (r: TakenBack) => Boolean(total) && r.kind === "refund" && r.id !== total!.id && (r.total_at ?? r.occurred_at) <= total!.total_at!;
  const stmts = rows.filter(covered).map((r) => db.prepare("DELETE FROM payments WHERE id = ?1 AND site_id = ?2").bind(r.id, site.id));

  const paid = Math.abs(charge.amount_minor);
  let refundRoom = paid;
  let unconfirmedRoom = paid;
  const flagged: [PaymentAnomaly, string][] = [];
  const inOrder = rows.filter((r) => !covered(r)).sort((a, b) => a.unverified - b.unverified || a.occurred_at - b.occurred_at || (a.id < b.id ? -1 : 1));
  for (const r of inOrder) {
    const size = Math.abs(r.amount_minor);
    let allowed = size;
    if (r.currency === charge.currency) {
      // Under a confirmed charge unconfirmed ones count for nothing, so they needn't share.
      const takesBack = r.kind !== "dispute_won";
      allowed = Math.min(size, r.unverified && takesBack && charge.unverified ? unconfirmedRoom : r.kind === "refund" && !r.unverified ? refundRoom : paid);
      if (r.kind === "refund" && !r.unverified) refundRoom -= allowed;
      if (takesBack) unconfirmedRoom = Math.max(0, unconfirmedRoom - allowed);
    }
    const amount = Math.sign(r.amount_minor) * allowed || 0;
    const anomaly = allowed < size ? "refund_capped" : r.currency !== charge.currency ? "refund_currency" : r.anomaly === "no_charge" ? null : r.anomaly;
    const held = heldBack(r.kind, r.unverified === 1, charge);
    let siteAmount = r.amount_site_minor;
    if (held) siteAmount = 0;
    else if (allowed < size || (siteAmount === 0 && amount !== 0)) siteAmount = await convertNow(db, amount, r.currency, site.currency, new Date(r.occurred_at * 1000).toISOString().slice(0, 10));
    if (amount === r.amount_minor && siteAmount === r.amount_site_minor && anomaly === r.anomaly) continue;
    stmts.push(db.prepare("UPDATE payments SET amount_minor = ?2, amount_site_minor = ?3, anomaly = ?4 WHERE id = ?1").bind(r.id, amount, siteAmount, anomaly));
    if (anomaly !== r.anomaly && (anomaly === "refund_capped" || anomaly === "refund_currency")) flagged.push([anomaly, r.id]);
  }
  if (stmts.length) await db.batch(stmts);
  for (const [kind, id] of flagged) await noteAnomaly(db, site.id, kind, id);
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
async function linkCharge(db: D1Database, site: SiteDTO, provider: string, link: NormalizedLink, now: number): Promise<void> {
  const refs = [...new Set(link.refs)].filter((r) => r && r !== link.chargeRef);
  if (!link.chargeRef || !refs.length) return;
  const charge = await findParent(db, site.id, provider, [link.chargeRef]);
  if (charge) {
    await teach(db, charge, refs);
    // What was waiting under one of the new ids finds the charge now.
    return settleCharge(db, site, provider, charge);
  }
  await db.batch([
    ...refs.map((r) => db.prepare("INSERT INTO payment_links (site_id, provider, charge_ref, ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING").bind(site.id, provider, link.chargeRef, r, now)),
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
 * A connection with a product filter and a charge that names no product (Stripe
 * one-time checkouts, PayPal, renewals on some providers): the filter can't
 * decide. The charge stays here if its reference is a visit of this site, or if
 * no other site's connection without a filter would take it.
 */
async function leaveToOtherSite(db: D1Database, site: SiteDTO, provider: string, p: NormalizedPayment): Promise<boolean> {
  if (p.ref) {
    const own = await db.prepare("SELECT 1 FROM web_sessions WHERE id = ?1 AND site_id = ?2").bind(p.ref, site.id).first();
    if (own) return false;
  }
  const other = await db
    .prepare("SELECT 1 FROM payment_connections WHERE provider = ?1 AND site_id != ?2 AND enabled != 0 AND product_filter IN ('', '[]') LIMIT 1")
    .bind(provider, site.id)
    .first();
  return Boolean(other);
}

/**
 * This site's write met a row of another site under the same id (ids are global).
 * "there": that site rightly has it, nothing to report. "here": the row is this
 * site's, and it has been moved over, with the refunds and disputes under it.
 * "conflict": nothing shows whose it is.
 *
 * Anyone with this site's webhook secret can sign anything, so this site's event
 * alone proves nothing about the other's row. The row has to agree: it was stored
 * from a copy of the same event, with the same amount and currency, naming this
 * site's visit (a charge) or a charge this site has (a refund or dispute). Sites
 * sharing a provider account get exactly that. Only a provider's own confirmed
 * webhook can move a row, never one matched to a visit, and the customer details
 * stored with it stay behind: what this site knows comes from its own event.
 */
async function settleSharedId(db: D1Database, site: SiteDTO, provider: string, connectionId: string | null, p: NormalizedPayment, id: string, parent: ParentRow | null, amount: number): Promise<"there" | "here" | "conflict"> {
  if (!connectionId) return "conflict";
  const row = await db
    .prepare("SELECT site_id, session_id, parent_id, ref, order_ref, amount_minor, currency FROM payments WHERE id = ?1")
    .bind(id)
    .first<{ site_id: string; session_id: string | null; parent_id: string | null; ref: string | null; order_ref: string | null; amount_minor: number; currency: string }>();
  if (!row || row.site_id === site.id) return "conflict";
  const sameMoney = row.amount_minor === amount && row.currency === p.currency;
  if (p.kind === "charge") {
    const visit = p.ref ? await db.prepare("SELECT site_id FROM web_sessions WHERE id = ?1").bind(p.ref).first<{ site_id: string }>() : null;
    if (visit?.site_id === row.site_id) return "there";
    if (visit?.site_id !== site.id || row.session_id || row.ref !== p.ref || !sameMoney) return "conflict";
  } else {
    if (!parent) return row.parent_id ? "there" : "conflict";
    if (row.parent_id || !sameMoney) return "conflict";
    const named = (row.order_ref ?? "").split(" ");
    if (!chargeIds(provider, parent).some((r) => named.includes(awaitsRef(r)))) return "conflict";
  }
  if (p.unverified) return "conflict";
  // The site's own currency and match are worked out again here (the upsert, the rematch, the daily conversion).
  await db
    .prepare(
      `UPDATE payments SET site_id = ?2, connection_id = ?3, amount_site_minor = NULL, session_id = NULL, visitor_id = NULL, credited_session_id = NULL,
         matched_by = NULL, confidence = NULL, proves_identity = 0, unmatched_reason = NULL, last_match_at = NULL, email = NULL, customer_id = NULL
       WHERE (id = ?1 OR parent_id = ?1) AND site_id = ?4`,
    )
    .bind(id, site.id, connectionId, row.site_id)
    .run();
  return "here";
}

/** The stored row was only the webhook's word, and this write is confirmed: its values replace the row's. */
const CONFIRMS = "(payments.unverified = 1 AND excluded.unverified = 0)";
/** A running total that grew. An unconfirmed one can't change a confirmed row. */
const GROWS = "(?24 = 1 AND excluded.unverified <= payments.unverified AND ABS(excluded.amount_minor) >= ABS(payments.amount_minor))";

/**
 * Stores one payment (also from the generic API), converts it to the site's
 * currency and matches it. Returns the stored id, or null when it was skipped
 * (another product, a refund of a charge this site doesn't have, or an id that
 * belongs to another site: top of this file).
 */
export async function storePayment(db: D1Database, site: SiteDTO, provider: string, connectionId: string | null, p: NormalizedPayment, productFilter: string[] = [], resolve?: ParentResolver): Promise<string | null> {
  if (!p.providerId || !Number.isFinite(p.amountMinor)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (productFilter.length) {
    if (p.productIds.length) {
      if (!p.productIds.some((id) => productFilter.includes(id))) return null;
    } else if (p.kind === "charge" && (await leaveToOtherSite(db, site, provider, p))) {
      return null;
    }
  }

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
  // Any refund or dispute stored before its charge keeps what it names, to join the charge when it comes (settleCharge).
  if (p.kind !== "charge" && !parent) refs = [...new Set([...refs, ...parentRefs.map(awaitsRef)])];
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
      const merged = await chargeRow(db, twin.id);
      if (merged) await settleCharge(db, site, provider, merged);
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
  const reported = p.amountUnknown ? 0 : SIGN[p.kind] * Math.abs(Math.round(p.amountMinor));
  const checked = p.kind === "charge" ? { amount: reported, anomaly: null } : await checkAgainstCharge(db, p, parent, id, totalAt, reported);
  const amount = checked.amount;
  const anomaly: PaymentAnomaly | null = p.amountUnknown ? "refund_unknown" : checked.anomaly;
  const day = new Date(p.occurredAt * 1000).toISOString().slice(0, 10);
  const siteAmount = heldBack(p.kind, Boolean(p.unverified), parent) ? 0 : await convertNow(db, amount, p.currency, site.currency, day);
  // A refund or dispute of an erased charge arrives erased too, so it can't bring the person back.
  const cleared = parent?.personal_cleared_at ? now : null;

  // Ids are global: the row of another site that reported the same id is left alone (nothing is written).
  const write = () => db
    .prepare(
      `INSERT INTO payments (id, site_id, connection_id, provider, kind, billing, occurred_at, amount_minor, currency, amount_site_minor,
         customer_id, email, subscription_id, order_ref, parent_id, ref, session_id, visitor_id, credited_session_id, matched_by, confidence, test_mode, created_at, personal_cleared_at, total_at, anomaly, unverified, started_at, proves_identity)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?25, ?26, ?27, ?28, ?29, ?30)
       ON CONFLICT (id) DO UPDATE SET
         -- A running total only grows, so a replayed older total can't shrink it (the cap can: settleCharge, below).
         -- A confirmed write replaces an unconfirmed one, and an unconfirmed one changes nothing confirmed.
         amount_minor = CASE WHEN ${CONFIRMS} OR ${GROWS} THEN excluded.amount_minor ELSE payments.amount_minor END,
         amount_site_minor = CASE WHEN ${CONFIRMS} OR ${GROWS} THEN excluded.amount_site_minor
           WHEN excluded.unverified > payments.unverified THEN payments.amount_site_minor
           ELSE COALESCE(payments.amount_site_minor, excluded.amount_site_minor) END,
         occurred_at = CASE WHEN ${CONFIRMS} OR ${GROWS} THEN excluded.occurred_at ELSE payments.occurred_at END,
         started_at = COALESCE(payments.started_at, excluded.started_at),
         test_mode = CASE WHEN ${CONFIRMS} THEN excluded.test_mode ELSE payments.test_mode END,
         total_at = NULLIF(MAX(COALESCE(payments.total_at, 0), COALESCE(excluded.total_at, 0)), 0),
         -- A refund or dispute stored before its charge could be found follows it once it is.
         parent_id = COALESCE(payments.parent_id, excluded.parent_id),
         session_id = CASE WHEN payments.parent_id IS NULL AND payments.personal_cleared_at IS NULL THEN COALESCE(payments.session_id, excluded.session_id) ELSE payments.session_id END,
         visitor_id = CASE WHEN payments.parent_id IS NULL AND payments.personal_cleared_at IS NULL THEN COALESCE(payments.visitor_id, excluded.visitor_id) ELSE payments.visitor_id END,
         credited_session_id = CASE WHEN payments.parent_id IS NULL AND payments.personal_cleared_at IS NULL THEN COALESCE(payments.credited_session_id, excluded.credited_session_id) ELSE payments.credited_session_id END,
         matched_by = CASE WHEN payments.parent_id IS NULL THEN COALESCE(payments.matched_by, excluded.matched_by) ELSE payments.matched_by END,
         confidence = CASE WHEN payments.parent_id IS NULL THEN COALESCE(payments.confidence, excluded.confidence) ELSE payments.confidence END,
         proves_identity = CASE WHEN payments.parent_id IS NULL THEN MAX(payments.proves_identity, excluded.proves_identity) ELSE payments.proves_identity END,
         -- The same event again after an erasure (a retry or a replay) can't refill what it removed,
         -- and a refund stored before its charge was found is erased with it once it is.
         ref = CASE WHEN payments.personal_cleared_at IS NULL AND excluded.personal_cleared_at IS NULL THEN COALESCE(payments.ref, excluded.ref) END,
         email = CASE WHEN payments.personal_cleared_at IS NULL AND excluded.personal_cleared_at IS NULL THEN
           CASE WHEN ${CONFIRMS} THEN COALESCE(excluded.email, payments.email) ELSE COALESCE(payments.email, excluded.email) END END,
         customer_id = CASE WHEN payments.personal_cleared_at IS NULL AND excluded.personal_cleared_at IS NULL THEN
           CASE WHEN ${CONFIRMS} THEN COALESCE(excluded.customer_id, payments.customer_id) ELSE COALESCE(payments.customer_id, excluded.customer_id) END END,
         personal_cleared_at = COALESCE(payments.personal_cleared_at, excluded.personal_cleared_at),
         subscription_id = CASE WHEN ${CONFIRMS} THEN COALESCE(excluded.subscription_id, payments.subscription_id) ELSE COALESCE(payments.subscription_id, excluded.subscription_id) END,
         -- A cap, currency or unknown-size flag stays; "no charge found" goes once one is, "size unknown" once it is known.
         anomaly = CASE
           WHEN excluded.unverified > payments.unverified THEN payments.anomaly
           WHEN excluded.anomaly IN ('refund_capped', 'refund_currency', 'refund_unknown') THEN excluded.anomaly
           WHEN payments.anomaly = 'refund_unknown' THEN excluded.anomaly
           WHEN COALESCE(payments.parent_id, excluded.parent_id) IS NULL THEN COALESCE(payments.anomaly, excluded.anomaly)
           WHEN payments.anomaly = 'no_charge' THEN NULL
           ELSE payments.anomaly END,
         unverified = MIN(payments.unverified, excluded.unverified)
       WHERE payments.site_id = excluded.site_id`,
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
      anomaly,
      p.unverified ? 1 : 0,
      p.startedAt ?? null,
      cleared ? 0 : (parent?.proves_identity ?? 0),
    )
    .run();
  let written = await write();
  if (!written.meta.changes) {
    const settled = await settleSharedId(db, site, provider, connectionId, p, id, parent, reported);
    if (settled === "there") return null;
    if (settled === "here") written = await write();
    if (!written.meta.changes) {
      await noteAnomaly(db, site.id, "id_conflict", id);
      return null;
    }
  }
  if (anomaly) await noteAnomaly(db, site.id, anomaly, id);

  if (linked) await forgetLinks(db, site.id, provider, [p.providerId, ...p.refs]);
  if (p.kind === "charge") {
    await rematchIfOpen(db, site, id);
    // Refunds and disputes that came first join it, and are held to what it says.
    const stored = await chargeRow(db, id);
    if (stored) await settleCharge(db, site, provider, stored);
  }
  // That total replaces the same refund stored before its charge was known, and the charge's
  // refunds stored one by one under their own ids up to when it was read, including ones stored
  // before the charge was (marked with partOfRef). A later one stays: it is not in it.
  if (totalAt !== null && parent && p.kind === "refund") {
    const coveredIds = [...new Set([parentKey ?? "", ...parentRefs, ...(parent.order_ref ?? "").split(" ")].filter(Boolean))];
    const orphans = coveredIds.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 7} ${LIKE_ESCAPE}`).join(" OR ");
    await db
      .prepare(
        `DELETE FROM payments WHERE site_id = ?3 AND kind = 'refund' AND id != ?2
           AND ((parent_id = ?1 AND occurred_at <= ?5) OR id = ?4 OR (parent_id IS NULL AND provider = ?6 AND occurred_at <= ?5 AND (${orphans})))`,
      )
      .bind(parent.id, id, site.id, `${provider}:refund:${p.providerId}`, totalAt, provider, ...coveredIds.map((r) => tokenLike(partOfRef(r))))
      .run();
  }
  // Also when this write repeats one stored before the charge was known: the cap applies to what is stored.
  if (parent && p.kind !== "charge") await settleCharge(db, site, provider, parent);
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

/** How far ahead of this Worker's clock a provider's event time is believed. */
const EVENT_CLOCK_SKEW_SEC = 300;
const ENDED_STATES = "('canceled', 'ended')";

/**
 * Subscription state, with its monthly value in the site's currency. Events can
 * arrive out of order or be replayed, so the state follows the newest: an event
 * older than the one stored is ignored, and a newer one may bring a canceled
 * subscription back. An event without a time, or of the same second, can't.
 */
export async function storeSubscription(db: D1Database, site: SiteDTO, provider: string, s: NormalizedSubscription): Promise<void> {
  if (!s.providerId) return;
  const now = Math.floor(Date.now() / 1000);
  let mrr: number | null = null;
  if (s.amountMinor != null && s.currency && s.intervalUnit) {
    mrr = await convert(db, monthlyMinor(s.amountMinor, s.intervalUnit, s.intervalCount ?? 1), s.currency, site.currency, new Date().toISOString().slice(0, 10));
  }
  const id = `${provider}:${s.providerId}`;
  // A wrong clock (or a made-up time) far in the future would freeze the state.
  const eventAt = s.eventAt == null ? null : Math.min(s.eventAt, now + EVENT_CLOCK_SKEW_SEC);
  const stays = `(subscriptions.status IN ${ENDED_STATES} AND excluded.status NOT IN ${ENDED_STATES})`;
  const written = await db
    .prepare(
      `INSERT INTO subscriptions (id, site_id, provider, customer_id, status, interval_unit, interval_count, amount_minor, currency, mrr_site_minor, started_at, canceled_at, ended_at, updated_at, last_event_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status,
         last_event_at = COALESCE(MAX(excluded.last_event_at, subscriptions.last_event_at), excluded.last_event_at, subscriptions.last_event_at),
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
         updated_at = excluded.updated_at,
         -- What the provider now says settles an end that was waiting for confirmation.
         unconfirmed_end = NULL,
         unconfirmed_at = NULL
       WHERE subscriptions.site_id = excluded.site_id AND CASE
         WHEN excluded.last_event_at IS NULL THEN NOT ${stays}
         WHEN subscriptions.last_event_at IS NULL THEN 1
         WHEN excluded.last_event_at > subscriptions.last_event_at THEN 1
         WHEN excluded.last_event_at = subscriptions.last_event_at THEN NOT ${stays}
         ELSE 0 END`,
    )
    .bind(id, site.id, provider, s.customerId ?? null, s.status, s.intervalUnit ?? null, s.intervalCount ?? 1, s.amountMinor ?? null, s.currency ?? null, mrr, s.startedAt ?? now, s.canceledAt ?? null, s.endedAt ?? null, now, eventAt)
    .run();
  if (!written.meta.changes) {
    const owner = await db.prepare("SELECT site_id FROM subscriptions WHERE id = ?1").bind(id).first<{ site_id: string }>();
    if (owner && owner.site_id !== site.id) {
      await noteAnomaly(db, site.id, "id_conflict", id);
      return;
    }
    console.log(JSON.stringify({ message: "older subscription event ignored", site: site.id, subscription: id, status: s.status }));
  }
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
      await adoptFirstRefunds(db, site, provider, s.providerId, s.firstOrderRef);
    }
  }
}

/**
 * A cancellation or end nothing confirms (the provider can't be asked, or doesn't
 * show it). It is written down beside the subscription, whose status, dates and
 * value stay: a webhook address is enough to send one. With no subscription stored
 * yet the row says only that ("unconfirmed"), and counts in no figure. A confirmed
 * event for the subscription replaces all of it.
 */
async function holdSubscriptionEnd(db: D1Database, site: SiteDTO, provider: string, s: NormalizedSubscription, now: number): Promise<void> {
  if (!s.providerId) return;
  const id = `${provider}:${s.providerId}`;
  const written = await db
    .prepare(
      `INSERT INTO subscriptions (id, site_id, provider, status, started_at, updated_at, unconfirmed_end, unconfirmed_at) VALUES (?1, ?2, ?3, 'unconfirmed', ?4, ?4, ?5, ?4)
       ON CONFLICT (id) DO UPDATE SET unconfirmed_end = excluded.unconfirmed_end, unconfirmed_at = excluded.unconfirmed_at
       WHERE subscriptions.site_id = excluded.site_id AND subscriptions.status NOT IN ${ENDED_STATES}`,
    )
    .bind(id, site.id, provider, now, s.status)
    .run();
  if (written.meta.changes) return;
  const owner = await db.prepare("SELECT site_id FROM subscriptions WHERE id = ?1").bind(id).first<{ site_id: string }>();
  if (owner && owner.site_id !== site.id) await noteAnomaly(db, site.id, "id_conflict", id);
}

/**
 * Refunds of a subscription's first invoice that arrived before the
 * subscription named its order were stored without a charge. Now that the
 * order is known they become the order's refund total: the row order_refunded
 * writes, so the same money is one row whichever event came first.
 */
async function adoptFirstRefunds(db: D1Database, site: SiteDTO, provider: string, subscriptionId: string, orderRef: string): Promise<void> {
  const siteId = site.id;
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
        `UPDATE OR IGNORE payments SET id = ?2, parent_id = ?3, session_id = ?4, visitor_id = ?5, credited_session_id = ?6, matched_by = ?7, confidence = ?8, proves_identity = ?9,
           total_at = COALESCE(total_at, occurred_at), anomaly = CASE WHEN anomaly = 'no_charge' THEN NULL ELSE anomaly END WHERE id = ?1`,
      )
      .bind(orphan.id, target, charge.id, charge.session_id, charge.visitor_id, charge.credited_session_id, charge.matched_by, charge.confidence, charge.proves_identity)
      .run();
    if (moved.meta.changes) continue;
    // Taken: by this site's refund of the order, or (ids being global) by another site's row, which stays as it is.
    const holder = await db.prepare("SELECT site_id FROM payments WHERE id = ?1").bind(target).first<{ site_id: string }>();
    if (holder && holder.site_id !== siteId) {
      await noteAnomaly(db, siteId, "id_conflict", target);
      continue;
    }
    // The order's refund is stored already: both are running totals of the same money, the larger is the later one.
    await db.batch([
      db
        .prepare("UPDATE payments SET amount_minor = ?2, amount_site_minor = ?3, occurred_at = ?4 WHERE id = ?1 AND ABS(amount_minor) < ABS(?2)")
        .bind(target, orphan.amount_minor, orphan.amount_site_minor, orphan.occurred_at),
      db.prepare("DELETE FROM payments WHERE id = ?1").bind(orphan.id),
    ]);
  }
  await settleCharge(db, site, provider, charge);
}

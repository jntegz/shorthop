// Outbound webhooks. Events become rows in an outbox (webhook_deliveries),
// one per subscribed endpoint; admin actions send them at once in the
// background, and the half-hourly cron retries what's due with backoff.
//
// Each POST is signed like the digest webhook: X-Shorthop-Signature:
// t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. Secrets are stored
// encrypted (AES-GCM, key derived from SESSION_SECRET) and shown only once.
// Endpoints must be public https addresses, and redirects aren't followed.

import { diffSnapshots, snapshotOf, type HistoryField } from "../shared/history";
import { isFetchableUrl } from "../shared/link-check";
import { fromBase64Url, toBase64Url } from "../shared/password";
import type { WebhookDTO, WebhookDeliveryDTO } from "../shared/types";
import { DELIVERY_RETENTION_DAYS, DELIVERY_TIMEOUT_MS, milestoneFor, RETRY_DELAYS_SEC, type WebhookEvent } from "../shared/webhooks";
import { getSetting, nowSec, setSettingStmt, type LinkRow } from "./db";
import { webhookSignature } from "./mailer";
import { planLimits } from "./plan";

// ---- Secrets ------------------------------------------------------------------

async function secretKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("shorthop-webhooks"), info: new TextEncoder().encode("webhook-secret-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function newSecret(): string {
  return `whsec_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function encryptSecret(env: Env, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await secretKey(env), new TextEncoder().encode(secret));
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(data))}`;
}

/** Null when it can't be decrypted (SESSION_SECRET changed): the owner rotates the secret. */
export async function decryptSecret(env: Env, stored: string): Promise<string | null> {
  const [v, ivText, dataText] = stored.split(":");
  const iv = fromBase64Url(ivText ?? "");
  const data = fromBase64Url(dataText ?? "");
  if (v !== "v1" || !iv || !data) return null;
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await secretKey(env), data));
  } catch {
    return null;
  }
}

// ---- Events ---------------------------------------------------------------------

const randomId = (prefix: string) => `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString());

/** A link as webhooks describe it. Never includes the password hash. */
export function linkPayload(row: LinkRow): Record<string, unknown> {
  return {
    domain: row.domain,
    slug: row.slug,
    short_url: `https://${row.domain}/${encodeURIComponent(row.slug)}`,
    target: row.target,
    title: row.title,
    tags: row.tags ? row.tags.split(",") : [],
    active: row.active === 1,
    expires_at: iso(row.expires_at),
    no_longer_working: row.broken === 1,
    password_protected: Boolean(row.password_hash),
    max_clicks: row.max_clicks,
    smart_routing: Boolean(row.routing),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

/** Field names as webhook payloads call them. */
const FIELD_NAMES: Record<HistoryField, string> = {
  target: "target",
  routing: "smart_routing",
  preview: "social_preview",
  qr: "qr_design",
  password_hash: "password",
  max_clicks: "max_clicks",
  title: "title",
  active: "active",
  expires_at: "expires_at",
  broken: "no_longer_working",
  replacement: "replacement",
  utm: "utm",
  utm_template: "utm_template",
  pass_query: "pass_query",
  monitor: "destination_checks",
  tags: "tags",
  notes: "notes",
};

/** What changed between two saved states of a link, by name. */
export function changedFields(before: LinkRow, after: LinkRow): string[] {
  return diffSnapshots(snapshotOf(before), snapshotOf(after)).map((c) => FIELD_NAMES[c.field]);
}

interface HookRow {
  id: number;
  url: string;
  description: string;
  events: string;
  secret: string;
  active: number;
  created_at: number;
  updated_at: number;
}

interface DeliveryRow {
  id: string;
  webhook_id: number;
  event_id: string;
  event_type: string;
  payload: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_at: number | null;
  last_status: number | null;
  last_error: string | null;
  last_at: number | null;
  duration_ms: number | null;
  created_at: number;
}

const subscribed = (h: HookRow, type: string) => {
  try {
    return (JSON.parse(h.events) as string[]).includes(type);
  } catch {
    return false;
  }
};

/**
 * Queues an event for every active endpoint that wants it. With `ctx`, the
 * deliveries are attempted right away in the background; otherwise the next
 * cron run sends them. Never throws: a webhook problem must not fail the
 * action that caused it.
 */
/** Anything that can keep background work alive (Workers' or Hono's execution context). */
export interface Background {
  waitUntil(p: Promise<unknown>): void;
}

export async function emit(env: Env, type: WebhookEvent, data: Record<string, unknown>, opts: { ctx?: Background; only?: number } = {}): Promise<string[]> {
  return emitAll(env, [{ type, data }], opts);
}

export interface Event {
  type: WebhookEvent;
  data: Record<string, unknown>;
}

/**
 * Queues several events in one D1 round trip (an import creates many links at
 * once). With `ctx`, the first `now` deliveries (the plan's allowance by
 * default) are attempted right away in the background; the cron sends the
 * rest a few at a time, so one request can't spend its whole subrequest
 * budget on webhooks.
 */
export async function emitAll(env: Env, events: readonly Event[], opts: { ctx?: Background; only?: number; now?: number } = {}): Promise<string[]> {
  if (!events.length) return [];
  try {
    const { results } = await env.DB.prepare("SELECT * FROM webhooks WHERE active = 1").all<HookRow>();
    const now = nowSec();
    const stmt = env.DB.prepare(
      "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
    );
    const writes: D1PreparedStatement[] = [];
    const ids: string[] = [];
    for (const { type, data } of events) {
      const hooks = results.filter((h) => (opts.only === undefined ? subscribed(h, type) : h.id === opts.only));
      if (!hooks.length) continue;
      const eventId = randomId("evt");
      const body = JSON.stringify({ id: eventId, type, created_at: iso(now), api_version: 1, data });
      for (const h of hooks) {
        const id = randomId("dlv");
        ids.push(id);
        writes.push(stmt.bind(id, h.id, eventId, type, body, now, now));
      }
    }
    if (!writes.length) return [];
    await env.DB.batch(writes);
    if (opts.ctx) {
      const first = ids.slice(0, opts.now ?? planLimits(env).deliveriesNow);
      if (first.length) opts.ctx.waitUntil(deliver(env, { ids: first }));
    }
    return ids;
  } catch (err) {
    console.error(JSON.stringify({ message: "webhook emit failed", types: [...new Set(events.map((e) => e.type))], error: String(err) }));
    return [];
  }
}

// ---- Delivery ---------------------------------------------------------------------

async function attempt(env: Env, d: DeliveryRow, hook: HookRow | undefined, fetcher: typeof fetch): Promise<void> {
  const now = nowSec();
  // Claim it first, so the cron and a background send can't both deliver it.
  const claim = await env.DB.prepare("UPDATE webhook_deliveries SET next_at = ?1 WHERE id = ?2 AND status = 'pending' AND next_at <= ?3")
    .bind(now + 600, d.id, now)
    .run();
  if (!claim.meta.changes) return;

  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  const secret = hook ? await decryptSecret(env, hook.secret) : null;
  if (!hook) error = "The webhook was deleted.";
  else if (!hook.active) error = "The webhook is paused.";
  else if (!secret) error = "The signing secret can't be read (SESSION_SECRET changed). Rotate the secret.";
  else {
    let url: URL | null = null;
    try {
      url = new URL(hook.url);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || !isFetchableUrl(url)) error = "The address isn't a public https:// address.";
    else {
      try {
        const res = await fetcher(url.href, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "ShorthopWebhooks/1.0",
            "X-Shorthop-Event": d.event_type,
            "X-Shorthop-Delivery": d.id,
            "X-Shorthop-Signature": await webhookSignature(secret, d.payload, Math.floor(Date.now() / 1000)),
          },
          body: d.payload,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        status = res.status;
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 300 && res.status < 400) error = "The endpoint redirected; redirects aren't followed. Use its final address.";
        else if (!res.ok) error = `The endpoint answered HTTP ${res.status}.`;
      } catch (err) {
        error = /timeout|abort/i.test(String(err)) ? "No answer within 10 seconds." : "Couldn't connect to the endpoint.";
      }
    }
  }

  const attempts = d.attempts + 1;
  const ms = Date.now() - started;
  if (!error) {
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?1, next_at = NULL, last_status = ?2, last_error = NULL, last_at = ?3, duration_ms = ?4 WHERE id = ?5",
    )
      .bind(attempts, status, now, ms, d.id)
      .run();
    return;
  }
  // Paused or deleted endpoints and unreadable secrets aren't retried (nothing would change),
  // and neither are test events: the owner is watching and can send another.
  const permanent = !hook || !hook.active || !secret || d.event_type === "webhook.test";
  const delay = RETRY_DELAYS_SEC[attempts - 1];
  const giveUp = permanent || delay === undefined;
  await env.DB.prepare(
    "UPDATE webhook_deliveries SET status = ?1, attempts = ?2, next_at = ?3, last_status = ?4, last_error = ?5, last_at = ?6, duration_ms = ?7 WHERE id = ?8",
  )
    .bind(giveUp ? "failed" : "pending", attempts, giveUp ? null : now + delay!, status, error, now, ms, d.id)
    .run();
}

/** Sends the given deliveries, or whatever is due (the cron) within the plan's budget: each costs a fetch and two D1 writes. */
export async function deliver(env: Env, opts: { ids?: string[]; budget?: number; fetcher?: typeof fetch } = {}): Promise<number> {
  const now = nowSec();
  const { results } = opts.ids
    ? await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'pending'").bind(JSON.stringify(opts.ids)).all<DeliveryRow>()
    : await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_at <= ?1 ORDER BY next_at LIMIT ?2")
        .bind(now, opts.budget ?? planLimits(env).cronDeliveries)
        .all<DeliveryRow>();
  if (!results.length) return 0;
  const { results: hooks } = await env.DB.prepare("SELECT * FROM webhooks WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify([...new Set(results.map((d) => d.webhook_id))]))
    .all<HookRow>();
  const byId = new Map(hooks.map((h) => [h.id, h]));
  await Promise.all(results.map((d) => attempt(env, d, byId.get(d.webhook_id), opts.fetcher ?? fetch).catch((err) => console.error(JSON.stringify({ message: "webhook delivery crashed", id: d.id, error: String(err) })))));
  return results.length;
}

/** Sends a delivery again now, as a new attempt (the log keeps the count). */
export async function redeliver(env: Env, id: string, ctx?: Background): Promise<boolean> {
  const { meta } = await env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', next_at = ?1 WHERE id = ?2").bind(nowSec(), id).run();
  if (!meta.changes) return false;
  const work = deliver(env, { ids: [id] });
  if (ctx) ctx.waitUntil(work);
  else await work;
  return true;
}

// ---- Milestones and cleanup ---------------------------------------------------------

/**
 * Daily, after the rollup: announces links that passed a click milestone. The
 * first run only records where every link stands, so a new subscriber isn't
 * flooded with milestones passed long ago.
 */
export async function checkMilestones(env: Env): Promise<number> {
  const { results: hooks } = await env.DB.prepare("SELECT * FROM webhooks WHERE active = 1").all<HookRow>();
  if (!hooks.some((h) => subscribed(h, "link.milestone"))) return 0;
  const started = (await getSetting(env.DB, "milestones_started")) === "1";
  const { results } = await env.DB.prepare(
    `SELECT t.domain, t.slug, t.clicks, m.milestone FROM
       (SELECT domain, slug, SUM(clicks) AS clicks FROM daily_dims WHERE dim = 'total' GROUP BY domain, slug) t
     JOIN links l ON l.domain = t.domain AND l.slug = t.slug
     LEFT JOIN link_milestones m ON m.domain = t.domain AND m.slug = t.slug`,
  ).all<{ domain: string; slug: string; clicks: number; milestone: number | null }>();
  const upsert = env.DB.prepare(
    "INSERT INTO link_milestones (domain, slug, milestone) VALUES (?, ?, ?) ON CONFLICT (domain, slug) DO UPDATE SET milestone = excluded.milestone",
  );
  const writes: D1PreparedStatement[] = [];
  const passed: { domain: string; slug: string; clicks: number; milestone: number }[] = [];
  for (const r of results) {
    const m = milestoneFor(r.clicks);
    if (m > (r.milestone ?? 0)) {
      writes.push(upsert.bind(r.domain, r.slug, m));
      if (started) passed.push({ domain: r.domain, slug: r.slug, clicks: r.clicks, milestone: m });
    }
  }
  if (!started) writes.push(setSettingStmt(env.DB, "milestones_started", "1"));
  if (writes.length) await env.DB.batch(writes);
  for (const p of passed) {
    const row = await env.DB.prepare("SELECT * FROM links WHERE domain = ? AND slug = ?").bind(p.domain, p.slug).first<LinkRow>();
    if (row) await emit(env, "link.milestone", { link: linkPayload(row), milestone: p.milestone, clicks_total: p.clicks });
  }
  return passed.length;
}

export async function pruneDeliveries(env: Env, now = nowSec()): Promise<void> {
  await env.DB.prepare("DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?").bind(now - DELIVERY_RETENTION_DAYS * 86400).run();
}

// ---- Admin views -------------------------------------------------------------------

export async function listWebhooks(env: Env): Promise<WebhookDTO[]> {
  const { results } = await env.DB.prepare(
    `SELECT h.*,
       (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = h.id AND d.status = 'pending' AND d.attempts > 0) AS retrying,
       (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id = h.id AND d.status = 'failed' AND d.created_at > ?1) AS failed_recent,
       (SELECT json_object('status', d.status, 'last_status', d.last_status, 'last_at', d.last_at, 'last_error', d.last_error)
          FROM webhook_deliveries d WHERE d.webhook_id = h.id AND d.last_at IS NOT NULL ORDER BY d.last_at DESC LIMIT 1) AS last
     FROM webhooks h ORDER BY h.created_at`,
  )
    .bind(nowSec() - 7 * 86400)
    .all<HookRow & { retrying: number; failed_recent: number; last: string | null }>();
  return Promise.all(
    results.map(async (h) => {
      const last = h.last ? (JSON.parse(h.last) as { status: string; last_status: number | null; last_at: number; last_error: string | null }) : null;
      return {
        id: h.id,
        url: h.url,
        description: h.description,
        events: JSON.parse(h.events) as string[],
        active: h.active === 1,
        createdAt: h.created_at,
        secretReadable: (await decryptSecret(env, h.secret)) !== null,
        retrying: h.retrying,
        failedRecent: h.failed_recent,
        last: last ? { ok: last.status === "delivered", httpStatus: last.last_status, at: last.last_at, error: last.last_error } : null,
      };
    }),
  );
}

export async function listDeliveries(env: Env, webhookId: number): Promise<WebhookDeliveryDTO[]> {
  const { results } = await env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, id LIMIT 100").bind(webhookId).all<DeliveryRow>();
  return results.map((d) => ({
    id: d.id,
    eventId: d.event_id,
    type: d.event_type,
    status: d.status,
    attempts: d.attempts,
    nextAt: d.next_at,
    httpStatus: d.last_status,
    error: d.last_error,
    lastAt: d.last_at,
    durationMs: d.duration_ms,
    createdAt: d.created_at,
    payload: d.payload,
  }));
}

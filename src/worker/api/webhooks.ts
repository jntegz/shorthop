import { Hono } from "hono";
import { z } from "zod";
import { can, PERMISSION_INFO, type Actor, type Permission } from "../../shared/permissions";
import { EVENT_TYPES, MAX_WEBHOOKS, WEBHOOK_EVENTS, webhookUrlProblem } from "../../shared/webhooks";
import { normalizeTags } from "../../shared/schemas";
import { nowSec } from "../db";
import { validate, type AppEnv } from "../hono";
import { deliver, emit, encryptSecret, listDeliveries, listWebhooks, newSecret, redeliver, resetClickHooks } from "../webhooks";

/** Events that carry data with its own permission: subscribing to them, or reading their payloads, needs it too. */
const EVENT_PERMISSION: Partial<Record<string, Permission>> = {
  "site.payment": "revenue.view",
  "site.traffic_spike": "stats.view",
  "link.milestone": "stats.view",
  // Every click's country, city, device and referrer.
  "link.clicked": "stats.view",
  // What the destination checks found, as on Link health.
  "link.health_changed": "health.manage",
};

function forbiddenEvent(actor: Actor, events: string[]): string | null {
  for (const e of events) {
    const need = EVENT_PERMISSION[e];
    if (need && !can(actor, need)) return `events: "${e}" needs the ${PERMISSION_INFO[need].label} permission.`;
  }
  return null;
}

/** Whether someone may see, and send again, a delivery of this event. */
const visible = (actor: Actor, type: string) => forbiddenEvent(actor, [type]) === null;

/**
 * The events a stored webhook carries: the ones it subscribes to, and those of
 * deliveries still waiting to be sent, which go to its address as it is when
 * they are (also after the event was taken off it). Undefined when there's no
 * such webhook.
 */
async function eventsOf(db: D1Database, id: number): Promise<string[] | undefined> {
  const [hook, waiting] = await db.batch<{ events?: string; event_type?: string }>([
    db.prepare("SELECT events FROM webhooks WHERE id = ?").bind(id),
    db.prepare("SELECT DISTINCT event_type FROM webhook_deliveries WHERE webhook_id = ? AND status = 'pending'").bind(id),
  ]);
  const row = hook?.results[0];
  if (!row) return undefined;
  let events: string[] = [];
  try {
    const v = JSON.parse(row.events ?? "") as unknown;
    if (Array.isArray(v)) events = v.filter((e): e is string => typeof e === "string");
  } catch {
    // Not JSON: no events of its own.
  }
  return [...new Set([...events, ...(waiting?.results ?? []).flatMap((r) => (r.event_type ? [r.event_type] : []))])];
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const body = z.object({
  url: z.string().trim().max(2048),
  description: z.string().trim().max(120).default(""),
  events: z.array(z.string()).min(1, "Choose at least one event").max(EVENT_TYPES.length),
  active: z.boolean().default(true),
  /** link.clicked: only links with one of these tags. */
  clickTags: z.array(z.string()).max(20).default([]),
});

const filtersOf = (b: z.infer<typeof body>) => {
  const tags = normalizeTags(b.clickTags);
  return tags.length ? JSON.stringify({ tags }) : null;
};

function check(b: z.infer<typeof body>): string | null {
  const urlProblem = webhookUrlProblem(b.url);
  if (urlProblem) return `url: ${urlProblem}`;
  const unknown = b.events.find((e) => !EVENT_TYPES.includes(e));
  return unknown ? `events: "${unknown}" isn't an event.` : null;
}

export const webhooksApi = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ webhooks: await listWebhooks(c.env), events: WEBHOOK_EVENTS }))

  /** The signing secret is in this answer only; it can't be read back later, only rotated. */
  .post("/", validate("json", body), async (c) => {
    // The link.clicked subscribers are cached a minute per isolate: read them again.
    resetClickHooks();
    const b = c.req.valid("json");
    const problem = check(b);
    if (problem) return c.json({ error: problem }, 400);
    const forbidden = forbiddenEvent(c.get("actor"), b.events);
    if (forbidden) return c.json({ error: forbidden }, 403);
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks").first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_WEBHOOKS) return c.json({ error: `Keep at most ${MAX_WEBHOOKS} webhooks.` }, 400);
    const secret = newSecret();
    const now = nowSec();
    const r = await c.env.DB.prepare("INSERT INTO webhooks (url, description, events, secret, active, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(new URL(b.url).href, b.description, JSON.stringify([...new Set(b.events)]), await encryptSecret(c.env, "webhook", secret), b.active ? 1 : 0, filtersOf(b), now, now)
      .first<{ id: number }>();
    return c.json({ id: r!.id, secret, webhooks: await listWebhooks(c.env) }, 201);
  })

  .put("/:id", validate("param", idParam), validate("json", body), async (c) => {
    // The link.clicked subscribers are cached a minute per isolate: read them again.
    resetClickHooks();
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const problem = check(b);
    if (problem) return c.json({ error: problem }, 400);
    // Changing where a webhook sends needs the permission for what it already carries (deliveries still
    // waiting included), and for what it will.
    const before = await eventsOf(c.env.DB, id);
    if (!before) return c.json({ error: "Webhook not found" }, 404);
    const forbidden = forbiddenEvent(c.get("actor"), [...before, ...b.events]);
    if (forbidden) return c.json({ error: forbidden }, 403);
    const { meta } = await c.env.DB.prepare("UPDATE webhooks SET url = ?, description = ?, events = ?, active = ?, filters = ?, updated_at = ? WHERE id = ?")
      .bind(new URL(b.url).href, b.description, JSON.stringify([...new Set(b.events)]), b.active ? 1 : 0, filtersOf(b), nowSec(), id)
      .run();
    if (!meta.changes) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ webhooks: await listWebhooks(c.env) });
  })

  /** A new secret; the old one stops working at once. */
  .post("/:id/rotate", validate("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    // Whoever holds the secret can sign as this webhook: the same permissions as changing it.
    const forbidden = forbiddenEvent(c.get("actor"), (await eventsOf(c.env.DB, id)) ?? []);
    if (forbidden) return c.json({ error: forbidden }, 403);
    const secret = newSecret();
    const { meta } = await c.env.DB.prepare("UPDATE webhooks SET secret = ?, updated_at = ? WHERE id = ?").bind(await encryptSecret(c.env, "webhook", secret), nowSec(), id).run();
    if (!meta.changes) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ secret, webhooks: await listWebhooks(c.env) });
  })

  .delete("/:id", validate("param", idParam), async (c) => {
    // The link.clicked subscribers are cached a minute per isolate: read them again.
    resetClickHooks();
    const { id } = c.req.valid("param");
    const [, del] = await c.env.DB.batch([c.env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").bind(id), c.env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(id)]);
    if (!del?.meta.changes) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ webhooks: await listWebhooks(c.env) });
  })

  /** Sends a webhook.test event to this endpoint now and reports how it went. */
  .post("/:id/test", validate("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const ids = await emit(c.env, "webhook.test", { message: "A test event from Shorthop. Your endpoint received and can verify webhooks." }, { only: id });
    if (!ids.length) return c.json({ error: "Webhook not found, or paused" }, 404);
    await deliver(c.env, { ids });
    const delivery = (await listDeliveries(c.env, id)).find((d) => d.id === ids[0]);
    return c.json({ delivery: delivery! });
  })

  /** Deliveries of events the caller may not see are left out, and only counted in `hidden`. */
  .get("/:id/deliveries", validate("param", idParam), async (c) => {
    const all = await listDeliveries(c.env, c.req.valid("param").id);
    const deliveries = all.filter((d) => visible(c.get("actor"), d.type));
    return c.json({ deliveries, hidden: all.length - deliveries.length });
  })

  .post("/deliveries/:delivery/redeliver", validate("param", z.object({ delivery: z.string().regex(/^dlv_[A-Za-z0-9_-]{16}$/) })), async (c) => {
    const id = c.req.valid("param").delivery;
    const row = await c.env.DB.prepare("SELECT webhook_id, event_type FROM webhook_deliveries WHERE id = ?").bind(id).first<{ webhook_id: number; event_type: string }>();
    if (!row) return c.json({ error: "Delivery not found" }, 404);
    // Sending it again posts the stored payload to the webhook's address as it is now.
    const forbidden = forbiddenEvent(c.get("actor"), [row.event_type]);
    if (forbidden) return c.json({ error: forbidden }, 403);
    if (!(await redeliver(c.env, id))) return c.json({ error: "Delivery not found" }, 404);
    const delivery = (await listDeliveries(c.env, row.webhook_id)).find((d) => d.id === id);
    return c.json({ delivery: delivery! });
  });

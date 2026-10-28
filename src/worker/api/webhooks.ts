import { Hono } from "hono";
import { z } from "zod";
import { EVENT_TYPES, MAX_WEBHOOKS, WEBHOOK_EVENTS, webhookUrlProblem } from "../../shared/webhooks";
import { nowSec } from "../db";
import { validate, type AppEnv } from "../hono";
import { deliver, emit, encryptSecret, listDeliveries, listWebhooks, newSecret, redeliver } from "../webhooks";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const body = z.object({
  url: z.string().trim().max(2048),
  description: z.string().trim().max(120).default(""),
  events: z.array(z.string()).min(1, "Choose at least one event").max(EVENT_TYPES.length),
  active: z.boolean().default(true),
});

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
    const b = c.req.valid("json");
    const problem = check(b);
    if (problem) return c.json({ error: problem }, 400);
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks").first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_WEBHOOKS) return c.json({ error: `Keep at most ${MAX_WEBHOOKS} webhooks.` }, 400);
    const secret = newSecret();
    const now = nowSec();
    const r = await c.env.DB.prepare("INSERT INTO webhooks (url, description, events, secret, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(new URL(b.url).href, b.description, JSON.stringify([...new Set(b.events)]), await encryptSecret(c.env, "webhook", secret), b.active ? 1 : 0, now, now)
      .first<{ id: number }>();
    return c.json({ id: r!.id, secret, webhooks: await listWebhooks(c.env) }, 201);
  })

  .put("/:id", validate("param", idParam), validate("json", body), async (c) => {
    const { id } = c.req.valid("param");
    const b = c.req.valid("json");
    const problem = check(b);
    if (problem) return c.json({ error: problem }, 400);
    const { meta } = await c.env.DB.prepare("UPDATE webhooks SET url = ?, description = ?, events = ?, active = ?, updated_at = ? WHERE id = ?")
      .bind(new URL(b.url).href, b.description, JSON.stringify([...new Set(b.events)]), b.active ? 1 : 0, nowSec(), id)
      .run();
    if (!meta.changes) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ webhooks: await listWebhooks(c.env) });
  })

  /** A new secret; the old one stops working at once. */
  .post("/:id/rotate", validate("param", idParam), async (c) => {
    const { id } = c.req.valid("param");
    const secret = newSecret();
    const { meta } = await c.env.DB.prepare("UPDATE webhooks SET secret = ?, updated_at = ? WHERE id = ?").bind(await encryptSecret(c.env, "webhook", secret), nowSec(), id).run();
    if (!meta.changes) return c.json({ error: "Webhook not found" }, 404);
    return c.json({ secret, webhooks: await listWebhooks(c.env) });
  })

  .delete("/:id", validate("param", idParam), async (c) => {
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

  .get("/:id/deliveries", validate("param", idParam), async (c) => c.json({ deliveries: await listDeliveries(c.env, c.req.valid("param").id) }))

  .post("/deliveries/:delivery/redeliver", validate("param", z.object({ delivery: z.string().regex(/^dlv_[A-Za-z0-9_-]{16}$/) })), async (c) => {
    const id = c.req.valid("param").delivery;
    if (!(await redeliver(c.env, id))) return c.json({ error: "Delivery not found" }, 404);
    const row = await c.env.DB.prepare("SELECT webhook_id FROM webhook_deliveries WHERE id = ?").bind(id).first<{ webhook_id: number }>();
    const delivery = (await listDeliveries(c.env, row!.webhook_id)).find((d) => d.id === id);
    return c.json({ delivery: delivery! });
  });

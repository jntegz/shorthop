import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookDTO, WebhookDeliveryDTO } from "../src/shared/types";
import { runLinkChecks } from "../src/worker/link-check";
import { webhookSignature } from "../src/worker/mailer";
import { checkMilestones, deliver } from "../src/worker/webhooks";
import { API, bearer, call, json, resetData } from "./helpers";

const HOOK = "https://hooks.example.com/shorthop";
type Sent = { url: string; headers: Record<string, string>; body: string };
let sent: Sent[];
let reply: (url: string) => Response;

beforeEach(async () => {
  await resetData();
  sent = [];
  reply = () => new Response("ok", { status: 200 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === HOOK) {
      sent.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
      return reply(url);
    }
    // Destination checks in the health test.
    return new Response(null, { status: url.includes("gone") ? 404 : 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function addHook(events = ["link.created", "link.updated", "link.deleted", "link.health_changed", "link.milestone"], url = HOOK) {
  const res = await call(`${API}/webhooks`, json({ url, events }));
  return { res, body: (await res.json()) as { id: number; secret: string; webhooks: WebhookDTO[]; error?: string } };
}
const deliveries = async (id: number) => ((await (await call(`${API}/webhooks/${id}/deliveries`, { headers: bearer })).json()) as { deliveries: WebhookDeliveryDTO[] }).deliveries;
const makeDue = () => env.DB.prepare("UPDATE webhook_deliveries SET next_at = 0 WHERE status = 'pending'").run();
const createLink = (slug: string, extra: Record<string, unknown> = {}) => call(`${API}/links`, json({ slug, target: "https://example.com/page", ...extra }));

describe("endpoints", () => {
  it("returns the secret once, keeps it encrypted, and refuses unsafe addresses", async () => {
    const { res, body } = await addHook();
    expect(res.status).toBe(201);
    expect(body.secret).toMatch(/^whsec_/);
    expect(JSON.stringify(body.webhooks)).not.toContain(body.secret);
    const stored = await env.DB.prepare("SELECT secret FROM webhooks").first<{ secret: string }>();
    expect(stored!.secret).toMatch(/^v1:/);
    expect(stored!.secret).not.toContain(body.secret.slice(6, 20));
    for (const bad of ["http://hooks.example.com/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://hooks.local/x", "https://user:pw@hooks.example.com/"]) {
      expect((await addHook(undefined, bad)).res.status, bad).toBe(400);
    }
    expect((await call(`${API}/webhooks`, json({ url: HOOK, events: ["link.exploded"] }))).status).toBe(400);
  });
});

describe("events", () => {
  it("sends link.created at once, signed so the receiver can verify it", async () => {
    const { body } = await addHook();
    await createLink("guide", { title: "Guide", password: "open sesame" });
    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.headers["x-shorthop-event"]).toBe("link.created");
    expect(s.headers["x-shorthop-delivery"]).toMatch(/^dlv_/);
    const t = Number(/^t=(\d+),/.exec(s.headers["x-shorthop-signature"]!)![1]);
    expect(s.headers["x-shorthop-signature"]).toBe(await webhookSignature(body.secret, s.body, t));
    const payload = JSON.parse(s.body) as { id: string; type: string; api_version: number; data: { link: Record<string, unknown> } };
    expect(payload).toMatchObject({ type: "link.created", api_version: 1, data: { link: { slug: "guide", short_url: "https://sh.example/guide", title: "Guide", password_protected: true } } });
    expect(s.body).not.toContain("pbkdf2");
    expect((await deliveries(body.id))[0]).toMatchObject({ status: "delivered", httpStatus: 200, attempts: 1 });
  });

  it("names what changed, skips saves that change nothing, and announces deletes", async () => {
    await addHook();
    await createLink("guide");
    await call(`${API}/links/sh.example/guide`, { ...json({ target: "https://example.com/new", tags: ["a"] }), method: "PATCH" });
    await call(`${API}/links/sh.example/guide`, { ...json({ tags: ["a"] }), method: "PATCH" });
    await call(`${API}/links/sh.example/guide`, { method: "DELETE", headers: bearer });
    const events = sent.map((s) => JSON.parse(s.body) as { type: string; data: { changes?: string[] } });
    expect(events.map((e) => e.type)).toEqual(["link.created", "link.updated", "link.deleted"]);
    expect(events[1]!.data.changes).toEqual(["target", "tags"]);
  });

  it("only sends what an endpoint subscribed to, and nothing while paused", async () => {
    const { body } = await addHook(["link.deleted"]);
    await createLink("guide");
    expect(sent).toHaveLength(0);
    await call(`${API}/webhooks/${body.id}`, { ...json({ url: HOOK, events: ["link.created"], active: false }), method: "PUT" });
    await createLink("other");
    expect(sent).toHaveLength(0);
  });

  it("announces a destination going down and coming back, via the cron", async () => {
    await addHook(["link.health_changed"]);
    await createLink("dead", { target: "https://gone.example.com/" });
    for (let i = 0; i < 3; i++) {
      await runLinkChecks(env);
      await env.DB.prepare("UPDATE target_checks SET next_at = 0").run();
    }
    expect(sent).toHaveLength(0); // queued, not sent from the checks run
    await deliver(env);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ type: "link.health_changed", data: { destination: "https://gone.example.com/", state: "down", problem: "not_found", links: [{ slug: "dead" }] } });
  });

  it("announces each click milestone once, after a quiet first run", async () => {
    await addHook(["link.milestone"]);
    await createLink("guide");
    const addClicks = (date: string, clicks: number) =>
      env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, 'sh.example', 'guide', 'total', '', ?, 0, 0)").bind(date, clicks).run();
    await addClicks("2026-10-01", 150);
    expect(await checkMilestones(env)).toBe(0); // baseline: 100 already passed
    await addClicks("2026-10-02", 400);
    expect(await checkMilestones(env)).toBe(1);
    expect(await checkMilestones(env)).toBe(0);
    await deliver(env);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ type: "link.milestone", data: { milestone: 500, clicks_total: 550, link: { slug: "guide" } } });
  });
});

describe("delivery", () => {
  it("retries failures with backoff, then gives up", async () => {
    const { body } = await addHook(["link.created"]);
    reply = () => new Response("nope", { status: 500 });
    await createLink("guide");
    let [d] = await deliveries(body.id);
    expect(d).toMatchObject({ status: "pending", attempts: 1, httpStatus: 500, error: "The endpoint answered HTTP 500." });
    expect(d!.nextAt! - d!.lastAt!).toBe(30 * 60);
    for (let i = 0; i < 6; i++) {
      await makeDue();
      await deliver(env);
    }
    [d] = await deliveries(body.id);
    expect(d).toMatchObject({ status: "failed", attempts: 6 });

    reply = () => new Response("ok");
    const res = await call(`${API}/webhooks/deliveries/${d!.id}/redeliver`, { method: "POST", headers: bearer });
    expect(((await res.json()) as { delivery: WebhookDeliveryDTO }).delivery).toMatchObject({ status: "delivered", attempts: 7 });
  });

  it("doesn't follow redirects", async () => {
    const { body } = await addHook(["link.created"]);
    reply = () => new Response(null, { status: 301, headers: { Location: "https://elsewhere.example.com/" } });
    await createLink("guide");
    expect((await deliveries(body.id))[0]).toMatchObject({ status: "pending", httpStatus: 301, error: expect.stringContaining("redirect") });
    expect(sent).toHaveLength(1);
  });

  it("sends a test event on request, and signs with a rotated secret", async () => {
    const { body } = await addHook(["link.created"]);
    const test = await call(`${API}/webhooks/${body.id}/test`, { method: "POST", headers: bearer });
    expect(((await test.json()) as { delivery: WebhookDeliveryDTO }).delivery).toMatchObject({ type: "webhook.test", status: "delivered" });
    reply = () => new Response(null, { status: 405 });
    const failedTest = await call(`${API}/webhooks/${body.id}/test`, { method: "POST", headers: bearer });
    expect(((await failedTest.json()) as { delivery: WebhookDeliveryDTO }).delivery).toMatchObject({ status: "failed", httpStatus: 405, nextAt: null });
    reply = () => new Response("ok");
    const { secret } = (await (await call(`${API}/webhooks/${body.id}/rotate`, { method: "POST", headers: bearer })).json()) as { secret: string };
    expect(secret).not.toBe(body.secret);
    await createLink("guide");
    const s = sent.at(-1)!;
    const t = Number(/^t=(\d+),/.exec(s.headers["x-shorthop-signature"]!)![1]);
    expect(s.headers["x-shorthop-signature"]).toBe(await webhookSignature(secret, s.body, t));
    await call(`${API}/webhooks/${body.id}`, { method: "DELETE", headers: bearer });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

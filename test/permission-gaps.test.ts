// What a limited person or key must not reach through a side door: payment
// payloads through someone else's webhook, revenue reports through the share
// list, missed visits and click counts without their permission, and a reset
// link that outlives a new password.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapDTO, LinkDTO, RecentHit, ShareDTO, VersionDTO, WebhookDeliveryDTO } from "../src/shared/types";
import { hashPassword } from "../src/shared/password";
import { nowSec } from "../src/worker/db";
import { sha256Hex } from "../src/worker/users";
import { aePoint, mockAeSql, type StoredPoint } from "./ae-mock";
import { API, bearer, call, captureClicks, json, ORIGIN, putLink, resetData } from "./helpers";
import { addKey, addUser, adminCall, as, LOCAL } from "./people";

const HOOK = "https://hooks.example.com/shorthop";
const ELSEWHERE = "https://elsewhere.example.net/x";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

describe("webhooks carry data with its own permission", () => {
  const SETTINGS_ONLY = "settings@example.com";
  let sent: { url: string; body: string }[];

  beforeEach(async () => {
    sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent.push({ url: String(input), body: String(init?.body) });
      return new Response("ok");
    });
    await addUser(SETTINGS_ONLY, "user", ["settings.manage"]);
  });

  const addHook = async (events: string[]) => ((await (await call(`${API}/webhooks`, json({ url: HOOK, events }))).json()) as { id: number }).id;
  const urlOf = async (id: number) => (await env.DB.prepare("SELECT url FROM webhooks WHERE id = ?").bind(id).first<{ url: string }>())!.url;
  const payment = (hook: number) =>
    env.DB.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, created_at) VALUES ('dlv_pay0123456789abc', ?1, 'e1', 'site.payment', ?2, 'delivered', 2)")
      .bind(hook, JSON.stringify({ data: { payment: { email: "buyer@example.com", amount: 49 } } }))
      .run();

  it("can't be pointed elsewhere, or have its events swapped, by someone who may not see what it carries", async () => {
    const id = await addHook(["site.payment", "link.created"]);
    // Dropping the payment event from the request doesn't make the change allowed.
    for (const events of [["link.created"], ["site.payment", "link.created"]]) {
      const res = await adminCall(SETTINGS_ONLY, `/webhooks/${id}`, { method: "PUT", body: { url: ELSEWHERE, events } });
      expect(res.status, events.join()).toBe(403);
    }
    expect(await urlOf(id)).toBe(HOOK);
    // A new secret would let them sign as it.
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}/rotate`, { method: "POST" })).status).toBe(403);

    // A webhook without such events is theirs to change, but not to subscribe to payments.
    const plain = await addHook(["link.created"]);
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${plain}`, { method: "PUT", body: { url: ELSEWHERE, events: ["link.created", "site.payment"] } })).status).toBe(403);
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${plain}`, { method: "PUT", body: { url: ELSEWHERE, events: ["link.deleted"] } })).status).toBe(200);
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${plain}/rotate`, { method: "POST" })).status).toBe(200);

    // The owner changes either.
    expect((await call(`${API}/webhooks/${id}`, { ...json({ url: ELSEWHERE, events: ["site.payment"] }), method: "PUT" })).status).toBe(200);
    expect(await urlOf(id)).toBe(ELSEWHERE);
    expect((await call(`${API}/webhooks/${id}/rotate`, { method: "POST", headers: bearer })).status).toBe(200);
    expect((await call(`${API}/webhooks/999`, { ...json({ url: ELSEWHERE, events: ["link.created"] }), method: "PUT" })).status).toBe(404);
  });

  it("doesn't list or send again a delivery of an event someone may not see", async () => {
    const id = await addHook(["site.payment", "link.created"]);
    await payment(id);
    await env.DB.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, created_at) VALUES ('dlv_link0123456789ab', ?1, 'e2', 'link.created', '{\"slug\":\"a\"}', 'delivered', 1)")
      .bind(id)
      .run();

    const listed = (await (await adminCall(SETTINGS_ONLY, `/webhooks/${id}/deliveries`)).json()) as { deliveries: WebhookDeliveryDTO[]; hidden: number };
    expect(listed.deliveries.map((d) => d.id)).toEqual(["dlv_link0123456789ab"]);
    expect(listed.hidden).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("dlv_pay");

    // Even knowing the id.
    const refused = await adminCall(SETTINGS_ONLY, "/webhooks/deliveries/dlv_pay0123456789abc/redeliver", { method: "POST" });
    expect(refused.status).toBe(403);
    expect(sent).toEqual([]);
    expect((await adminCall(SETTINGS_ONLY, "/webhooks/deliveries/dlv_link0123456789ab/redeliver", { method: "POST" })).status).toBe(200);
    expect(sent.map((s) => s.body)).toEqual(['{"slug":"a"}']);
    // A test event carries nothing.
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}/test`, { method: "POST" })).status).toBe(200);

    const owner = await call(`${API}/webhooks/deliveries/dlv_pay0123456789abc/redeliver`, { method: "POST", headers: bearer });
    expect(owner.status).toBe(200);
    expect(sent.at(-1)!.body).toContain("buyer@example.com");
    expect((await call(`${API}/webhooks/deliveries/dlv_gone0123456789ab/redeliver`, { method: "POST", headers: bearer })).status).toBe(404);
  });

  it("can't be pointed elsewhere while payment deliveries still wait for it, even after the event was taken off", async () => {
    const id = await addHook(["site.payment", "link.created"]);
    // A retry still waiting, then the owner takes the payment event off.
    await env.DB.prepare(
      "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, next_at, created_at) VALUES ('dlv_wait0123456789ab', ?1, 'e3', 'site.payment', ?2, 'pending', 0, 2)",
    )
      .bind(id, JSON.stringify({ data: { payment: { email: "buyer@example.com" } } }))
      .run();
    expect((await call(`${API}/webhooks/${id}`, { ...json({ url: HOOK, events: ["link.created"] }), method: "PUT" })).status).toBe(200);

    // The retry would go to the new address: changing it needs what the retry carries.
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}`, { method: "PUT", body: { url: ELSEWHERE, events: ["link.created"] } })).status).toBe(403);
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}/rotate`, { method: "POST" })).status).toBe(403);
    expect(await urlOf(id)).toBe(HOOK);

    // Once it is sent, nothing of the kind is left.
    await env.DB.prepare("UPDATE webhook_deliveries SET status = 'delivered' WHERE id = 'dlv_wait0123456789ab'").run();
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}`, { method: "PUT", body: { url: ELSEWHERE, events: ["link.created"] } })).status).toBe(200);
    expect(await urlOf(id)).toBe(ELSEWHERE);
  });

  it("needs Link health for the destination-check events", async () => {
    expect((await adminCall(SETTINGS_ONLY, "/webhooks", { body: { url: HOOK, events: ["link.health_changed"] } })).status).toBe(403);
    await addUser("both@example.com", "user", ["settings.manage", "health.manage"]);
    expect((await adminCall("both@example.com", "/webhooks", { body: { url: HOOK, events: ["link.health_changed"] } })).status).toBe(201);
  });

  it("needs See statistics for the stream of every click", async () => {
    expect((await adminCall(SETTINGS_ONLY, "/webhooks", { body: { url: HOOK, events: ["link.clicked"] } })).status).toBe(403);
    const { auth } = await addKey("owner@example.com", ["settings.manage"]);
    expect((await call(`${API}/webhooks`, { ...json({ url: HOOK, events: ["link.clicked"] }), headers: { ...auth, "Content-Type": "application/json" } })).status).toBe(403);
    await addUser("both@example.com", "user", ["settings.manage", "stats.view"]);
    expect((await adminCall("both@example.com", "/webhooks", { body: { url: HOOK, events: ["link.clicked"] } })).status).toBe(201);
    expect((await call(`${API}/webhooks`, json({ url: HOOK, events: ["link.clicked"] }))).status).toBe(201);
  });
});

describe("reports with revenue", () => {
  const SHARER = "sharer@example.com";
  const reports = async (email: string) => ((await (await adminCall(email, "/shares")).json()) as { shares: ShareDTO[] }).shares;

  it("keeps the address and the settings of a report with revenue from someone without See revenue", async () => {
    await addUser(SHARER, "user", ["stats.view", "links.edit"]);
    const made = async (title: string, showRevenue: boolean) =>
      ((await (await call(`${API}/shares`, json({ scope: "tag", tag: "launch", title, showRevenue, password: "open sesame 1" }))).json()) as { share: ShareDTO }).share;
    const money = await made("With revenue", true);
    const plain = await made("Clicks only", false);
    expect(money.url).toContain("/_share/");

    const seen = await reports(SHARER);
    // It's listed, without the way in.
    expect(seen.find((s) => s.id === money.id)).toMatchObject({ title: "With revenue", showRevenue: true, url: null, protected: true });
    const path = (url: string | null) => new URL(url!).pathname;
    expect(path(seen.find((s) => s.id === plain.id)!.url)).toBe(path(plain.url));
    expect(JSON.stringify(seen)).not.toContain(money.url!.split(".").pop());

    for (const body of [{ password: null }, { password: "another password" }, { expiresAt: null }, { rangeLimit: "7d" }, { showRecent: true }, { revoke: true, password: null }]) {
      const res = await adminCall(SHARER, `/shares/${money.id}`, { method: "PATCH", body });
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    expect(await env.DB.prepare("SELECT password_hash IS NOT NULL AS locked, revoked_at FROM stat_shares WHERE id = ?").bind(money.id).first()).toEqual({ locked: 1, revoked_at: null });
    // Their own kind of report is theirs to change, and they can't make one with revenue.
    expect((await adminCall(SHARER, `/shares/${plain.id}`, { method: "PATCH", body: { password: null } })).status).toBe(200);
    expect((await adminCall(SHARER, "/shares", { body: { scope: "tag", tag: "launch", title: "Mine", showRevenue: true } })).status).toBe(403);

    // The owner sees the address and changes it.
    expect(path((await reports("")).find((s) => s.id === money.id)!.url)).toBe(path(money.url));
    const opened = await call(`${API}/shares/${money.id}`, { ...json({ password: null }), method: "PATCH" });
    expect(((await opened.json()) as { share: ShareDTO }).share).toMatchObject({ protected: false, url: money.url });

    // Stopping it is managing it too: only for someone who may see revenue.
    expect((await adminCall(SHARER, `/shares/${money.id}`, { method: "PATCH", body: { revoke: true } })).status).toBe(403);
  });
});

describe("import and restore check a new destination again", () => {
  const ON = { SAFETY_DNS: "" } as Partial<Env>;
  beforeEach(() => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.hostname !== "security.cloudflare-dns.com") return real(input, init);
      const name = url.searchParams.get("name") ?? "";
      const bad = name.startsWith("phish.");
      return Response.json({ Status: 0, Answer: [{ name, type: 1, data: bad ? "0.0.0.0" : "93.184.215.14" }], ...(bad ? { Comment: ["EDE(16): Censored"] } : {}) });
    });
  });

  const safety = (slug: string) => env.DB.prepare("SELECT unsafe, unsafe_at IS NULL AS unchecked FROM links WHERE slug = ?").bind(slug).first<{ unsafe: number; unchecked: number }>();
  const create = (slug: string, target: string) => call(`${API}/links`, json({ slug, target }), ON);
  const patch = (slug: string, body: unknown) => call(`${API}/links/sh.example/${slug}`, { ...json(body), method: "PATCH" }, ON);
  const overwrite = (rows: unknown[]) => call(`${API}/import`, json({ mode: "overwrite", rows }), ON);

  it("doesn't carry a flag or 'trusted anyway' over to an imported destination", async () => {
    await create("trusted", "https://phish.example.net/a");
    await patch("trusted", { trustDestination: true });
    await create("flagged", "https://phish.example.net/b");
    await create("same", "https://phish.example.net/c");
    await patch("same", { trustDestination: true });
    expect(await safety("trusted")).toEqual({ unsafe: 2, unchecked: 0 });

    const res = await overwrite([
      { slug: "trusted", target: "https://phish.other.example/new" },
      { slug: "flagged", target: "https://fine.example.org/" },
      { slug: "same", target: "https://phish.example.net/c" },
    ]);
    expect(res.status).toBe(200);
    // Looked up in the import itself: the new destination's own answer, not the old link's.
    expect(await safety("trusted")).toEqual({ unsafe: 1, unchecked: 0 });
    expect(await safety("flagged")).toEqual({ unsafe: 0, unchecked: 0 });
    expect(await env.LINKS.get("sh.example/trusted", "json")).toMatchObject({ w: 1 });
    expect((await env.LINKS.get<{ w?: number }>("sh.example/flagged", "json"))!.w).toBeUndefined();
    // The same destination keeps the owner's decision.
    expect(await safety("same")).toEqual({ unsafe: 2, unchecked: 0 });
  });

  it("looks an older destination up again when a version is restored", async () => {
    await create("moved", "https://phish.example.net/login");
    await patch("moved", { target: "https://fine.example.org/" });
    expect((await safety("moved"))!.unsafe).toBe(0);
    const { versions } = (await (await call(`${API}/links/sh.example/moved/history`, { headers: bearer })).json()) as { versions: VersionDTO[] };
    const first = versions.find((v) => v.action === "create")!;
    const restored = await call(`${API}/links/sh.example/moved/history/${first.id}/restore`, { method: "POST", headers: bearer }, ON);
    expect(((await restored.json()) as { link: LinkDTO }).link.unsafe).toBe("flagged");
    expect(await env.LINKS.get("sh.example/moved", "json")).toMatchObject({ w: 1 });

    // And back: "trusted anyway" on the bad one doesn't follow to another destination and return with it.
    await patch("moved", { trustDestination: true });
    const fine = versions.find((v) => v.snapshot.target === "https://fine.example.org/")!;
    const back = await call(`${API}/links/sh.example/moved/history/${fine.id}/restore`, { method: "POST", headers: bearer }, ON);
    expect(((await back.json()) as { link: LinkDTO }).link.unsafe).toBeNull();
  });
});

describe("statistics without the permission", () => {
  const AE_ENV = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" };
  const STATS = "stats@example.com";
  const HEALTH = "health@example.com";
  const VIEWER = "viewer@example.com";

  it("keeps missed visits out of recent hits without Link health", async () => {
    await addUser(STATS, "user", ["stats.view"]);
    await addUser(HEALTH, "user", ["stats.view", "health.manage", "api.use"]);
    await putLink("guide", { u: "https://example.com/guide" });
    const { points, CLICKS } = captureClicks();
    for (const path of ["/guide", "/tyop", "/typo"]) {
      await call(new Request(`${ORIGIN}${path}`, { headers: { "User-Agent": CHROME, "CF-Connecting-IP": "198.51.100.1" }, cf: { country: "CZ", city: "Prague" } } as RequestInit), undefined, { CLICKS });
    }
    const store: StoredPoint[] = points.map((p) => aePoint(p, Math.floor(Date.now() / 1000) - 30));
    expect(store.some((p) => p.blobs[0] === "miss")).toBe(true);
    mockAeSql(store);

    const recent = (email: string, q = "") => adminCall(email, `/stats/recent?limit=200${q}`, {}, AE_ENV);
    const events = async (res: Response) => ((await res.json()) as { hits: RecentHit[] }).hits.map((h) => h.event);

    const asked = await recent(STATS, "&event=miss");
    expect(asked.status).toBe(403);
    expect(await asked.json()).toMatchObject({ code: "forbidden" });
    // Every type: the clicks, without the misses.
    expect(await events(await recent(STATS))).toEqual(["click"]);
    expect(await events(await recent(STATS, "&event=click"))).toEqual(["click"]);
    const { auth } = await addKey(HEALTH, ["stats.view"]);
    expect((await call(`${API}/stats/recent?event=miss`, { headers: auth }, AE_ENV)).status).toBe(403);

    expect((await events(await recent(HEALTH, "&event=miss"))).every((e) => e === "miss")).toBe(true);
    expect((await events(await recent(HEALTH))).sort()).toEqual(["click", "miss", "miss"]);
    expect((await events(await recent(""))).filter((e) => e === "miss")).toHaveLength(2);
  });

  it("answers a failing query without Analytics Engine's own words", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Invalid query near account acc-internal-detail", { status: 422 }));
    const failed = (await (await call(`${API}/stats/recent`, { headers: bearer }, AE_ENV)).json()) as { aeAvailable: boolean; error?: string };
    expect(failed.aeAvailable).toBe(true);
    expect(failed.error).toBe("Analytics Engine didn't answer. Try again in a moment.");
  });

  it("hides a capped link's count and imported clicks without See statistics", async () => {
    await addUser(VIEWER);
    await addUser(STATS, "user", ["stats.view"]);
    expect((await call(`${API}/import`, json({ rows: [{ slug: "old", target: "https://example.com/old", clicks: 1234 }] }))).status).toBe(200);
    expect((await call(`${API}/links/sh.example/old`, { ...json({ maxClicks: 5 }), method: "PATCH" })).status).toBe(200);

    const cap = async (email: string) => (await (await adminCall(email, "/links/sh.example/old/cap")).json()) as CapDTO;
    expect(await cap(VIEWER)).toEqual({ limit: 5, count: null });
    expect(await cap(STATS)).toEqual({ limit: 5, count: 0 });

    const link = async (email: string) => ((await (await adminCall(email, "/links/sh.example/old")).json()) as { link: LinkDTO }).link;
    expect((await link(VIEWER)).importedClicks).toBeNull();
    expect((await link(STATS)).importedClicks).toBe(1234);

    for (const path of ["/links", "/export/links.json", "/export/links.csv", "/links/sh.example/old/history"]) {
      expect(await (await adminCall(VIEWER, path)).text(), path).not.toContain("1234");
      expect(await (await adminCall(STATS, path)).text(), path).toContain("1234");
    }
    const { auth } = await addKey("owner@example.com", []);
    expect(await (await call(`${API}/export/links.json`, { headers: auth })).text()).not.toContain("1234");
  });
});

describe("a new password ends the links that could set another", () => {
  const ANNA = "anna@example.com";
  const PASSWORD = "a-long-enough-password";
  const NEW_PASSWORD = "a-brand-new-password-1";
  const TOKEN = "r".repeat(43);
  const INVITE = "i".repeat(43);
  const limiter = { limit: async () => ({ success: true }) } as RateLimit;
  let withLogin: Partial<Env>;
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams(fields).toString(),
  });
  const pending = () => env.DB.prepare("SELECT reset_hash, reset_expires, invite_hash, invite_expires FROM users WHERE email = ?").bind(ANNA).first();
  const NONE = { reset_hash: null, reset_expires: null, invite_hash: null, invite_expires: null };

  beforeEach(async () => {
    withLogin = as(ANNA, { ADMIN_PASSWORD_HASH: await hashPassword("owner-password-0123", 10_000), LOGIN_LIMITER: limiter });
  });

  it("drops an emailed reset link when you change your password yourself", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    await env.DB.prepare("UPDATE users SET reset_hash = ?, reset_expires = ? WHERE email = ?").bind(await sha256Hex(TOKEN), nowSec() + 3600, ANNA).run();
    const signedIn = await call(new Request(`${LOCAL}/_admin/login`, form({ password: PASSWORD })), undefined, withLogin);
    const cookie = signedIn.headers.get("Set-Cookie")!.split(";")[0]!;
    const changed = await call(
      new Request(`${LOCAL}/_admin/api/me/password`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: LOCAL },
        body: JSON.stringify({ current: PASSWORD, next: NEW_PASSWORD }),
      }),
      undefined,
      withLogin,
    );
    expect(changed.status).toBe(200);
    expect(await pending()).toEqual(NONE);
    // The link from the email no longer sets a password.
    await call(new Request(`${LOCAL}/_admin/reset/${TOKEN}`, form({ password: "the-attackers-password", confirm: "the-attackers-password" })), undefined, withLogin);
    const stillNew = await call(new Request(`${LOCAL}/_admin/login`, form({ password: NEW_PASSWORD })), undefined, withLogin);
    expect(stillNew.headers.get("Set-Cookie")).toBeTruthy();
    const attacker = await call(new Request(`${LOCAL}/_admin/login`, form({ password: "the-attackers-password" })), undefined, withLogin);
    expect(attacker.headers.get("Set-Cookie")).toBeNull();
  });

  it("drops a pending reset when an invitation is accepted, and the other way round", async () => {
    await addUser(ANNA, "user", [], { inviteToken: INVITE });
    await env.DB.prepare("UPDATE users SET reset_hash = ?, reset_expires = ? WHERE email = ?").bind(await sha256Hex(TOKEN), nowSec() + 3600, ANNA).run();
    const accepted = await call(new Request(`${LOCAL}/_admin/invite/${INVITE}`, form({ password: NEW_PASSWORD, confirm: NEW_PASSWORD })), undefined, withLogin);
    expect(accepted.status).toBe(303);
    expect(await pending()).toEqual(NONE);

    await env.DB.prepare("UPDATE users SET reset_hash = ?1, reset_expires = ?3, invite_hash = ?2, invite_expires = ?3 WHERE email = ?4")
      .bind(await sha256Hex(TOKEN), await sha256Hex(INVITE), nowSec() + 3600, ANNA)
      .run();
    const reset = await call(new Request(`${LOCAL}/_admin/reset/${TOKEN}`, form({ password: PASSWORD, confirm: PASSWORD })), undefined, withLogin);
    expect(reset.status).toBe(303);
    expect(await pending()).toEqual(NONE);
  });
});

describe("importing from Short.io", () => {
  it("doesn't put a cursor's domain id into the request unless it's a number", async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(String(input));
      return Response.json({ links: [], nextPageToken: null });
    });
    const cursor = (state: unknown) => btoa(JSON.stringify(state)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const pull = (state: unknown) => adminCall("", "/import/pull", { body: { vendor: "shortio", apiKey: "shortio-key", cursor: cursor(state) } });

    const forged = await pull({ d: [{ id: "9&limit=1/../../../users?x=", host: "s.brand.co" }, { id: 1.5, host: "s.brand.co" }, { id: -3, host: "s.brand.co" }], i: 0, t: null });
    expect(forged.status).toBe(200);
    expect(await forged.json()).toMatchObject({ rows: [], cursor: null });
    expect(seen).toEqual([]);

    expect((await pull({ d: [{ id: 9, host: "s.brand.co" }], i: 0, t: "a b&c" })).status).toBe(200);
    expect(seen).toEqual(["https://api.short.io/api/links?domain_id=9&limit=150&pageToken=a%20b%26c"]);
  });
});

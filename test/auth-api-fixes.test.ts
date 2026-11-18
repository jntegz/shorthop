// Regression tests for the 2.0.3 authorization and API fixes: what the API token
// can read, MCP path and result handling, mail settings, key standing, reads by
// people without permissions, tag reports, the admin origin check, audit labels,
// the login brake, the workers.dev admin and secrets in error logs.

import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/shared/password";
import type { ConnectionDTO, SiteDTO } from "../src/shared/sites";
import type { LinkChecksDTO, LinkDTO, RecentHit, SecurityDTO, ShareDTO, SystemHealthDTO, TargetCheckDTO, VersionDTO, WebhookDeliveryDTO, WebhookDTO } from "../src/shared/types";
import { KEY_CHECK_DETAILS } from "../src/worker/api/settings";
import { nowSec } from "../src/worker/db";
import { recordJob, systemHealth } from "../src/worker/health";
import { RULES, TOKEN_READS } from "../src/worker/permissions";
import { planLimits } from "../src/worker/plan";
import { redactSecrets, safePath } from "../src/worker/redact";
import { chargeAttempt, getEpoch, issueSessionCookie, loginConfig } from "../src/worker/session";
import { OWNER_EPOCH } from "../src/worker/users";
import { aePoint, mockAeSql, type StoredPoint } from "./ae-mock";
import { API, bearer, call, captureClicks, json, ORIGIN, putLink, resetData } from "./helpers";
import { addKey, addUser, adminCall, as, LOCAL } from "./people";

const DEFAULT_SCOPE = { API_TOKEN_SCOPE: "create" } as Partial<Env>;
const ALLOW_ALL = { limit: async () => ({ success: true }) } as RateLimit;
const PASSWORD = "correct-horse-battery-staple-2026"; // gitleaks:allow (test fixture)
let HASH: string;

beforeAll(async () => {
  HASH = await hashPassword(PASSWORD, 10_000);
});
beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

const newLink = (body: Record<string, unknown>, headers: Record<string, string> = bearer, extra: Partial<Env> = {}) => call(`${API}/links`, json(body, headers), extra);
const SECRET_TARGET = "https://private.example.net/hidden-page";
const protectedLink = (slug = "vault") => newLink({ url: SECRET_TARGET, slug, notes: "the vault note", password: "open sesame 1", tags: ["vault-tag"] });

describe("what the default API token can read", () => {
  const read = (path: string, extra: Partial<Env> = DEFAULT_SCOPE) => call(`${API}${path}`, { headers: bearer }, extra);

  it("has an explicit list: every other GET route is refused with a clear message", async () => {
    for (const route of TOKEN_READS) expect(RULES[route], route).toBeDefined();
    const fill = (path: string) => path.replace(":domain", "sh.example").replace(":slug", "nope").replace(/:[a-z]+/g, "abcd1234");
    const wrong: string[] = [];
    for (const route of Object.keys(RULES).filter((r) => r.startsWith("GET "))) {
      const res = await read(fill(route.slice(4)));
      const refused = res.status === 403 && /API_TOKEN_SCOPE/.test(await res.clone().text());
      if (refused === TOKEN_READS.has(route)) wrong.push(`${route} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("never gets a webhook address, a share address, a payment connection or customer data", async () => {
    const hook = "https://hooks.example.com/services/CREDENTIAL-IN-URL";
    expect((await call(`${API}/webhooks`, json({ url: hook, events: ["link.created"] }))).status).toBe(201);
    await newLink({ url: "https://example.com/a", slug: "a" });
    const share = (await (await call(`${API}/links/sh.example/a/shares`, json({}))).json<{ share: ShareDTO }>()).share;
    const secret = share.url!.split(".").at(-1)!;
    const site = await (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json<SiteDTO>();
    const conn = await (await call(`${API}/sites/${site.id}/connections`, json({ provider: "gumroad" }))).json<ConnectionDTO>();
    const token = new URL(conn.webhookUrl!).searchParams.get("token")!;
    await env.DB.prepare("INSERT INTO payments (id, site_id, provider, kind, occurred_at, amount_minor, currency, email, created_at) VALUES ('p1', ?1, 'stripe', 'charge', ?2, 100, 'usd', 'buyer@example.com', ?2)")
      .bind(site.id, nowSec())
      .run();

    const bodies: string[] = [];
    for (const path of ["/webhooks", "/webhooks/1/deliveries", "/shares", "/links/sh.example/a/shares", `/sites/${site.id}/connections`, `/sites/${site.id}/payments`, `/sites/${site.id}/payments.csv`, "/sites", "/links", "/settings"]) {
      bodies.push(await (await read(path)).text());
    }
    const all = bodies.join("\n");
    expect(all).not.toContain("CREDENTIAL-IN-URL");
    expect(all).not.toContain(secret);
    expect(all).not.toContain(token);
    expect(all).not.toContain("buyer@example.com");
    // The same routes still answer with the full scope.
    expect(await (await read("/webhooks", { API_TOKEN_SCOPE: "full" })).text()).toContain("CREDENTIAL-IN-URL");
    expect(await (await read(`/sites/${site.id}/payments`, { API_TOKEN_SCOPE: "full" })).text()).toContain("buyer@example.com");
  });

  it("keeps reading links and statistics, creating links and importing new ones", async () => {
    expect((await newLink({ url: "https://example.com/kept", slug: "kept" }, bearer, DEFAULT_SCOPE)).status).toBe(201);
    for (const path of ["/links", "/links/sh.example/kept", "/tags", "/export/links.json", "/stats/overview", "/stats/recent", "/me", "/settings/health"]) {
      expect((await read(path)).status, path).toBe(200);
    }
    const me = await (await read("/me")).json<{ permissions: string[] }>();
    expect(me.permissions).not.toContain("links.edit");
    expect(me.permissions).not.toContain("revenue.view");
    const imported = await call(`${API}/import`, json({ rows: [{ slug: "imp", target: "https://example.com/i" }] }), DEFAULT_SCOPE);
    expect((await imported.json<{ created: number }>()).created).toBe(1);
  });

  it("doesn't see where a password-protected link goes", async () => {
    await protectedLink();
    const body = await (await read("/links/sh.example/vault")).text();
    expect(body).not.toContain("private.example.net");
    expect(body).not.toContain("the vault note");
  });
});

describe("MCP tools", () => {
  const rpc = (method: string, params: Record<string, unknown>, headers: Record<string, string> = bearer) =>
    call(`${API}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  type ToolResult = { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, string> };
  const tool = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = bearer) =>
    (await (await rpc("tools/call", { name, arguments: args }, headers)).json<{ result: ToolResult }>()).result;
  const listed = async (headers: Record<string, string> = bearer) =>
    (await (await rpc("tools/list", {}, headers)).json<{ result: { tools: { name: string; annotations: Record<string, boolean> }[] } }>()).result.tools;

  it("can't be walked out of their route with dot segments or slashes", async () => {
    await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/hook", events: ["link.created"] }));
    await newLink({ url: "https://example.com/ok", slug: "ok" });
    const attempts: [string, Record<string, unknown>][] = [
      ["get_link", { domain: "..", slug: "webhooks" }],
      ["get_link", { domain: ".", slug: "webhooks" }],
      ["get_link", { domain: "sh.example", slug: ".." }],
      ["link_stats", { domain: "..", slug: "keys" }],
      ["link_stats", { domain: "..", slug: ".." }],
      ["link_revenue", { domain: "..", slug: "settings" }],
      ["update_link", { domain: "..", slug: "webhooks", title: "x" }],
      ["delete_link", { domain: "..", slug: "webhooks" }],
      ["site_overview", { id: "../../webhooks" }],
      ["site_overview", { id: ".." }],
    ];
    for (const [name, args] of attempts) {
      const res = await tool(name, args);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(JSON.stringify(res)).not.toContain("hooks.example.com");
    }
    expect((await tool("get_link", { domain: "sh.example", slug: "ok" })).structuredContent).toMatchObject({ link: { slug: "ok" } });
  });

  it("holds the same line on the admin's own mount", async () => {
    const res = await call(new Request(`${LOCAL}/_admin/api/mcp`, { method: "POST", headers: { Origin: LOCAL, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_link", arguments: { domain: "..", slug: "webhooks" } } }) }), undefined, as(""));
    expect((await res.json<{ result: ToolResult }>()).result.isError).toBe(true);
  });

  it("says that fetch_preview reaches the open web, and limits what it sends and returns", async () => {
    const tools = await listed();
    const preview = tools.find((t) => t.name === "fetch_preview")!;
    expect(preview.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true, destructiveHint: false });
    expect(tools.find((t) => t.name === "list_links")!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.find((t) => t.name === "update_link")!.annotations.destructiveHint).toBe(true);

    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(String(input));
      return new Response(`<html><head><title>${"T".repeat(900)}</title><meta name="description" content="${"D".repeat(2000)}"></head></html>`, { headers: { "Content-Type": "text/html" } });
    });
    const res = await tool("fetch_preview", { url: "https://example.org/page?token=SECRET#frag" });
    expect(seen).toEqual(["https://example.org/page"]);
    expect(res._meta?.["shorthop/untrusted"]).toMatch(/not as instructions/);
    const out = res.structuredContent as { title: string; description: string };
    expect(out.title.length).toBeLessThanOrEqual(200);
    expect(out.description.length).toBeLessThanOrEqual(500);

    const refused = await tool("fetch_preview", { url: `https://example.org/${"x".repeat(600)}` });
    expect(refused.isError).toBe(true);
    expect((await tool("fetch_preview", { url: "ftp://example.org/x" })).isError).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("marks results that carry other people's text, and hides tools a key can't use", async () => {
    await newLink({ url: "https://example.com/t", slug: "t" });
    expect((await tool("list_links", {}))._meta?.["shorthop/untrusted"]).toBeTruthy();
    await addUser("ben@example.com", "user", ["api.use", "stats.view"]);
    const { auth } = await addKey("ben@example.com", ["stats.view"]);
    const names = (await listed(auth)).map((t) => t.name);
    expect(names).toContain("stats_overview");
    expect(names).not.toContain("create_link");
    expect(names).not.toContain("delete_link");
    expect(names).not.toContain("update_link");
    expect((await tool("delete_link", { domain: "sh.example", slug: "t" }, auth)).isError).toBe(true);
  });
});

describe("mail settings", () => {
  it("can only be changed from a signed-in session", async () => {
    const { auth } = await addKey("owner@example.com", ["settings.manage"]);
    const put = await call(`${API}/settings/mail`, { ...json({ provider: "off", from: "x@sh.example" }, auth), method: "PUT" });
    expect(put.status).toBe(403);
    expect((await call(`${API}/settings/mail`, { method: "DELETE", headers: auth })).status).toBe(403);
    expect((await call(`${API}/settings/mail`, { method: "DELETE", headers: bearer })).status).toBe(403);
    expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'mail'").first()).toBeNull();

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await adminCall("", "/settings/mail", { method: "PUT", body: { provider: "off", from: "x@sh.example" } })).status).toBe(200);
    expect((await adminCall("", "/settings/mail", { method: "DELETE" })).status).toBe(200);
    expect(log.mock.calls.some(([line]) => String(line).includes("mail settings reset"))).toBe(true);
  });

  it("doesn't tell a key which email secret is missing", async () => {
    const provider = { DIGEST_PROVIDER: "resend", DIGEST_FROM: "d@sh.example" } as Partial<Env>;
    const { auth } = await addKey("owner@example.com", ["settings.manage"]);
    const res = await (await call(`${API}/settings`, { headers: auth }, provider)).json<{ digestProblem: string | null }>();
    expect(res.digestProblem).toBeNull();
    const session = await (await adminCall("", "/settings", {}, provider)).json<{ digestProblem: string | null }>();
    expect(session.digestProblem).toBeTruthy();
  });
});

describe("key lifecycle", () => {
  const hookCount = () => env.DB.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE key_revoked_at IS NOT NULL").first<{ n: number }>();

  it("stops a person's key while Access is off", async () => {
    await addUser("ben@example.com", "user", ["api.use", "links.create"], { password: PASSWORD });
    const { auth } = await addKey("ben@example.com", ["links.create"]);
    expect((await call(`${API}/me`, { headers: auth })).status).toBe(200);
    expect((await call(`${API}/me`, { headers: auth }, { ADMIN_AUTH: "password" })).status).toBe(401);
    const owner = await addKey("owner@example.com", ["links.create"]);
    expect((await call(`${API}/me`, { headers: owner.auth }, { ADMIN_AUTH: "password" })).status).toBe(200);
  });

  it("stops a key while its owner's password was reset, and starts again once they choose one", async () => {
    await addUser("ben@example.com", "user", ["api.use", "links.create"], { password: PASSWORD });
    const { auth } = await addKey("ben@example.com", ["links.create"]);
    expect((await adminCall("", "/users/ben%40example.com/invite", { body: { sendEmail: false } })).status).toBe(200);
    expect((await call(`${API}/me`, { headers: auth })).status).toBe(401);
    await env.DB.prepare("UPDATE users SET password_hash = 'x', invite_hash = NULL, invite_expires = NULL WHERE email = 'ben@example.com'").run();
    expect((await call(`${API}/me`, { headers: auth })).status).toBe(200);
  });

  it("flags the webhooks a revoked key created, until someone looks at them", async () => {
    await addUser("ben@example.com", "user", ["api.use", "settings.manage"], { password: PASSWORD });
    const key = await addKey("ben@example.com", ["settings.manage"], { name: "ci" });
    const created = await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/from-key", events: ["link.created"] }, key.auth));
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: number }>();
    expect(await env.DB.prepare("SELECT changed_by AS by, key_id AS k FROM webhooks WHERE id = ?").bind(id).first()).toEqual({ by: "ben@example.com · API key ci", k: key.id });

    expect((await adminCall("ben@example.com", `/keys/${key.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await hookCount()).toEqual({ n: 1 });
    const hooks = await (await adminCall("", "/webhooks")).json<{ webhooks: WebhookDTO[] }>();
    expect(hooks.webhooks[0]?.keyRevokedAt).toBeGreaterThan(0);
    expect((await systemHealth(env, new Date())).checks.find((c) => c.id === "webhookkeys")?.status).toBe("warn");

    // Saving it in the admin is the review.
    const saved = await adminCall("", `/webhooks/${id}`, { method: "PUT", body: { url: "https://hooks.example.com/from-key", events: ["link.created"] } });
    expect(saved.status).toBe(200);
    expect(await hookCount()).toEqual({ n: 0 });
  });

  it("flags them when a person's keys go, and offers revoking all of them", async () => {
    await addUser("ben@example.com", "user", ["api.use", "settings.manage"], { password: PASSWORD });
    const key = await addKey("ben@example.com", ["settings.manage"]);
    await addKey("ben@example.com", []);
    await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/a", events: ["link.created"] }, key.auth));
    expect((await adminCall("ben@example.com", "/users/ben%40example.com/revoke-keys", { method: "POST" })).status).toBe(403);
    expect(await (await adminCall("", "/users/ben%40example.com/revoke-keys", { method: "POST" })).json()).toEqual({ revoked: 2 });
    expect(await hookCount()).toEqual({ n: 1 });
    expect((await call(`${API}/me`, { headers: key.auth })).status).toBe(401);
  });

  it("flags them when the person is removed", async () => {
    await addUser("ben@example.com", "user", ["api.use", "settings.manage"], { password: PASSWORD });
    const key = await addKey("ben@example.com", ["settings.manage"]);
    await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/b", events: ["link.created"] }, key.auth));
    expect(await (await adminCall("", "/users/ben%40example.com", { method: "DELETE" })).json()).toMatchObject({ keysRevoked: 1 });
    expect(await hookCount()).toEqual({ n: 1 });
  });
});

describe("reading links", () => {
  const VIEWER = "none@example.com";
  const STATS = "stats@example.com";
  const EDITOR = "editor@example.com";

  beforeEach(async () => {
    await addUser(VIEWER);
    await addUser(STATS, "user", ["stats.view"]);
    await addUser(EDITOR, "user", ["links.edit"]);
    await protectedLink();
    await newLink({ url: "https://example.com/open", slug: "open", notes: "plain note" });
  });

  it("is closed to someone with no permission at all", async () => {
    for (const path of ["/links", "/links/sh.example/open", "/links/sh.example/open/history", "/links/by-target?url=https%3A%2F%2Fexample.com%2Fopen", "/deleted", "/tags", "/export/links.csv", "/export/links.json", "/checks/links/sh.example/open"]) {
      expect((await adminCall(VIEWER, path)).status, path).toBe(403);
    }
    expect((await adminCall(VIEWER, "/me")).status).toBe(200);
    expect((await call(`${API}/links`, { headers: (await addKey("owner@example.com", [])).auth })).status).toBe(403);
  });

  it("stays open to anyone holding a permission, with protected links' secrets left out", async () => {
    const list = await (await adminCall(STATS, "/links")).json<{ links: LinkDTO[] }>();
    const vault = list.links.find((l) => l.slug === "vault")!;
    expect(vault).toMatchObject({ protected: true, target: "", notes: "", routing: null });
    expect(list.links.find((l) => l.slug === "open")).toMatchObject({ target: "https://example.com/open", notes: "plain note" });
    const one = await (await adminCall(STATS, "/links/sh.example/vault")).json<{ link: LinkDTO }>();
    expect(one.link.target).toBe("");

    const editor = await (await adminCall(EDITOR, "/links/sh.example/vault")).json<{ link: LinkDTO }>();
    expect(editor.link).toMatchObject({ target: SECRET_TARGET, notes: "the vault note" });
  });

  it("can't be worked around through search, lookups, history, exports or the deleted list", async () => {
    const texts = async (email: string) => {
      const out: string[] = [];
      for (const path of ["/links?q=private.example", "/links?q=vault%20note", `/links/by-target?url=${encodeURIComponent(SECRET_TARGET)}`, "/links/sh.example/vault/history", "/export/links.csv", "/export/links.json", "/checks/links/sh.example/vault"]) {
        out.push(await (await adminCall(email, path)).text());
      }
      return out.join("\n");
    };
    const seen = await texts(STATS);
    expect(seen).not.toContain("private.example.net");
    expect(seen).not.toContain("the vault note");
    expect(await texts(EDITOR)).toContain("private.example.net");

    const filtered = await (await adminCall(STATS, "/links?q=private.example")).json<{ links: LinkDTO[] }>();
    expect(filtered.links).toEqual([]);
    const history = await (await adminCall(STATS, "/links/sh.example/vault/history")).json<{ versions: VersionDTO[] }>();
    expect(history.versions[0]?.snapshot.target).toBe("");

    await call(`${API}/links/sh.example/vault`, { method: "DELETE", headers: bearer });
    expect(await (await adminCall(STATS, "/deleted")).text()).not.toContain("private.example.net");
    expect(await (await adminCall(EDITOR, "/deleted")).text()).toContain("private.example.net");
  });

  it("hides visitor ids in the live view from people without revenue", async () => {
    const site = await (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json<SiteDTO>();
    const now = nowSec();
    await env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) VALUES ('s1', ?1, 'visitor-1', ?2, ?2)").bind(site.id, now).run();
    await addUser("money@example.com", "user", ["stats.view", "revenue.view"]);
    const live = async (email: string) => (await adminCall(email, `/sites/${site.id}/live`)).text();
    expect(await live(STATS)).not.toContain("visitor-1");
    expect(await live("money@example.com")).toContain("visitor-1");
  });
});

describe("tags that feed a shared report", () => {
  const EDITOR = "editor@example.com";
  const CREATOR = "creator@example.com";
  const STATS_EDITOR = "stats-editor@example.com";
  const FULL = "full@example.com";
  const report = (tag: string, showRevenue: boolean) => call(`${API}/shares`, json({ scope: "tag", tag, title: "Report", showRevenue }));

  beforeEach(async () => {
    await addUser(EDITOR, "user", ["links.edit", "links.create"]);
    await addUser(CREATOR, "user", ["links.create"]);
    await addUser(STATS_EDITOR, "user", ["links.edit", "stats.view"]);
    await addUser(FULL, "user", ["links.edit", "links.create", "stats.view", "revenue.view"]);
    await newLink({ url: "https://example.com/a", slug: "a", tags: ["other"] });
    await report("press", false);
    await report("money", true);
  });

  it("needs See statistics to add one, on every path", async () => {
    const refused = [
      await adminCall(EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "press"] } }),
      await adminCall(EDITOR, "/links/bulk", { body: { links: [{ domain: "sh.example", slug: "a" }], action: "addTag", tag: "press" } }),
      await adminCall(EDITOR, "/tags/rename", { body: { from: "other", to: "press" } }),
      await adminCall(CREATOR, "/links", { body: { url: "https://example.com/n", slug: "n", tags: ["press"] } }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect((await res.json<{ error: string }>()).error).toMatch(/shared report.*See statistics/);
    }
    expect((await env.DB.prepare("SELECT tags FROM links WHERE slug = 'a'").first<{ tags: string }>())?.tags).toBe("other");
    expect(await env.DB.prepare("SELECT 1 FROM links WHERE slug = 'n'").first()).toBeNull();

    // An import refuses just the rows that carry it.
    const imported = await (await adminCall(CREATOR, "/import", { body: { rows: [{ slug: "i1", target: "https://example.com/1", tags: ["press"] }, { slug: "i2", target: "https://example.com/2" }] } })).json<{ created: number; errors: number; rows: { slug: string; message?: string }[] }>();
    expect(imported).toMatchObject({ created: 1, errors: 1 });
    expect(imported.rows.find((r) => r.slug === "i1")?.message).toMatch(/shared report/);
  });

  it("needs See revenue too when the report shows revenue", async () => {
    expect((await adminCall(STATS_EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "press"] } })).status).toBe(200);
    const res = await adminCall(STATS_EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "press", "money"] } });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toMatch(/See revenue/);
    expect((await adminCall(FULL, "/links/sh.example/a", { method: "PATCH", body: { tags: ["money"] } })).status).toBe(200);
  });

  it("counts a restored version as adding its tags", async () => {
    await adminCall(FULL, "/links/sh.example/a", { method: "PATCH", body: { tags: ["money"] } });
    await adminCall(FULL, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other"] } });
    const { versions } = await (await adminCall(FULL, "/links/sh.example/a/history")).json<{ versions: VersionDTO[] }>();
    const withMoney = versions.find((v) => v.snapshot.tags === "money")!;
    expect((await adminCall(EDITOR, `/links/sh.example/a/history/${withMoney.id}/restore`, { method: "POST" })).status).toBe(403);
    expect((await adminCall(FULL, `/links/sh.example/a/history/${withMoney.id}/restore`, { method: "POST" })).status).toBe(200);
  });

  it("counts a report that has expired: extending it brings back every link with its tag", async () => {
    await env.DB.prepare("UPDATE stat_shares SET expires_at = ? WHERE tag IN ('press', 'money')").bind(nowSec() - 60).run();
    const res = await adminCall(EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "press"] } });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toMatch(/shared report.*See statistics/);
    expect((await adminCall(STATS_EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "money"] } })).status).toBe(403);
    expect((await env.DB.prepare("SELECT tags FROM links WHERE slug = 'a'").first<{ tags: string }>())?.tags).toBe("other");
    // Someone who may see what the report shows can still add it.
    expect((await adminCall(STATS_EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "press"] } })).status).toBe(200);
  });

  it("leaves other tags, links already tagged and revoked reports alone", async () => {
    expect((await adminCall(EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "free"] } })).status).toBe(200);
    await env.DB.prepare("UPDATE stat_shares SET revoked_at = ? WHERE tag = 'press'").bind(nowSec()).run();
    expect((await adminCall(EDITOR, "/links/sh.example/a", { method: "PATCH", body: { tags: ["other", "press"] } })).status).toBe(200);
    // Keeping a tag it already has is no change: nothing new reaches a report.
    expect((await adminCall(EDITOR, "/links/sh.example/a", { method: "PATCH", body: { title: "New title", tags: ["other", "press"] } })).status).toBe(200);
  });

  it("keeps the default API token out of revenue reports", async () => {
    const res = await newLink({ url: "https://example.com/m", slug: "m", tags: ["money"] }, bearer, DEFAULT_SCOPE);
    expect(res.status).toBe(403);
    expect((await newLink({ url: "https://example.com/p", slug: "p", tags: ["press"] }, bearer, DEFAULT_SCOPE)).status).toBe(201);
  });
});

describe("the admin API's origin check", () => {
  const post = (headers: Record<string, string>) => call(new Request(`${LOCAL}/_admin/api/links`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ url: "https://example.com/o" }) }), undefined, as(""));
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM links").first<{ n: number }>())?.n;

  it("refuses JSON from another origin, a sibling or an opaque one", async () => {
    for (const headers of [{ Origin: "https://evil.example" }, { Origin: "http://other.localhost:5173" }, { Origin: "null" }, { "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
      const res = await post(headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json()).toMatchObject({ code: "cross_origin" });
    }
    expect(await count()).toBe(0);
  });

  it("lets the admin's own pages and clients that aren't browsers through", async () => {
    expect((await post({ Origin: LOCAL })).status).toBe(201);
    expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).toBe(201);
    expect((await post({})).status).toBe(201);
    expect(await count()).toBe(3);
  });

  it("doesn't touch the bearer API", async () => {
    expect((await call(`${API}/links`, json({ url: "https://example.com/b" }, { Origin: "https://elsewhere.example" }))).status).toBe(201);
  });
});

describe("telling shared identities apart", () => {
  const pwEnv = () => ({ ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: ALLOW_ALL }) as Partial<Env>;
  const session = async (ago: number) => {
    const cfg = loginConfig({ ...env, ...pwEnv() } as Env)!;
    return (await issueSessionCookie(cfg, "admin", { global: await getEpoch(env.DB), user: OWNER_EPOCH }, nowSec() - ago)).cookie.split(";")[0]!;
  };
  const edit = (cookie: string, title: string) =>
    call(new Request(`${ORIGIN}/_admin/api/links/sh.example/a`, { method: "PATCH", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ title }) }), undefined, pwEnv());

  it("records which session changed a link when everyone is the same admin", async () => {
    await newLink({ url: "https://example.com/a", slug: "a" });
    expect((await edit(await session(0), "one")).status).toBe(200);
    expect((await edit(await session(60), "two")).status).toBe(200);
    const { results } = await env.DB.prepare("SELECT actor FROM link_versions WHERE action = 'update' ORDER BY id").all<{ actor: string }>();
    const [first, second] = results.map((r) => r.actor);
    expect(first).toMatch(/^admin · session [0-9a-f]{8}$/);
    expect(second).toMatch(/^admin · session [0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it("tells the API token's networks apart, and never writes the address", async () => {
    await newLink({ url: "https://example.com/a", slug: "a" }, { ...bearer, "CF-Connecting-IP": "198.51.100.1" });
    await newLink({ url: "https://example.com/b", slug: "b" }, { ...bearer, "CF-Connecting-IP": "198.51.100.2" });
    const { results } = await env.DB.prepare("SELECT actor FROM link_versions ORDER BY id").all<{ actor: string }>();
    expect(results[0]?.actor).toMatch(/^api-token · network [0-9a-f]{8}$/);
    expect(results[0]?.actor).not.toBe(results[1]?.actor);
    expect(JSON.stringify(results)).not.toContain("198.51.100");
  });

  it("shows admins an account signing in from several networks, and keeps the real email in Security", async () => {
    const now = nowSec();
    await env.DB.batch(["net-a", "net-b"].map((ip) => env.DB.prepare("INSERT INTO login_events (ts, ok, ip_hash, country, email) VALUES (?, 1, ?, '', 'admin')").bind(now, ip)));
    const res = await call(new Request(`${ORIGIN}/_admin/api/settings`, { headers: { Cookie: await session(0) } }), undefined, pwEnv());
    const { security } = await res.json<{ security: SecurityDTO }>();
    expect(security.sharedSignIns).toEqual([{ email: "admin", networks: 2 }]);
    expect(security.email).toBe("admin");
  });

  it("logs deleted settings with who did it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await adminCall("", "/settings/not-found/image", { method: "DELETE" })).status).toBe(200);
    expect(log.mock.calls.some(([line]) => String(line).includes("not-found image deleted") && String(line).includes("dev@localhost"))).toBe(true);
  });
});

describe("guessing the admin password", () => {
  const pwEnv = () => ({ ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: ALLOW_ALL }) as Partial<Env>;
  const login = (password: string, ip: string, extra: Partial<Env> = {}) =>
    call(new Request(`${ORIGIN}/_admin/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": ip }, body: new URLSearchParams({ password }).toString() }), undefined, { ...pwEnv(), ...extra });
  const brake = () => env.DB.prepare("INSERT INTO auth_failures (key, fails, window_start, locked_until, lockouts, updated_at) VALUES ('*', 0, ?1, ?2, 0, ?1)").bind(nowSec(), nowSec() + 900).run();

  it("lets a network the owner signed in from through the global pause, and nobody else", async () => {
    expect((await login(PASSWORD, "198.51.100.10")).status).toBe(303);
    await brake();
    expect((await login(PASSWORD, "198.51.100.11")).status).toBe(429);
    expect((await login(PASSWORD, "198.51.100.10")).status).toBe(303);
  });

  it("tells the owner on a new network the way out that SECURITY.md gives, and it works", async () => {
    await brake();
    const paused = await login(PASSWORD, "198.51.100.12");
    expect(paused.status).toBe(429);
    expect(await paused.text()).toContain("SECURITY.md");
    await env.DB.exec("DELETE FROM auth_failures WHERE key IN ('*', '*people')");
    expect((await login(PASSWORD, "198.51.100.12")).status).toBe(303);
  });

  it("keeps that network's own limit", async () => {
    expect((await login(PASSWORD, "198.51.100.20")).status).toBe(303);
    await brake();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await login("wrong-password", "198.51.100.20")).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(429);
    // Locked now: even the right password waits.
    expect((await login(PASSWORD, "198.51.100.20")).status).toBe(429);
  });

  it("stores no raw address for it", async () => {
    await login(PASSWORD, "198.51.100.30");
    const { results } = await env.DB.prepare("SELECT ip_hash FROM login_events").all<{ ip_hash: string }>();
    expect(JSON.stringify(results)).not.toContain("198.51.100.30");
  });

  it("warns about a short plain password without Access, and keeps it working", async () => {
    const base = { ...env, ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: "", ADMIN_PASSWORD: "ninechars" } as unknown as Env;
    const short = (await systemHealth(base, new Date())).checks.find((c) => c.id === "password");
    expect(short).toMatchObject({ status: "warn" });
    expect(short?.advisory).toBeUndefined();
    expect(short?.detail).not.toContain("ninechars");
    const long = (await systemHealth({ ...base, ADMIN_PASSWORD: "a-much-longer-admin-password" } as Env, new Date())).checks.find((c) => c.id === "password");
    expect(long?.advisory).toBe(true);
    expect((await login("ninechars", "198.51.100.40", { ADMIN_PASSWORD_HASH: "", ADMIN_PASSWORD: "ninechars" } as Partial<Env>)).status).toBe(303);
  });

  it("keeps the bot check's script off invite and reset pages", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('turnstile', ?)").bind(JSON.stringify({ enabled: true, siteKey: "0x4AAAAAAA" })).run();
    const token = "t".repeat(43);
    await addUser("ana@example.com", "user", ["links.create"], { inviteToken: token });
    const bot = as("ana@example.com", { ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: ALLOW_ALL, TURNSTILE_SECRET: "s" } as Partial<Env>);
    const page = await call(new Request(`${LOCAL}/_admin/invite/${token}`), undefined, bot);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain("challenges.cloudflare.com");
    expect(html).not.toContain("data-sitekey");
    const saved = await call(new Request(`${LOCAL}/_admin/invite/${token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" }, body: new URLSearchParams({ password: PASSWORD, confirm: PASSWORD }).toString() }), undefined, bot);
    expect(saved.status).toBe(303);
  });
});

describe("the workers.dev address", () => {
  const DEV = "https://shorthop.someone.workers.dev";
  const OFF = { WORKERS_DEV_ADMIN: "off" } as Partial<Env>;

  it("keeps the admin by default, as a way back in", async () => {
    expect((await call(`${DEV}/api/me`, { headers: bearer })).status).toBe(200);
  });

  it("stops serving the admin and the API when turned off, but keeps links", async () => {
    await newLink({ url: "https://example.com/kept", slug: "kept" });
    expect((await call(`${DEV}/api/me`, { headers: bearer }, OFF)).status).toBe(404);
    expect((await call(`${DEV}/_admin/login`, undefined, OFF)).status).toBe(404);
    expect((await call(`${ORIGIN}/api/me`, { headers: bearer }, OFF)).status).toBe(200);
  });

  it("serves a share page there only while the admin is allowed there", async () => {
    await newLink({ url: "https://example.com/shared", slug: "shared" });
    const { share } = await (await call(`${API}/links/sh.example/shared/shares`, json({}))).json<{ share: ShareDTO }>();
    const page = `${DEV}${new URL(share.url!).pathname}`;
    expect((await call(page)).status).toBe(200);
    expect((await call(page, undefined, OFF)).status).toBe(404);
  });

  it("can't be turned off before a domain exists: it's the only admin there is", async () => {
    expect((await call(`${DEV}/api/me`, { headers: bearer }, { ...OFF, SHORT_DOMAINS: "" })).status).toBe(200);
  });

  it("is mentioned in System status until it's dealt with", async () => {
    const check = async (extra: Partial<Env>) => (await systemHealth({ ...env, ...extra } as Env, new Date())).checks.find((c) => c.id === "workersdev");
    expect(await check({})).toMatchObject({ status: "warn", advisory: true });
    expect(await check(OFF)).toBeUndefined();
    expect(await check({ SHORT_DOMAINS: "" })).toBeUndefined();
  });
});

describe("error logs", () => {
  const brokenDb = { DB: { prepare: () => { throw new Error("db down"); }, batch: () => { throw new Error("db down"); } } } as unknown as Partial<Env>;

  it("take the secret out of every kind of secret address", () => {
    const paths = [
      ["/_share/abcd1234.SECRETSHARETOKEN1234?x=SECRETQUERY", "/_share/[redacted]"],
      ["/_admin/invite/SECRETINVITETOKEN?x=SECRETQUERY", "/_admin/invite/[redacted]"],
      ["/_admin/reset/SECRETRESETTOKEN?x=SECRETQUERY", "/_admin/reset/[redacted]"],
      ["/_pay/gumroad/pc_1?token=SECRETQUERY", "/_pay/[redacted]"],
    ] as const;
    for (const [path, safe] of paths) {
      expect(safePath(path)).toBe(safe);
      expect(redactSecrets(`TypeError: fetch failed for https://sh.example${path} at handler`)).toBe(`TypeError: fetch failed for https://sh.example${safe} at handler`);
    }
    expect(safePath("/api/links")).toBe("/api/links");
  });

  it("never hold a secret from the address when a request fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await call(`${ORIGIN}/_share/abcd1234.SECRETSHARETOKEN1234?token=SECRETQUERY`, undefined, brokenDb);
    const text = logged.mock.calls.flat().map(String).join("\n");
    expect(text).toContain("request failed");
    expect(text).toContain("/_share/[redacted]");
    for (const secret of ["SECRETSHARETOKEN", "SECRETQUERY"]) expect(text).not.toContain(secret);
  });

  it("name the API route instead of its address", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await call(`${API}/links/sh.example/private-slug`, { headers: bearer }, brokenDb);
    const text = logged.mock.calls.flat().map(String).join("\n");
    expect(text).toContain("GET /links/:domain/:slug");
    expect(text).not.toContain("private-slug");
  });
});

describe("destination checks of password-protected links", () => {
  const HEALTH = "health@example.com";
  const CREATOR = "creator@example.com";
  const EDITOR = "editor@example.com";
  const path = (slug: string) => `/checks/links/sh.example/${slug}`;
  type LinkCheck = { check: TargetCheckDTO | null; routed: TargetCheckDTO[] };
  const slugsIn = (r: LinkCheck) => [...(r.check?.links ?? []), ...r.routed.flatMap((c) => c.links)].map((l) => l.slug);

  beforeEach(async () => {
    await addUser(HEALTH, "user", ["health.manage"]);
    await addUser(CREATOR, "user", ["links.create"]);
    await addUser(EDITOR, "user", ["links.edit", "health.manage"]);
    await protectedLink();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
  });

  it("aren't given back by Check now without Edit links", async () => {
    const { auth } = await addKey("owner@example.com", ["health.manage"]);
    for (const res of [await adminCall(HEALTH, path("vault"), { method: "POST" }), await call(`${API}${path("vault")}`, { method: "POST", headers: auth })]) {
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("private.example.net");
      expect(JSON.parse(text)).toMatchObject({ check: null, routed: [] });
    }
    expect(await (await adminCall(EDITOR, path("vault"), { method: "POST" })).text()).toContain("private.example.net");
  });

  it("don't confirm a guessed destination through a link to the same address", async () => {
    expect((await call(`${API}/checks/settings`, { ...json({ scope: "all" }), method: "PUT" })).status).toBe(200);
    expect((await adminCall(CREATOR, "/links", { body: { url: SECRET_TARGET, slug: "guess" } })).status).toBe(201);
    const read = async (email: string) => (await adminCall(email, path("guess"))).json<LinkCheck>();

    expect(slugsIn(await read(CREATOR))).toEqual(["guess"]);
    expect(slugsIn(await (await call(`${API}${path("guess")}`, { headers: bearer }, DEFAULT_SCOPE)).json<LinkCheck>())).toEqual(["guess"]);
    expect(slugsIn(await (await adminCall(HEALTH, path("guess"), { method: "POST" })).json<LinkCheck>())).toEqual(["guess"]);
    // Someone who can edit links sees everything using it, as on Link health.
    expect(slugsIn(await read(EDITOR)).sort()).toEqual(["guess", "vault"]);
    const page = await (await adminCall(HEALTH, "/checks")).json<LinkChecksDTO>();
    expect(page.items.flatMap((i) => i.links).map((l) => l.slug)).toEqual(["guess"]);
  });
});

describe("missed visits and the default API token", () => {
  const AE_ENV = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" };
  const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

  it("stay out of /stats/recent, asked for or not", async () => {
    await putLink("guide", { u: "https://example.com/guide" });
    const { points, CLICKS } = captureClicks();
    for (const p of ["/guide", "/secret-typo-path"]) {
      await call(new Request(`${ORIGIN}${p}`, { headers: { "User-Agent": CHROME, "CF-Connecting-IP": "198.51.100.1" }, cf: { country: "CZ", city: "Prague" } } as RequestInit), undefined, { CLICKS });
    }
    const store: StoredPoint[] = points.map((p) => aePoint(p, nowSec() - 30));
    mockAeSql(store);
    const recent = (q: string, extra: Partial<Env>) => call(`${API}/stats/recent?limit=200${q}`, { headers: bearer }, { ...AE_ENV, ...extra });

    expect((await recent("&event=miss", DEFAULT_SCOPE)).status).toBe(403);
    const plain = await (await recent("", DEFAULT_SCOPE)).json<{ hits: RecentHit[] }>();
    expect(plain.hits.map((h) => h.event)).toEqual(["click"]);
    expect(JSON.stringify(plain)).not.toContain("secret-typo-path");

    // The full scope, like Link health, still sees them.
    const full = await (await recent("&event=miss", { API_TOKEN_SCOPE: "full" })).json<{ hits: RecentHit[] }>();
    expect(full.hits.map((h) => h.slug)).toEqual(["secret-typo-path"]);
  });
});

describe("System status for keys and the API token", () => {
  const PLACEHOLDER = "Open System status in the admin for the details.";
  const health = async (headers: Record<string, string>, extra: Partial<Env> = {}) => (await call(`${API}/settings/health`, { headers }, extra)).json<SystemHealthDTO>();
  const views = async (extra: Partial<Env> = {}) => {
    const { auth } = await addKey("owner@example.com", ["settings.manage"]);
    return [await health(bearer, { ...DEFAULT_SCOPE, ...extra }), await health(auth, extra)];
  };

  it("gives details only for the checks on its list", async () => {
    const site = await (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json<SiteDTO>();
    await call(`${API}/sites/${site.id}/connections`, json({ provider: "gumroad" }));
    expect((await (await adminCall("", "/settings/health")).json<SystemHealthDTO>()).checks.find((c) => c.id === "gumroad")?.detail).toContain("no access token");

    for (const view of await views()) {
      const gumroad = view.checks.find((c) => c.id === "gumroad")!;
      expect(gumroad.status).toBe("warn");
      expect(gumroad.detail).toBe(PLACEHOLDER);
      expect(view.checks.find((c) => c.id === "d1")?.detail).not.toBe(PLACEHOLDER);
      for (const c of view.checks.filter((c) => !KEY_CHECK_DETAILS.has(c.id))) {
        expect(c.detail, c.id).toBe(PLACEHOLDER);
        expect(c.fix, c.id).toBeUndefined();
        expect(c.docs, c.id).toBeUndefined();
      }
    }
    // The full scope keeps what it had: everything but how sign-in, secrets and email are set up.
    const full = await health(bearer, { API_TOKEN_SCOPE: "full" });
    expect(full.checks.find((c) => c.id === "gumroad")?.detail).toContain("no access token");
    expect(full.checks.find((c) => c.id === "security")?.detail).toBe(PLACEHOLDER);
  });

  it("doesn't describe where the secrets live", async () => {
    for (const view of await views({ SESSION_SECRET: "", ENCRYPTION_KEY: "" })) {
      expect(view.checks.find((c) => c.id === "encryption")?.detail).toBe(PLACEHOLDER);
    }
  });

  it("leaves out raw error text and the last alert's failure", async () => {
    const LINKS = { get: () => { throw new Error("kv-internal-detail"); } } as unknown as KVNamespace;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await recordJob(env.DB, "alert", false, "alert-internal-detail");
    for (const view of await views({ LINKS })) {
      expect(view.checks.find((c) => c.id === "kv")).toMatchObject({ status: "error", detail: PLACEHOLDER });
      expect(view.lastAlert).toBeNull();
      expect(JSON.stringify(view)).not.toContain("internal-detail");
    }
    const session = await (await adminCall("", "/settings/health", {}, { LINKS })).json<SystemHealthDTO>();
    expect(session.lastAlert?.error).toBe("alert-internal-detail");
  });
});

describe("webhooks and where password-protected links go", () => {
  const SETTINGS_ONLY = "settings@example.com";
  const EDITOR = "editor@example.com";
  const HOOK = "https://hooks.example.com/shorthop";
  const ELSEWHERE = "https://elsewhere.example.net/x";
  let sent: { url: string; body: string }[];
  const lastTarget = () => (JSON.parse(sent.at(-1)!.body) as { data: { link: { target: string } } }).data.link.target;
  const ownerHook = async (events = ["link.created"]) => (await (await call(`${API}/webhooks`, json({ url: HOOK, events }))).json<{ id: number }>()).id;
  const log = async (email: string, id: number) => (await (await adminCall(email, `/webhooks/${id}/deliveries`)).json<{ deliveries: WebhookDeliveryDTO[] }>()).deliveries;
  const hookOf = async (id: number) => (await (await adminCall("", "/webhooks")).json<{ webhooks: WebhookDTO[] }>()).webhooks.find((h) => h.id === id)!;
  const stored = (id: number, deliveryId: string, type: string, payload: unknown) =>
    env.DB.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, created_at) VALUES (?1, ?2, 'e1', ?3, ?4, 'delivered', 1)").bind(deliveryId, id, type, JSON.stringify(payload)).run();

  beforeEach(async () => {
    sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      sent.push({ url: String(input), body: String(init?.body) });
      return new Response("ok");
    });
    await addUser(SETTINGS_ONLY, "user", ["settings.manage"]);
    await addUser(EDITOR, "user", ["settings.manage", "links.edit"]);
  });

  it("still go to a webhook someone who can edit links set up", async () => {
    const id = await ownerHook();
    await protectedLink();
    expect(lastTarget()).toBe(SECRET_TARGET);
    expect((await hookOf(id)).hidesProtected).toBe(false);
  });

  it("are left out of the delivery log without Edit links", async () => {
    const id = await ownerHook();
    await protectedLink();
    await newLink({ url: "https://example.com/open", slug: "open" });
    const shown = await log(SETTINGS_ONLY, id);
    expect(shown).toHaveLength(2);
    expect(JSON.stringify(shown)).not.toContain("private.example.net");
    expect(JSON.stringify(shown)).toContain("https://example.com/open");
    expect(JSON.stringify(await log(EDITOR, id))).toContain("private.example.net");

    const vault = shown.find((d) => d.payload.includes('"vault"'))!;
    expect(JSON.parse(vault.payload)).toMatchObject({ data: { link: { slug: "vault", target: "", password_protected: true } } });
    const again = await adminCall(SETTINGS_ONLY, `/webhooks/deliveries/${vault.id}/redeliver`, { method: "POST" });
    expect(await again.text()).not.toContain("private.example.net");
    // Its address was set by the owner, so the receiver gets what it always got.
    expect(lastTarget()).toBe(SECRET_TARGET);
  });

  it("hide a link that got its password after the event, and health events of protected links", async () => {
    const id = await ownerHook(["link.created", "link.health_changed"]);
    await newLink({ url: "https://later.example.net/page", slug: "later" });
    expect((await call(`${API}/links/sh.example/later`, { ...json({ password: "open sesame 1" }), method: "PATCH" })).status).toBe(200);
    await protectedLink();
    await newLink({ url: "https://example.com/open", slug: "open" });
    const link = (slug: string) => ({ domain: "sh.example", slug, title: "", short_url: `https://sh.example/${slug}` });
    await stored(id, "dlv_only", "link.health_changed", { type: "link.health_changed", data: { destination: SECRET_TARGET, state: "down", links: [link("vault")] } });
    await stored(id, "dlv_both", "link.health_changed", { type: "link.health_changed", data: { destination: "https://example.com/open", state: "down", links: [link("open"), link("vault")] } });
    await addUser("both@example.com", "user", ["settings.manage", "health.manage"]);

    const shown = await log("both@example.com", id);
    const text = JSON.stringify(shown);
    expect(text).not.toContain("later.example.net");
    expect(text).not.toContain("private.example.net");
    expect(JSON.parse(shown.find((d) => d.id === "dlv_only")!.payload)).toMatchObject({ data: { destination: "", links: [] } });
    const both = JSON.parse(shown.find((d) => d.id === "dlv_both")!.payload) as { data: { destination: string; links: { slug: string }[] } };
    expect(both.data.destination).toBe("https://example.com/open");
    expect(both.data.links.map((l) => l.slug)).toEqual(["open"]);
  });

  it("aren't sent to a webhook set up by someone who can't edit links, until an editor saves it", async () => {
    const res = await adminCall(SETTINGS_ONLY, "/webhooks", { body: { url: ELSEWHERE, events: ["link.created"] } });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: number }>();
    expect((await hookOf(id)).hidesProtected).toBe(true);

    await protectedLink();
    expect(sent.at(-1)!.url).toBe(ELSEWHERE);
    expect(sent.at(-1)!.body).not.toContain("private.example.net");
    expect(lastTarget()).toBe("");
    await newLink({ url: "https://example.com/open", slug: "open" });
    expect(lastTarget()).toBe("https://example.com/open");

    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}`, { method: "PUT", body: { url: ELSEWHERE, events: ["link.created"], description: "mine" } })).status).toBe(200);
    expect((await hookOf(id)).hidesProtected).toBe(true);
    expect((await adminCall(EDITOR, `/webhooks/${id}`, { method: "PUT", body: { url: ELSEWHERE, events: ["link.created"] } })).status).toBe(200);
    expect((await hookOf(id)).hidesProtected).toBe(false);
    await protectedLink("vault2");
    expect(lastTarget()).toBe(SECRET_TARGET);
  });

  it("can't be collected by pointing a webhook elsewhere and sending a delivery again", async () => {
    const id = await ownerHook();
    await protectedLink();
    const delivery = (await log("", id))[0]!;
    // Saving it without moving it changes nothing for the receiver.
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}`, { method: "PUT", body: { url: HOOK, events: ["link.created"], description: "renamed" } })).status).toBe(200);
    expect((await hookOf(id)).hidesProtected).toBe(false);

    expect((await adminCall(SETTINGS_ONLY, `/webhooks/${id}`, { method: "PUT", body: { url: ELSEWHERE, events: ["link.created"] } })).status).toBe(200);
    expect((await hookOf(id)).hidesProtected).toBe(true);
    expect((await adminCall(SETTINGS_ONLY, `/webhooks/deliveries/${delivery.id}/redeliver`, { method: "POST" })).status).toBe(200);
    expect(sent.at(-1)!.url).toBe(ELSEWHERE);
    expect(sent.at(-1)!.body).not.toContain("private.example.net");
  });

  it("aren't in the digest preview", async () => {
    await protectedLink();
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, 'sh.example', 'vault', 'total', '', 5, 5, 0)").bind(yesterday),
      env.DB.prepare("UPDATE links SET created_at = ? WHERE slug = 'vault'").bind(nowSec() - 2 * 86400),
    ]);
    await addUser("digest@example.com", "user", ["settings.manage", "stats.view"]);
    const res = await adminCall("digest@example.com", "/settings/digest/preview");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("vault");
    expect(text).not.toContain("private.example.net");
  });
});

describe("what failed attempts write to D1", () => {
  const pwEnv = { ADMIN_AUTH: "password", LOGIN_LIMITER: ALLOW_ALL } as Partial<Env>;
  const login = (password: string, ip: string) =>
    call(new Request(`${ORIGIN}/_admin/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": ip }, body: new URLSearchParams({ password }).toString() }), undefined, { ...pwEnv, ADMIN_PASSWORD_HASH: HASH });
  const submit = (password: string, ip: string) =>
    call(new Request(`${ORIGIN}/vault`, { method: "POST", headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0", "CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) }), undefined, { LINK_PASSWORD_LIMITER: ALLOW_ALL });
  const wrongToken = (ip: string, extra: Partial<Env> = {}) => call(`${API}/links`, { headers: { Authorization: "Bearer not-the-token", "CF-Connecting-IP": ip } }, { AUTH_LIMITER: ALLOW_ALL, ...extra });
  /** Marks every row, so that any write to one shows. */
  const mark = () => env.DB.prepare("UPDATE auth_failures SET updated_at = 1").run();
  const rows = async () => (await env.DB.prepare("SELECT * FROM auth_failures ORDER BY key").all()).results;

  it("adds nothing while a network is locked out of the login", async () => {
    for (let i = 0; i < 5; i++) await login("wrong-password", "198.51.100.50");
    await mark();
    const before = await rows();
    expect((await login("wrong-password", "198.51.100.50")).status).toBe(429);
    expect(await rows()).toEqual(before);
  });

  it("keeps a lock's history until a quiet day has passed after the lock", async () => {
    const now = nowSec();
    await env.DB.prepare("INSERT INTO auth_failures (key, fails, window_start, locked_until, lockouts, updated_at) VALUES ('t', 0, ?1, ?2, 3, ?1)").bind(now - 86500, now - 10).run();
    expect((await chargeAttempt(env.DB, "t", now)).lockouts).toBe(3);
    await env.DB.prepare("UPDATE auth_failures SET locked_until = ?1, updated_at = ?1").bind(now - 86500).run();
    expect((await chargeAttempt(env.DB, "t", now)).lockouts).toBe(0);
  });

  it("still says a locked key is locked", async () => {
    const now = nowSec();
    await env.DB.prepare("INSERT INTO auth_failures (key, fails, window_start, locked_until, lockouts, updated_at) VALUES ('t', 4, ?1, ?2, 2, 1)").bind(now, now + 60).run();
    expect(await chargeAttempt(env.DB, "t", now)).toEqual({ fails: 4, lockedUntil: now + 60, lockouts: 2, windowStart: now });
    expect(await env.DB.prepare("SELECT updated_at AS at FROM auth_failures").first()).toEqual({ at: 1 });
  });

  it("adds nothing for a link password that is refused before it is checked", async () => {
    await protectedLink();
    for (let i = 0; i < 11; i++) await submit("wrong guess", "203.0.113.60");
    await mark();
    let before = await rows();
    expect((await submit("wrong guess", "203.0.113.60")).status).toBe(429);
    expect(await rows()).toEqual(before);

    // The link's brake: networks that guessed wrong wait, without a write.
    await env.DB.prepare("DELETE FROM auth_failures").run();
    for (let i = 0; i < 20; i++) expect((await submit("wrong guess", `192.0.2.${i + 1}`)).status).toBe(401);
    await mark();
    before = await rows();
    expect((await submit("wrong guess", "192.0.2.1")).status).toBe(429);
    expect(await rows()).toEqual(before);

    // And once all networks together have used their tries, a new one adds no row either.
    for (let i = 0; i < 20; i++) expect((await submit("another guess", `2001:db8:0:${(i + 1).toString(16)}::1`)).status).toBe(401);
    await mark();
    before = await rows();
    expect((await submit("open sesame 1", "2001:db8:0:ff::1")).status).toBe(429);
    expect(await rows()).toEqual(before);
  });

  it("stops recording wrong API credentials at the Free plan's daily budget, and keeps refusing them", async () => {
    const FREE = { WORKERS_PLAN: "free" } as Partial<Env>;
    const limit = planLimits({ WORKERS_PLAN: "free" }).apiFailureWrites;
    for (let i = 0; i < 10; i++) await wrongToken("198.51.100.70", FREE);
    expect((await call(`${API}/links`, { headers: { ...bearer, "CF-Connecting-IP": "198.51.100.70" } })).status).toBe(429);
    await env.DB.prepare("INSERT INTO auth_failures (key, fails, window_start, locked_until, lockouts, updated_at) VALUES ('api:*', ?1, ?2, 0, 0, ?2)").bind(limit - 1, nowSec()).run();
    // Every network still counts until the shared count, added to every so often, reaches the budget.
    for (let i = 0; i < 15; i++) expect((await wrongToken(`203.0.113.${i + 1}`, FREE)).status).toBe(401);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE key LIKE 'api:%' AND key != 'api:*'").first<{ n: number }>())?.n).toBe(15);

    const count = (await rows()).length;
    expect((await wrongToken("198.51.100.71", FREE)).status).toBe(401);
    expect((await rows()).length).toBe(count);
    // A network locked earlier stays locked, and the right token still works elsewhere.
    expect((await call(`${API}/links`, { headers: { ...bearer, "CF-Connecting-IP": "198.51.100.70" } })).status).toBe(429);
    expect((await call(`${API}/links`, { headers: { ...bearer, "CF-Connecting-IP": "198.51.100.72" } })).status).toBe(200);
  });

  it("has no such budget on Workers Paid", async () => {
    for (let i = 0; i < 30; i++) await wrongToken(`203.0.113.${i + 1}`, { WORKERS_PLAN: "paid" } as Partial<Env>);
    expect(await env.DB.prepare("SELECT 1 FROM auth_failures WHERE key = 'api:*'").first()).toBeNull();
    expect((await rows()).length).toBe(30);
  });
});

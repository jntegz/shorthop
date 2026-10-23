import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiKeyDTO, NewApiKeyDTO, VersionDTO } from "../src/shared/types";
import { nowSec } from "../src/worker/db";
import { API, bearer, call, json, resetData } from "./helpers";
import { addKey, addUser, adminCall } from "./people";

beforeEach(resetData);

const newLink = (auth: Record<string, string>, slug: string) => call(`${API}/links`, json({ url: "https://example.com/", slug }, auth));

describe("personal API keys", () => {
  it("is shown once and works as a Bearer token", async () => {
    await addUser("ben@example.com", "user", ["api.use", "links.create"]);
    const res = await adminCall("ben@example.com", "/keys", { body: { name: "Zapier", permissions: ["links.create"], expiresInDays: 30 } });
    expect(res.status).toBe(201);
    const { key, secret } = await res.json<NewApiKeyDTO>();
    expect(secret).toMatch(/^shp_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({ name: "Zapier", owner: "ben@example.com", permissions: ["links.create"], expired: false });
    expect(key.expiresAt! - nowSec()).toBeGreaterThan(29 * 86400);

    const list = await (await adminCall("ben@example.com", "/keys")).json<{ keys: ApiKeyDTO[] }>();
    expect(list.keys.map((k) => k.id)).toEqual([key.id]);
    expect(JSON.stringify(list)).not.toContain(secret.slice(14));

    const auth = { Authorization: `Bearer ${secret}` };
    expect((await newLink(auth, "via-key")).status).toBe(201);
    const history = await (await call(`${API}/links/sh.example/via-key/history`, { headers: auth })).json<{ versions: VersionDTO[] }>();
    expect(history.versions[0]?.actor).toBe("ben@example.com · API key Zapier");
  });

  it("can only do what it was given, and what its owner still can", async () => {
    await addUser("ben@example.com", "user", ["api.use", "links.create", "links.delete"]);
    const viewOnly = await addKey("ben@example.com", []);
    expect((await call(`${API}/links`, { headers: viewOnly.auth })).status).toBe(200);
    expect((await newLink(viewOnly.auth, "nope")).status).toBe(403);

    // Asking for more than you have is refused.
    expect((await adminCall("ben@example.com", "/keys", { body: { name: "Too much", permissions: ["settings.manage"] } })).status).toBe(403);

    const creator = await addKey("ben@example.com", ["links.create"]);
    expect((await newLink(creator.auth, "first")).status).toBe(201);
    await adminCall("", "/users/ben%40example.com", { method: "PATCH", body: { permissions: ["api.use"] } });
    expect((await newLink(creator.auth, "second")).status).toBe(403);

    // Without api.use the keys stop working altogether.
    await adminCall("", "/users/ben%40example.com", { method: "PATCH", body: { permissions: ["links.create"] } });
    expect((await call(`${API}/links`, { headers: creator.auth })).status).toBe(401);
  });

  it("stops working when expired or revoked, and only its owner or an admin can revoke it", async () => {
    await addUser("ben@example.com", "user", ["api.use"]);
    await addUser("amy@example.com", "user", ["api.use"]);
    const expired = await addKey("ben@example.com", [], { expiresAt: nowSec() - 1 });
    expect((await call(`${API}/links`, { headers: expired.auth })).status).toBe(401);

    const key = await addKey("ben@example.com", []);
    expect((await adminCall("amy@example.com", `/keys/${key.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await adminCall("ben@example.com", `/keys/${key.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`${API}/links`, { headers: key.auth })).status).toBe(401);

    const other = await addKey("amy@example.com", []);
    const all = await (await adminCall("", "/keys?all=1")).json<{ keys: ApiKeyDTO[] }>();
    expect(all.keys.map((k) => k.owner)).toContain("amy@example.com");
    expect((await adminCall("", `/keys/${other.id}`, { method: "DELETE" })).status).toBe(200);
  });

  it("works for owners, and dies with an owner removed from ADMIN_EMAIL", async () => {
    const key = await addKey("owner@example.com", ["links.create"]);
    expect((await newLink(key.auth, "owner-key")).status).toBe(201);
    const res = await call(`${API}/links`, { headers: key.auth }, { ADMIN_EMAIL: "someone@else.com" });
    expect(res.status).toBe(401);
  });

  it("can't manage people, keys or sessions", async () => {
    const key = await addKey("owner@example.com", ["links.create", "links.edit", "links.delete", "stats.view", "health.manage", "settings.manage"]);
    for (const [path, method] of [
      ["/users", "GET"],
      ["/keys", "GET"],
      ["/keys", "POST"],
      ["/settings/sessions/revoke", "POST"],
    ]) {
      expect((await call(`${API}${path}`, { method, headers: key.auth })).status, path).toBe(403);
    }
  });

  it("records use at most once an hour", async () => {
    await addUser("ben@example.com", "user", ["api.use"]);
    const key = await addKey("ben@example.com", []);
    const lastUsed = async () => (await env.DB.prepare("SELECT last_used_at AS t FROM api_keys WHERE id = ?").bind(key.id).first<{ t: number | null }>())?.t;
    await call(`${API}/links`, { headers: key.auth });
    expect(await lastUsed()).toBeGreaterThan(nowSec() - 5);

    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(nowSec() - 100, key.id).run();
    await call(`${API}/links`, { headers: key.auth });
    expect(await lastUsed()).toBeLessThan(nowSec() - 90);

    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(nowSec() - 4000, key.id).run();
    await call(`${API}/links`, { headers: key.auth });
    expect(await lastUsed()).toBeGreaterThan(nowSec() - 5);
  });

  it("allows 20 keys per person", async () => {
    await addUser("ben@example.com", "user", ["api.use"]);
    for (let i = 0; i < 19; i++) await addKey("ben@example.com", []);
    expect((await adminCall("ben@example.com", "/keys", { body: { name: "Twentieth" } })).status).toBe(201);
    expect((await adminCall("ben@example.com", "/keys", { body: { name: "One too many" } })).status).toBe(409);
  });

  it("keeps the server token working with full access", async () => {
    expect((await newLink(bearer, "legacy")).status).toBe(201);
    expect((await call(`${API}/links`, { headers: { Authorization: "Bearer shp_abcdefgh_" + "x".repeat(43), "CF-Connecting-IP": "203.0.113.77" } })).status).toBe(401);
  });
});

describe("import", () => {
  const rows = [{ slug: "imp", target: "https://example.com/new" }];

  it("needs Edit links to overwrite, even for a dry run", async () => {
    await addUser("ben@example.com", "user", ["api.use", "links.create"]);
    const key = await addKey("ben@example.com", ["links.create"]);
    expect((await call(`${API}/import`, json({ rows, mode: "overwrite", dryRun: true }, key.auth))).status).toBe(403);
    expect((await call(`${API}/import`, json({ rows }, key.auth))).status).toBe(200);
  });

  it("never overwrites in skip mode", async () => {
    await newLink(bearer, "imp");
    const res = await call(`${API}/import`, json({ rows }));
    expect((await res.json<{ skipped: number }>()).skipped).toBe(1);
    const { link } = await (await call(`${API}/links/sh.example/imp`, { headers: bearer })).json<{ link: { target: string } }>();
    expect(link.target).toBe("https://example.com/");
  });
});

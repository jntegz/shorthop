import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DELETED_RETENTION_DAYS, HISTORY_RETENTION_DAYS, diffSnapshots } from "../src/shared/history";
import type { DeletedLinkDTO, LinkDTO, VersionDTO } from "../src/shared/types";
import { nowSec } from "../src/worker/db";
import { pruneHistory } from "../src/worker/history";
import { API, bearer, call, json, resetData } from "./helpers";

beforeEach(resetData);

const patch = (slug: string, body: unknown) => call(`${API}/links/sh.example/${slug}`, { ...json(body), method: "PATCH" });
const history = async (slug: string) =>
  ((await (await call(`${API}/links/sh.example/${slug}/history`, { headers: bearer })).json()) as { versions: VersionDTO[] }).versions;
const deleted = async () => ((await (await call(`${API}/deleted`, { headers: bearer })).json()) as { links: DeletedLinkDTO[] }).links;
const kv = (slug: string) => env.LINKS.get(`sh.example/${slug}`, "json") as Promise<{ u: string; a: number } | null>;

async function create(slug: string, extra: Record<string, unknown> = {}) {
  const res = await call(`${API}/links`, json({ slug, target: "https://example.com/one", title: "First", tags: ["a"], ...extra }));
  expect(res.status).toBe(201);
}

describe("recording", () => {
  it("records creation and each real change, newest first, with who made it", async () => {
    await create("guide");
    await patch("guide", { target: "https://example.com/two" });
    await patch("guide", { title: "First" }); // no change: no version
    await patch("guide", { active: false, tags: ["a", "b"] });
    const v = await history("guide");
    expect(v.map((x) => x.action)).toEqual(["update", "update", "create"]);
    expect(v.every((x) => x.actor === "api-token")).toBe(true);
    expect(v[0]!.snapshot).toMatchObject({ target: "https://example.com/two", active: 0, tags: "a,b", source: "native" });
    expect(diffSnapshots(v[1]!.snapshot, v[0]!.snapshot).map((c) => c.field)).toEqual(["active", "tags"]);
  });

  it("records imports with what was saved", async () => {
    await call(`${API}/import`, json({ rows: [{ slug: "old", target: "http://example.com/x", title: "Old" }] }));
    const v = await history("old");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ action: "import", snapshot: { target: "http://example.com/x", source: "import" } });
  });
});

describe("restoring a version", () => {
  it("puts the fields back, republishes, and records the restore", async () => {
    await create("guide");
    await patch("guide", { target: "https://example.com/two", notes: "changed" });
    const [, first] = await history("guide");
    const res = await call(`${API}/links/sh.example/guide/history/${first!.id}/restore`, { method: "POST", headers: bearer });
    expect(res.status).toBe(200);
    const { link } = (await res.json()) as { link: LinkDTO };
    expect(link).toMatchObject({ target: "https://example.com/one", notes: "" });
    expect((await kv("guide"))?.u).toBe("https://example.com/one");
    const v = await history("guide");
    expect(v[0]).toMatchObject({ action: "restore", restoredFrom: first!.id });

    // Restoring what the link already is changes nothing.
    const again = await call(`${API}/links/sh.example/guide/history/${first!.id}/restore`, { method: "POST", headers: bearer });
    expect(again.status).toBe(409);
  });

  it("refuses versions of other links and unknown ids", async () => {
    await create("guide");
    await create("other");
    const [otherV] = await history("other");
    expect((await call(`${API}/links/sh.example/guide/history/${otherV!.id}/restore`, { method: "POST", headers: bearer })).status).toBe(404);
    expect((await call(`${API}/links/sh.example/guide/history/999999/restore`, { method: "POST", headers: bearer })).status).toBe(404);
  });
});

describe("deleted links", () => {
  it("can be brought back with their settings and creation date", async () => {
    await create("guide", { notes: "keep me" });
    const createdAt = (await env.DB.prepare("SELECT created_at FROM links WHERE slug = 'guide'").first<{ created_at: number }>())!.created_at;
    await call(`${API}/links/sh.example/guide`, { method: "DELETE", headers: bearer });
    expect(await kv("guide")).toBeNull();
    const list = await deleted();
    expect(list).toMatchObject([{ domain: "sh.example", slug: "guide", target: "https://example.com/one", title: "First", actor: "api-token" }]);

    const res = await call(`${API}/deleted/sh.example/guide/restore`, { method: "POST", headers: bearer });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { link: LinkDTO }).link).toMatchObject({ notes: "keep me", tags: ["a"], createdAt });
    expect((await kv("guide"))?.u).toBe("https://example.com/one");
    expect(await deleted()).toEqual([]);
    expect((await history("guide")).map((v) => v.action)).toEqual(["restore", "delete", "create"]);
    expect((await call(`${API}/deleted/sh.example/guide/restore`, { method: "POST", headers: bearer })).status).toBe(409);
  });

  it("aren't listed once the slug is used again", async () => {
    await create("guide");
    await call(`${API}/links/sh.example/guide`, { method: "DELETE", headers: bearer });
    await create("guide", { target: "https://example.com/new" });
    expect(await deleted()).toEqual([]);
    expect((await call(`${API}/deleted/sh.example/guide/restore`, { method: "POST", headers: bearer })).status).toBe(409);
  });
});

describe("retention", () => {
  it("drops old versions but keeps each link's latest, and forgets long-deleted links", async () => {
    await create("guide");
    await patch("guide", { title: "Second" });
    await create("gone");
    await call(`${API}/links/sh.example/gone`, { method: "DELETE", headers: bearer });
    const old = nowSec() - (HISTORY_RETENTION_DAYS + 1) * 86400;
    await env.DB.prepare("UPDATE link_versions SET at = ?").bind(old).run();
    expect(DELETED_RETENTION_DAYS).toBeLessThan(HISTORY_RETENTION_DAYS);

    await pruneHistory(env.DB);
    expect((await history("guide")).map((v) => v.action)).toEqual(["update"]);
    expect(await history("gone")).toEqual([]);
  });
});

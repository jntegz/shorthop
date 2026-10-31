import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BulkResult, LinkDTO } from "../src/shared/types";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";

beforeEach(resetData);

async function create(slug: string, extra: Record<string, unknown> = {}) {
  const res = await call(`${API}/links`, json({ slug, target: `https://example.com/${slug}`, ...extra }));
  expect(res.status).toBe(201);
}

const bulk = async (body: Record<string, unknown>, envOverride: Partial<Env> = {}) => {
  const res = await call(`${API}/links/bulk`, json(body), envOverride);
  return { res, data: (await res.json()) as BulkResult & { error?: string } };
};
const ref = (slug: string) => ({ domain: "sh.example", slug });
const get = async (slug: string) => ((await (await call(`${API}/links/sh.example/${slug}`, { headers: bearer })).json()) as { link: LinkDTO }).link;
const versions = async (slug: string) =>
  (await env.DB.prepare("SELECT action FROM link_versions WHERE domain = 'sh.example' AND slug = ? ORDER BY id").bind(slug).all<{ action: string }>()).results.map((r) => r.action);

describe("bulk actions", () => {
  it("disables and enables links, republishing them and keeping a version each", async () => {
    await create("a");
    await create("b");
    const off = await bulk({ links: [ref("a"), ref("b"), ref("missing")], action: "disable" });
    expect(off.res.status).toBe(200);
    expect(off.data).toMatchObject({ changed: 2, unchanged: 0, failed: [{ slug: "missing", error: "Link not found" }] });
    expect((await call(`${ORIGIN}/a`)).status).toBe(404);
    expect(await versions("a")).toEqual(["create", "update"]);

    const again = await bulk({ links: [ref("a")], action: "disable" });
    expect(again.data).toMatchObject({ changed: 0, unchanged: 1 });

    await bulk({ links: [ref("a")], action: "enable" });
    expect((await call(`${ORIGIN}/a`)).headers.get("Location")).toBe("https://example.com/a");
  });

  it("adds and removes a tag without touching the published link", async () => {
    await create("a", { tags: "old" });
    const before = await env.LINKS.get("sh.example/a");
    await bulk({ links: [ref("a")], action: "addTag", tag: "Launch Week" });
    expect((await get("a")).tags).toEqual(["old", "launch-week"]);
    await bulk({ links: [ref("a")], action: "removeTag", tag: "old" });
    expect((await get("a")).tags).toEqual(["launch-week"]);
    expect(await env.LINKS.get("sh.example/a")).toBe(before);
    expect((await bulk({ links: [ref("a")], action: "addTag" })).res.status).toBe(400);
  });

  it("deletes links so they can be restored, and ends their shares", async () => {
    await create("a");
    await create("b");
    const { data } = await bulk({ links: [ref("a"), ref("b")], action: "delete" });
    expect(data.changed).toBe(2);
    expect(await env.LINKS.get("sh.example/a")).toBeNull();
    const deleted = (await (await call(`${API}/deleted`, { headers: bearer })).json()) as { links: { slug: string }[] };
    expect(deleted.links.map((l) => l.slug).sort()).toEqual(["a", "b"]);
  });

  it("caps a request at the plan's bulk size", async () => {
    const links = Array.from({ length: 21 }, (_, i) => ref(`x${i}`));
    const { res, data } = await bulk({ links, action: "disable" }, { WORKERS_PLAN: "free" });
    expect(res.status).toBe(413);
    expect(data).toMatchObject({ error: expect.stringContaining("20") });
  });
});

describe("tags", () => {
  it("renames a tag, merging into an existing one, and removes a tag everywhere", async () => {
    await create("a", { tags: "draft, news" });
    await create("b", { tags: "draft" });
    const renamed = await call(`${API}/tags/rename`, json({ from: "draft", to: "News" }));
    expect(await renamed.json()).toEqual({ changed: 2 });
    expect((await get("a")).tags).toEqual(["news"]);
    expect((await get("b")).tags).toEqual(["news"]);

    const removed = await call(`${API}/tags/news`, { method: "DELETE", headers: bearer });
    expect(await removed.json()).toEqual({ changed: 2 });
    expect((await get("a")).tags).toEqual([]);
  });
});

describe("links by destination", () => {
  it("finds links that already go to the same destination, after normalizing it", async () => {
    await create("a");
    const res = await call(`${API}/links/by-target?url=${encodeURIComponent("  https://EXAMPLE.com/a ")}`, { headers: bearer });
    const body = (await res.json()) as { links: LinkDTO[] };
    expect(body.links.map((l) => l.slug)).toEqual(["a"]);
    const none = (await (await call(`${API}/links/by-target?url=not-a-url`, { headers: bearer })).json()) as { links: LinkDTO[] };
    expect(none.links).toEqual([]);
  });
});

describe("links export", () => {
  it("exports only the filtered links, or a selection", async () => {
    await create("a", { tags: "keep" });
    await create("b");
    const filtered = await (await call(`${API}/export/links.csv?tag=keep`, { headers: bearer })).text();
    expect(filtered).toContain("/a,");
    expect(filtered).not.toContain("/b,");
    expect(filtered.split("\n")[0]).toContain("off_redirect");
    const picked = await (await call(`${API}/export/links.csv?links=${encodeURIComponent("sh.example/b")}`, { headers: bearer })).text();
    expect(picked).toContain("/b,");
    expect(picked).not.toContain("/a,");
  });
});

// The migration kit: imports that remember where links came from, another
// workspace's JSON export with every setting, and pulling links straight from
// Bitly, Rebrandly, Short.io and Dub.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportResult, LinkDTO } from "../src/shared/types";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";
import { adminCall } from "./people";

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

const get = async (slug: string) => ((await (await call(`${API}/links/sh.example/${slug}`, { headers: bearer })).json()) as { link: LinkDTO }).link;
const importRows = async (body: Record<string, unknown>) => (await call(`${API}/import`, json(body))).json<ImportResult>();

describe("imports", () => {
  it("remember where links came from, and shorten long titles", async () => {
    const res = await importRows({ from: "bitly", rows: [{ slug: "a", target: "https://example.com/a", title: "x".repeat(400), clicks: 12 }] });
    expect(res.created).toBe(1);
    const link = await get("a");
    expect(link).toMatchObject({ importFrom: "bitly", importedClicks: 12, source: "import" });
    expect(link.title).toHaveLength(300);
  });

  it("round-trips every setting through the JSON export, but never the password", async () => {
    const created = await call(
      `${API}/links`,
      json({
        slug: "full",
        target: "https://example.com/full",
        title: "Full",
        tags: "a,b",
        notes: "hello",
        utm: true,
        utmTemplate: "utm_source=x",
        passQuery: true,
        maxClicks: 50,
        password: "a-long-secret-1",
        preview: { title: "Preview title", description: "", image: null },
      }),
    );
    expect(created.status).toBe(201);
    const exported = (await (await call(`${API}/export/links.json`, { headers: bearer })).json()) as { format: string; links: Record<string, unknown>[] };
    expect(exported.format).toBe("shorthop-links");
    expect(JSON.stringify(exported)).not.toContain("a-long-secret-1");
    expect(JSON.stringify(exported)).not.toContain("password");

    await call(`${API}/links/sh.example/full`, { method: "DELETE", headers: bearer });
    const res = await importRows({ from: "json", rows: exported.links });
    expect(res).toMatchObject({ created: 1, errors: 0 });
    const link = await get("full");
    expect(link).toMatchObject({ importFrom: "json", title: "Full", tags: ["a", "b"], notes: "hello", utm: true, utmTemplate: "utm_source=x", passQuery: true, maxClicks: 50, protected: false });
    expect(link.preview).toMatchObject({ title: "Preview title" });
  });

  it("an overwrite with settings replaces them; without, keeps them", async () => {
    await call(`${API}/links`, json({ slug: "o", target: "https://example.com/o", notes: "keep me" }));
    await importRows({ mode: "overwrite", rows: [{ slug: "o", target: "https://example.com/new" }] });
    expect(await get("o")).toMatchObject({ target: "https://example.com/new", notes: "keep me" });
    await importRows({ mode: "overwrite", rows: [{ slug: "o", target: "https://example.com/new", config: { notes: "replaced", active: false } }] });
    expect(await get("o")).toMatchObject({ notes: "replaced", active: false });
  });

  it("refuses bad settings row by row", async () => {
    const res = await importRows({ rows: [{ slug: "bad", target: "https://example.com/", config: { utmTemplate: "not a template" } }, { slug: "ok", target: "https://example.com/" }] });
    expect(res).toMatchObject({ created: 1, errors: 1 });
  });
});

/** Answers each vendor URL from `routes` (first matching prefix); counts the calls. */
function vendorApi(routes: [prefix: string, answer: (url: URL) => unknown][]) {
  const seen: string[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes.find(([p]) => url.startsWith(p));
    if (!route) return real(input, init);
    seen.push(url);
    const headers = new Headers(init?.headers);
    if (!headers.get("Authorization") && !headers.get("apikey")) return new Response("no key", { status: 401 });
    return Response.json(route[1](new URL(url)));
  });
  return seen;
}

const pull = (body: Record<string, unknown>, envOverride: Partial<Env> = {}) => adminCall("", "/import/pull", { body }, envOverride);

describe("pulling from another shortener", () => {
  it("Bitly: the branded back-half first, click totals, and a cursor until the end", async () => {
    const seen = vendorApi([
      ["https://api-ssl.bitly.com/v4/user", () => ({ default_group_guid: "G1" })],
      [
        "https://api-ssl.bitly.com/v4/groups/G1/bitlinks",
        (u) =>
          u.searchParams.get("search_after")
            ? { links: [{ id: "bit.ly/plain", link: "https://bit.ly/plain", long_url: "https://example.com/p", created_at: "2025-01-02T03:04:05+0000" }], pagination: {} }
            : {
                links: [{ id: "bit.ly/abc", link: "https://bit.ly/abc", long_url: "https://example.com/a", title: "A", tags: ["x"], custom_bitlinks: ["https://brand.co/launch"] }],
                pagination: { search_after: "next1" },
              },
      ],
      ["https://api-ssl.bitly.com/v4/bitlinks/", () => ({ total_clicks: 41 })],
    ]);
    const first = await (await pull({ vendor: "bitly", apiKey: "bitly-key-123" })).json<{ rows: Record<string, unknown>[]; cursor: string | null }>();
    expect(first.rows).toEqual([{ domain: "brand.co", slug: "launch", target: "https://example.com/a", title: "A", tags: ["x"], clicks: 41, createdAt: null }]);
    expect(first.cursor).toBeTruthy();
    const second = await (await pull({ vendor: "bitly", apiKey: "bitly-key-123", cursor: first.cursor })).json<{ rows: Record<string, unknown>[]; cursor: string | null }>();
    expect(second.rows[0]).toMatchObject({ domain: "bit.ly", slug: "plain", createdAt: 1735787045 });
    expect(second.cursor).toBeNull();
    expect(seen.some((u) => u.includes("search_after=next1"))).toBe(true);
  });

  it("Rebrandly, Short.io and Dub map their fields", async () => {
    vendorApi([
      ["https://api.rebrandly.com/v1/links", () => [{ id: "r1", slashtag: "deal", destination: "https://example.com/r", title: "R", domain: { fullName: "go.brand.co" }, clicks: 7, createdAt: "2025-03-01T00:00:00Z" }]],
      ["https://api.short.io/api/domains", () => [{ id: 9, hostname: "s.brand.co" }]],
      ["https://api.short.io/api/links", () => ({ links: [{ id: 101, path: "promo", originalURL: "https://example.com/s", title: "S", tags: ["t"] }], nextPageToken: null })],
      ["https://api-v2.short.io/statistics/domain/9/link_clicks", () => ({ "101": 5 })],
      ["https://api.dub.co/links", () => [{ id: "d1", domain: "dub.sh", key: "hi", url: "https://example.com/d", title: null, tags: [{ name: "t1" }], clicks: 3, createdAt: "2025-04-01T00:00:00Z" }]],
    ]);
    const rb = await (await pull({ vendor: "rebrandly", apiKey: "rebrandly-key" })).json<{ rows: Record<string, unknown>[]; cursor: string | null }>();
    expect(rb).toMatchObject({ cursor: null, rows: [{ domain: "go.brand.co", slug: "deal", clicks: 7 }] });
    const so = await (await pull({ vendor: "shortio", apiKey: "shortio-key" })).json<{ rows: Record<string, unknown>[]; cursor: string | null }>();
    expect(so).toMatchObject({ cursor: null, rows: [{ domain: "s.brand.co", slug: "promo", clicks: 5, tags: ["t"] }] });
    const db = await (await pull({ vendor: "dub", apiKey: "dub_key_123" })).json<{ rows: Record<string, unknown>[]; cursor: string | null }>();
    expect(db).toMatchObject({ cursor: null, rows: [{ domain: "dub.sh", slug: "hi", tags: ["t1"], clicks: 3 }] });
  });

  it("passes a refused key on, never echoes it, and needs a signed-in person", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 401 }));
    const res = await pull({ vendor: "dub", apiKey: "dub_secret_value" });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("refused the API key");
    expect(text).not.toContain("dub_secret_value");

    // A script's API key can't hand over another service's key.
    const byKey = await call(`${ORIGIN}/api/import/pull`, json({ vendor: "dub", apiKey: "dub_secret_value" }));
    expect(byKey.status).toBe(403);
  });

  it("stays inside the plan's call budget", async () => {
    const seen = vendorApi([
      ["https://api-ssl.bitly.com/v4/user", () => ({ default_group_guid: "G" })],
      ["https://api-ssl.bitly.com/v4/groups/G/bitlinks", () => ({ links: Array.from({ length: 100 }, (_, i) => ({ id: `bit.ly/l${i}`, long_url: "https://example.com/" })), pagination: { search_after: "more" } })],
      ["https://api-ssl.bitly.com/v4/bitlinks/", () => ({ total_clicks: 1 })],
    ]);
    await pull({ vendor: "bitly", apiKey: "bitly-key-123" }, { WORKERS_PLAN: "free" });
    expect(seen.length).toBeLessThanOrEqual(40);
    expect(env.WORKERS_PLAN).toBeDefined();
  });
});

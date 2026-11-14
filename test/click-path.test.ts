import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { API, call, captureClicks, json, ORIGIN, putLink, resetData } from "./helpers";

beforeEach(resetData);

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers: { "User-Agent": CHROME, ...headers } });
const create = (body: Record<string, unknown>) => call(`${API}/links`, json(body));

describe("near-miss slugs", () => {
  beforeEach(async () => {
    expect((await create({ slug: "Talk26", target: "https://example.com/talk" })).status).toBe(201);
    expect((await create({ slug: "guide", target: "https://example.com/guide" })).status).toBe(201);
  });

  it("sends a slug that differs only by case to the link's own address, keeping the query", async () => {
    const { points, CLICKS } = captureClicks();
    const res = await call(get("/talk26?s=nl&x=1"), undefined, { CLICKS });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/Talk26?s=nl&x=1`);
    expect((await call(get("/GUIDE"), undefined, { CLICKS })).headers.get("Location")).toBe(`${ORIGIN}/guide`);
    // Nothing is recorded for the recovery itself: the link's own address counts the click.
    expect(points).toEqual([]);
    expect((await call(get("/Talk26?s=nl"), undefined, { CLICKS })).headers.get("Location")).toBe("https://example.com/talk");
    expect(points.map((p) => [p.indexes?.[0], p.blobs?.[0]])).toEqual([["Talk26", "click"]]);
  });

  it("drops the punctuation a pasted link picks up", async () => {
    for (const path of ["/guide.", "/guide)", "/guide%22", "/guide).", "/guide,", "/guide!", "/guide%5D", "/guide'"]) {
      const res = await call(get(path));
      expect(res.status, path).toBe(302);
      expect(res.headers.get("Location"), path).toBe(`${ORIGIN}/guide`);
    }
    // Both at once: punctuation and case.
    expect((await call(get("/TALK26)."))).headers.get("Location")).toBe(`${ORIGIN}/Talk26`);
  });

  it("chooses neither when two links differ only by case, and logs the miss as before", async () => {
    expect((await create({ slug: "Guide", target: "https://example.com/other" })).status).toBe(201);
    const { points, CLICKS } = captureClicks();
    const res = await call(get("/GUIDE"), undefined, { CLICKS });
    expect(res.status).toBe(404);
    expect(points.map((p) => [p.indexes?.[0], p.blobs?.[0]])).toEqual([["GUIDE", "miss"]]);
    // Each of the two still answers at its own address.
    expect((await call(get("/Guide"))).headers.get("Location")).toBe("https://example.com/other");
  });

  it("leaves unknown slugs, scanner paths and other methods alone", async () => {
    const { points, CLICKS } = captureClicks();
    expect((await call(get("/nothing-here"), undefined, { CLICKS })).status).toBe(404);
    expect(points.map((p) => [p.indexes?.[0], p.blobs?.[0]])).toEqual([["nothing-here", "miss"]]);
    // A scanner path is never looked up in D1, even when a link matches apart from case.
    await env.DB.prepare("UPDATE links SET slug = 'WP-Login' WHERE slug = 'Talk26'").run();
    expect((await call(get("/wp-login"))).status).toBe(404);
    expect((await call(new Request(`${ORIGIN}/GUIDE`, { method: "POST" }))).status).toBe(405);
  });

  it("doesn't loop when the database has a link that KV doesn't", async () => {
    await env.LINKS.delete("sh.example/guide");
    expect((await call(get("/guide"))).status).toBe(404);
    expect((await call(get("/guide."))).status).toBe(404);
  });

  it("on a domain with only lower-case slugs, recovers by KV and doesn't ask D1 for each miss", async () => {
    await env.DB.prepare("DELETE FROM links WHERE slug = 'Talk26'").run();
    await env.LINKS.delete("sh.example/Talk26");
    const asked: string[] = [];
    const DB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            asked.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect((await call(get("/GUIDE"), undefined, { DB })).headers.get("Location")).toBe(`${ORIGIN}/guide`);
    for (const path of ["/nothing-here", "/abc123", "/Nothing"]) expect((await call(get(path), undefined, { DB })).status, path).toBe(404);
    // One read for the domain, cached; no lookup per miss.
    expect(asked.filter((sql) => sql.includes("FROM links"))).toEqual([expect.stringContaining("links_mixed_case")]);
  });

  it("finds the match through the index, not a scan", async () => {
    const { results } = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT slug FROM links WHERE domain = ?1 AND slug = ?2 COLLATE NOCASE LIMIT 2").bind("sh.example", "guide").all<{ detail: string }>();
    expect(results.map((r) => r.detail).join(" ")).toMatch(/SEARCH links USING (COVERING )?INDEX links_slug_nocase/);
  });
});

describe("{source} in UTM templates", () => {
  it("uses the referrer, like the recorded click", async () => {
    await putLink("utm", { u: "https://example.com/a", utm: 1, t: "utm_source={source}&utm_campaign={slug}" });
    const { points, CLICKS } = captureClicks();
    const res = await call(get("/utm", { Referer: "https://www.linkedin.com/feed/" }), undefined, { CLICKS });
    const source = new URL(res.headers.get("Location")!).searchParams.get("utm_source");
    expect(source).toBe("li");
    expect(points[0]?.blobs?.[11]).toBe(source);
    expect((await call(get("/utm"))).headers.get("Location")).toBe("https://example.com/a?utm_source=direct&utm_campaign=utm");
    // The shortener's own pages are not a source.
    expect((await call(get("/utm", { Referer: `${ORIGIN}/me` }))).headers.get("Location")).toContain("utm_source=direct");
  });
});

describe("malformed KV records", () => {
  it("falls back to the plain destination when routing rules are malformed", async () => {
    for (const ro of [[{}], [null], ["x"], [{ id: "r", devices: [], countries: [], countryMode: "in", variants: [{ id: "v", weight: 100 }] }], [{ id: "r", devices: [], countries: [], countryMode: "in", variants: "x" }]]) {
      await putLink("routed", { u: "https://example.com/plain", ro: ro as never });
      const res = await call(get("/routed"));
      expect(res.status, JSON.stringify(ro)).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/plain");
    }
  });

  it("falls back to the plain destination when a bio page is malformed, counting one click", async () => {
    for (const bio of ["x", {}, { name: "A", blocks: [null] }, { name: "A", blocks: "x" }]) {
      await putLink("me", { u: "https://example.com/plain", bio: bio as never });
      const { points, CLICKS } = captureClicks();
      const res = await call(get("/me"), undefined, { CLICKS });
      expect(res.status, JSON.stringify(bio)).toBe(302);
      expect(res.headers.get("Location")).toBe("https://example.com/plain");
      expect(points.length).toBe(1);
    }
  });
});

describe("bio page caching", () => {
  const bio = { name: "Ada Example", text: "", theme: "auto", accent: "#6554c0", avatarKey: null, blocks: [{ label: "Website", url: "https://example.com/" }] };
  const submit = (password: string) =>
    call(new Request(`${ORIGIN}/me`, { method: "POST", headers: { "User-Agent": CHROME, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) }));

  it("lets browsers cache an open page briefly", async () => {
    expect((await create({ slug: "me", target: "https://example.com/", bio })).status).toBe(201);
    const page = await call(get("/me"));
    expect(page.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(page.headers.get("X-Robots-Tag")).toBe("all");
  });

  it("never lets a password-protected page be stored", async () => {
    expect((await create({ slug: "me", target: "https://example.com/", bio, password: "open sesame" })).status).toBe(201);
    const cookie = (await submit("open sesame")).headers.get("Set-Cookie")!.split(";")[0]!;
    const page = await call(get("/me", { Cookie: cookie }));
    expect(await page.text()).toContain("Ada Example");
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    expect(page.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("never lets a click-limited page be stored", async () => {
    expect((await create({ slug: "me", target: "https://example.com/", bio, maxClicks: 1 })).status).toBe(201);
    const page = await call(get("/me"));
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await call(get("/me"))).status).toBe(410);
  });
});

describe("destinations without a scheme", () => {
  it("saves example.com/page as https://example.com/page", async () => {
    const res = await create({ slug: "bare", target: "example.com/page" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { link: { target: string } }).link.target).toBe("https://example.com/page");
    expect((await call(get("/bare"))).headers.get("Location")).toBe("https://example.com/page");
    const bad = await create({ slug: "bad", target: "mailto:me@example.com" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("Destination must start with https://.");
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImportResult, LinkDTO, LinkListItem } from "../src/shared/types";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";

beforeEach(resetData);

async function create(body: Record<string, unknown>) {
  const res = await call(`${API}/links`, json(body));
  return { res, data: (await res.json()) as { link: LinkDTO; error?: string } };
}

const kv = (slug: string, domain = "sh.example") => env.LINKS.get(`${domain}/${slug}`, "json") as Promise<Record<string, unknown> | null>;

describe("create", () => {
  it("creates links with UTM off unless it's asked for", async () => {
    const { res, data } = await create({ url: "https://example.com/plain" });
    expect(res.status).toBe(201);
    expect(data.link.utm).toBe(false);
    expect((await call(`${ORIGIN}/${data.link.slug}`)).headers.get("Location")).toBe("https://example.com/plain");
  });

  it("creates an auto-slug link, publishes it to KV and redirects with UTM", async () => {
    const { res, data } = await create({ url: "https://example.com/guide", utm: true });
    expect(res.status).toBe(201);
    expect(data.link.slug).toMatch(/^[0-9A-Za-z]{6}$/);
    expect(data.link.shortUrl).toBe(`${ORIGIN}/${data.link.slug}`);
    expect(await kv(data.link.slug)).toEqual({
      u: "https://example.com/guide",
      a: 1,
      e: null,
      utm: 1,
      qp: 0,
      t: "utm_source={domain}&utm_medium=shortlink&utm_campaign={slug}",
    });
    const redirect = await call(`${ORIGIN}/${data.link.slug}`);
    expect(redirect.headers.get("Location")).toBe(
      `https://example.com/guide?utm_source=sh.example&utm_medium=shortlink&utm_campaign=${data.link.slug}`,
    );
  });

  it("supports custom slugs, tags, expiry and the plain-text response for Shortcuts", async () => {
    const res = await call(`${API}/links?format=text`, json({ slug: "Talk-2026", target: "https://example.com/talk", tags: "Talks, 2026", expiresAt: "2030-01-01T00:00:00Z" }));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe(`${ORIGIN}/Talk-2026`);
    const got = (await (await call(`${API}/links/sh.example/Talk-2026`, { headers: bearer })).json()) as { link: LinkDTO };
    expect(got.link.tags).toEqual(["talks", "2026"]);
    expect(got.link.expiresAt).toBe(1893456000);
  });

  it("rejects duplicates, reserved slugs, bad slugs and unsafe targets", async () => {
    await create({ slug: "dup", target: "https://example.com/" });
    expect((await create({ slug: "dup", target: "https://example.com/" })).res.status).toBe(409);
    expect((await create({ slug: "health", target: "https://example.com/" })).res.status).toBe(400);
    expect((await create({ slug: "a.b", target: "https://example.com/" })).res.status).toBe(400);
    expect((await create({ target: "http://example.com/" })).res.status).toBe(400);
    expect((await create({ target: "javascript:alert(1)" })).res.status).toBe(400);
    expect((await create({ target: "https://sh.example/loop" })).res.status).toBe(400);
    expect((await create({})).res.status).toBe(400);
    expect((await create({ target: "https://example.com/", utmTemplate: "bad template" })).res.status).toBe(400);
  });
});

describe("update and delete", () => {
  it("edits, disables and re-enables a link", async () => {
    await create({ slug: "edit-me", target: "https://example.com/a", utm: false });
    let res = await call(`${API}/links/sh.example/edit-me`, { ...json({ target: "https://example.com/b", passQuery: true }), method: "PATCH" });
    expect(res.status).toBe(200);
    expect(await kv("edit-me")).toMatchObject({ u: "https://example.com/b", qp: 1, utm: 0 });
    expect((await call(`${ORIGIN}/edit-me?x=1`)).headers.get("Location")).toBe("https://example.com/b?x=1");

    res = await call(`${API}/links/sh.example/edit-me`, { ...json({ active: false }), method: "PATCH" });
    expect(((await res.json()) as { link: LinkDTO }).link.active).toBe(false);
    expect((await call(`${ORIGIN}/edit-me`)).status).toBe(404);

    await call(`${API}/links/sh.example/edit-me`, { ...json({ active: true }), method: "PATCH" });
    expect((await call(`${ORIGIN}/edit-me`)).status).toBe(302);
  });

  it("doesn't publish a link deleted while it was being edited", async () => {
    await create({ slug: "racy", target: "https://example.com/a" });
    // The DELETE lands between the PATCH's read and its UPDATE (sent in a batch with its version).
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            await env.LINKS.delete("sh.example/racy");
            await env.DB.prepare("DELETE FROM links WHERE domain = 'sh.example' AND slug = 'racy'").run();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await call(`${API}/links/sh.example/racy`, { ...json({ target: "https://example.com/b" }), method: "PATCH" }, { DB });
    expect(res.status).toBe(404);
    expect(await kv("racy")).toBeNull();
    // The lost edit leaves no version: one after a delete would hide it from "Recently deleted".
    const { results } = await env.DB.prepare("SELECT action FROM link_versions WHERE slug = 'racy' ORDER BY id").all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(["create"]);
  });

  it("takes back an edit's KV record when the link is deleted right after it's published", async () => {
    await create({ slug: "late", target: "https://example.com/a" });
    const LINKS = new Proxy(env.LINKS, {
      get(target, prop) {
        if (prop === "put") {
          return async (...args: Parameters<KVNamespace["put"]>) => {
            await target.put(...args);
            // A DELETE's D1 step lands between the publish and the edit's own check.
            await env.DB.prepare("DELETE FROM links WHERE domain = 'sh.example' AND slug = 'late'").run();
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await call(`${API}/links/sh.example/late`, { ...json({ target: "https://example.com/b" }), method: "PATCH" }, { LINKS });
    expect(res.status).toBe(404);
    expect(await kv("late")).toBeNull();
  });

  it("retries a failed KV write once after saving an edit", async () => {
    await create({ slug: "flaky", target: "https://example.com/a" });
    let puts = 0;
    const LINKS = new Proxy(env.LINKS, {
      get(target, prop) {
        if (prop === "put") {
          return (...args: Parameters<KVNamespace["put"]>) => {
            if (++puts === 1) return Promise.reject(new Error("KV is having a moment"));
            return target.put(...args);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await call(`${API}/links/sh.example/flaky`, { ...json({ target: "https://example.com/b" }), method: "PATCH" }, { LINKS });
    expect(res.status).toBe(200);
    expect(puts).toBe(2);
    expect(await kv("flaky")).toMatchObject({ u: "https://example.com/b" });
  });

  it("marks a link as no longer working, with a replacement that must exist and isn't itself", async () => {
    await create({ slug: "old", target: "https://dead.example/" });
    await create({ slug: "new", target: "https://example.com/new" });
    const patch = (body: unknown) => call(`${API}/links/sh.example/old`, { ...json(body), method: "PATCH" });

    expect((await patch({ broken: true, replacement: { domain: "sh.example", slug: "old" } })).status).toBe(400);
    expect((await patch({ broken: true, replacement: { domain: "sh.example", slug: "nope" } })).status).toBe(400);

    const res = await patch({ broken: true, replacement: { domain: "sh.example", slug: "new" } });
    expect(res.status).toBe(200);
    const { link } = (await res.json()) as { link: LinkDTO };
    expect(link.broken).toBe(true);
    expect(link.replacement).toEqual({ domain: "sh.example", slug: "new" });
    expect(await kv("old")).toMatchObject({ b: 1, r: "sh.example/new" });
    expect((await call(`${ORIGIN}/old`)).status).toBe(410);

    const list = async (q: string) => ((await (await call(`${API}/links${q}`, { headers: bearer })).json()) as { links: LinkListItem[] }).links.map((l) => l.slug);
    expect(await list("?status=broken")).toEqual(["old"]);
    expect(await list("?status=active")).toEqual(["new"]);

    const deps = (await (await call(`${API}/links/sh.example/new/dependents`, { headers: bearer })).json()) as { links: LinkDTO[] };
    expect(deps.links.map((l) => l.slug)).toEqual(["old"]);

    // Deleting the replacement needs no cleanup: visitors are sent on instead.
    await call(`${API}/links/sh.example/new`, { method: "DELETE", headers: bearer });
    expect(await (await call(`${ORIGIN}/old`)).text()).toContain('http-equiv="refresh"');

    // Turning it off again restores the redirect; the KV record drops the marks.
    await patch({ broken: false });
    expect(await kv("old")).toEqual({ u: "https://dead.example/", a: 1, e: null, utm: 0, qp: 0 });
    expect((await call(`${ORIGIN}/old`)).headers.get("Location")).toBe("https://dead.example/");
  });

  it("deletes from D1 and KV", async () => {
    await create({ slug: "gone", target: "https://example.com/" });
    const res = await call(`${API}/links/sh.example/gone`, { method: "DELETE", headers: bearer });
    expect(res.status).toBe(200);
    expect(await kv("gone")).toBeNull();
    expect((await call(`${API}/links/sh.example/gone`, { headers: bearer })).status).toBe(404);
  });
});

describe("list and search", () => {
  it("filters by text, tag and status", async () => {
    await create({ slug: "resume", target: "https://example.com/resume", tags: ["career"] });
    await create({ slug: "ebook", target: "https://example.com/ebook", tags: ["books"], active: false });
    const list = async (q: string) =>
      ((await (await call(`${API}/links${q}`, { headers: bearer })).json()) as { links: LinkListItem[] }).links.map((l) => l.slug);
    expect(await list("?q=resume")).toEqual(["resume"]);
    expect(await list("?tag=books")).toEqual(["ebook"]);
    expect(await list("?status=disabled")).toEqual(["ebook"]);
    expect(await list("?q=100%25")).toEqual([]);
    // "_" and "%" in a tag are literal, not LIKE wildcards.
    await create({ slug: "under", target: "https://example.com/u", tags: ["a_b"] });
    await create({ slug: "plain", target: "https://example.com/p", tags: ["axb"] });
    expect(await list("?tag=a_b")).toEqual(["under"]);
    expect(await list("?tag=a%25")).toEqual([]);
  });
});

describe("import", () => {
  const rows = [
    { slug: "Guide", target: "https://example.com/guide", clicks: 120 },
    { slug: "old-http", target: "http://example.com/x" },
    { slug: "api", target: "https://example.com/" },
    { slug: "bad target", target: "https://example.com/" },
    { slug: "Guide", target: "https://example.com/dupe" },
  ];

  it("validates on dry run without writing", async () => {
    const res = await call(`${API}/import`, json({ rows, dryRun: true }));
    const result = (await res.json()) as ImportResult;
    expect(result).toMatchObject({ dryRun: true, created: 2, errors: 3 });
    expect(await kv("Guide")).toBeNull();
  });

  it("imports links with destination checks off, like new links", async () => {
    await call(`${API}/import`, json({ rows: [{ slug: "chk", target: "https://example.com/chk" }] }));
    expect((await env.DB.prepare("SELECT monitor FROM links WHERE slug = 'chk'").first<{ monitor: number }>())?.monitor).toBe(0);
  });

  it("imports links verbatim (http allowed, no UTM) and skips existing ones", async () => {
    let result = (await (await call(`${API}/import`, json({ rows }))).json()) as ImportResult;
    expect(result.created).toBe(2);
    expect(await kv("Guide")).toEqual({ u: "https://example.com/guide", a: 1, e: null, utm: 0, qp: 0 });
    expect((await call(`${ORIGIN}/old-http`)).headers.get("Location")).toBe("http://example.com/x");
    const link = ((await (await call(`${API}/links/sh.example/Guide`, { headers: bearer })).json()) as { link: LinkDTO }).link;
    expect(link).toMatchObject({ source: "import", importedClicks: 120, utm: false });

    result = (await (await call(`${API}/import`, json({ rows: [{ slug: "Guide", target: "https://example.com/new" }] }))).json()) as ImportResult;
    expect(result.skipped).toBe(1);
    result = (await (await call(`${API}/import`, json({ rows: [{ slug: "Guide", target: "https://example.com/new" }], mode: "overwrite" }))).json()) as ImportResult;
    expect(result.updated).toBe(1);
    expect(await kv("Guide")).toMatchObject({ u: "https://example.com/new" });
  });

  it("warns about slugs that differ only in case", async () => {
    await create({ slug: "casey", target: "https://example.com/" });
    const result = (await (await call(`${API}/import`, json({ rows: [{ slug: "Casey", target: "https://example.com/" }] }))).json()) as ImportResult;
    expect(result.rows[0]?.message).toMatch(/case/);
  });

  it("warns about case-only duplicates within one import", async () => {
    const rows = [
      { slug: "Webinar", target: "https://example.com/a" },
      { slug: "webinar", target: "https://example.com/b" },
    ];
    const result = (await (await call(`${API}/import`, json({ rows, dryRun: true }))).json()) as ImportResult;
    expect(result.created).toBe(2);
    expect(result.rows[1]?.message).toMatch(/in this import/);
  });
});

describe("resync, export and settings", () => {
  it("republishes every link to KV in pages", async () => {
    await create({ slug: "r1", target: "https://example.com/1" });
    await env.LINKS.delete("sh.example/r1");
    const res = await call(`${API}/resync`, { method: "POST", headers: bearer });
    expect(((await res.json()) as { published: number }).published).toBeGreaterThan(0);
    expect(await kv("r1")).not.toBeNull();
  });

  it("sizes republish pages and import batches to the Workers plan", async () => {
    const FREE = { WORKERS_PLAN: "free" };
    const insert = env.DB.prepare("INSERT INTO links (domain, slug, target, created_at, updated_at) VALUES ('sh.example', ?, 'https://example.com/', 1, 1)");
    await env.DB.batch(Array.from({ length: 45 }, (_, i) => insert.bind(`f${i}`)));
    // Free: 40 KV writes a page, well inside the 50 subrequests an invocation gets.
    const first = (await (await call(`${API}/resync`, { method: "POST", headers: bearer }, FREE)).json()) as { published: number; next: string | null };
    expect(first.published).toBe(40);
    expect(first.next).not.toBeNull();
    const second = (await (await call(`${API}/resync?after=${encodeURIComponent(first.next!)}`, { method: "POST", headers: bearer }, FREE)).json()) as { published: number; next: string | null };
    expect(second).toEqual({ published: 5, next: null });
    // Paid takes the whole lot in one page.
    const paid = (await (await call(`${API}/resync`, { method: "POST", headers: bearer })).json()) as { published: number; next: string | null };
    expect(paid).toEqual({ published: 45, next: null });

    const rows = Array.from({ length: 21 }, (_, i) => ({ slug: `imp${i}`, target: "https://example.com/" }));
    const tooMany = await call(`${API}/import`, json({ rows }), FREE);
    expect(tooMany.status).toBe(413);
    expect(((await tooMany.json()) as { error: string }).error).toMatch(/20 rows/);
    expect((await call(`${API}/import`, json({ rows: rows.slice(0, 20) }), FREE)).status).toBe(200);
    expect((await call(`${API}/import`, json({ rows: rows.slice(20) }))).status).toBe(200);
    const me = (await (await call(`${API}/me`, { headers: bearer }, FREE)).json()) as { workspace: { importRows: number } };
    expect(me.workspace.importRows).toBe(20);
  });

  it("exports links as CSV", async () => {
    await create({ slug: "csv1", target: "https://example.com/1", notes: "=cmd" });
    const res = await call(`${API}/export/links.csv`, { headers: bearer });
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\r\n")[0]).toContain("domain,slug,short_url,target");
    expect(text).toContain("'=cmd");
  });

  it("exports a link whose dates are out of range, leaving them blank", async () => {
    await env.DB.prepare("INSERT INTO links (domain, slug, target, expires_at, created_at, updated_at) VALUES ('sh.example', 'far', 'https://example.com/', ?, 1, 1)")
      .bind(1e15)
      .run();
    const res = await call(`${API}/export/links.csv`, { headers: bearer });
    expect(res.status).toBe(200);
    const row = (await res.text()).split("\r\n").find((l) => l.startsWith("sh.example,far,"));
    expect(row?.split(",")[5]).toBe("");
    expect(row).toContain("1970-01-01T00:00:01.000Z");
  });

  it("changes the default UTM template, applied after resync", async () => {
    await create({ slug: "u1", target: "https://example.com/", utm: true });
    const put = await call(`${API}/settings`, { ...json({ defaultUtm: "utm_source=tl&utm_campaign={slug}" }), method: "PUT" });
    expect(put.status).toBe(200);
    await call(`${API}/resync`, { method: "POST", headers: bearer });
    expect((await call(`${ORIGIN}/u1`)).headers.get("Location")).toBe("https://example.com/?utm_source=tl&utm_campaign=u1");
    const bad = await call(`${API}/settings`, { ...json({ defaultUtm: "nope" }), method: "PUT" });
    expect(bad.status).toBe(400);
  });
});

describe("short domains", () => {
  const TWO = { SHORT_DOMAINS: "sh.example,alt.example" };
  const post = (body: Record<string, unknown>) => call(`${API}/links`, json(body), TWO);
  const list = async (q = "") =>
    ((await (await call(`${API}/links${q}`, { headers: bearer }, TWO)).json()) as { links: LinkListItem[] }).links.map((l) => `${l.domain}/${l.slug}`);

  it("keeps slugs separate per domain", async () => {
    expect((await post({ slug: "same", target: "https://example.com/a" })).status).toBe(201);
    const res = await post({ domain: "Alt.example", slug: "same", target: "https://example.com/b" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { link: LinkDTO }).link).toMatchObject({ domain: "alt.example", slug: "same", shortUrl: "https://alt.example/same" });
    expect(await kv("same")).toMatchObject({ u: "https://example.com/a" });
    expect(await kv("same", "alt.example")).toMatchObject({ u: "https://example.com/b" });

    expect((await post({ domain: "alt.example", slug: "same", target: "https://example.com/c" })).status).toBe(409);
    expect((await post({ domain: "other.link", target: "https://example.com/" })).status).toBe(400);
    expect((await post({ target: "https://alt.example/loop" })).status).toBe(400);
  });

  it("lists, edits and deletes one domain's link without touching the other", async () => {
    await post({ slug: "same", target: "https://example.com/a" });
    await post({ domain: "alt.example", slug: "same", target: "https://example.com/b" });
    expect((await list()).sort()).toEqual(["alt.example/same", "sh.example/same"]);
    expect(await list("?domain=alt.example")).toEqual(["alt.example/same"]);

    const patch = await call(`${API}/links/alt.example/same`, { ...json({ target: "https://example.com/b2" }), method: "PATCH" }, TWO);
    expect(patch.status).toBe(200);
    expect(await kv("same", "alt.example")).toMatchObject({ u: "https://example.com/b2" });
    expect(await kv("same")).toMatchObject({ u: "https://example.com/a" });

    expect((await call(`${API}/links/alt.example/same`, { method: "DELETE", headers: bearer }, TWO)).status).toBe(200);
    expect(await kv("same", "alt.example")).toBeNull();
    expect(await list()).toEqual(["sh.example/same"]);
    expect((await call(`${API}/links/not_a_domain/same`, { headers: bearer }, TWO)).status).toBe(400);
  });

  it("imports rows onto their own domains", async () => {
    const rows = [
      { domain: "alt.example", slug: "p", target: "https://example.com/alt" },
      { slug: "p", target: "https://example.com/default" },
      { domain: "nope.link", slug: "q", target: "https://example.com/" },
      { domain: "alt.example", slug: "P", target: "https://example.com/case" },
    ];
    const res = await call(`${API}/import`, json({ rows, defaultDomain: "sh.example" }), TWO);
    const result = (await res.json()) as ImportResult;
    expect(result).toMatchObject({ created: 3, errors: 1 });
    expect(result.rows.find((r) => r.domain === "nope.link")?.status).toBe("error");
    expect(result.rows.find((r) => r.slug === "P")?.message).toMatch(/in this import/);
    expect(await kv("p", "alt.example")).toMatchObject({ u: "https://example.com/alt" });
    expect(await kv("p")).toMatchObject({ u: "https://example.com/default" });

    // Rows without a domain follow defaultDomain.
    await call(`${API}/import`, json({ rows: [{ slug: "d", target: "https://example.com/d" }], defaultDomain: "alt.example" }), TWO);
    expect(await kv("d", "alt.example")).not.toBeNull();
    expect(await kv("d")).toBeNull();
  });

  it("republishes across domains page by page, or only links on the default template", async () => {
    const insert = env.DB.prepare(
      "INSERT INTO links (domain, slug, target, utm, utm_template, created_at, updated_at) VALUES (?, ?, 'https://example.com/', ?, ?, 1, 1)",
    );
    await env.DB.batch(
      Array.from({ length: 205 }, (_, i) => insert.bind(i % 2 ? "alt.example" : "sh.example", `s${i}`, i % 3 ? 1 : 0, i % 5 ? null : "utm_source=x")),
    );
    const first = (await (await call(`${API}/resync`, { method: "POST", headers: bearer }, TWO)).json()) as { published: number; next: string | null };
    expect(first.published).toBe(200);
    expect(first.next).toMatch(/^sh\.example\//);
    const second = (await (await call(`${API}/resync?after=${encodeURIComponent(first.next!)}`, { method: "POST", headers: bearer }, TWO)).json()) as {
      published: number;
      next: string | null;
    };
    expect(second).toEqual({ published: 5, next: null });
    expect(await kv("s1", "alt.example")).not.toBeNull();

    const scoped = (await (await call(`${API}/resync?scope=default-utm`, { method: "POST", headers: bearer }, TWO)).json()) as { published: number };
    const expected = Array.from({ length: 205 }, (_, i) => i).filter((i) => i % 3 && i % 5).length;
    expect(scoped.published).toBe(expected);
  });

  it("reports the configured domains and their link counts in settings", async () => {
    await post({ slug: "a", target: "https://example.com/a" });
    await post({ slug: "b", target: "https://example.com/b" });
    await post({ domain: "alt.example", slug: "a", target: "https://example.com/c" });
    const s = (await (await call(`${API}/settings`, { headers: bearer }, TWO)).json()) as {
      domains: string[];
      primaryDomain: string;
      linksPerDomain: Record<string, number>;
    };
    expect(s).toMatchObject({ domains: ["sh.example", "alt.example"], primaryDomain: "sh.example", linksPerDomain: { "sh.example": 2, "alt.example": 1 } });
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { API, bearer, call, captureClicks, json, ORIGIN, putLink, resetData } from "./helpers";

beforeEach(resetData);

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const get = (path: string, headers: Record<string, string> = { "User-Agent": CHROME }) => new Request(`${ORIGIN}${path}`, { headers });

describe("redirects", () => {
  beforeEach(async () => {
    await putLink("guide", { u: "https://example.com/guide" });
  });

  it("302s to the stored target byte-for-byte, uncached", async () => {
    await putLink("bare", { u: "https://example.com" });
    const res = await call(get("/bare"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("strips the source tag and QR flag, drops other params unless pass-through is on", async () => {
    expect((await call(get("/guide?s=li&q=1&x=1"))).headers.get("Location")).toBe("https://example.com/guide");
    await putLink("pass", { u: "https://example.com/p?a=1", qp: 1 });
    expect((await call(get("/pass?s=li&x=1&q=2"))).headers.get("Location")).toBe("https://example.com/p?a=1&x=1&q=2");
  });

  it("appends the UTM template without overriding existing UTM params", async () => {
    await putLink("utm", { u: "https://example.com/a?utm_source=nl#top", utm: 1, t: "utm_source=sh.example&utm_campaign={slug}&utm_content={source}" });
    const res = await call(get("/utm?s=li"));
    expect(res.headers.get("Location")).toBe("https://example.com/a?utm_source=nl&utm_campaign=utm&utm_content=li#top");
  });

  it("fills {source} from the referrer and {domain} from the link's domain", async () => {
    await putLink("ref", { u: "https://example.com/r", utm: 1, t: "utm_source={domain}&utm_content={source}" });
    const res = await call(get("/ref", { Referer: "https://www.google.com/search?q=x" }));
    expect(res.headers.get("Location")).toBe("https://example.com/r?utm_source=sh.example&utm_content=google");
  });

  it("accepts a trailing slash and encoded slugs", async () => {
    await putLink("v1.2~x", { u: "https://example.com/" });
    expect((await call(get("/guide/"))).status).toBe(302);
    expect((await call(get("/v1.2%7Ex"))).headers.get("Location")).toBe("https://example.com/");
  });

  it("is case-sensitive", async () => {
    expect((await call(get("/Guide"))).status).toBe(404);
  });

  it("shows the branded 404 for unknown, disabled, expired and reserved slugs", async () => {
    await putLink("off", { u: "https://example.com/", a: 0 });
    await putLink("old", { u: "https://example.com/", e: Math.floor(Date.now() / 1000) - 10 });
    for (const path of ["/missing", "/off", "/old", "/api", "/_x", "/a/b"]) {
      const res = await call(get(path));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("text/html");
      expect(await res.text()).toContain("example.com");
    }
  });

  it("shows the owner's not-found page, with the address asked for and an uploaded image", async () => {
    const page = { heading: "Nothing <here>", message: "Try again", buttonLabel: "Home", buttonUrl: "https://example.com/home", background: "#000000", card: "#111111", text: "#eeeeee", accent: "#ff6600" };
    const put = await call(`${API}/settings/not-found`, { ...json(page), method: "PUT" });
    expect(put.status).toBe(200);
    expect((await call(`${API}/settings/not-found`, { ...json({ ...page, accent: "red" }), method: "PUT" })).status).toBe(400);

    const html = await (await call(get("/gg"))).text();
    expect(html).toContain("Nothing &#60;here&#62;");
    expect(html).toContain("sh.example/gg");
    expect(html).toContain('href="https://example.com/home"');
    expect(html).toContain("--accent:#ff6600");

    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], "a.png"));
    expect((await call(`${API}/settings/not-found/image`, { method: "PUT", headers: bearer, body: form })).status).toBe(200);
    const bad = new FormData();
    bad.append("file", new File(["<svg/>"], "a.svg"));
    expect((await call(`${API}/settings/not-found/image`, { method: "PUT", headers: bearer, body: bad })).status).toBe(400);
    expect(await (await call(get("/gg"))).text()).toMatch(/<img src="\/_404\.img\?v=\d+"/);
    const img = await call(get("/_404.img"));
    expect(img.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toHaveLength(7);
    expect(img.headers.get("Cache-Control")).toBe("no-store"); // no ?v=: not cacheable
    const admin = await call(`${API}/settings/not-found/image`, { headers: bearer });
    expect(admin.status).toBe(200);
    expect(admin.headers.get("Content-Type")).toBe("image/png");
  });

  describe("links marked no longer working", () => {
    const now = () => Math.floor(Date.now() / 1000);

    it("points to a working replacement through its short link, and counts the visit", async () => {
      await putLink("old", { u: "https://dead.example/", b: 1, r: "sh.example/guide" });
      const { points, CLICKS } = captureClicks();
      const res = await call(get("/old"), undefined, { CLICKS });
      expect(res.status).toBe(410);
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain('href="https://sh.example/guide"');
      expect(html).toContain("sh.example/old");
      expect(html).toContain("next best thing");
      expect(html).not.toContain('http-equiv="refresh"');
      expect(points.map((p) => [p.indexes?.[0], p.blobs?.[0]])).toEqual([["old", "click"]]);
    });

    it("sends visitors on after the delay when the replacement is missing, disabled, expired or also not working", async () => {
      await putLink("off", { u: "https://example.com/", a: 0 });
      await putLink("expired", { u: "https://example.com/", e: now() - 10 });
      await putLink("broken", { u: "https://example.com/", b: 1 });
      for (const r of [undefined, "sh.example/missing", "sh.example/off", "sh.example/expired", "sh.example/broken"]) {
        await putLink("old", { u: "https://dead.example/", b: 1, ...(r ? { r } : {}) });
        const res = await call(get("/old"));
        expect(res.status, r).toBe(410);
        const html = await res.text();
        expect(html, r).toContain(`<meta http-equiv="refresh" content="7;url=${env.FALLBACK_URL}">`);
        expect(html, r).toContain("redirected in 7 seconds");
      }
    });

    it("uses the wording, redirect URL and delay from Settings", async () => {
      const page = {
        replacedHeading: "Moved <on>",
        replacedMessage: "Try this instead",
        replacedButton: "Open it",
        goneHeading: "Gone for good",
        goneMessage: "Off you go in {seconds}s",
        goneButton: "Leave now",
        redirectUrl: "https://example.com/home",
        delaySeconds: 12,
      };
      expect((await call(`${API}/settings/dead-link`, { ...json({ ...page, delaySeconds: 1 }), method: "PUT" })).status).toBe(400);
      expect((await call(`${API}/settings/dead-link`, { ...json({ ...page, redirectUrl: "ftp://x" }), method: "PUT" })).status).toBe(400);
      expect((await call(`${API}/settings/dead-link`, { ...json(page), method: "PUT" })).status).toBe(200);
      const got = (await (await call(`${API}/settings/dead-link`, { headers: bearer })).json()) as { page: typeof page };
      expect(got.page).toEqual(page);

      await putLink("old", { u: "https://dead.example/", b: 1, r: "sh.example/guide" });
      let html = await (await call(get("/old"))).text();
      expect(html).toContain("Moved &#60;on&#62;");
      expect(html).toContain("Open it");

      await putLink("old", { u: "https://dead.example/", b: 1 });
      html = await (await call(get("/old"))).text();
      expect(html).toContain('content="12;url=https://example.com/home"');
      expect(html).toContain("Off you go in 12s");
      expect(html).toContain('href="https://example.com/home"');
    });

    it("falls back to the not-found page's button link when no redirect URL is set", async () => {
      const nf = { heading: "x", message: "", buttonLabel: "Home", buttonUrl: "https://example.com/nf", background: "#000000", card: "#111111", text: "#eeeeee", accent: "#ff6600" };
      await call(`${API}/settings/not-found`, { ...json(nf), method: "PUT" });
      await putLink("old", { u: "https://dead.example/", b: 1 });
      const html = await (await call(get("/old"))).text();
      expect(html).toContain('content="7;url=https://example.com/nf"');
      expect(html).toContain("--accent:#ff6600");
    });

    it("still 404s when the link is also disabled", async () => {
      await putLink("old", { u: "https://dead.example/", a: 0, b: 1, r: "sh.example/guide" });
      expect((await call(get("/old"))).status).toBe(404);
    });
  });

  it("still redirects a link whose expiry is in the future", async () => {
    await putLink("soon", { u: "https://example.com/", e: Math.floor(Date.now() / 1000) + 3600 });
    expect((await call(get("/soon"))).status).toBe(302);
  });

  it("rejects other methods", async () => {
    expect((await call(new Request(`${ORIGIN}/guide`, { method: "POST" }))).status).toBe(405);
  });

  it("falls back to FALLBACK_URL when KV fails, is malformed or is slow", async () => {
    const failing = { get: async () => { throw new Error("KV down"); } } as unknown as KVNamespace;
    let res = await call(get("/guide"), undefined, { LINKS: failing });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(env.FALLBACK_URL);

    await env.LINKS.put("sh.example/broken", JSON.stringify({ nope: true }));
    res = await call(get("/broken"));
    expect(res.headers.get("Location")).toBe(env.FALLBACK_URL);

    const slow = { get: () => new Promise(() => {}) } as unknown as KVNamespace;
    res = await call(get("/guide"), undefined, { LINKS: slow });
    expect(res.headers.get("Location")).toBe(env.FALLBACK_URL);
  });

  it("redirects / to the fallback and answers /health", async () => {
    expect((await call(get("/"))).headers.get("Location")).toBe(env.FALLBACK_URL);
    expect(await (await call(get("/health"))).text()).toBe("ok");
  });
});

describe("worker module", () => {
  it("exports only the default handler (Workers reject other entry exports)", async () => {
    const mod = await import("../src/worker/index");
    expect(Object.keys(mod)).toEqual(["default"]);
  });
});

describe("click logging", () => {
  beforeEach(async () => {
    await putLink("guide", { u: "https://example.com/guide" });
  });

  it("logs clicks, bots and misses separately", async () => {
    const { points, CLICKS } = captureClicks();
    await call(get("/guide?s=nl"), undefined, { CLICKS });
    await call(get("/guide", { "User-Agent": "LinkedInBot/1.0" }), undefined, { CLICKS });
    await call(get("/nope"), undefined, { CLICKS });
    expect(points.map((p) => [p.indexes?.[0], p.blobs?.[0], p.blobs?.[11]])).toEqual([
      ["guide", "click", "nl"],
      ["guide", "bot", "direct"],
      ["nope", "miss", "direct"],
    ]);
    expect(points[1]?.blobs?.[13]).toBe("LinkedIn");
  });

  it("never lets an analytics failure break a redirect", async () => {
    const CLICKS = { writeDataPoint: () => { throw new Error("AE down"); } } as unknown as AnalyticsEngineDataset;
    const res = await call(get("/guide"), undefined, { CLICKS });
    expect(res.status).toBe(302);
  });
});

describe("short domains", () => {
  const TWO = { SHORT_DOMAINS: "sh.example,alt.example" };
  const at = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { "User-Agent": CHROME, ...headers } });

  beforeEach(async () => {
    await putLink("x", { u: "https://example.com/primary" });
    await putLink("x", { u: "https://example.com/alt" }, "alt.example");
  });

  it("serves each domain's own links for the same slug", async () => {
    expect((await call(at("https://sh.example/x"), undefined, TWO)).headers.get("Location")).toBe("https://example.com/primary");
    expect((await call(at("https://alt.example/x"), undefined, TWO)).headers.get("Location")).toBe("https://example.com/alt");
  });

  it("ignores hosts that aren't configured, without logging them", async () => {
    const { points, CLICKS } = captureClicks();
    const res = await call(at("https://alt.example/x"), undefined, { CLICKS });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    expect(points).toEqual([]);
  });

  it("keeps the admin and the API on the primary domain", async () => {
    const shell = await call(at("https://alt.example/_admin/"), undefined, TWO);
    expect(shell.status).toBe(404);
    expect(await shell.text()).toContain("alt.example");
    const api = await call(at("https://alt.example/api/links", { Authorization: "Bearer test-api-token-0123456789abcdef" }), undefined, TWO);
    expect(api.status).toBe(404);
  });

  it("moves the admin and the API to ADMIN_HOST, which serves no links", async () => {
    const env = { ...TWO, ADMIN_HOST: "admin.example" };
    const auth = { Authorization: "Bearer test-api-token-0123456789abcdef" };
    expect((await call(at("https://admin.example/api/links", auth), undefined, env)).status).toBe(200);
    expect((await call(at("https://sh.example/api/links", auth), undefined, env)).status).toBe(404);
    expect((await call(at("https://sh.example/x"), undefined, env)).headers.get("Location")).toBe("https://example.com/primary");
    expect((await call(at("https://admin.example/x"), undefined, env)).status).toBe(404);
    expect((await call(at("https://admin.example/"), undefined, env)).headers.get("Location")).toBe("/_admin/");
    // Access may only cover /_admin/*: the bare path redirects before any auth check.
    expect((await call(at("https://admin.example/_admin"), undefined, env)).headers.get("Location")).toBe("/_admin/");
    expect((await call(at("https://admin.example/health"), undefined, env)).status).toBe(200);
  });

  it("lets dev hosts pick a domain with X-Shorthop-Domain, and only dev hosts", async () => {
    const dev = "https://shorthop.someone.workers.dev/x";
    expect((await call(at(dev), undefined, TWO)).headers.get("Location")).toBe("https://example.com/primary");
    expect((await call(at(dev, { "X-Shorthop-Domain": "alt.example" }), undefined, TWO)).headers.get("Location")).toBe("https://example.com/alt");
    expect((await call(at("https://sh.example/x", { "X-Shorthop-Domain": "alt.example" }), undefined, TWO)).headers.get("Location")).toBe(
      "https://example.com/primary",
    );
  });

  it("records the domain with every hit and miss", async () => {
    const { points, CLICKS } = captureClicks();
    await call(at("https://alt.example/x"), undefined, { ...TWO, CLICKS });
    await call(at("https://alt.example/nope"), undefined, { ...TWO, CLICKS });
    expect(points.map((p) => [p.blobs?.[0], p.indexes?.[0], p.blobs?.[16]])).toEqual([
      ["click", "x", "alt.example"],
      ["miss", "nope", "alt.example"],
    ]);
  });
});

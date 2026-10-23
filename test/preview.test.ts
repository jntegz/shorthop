import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageSize, isPreviewCrawler, validatePreview } from "../src/shared/preview";
import type { LinkDTO, VersionDTO } from "../src/shared/types";
import { nowSec } from "../src/worker/db";
import { fetchDestinationPreview, prunePreviewImages } from "../src/worker/preview";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";

const LINKEDIN = "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)";
const SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const IMESSAGE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const TEAMS_APP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Teams/1.6.00.4472 Chrome/80.0 Electron/8.5.1 Safari/537.36";

/** A 1200×630 PNG header (enough for the type and size checks). */
function png(width = 1200, height = 630): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

const upload = async (bytes: Uint8Array) => call(`${API}/previews/images`, { method: "POST", headers: { ...bearer, "Content-Type": "image/png" }, body: bytes });
const visit = (ua: string, method = "GET") => call(new Request(`${ORIGIN}/guide`, { method, headers: { "User-Agent": ua } }));
const PREVIEW = { title: 'Job search guide: "the 2026 edition"', description: "Twelve chapters <and> a checklist.", image: { kind: "url", url: "https://cdn.example.com/cover.png" } };

describe("crawler detection and validation", () => {
  it("knows preview crawlers from people and in-app browsers", () => {
    for (const ua of [LINKEDIN, SLACK, IMESSAGE, "Twitterbot/1.0", "Discordbot/2.0", "TelegramBot (like TwitterBot)", "WhatsApp/2.23.20"]) expect(isPreviewCrawler(ua), ua).toBe(true);
    for (const ua of [PERSON, TEAMS_APP, "Googlebot/2.1", ""]) expect(isPreviewCrawler(ua), ua).toBe(false);
  });

  it("requires a title and an https image, and trims", () => {
    expect(validatePreview({ title: "  A   title ", description: "", image: null })).toEqual({ ok: true, preview: { title: "A title", description: "", image: null } });
    expect(validatePreview({ title: "", description: "", image: null }).ok).toBe(false);
    expect(validatePreview({ title: "x", description: "", image: { kind: "url", url: "http://e.com/a.png" } }).ok).toBe(false);
    expect(validatePreview({ title: "x", description: "", image: { kind: "upload", key: "../etc", width: 1, height: 1 } }).ok).toBe(false);
  });

  it("reads image sizes from headers", () => {
    expect(imageSize(png(1200, 627))).toEqual({ width: 1200, height: 627 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
    expect(imageSize(gif)).toEqual({ width: 320, height: 240 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x73, 0x04, 0xb0, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 1200, height: 627 });
  });
});

describe("serving previews", () => {
  beforeEach(async () => {
    const res = await call(`${API}/links`, json({ slug: "guide", target: "https://example.com/guide", preview: PREVIEW, utm: true, utmTemplate: "utm_source=x" }));
    expect(res.status).toBe(201);
  });

  it("gives crawlers the owner's preview and people the redirect", async () => {
    const res = await visit(LINKEDIN);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Job search guide: &#34;the 2026 edition&#34;">');
    expect(html).toContain('<meta property="og:description" content="Twelve chapters &#60;and&#62; a checklist.">');
    expect(html).toContain('<meta property="og:image" content="https://cdn.example.com/cover.png">');
    expect(html).toContain('<meta property="og:url" content="https://sh.example/guide">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('content="0;url=https://example.com/guide?utm_source=x"');
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");

    const person = await visit(PERSON);
    expect(person.status).toBe(302);
    expect(person.headers.get("Location")).toBe("https://example.com/guide?utm_source=x");
    expect((await visit(TEAMS_APP)).status).toBe(302);
  });

  it("answers HEAD without a body, and lets crawlers follow the redirect when there's no preview", async () => {
    const head = await visit(SLACK, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    await call(`${API}/links/sh.example/guide`, { ...json({ preview: null }), method: "PATCH" });
    expect((await visit(LINKEDIN)).status).toBe(302);
  });

  it("serves uploaded images from every short domain with their size", async () => {
    const up = await upload(png());
    expect(up.status).toBe(201);
    const { image } = (await up.json()) as { image: { kind: "upload"; key: string; width: number; height: number } };
    expect(image).toMatchObject({ kind: "upload", width: 1200, height: 630 });
    await call(`${API}/links/sh.example/guide`, { ...json({ preview: { ...PREVIEW, image } }), method: "PATCH" });

    const html = await (await visit(LINKEDIN)).text();
    expect(html).toContain(`<meta property="og:image" content="https://sh.example/_og/${image.key}">`);
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    const img = await call(`${ORIGIN}/_og/${image.key}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
    expect(img.headers.get("Cache-Control")).toContain("immutable");
    expect((await call(`${ORIGIN}/_og/aaaaaaaaaaaaaaaaaaaa.png`)).status).toBe(404);
    expect((await call(`${ORIGIN}/_og/..%2Fsecret`)).status).toBe(404);
  });

  it("refuses files that aren't images", async () => {
    const res = await upload(new TextEncoder().encode("<svg onload=alert(1)>"));
    expect(res.status).toBe(400);
  });

  it("keeps the preview in the history", async () => {
    await call(`${API}/links/sh.example/guide`, { ...json({ preview: { ...PREVIEW, title: "New title" } }), method: "PATCH" });
    const { versions } = (await (await call(`${API}/links/sh.example/guide/history`, { headers: bearer })).json()) as { versions: VersionDTO[] };
    expect(JSON.parse(versions[0]!.snapshot.preview!)).toMatchObject({ title: "New title" });
    const { link } = (await (await call(`${API}/links/sh.example/guide`, { headers: bearer })).json()) as { link: LinkDTO };
    expect(link.preview).toMatchObject({ title: "New title", image: { kind: "url" } });
  });

  it("deletes uploads nothing uses once they're a day old", async () => {
    const used = ((await (await upload(png())).json()) as { image: { kind: "upload"; key: string } }).image;
    const unused = ((await (await upload(png())).json()) as { image: { key: string } }).image;
    await call(`${API}/links/sh.example/guide`, { ...json({ preview: { ...PREVIEW, image: used } }), method: "PATCH" });
    expect(await prunePreviewImages(env)).toBe(0); // too new
    expect(await prunePreviewImages(env, nowSec() + 2 * 86400)).toBe(1);
    expect(await env.LINKS.get(`og:${unused.key}`)).toBeNull();
    expect(await env.LINKS.get(`og:${used.key}`)).not.toBeNull();
  });
});

describe("reading a destination's own preview", () => {
  const page = (html: string, headers: Record<string, string> = {}) => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });

  it("takes Open Graph tags, resolving a relative image against the final URL", async () => {
    const fetcher = vi.fn(async (u: RequestInfo | URL) =>
      String(u) === "https://example.com/old"
        ? new Response(null, { status: 301, headers: { Location: "/new" } })
        : page(`<html><head><title>Plain</title><meta property="og:title" content="Guide &amp; checklist"><meta name="description" content="Short."><meta property="og:image" content="/img/cover.png"></head></html>`),
    );
    expect(await fetchDestinationPreview("https://example.com/old", fetcher as unknown as typeof fetch)).toEqual({
      title: "Guide & checklist",
      description: "Short.",
      image: "https://example.com/img/cover.png",
      url: "https://example.com/new",
    });
  });

  it("falls back to <title>, and refuses private addresses and non-pages", async () => {
    const fetcher = vi.fn(async () => page("<title> Just a title </title>"));
    expect(await fetchDestinationPreview("https://example.com/", fetcher as unknown as typeof fetch)).toMatchObject({ title: "Just a title", description: "", image: null });
    expect(await fetchDestinationPreview("http://127.0.0.1/", fetcher as unknown as typeof fetch)).toEqual({ error: expect.any(String) });
    const pdf = vi.fn(async () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }));
    expect(await fetchDestinationPreview("https://example.com/x.pdf", pdf as unknown as typeof fetch)).toEqual({ error: "That address isn't a web page." });
  });
});

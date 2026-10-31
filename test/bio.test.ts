import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";

beforeEach(resetData);

const bio = (blocks: unknown[]) => ({ name: "Alex Rivera", text: "Writer and speaker", theme: "auto", accent: "#6554c0", avatarKey: null, blocks });

describe("link-in-bio pages", () => {
  it("shows a page of buttons, each going through its own short link", async () => {
    await call(`${API}/links`, json({ slug: "book", target: "https://example.com/book" }));
    const res = await call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: bio([{ label: "My book", link: { domain: "sh.example", slug: "book" } }, { label: "Website", url: "https://example.com/" }]) }));
    expect(res.status).toBe(201);
    expect(await env.LINKS.get("sh.example/me", "json")).toMatchObject({ u: "https://example.com/", bio: { name: "Alex Rivera" } });

    const page = await call(`${ORIGIN}/me`, { redirect: "manual" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Alex Rivera");
    expect(html).toContain(`href="${ORIGIN}/book?s=bio"`);
    expect(html).toContain('href="https://example.com/"');
    expect(html).not.toContain("<script");
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    // A button's click goes through that link, tagged as coming from the bio page.
    const through = await call(`${ORIGIN}/book?s=bio`, { redirect: "manual" });
    expect(through.headers.get("Location")).toBe("https://example.com/book");
  });

  it("lists only bio pages with the Bio pages filter", async () => {
    await call(`${API}/links`, json({ slug: "book", target: "https://example.com/book" }));
    await call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: bio([{ label: "Site", url: "https://example.com/" }]) }));
    const { links } = (await (await call(`${API}/links?status=bio`, { headers: bearer })).json()) as { links: { slug: string }[] };
    expect(links.map((l) => l.slug)).toEqual(["me"]);
  });

  it("refuses buttons to links that don't exist, or without a name", async () => {
    expect((await call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: bio([{ label: "Gone", link: { domain: "sh.example", slug: "nope" } }]) }))).status).toBe(400);
    expect((await call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: { ...bio([{ label: "x", url: "https://example.com/" }]), name: "" } }))).status).toBe(400);
  });

  it("turns back into a redirect when the page is removed, and keeps it in history", async () => {
    await call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: bio([{ label: "Site", url: "https://example.com/" }]) }));
    await call(`${API}/links/sh.example/me`, { ...json({ bio: null }), method: "PATCH" });
    expect((await call(`${ORIGIN}/me`, { redirect: "manual" })).headers.get("Location")).toBe("https://example.com/");
    const snapshots = await env.DB.prepare("SELECT snapshot FROM link_versions WHERE slug = 'me' ORDER BY id").all<{ snapshot: string }>();
    expect(snapshots.results[0]!.snapshot).toContain("Alex Rivera");
  });

  it("shows texts, section titles, social links in a new tab, a share panel and own colours", async () => {
    await call(`${API}/links`, json({ slug: "book", target: "https://example.com/book" }));
    const page = {
      ...bio([
        { type: "heading", label: "Books" },
        { label: "My book", link: { domain: "sh.example", slug: "book" } },
        { type: "text", text: "Out now in paperback & ebook." },
      ]),
      socials: [
        { network: "linkedin", url: "https://www.linkedin.com/in/example/" },
        { network: "email", url: "owner@example.com" },
      ],
      socialsAt: "bottom",
      share: true,
      background: "#102030",
      buttonColor: "#FFFFFF",
      iconColor: "#ffcc00",
    };
    const res = await call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: page }));
    expect(res.status).toBe(201);
    // Stored tidied: email gets mailto:, colours lower case.
    expect(await env.LINKS.get("sh.example/me", "json")).toMatchObject({
      bio: { socials: [{ network: "linkedin" }, { network: "email", url: "mailto:owner@example.com" }], socialsAt: "bottom", share: true, buttonColor: "#ffffff" },
    });

    const html = await (await call(`${ORIGIN}/me`)).text();
    expect(html).toContain("<h2>Books</h2>");
    expect(html).toContain('<p class="note">Out now in paperback &#38; ebook.</p>');
    expect(html).toContain(`<a class="btn first" href="${ORIGIN}/book?s=bio"`);
    // Social links open in a new tab; email doesn't. Icons come after the buttons when asked.
    expect(html).toContain('href="https://www.linkedin.com/in/example/" target="_blank" rel="me noopener noreferrer" aria-label="LinkedIn"');
    expect(html).toContain('href="mailto:owner@example.com" aria-label="Email"');
    expect(html.indexOf('class="socials at-end"')).toBeGreaterThan(html.indexOf("My book"));
    // Share: the page's own address, plain share links, still no script.
    expect(html).toContain("Share this page");
    expect(html).toContain(`<p class="share-url" title="Tap to select, then copy">${ORIGIN}/me</p>`);
    expect(html).toContain(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(`${ORIGIN}/me`)}`);
    expect(html).not.toContain("<script");
    // Own background replaces the theme; text, buttons and icons follow the colours.
    expect(html).toContain("--bg:#102030; --fg:#ffffff;");
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).toContain("--btn:#ffffff; --on-btn:#111111;");
    expect(html).toContain("--icon:#ffcc00;");
  });

  it("still shows pages saved before texts, socials and colours existed", async () => {
    await call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: bio([{ label: "Site", url: "https://example.com/" }]) }));
    // An older Worker stored only the first six bio fields.
    const stored = (await env.LINKS.get("sh.example/me", "json")) as { bio: Record<string, unknown> };
    const { socials: _s, socialsAt: _a, share: _sh, background: _b, buttonColor: _bc, iconColor: _ic, ...old } = stored.bio;
    await env.LINKS.put("sh.example/me", JSON.stringify({ ...stored, bio: old }));
    const html = await (await call(`${ORIGIN}/me`)).text();
    expect(html).toContain('<a class="btn first" href="https://example.com/"');
    expect(html).toContain("prefers-color-scheme");
    expect(html).not.toContain('class="socials');
    expect(html).not.toContain("Share this page");
  });

  it("refuses long texts, bad social links and bad colours, and allows a page of social links only", async () => {
    const make = (b: unknown) => call(`${API}/links`, json({ slug: "me", target: "https://example.com/", bio: b }));
    expect((await make(bio([{ type: "text", text: "x".repeat(281) }]))).status).toBe(400);
    expect((await make({ ...bio([]), socials: [{ network: "linkedin", url: "http://insecure.example/" }] })).status).toBe(400);
    expect((await make({ ...bio([]), socials: [{ network: "email", url: "not-an-email" }] })).status).toBe(400);
    expect((await make({ ...bio([{ label: "Site", url: "https://example.com/" }]), background: "red" })).status).toBe(400);
    expect((await make(bio([]))).status).toBe(400);
    expect((await make({ ...bio([]), socials: [{ network: "github", url: "https://github.com/example" }] })).status).toBe(201);
  });
});

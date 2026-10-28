import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { LinkDTO, ShareDTO } from "../src/shared/types";
import { allowedRanges, parseSharePath } from "../src/worker/share";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";

const PERSON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

beforeEach(resetData);

const createLink = (slug: string, body: Record<string, unknown> = {}) => call(`${API}/links`, json({ slug, target: `https://example.com/${slug}-private`, ...body }));
const patchLink = (slug: string, body: unknown) => call(`${API}/links/sh.example/${slug}`, { ...json(body), method: "PATCH" });
const share = async (body: Record<string, unknown> = {}, slug = "report") => {
  const res = await call(`${API}/links/sh.example/${slug}/shares`, json(body));
  return { res, share: res.ok ? ((await res.json()) as { share: ShareDTO }).share : null };
};
const open = (url: string, init: RequestInit = {}, ip = "198.51.100.7") =>
  call(new Request(url, { ...init, headers: { "User-Agent": PERSON, "CF-Connecting-IP": ip, ...(init.headers as Record<string, string>) } }));
const submit = (url: string, password: string) =>
  open(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });

describe("shared statistics", () => {
  it("creates an unguessable read-only page that never shows the destination", async () => {
    await createLink("report", { title: "Quarterly report" });
    const { res, share: s } = await share();
    expect(res.status).toBe(201);
    expect(s!.status).toBe("active");
    expect(s!.url).toMatch(new RegExp(`^${ORIGIN}/_share/[a-z0-9]{8}\\.[A-Za-z0-9_-]{32}$`));

    const page = await open(s!.url!);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("sh.example/report");
    expect(html).toContain("Quarterly report");
    expect(html).not.toContain("example.com");
    expect(html).not.toContain("<script");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    // The secret is only stored hashed (and encrypted for "Copy link").
    const row = await env.DB.prepare("SELECT * FROM stat_shares WHERE id = ?").bind(s!.id).first<{ secret_hash: string; secret_enc: string; views: number }>();
    const secret = s!.url!.split(".").pop()!;
    expect(row!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.secret_enc).not.toContain(secret);
    expect(row!.views).toBe(1);
  });

  it("answers 404 for a wrong secret or id, the same way", async () => {
    await createLink("report");
    const { share: s } = await share();
    const id = s!.url!.split("/_share/")[1]!.split(".")[0]!;
    expect((await open(`${ORIGIN}/_share/${id}.${"x".repeat(32)}`)).status).toBe(404);
    expect((await open(`${ORIGIN}/_share/zzzzzzzz.${"x".repeat(32)}`)).status).toBe(404);
    expect((await open(`${ORIGIN}/_share/nope`)).status).toBe(404);
  });

  it("ends when it expires, is revoked, or the link is deleted", async () => {
    await createLink("report");
    const { share: s } = await share({ expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    expect((await open(s!.url!)).status).toBe(200);

    await env.DB.prepare("UPDATE stat_shares SET expires_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 1, s!.id).run();
    const expired = await open(s!.url!);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("no longer shared");

    const { share: s2 } = await share();
    const revoked = await call(`${API}/shares/${s2!.id}`, { ...json({ revoke: true }), method: "PATCH" });
    expect(((await revoked.json()) as { share: ShareDTO }).share.status).toBe("revoked");
    expect((await open(s2!.url!)).status).toBe(410);

    const { share: s3 } = await share();
    await call(`${API}/links/sh.example/report`, { method: "DELETE", headers: bearer });
    expect((await open(s3!.url!)).status).toBe(410);
    // Restoring the link doesn't bring the share back.
    await call(`${API}/deleted/sh.example/report/restore`, { method: "POST", headers: bearer });
    expect((await open(s3!.url!)).status).toBe(410);
  });

  it("rejects an end date in the past", async () => {
    await createLink("report");
    expect((await share({ expiresAt: Math.floor(Date.now() / 1000) - 60 })).res.status).toBe(400);
  });

  it("asks for a password, remembers it, and forgets it when the password changes", async () => {
    await createLink("report");
    const { share: s } = await share({ password: "hiring manager" });
    expect(s!.protected).toBe(true);

    const locked = await open(s!.url!);
    expect(locked.status).toBe(200);
    const lockedHtml = await locked.text();
    expect(lockedHtml).toContain("Password required");
    expect(lockedHtml).not.toContain("sh.example/report");

    expect((await submit(s!.url!, "wrong password")).status).toBe(401);
    const ok = await submit(s!.url!, "hiring manager");
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(setCookie).toContain(`Path=/_share/${s!.id}.`);
    const cookie = setCookie.split(";")[0]!;

    const seen = await open(s!.url!, { headers: { Cookie: cookie } });
    expect(await seen.text()).toContain("sh.example/report");

    await call(`${API}/shares/${s!.id}`, { ...json({ password: "a new password" }), method: "PATCH" });
    expect(await (await open(s!.url!, { headers: { Cookie: cookie } })).text()).toContain("Password required");
  });

  it("locks the password after too many wrong tries from many networks", async () => {
    await createLink("report");
    const { share: s } = await share({ password: "hiring manager" });
    let last = 0;
    for (let i = 0; i < 22; i++) {
      const res = await open(s!.url!, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password: `guess ${i}` }) }, `203.0.113.${i + 1}`);
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("limits the periods viewers can pick", async () => {
    expect(allowedRanges("30d")).toEqual(["7d", "30d"]);
    expect(allowedRanges(null)).toContain("all");
    await createLink("report");
    const { share: s } = await share({ rangeLimit: "7d" });
    const html = await (await open(`${s!.url!}?range=all`)).text();
    expect(html).not.toContain("All time");
    expect(html).toContain('aria-current="page">7 days');
  });

  it("offers automatic, light and dark themes, kept across periods", async () => {
    await createLink("report");
    const { share: s } = await share();
    const auto = await (await open(s!.url!)).text();
    expect(auto).toContain("<html lang=\"en\">");
    expect(auto).toContain("prefers-color-scheme: dark");
    const dark = await (await open(`${s!.url!}?theme=dark`)).text();
    expect(dark).toContain('<html lang="en" data-theme="dark">');
    expect(dark).toContain('href="?range=7d&amp;theme=dark"');
    expect(await (await open(`${s!.url!}?theme=<script>`)).text()).toContain("<html lang=\"en\">");
  });

  it("marks shared links in the list and filters by them", async () => {
    await createLink("report");
    await createLink("other");
    await share();
    const all = (await (await call(`${API}/links`, { headers: bearer })).json()) as { links: { slug: string; shares: number }[] };
    expect(all.links.find((l) => l.slug === "report")?.shares).toBe(1);
    expect(all.links.find((l) => l.slug === "other")?.shares).toBe(0);
    const shared = (await (await call(`${API}/links?status=shared`, { headers: bearer })).json()) as { links: { slug: string }[] };
    expect(shared.links.map((l) => l.slug)).toEqual(["report"]);
  });

  it("caps active shares per link", async () => {
    await createLink("report");
    for (let i = 0; i < 20; i++) expect((await share()).res.status).toBe(201);
    expect((await share()).res.status).toBe(409);
    const list = (await (await call(`${API}/links/sh.example/report/shares`, { headers: bearer })).json()) as { shares: ShareDTO[] };
    expect(list.shares).toHaveLength(20);
  });

  it("parses only well-formed share paths", () => {
    expect(parseSharePath("/_share/abcd1234.abcdefghijklmnopqrstuvwxyz012345")).toEqual({ id: "abcd1234", secret: "abcdefghijklmnopqrstuvwxyz012345" });
    expect(parseSharePath("/_share/ABCD1234.abcdefghijklmnop")).toBeNull();
    expect(parseSharePath("/_share/abcd1234")).toBeNull();
  });
});

describe("turning a link off", () => {
  const visit = (slug: string) => call(new Request(`${ORIGIN}/${slug}`, { headers: { "User-Agent": PERSON, "CF-Connecting-IP": "198.51.100.7" } }));

  it("shows the not-found page by default", async () => {
    await createLink("job");
    await patchLink("job", { active: false });
    expect((await visit("job")).status).toBe(404);
  });

  it("sends visitors to the main site", async () => {
    await createLink("job");
    const res = await patchLink("job", { active: false, offRedirect: "home" });
    expect(((await res.json()) as { link: LinkDTO }).link.offRedirect).toBe("home");
    const v = await visit("job");
    expect(v.status).toBe(302);
    expect(v.headers.get("Location")).toBe(env.FALLBACK_URL);
  });

  it("sends visitors to another link while that one works", async () => {
    await createLink("job");
    await createLink("careers");
    await patchLink("job", { active: false, offRedirect: { domain: "sh.example", slug: "careers" } });
    const v = await visit("job");
    expect(v.status).toBe(302);
    expect(v.headers.get("Location")).toBe("https://sh.example/careers");

    await patchLink("careers", { active: false });
    expect((await visit("job")).status).toBe(404);
  });

  it("stops redirecting elsewhere once turned back on", async () => {
    await createLink("job");
    await patchLink("job", { active: false, offRedirect: "home" });
    await patchLink("job", { active: true });
    expect((await visit("job")).headers.get("Location")).toContain("example.com/job-private");
  });

  it("refuses itself and missing links as the target", async () => {
    await createLink("job");
    expect((await patchLink("job", { active: false, offRedirect: { domain: "sh.example", slug: "job" } })).status).toBe(400);
    expect((await patchLink("job", { active: false, offRedirect: { domain: "sh.example", slug: "missing" } })).status).toBe(400);
  });
});

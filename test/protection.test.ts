import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { linkPasswordProblem } from "../src/shared/protection";
import type { CapDTO, LinkDTO, VersionDTO } from "../src/shared/types";
import { checkLinkPassword, hashLinkPassword } from "../src/worker/link-password";
import { API, bearer, call, captureClicks, json, ORIGIN, resetData } from "./helpers";

const PERSON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const LINKEDIN = "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)";

beforeEach(resetData);

const create = (body: Record<string, unknown>) => call(`${API}/links`, json({ slug: "secret", target: "https://example.com/private-doc", ...body }));
const patch = (slug: string, body: unknown) => call(`${API}/links/sh.example/${slug}`, { ...json(body), method: "PATCH" });
const visit = (slug = "secret", headers: Record<string, string> = {}, ip = "198.51.100.7") =>
  call(new Request(`${ORIGIN}/${slug}`, { headers: { "User-Agent": PERSON, "CF-Connecting-IP": ip, ...headers } }));
const submit = (password: string, slug = "secret", ip = "198.51.100.7") =>
  call(new Request(`${ORIGIN}/${slug}`, { method: "POST", headers: { "User-Agent": PERSON, "CF-Connecting-IP": ip, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) }));
const cookieOf = (res: Response) => res.headers.get("Set-Cookie")!.split(";")[0]!;

describe("passwords", () => {
  it("hashes and checks, and rejects passwords that are too short or long", async () => {
    const h = await hashLinkPassword({ WORKERS_PLAN: "free" }, "open sesame");
    expect(h).toMatch(/^pbkdf2-sha256:30000:/);
    // Paid installs use more; a hash keeps its own count, so either still checks.
    const paid = await hashLinkPassword({ WORKERS_PLAN: "paid" }, "open sesame");
    expect(paid).toMatch(/^pbkdf2-sha256:100000:/);
    expect(await checkLinkPassword("open sesame", paid)).toBe(true);
    expect(await checkLinkPassword("open sesame", h)).toBe(true);
    expect(await checkLinkPassword("Open sesame", h)).toBe(false);
    expect(linkPasswordProblem("abc")).not.toBeNull();
    expect((await create({ password: "abc" })).status).toBe(400);
  });

  it("asks for the password without revealing the destination, then redirects", async () => {
    await create({ password: "open sesame" });
    const { link } = (await (await call(`${API}/links/sh.example/secret`, { headers: bearer })).json()) as { link: LinkDTO & { password_hash?: string } };
    expect(link.protected).toBe(true);
    expect(JSON.stringify(link)).not.toContain("pbkdf2");

    const page = await visit();
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("This link is protected");
    expect(html).not.toContain("example.com");
    expect(page.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(page.headers.get("Cache-Control")).toContain("max-age=0");

    const wrong = await submit("nope");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("That password isn&#39;t right");

    const ok = await submit("open sesame");
    // A page that moves on by meta refresh: a redirect after a form post would be held to form-action.
    expect(ok.status).toBe(200);
    const unlocked = await ok.text();
    expect(unlocked).toContain('content="0;url=/secret"');
    expect(unlocked).not.toContain("example.com");
    const setCookie = ok.headers.get("Set-Cookie")!;
    expect(setCookie).toMatch(/Path=\/secret;.*HttpOnly; Secure; SameSite=Lax/);

    const after = await visit("secret", { Cookie: cookieOf(ok) });
    expect(after.status).toBe(302);
    expect(after.headers.get("Location")).toBe("https://example.com/private-doc");
  });

  it("keeps a cookie to its own link, and ends access when the password changes", async () => {
    await create({ password: "open sesame" });
    await call(`${API}/links`, json({ slug: "other", target: "https://example.com/other", password: "open sesame" }));
    const cookie = cookieOf(await submit("open sesame"));
    expect((await visit("other", { Cookie: cookie })).status).toBe(200);
    await patch("secret", { password: "new password" });
    expect((await visit("secret", { Cookie: cookie })).status).toBe(200);
    await patch("secret", { password: null });
    expect((await visit("secret")).status).toBe(302);
  });

  it("limits attempts per network", async () => {
    await create({ password: "open sesame" });
    let last: Response | null = null;
    for (let i = 0; i < 12; i++) last = await submit("wrong", "secret", "203.0.113.9");
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toBe("60");
  });

  it("locks the link after many wrong passwords, however many networks they come from", async () => {
    await create({ password: "open sesame" });
    for (let i = 0; i < 20; i++) expect((await submit("wrong guess", "secret", `192.0.2.${i + 1}`)).status).toBe(401);
    // Locked for everyone, even with the right password from a new network.
    expect((await submit("open sesame", "secret", "198.51.100.200")).status).toBe(429);
    await env.DB.prepare("UPDATE auth_failures SET locked_until = 0 WHERE key = 'link:sh.example/secret'").run();
    expect((await submit("open sesame", "secret", "198.51.100.200")).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM auth_failures WHERE key = 'link:sh.example/secret'").first()).toBeNull();
  });

  it("shows a custom preview to crawlers without the destination, and refuses POST on other links", async () => {
    await create({ password: "open sesame", preview: { title: "A private document", description: "", image: null } });
    const res = await visit("secret", { "User-Agent": LINKEDIN });
    const html = await res.text();
    expect(html).toContain("A private document");
    expect(html).not.toContain("example.com");
    await call(`${API}/links`, json({ slug: "open", target: "https://example.com" }));
    expect((await submit("x", "open")).status).toBe(405);
  });

  it("shows only a fingerprint of the password in the history", async () => {
    await create({ password: "open sesame" });
    await patch("secret", { password: "changed it" });
    const { versions } = (await (await call(`${API}/links/sh.example/secret/history`, { headers: bearer })).json()) as { versions: VersionDTO[] };
    expect(versions[0]!.snapshot.password_hash).toMatch(/^set:[0-9a-f]{8}$/);
    expect(versions[0]!.snapshot.password_hash).not.toBe(versions[1]!.snapshot.password_hash);
    expect(JSON.stringify(versions)).not.toContain("pbkdf2");
  });
});

describe("click limits", () => {
  const cap = async (slug = "secret") => (await (await call(`${API}/links/sh.example/${slug}/cap`, { headers: bearer })).json()) as CapDTO;

  it("lets exactly the limit through, even when clicks arrive at once", async () => {
    await create({ maxClicks: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => visit("secret", {}, `198.51.100.${i + 1}`)));
    expect(results.filter((r) => r.status === 302)).toHaveLength(3);
    expect(results.filter((r) => r.status === 410)).toHaveLength(7);
    expect(await cap()).toEqual({ limit: 3, count: 3 });
    expect(await (await visit()).text()).toContain("reached its limit");
  });

  it("doesn't let bots or previews use clicks up", async () => {
    await create({ maxClicks: 1 });
    const { points, CLICKS } = captureClicks();
    for (let i = 0; i < 3; i++) await call(new Request(`${ORIGIN}/secret`, { headers: { "User-Agent": LINKEDIN } }), undefined, { CLICKS });
    expect(points.every((p) => p.blobs?.[0] === "bot")).toBe(true);
    expect((await cap()).count).toBe(0);
    expect((await visit()).status).toBe(302);
    expect((await visit()).status).toBe(410);
  });

  it("never sends previews, prefetches or HEAD requests on, so they can't get past the limit", async () => {
    await create({ maxClicks: 1 });
    const lookers = [
      new Request(`${ORIGIN}/secret`, { headers: { "User-Agent": LINKEDIN } }),
      new Request(`${ORIGIN}/secret`, { method: "HEAD", headers: { "User-Agent": PERSON } }),
      new Request(`${ORIGIN}/secret`, { headers: { "User-Agent": PERSON, "Sec-Purpose": "prefetch" } }),
    ];
    for (const req of lookers) {
      const res = await call(req);
      expect(res.status).toBe(204);
      expect(res.headers.get("Location")).toBeNull();
    }
    expect((await cap()).count).toBe(0);
  });

  it("counts a click for any other client that is sent on, whatever it calls itself", async () => {
    await create({ maxClicks: 1 });
    const scripted = await call(new Request(`${ORIGIN}/secret`, { headers: { "User-Agent": "python-requests/2.32" } }));
    expect(scripted.status).toBe(302);
    expect((await visit()).status).toBe(410);
  });

  it("counts a new limit from zero, keeps the count when it changes, and resets on request", async () => {
    await create({});
    await visit();
    await patch("secret", { maxClicks: 2 });
    expect(await cap()).toEqual({ limit: 2, count: 0 });
    await visit();
    await patch("secret", { maxClicks: 5 });
    expect((await cap()).count).toBe(1);
    expect(await (await call(`${API}/links/sh.example/secret/cap/reset`, { method: "POST", headers: bearer })).json()).toEqual({ limit: 5, count: 0 });
    await patch("secret", { maxClicks: null });
    expect(((await env.LINKS.get("sh.example/secret", "json")) as { mc?: number }).mc).toBeUndefined();
  });

  it("asks for the password before using a click", async () => {
    await create({ maxClicks: 1, password: "open sesame" });
    expect((await visit()).status).toBe(200);
    expect((await cap()).count).toBe(0);
    const cookie = cookieOf(await submit("open sesame"));
    expect((await visit("secret", { Cookie: cookie })).status).toBe(302);
    expect((await visit("secret", { Cookie: cookie })).status).toBe(410);
  });
});

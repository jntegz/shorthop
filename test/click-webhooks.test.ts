import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClickHooks } from "../src/worker/webhooks";
import { API, call, json, ORIGIN, putLink, resetData } from "./helpers";

const PERSON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const HOOK = "https://hooks.example.com/clicks";

let sent: { url: string; body: string; headers: Headers }[] = [];
beforeEach(async () => {
  await resetData();
  resetClickHooks();
  sent = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://hooks.example.com/")) {
      sent.push({ url, body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response("ok");
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

async function hook(events: string[], clickTags: string[] = []) {
  expect((await call(`${API}/webhooks`, json({ url: HOOK, events, clickTags }))).status).toBe(201);
}

/** Clicks and waits for the background work (the test runner finishes waitUntil before returning). */
const click = (slug: string, ua = PERSON) => call(`${ORIGIN}/${slug}`, { headers: { "User-Agent": ua }, redirect: "manual" });

describe("link.clicked", () => {
  it("posts each person's click, signed, without writing a delivery row", async () => {
    await hook(["link.clicked"]);
    await putLink("go", { u: "https://example.com/" });
    await click("go");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const body = JSON.parse(sent[0]!.body) as { type: string; data: { slug: string; device: string } };
    expect(body).toMatchObject({ type: "link.clicked", data: { slug: "go", device: "desktop" } });
    expect(sent[0]!.headers.get("X-Shorthop-Signature")).toMatch(/^t=\d+,v1=/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").first<{ n: number }>())?.n).toBe(0);
  });

  it("leaves bots out, and webhooks that didn't ask", async () => {
    await hook(["link.created"]);
    await putLink("go", { u: "https://example.com/" });
    await click("go", "Googlebot/2.1 (+http://www.google.com/bot.html)");
    await click("go");
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
  });

  it("sends only clicks on links with a chosen tag", async () => {
    await hook(["link.clicked"], ["launch"]);
    await call(`${API}/links`, json({ slug: "tagged", target: "https://example.com/a", tags: "launch" }));
    await call(`${API}/links`, json({ slug: "plain", target: "https://example.com/b" }));
    await click("plain");
    await click("tagged");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(JSON.parse(sent[0]!.body).data.slug).toBe("tagged");
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkDTO } from "../src/shared/types";
import { checkUnsafeBacklog } from "../src/worker/health";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";

const ON = { SAFETY_DNS: "" } as Partial<Env>;
let dnsDown = false;

beforeEach(async () => {
  await resetData();
  dnsDown = false;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "security.cloudflare-dns.com") {
      if (dnsDown) throw new Error("network down");
      const name = url.searchParams.get("name") ?? "";
      const bad = name.startsWith("phish.");
      return Response.json({ Status: 0, Answer: [{ name, type: 1, data: bad ? "0.0.0.0" : "93.184.215.14" }], ...(bad ? { Comment: ["EDE(16): Censored"] } : {}) });
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const create = async (slug: string, target: string) => {
  const res = await call(`${API}/links`, json({ slug, target }), ON);
  expect(res.status).toBe(201);
  return ((await res.json()) as { link: LinkDTO }).link;
};
const open = (slug: string) => call(`${ORIGIN}/${slug}`, { headers: { "User-Agent": "Mozilla/5.0 Safari/605.1.15" }, redirect: "manual" }, ON);

describe("unsafe destinations", () => {
  it("warns visitors before a flagged destination, with a way through", async () => {
    const link = await create("bad", "https://phish.example.net/login");
    expect(link.unsafe).toBe("flagged");
    expect(await env.LINKS.get("sh.example/bad", "json")).toMatchObject({ w: 1 });
    const res = await open("bad");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("may not be safe");
    expect(html).toContain('href="https://phish.example.net/login"');
  });

  it("lets the owner trust it, and checks a new destination again", async () => {
    await create("bad", "https://phish.example.net/");
    const trusted = await call(`${API}/links/sh.example/bad`, { ...json({ trustDestination: true }), method: "PATCH" }, ON);
    expect(((await trusted.json()) as { link: LinkDTO }).link.unsafe).toBe("trusted");
    expect((await open("bad")).status).toBe(302);

    const moved = await call(`${API}/links/sh.example/bad`, { ...json({ target: "https://fine.example.org/" }), method: "PATCH" }, ON);
    expect(((await moved.json()) as { link: LinkDTO }).link.unsafe).toBeNull();
  });

  it("never blocks a save when the lookup fails", async () => {
    dnsDown = true;
    // A host not looked up before (answers are cached for a few minutes).
    const link = await create("ok", "https://phish.never-seen.example/");
    expect(link.unsafe).toBeNull();
    expect((await open("ok")).status).toBe(302);
  });

  it("checks imported links in the background and republishes flagged ones", async () => {
    await call(`${API}/import`, json({ rows: [{ slug: "imp", target: "https://phish.example.net/x" }, { slug: "fine", target: "https://fine.example.org/" }] }), ON);
    const r = await checkUnsafeBacklog({ ...env, ...ON } as Env, 10);
    expect(r).toEqual({ checked: 2, flagged: 1 });
    expect(await env.LINKS.get("sh.example/imp", "json")).toMatchObject({ w: 1 });
    const fine = (await (await call(`${API}/links/sh.example/fine`, { headers: bearer })).json()) as { link: LinkDTO };
    expect(fine.link.unsafe).toBeNull();
  });
});

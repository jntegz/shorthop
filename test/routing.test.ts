import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeConditions,
  pickRoute,
  routeCountry,
  routeDevice,
  ruleMatches,
  shadowedRules,
  splitChanged,
  validateRouting,
  type RouteRule,
  type Routing,
} from "../src/shared/routing";
import type { LinkDTO, LinkListItem, VersionDTO } from "../src/shared/types";
import { runLinkChecks } from "../src/worker/link-check";
import { API, bearer, call, captureClicks, enableChecks, json, ORIGIN, resetData } from "./helpers";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const LINKEDIN_BOT = "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)";

const rule = (over: Partial<RouteRule>): RouteRule => ({
  id: "r1",
  name: "",
  enabled: true,
  devices: [],
  countries: [],
  countryMode: "in",
  variants: [{ id: "a", label: "", url: "https://example.com/a", weight: 100 }],
  ...over,
});

/** App stores first, then a 70/30 split for Czech desktops; everyone else gets the target. */
const APP_SETUP = {
  rules: [
    rule({ id: "ios", name: "App Store", devices: ["ios"], variants: [{ id: "a", label: "", url: "https://apps.apple.com/app/x", weight: 100 }] }),
    rule({ id: "and", devices: ["android"], variants: [{ id: "a", label: "", url: "https://play.google.com/store/apps/details?id=x", weight: 100 }] }),
    rule({
      id: "cz",
      devices: ["desktop"],
      countries: ["CZ", "SK"],
      variants: [
        { id: "a", label: "A", url: "https://example.com/cz-a", weight: 70 },
        { id: "b", label: "B", url: "https://example.com/cz-b", weight: 30 },
      ],
    }),
  ],
};

describe("matching", () => {
  it("classifies devices and countries the way rules see them", () => {
    expect(routeDevice("iOS", "mobile")).toBe("ios");
    expect(routeDevice("iOS", "tablet")).toBe("ios");
    expect(routeDevice("Android", "tablet")).toBe("android");
    expect(routeDevice("macOS", "desktop")).toBe("desktop");
    expect(routeDevice("Other", "mobile")).toBe("other");
    expect(routeCountry("cz")).toBe("CZ");
    expect(routeCountry("T1")).toBe("XX");
    expect(routeCountry(undefined)).toBe("XX");
  });

  it("matches devices and countries, including outside a list", () => {
    const r = rule({ devices: ["ios", "android"], countries: ["CZ"] });
    expect(ruleMatches(r, { device: "ios", country: "CZ" })).toBe(true);
    expect(ruleMatches(r, { device: "desktop", country: "CZ" })).toBe(false);
    expect(ruleMatches(r, { device: "ios", country: "DE" })).toBe(false);
    const outside = rule({ countries: ["CZ", "SK"], countryMode: "not_in" });
    expect(ruleMatches(outside, { device: "desktop", country: "DE" })).toBe(true);
    expect(ruleMatches(outside, { device: "desktop", country: "SK" })).toBe(false);
    expect(ruleMatches(outside, { device: "desktop", country: "XX" })).toBe(true);
  });

  it("uses the first matching rule and splits by weight", () => {
    const desktopCz = { device: "desktop" as const, country: "CZ" };
    expect(pickRoute(APP_SETUP.rules, { device: "ios", country: "CZ" }, 0.5)).toMatchObject({ url: "https://apps.apple.com/app/x", key: "ios" });
    expect(pickRoute(APP_SETUP.rules, desktopCz, 0)).toMatchObject({ url: "https://example.com/cz-a", key: "cz.a" });
    expect(pickRoute(APP_SETUP.rules, desktopCz, 0.6999)).toMatchObject({ key: "cz.a" });
    expect(pickRoute(APP_SETUP.rules, desktopCz, 0.7)).toMatchObject({ key: "cz.b" });
    expect(pickRoute(APP_SETUP.rules, desktopCz, 0.9999)).toMatchObject({ key: "cz.b" });
    expect(pickRoute(APP_SETUP.rules, { device: "desktop", country: "DE" }, 0.5)).toBeNull();
  });

  it("splits close to the configured weights", () => {
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 10_000; i++) counts[pickRoute(APP_SETUP.rules, { device: "desktop", country: "SK" }, Math.random())!.variantId as "a" | "b"]++;
    expect(counts.a / 10_000).toBeGreaterThan(0.67);
    expect(counts.a / 10_000).toBeLessThan(0.73);
  });

  it("describes conditions in words", () => {
    const name = (c: string) => ({ CZ: "Czechia", SK: "Slovakia" })[c] ?? c;
    expect(describeConditions(rule({}))).toBe("Everyone");
    expect(describeConditions(rule({ devices: ["ios"], countries: ["CZ", "SK"] }), name)).toBe("iPhone & iPad in Czechia or Slovakia");
    expect(describeConditions(rule({ countries: ["CZ"], countryMode: "not_in" }), name)).toBe("Anyone outside Czechia");
  });
});

describe("validation", () => {
  it("accepts a sound setup and normalizes it", () => {
    const r = validateRouting({ rules: [rule({ countries: ["cz"], variants: [{ id: "a", label: "", url: "https://example.com/a", weight: 5 }] })] });
    expect(r).toMatchObject({ ok: true, rules: [{ countries: ["CZ"], variants: [{ weight: 100 }] }] });
  });

  it.each([
    ["shares that don't add up", rule({ variants: [{ id: "a", label: "A", url: "https://e.com/a", weight: 60 }, { id: "b", label: "B", url: "https://e.com/b", weight: 30 }] }), "add up to 100"],
    ["unnamed split destinations", rule({ variants: [{ id: "a", label: "", url: "https://e.com/a", weight: 50 }, { id: "b", label: "B", url: "https://e.com/b", weight: 50 }] }), "Name each destination"],
    ["http destinations", rule({ variants: [{ id: "a", label: "", url: "http://e.com/a", weight: 100 }] }), "https://"],
    ["pointing back at the shortener", rule({ variants: [{ id: "a", label: "", url: "https://sh.example/x", weight: 100 }] }), "back at the shortener"],
    ["bad country codes", rule({ countries: ["CZE"] }), "two-letter"],
    ["every device ticked", rule({ devices: ["ios", "android", "desktop", "other"] }), "Every device"],
    ["no destination", rule({ variants: [] }), "Add a destination"],
  ])("rejects %s", (_, r, message) => {
    const result = validateRouting({ rules: [r] }, { selfHosts: ["sh.example"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.message).toContain(message);
  });

  it("rejects rules that can never run after a rule for everyone", () => {
    const r = validateRouting({ rules: [rule({ id: "all" }), rule({ id: "ios", devices: ["ios"] })] });
    expect(r).toMatchObject({ ok: false, errors: [{ rule: 1, message: expect.stringContaining("never runs") }] });
    // A paused catch-all doesn't hide anything.
    expect(validateRouting({ rules: [rule({ id: "all", enabled: false }), rule({ id: "ios", devices: ["ios"] })] }).ok).toBe(true);
  });

  it("flags rules hidden by a broader one above", () => {
    const rules = [rule({ id: "a", devices: ["ios"] }), rule({ id: "b", devices: ["ios"], countries: ["CZ"] }), rule({ id: "c", devices: ["android"] })];
    expect([...shadowedRules(rules)]).toEqual([1]);
  });

  it("knows when a change starts a new results period", () => {
    const base = APP_SETUP.rules;
    expect(splitChanged(base, base.map((r) => ({ ...r, name: "renamed" })))).toBe(false);
    expect(splitChanged(base, base.map((r) => (r.id === "cz" ? { ...r, variants: r.variants.map((v) => ({ ...v, weight: 50 })) } : r)))).toBe(true);
  });
});

describe("redirects", () => {
  beforeEach(async () => {
    await resetData();
    const res = await call(`${API}/links`, json({ slug: "app", target: "https://example.com/app", routing: APP_SETUP, utm: true, utmTemplate: "utm_content={variant}" }));
    expect(res.status).toBe(201);
  });
  afterEach(() => vi.restoreAllMocks());

  const visit = async (ua: string, country?: string, headers: Record<string, string> = {}) => {
    const { points, CLICKS } = captureClicks();
    const req = new Request(`${ORIGIN}/app`, { headers: { "User-Agent": ua, ...headers }, cf: country ? { country } : {} } as RequestInit);
    const res = await call(req, undefined, { CLICKS });
    return { location: res.headers.get("Location"), route: points[0]?.blobs?.[17], status: res.status };
  };

  it("sends each device and country where its rule says, and everyone else to the target", async () => {
    expect(await visit(IPHONE, "US")).toMatchObject({ location: "https://apps.apple.com/app/x?utm_content=App%20Store", route: "ios" });
    expect(await visit(ANDROID, "CZ")).toMatchObject({ location: "https://play.google.com/store/apps/details?id=x&utm_content=and", route: "and" });
    expect(await visit(MAC, "DE")).toMatchObject({ location: "https://example.com/app?utm_content=default", route: "-" });
    expect(await visit(MAC)).toMatchObject({ location: "https://example.com/app?utm_content=default", route: "-" });
  });

  it("splits Czech desktops 70/30 and records the variant", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    expect(await visit(MAC, "CZ")).toMatchObject({ location: "https://example.com/cz-a?utm_content=A", route: "cz.a" });
    vi.spyOn(Math, "random").mockReturnValue(0.8);
    expect(await visit(MAC, "SK")).toMatchObject({ location: "https://example.com/cz-b?utm_content=B", route: "cz.b" });
  });

  it("gives bots and link previews the fallback, but routes a browser's prefetch", async () => {
    expect(await visit(LINKEDIN_BOT, "CZ")).toMatchObject({ location: "https://example.com/app?utm_content=default", route: "-" });
    expect(await visit(IPHONE, "CZ", { "Sec-Purpose": "prefetch" })).toMatchObject({ location: expect.stringContaining("apps.apple.com") });
  });

  it("publishes only enabled rules, and turning routing off restores the plain redirect", async () => {
    const off = APP_SETUP.rules.map((r) => (r.id === "ios" ? { ...r, enabled: false } : r));
    await call(`${API}/links/sh.example/app`, { ...json({ routing: { rules: off } }), method: "PATCH" });
    const kv = (await env.LINKS.get("sh.example/app", "json")) as { ro: { id: string }[] };
    expect(kv.ro.map((r) => r.id)).toEqual(["and", "cz"]);
    expect((await visit(IPHONE, "US")).route).toBe("-");

    await call(`${API}/links/sh.example/app`, { ...json({ routing: null }), method: "PATCH" });
    expect(((await env.LINKS.get("sh.example/app", "json")) as { ro?: unknown }).ro).toBeUndefined();
    expect(await visit(IPHONE, "US")).toMatchObject({ location: "https://example.com/app?utm_content=default", route: "" });
  });
});

describe("API", () => {
  beforeEach(resetData);
  const create = (routing: unknown) => call(`${API}/links`, json({ slug: "app", target: "https://example.com/app", routing }));
  const get = async () => ((await (await call(`${API}/links/sh.example/app`, { headers: bearer })).json()) as { link: LinkDTO }).link;

  it("explains what's wrong with a setup", async () => {
    const res = await create({ rules: [rule({ variants: [{ id: "a", label: "A", url: "https://e.com/a", weight: 60 }, { id: "b", label: "B", url: "https://e.com/b", weight: 30 }] })] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "routing: Rule 1: The shares must add up to 100%.", details: [{ rule: 0 }] });
  });

  it("moves the results date only when destinations or weights change", async () => {
    await create(APP_SETUP);
    const first = (await get()).routing!;
    await env.DB.prepare("UPDATE links SET routing = json_set(routing, '$.changedAt', 1000)").run();
    const renamed = { rules: APP_SETUP.rules.map((r) => ({ ...r, name: `${r.name} (renamed)` })) };
    await call(`${API}/links/sh.example/app`, { ...json({ routing: renamed }), method: "PATCH" });
    expect((await get()).routing!.changedAt).toBe(1000);
    const reweighted = { rules: APP_SETUP.rules.map((r) => (r.id === "cz" ? { ...r, variants: r.variants.map((v) => ({ ...v, weight: 50 })) } : r)) };
    await call(`${API}/links/sh.example/app`, { ...json({ routing: reweighted }), method: "PATCH" });
    expect((await get()).routing!.changedAt).toBeGreaterThan(1000);
    expect(first.rules).toHaveLength(3);
  });

  it("keeps routing in the history and restores it", async () => {
    await create(APP_SETUP);
    await call(`${API}/links/sh.example/app`, { ...json({ routing: null }), method: "PATCH" });
    const { versions } = (await (await call(`${API}/links/sh.example/app/history`, { headers: bearer })).json()) as { versions: VersionDTO[] };
    expect(versions[0]!.snapshot.routing).toBeNull();
    const created = versions.at(-1)!;
    expect((JSON.parse(created.snapshot.routing!) as Routing).rules).toHaveLength(3);
    await call(`${API}/links/sh.example/app/history/${created.id}/restore`, { method: "POST", headers: bearer });
    expect((await get()).routing?.rules.map((r) => r.id)).toEqual(["ios", "and", "cz"]);
    expect(((await env.LINKS.get("sh.example/app", "json")) as { ro: unknown[] }).ro).toHaveLength(3);
  });

  it("checks every routed destination and shows the worst on the link", async () => {
    await create(APP_SETUP);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      new Response(null, { status: String(input).includes("cz-b") ? 404 : 200 }),
    );
    // Three pages of example.com: the per-site limit spreads them over two runs.
    await enableChecks();
    await runLinkChecks(env);
    await runLinkChecks(env);
    const fetched = fetchMock.mock.calls.map(([u]) => String(u));
    for (const u of ["https://example.com/app", "https://apps.apple.com/app/x", "https://example.com/cz-a", "https://example.com/cz-b"]) expect(fetched).toContain(u);
    const { links } = (await (await call(`${API}/links?status=failing`, { headers: bearer })).json()) as { links: LinkListItem[] };
    expect(links.map((l) => l.slug)).toEqual(["app"]);
    expect(links[0]!.check).toMatchObject({ state: "warning", httpStatus: 404 });
    vi.restoreAllMocks();
  });
});

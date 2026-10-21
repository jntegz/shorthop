import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dayStartSec, utcDate } from "../src/shared/dates";
import type { SettingsDTO } from "../src/shared/types";
import { scheduledDaily } from "../src/worker/health";
import { runRollup } from "../src/worker/rollup";
import { aePoint, mockAeSql } from "./ae-mock";
import { API, bearer, call, captureClicks, putLink, resetData } from "./helpers";

const TWO = { SHORT_DOMAINS: "sh.example,alt.example" };
const DEV = "http://localhost:5173/_admin/api/settings";
const DEV_ENV = { ...TWO, DEV_AUTH_BYPASS: "1" };
const AE_ENV = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" };
const NOW = new Date();
const YESTERDAY = addDays(utcDate(NOW), -1);

const rows = async (sql: string, ...params: unknown[]) => (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results;
const count = async (sql: string, ...params: unknown[]) => Number((await env.DB.prepare(sql).bind(...params).first<{ n: number }>())?.n);

/** The admin's purge call, as a signed-in owner (the localhost dev bypass) unless `init` says otherwise. */
function purge(domain: string, confirm = domain, init: RequestInit = {}) {
  return call(
    new Request(`${DEV}/domains/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
      body: JSON.stringify({ domain, confirm }),
      ...init,
    }),
    undefined,
    DEV_ENV,
  );
}

async function purgeAll(domain: string): Promise<number> {
  let deleted = 0;
  for (let calls = 0; calls < 10; calls++) {
    const res = await purge(domain);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; done: boolean };
    deleted += body.deleted;
    if (body.done) return deleted;
  }
  throw new Error("purge never finished");
}

async function addLinks(domain: string, slugs: string[]) {
  await env.DB.batch(
    slugs.map((s) => env.DB.prepare("INSERT INTO links (domain, slug, target, created_at, updated_at) VALUES (?, ?, 'https://example.com/', 1, 1)").bind(domain, s)),
  );
  await Promise.all(slugs.map((s) => putLink(s, { u: "https://example.com/" }, domain)));
}

async function addStats(domain: string, slug: string, date = YESTERDAY) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO daily_stats (date, domain, slug, country, device, source, clicks, uniques, bots) VALUES (?, ?, ?, 'FR', 'desktop', 'direct', 3, 1, 0)").bind(date, domain, slug),
    env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, ?, ?, 'total', '', 3, 1, 0)").bind(date, domain, slug),
    env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, ?, 'nope', 'miss', '', 2, 0, 0)").bind(date, domain),
  ]);
}

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

describe("removing a domain", () => {
  it("deletes the domain's links, KV records, stats and misses, and nothing else", async () => {
    await addLinks("sh.example", ["guide"]);
    await addLinks("alt.example", ["guide", "cv"]);
    await putLink("orphan", { u: "https://example.com/" }, "alt.example"); // KV only, from a failed write
    await addStats("sh.example", "guide");
    await addStats("alt.example", "guide");

    expect(await purgeAll("alt.example")).toBe(2);

    expect(await rows("SELECT domain, slug FROM links")).toEqual([{ domain: "sh.example", slug: "guide" }]);
    expect((await env.LINKS.list()).keys.map((k) => k.name)).toEqual(["sh.example/guide"]);
    expect(await count("SELECT COUNT(*) AS n FROM daily_stats WHERE domain = 'alt.example'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM daily_dims WHERE domain = 'alt.example'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM daily_dims WHERE domain = 'sh.example'")).toBe(2);
  });

  it("leaves a subdomain alone when its parent domain is removed", async () => {
    await addLinks("sh.example", ["guide"]);
    await addLinks("go.sh.example", ["guide"]);
    await addStats("go.sh.example", "guide");
    expect(await purgeAll("sh.example")).toBe(1);
    expect(await rows("SELECT domain, slug FROM links")).toEqual([{ domain: "go.sh.example", slug: "guide" }]);
    expect((await env.LINKS.list()).keys.map((k) => k.name)).toEqual(["go.sh.example/guide"]);
    expect(await count("SELECT COUNT(*) AS n FROM daily_dims WHERE domain = 'go.sh.example'")).toBe(2);
  });

  it("works through large domains a page at a time", async () => {
    await addLinks("alt.example", Array.from({ length: 450 }, (_, i) => `l${i}`));
    const first = (await (await purge("alt.example")).json()) as { deleted: number; done: boolean };
    expect(first).toMatchObject({ deleted: 200, done: false });
    expect(200 + (await purgeAll("alt.example"))).toBe(450);
    expect(await count("SELECT COUNT(*) AS n FROM links")).toBe(0);
  });

  it("needs the domain typed again, and an admin session rather than the API token", async () => {
    await addLinks("alt.example", ["guide"]);
    expect((await purge("alt.example", "sh.example")).status).toBe(400);
    const viaToken = await call(
      `${API}/settings/domains/purge`,
      { method: "POST", headers: { "Content-Type": "application/json", ...bearer }, body: JSON.stringify({ domain: "alt.example", confirm: "alt.example" }) },
      TWO,
    );
    expect(viaToken.status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM links")).toBe(1);
  });

  it("keeps the domain's old Analytics Engine rows out of later rollups", async () => {
    await addLinks("sh.example", ["guide"]);
    await addLinks("alt.example", ["guide"]);
    // Real redirects on both domains yesterday, as Analytics Engine would hold them.
    const { points, CLICKS } = captureClicks();
    for (const host of ["sh.example", "alt.example"]) await call(`https://${host}/guide`, { headers: { "User-Agent": "Mozilla/5.0 Chrome/130" } }, { ...TWO, CLICKS });
    const store = points.map((p) => aePoint(p, dayStartSec(YESTERDAY) + 3600));
    expect(store).toHaveLength(2);

    await purgeAll("alt.example");
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    expect(await count("SELECT COUNT(*) AS n FROM daily_dims WHERE domain = 'alt.example'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM daily_dims WHERE domain = 'sh.example'")).toBeGreaterThan(0);
  });
});

describe("demo data", () => {
  const seedDemo = async (domain = "sh.example") => {
    await addLinks(domain, ["guide", "pricing"]);
    await addStats(domain, "guide");
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('demo_data', ?)")
      .bind(JSON.stringify({ domain, links: ["guide", "pricing"], misses: ["nope"] }))
      .run();
  };
  const settings = async (extra: Partial<Env> = {}) => (await (await call(`${API}/settings`, { headers: bearer }, { ...TWO, ...extra })).json()) as SettingsDTO;

  it("is reported, and removing it keeps links added by hand", async () => {
    await seedDemo();
    await addLinks("sh.example", ["mine"]);
    expect((await settings()).demo).toEqual({ domain: "sh.example", links: 2 });

    const res = await call(`${API}/settings/demo`, { method: "DELETE", headers: bearer }, TWO);
    expect(await res.json()).toEqual({ removed: true });
    expect(await rows("SELECT slug FROM links")).toEqual([{ slug: "mine" }]);
    expect((await env.LINKS.list()).keys.map((k) => k.name)).toEqual(["sh.example/mine"]);
    expect(await count("SELECT COUNT(*) AS n FROM daily_dims")).toBe(0);
    expect((await settings()).demo).toBeNull();
  });

  it("goes on its own once a real domain is configured, not for placeholder ones", async () => {
    await seedDemo();
    expect((await settings({ SHORT_DOMAINS: "sh.example,alt.example,links.test" })).demo).not.toBeNull();
    expect((await settings({ SHORT_DOMAINS: "sh.example,go.realdomain.com" })).demo).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM links")).toBe(0);
  });

  it("is cleared by the daily job too", async () => {
    await seedDemo();
    await scheduledDaily({ ...env, SHORT_DOMAINS: "go.realdomain.com,sh.example" }, NOW);
    expect(await count("SELECT COUNT(*) AS n FROM settings WHERE key = 'demo_data'")).toBe(0);
  });
});

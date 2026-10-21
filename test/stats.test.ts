import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dayStartSec, utcDate } from "../src/shared/dates";
import type { LinkStatsDTO, MissRow, OverviewDTO, SettingsDTO } from "../src/shared/types";
import { dataset } from "../src/worker/ae";
import { digestData, renderDigest, runDigest } from "../src/worker/digest";
import { jsonChunks, setSettingStmt } from "../src/worker/db";
import { capDims, runRollup } from "../src/worker/rollup";
import { aePoint, mockAeSql, type StoredPoint } from "./ae-mock";
import { API, bearer, call, captureClicks, json, ORIGIN, putLink, resetData } from "./helpers";

const AE_ENV = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" };
const NOW = new Date();
const TODAY = utcDate(NOW);
const YESTERDAY = addDays(TODAY, -1);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const TWO = { SHORT_DOMAINS: "sh.example,alt.example" };

interface Hit {
  /** Defaults to https://sh.example. */
  host?: string;
  path: string;
  ua?: string;
  ip?: string;
  cf?: Record<string, unknown>;
}

/** Sends real requests through the Worker and stores the data points at a given time. */
async function hits(store: StoredPoint[], ts: number, list: Hit[]) {
  const { points, CLICKS } = captureClicks();
  for (const h of list) {
    const req = new Request(`${h.host ?? ORIGIN}${h.path}`, {
      headers: { "User-Agent": h.ua ?? CHROME, "CF-Connecting-IP": h.ip ?? "198.51.100.1" },
      cf: { country: "FR", city: "Paris", region: "Paris", continent: "EU", asn: 3215, asOrganization: "Orange", colo: "CDG", ...h.cf },
    } as RequestInit);
    await call(req, undefined, { CLICKS, ...TWO });
  }
  store.push(...points.map((p) => aePoint(p, ts)));
}

let store: StoredPoint[];

beforeEach(async () => {
  await resetData();
  store = [];
  await putLink("guide", { u: "https://example.com/guide" });
  await putLink("cv", { u: "https://example.com/cv" });
  await env.DB.prepare(
    "INSERT INTO links (domain, slug, target, created_at, updated_at) VALUES ('sh.example', 'guide', 'https://example.com/guide', 1, 1), ('sh.example', 'cv', 'https://example.com/cv', 1, 1), ('sh.example', 'Old', 'https://x.com/', 1, 1)",
  ).run();

  const y = dayStartSec(YESTERDAY) + 36000;
  await hits(store, y, [
    { path: "/guide?s=li", ip: "1.1.1.1" },
    { path: "/guide?s=li", ip: "1.1.1.1" }, // same visitor, same day
    { path: "/guide?s=nl", ip: "2.2.2.2", ua: IPHONE, cf: { country: "US", city: "Austin", region: "Texas" } },
    { path: "/guide", ua: "LinkedInBot/1.0" },
    { path: "/cv?q=1", ip: "3.3.3.3" },
    { path: "/old" }, // case-only miss of "Old"
    { path: "/wp-login.php", ua: "curl/8" },
  ]);
  const t = Math.floor(NOW.getTime() / 1000) - 60;
  await hits(store, t, [
    { path: "/guide?s=li", ip: "1.1.1.1" }, // same IP as yesterday, new day → new unique
    { path: "/cv", ip: "4.4.4.4", ua: IPHONE },
  ]);
});

afterEach(() => vi.restoreAllMocks());

const rows = async (sql: string, ...params: unknown[]) => (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results;

describe("rollup", () => {
  it("skips cleanly without Analytics Engine credentials", async () => {
    expect(await runRollup(env, NOW)).toMatchObject({ skipped: expect.any(String), rolled: [] });
  });

  it("rolls completed days into D1 and is idempotent", async () => {
    mockAeSql(store);
    const e = { ...env, ...AE_ENV };
    const first = await runRollup(e, NOW);
    expect(first.rolled.at(-1)).toBe(YESTERDAY);
    expect(first.rolled).toHaveLength(7);

    const totals = await rows("SELECT slug, clicks, uniques, bots FROM daily_dims WHERE dim = 'total' AND date = ? ORDER BY slug", YESTERDAY);
    expect(totals).toEqual([
      { slug: "cv", clicks: 1, uniques: 1, bots: 0 },
      { slug: "guide", clicks: 3, uniques: 2, bots: 1 },
    ]);
    const combos = await rows("SELECT country, device, source, clicks, uniques, bots FROM daily_stats WHERE slug = 'guide' ORDER BY country, device, source");
    expect(combos).toEqual([
      { country: "FR", device: "bot", source: "direct", clicks: 0, uniques: 0, bots: 1 },
      { country: "FR", device: "desktop", source: "li", clicks: 2, uniques: 1, bots: 0 },
      { country: "US", device: "mobile", source: "nl", clicks: 1, uniques: 1, bots: 0 },
    ]);
    const cities = await rows("SELECT value, clicks FROM daily_dims WHERE dim = 'city' AND slug = 'guide' ORDER BY value");
    expect(cities).toEqual([
      { value: "Austin, US", clicks: 1 },
      { value: "Paris, FR", clicks: 2 },
    ]);
    // The curl request for /wp-login.php is a bot probe, which isn't tracked by default.
    const misses = await rows("SELECT slug, clicks, bots FROM daily_dims WHERE dim = 'miss' ORDER BY slug");
    expect(misses).toEqual([{ slug: "old", clicks: 1, bots: 0 }]);
    expect(await rows("SELECT value FROM settings WHERE key = 'last_rolled'")).toEqual([{ value: YESTERDAY }]);

    // Nothing new to roll, and re-rolling the same days gives identical rows.
    expect((await runRollup(e, NOW)).rolled).toEqual([]);
    const before = await rows("SELECT COUNT(*) AS n FROM daily_dims");
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'last_rolled'").bind(addDays(YESTERDAY, -3)).run();
    expect((await runRollup(e, NOW)).rolled).toHaveLength(3);
    expect(await rows("SELECT COUNT(*) AS n FROM daily_dims")).toEqual(before);
  });

  it("queries the AE_DATASET dataset and refuses names that aren't identifiers", async () => {
    const queries = mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => /FROM shorthop_test_clicks\s/.test(q))).toBe(true);
    expect(dataset({ AE_DATASET: "my_clicks_2" } as Env)).toBe("my_clicks_2");
    for (const bad of ["", "clicks; DROP", "a-b", "x y", "x".repeat(65)]) {
      expect(() => dataset({ AE_DATASET: bad } as Env), bad).toThrow(/AE_DATASET/);
    }
  });

  it("caps long tails into (other) and chunks large JSON", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ date: TODAY, domain: "sh.example", slug: "s", dim: "referrer", value: `r${i}`, clicks: 150 - i, uniques: 0, bots: 0 }));
    const capped = capDims(many);
    expect(capped).toHaveLength(101);
    expect(capped.find((r) => r.value === "(other)")?.clicks).toBe(((1 + 50) * 50) / 2);
    const chunks = jsonChunks(Array.from({ length: 30000 }, (_, i) => ["sh.example", `slug-${i}`, "FR", "desktop", "li", i, i, 0]));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 500_000)).toBe(true);
    expect(chunks.flatMap((c) => JSON.parse(c) as unknown[])).toHaveLength(30000);
  });

  it("keeps a day's real misses however busy the scanners were", () => {
    const miss = (slug: string, clicks: number) => ({ date: TODAY, domain: "sh.example", slug, dim: "miss", value: "", clicks, uniques: 0, bots: 0 });
    const capped = capDims([...Array.from({ length: 300 }, (_, i) => miss(`scan-${i}.php`, 5)), ...Array.from({ length: 5 }, (_, i) => miss(`typo-${i}`, 1))]);
    expect(capped.filter((r) => r.slug.startsWith("typo-"))).toHaveLength(5);
    expect(capped.filter((r) => r.slug.endsWith(".php"))).toHaveLength(200);
    expect(capped.some((r) => r.slug === "(other)")).toBe(false);
  });
});

describe("stats API", () => {
  it("merges D1 rollups with live data for today", async () => {
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    const res = await call(`${API}/stats/links/sh.example/guide?range=7d`, { headers: bearer }, AE_ENV);
    const s = (await res.json()) as LinkStatsDTO;
    expect(s.aeAvailable).toBe(true);
    expect(s.totals).toEqual({ clicks: 4, uniques: 3, bots: 1 });
    expect(s.series).toHaveLength(7);
    expect(s.series.at(-1)).toMatchObject({ date: TODAY, clicks: 1, uniques: 1 });
    expect(s.dims.source).toEqual([
      { value: "li", clicks: 3, bots: 0 },
      { value: "nl", clicks: 1, bots: 0 },
      { value: "direct", clicks: 0, bots: 1 },
    ]);
    expect(s.dims.bot).toEqual([{ value: "LinkedIn", clicks: 0, bots: 1 }]);
    expect(s.dims.country.map((c) => c.value)).toEqual(["FR", "US"]);
  });

  it("works from D1 alone when Analytics Engine is unavailable", async () => {
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    const s = (await (await call(`${API}/stats/links/sh.example/guide?range=7d`, { headers: bearer })).json()) as LinkStatsDTO;
    expect(s.aeAvailable).toBe(false);
    expect(s.totals.clicks).toBe(3);
  });

  it("builds the overview and the misses report", async () => {
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    const o = (await (await call(`${API}/stats/overview?range=30d`, { headers: bearer }, AE_ENV)).json()) as OverviewDTO;
    expect(o.totals.clicks).toBe(6);
    expect(o.topLinks.map((l) => [l.slug, l.clicks, l.target])).toEqual([
      ["guide", 4, "https://example.com/guide"],
      ["cv", 2, "https://example.com/cv"],
    ]);
    const m = (await (await call(`${API}/stats/misses?range=7d`, { headers: bearer }, AE_ENV)).json()) as { rows: MissRow[] };
    expect(m.rows.find((r) => r.slug === "old")).toMatchObject({ hits: 1, link: "none", suggestion: "Old" });
  });

  it("returns recent hits", async () => {
    mockAeSql(store);
    const r = (await (await call(`${API}/stats/recent?slug=guide&limit=2`, { headers: bearer }, AE_ENV)).json()) as {
      hits: { slug: string; event: string }[];
    };
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0]).toMatchObject({ slug: "guide", event: "click" });
  });

  it("lists 7-day and all-time clicks per link", async () => {
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    const res = await call(`${API}/links?sort=clicks`, { headers: bearer }, AE_ENV);
    const { links } = (await res.json()) as { links: { slug: string; clicksPeriod: number; clicksTotal: number }[] };
    expect(links.slice(0, 2)).toEqual([
      expect.objectContaining({ slug: "guide", clicksPeriod: 4, clicksTotal: 4 }),
      expect.objectContaining({ slug: "cv", clicksPeriod: 2, clicksTotal: 2 }),
    ]);
    // Move yesterday's clicks 20 days back: inside 30d, outside 14d.
    await env.DB.prepare("UPDATE daily_dims SET date = ? WHERE date = ?").bind(addDays(TODAY, -20), YESTERDAY).run();
    const list = async (period: string) =>
      ((await (await call(`${API}/links?sort=clicks&period=${period}`, { headers: bearer }, AE_ENV)).json()) as { links: { slug: string; clicksPeriod: number }[] })
        .links;
    expect((await list("14d")).find((l) => l.slug === "guide")?.clicksPeriod).toBe(1);
    expect((await list("30d")).find((l) => l.slug === "guide")?.clicksPeriod).toBe(4);
    expect((await list("all")).find((l) => l.slug === "guide")?.clicksPeriod).toBe(4);
    expect((await call(`${API}/links?period=2d`, { headers: bearer })).status).toBe(400);
  });

  it("says which days the next rollup will save", async () => {
    mockAeSql(store);
    const settings = async () => (await (await call(`${API}/settings`, { headers: bearer }, AE_ENV)).json()) as SettingsDTO;
    expect((await settings()).rollupPending).toEqual({ from: addDays(YESTERDAY, -6), to: YESTERDAY, days: 7 });
    await runRollup({ ...env, ...AE_ENV }, NOW);
    expect((await settings()).rollupPending).toBeNull();
  });
});

const POLICY = { trackNoise: true, noiseLimit: 100, retentionDays: 90, realLimit: 1000 };
const setPolicy = (policy: Partial<typeof POLICY>) => call(`${API}/stats/misses/policy`, { ...json({ ...POLICY, ...policy }), method: "PUT" }, AE_ENV);
const report = async (range = "30d") =>
  ((await (await call(`${API}/stats/misses?range=${range}`, { headers: bearer }, AE_ENV)).json()) as { rows: MissRow[] }).rows;

describe("misses cleanup", () => {
  const clear = (body: unknown) => call(`${API}/stats/misses/clear`, json(body), AE_ENV);

  beforeEach(async () => {
    expect((await setPolicy({ trackNoise: true })).status).toBe(200);
    await hits(store, dayStartSec(YESTERDAY) + 50000, [
      { path: "//.env.production.local", ip: "9.9.9.9" },
      { path: "/wp-login.php", ua: "curl/8" },
    ]);
    await hits(store, Math.floor(NOW.getTime() / 1000) - 30, [{ path: "/nope", ip: "8.8.8.8" }]);
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
  });

  it("flags scanner probes and keeps them out of the digest", async () => {
    const rows_ = await report();
    expect(rows_.find((r) => r.slug === "/.env.production.local")).toMatchObject({ hits: 1, probe: true });
    expect(rows_.find((r) => r.slug === "wp-login.php")).toMatchObject({ hits: 0, bots: 1, probe: true });
    expect(rows_.find((r) => r.slug === "old")).toMatchObject({ probe: false });
    expect(rows_.find((r) => r.slug === "nope")).toMatchObject({ hits: 1, probe: false });
    expect((await digestData(env, NOW)).misses.map((m) => m.slug)).toEqual(["old"]);
  });

  it("clears one miss, and it stays cleared through a re-rollup", async () => {
    expect((await clear({ links: [{ domain: "sh.example", slug: "old" }] })).status).toBe(200);
    expect((await report()).map((r) => r.slug).sort()).toEqual(["/.env.production.local", "nope", "wp-login.php"]);
    expect(await rows("SELECT slug FROM daily_dims WHERE dim = 'miss' AND slug = 'old'")).toEqual([]);
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'last_rolled'").bind(addDays(YESTERDAY, -3)).run();
    await runRollup({ ...env, ...AE_ENV }, NOW);
    expect((await report()).some((r) => r.slug === "old")).toBe(false);
    expect(await rows("SELECT slug FROM daily_dims WHERE dim = 'miss' AND slug = 'old'")).toEqual([]);
    expect((await digestData(env, NOW)).misses).toEqual([]);
  });

  it("clears everything, including today's live misses", async () => {
    expect((await clear({})).status).toBe(200);
    expect(await report()).toEqual([]);
    expect(await rows("SELECT COUNT(*) AS n FROM daily_dims WHERE dim = 'miss'")).toEqual([{ n: 0 }]);
    expect((await clear({ links: [] })).status).toBe(400);
  });

  it("shows a visit made right after a clear, the same day and after the rollup", async () => {
    const sec = Math.floor(Date.now() / 1000);
    expect((await clear({ links: [{ domain: "sh.example", slug: "nope" }] })).status).toBe(200);
    await hits(store, sec - 5, [{ path: "/nope" }]); // before the clear: stays hidden
    expect((await report()).some((r) => r.slug === "nope")).toBe(false);
    await hits(store, sec + 5, [{ path: "/nope" }]);
    expect((await report()).find((r) => r.slug === "nope")).toMatchObject({ hits: 1 });

    // Everything before the clear goes; the visits after it (both in the future here) stay.
    expect((await clear({})).status).toBe(200);
    await hits(store, sec + 10, [{ path: "/gg" }]);
    expect((await report()).map((r) => r.slug).sort()).toEqual(["gg", "nope"]);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    expect((await report()).map((r) => r.slug).sort()).toEqual(["gg", "nope"]);
  });

  it.each([
    ["everything", {}],
    ["one path", { links: [{ domain: "sh.example", slug: "nope" }] }],
  ])("clearing %s hides misses up to its second and keeps later ones through that day's rollup and prune", async (_, body) => {
    expect((await clear(body)).status).toBe(200);
    const stored = JSON.parse(String((await rows("SELECT value FROM settings WHERE key = 'misses_cleared'"))[0]!.value));
    const sec = "links" in body ? stored.links["sh.example/nope"] : stored.all;
    expect(typeof sec).toBe("number");
    await hits(store, sec - 1, [{ path: "/nope" }]); // hidden
    await hits(store, sec + 1, [{ path: "/nope" }]); // shown
    expect((await report()).find((r) => r.slug === "nope")).toMatchObject({ hits: 1 });

    // The nightly run after the clearing day: rollup with the cutoffs, then the pruner.
    const day = utcDate(new Date(sec * 1000));
    await runRollup({ ...env, ...AE_ENV }, new Date((dayStartSec(addDays(day, 1)) + 4500) * 1000));
    expect(await rows("SELECT clicks FROM daily_dims WHERE dim = 'miss' AND slug = 'nope' AND date = ?", day)).toEqual([{ clicks: 1 }]);
    expect((await report()).find((r) => r.slug === "nope")).toMatchObject({ hits: 1 });
  });

  it("still hides misses through the end of a day stored by older versions", async () => {
    const legacy = { all: YESTERDAY, links: { "sh.example/nope": TODAY } };
    await setSettingStmt(env.DB, "misses_cleared", JSON.stringify(legacy)).run();
    const sec = Math.floor(Date.now() / 1000);
    await hits(store, sec + 5, [{ path: "/nope" }, { path: "/fresh" }]);
    expect((await report()).map((r) => r.slug)).toEqual(["fresh"]);

    await runRollup({ ...env, ...AE_ENV }, new Date((dayStartSec(addDays(TODAY, 1)) + 4500) * 1000));
    expect(await rows("SELECT slug FROM daily_dims WHERE dim = 'miss' ORDER BY slug")).toEqual([{ slug: "fresh" }]);
    expect((await report()).map((r) => r.slug)).toEqual(["fresh"]);
  });

  it("records a probe-looking typo of a real link, and doesn't log the 404 preview", async () => {
    await setPolicy({ trackNoise: false });
    await env.DB.prepare("INSERT INTO links (domain, slug, target, created_at, updated_at) VALUES ('sh.example', 'Feed.xml', 'https://x.com/', 1, 1)").run();
    const { points, CLICKS } = captureClicks();
    for (const path of ["/feed.xml", "/config.xml", "/_404"]) {
      await call(new Request(`${ORIGIN}${path}`, { headers: { "User-Agent": CHROME } }), undefined, { CLICKS });
    }
    expect(points.map((p) => p.indexes?.[0])).toEqual(["feed.xml"]);
    expect((await call(`${ORIGIN}/_404`)).status).toBe(404);
  });

});

describe("miss tracking policy", () => {
  it("prunes nothing until the owner saves a policy", async () => {
    mockAeSql(store);
    await env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, 'sh.example', 'ancient', 'miss', '', 3, 0, 0)")
      .bind(addDays(TODAY, -200))
      .run();
    await runRollup({ ...env, ...AE_ENV }, NOW);
    expect(await rows("SELECT slug FROM daily_dims WHERE slug = 'ancient'")).toHaveLength(1);
    await setPolicy({ retentionDays: 180 });
    expect(await rows("SELECT slug FROM daily_dims WHERE slug = 'ancient'")).toEqual([]);
  });

  it("doesn't record scanner probes or bot misses unless tracking is on", async () => {
    const probes: Hit[] = [{ path: "//.env" }, { path: "/xmlrpc.php" }, { path: "/typo", ua: "Googlebot/2.1" }, { path: "/typo" }];
    const { points, CLICKS } = captureClicks();
    for (const h of probes) await call(new Request(`${ORIGIN}${h.path}`, { headers: { "User-Agent": h.ua ?? CHROME } }), undefined, { CLICKS });
    expect(points.map((p) => p.indexes?.[0])).toEqual(["typo"]);

    await setPolicy({ trackNoise: true });
    points.length = 0;
    for (const h of probes) await call(new Request(`${ORIGIN}${h.path}`, { headers: { "User-Agent": h.ua ?? CHROME } }), undefined, { CLICKS });
    expect(points.map((p) => p.indexes?.[0])).toEqual(["/.env", "xmlrpc.php", "typo", "typo"]);
  });

  it("keeps only the most recent paths of each kind, within the retention", async () => {
    mockAeSql(store);
    const insert = env.DB.prepare("INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots) VALUES (?, 'sh.example', ?, 'miss', '', ?, 0, ?)");
    // 120 real paths and 120 probes, one per day going back; plus one bot-only path and one real path 4 months ago.
    await env.DB.batch([
      ...Array.from({ length: 120 }, (_, i) => insert.bind(addDays(TODAY, -1 - (i % 60)), `typo-${i}`, 1, 0)),
      ...Array.from({ length: 120 }, (_, i) => insert.bind(addDays(TODAY, -1 - (i % 60)), `scan-${i}.php`, 1, 0)),
      insert.bind(addDays(TODAY, -3), "bot-only", 0, 4),
      insert.bind(addDays(TODAY, -120), "old-typo", 9, 0),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_rolled', ?)").bind(YESTERDAY),
    ]);
    const paths = async () => (await rows("SELECT DISTINCT slug FROM daily_dims WHERE dim = 'miss'")).map((r) => r.slug as string);
    const removed = async (res: Response) => ((await res.json()) as { removed: number }).removed;

    // 6 months: old-typo survives the retention but not the 100 most recent real paths.
    expect(await removed(await setPolicy({ retentionDays: 180, realLimit: 100, noiseLimit: 100 }))).toBe(21 + 21);
    const kept = await paths();
    expect(kept.filter((p) => p.startsWith("typo-"))).toHaveLength(100);
    expect(kept).toContain("typo-0"); // the most recent are kept
    expect(kept).not.toContain("typo-59");
    expect(kept.filter((p) => p.endsWith(".php") || p === "bot-only")).toHaveLength(100);
    const shown = await report("all");
    expect(shown.filter((r) => r.probe || r.hits === 0)).toHaveLength(100);
    expect(shown.find((r) => r.slug === "typo-0")?.lastSeen).toBe(addDays(TODAY, -1));

    // Turning noise tracking off removes every probe and bot-only path, now and in the report.
    await setPolicy({ trackNoise: false, retentionDays: 90, realLimit: 0 });
    expect((await paths()).every((p) => p.startsWith("typo-"))).toBe(true);
    expect((await report("all")).every((r) => !r.probe && r.hits > 0)).toBe(true);

    expect((await setPolicy({ noiseLimit: 42 as 100 })).status).toBe(400);
  });

  it("exports the misses as CSV, following the filters", async () => {
    await setPolicy({ trackNoise: true });
    await hits(store, dayStartSec(YESTERDAY) + 50000, [{ path: "/.git/config" }, { path: "/=cmd|calc" }]);
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    const get = async (q: string) => (await call(`${API}/stats/misses/export.csv?range=30d${q}`, { headers: bearer }, AE_ENV)).text();
    const plain = await get("");
    expect(plain.split("\r\n")[0]).toBe("domain,path,link,human_visits,bot_visits,last_seen,why,case_match");
    expect(plain).toContain(`sh.example,old,/old,1,0,${YESTERDAY},case differs,Old`);
    expect(plain).not.toContain(".git");
    const all = await get("&probes=1&bots=1");
    expect(all).toContain(".git/config");
    expect(all).toContain("scanner probe");
    expect(all).toContain("'=cmd|calc"); // spreadsheet formulas are defused
  });
});

describe("weekly digest", () => {
  it("summarizes the last 7 days from D1", async () => {
    mockAeSql(store);
    await runRollup({ ...env, ...AE_ENV }, NOW);
    const d = await digestData(env, NOW);
    expect(d.totals).toEqual({ clicks: 4, uniques: 3, bots: 1 });
    expect(d.topLinks[0]).toMatchObject({ slug: "guide", clicks: 3, previous: 0 });
    expect(d.misses.map((m) => m.slug)).toEqual(["old"]);
    const { subject, html, text } = renderDigest(d, "https://sh.example", "sh.example");
    expect(subject).toContain("4 clicks");
    expect(html).toContain("/guide");
    expect(text).toContain("Top links:");
  });

  it("sends once per week through the binding", async () => {
    mockAeSql(store);
    const sent: unknown[] = [];
    const DIGEST = { send: async (m: unknown) => (sent.push(m), { messageId: "m1" }) } as unknown as SendEmail;
    const e = { ...env, ...AE_ENV, DIGEST };
    expect(await runDigest(e, NOW)).toMatchObject({ status: "sent", messageId: "m1" });
    expect(sent[0]).toMatchObject({ to: env.DIGEST_TO, from: { email: env.DIGEST_FROM } });
    expect(await runDigest(e, NOW)).toMatchObject({ status: "skipped" });
    expect(await runDigest(e, NOW, true)).toMatchObject({ status: "sent" });
  });

  it("reports send failures with the error code", async () => {
    const DIGEST = {
      send: async () => {
        throw Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" });
      },
    } as unknown as SendEmail;
    expect(await runDigest({ ...env, DIGEST }, NOW)).toMatchObject({ status: "failed", reason: "E_SENDER_NOT_VERIFIED" });
  });

  it("previews over the admin API", async () => {
    const res = await call(`${API}/settings/digest/preview`, { headers: bearer });
    expect(((await res.json()) as { subject: string }).subject).toContain("sh.example weekly");
    expect((await call(`${API}/settings/rollup`, json({}))).status).toBe(200);
  });
});

describe("short domains", () => {
  it("keeps the same slug on two domains apart in rollups, stats, misses and the digest", async () => {
    await putLink("guide", { u: "https://alt-target.example/guide" }, "alt.example");
    await env.DB.prepare(
      "INSERT INTO links (domain, slug, target, created_at, updated_at) VALUES ('alt.example', 'guide', 'https://alt-target.example/guide', 1, 1)",
    ).run();
    await hits(store, dayStartSec(YESTERDAY) + 40000, [
      { host: "https://alt.example", path: "/guide?s=x", ip: "5.5.5.5" },
      { host: "https://alt.example", path: "/guide", ip: "6.6.6.6" },
      { host: "https://alt.example", path: "/nothing", ip: "7.7.7.7" },
    ]);
    mockAeSql(store);
    const e = { ...env, ...AE_ENV, ...TWO };
    await runRollup(e, NOW);

    expect(await rows("SELECT domain, slug, clicks, uniques FROM daily_dims WHERE dim = 'total' AND date = ? ORDER BY domain, slug", YESTERDAY)).toEqual([
      { domain: "alt.example", slug: "guide", clicks: 2, uniques: 2 },
      { domain: "sh.example", slug: "cv", clicks: 1, uniques: 1 },
      { domain: "sh.example", slug: "guide", clicks: 3, uniques: 2 },
    ]);

    const stats = async (domain: string) =>
      (await (await call(`${API}/stats/links/${domain}/guide?range=7d`, { headers: bearer }, { ...AE_ENV, ...TWO })).json()) as LinkStatsDTO;
    expect((await stats("alt.example")).totals.clicks).toBe(2);
    expect((await stats("sh.example")).totals.clicks).toBe(4);

    const o = (await (await call(`${API}/stats/overview?range=30d`, { headers: bearer }, { ...AE_ENV, ...TWO })).json()) as OverviewDTO;
    const top = o.topLinks.map((l) => [l.domain, l.slug, l.clicks, l.target]);
    expect(top[0]).toEqual(["sh.example", "guide", 4, "https://example.com/guide"]);
    // alt.example/guide and sh.example/cv tie on clicks, so their order is open.
    expect(top.slice(1)).toHaveLength(2);
    expect(top.slice(1)).toEqual(
      expect.arrayContaining([
        ["alt.example", "guide", 2, "https://alt-target.example/guide"],
        ["sh.example", "cv", 2, "https://example.com/cv"],
      ]),
    );

    const m = (await (await call(`${API}/stats/misses?range=7d`, { headers: bearer }, { ...AE_ENV, ...TWO })).json()) as { rows: MissRow[] };
    expect(m.rows.find((r) => r.slug === "nothing")).toMatchObject({ domain: "alt.example", hits: 1, link: "none" });

    const r = (await (await call(`${API}/stats/recent?domain=alt.example&slug=guide`, { headers: bearer }, { ...AE_ENV, ...TWO })).json()) as {
      hits: { domain: string; slug: string }[];
    };
    expect(r.hits).toHaveLength(2);
    expect(r.hits.every((h) => h.domain === "alt.example")).toBe(true);

    const { text } = renderDigest(await digestData(e, NOW), "https://sh.example", "sh.example");
    expect(text).toContain("alt.example/guide");
    expect(text).toContain("/guide —");
  });

  it("refuses to put an invalid domain into Analytics Engine SQL", async () => {
    const { domainLiteral } = await import("../src/worker/ae");
    expect(() => domainLiteral("x' OR 1=1 --")).toThrow();
    expect(domainLiteral("alt.example")).toBe("'alt.example'");
  });
});

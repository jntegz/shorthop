// Every bulk path must stay inside Workers Free's 50 subrequests per
// invocation (fetch, KV and D1 calls alike, everything waitUntil started
// included). These tests count the calls with WORKERS_PLAN "free" and keep a
// margin of five below the limit.

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, utcDate } from "../src/shared/dates";
import { DOWN_AFTER_FAILS } from "../src/shared/link-check";
import type { ImportResult } from "../src/shared/types";
import { nowSec } from "../src/worker/db";
import worker from "../src/worker/index";
import { runLinkChecks } from "../src/worker/link-check";
import { FREE } from "../src/worker/plan";
import { mockAeSql } from "./ae-mock";
import { API, bearer, call, enableChecks, json, resetData } from "./helpers";

const FREE_MAX = 45;
const HOOK = "https://hooks.example.com/shorthop";
const AE_ENV = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" };
const MAIL_ENV = { DIGEST_PROVIDER: "resend", DIGEST_API_KEY: "re_key" };

const REAL = Symbol("real statement");

/** The env with DB, LINKS and the mail binding counting each call they make, and fetch counted too. */
function counting(extra: Partial<Env> = {}) {
  const calls: string[] = [];
  const tick = (what: string) => calls.push(what);
  const wrap = (real: D1PreparedStatement, sql: string): D1PreparedStatement =>
    ({
      [REAL]: real,
      bind: (...values: unknown[]) => wrap(real.bind(...values), sql),
      first: (...a: [string?]) => (tick(`D1 ${sql}`), (real.first as (...x: unknown[]) => unknown)(...a)),
      run: () => (tick(`D1 ${sql}`), real.run()),
      all: () => (tick(`D1 ${sql}`), real.all()),
      raw: (...a: unknown[]) => (tick(`D1 ${sql}`), (real.raw as (...x: unknown[]) => unknown)(...a)),
    }) as unknown as D1PreparedStatement;
  const DB = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql), sql.replace(/\s+/g, " ").slice(0, 60)),
    batch: (stmts: D1PreparedStatement[]) => (tick("D1 batch"), env.DB.batch(stmts.map((s) => (s as unknown as { [REAL]?: D1PreparedStatement })[REAL] ?? s))),
    exec: (q: string) => (tick("D1 exec"), env.DB.exec(q)),
  } as unknown as D1Database;
  const methods = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(t, p) {
        const v = Reflect.get(t, p) as unknown;
        return typeof v === "function" ? (...a: unknown[]) => (tick(`${name} ${String(p)}`), (v as (...x: unknown[]) => unknown).apply(t, a)) : v;
      },
    });
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    tick(`fetch ${input instanceof Request ? input.url : String(input)}`);
    return inner(input, init);
  });
  const e = { ...env, WORKERS_PLAN: "free", ...extra, DB, LINKS: methods("KV", env.LINKS), DIGEST: methods("mail", env.DIGEST) } as Env;
  return { env: e, calls, count: () => calls.length };
}

async function cron(e: Env, cronText: string, at: Date) {
  const ctx = createExecutionContext();
  await worker.scheduled({ cron: cronText, scheduledTime: at.getTime(), noRetry() {} } as ScheduledController, e, ctx);
  await waitOnExecutionContext(ctx);
}

/** Today at hh:mm UTC. */
const todayAt = (hh: number, mm: number) => new Date(`${utcDate(new Date())}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);

async function addLinks(n: number, prefix = "l") {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO links (domain, slug, target, monitor, created_at, updated_at)
     SELECT 'sh.example', ?1 || value, 'https://example.com/' || value, 0, ?2, ?2 FROM json_each(?3)`,
  )
    .bind(prefix, now, JSON.stringify(Array.from({ length: n }, (_, i) => i)))
    .run();
}

async function addHook(events: string[]) {
  const res = await call(`${API}/webhooks`, json({ url: HOOK, events }));
  expect(res.status).toBe(201);
}

/** Webhook deliveries waiting for the cron. */
const makeDeliveriesDue = () => env.DB.prepare("UPDATE webhook_deliveries SET status = 'pending', next_at = 0").run();

let fetchRoute: (url: string, init?: RequestInit) => Response;
beforeEach(async () => {
  await resetData();
  fetchRoute = () => new Response(null, { status: 200 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.resend.com")) return Response.json({ id: "msg" });
    return fetchRoute(url, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Workers Free: at most 45 subrequests per invocation", () => {
  it("republishes a full page of links", async () => {
    await addLinks(45);
    const c = counting();
    const res = (await (await call(`${API}/resync`, { method: "POST", headers: bearer }, c.env)).json()) as { published: number; next: string | null };
    expect(res).toMatchObject({ published: 40, next: expect.any(String) });
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });

  it("imports a full batch with two webhooks subscribed, and refuses a bigger one", async () => {
    await addHook(["link.created"]);
    await addHook(["link.created", "link.updated"]);
    const rows = Array.from({ length: 20 }, (_, i) => ({ slug: `imp${i}`, target: `https://example.com/imp${i}` }));
    const c = counting();
    const res = await call(`${API}/import`, json({ rows }), c.env);
    expect(((await res.json()) as ImportResult).created).toBe(20);
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);

    const tooMany = await call(`${API}/import`, json({ rows: [...rows, { slug: "imp20", target: "https://example.com/x" }] }), { WORKERS_PLAN: "free" });
    expect(tooMany.status).toBe(413);
    expect(await tooMany.json()).toMatchObject({ code: "too_many_rows" });
  });

  it("runs destination checks with webhooks due, destinations coming back and an email", async () => {
    await addHook(["link.health_changed", "link.created"]);
    for (let i = 0; i < 12; i++) {
      expect((await call(`${API}/links`, json({ slug: `chk${i}`, target: `https://site${i}.example/`, monitor: true }))).status).toBe(201);
    }
    await enableChecks();
    // Three destinations confirmed down (and emailed about) before the run.
    fetchRoute = (url) => new Response(null, { status: /site[0-2]\./.test(url) ? 404 : 200 });
    for (let i = 0; i < DOWN_AFTER_FAILS; i++) {
      await runLinkChecks({ ...env, ...MAIL_ENV } as Env);
      await env.DB.prepare("UPDATE target_checks SET next_at = 0").run();
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM target_checks WHERE status = 'down'").first<{ n: number }>())?.n).toBe(3);
    fetchRoute = () => new Response(null, { status: 200 });
    await makeDeliveriesDue();

    const c = counting(MAIL_ENV);
    await cron(c.env, "*/30 * * * *", todayAt(10, 30));
    expect(c.calls.some((x) => x.includes("api.resend.com")), c.calls.join("\n")).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM target_checks WHERE status = 'down'").first<{ n: number }>())?.n).toBeLessThan(3);
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });

  it("runs the 02:00 cleanup with uploads to prune, milestones and the health alert", async () => {
    await addHook(["link.milestone", "link.created"]);
    await addLinks(5, "m");
    const old = nowSec() - 3 * 86400;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('milestones_started', '1')"),
      env.DB.prepare(
        `INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, uniques, bots)
         SELECT ?1, 'sh.example', 'm' || value, 'total', '', 150, 1, 0 FROM json_each('[0,1,2,3,4]')`,
      ).bind(addDays(utcDate(new Date()), -1)),
      env.DB.prepare(
        "INSERT INTO preview_images (key, created_at, bytes) SELECT 'orphan' || value || '.png', ?1, 10 FROM json_each('[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14]')",
      ).bind(old),
    ]);
    await makeDeliveriesDue();

    const c = counting();
    await cron(c.env, "*/30 * * * *", todayAt(2, 0));
    expect(c.calls.filter((x) => x === "KV delete")).toHaveLength(FREE.prunedUploads);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM link_milestones").first<{ n: number }>())?.n).toBe(5);
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });

  it("catches the rollup up two weeks at a time", async () => {
    mockAeSql([]);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_rolled', ?)").bind(addDays(utcDate(new Date()), -31)).run();
    const c = counting(AE_ENV);
    await cron(c.env, "15 * * * *", todayAt(1, 15));
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_rolled'").first<{ value: string }>()).toEqual({
      value: addDays(utcDate(new Date()), -17),
    });
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });

  it("copies a week of website totals in the 02:30 run, and nothing else", async () => {
    const queries = mockAeSql([]);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('web_last_rolled', ?)").bind(addDays(utcDate(new Date()), -30)).run();
    const c = counting(AE_ENV);
    await cron(c.env, "*/30 * * * *", todayAt(2, 30));
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'web_last_rolled'").first<{ value: string }>()).toEqual({
      value: addDays(utcDate(new Date()), -30 + FREE.webRollupDays),
    });
    expect(queries.length).toBe(3 * FREE.webRollupDays);
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });

  it("runs website alerts within the budget with every site spiking and its digest due", async () => {
    await call(`${API}/webhooks`, json({ url: HOOK, events: ["site.traffic_spike"] }));
    const at = todayAt(10, 15);
    const t = Math.floor(at.getTime() / 1000);
    for (const n of [1, 2, 3, 4, 5]) {
      const site = await (await call(`${API}/sites`, json({ name: `Shop ${n}`, domains: [`shop${n}.example.com`], dailyDigest: true, digestHour: 10 }))).json<{ id: string }>();
      await env.DB.prepare(
        `INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at, source, channel)
         SELECT ?1 || '-' || value, ?1, 'v' || value, ?2 - value * 60, ?2, 'Hacker News', 'Organic Social' FROM json_each(?3)`,
      )
        .bind(site.id, t, JSON.stringify(Array.from({ length: 25 }, (_, i) => i)))
        .run();
    }
    vi.stubGlobal("fetch", async () => Response.json({ id: "sent" }));
    const c = counting(MAIL_ENV);
    await cron(c.env, "15 * * * *", at);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM site_spikes").first("n")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE digest_sent_on IS NOT NULL").first("n")).toBe(2);
    expect(c.calls.filter((x) => x.startsWith("fetch")).length, c.calls.join("\n")).toBeGreaterThan(0);
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });

  it("converts and matches payments in the 03:00 run within the budget, however many are waiting", async () => {
    // Three sites with 20 unconverted, unmatched payments each, in another currency than the site's.
    const now = nowSec();
    for (const n of [1, 2, 3]) {
      const site = await (await call(`${API}/sites`, json({ name: `Shop ${n}`, domains: [`shop${n}.example.com`] }))).json<{ id: string }>();
      await env.DB.prepare(
        `INSERT INTO payments (id, site_id, provider, kind, occurred_at, amount_minor, currency, email, created_at)
         SELECT 'stripe:charge:' || ?1 || '-' || value, ?1, 'stripe', 'charge', ?2 - value * 86400, 1000, 'USD', 'b' || value || '@example.com', ?2 FROM json_each(?3)`,
      )
        .bind(site.id, now, JSON.stringify(Array.from({ length: 20 }, (_, i) => i)))
        .run();
    }
    vi.stubGlobal("fetch", async () => Response.json({ date: utcDate(new Date()), rates: { USD: 1.1, GBP: 0.85 } }));
    const c = counting();
    await cron(c.env, "*/30 * * * *", todayAt(3, 0));
    expect(c.calls.some((x) => x.startsWith("fetch https://api.frankfurter.dev")), c.calls.join("\n")).toBe(true);
    expect(c.calls.some((x) => x.includes("SELECT id, site_id, provider")), c.calls.join("\n")).toBe(true);
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });

  it("sends the Monday digest without rolling up twice", async () => {
    const queries = mockAeSql([]);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_rolled', ?)").bind(addDays(utcDate(new Date()), -3)).run();
    const c = counting({ ...AE_ENV, ...MAIL_ENV });
    await cron(c.env, "0 7 * * 1", todayAt(7, 0));
    expect(c.calls.some((x) => x.includes("api.resend.com")), c.calls.join("\n")).toBe(true);
    // One rollup's worth of Analytics Engine queries, not two.
    expect(queries.length).toBeLessThanOrEqual(15);
    expect(c.count(), c.calls.join("\n")).toBeLessThanOrEqual(FREE_MAX);
  });
});

describe("Workers Paid keeps the large pages", () => {
  it("republishes 200 links a call", async () => {
    await addLinks(205);
    const res = (await (await call(`${API}/resync`, { method: "POST", headers: bearer }, { WORKERS_PLAN: "paid" })).json()) as { published: number };
    expect(res.published).toBe(200);
  });
});

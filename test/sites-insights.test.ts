// Site insights (peak hours, reading, path to purchase, customer value), the
// readable Direct split, consent mode, the install check and site alerts.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerValueDTO, EngagementDTO, InstallStatusDTO, PeakHoursDTO, PurchasePathsDTO, SiteDTO } from "../src/shared/sites";
import { visitRef } from "../src/worker/revenue/read";
import { findSpikes, runSiteAlerts } from "../src/worker/web/alerts";
import { attributionOf, inAppBrowser } from "../src/worker/web/source";
import { aePoint, mockAeSql } from "./ae-mock";
import { API, call, captureClicks, json, ORIGIN, resetData } from "./helpers";

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetData();
});

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const INSTAGRAM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 619461904)";
const AE_ENV = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "token" };
const now = () => Math.floor(Date.now() / 1000);

async function createSite(body: Record<string, unknown> = {}): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"], ...body }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

function collect(site: SiteDTO, payload: Record<string, unknown>, headers: Record<string, string> = {}, extraEnv: Record<string, unknown> = {}): Promise<Response> {
  return call(
    `${ORIGIN}/_t/e`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": "203.0.113.7", ...headers },
      body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/`, r: "", w: 1440, ...payload }),
    },
    extraEnv,
  );
}

async function get<T>(path: string, extraEnv: Record<string, unknown> = {}): Promise<T> {
  const res = await call(`${API}${path}`, { headers: json({}).headers }, extraEnv);
  expect(res.status).toBe(200);
  return res.json<T>();
}

let seq = 0;
async function session(site: SiteDTO, visitor: string, startedAt: number, fields: Record<string, string | number> = {}): Promise<string> {
  const id = `sess${String(++seq).padStart(10, "0")}`;
  const cols = ["id", "site_id", "visitor_id", "started_at", "last_seen_at", "pageviews", ...Object.keys(fields)];
  const values = [id, site.id, visitor, startedAt, startedAt + 60, 1, ...Object.values(fields)];
  await env.DB.prepare(`INSERT INTO web_sessions (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...values).run();
  return id;
}

async function payment(site: SiteDTO, p: { id: string; at: number; amount: number; visitor?: string | null; credited?: string | null; customer?: string; kind?: string; billing?: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO payments (id, site_id, provider, kind, billing, occurred_at, amount_minor, currency, amount_site_minor, customer_id, visitor_id, session_id, credited_session_id, created_at)
     VALUES (?1, ?2, 'api', ?3, ?4, ?5, ?6, 'USD', ?6, ?7, ?8, ?9, ?9, ?5)`,
  )
    .bind(p.id, site.id, p.kind ?? "charge", p.billing ?? "one_time", p.at, p.amount, p.customer ?? null, p.visitor ?? null, p.credited ?? null)
    .run();
}

describe("readable Direct", () => {
  it("names in-app browsers, checkout returns, shared links and typed visits", () => {
    expect(inAppBrowser(INSTAGRAM_UA)).toBe("Instagram");
    expect(inAppBrowser("Mozilla/5.0 (Linux; Android 14) [FBAN/EMA;FBLC/en_US;FBAV/400.0]")).toBe("Facebook");
    expect(inAppBrowser(UA)).toBe("");
    expect(attributionOf(new URL("https://x.com/"), "", null)).toMatchObject({ source: "Typed / bookmark", channel: "Direct" });
    expect(attributionOf(new URL("https://x.com/blog/post"), "", null)).toMatchObject({ source: "Shared link", channel: "Direct" });
    expect(attributionOf(new URL("https://x.com/blog/post"), "", null, { inApp: "TikTok" })).toMatchObject({ source: "TikTok (in-app)", channel: "Direct" });
    expect(attributionOf(new URL("https://x.com/thanks"), "checkout.stripe.com", null)).toMatchObject({ source: "Checkout return", channel: "Direct" });
    expect(attributionOf(new URL("https://x.com/thanks"), "", null, { checkoutReturn: true })).toMatchObject({ source: "Checkout return" });
    // A tag still wins.
    expect(attributionOf(new URL("https://x.com/?utm_source=newsletter"), "checkout.stripe.com", null)).toMatchObject({ source: "Newsletter" });
  });

  it("classifies a visit from Instagram's in-app browser through the collector", async () => {
    const site = await createSite();
    const res = await collect(site, { u: `${SITE_ORIGIN}/launch` }, { "User-Agent": INSTAGRAM_UA });
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT source, channel FROM web_sessions WHERE site_id = ?").bind(site.id).first()).toEqual({ source: "Instagram (in-app)", channel: "Direct" });
  });
});

describe("consent mode", () => {
  it("keeps a visitor cookieless until the browser reports consent", async () => {
    const site = await createSite({ idMode: "consent" });
    const vid = "consentvisitor0000000001";
    const before = await collect(site, { v: vid });
    expect(await before.json()).toMatchObject({ m: "c", a: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions WHERE visitor_id = ?").bind(vid).first("n")).toBe(0);

    const after = await collect(site, { v: vid, cs: 1 }, { "CF-Connecting-IP": "203.0.113.8" });
    expect(await after.json()).toMatchObject({ m: "p" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions WHERE visitor_id = ?").bind(vid).first("n")).toBe(1);

    // Global Privacy Control still wins.
    const gpc = await collect(site, { v: vid, cs: 1 }, { "Sec-GPC": "1" });
    const gpcBody = await gpc.json<Record<string, unknown>>();
    expect(gpcBody).toMatchObject({ m: "c" });
    // Nothing to ask: the browser already said no.
    expect(gpcBody.a).toBeUndefined();
    // Cookieless sites never ask.
    expect((await (await collect(await createSite(), {})).json<Record<string, unknown>>()).a).toBeUndefined();
  });

  it("reads the visit reference from checkout metadata, with or without its prefix", () => {
    expect(visitRef({ sh_ref: "sh_abcdefghijkl34" })).toBe("abcdefghijkl34");
    expect(visitRef({ sh_ref: "abcdefghijkl12" })).toBe("abcdefghijkl12");
  });
});

describe("install check", () => {
  it("waits for the first visit, then reports it", async () => {
    const site = await createSite();
    expect(await get<InstallStatusDTO>(`/sites/${site.id}/install-status`)).toEqual({ lastSeenAt: null, hostname: null, visits24h: 0 });
    await collect(site, {});
    const s = await get<InstallStatusDTO>(`/sites/${site.id}/install-status`);
    expect(s.lastSeenAt).toBeGreaterThan(now() - 60);
    expect(s).toMatchObject({ hostname: "shop.example.com", visits24h: 1 });
  });
});

describe("insights", () => {
  it("places visits and sales on the site's weekday and hour", async () => {
    const site = await createSite({ timezone: "America/New_York" });
    // Monday 2026-10-19 14:20 in New York (EDT, UTC-4) is 18:20 UTC.
    const mon = Date.UTC(2026, 9, 19, 18, 20) / 1000;
    for (let i = 0; i < 3; i++) await session(site, `v${i}`, mon + i * 60);
    await session(site, "w", mon + 86400 + 3600);
    await payment(site, { id: "api:charge:1", at: mon + 600, amount: 4900 });
    const q = "range=custom&from=2026-10-19&to=2026-10-25";
    const visits = await get<PeakHoursDTO>(`/sites/${site.id}/peak-hours?${q}`);
    expect(visits.cells[0]![14]).toBe(3);
    expect(visits.cells[1]![15]).toBe(1);
    expect(visits.top[0]).toEqual({ day: 0, hour: 14, value: 3 });
    const revenue = await get<PeakHoursDTO>(`/sites/${site.id}/peak-hours?${q}&metric=revenue`);
    expect(revenue.cells[0]![14]).toBe(4900);
    expect(revenue.total).toBe(4900);
  });

  it("measures the path to a first purchase and lifetime value by first source", async () => {
    const site = await createSite({ idMode: "persistent" });
    const t = now() - 3 * 86400;
    // Alice: found through Google, came back by newsletter and bought on the 3rd visit 48h later; then renewed.
    await session(site, "alice", t, { source: "Google", channel: "Organic Search", entry_path: "/blog/post" });
    await session(site, "alice", t + 86400, { source: "Typed / bookmark", channel: "Direct", entry_path: "/" });
    const credited = await session(site, "alice", t + 48 * 3600, { source: "Newsletter", channel: "Email", entry_path: "/pricing" });
    await payment(site, { id: "api:charge:a1", at: t + 48 * 3600 + 300, amount: 2000, visitor: "alice", credited, customer: "cus_a" });
    await payment(site, { id: "api:charge:a2", at: t + 60 * 3600, amount: 2000, visitor: "alice", credited, customer: "cus_a", billing: "sub_renewal" });
    // Bob: bought on his first visit from Hacker News, then refunded half.
    const bob = await session(site, "bob", t + 3600, { source: "Hacker News", channel: "Organic Social", entry_path: "/" });
    await payment(site, { id: "api:charge:b1", at: t + 3700, amount: 5000, visitor: "bob", credited: bob, customer: "cus_b" });
    await payment(site, { id: "api:refund:b1", at: t + 7200, amount: -2500, visitor: "bob", credited: bob, customer: "cus_b", kind: "refund" });

    const paths = await get<PurchasePathsDTO>(`/sites/${site.id}/purchase-paths?range=7d`);
    expect(paths.customers).toBe(2);
    expect(paths.firstVisitShare).toBe(0.5);
    expect(paths.medianVisits).toBe(2);
    expect(paths.pairs).toEqual(
      expect.arrayContaining([
        { found: "Google", credited: "Newsletter", customers: 1, revenue: 2000 },
        { found: "Hacker News", credited: "Hacker News", customers: 1, revenue: 5000 },
      ]),
    );
    expect(paths.pages.find((p) => p.path === "/")?.customers).toBe(2);

    const value = await get<CustomerValueDTO>(`/sites/${site.id}/customer-value?range=7d`);
    expect(value.customers).toBe(2);
    expect(value.rows).toEqual([
      { source: "Google", channel: "Organic Search", customers: 1, lifetimeRevenue: 4000, avgValue: 4000, repeatShare: 1 },
      { source: "Hacker News", channel: "Organic Social", customers: 1, lifetimeRevenue: 2500, avgValue: 2500, repeatShare: 0 },
    ]);
  });

  it("reports reading time and scroll depth per page, buyers apart", async () => {
    const site = await createSite();
    const { points, CLICKS: WEB } = captureClicks();
    const send = async (ip: string, body: Record<string, unknown>) => (await collect(site, body, { "CF-Connecting-IP": ip }, { WEB })).json<{ s: string }>();
    const buyer = await send("203.0.113.1", {});
    await send("203.0.113.1", { t: "engage", d: 40_000, sd: 90 });
    await send("203.0.113.2", {});
    await send("203.0.113.2", { t: "engage", d: 4_000, sd: 20 });
    await send("203.0.113.2", { t: "engage", d: 6_000, sd: 50 });
    await call(`${API}/sites/${site.id}/payments`, json({ id: "o-1", amount: 20, currency: "USD", ref: buyer.s }));
    mockAeSql(points.map((p, i) => aePoint(p, now() - 600 + i)));

    const r = await get<EngagementDTO>(`/sites/${site.id}/engagement?range=7d`, AE_ENV);
    expect(r.available).toBe(true);
    expect(r.all).toEqual([{ path: "/", visits: 2, medianSec: 25, avgSec: 25, avgScroll: 70, deepShare: 0.5 }]);
    expect(r.buyers).toEqual([{ path: "/", visits: 1, medianSec: 40, avgSec: 40, avgScroll: 90, deepShare: 1 }]);
    expect(r.others[0]).toMatchObject({ visits: 1, medianSec: 10, avgScroll: 50, deepShare: 0 });
  });
});

describe("site alerts", () => {
  it("reports a traffic spike once, by webhook", async () => {
    const site = await createSite();
    const hook = await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/in", events: ["site.traffic_spike"] }));
    expect(hook.status).toBe(201);
    const t = now();
    // Usually about one visit a day from Hacker News; 25 in the last hour.
    for (let d = 1; d <= 7; d++) await session(site, `old${d}`, t - d * 86400, { source: "Hacker News", channel: "Organic Social" });
    for (let i = 0; i < 25; i++) await session(site, `hn${i}`, t - 3000 + i * 10, { source: "Hacker News", channel: "Organic Social" });
    for (let i = 0; i < 5; i++) await session(site, `g${i}`, t - 1000 + i, { source: "Google", channel: "Organic Search" });

    expect((await findSpikes(env.DB, site.id, t)).map((s) => s.source)).toEqual(["Hacker News"]);
    expect(await runSiteAlerts(env, t)).toMatchObject({ spikes: 1 });
    const delivery = await env.DB.prepare("SELECT payload FROM webhook_deliveries WHERE event_type = 'site.traffic_spike'").first<{ payload: string }>();
    expect(JSON.parse(delivery!.payload).data).toMatchObject({ source: "Hacker News", visits_last_hour: 25 });
    // Not again within a few hours.
    expect(await runSiteAlerts(env, t + 1800)).toMatchObject({ spikes: 0 });
  });

  it("sends the daily digest once, at the site's hour", async () => {
    const site = await createSite({ timezone: "Europe/Prague", spikeAlerts: false, dailyDigest: true, digestHour: 9 });
    expect(site).toMatchObject({ dailyDigest: true, digestHour: 9, spikeAlerts: false });
    // 2026-10-27 is CET (UTC+1): 08:15 UTC is 09:15 in Prague, 07:15 UTC is 08:15.
    const early = Date.UTC(2026, 9, 27, 7, 15) / 1000;
    const due = Date.UTC(2026, 9, 27, 8, 15) / 1000;
    expect(await runSiteAlerts(env, early)).toMatchObject({ digests: 0 });
    expect(await runSiteAlerts(env, due)).toMatchObject({ digests: 1 });
    expect(await env.DB.prepare("SELECT digest_sent_on FROM sites WHERE id = ?").bind(site.id).first("digest_sent_on")).toBe("2026-10-27");
    expect(await runSiteAlerts(env, due + 1800)).toMatchObject({ digests: 0 });
  });

  it("sends a site.payment webhook for a payment", async () => {
    const site = await createSite();
    await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/in", events: ["site.payment"] }));
    // The delivery is attempted right away in the background; no network in tests.
    const realFetch = globalThis.fetch;
    const sent = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("https://hooks.example.com/") ? Promise.resolve(new Response("ok")) : realFetch(input, init),
    );
    const ref = (await (await collect(site, { u: `${SITE_ORIGIN}/?utm_source=newsletter` })).json<{ s: string }>()).s;
    const res = await call(`${API}/sites/${site.id}/payments`, json({ id: "o-9", amount: 49, currency: "USD", ref, email: "buyer@example.com" }));
    expect(res.status).toBe(201);
    await vi.waitFor(async () => {
      const row = await env.DB.prepare("SELECT payload FROM webhook_deliveries WHERE event_type = 'site.payment'").first<{ payload: string }>();
      expect(row).not.toBeNull();
      expect(JSON.parse(row!.payload).data).toMatchObject({
        payment: { amount: 49, currency: "USD", email: "buyer@example.com", kind: "charge" },
        credited: { source: "Newsletter" },
        journey: { visits: 1 },
      });
      expect(sent.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).startsWith("https://hooks.example.com/"))).toBe(true);
    });
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GOAL_NAME_RE, type SiteBreakdownRow, type SiteDTO, type SiteOverviewDTO } from "../src/shared/sites";
import { screenClass, vitalsOf } from "../src/worker/web/collect";
import { previousWindow, windowOf } from "../src/worker/web/queries";
import { API, call, json, ORIGIN, resetData } from "./helpers";

beforeEach(resetData);

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

async function createSite(body: Record<string, unknown> = {}): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"], ...body }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

function collect(site: SiteDTO, payload: Record<string, unknown>, opts: { ip?: string; cf?: Record<string, unknown> } = {}): Promise<Response> {
  return call(
    new Request(`${ORIGIN}/_t/e`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": opts.ip ?? "203.0.113.7" },
      body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/`, r: "", w: 1440, ...payload }),
      cf: { country: "DE", city: "Berlin", region: "Berlin", continent: "EU", timezone: "Europe/Berlin", asOrganization: "Example Corp", ...opts.cf },
    } as RequestInit),
  );
}

async function breakdown(site: SiteDTO, dim: string): Promise<SiteBreakdownRow[]> {
  const res = await call(`${API}/sites/${site.id}/breakdown?range=7d&dim=${dim}`, { headers: json({}).headers });
  expect(res.status).toBe(200);
  return (await res.json<{ rows: SiteBreakdownRow[] }>()).rows;
}

describe("website audience", () => {
  it("records the network, continent, time zone and screen class of a visit", async () => {
    const site = await createSite();
    expect((await collect(site, { w: 390 })).status).toBe(200);
    const row = await env.DB.prepare("SELECT org, continent, timezone, screen, return_visit FROM web_sessions WHERE site_id = ?").bind(site.id).first();
    expect(row).toEqual({ org: "Example Corp", continent: "EU", timezone: "Europe/Berlin", screen: "phone", return_visit: 0 });
    expect((await breakdown(site, "org"))[0]).toMatchObject({ value: "Example Corp", visitors: 1 });
    expect((await breakdown(site, "screen"))[0]).toMatchObject({ value: "phone" });
  });

  it("marks a visitor's later visit as returning", async () => {
    const site = await createSite();
    await collect(site, {});
    // A new campaign starts a new visit for the same visitor.
    await collect(site, { u: `${SITE_ORIGIN}/?utm_source=newsletter&utm_campaign=autumn` });
    const rows = await breakdown(site, "visitor_type");
    expect(rows.find((r) => r.value === "new")?.sessions).toBe(1);
    expect(rows.find((r) => r.value === "returning")?.sessions).toBe(1);
  });

  it("keeps the hash route for sites tracked with data-hash", async () => {
    const site = await createSite();
    await collect(site, { u: `${SITE_ORIGIN}/app#/settings` });
    const row = await env.DB.prepare("SELECT entry_path FROM web_sessions WHERE site_id = ?").bind(site.id).first<{ entry_path: string }>();
    expect(row!.entry_path).toBe("/app#/settings");
  });

  it("accepts page speed only for an open visit, and ignores empty measurements", async () => {
    const site = await createSite();
    expect((await collect(site, { t: "vitals", lcp: 1800, cls: 0.02, inp: 120 })).status).toBe(202);
    await collect(site, {});
    expect((await collect(site, { t: "vitals", lcp: 1800, cls: 0.02, inp: 120 })).status).toBe(200);
    expect((await collect(site, { t: "vitals", lcp: 0, inp: 0 })).status).toBe(202);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions WHERE site_id = ?").bind(site.id).first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("returns the period before and spikes with the overview", async () => {
    const site = await createSite();
    await collect(site, {});
    await env.DB.prepare("INSERT INTO site_spikes (site_id, source, detected_at, visits, baseline) VALUES (?, 'LinkedIn', ?, 40, 3)").bind(site.id, Math.floor(Date.now() / 1000) - 60).run();
    const res = await call(`${API}/sites/${site.id}/overview?range=7d`, { headers: json({}).headers });
    const o = await res.json<SiteOverviewDTO>();
    expect(o.previousSeries).toHaveLength(o.series.length);
    expect(o.spikes).toEqual([expect.objectContaining({ source: "LinkedIn", visits: 40 })]);
    expect(o.series.at(-1)).toMatchObject({ sessions: 1, goalSessions: 0 });
    const all = await (await call(`${API}/sites/${site.id}/overview?range=all`, { headers: json({}).headers })).json<SiteOverviewDTO>();
    expect(all.previousSeries).toBeNull();
  });
});

describe("websites list", () => {
  it("summarises the week, the daily visits and the top source", async () => {
    const site = await createSite();
    const empty = await createSite({ name: "Empty", domains: ["empty.example.com"] });
    await collect(site, {});
    await collect(site, { u: `${SITE_ORIGIN}/?utm_source=newsletter&utm_campaign=autumn` }, { ip: "203.0.113.8" });
    const res = await call(`${API}/sites`, { headers: json({}).headers });
    const { sites } = await res.json<{ sites: (SiteDTO & Record<string, unknown>)[] }>();
    const s = sites.find((x) => x.id === site.id)!;
    expect(s).toMatchObject({ visitors7d: 2, visitorsPrev7d: 0, online: 2 });
    expect((s.visitsDaily as { visits: number }[]).at(-1)!.visits).toBe(2);
    expect((s.visitsDaily as unknown[]).length).toBe(14);
    expect((s.topSource as { share: number }).share).toBe(0.5);
    expect(s.lastSeenAt).toEqual(expect.any(Number));
    expect(sites.find((x) => x.id === empty.id)).toMatchObject({ lastSeenAt: null, visitors7d: 0, topSource: null });
  });
});

describe("analytics helpers", () => {
  it("classes screens by window width", () => {
    expect(screenClass(0)).toBe("");
    expect(screenClass(390)).toBe("phone");
    expect(screenClass(800)).toBe("tablet");
    expect(screenClass(1440)).toBe("laptop");
    expect(screenClass(2560)).toBe("wide");
  });

  it("encodes vitals so a perfect layout shift isn't 'not measured'", () => {
    expect(vitalsOf({ lcp: 1200, cls: 0, inp: 0 })).toEqual({ lcp: 1200, cls: 1, inp: 0 });
    expect(vitalsOf({ lcp: 1200, cls: 0.1234, inp: 80 })).toEqual({ lcp: 1200, cls: 124, inp: 80 });
    expect(vitalsOf({ lcp: -5, inp: Number.NaN })).toBeNull();
    expect(vitalsOf({ lcp: 999_999 })?.lcp).toBe(60_000);
  });

  it("only lets safe goal names into Analytics Engine SQL", () => {
    expect(GOAL_NAME_RE.test("signup")).toBe(true);
    expect(GOAL_NAME_RE.test("Přihláška: krok 2")).toBe(true);
    expect(GOAL_NAME_RE.test("x' OR 1=1 --")).toBe(false);
  });

  it("puts the previous window right before the current one, same length", () => {
    const site = { timezone: "Europe/Prague", createdAt: 0 } as SiteDTO;
    const w = windowOf(site, { range: "7d" });
    const p = previousWindow(site, w);
    expect(p.end).toBe(w.start);
    expect(Math.round((p.end - p.start) / 86400)).toBe(Math.round((w.end - w.start) / 86400));
  });
});

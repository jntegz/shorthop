import { afterEach, describe, expect, it, vi } from "vitest";
import { classify, buildDataPoint, coarse } from "../src/worker/analytics";
import { API, bearer, call } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("live map", () => {
  it("records the visitor's place to the nearest 0.1 degree, 0 when unknown", () => {
    expect(coarse("48.8566")).toBe(48.9);
    expect(coarse("-0.1276")).toBe(-0.1);
    expect(coarse(undefined)).toBe(0);
    const req = new Request("https://sh.example/x", { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" } });
    Object.defineProperty(req, "cf", { value: { country: "FR", city: "Paris", latitude: "48.85661", longitude: "2.35222", asn: 1 } });
    const url = new URL(req.url);
    const point = buildDataPoint(req, classify(req, url, null, false), { domain: "sh.example", slug: "x", kind: "hit", sourceTag: null, qr: false }, "hash");
    expect(point.doubles?.slice(3)).toEqual([48.9, 2.4]);
  });

  it("asks Analytics Engine for clicks with a place, never for visitor codes", async () => {
    let sql = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sql = String(init?.body ?? "");
      return Response.json({ data: [{ ts: 1, domain: "sh.example", slug: "x", country: "FR", city: "Paris", device: "desktop", lat: 48.9, lon: 2.4 }] });
    });
    const res = await call(`${API}/stats/live?minutes=15`, { headers: bearer }, { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" } as Partial<Env>);
    const body = await res.json<{ clicks: Record<string, unknown>[] }>();
    expect(body.clicks[0]).toEqual({ ts: 1, domain: "sh.example", slug: "x", country: "FR", city: "Paris", device: "desktop", lat: 48.9, lon: 2.4 });
    expect(sql).toContain("blob1 = 'click'");
    expect(sql).not.toContain("blob15");
  });
});

describe("click peak hours", () => {
  const ae = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "tok" } as Partial<Env>;
  const hourly = (rows: { h: number; v: number }[]) => {
    let sql = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
      sql = String(init?.body ?? "");
      return Response.json({ data: rows });
    });
    return () => sql;
  };

  it("places UTC hours on the viewer's clock, half-hour zones included", async () => {
    // The hour from 09:00 UTC on Monday 2026-11-02 is 14:30 to 15:30 in Kolkata (UTC+5:30); its middle, 15:00, picks the cell.
    const h = Date.UTC(2026, 10, 2, 9) / 1000;
    const sql = hourly([{ h, v: 7 }]);
    const res = await call(`${API}/stats/links/sh.example/x/peak-hours?tz=Asia/Kolkata&days=30`, { headers: bearer }, ae);
    const body = await res.json<{ cells: number[][]; top: { day: number; hour: number }[]; total: number }>();
    expect(body.total).toBe(7);
    expect(body.cells[0]![15]).toBe(7);
    expect(body.top[0]).toMatchObject({ day: 0, hour: 15 });
    expect(sql()).toContain("index1 = 'x'");
  });

  it("follows daylight saving time", async () => {
    // 12:00 UTC is 13:00 in Paris in winter and 14:00 in summer.
    hourly([
      { h: Date.UTC(2026, 0, 5, 12) / 1000, v: 1 },
      { h: Date.UTC(2026, 6, 6, 12) / 1000, v: 2 },
    ]);
    const body = await (await call(`${API}/stats/peak-hours?tz=Europe/Paris`, { headers: bearer }, ae)).json<{ cells: number[][] }>();
    expect(body.cells[0]![13]).toBe(1);
    expect(body.cells[0]![14]).toBe(2);
  });

  it("refuses a made-up time zone", async () => {
    expect((await call(`${API}/stats/peak-hours?tz=Mars/Base`, { headers: bearer }, ae)).status).toBe(400);
  });
});

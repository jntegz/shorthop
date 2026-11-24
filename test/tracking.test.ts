import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedClicksDTO, TrackingPolicy } from "../src/shared/tracking";
import {
  browserVersion,
  cleanDetails,
  deviceModel,
  hostDomain,
  NETWORK_LIST_URLS,
  osVersion,
  parseAsnList,
  pruneTrackedClicks,
  ptrName,
  refreshNetworkLists,
  resetNetworkLists,
  resetTrackingPolicy,
  saveTrackingPolicy,
  reverseDns,
  signBeacon,
  tzMismatch,
  verifyBeacon,
} from "../src/worker/tracking";
import { getLink, publishLatest } from "../src/worker/db";
import { API, call, captureClicks, json, ORIGIN, resetData } from "./helpers";
import { addUser, adminCall } from "./people";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const LINKEDIN_BOT = "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)";

function visit(path: string, opts: { ua?: string; ip?: string; cf?: Record<string, unknown>; headers?: Record<string, string>; method?: string } = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? "GET",
    headers: { "User-Agent": opts.ua ?? CHROME, "CF-Connecting-IP": opts.ip ?? "198.51.100.7", "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8", ...opts.headers },
    cf: { country: "CZ", region: "Prague", city: "Prague", postalCode: "110 00", timezone: "Europe/Prague", continent: "EU", isEUCountry: "1", asn: 5610, asOrganization: "O2 Czech Republic", colo: "PRG", latitude: "50.08804", longitude: "14.42076", tlsVersion: "TLSv1.3", httpProtocol: "HTTP/2", clientTcpRtt: 12, ...opts.cf },
  } as RequestInit);
}

const { CLICKS } = captureClicks();
const hit = (r: Request) => call(r, undefined, { CLICKS });

async function createLink(slug: string, target = "https://example.com/page") {
  const res = await call(`${API}/links`, json({ slug, target }));
  expect(res.status).toBe(201);
}

/** Tracking settings with a purpose, which the default rules require. */
async function setTracking(slug: string, body: Record<string, unknown> | null, email = "") {
  return adminCall(email, `/links/sh.example/${slug}/tracking`, { method: "PUT", body: body === null ? null : { purpose: "Follow-up with one candidate", ...body } });
}

/** Rules that allow everything (the defaults keep IP addresses off). */
const OPEN_POLICY: TrackingPolicy = { enabled: true, allowIp: true, allowBrowser: true, allowPixel: true, maxRetentionDays: 365, requirePurpose: true };

async function clicks(slug: string, email = "", query = ""): Promise<TrackedClicksDTO> {
  const res = await adminCall(email, `/links/sh.example/${slug}/clicks${query}`);
  expect(res.status).toBe(200);
  return res.json<TrackedClicksDTO>();
}

beforeEach(async () => {
  resetNetworkLists();
  resetTrackingPolicy();
  await resetData();
  await env.DB.batch([env.DB.prepare("DELETE FROM tracked_clicks"), env.DB.prepare("DELETE FROM tracked_click_details")]);
  await saveTrackingPolicy(env, OPEN_POLICY);
});

describe("advanced tracking", () => {
  it("is off by default: a plain link writes no click log row", async () => {
    await createLink("plain");
    const res = await hit(visit("/plain"));
    expect(res.status).toBe(302);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("records every detail but the IP address in details mode", async () => {
    await createLink("cv");
    const put = await setTracking("cv", { mode: "details" });
    expect(put.status).toBe(200);
    const kv = await env.LINKS.get("sh.example/cv", "json");
    expect(kv).toMatchObject({ tk: 1, tr: 30 });

    const res = await hit(visit("/cv?s=li", { headers: { Referer: "https://www.linkedin.com/feed/" } }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/page");

    const row = await env.DB.prepare("SELECT * FROM tracked_clicks").first<Record<string, unknown>>();
    expect(row).toMatchObject({ event: "click", ip_enc: null, ip_key: null, country: "CZ", city: "Prague", postal_code: "110 00", timezone: "Europe/Prague", asn: 5610, as_org: "O2 Czech Republic", os: "Windows", browser: "Chrome", browser_version: "131.0.6778.86", source: "li", referrer: "https://www.linkedin.com/feed/", is_eu: 1, rtt_ms: 12 });
    expect(JSON.stringify(row)).not.toContain("198.51.100.7");

    const log = await clicks("cv");
    expect(log.total).toBe(1);
    expect(log.clicks[0]).toMatchObject({ visitor: "V1", hasIp: false, ip: null, latitude: 50.08804, languages: "cs-CZ,cs;q=0.9,en;q=0.8" });
  });

  it("refuses IP mode until the GDPR warning is accepted, then stores the IP encrypted", async () => {
    await createLink("ip");
    const refused = await setTracking("ip", { mode: "ip" });
    expect(refused.status).toBe(400);
    expect((await refused.json<{ code: string }>()).code).toBe("ack_required");

    const ok = await setTracking("ip", { mode: "ip", acknowledged: true, retentionDays: 7 });
    expect(ok.status).toBe(200);
    const { tracking } = await ok.json<{ tracking: { ackAt: number; ackBy: string; retentionDays: number } }>();
    expect(tracking.ackAt).toBeGreaterThan(0);
    expect(tracking.retentionDays).toBe(7);

    await hit(visit("/ip", { ip: "203.0.113.45" }));
    const row = await env.DB.prepare("SELECT ip_enc, ip_key, at, expires_at FROM tracked_clicks").first<{ ip_enc: string; ip_key: string; at: number; expires_at: number }>();
    expect(row?.ip_enc).toMatch(/^v2:/);
    expect(row?.ip_enc).not.toContain("203.0.113.45");
    expect(row!.expires_at - row!.at).toBe(7 * 86400);

    const log = await clicks("ip");
    expect(log.clicks[0]?.ip).toBe("203.0.113.45");
    expect(log.canSeeIp).toBe(true);

    // The same browser on the same network is the same visitor; another network is a new one.
    await hit(visit("/ip", { ip: "203.0.113.45" }));
    await hit(visit("/ip", { ip: "192.0.2.9" }));
    const again = await clicks("ip");
    expect(again.visitors).toBe(2);
    expect(again.clicks.map((k) => k.visitor).sort()).toEqual(["V1", "V1", "V2"]);
  });

  it("shows IP addresses only to people with the See IP addresses permission", async () => {
    await createLink("ipperm");
    await setTracking("ipperm", { mode: "ip", acknowledged: true });
    await hit(visit("/ipperm", { ip: "203.0.113.45" }));
    await addUser("viewer@example.com", "user", ["clicks.view"]);
    const log = await clicks("ipperm", "viewer@example.com");
    expect(log.clicks[0]).toMatchObject({ ip: null, hasIp: true });
    expect(log.canSeeIp).toBe(false);
    // Nor can they switch IP recording on.
    await addUser("editor@example.com", "user", ["links.edit", "clicks.view"]);
    expect((await setTracking("ipperm", { mode: "ip", acknowledged: true }, "editor@example.com")).status).toBe(403);
    // Without clicks.view there is no click log at all.
    await addUser("stats@example.com", "user", ["stats.view"]);
    expect((await adminCall("stats@example.com", "/links/sh.example/ipperm/clicks")).status).toBe(403);
  });

  it("drops recorded IP addresses when IP mode is switched off", async () => {
    await createLink("drop");
    await setTracking("drop", { mode: "ip", acknowledged: true });
    await hit(visit("/drop"));
    // A full reverse-DNS name can spell the address out: it goes with the address.
    await env.DB.prepare("UPDATE tracked_clicks SET hostname = 'ip-198-51-100-7.dyn.example.net'").run();
    await setTracking("drop", { mode: "details" });
    const row = await env.DB.prepare("SELECT ip_enc, ip_key, hostname, country FROM tracked_clicks").first<Record<string, unknown>>();
    expect(row).toMatchObject({ ip_enc: null, ip_key: null, hostname: "", country: "CZ" });
    await setTracking("drop", null);
    expect(await env.LINKS.get("sh.example/drop", "json")).not.toHaveProperty("tk");
  });

  it("logs bots separately and flags Tor, hosting and relay networks", async () => {
    await createLink("net");
    await setTracking("net", { mode: "details" });
    await hit(visit("/net", { ua: LINKEDIN_BOT }));
    await hit(visit("/net", { cf: { country: "T1", asn: 0 } }));
    await hit(visit("/net", { cf: { asn: 14061, asOrganization: "DigitalOcean" } }));
    await hit(visit("/net", { ua: IPHONE, cf: { asn: 36183, asOrganization: "Akamai" } }));
    const log = await clicks("net");
    // A hosting network counts as a bot, as in the statistics (scanners and preview fetchers live there), and is flagged.
    expect(log.bots).toBe(2);
    const byOrg = (o: string) => log.clicks.find((k) => k.asOrganization === o)!;
    expect(log.clicks.filter((k) => k.event === "bot").map((k) => k.botName).sort()).toEqual(["Datacenter", "LinkedIn"]);
    expect(log.clicks.find((k) => k.country === "T1")?.flags.tor).toBe(true);
    expect(byOrg("DigitalOcean").flags).toMatchObject({ datacenter: true, vpnSuspected: true });
    expect(byOrg("Akamai").flags.privateRelay).toBe(true);
    expect(byOrg("Akamai")).toMatchObject({ os: "iOS", osVersion: "18.1.1", deviceModel: "iPhone", browser: "Safari", browserVersion: "18.1" });
  });

  it("shows people the browser-details page, takes its beacon once, and gives bots the plain redirect", async () => {
    await createLink("bd", "https://example.com/x?a=1&b=<2>");
    await setTracking("bd", { mode: "details", browser: true });

    const bot = await hit(visit("/bd", { ua: LINKEDIN_BOT }));
    expect(bot.status).toBe(302);
    const head = await hit(visit("/bd", { method: "HEAD" }));
    expect(head.status).toBe(302);

    const page = await hit(visit("/bd"));
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'nonce-");
    const html = await page.text();
    expect(html).toContain('content="0;url=https://example.com/x?a=1&#38;b=%3C2%3E"');
    expect(html).not.toContain("<2>");
    const token = /,t=("[^"]+")/.exec(html)?.[1];
    expect(token).toBeTruthy();

    const data = { screen: "1920x1080", viewport: "1200x800", dpr: 2, timezone: "America/New_York", tzOffset: -300, languages: "en-US", platform: "Win32", cores: 8, memory: 8, touch: 0, connection: "4g", colorScheme: "dark", dnt: false, gpc: true, model: "", platformVersion: "15.0.0", fullVersion: "131.0.6778.86", evil: "<script>" };
    const beacon = (t: string) => call(new Request(`${ORIGIN}/_k`, { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.7" }, body: JSON.stringify({ t: JSON.parse(t), d: data }) }));
    expect((await beacon(token!)).status).toBe(204);
    expect((await beacon(token!)).status).toBe(204); // a second report changes nothing
    expect((await beacon('"forged.1.AAAA"')).status).toBe(400);

    const log = await clicks("bd", "", "?event=click");
    const k = log.clicks.find((c) => c.details)!;
    expect(k.details).toMatchObject({ screen: "1920x1080", timezone: "America/New_York", gpc: true });
    expect(k.details).not.toHaveProperty("evil");
    // A browser in New York behind a Prague IP: a VPN hint.
    expect(k.tzMismatch).toBe(true);
    expect(k.flags.vpnSuspected).toBe(true);
    expect(k.osVersion).toBe("11");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_click_details").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("exports CSV, deletes one click or the whole log, and the link's deletion takes its log", async () => {
    await createLink("csv");
    await setTracking("csv", { mode: "details" });
    await hit(visit("/csv"));
    await hit(visit("/csv", { ip: "192.0.2.1" }));
    const res = await adminCall("", "/links/sh.example/csv/clicks.csv");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toContain("time_utc,event,bot,visitor");
    expect(text).toContain("Prague");

    const log = await clicks("csv");
    const one = await adminCall("", `/links/sh.example/csv/clicks/${log.clicks[0]!.id}`, { method: "DELETE" });
    expect(one.status).toBe(200);
    expect((await clicks("csv")).total).toBe(1);

    await hit(visit("/csv"));
    const del = await call(`${API}/links/sh.example/csv`, { method: "DELETE", headers: json({}).headers });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("finds and erases one IP address's clicks across links", async () => {
    await createLink("a1");
    await createLink("a2");
    await setTracking("a1", { mode: "ip", acknowledged: true });
    await setTracking("a2", { mode: "ip", acknowledged: true });
    await hit(visit("/a1", { ip: "2001:DB8::1" }));
    await hit(visit("/a2", { ip: "2001:db8::1" }));
    await hit(visit("/a2", { ip: "192.0.2.50" }));
    const found = await adminCall("", "/clicks/by-ip", { body: { ip: "2001:db8::1" } });
    expect((await found.json<{ clicks: unknown[] }>()).clicks).toHaveLength(2);
    const erased = await adminCall("", "/clicks/by-ip/erase", { body: { ip: "2001:db8::1" } });
    expect(await erased.json()).toEqual({ deleted: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("deletes clicks after their retention", async () => {
    await createLink("old");
    await setTracking("old", { mode: "details", retentionDays: 7 });
    await hit(visit("/old"));
    await pruneTrackedClicks(env.DB, Math.floor(Date.now() / 1000) + 6 * 86400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 1 });
    await pruneTrackedClicks(env.DB, Math.floor(Date.now() / 1000) + 8 * 86400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("queues a webhook for people's clicks only, with no part of the IP address", async () => {
    await env.DB.prepare("INSERT INTO webhooks (url, secret, events, active, created_at, updated_at) VALUES ('https://hooks.example.com/x', 'v2:s:x:y', ?1, 1, 1, 1)").bind(JSON.stringify(["link.tracked_click"])).run();
    await createLink("hook");
    await setTracking("hook", { mode: "ip", acknowledged: true });
    await hit(visit("/hook", { ua: LINKEDIN_BOT }));
    await hit(visit("/hook", { ip: "203.0.113.45" }));
    const { results } = await env.DB.prepare("SELECT payload FROM webhook_deliveries WHERE event_type = 'link.tracked_click'").all<{ payload: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toContain('"ip_recorded":true');
    // Not even its /24: the event needs only See click logs, which is "without IP addresses".
    expect(results[0]!.payload).not.toContain("203.0.113");
    expect(results[0]!.payload).not.toContain("ip_masked");
  });

});

describe("advanced tracking: security", () => {
  it("never republishes a stale tracking setting: KV follows what D1 holds", async () => {
    await createLink("race");
    await setTracking("race", { mode: "ip", acknowledged: true });
    const stale = (await getLink(env.DB, "sh.example", "race"))!;
    // Switched off meanwhile; then an edit saved earlier reaches KV last. It reads D1 back and publishes what D1 holds.
    await setTracking("race", null);
    expect(await publishLatest(env, stale)).toBe("ok");
    expect(await env.LINKS.get("sh.example/race", "json")).not.toHaveProperty("tk");
    // And an edit after the tracking change keeps it.
    await setTracking("race", { mode: "details" });
    const patch = await call(`${API}/links/sh.example/race`, { ...json({ title: "Renamed" }), method: "PATCH" });
    expect(patch.status).toBe(200);
    expect(await env.LINKS.get("sh.example/race", "json")).toMatchObject({ tk: 1 });
  });

  it("keeps tracking through a bulk disable and enable", async () => {
    await createLink("bulk");
    await setTracking("bulk", { mode: "details" });
    for (const action of ["disable", "enable"]) {
      const res = await call(`${API}/links/bulk`, json({ links: [{ domain: "sh.example", slug: "bulk" }], action }));
      expect(res.status).toBe(200);
    }
    expect(await env.LINKS.get("sh.example/bulk", "json")).toMatchObject({ a: 1, tk: 1 });
  });

  it("shows who accepted the GDPR warning only to people who may see click logs", async () => {
    await createLink("ack");
    await setTracking("ack", { mode: "ip", acknowledged: true });
    await addUser("plain@example.com", "user", ["stats.view"]);
    const plain = await (await adminCall("plain@example.com", "/links/sh.example/ack")).json<{ link: { tracking: { mode: string; ackBy: string | null } } }>();
    expect(plain.link.tracking).toMatchObject({ mode: "ip", ackBy: null });
    const owner = await (await adminCall("", "/links/sh.example/ack")).json<{ link: { tracking: { ackBy: string | null } } }>();
    expect(owner.link.tracking.ackBy).toBe("dev@localhost");
  });

  it("deletes a click, and its browser details, only through its own link", async () => {
    await createLink("own");
    await createLink("other");
    await setTracking("own", { mode: "details" });
    await hit(visit("/own"));
    const id = (await clicks("own")).clicks[0]!.id;
    await env.DB.prepare("INSERT INTO tracked_click_details (click_id, data, created_at) VALUES (?1, '{}', 1)").bind(id).run();
    const wrong = await adminCall("", `/links/sh.example/other/clicks/${id}`, { method: "DELETE" });
    expect(wrong.status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_click_details").first<{ n: number }>()).toEqual({ n: 1 });
    expect((await adminCall("", `/links/sh.example/own/clicks/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_click_details").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses a beacon body over 4 KB even without a Content-Length", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ t: "x", d: { languages: "a".repeat(10_000) } }));
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (let i = 0; i < big.length; i += 1000) ctrl.enqueue(big.slice(i, i + 1000));
        ctrl.close();
      },
    });
    const res = await call(new Request(`${ORIGIN}/_k`, { method: "POST", body: stream, headers: { "CF-Connecting-IP": "198.51.100.7" }, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
  });

  it("brakes the beacon and the pixel per network, and the pixel still loads", async () => {
    await createLink("brake");
    await setTracking("brake", { mode: "details", pixel: true });
    const refused = { PUBLIC_LIMITER: { limit: async () => ({ success: false }) } } as unknown as Partial<Env>;
    const beacon = await call(new Request(`${ORIGIN}/_k`, { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.7" }, body: "{}" }), undefined, refused);
    expect(beacon.status).toBe(429);
    const pixel = await call(visit("/_p/brake.gif"), undefined, { CLICKS, ...refused });
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get("Content-Type")).toBe("image/gif");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("brakes tracked clicks per network: past the rate they still redirect, but aren't logged", async () => {
    await createLink("loop");
    await setTracking("loop", { mode: "details" });
    const keys: string[] = [];
    const refused = { PUBLIC_LIMITER: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } } as unknown as Partial<Env>;
    const res = await call(visit("/loop"), undefined, { CLICKS, ...refused });
    expect(res.status).toBe(302);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 0 });
    // Its own scope, so share pages and the pixel don't spend the same budget.
    expect(keys.some((k) => k.startsWith("track:"))).toBe(true);
    // Under the rate, the click is logged as before.
    expect((await hit(visit("/loop"))).status).toBe(302);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("never hands IP addresses to an AI assistant (MCP)", async () => {
    await createLink("mcp");
    await setTracking("mcp", { mode: "ip", acknowledged: true });
    await hit(visit("/mcp", { ip: "203.0.113.45" }));
    const res = await call(`${API}/mcp`, json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "click_log", arguments: { domain: "sh.example", slug: "mcp" } } }, { Accept: "application/json, text/event-stream" }));
    const text = await res.text();
    expect(text).toContain("Prague");
    expect(text).not.toContain("203.0.113.45");
  });

  it("finds tracked links through a partial index (the daily list refresh and rule changes)", async () => {
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT tracking FROM links WHERE tracking IS NOT NULL").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("links_tracked");
  });
});

describe("tracking helpers", () => {
  it("reads versions and models from user agents", () => {
    expect(browserVersion(CHROME, "Chrome")).toBe("131.0.6778.86");
    expect(osVersion(CHROME, "Windows", null)).toBe("10 or 11");
    expect(osVersion(CHROME, "Windows", '"15.0.0"')).toBe("11");
    expect(osVersion(IPHONE, "iOS", null)).toBe("18.1.1");
    expect(deviceModel("Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007) AppleWebKit/537.36", null)).toBe("SM-S918B");
    expect(deviceModel("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36", null)).toBe("");
    expect(deviceModel(CHROME, '"Pixel 8"')).toBe("Pixel 8");
  });

  it("signs beacons for a few minutes only", async () => {
    const now = 1_700_000_000;
    const t = await signBeacon("secret-0123456789", "abcdefghijklmnop", now);
    expect(await verifyBeacon("secret-0123456789", t, now + 30)).toBe("abcdefghijklmnop");
    expect(await verifyBeacon("secret-0123456789", t, now + 3600)).toBeNull();
    expect(await verifyBeacon("other-secret-0123", t, now + 30)).toBeNull();
  });

  it("cleans browser details and compares time zones by offset", () => {
    const d = cleanDetails({ screen: "10x10", timezone: "Europe/Berlin", tzOffset: 60, connection: "fiber", cores: 1e9 }, 1)!;
    expect(d).toMatchObject({ screen: "10x10", connection: "", cores: null });
    const winter = Date.UTC(2026, 0, 15) / 1000;
    expect(tzMismatch({ timezone: "Europe/Prague", at: winter }, d)).toBe(false);
    expect(tzMismatch({ timezone: "Europe/London", at: winter }, d)).toBe(true);
  });
});

describe("advanced tracking: email pixel, reverse DNS, VPN lists", () => {
  afterEach(() => vi.restoreAllMocks());

  const GMAIL = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
  const OUTLOOK = "Mozilla/4.0 (compatible; ms-office; MSOffice 16)";

  it("serves a transparent GIF and records an open only for a live tracked link", async () => {
    await createLink("mail");
    await createLink("untracked");
    await setTracking("mail", { mode: "details", pixel: true });
    const { points, CLICKS: sink } = captureClicks();
    for (const path of ["/_p/mail.gif", "/_p/mail", "/_p/untracked.gif", "/_p/nope.gif", "/_p/%E0%A4%A.gif"]) {
      const res = await call(visit(path), undefined, { CLICKS: sink });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/gif");
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect((await res.arrayBuffer()).byteLength).toBe(43);
    }
    // Opens are not clicks: nothing in the statistics.
    expect(points).toHaveLength(0);
    const log = await clicks("mail");
    expect(log).toMatchObject({ opens: 2, people: 0 });
    expect(log.clicks.every((k) => k.event === "open")).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks WHERE slug = 'untracked'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("tells mail-service proxies and mail clients from scanners", async () => {
    await createLink("px");
    await setTracking("px", { mode: "details", pixel: true });
    await hit(visit("/_p/px.gif", { ua: GMAIL, cf: { asn: 15169, asOrganization: "Google" } }));
    await hit(visit("/_p/px.gif", { ua: OUTLOOK }));
    await hit(visit("/_p/px.gif", { ua: "curl/8.0" }));
    const log = await clicks("px");
    expect(log).toMatchObject({ opens: 2, bots: 1 });
    expect(log.clicks.find((k) => k.botName === "Gmail image proxy")?.event).toBe("open");
    expect(log.clicks.find((k) => k.userAgent === OUTLOOK)?.event).toBe("open");
    expect(log.clicks.find((k) => k.userAgent === "curl/8.0")?.event).toBe("bot");
  });

  it("counts a pixel loaded by a web page, or Office from Microsoft's network, as a bot", async () => {
    await createLink("emb");
    await setTracking("emb", { mode: "details", pixel: true });
    await hit(visit("/_p/emb.gif", { headers: { Referer: "https://forum.example.org/thread/1" } }));
    await hit(visit("/_p/emb.gif", { headers: { Referer: "https://email.seznam.cz/" } }));
    await hit(visit("/_p/emb.gif", { ua: OUTLOOK, cf: { asn: 8075, asOrganization: "Microsoft" } }));
    const log = await clicks("emb");
    expect(log).toMatchObject({ opens: 1, bots: 2 });
    expect(log.clicks.map((k) => k.botName).sort()).toEqual(["", "Email scanner", "Embedded on forum.example.org"].sort());
  });

  it("refuses a VPN list that is far too big", async () => {
    const huge = vi.fn(async () => new Response("AS1 # x\n".repeat(60_000)));
    await expect(refreshNetworkLists(env, huge as unknown as typeof fetch)).rejects.toThrow(/larger than/);
  });

  it("sends an open through the webhook as its own event kind", async () => {
    await env.DB.prepare("INSERT INTO webhooks (url, secret, events, active, created_at, updated_at) VALUES ('https://hooks.example.com/x', 'v2:s:x:y', ?1, 1, 1, 1)").bind(JSON.stringify(["link.tracked_click"])).run();
    await createLink("hookopen");
    await setTracking("hookopen", { mode: "details", pixel: true });
    await hit(visit("/_p/hookopen.gif", { ua: GMAIL }));
    const row = await env.DB.prepare("SELECT payload FROM webhook_deliveries").first<{ payload: string }>();
    expect(JSON.parse(row!.payload).data).toMatchObject({ event: "open", via: "Gmail image proxy" });
  });

  it("builds PTR names and keeps only the domain without IP addresses", () => {
    expect(ptrName("203.0.113.45")).toBe("45.113.0.203.in-addr.arpa");
    expect(ptrName("2001:db8::1")).toBe(`1.${"0.".repeat(23)}8.b.d.0.1.0.0.2.ip6.arpa`);
    expect(ptrName("999.1.1.1")).toBeNull();
    expect(ptrName("not-an-ip")).toBeNull();
    expect(hostDomain("ip-203-0-113-45.dyn.example.net")).toBe("example.net");
    expect(hostDomain("45.113.0.203.broadband.o2.co.uk")).toBe("o2.co.uk");
    expect(hostDomain("mail.firma.cz")).toBe("firma.cz");
  });

  /** A resolver that answers PTR with `ptr` and A/AAAA of that name with `back`. */
  const resolver = (ptr: string, back: { type: number; data: string }[]) =>
    vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      return Response.json({ Answer: u.searchParams.get("type") === "PTR" ? [{ type: 12, data: ptr }] : back });
    });

  it("asks 1.1.1.1 for the reverse name, keeps it only when it resolves back, and gives up quietly", async () => {
    const ok = resolver("gw.firma.cz.", [{ type: 1, data: "203.0.113.45" }]);
    expect(await reverseDns("203.0.113.45", ok as unknown as typeof fetch)).toBe("gw.firma.cz");
    expect(String(ok.mock.calls[0]![0])).toContain("name=45.113.0.203.in-addr.arpa&type=PTR");
    expect(String(ok.mock.calls[1]![0])).toContain("name=gw.firma.cz&type=A");
    // Anyone who runs an address can claim any name in its PTR record: unconfirmed, it's dropped.
    const spoof = resolver("mail.google.com.", [{ type: 1, data: "142.250.1.1" }]);
    expect(await reverseDns("203.0.113.45", spoof as unknown as typeof fetch)).toBe("");
    const v6 = resolver("host.example.net.", [{ type: 28, data: "2001:db8:0:0:0:0:0:1" }]);
    expect(await reverseDns("2001:DB8::1", v6 as unknown as typeof fetch)).toBe("host.example.net");
    const bad = vi.fn(async () => Response.json({ Answer: [{ type: 12, data: "<script>.example" }] }));
    expect(await reverseDns("203.0.113.45", bad as unknown as typeof fetch)).toBe("");
    const fail = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await reverseDns("203.0.113.45", fail as unknown as typeof fetch)).toBe("");
  });

  it("stores the whole host name only in IP mode, and looks people up, not bots", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      Response.json({ Answer: new URL(String(url)).searchParams.get("type") === "PTR" ? [{ type: 12, data: "ip-203-0-113-45.dyn.example.net." }] : [{ type: 1, data: "198.51.100.7" }] }),
    );
    const net = { TRACKING_NET: "" };
    await createLink("hd");
    await createLink("hi");
    await setTracking("hd", { mode: "details" });
    await setTracking("hi", { mode: "ip", acknowledged: true });
    await call(visit("/hd"), undefined, { CLICKS, ...net });
    await call(visit("/hi"), undefined, { CLICKS, ...net });
    const before = spy.mock.calls.length;
    await call(visit("/hd", { ua: LINKEDIN_BOT }), undefined, { CLICKS, ...net });
    expect(spy.mock.calls.length).toBe(before);
    expect((await clicks("hd", "", "?event=click")).clicks[0]?.hostname).toBe("example.net");
    expect((await clicks("hi")).clicks[0]?.hostname).toBe("ip-203-0-113-45.dyn.example.net");
  });

  it("downloads the VPN and hosting lists and flags clicks from them", async () => {
    expect(parseAsnList("AS9009 # M247, GB (NordVPN)\n# comment\nAS209854 # Surfshark\nnot a line")).toEqual([
      [9009, "M247, GB (NordVPN)"],
      [209854, "Surfshark"],
    ]);
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      new Response(String(url) === NETWORK_LIST_URLS.vpn ? "AS9009 # M247, GB (NordVPN)\n" : "AS64500 # Example hosting\nAS36183 # Akamai\n"),
    );
    expect(await refreshNetworkLists(env, fetcher as unknown as typeof fetch)).toBe(true);
    await createLink("vpn");
    await setTracking("vpn", { mode: "details" });
    await hit(visit("/vpn", { cf: { asn: 9009, asOrganization: "M247" } }));
    await hit(visit("/vpn", { cf: { asn: 64500, asOrganization: "Example hosting" } }));
    await hit(visit("/vpn", { ua: IPHONE, cf: { asn: 36183, asOrganization: "Akamai" } }));
    const log = await clicks("vpn");
    const by = (o: string) => log.clicks.find((k) => k.asOrganization === o)!;
    expect(by("M247").flags).toMatchObject({ knownVpn: "M247, GB (NordVPN)", vpnSuspected: true });
    expect(by("Example hosting").flags).toMatchObject({ datacenter: true, knownVpn: "" });
    // Akamai is on the hosting list, but iCloud Private Relay leaves through it: a relay, not a datacenter.
    expect(by("Akamai").flags).toMatchObject({ datacenter: false, privateRelay: true });
  });

  it("keeps the old lists when a download fails", async () => {
    const good = vi.fn(async () => new Response("AS9009 # NordVPN\n"));
    await refreshNetworkLists(env, good as unknown as typeof fetch);
    const broken = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(refreshNetworkLists(env, broken as unknown as typeof fetch)).rejects.toThrow();
    const stored = await env.DB.prepare("SELECT value FROM settings WHERE key = 'tracking_network_lists'").first<{ value: string }>();
    expect(stored?.value).toContain("9009");
  });
});

describe("advanced tracking: workspace rules", () => {
  const putPolicy = (body: unknown, email = "") => adminCall(email, "/tracking/policy", { method: "PUT", body });

  it("starts cautious: IP addresses off, a purpose required, 90 days at most", async () => {
    resetTrackingPolicy();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'tracking_policy'").run();
    const { policy } = await (await adminCall("", "/tracking/policy")).json<{ policy: Record<string, unknown> }>();
    expect(policy).toEqual({ enabled: true, allowIp: false, allowBrowser: true, allowPixel: true, maxRetentionDays: 90, requirePurpose: true });
    await createLink("c1");
    expect((await setTracking("c1", { mode: "ip", acknowledged: true })).status).toBe(400);
    expect((await setTracking("c1", { mode: "details", retentionDays: 365 })).status).toBe(400);
    const noPurpose = await adminCall("", "/links/sh.example/c1/tracking", { method: "PUT", body: { mode: "details" } });
    expect(noPurpose.status).toBe(400);
    expect((await noPurpose.json<{ code: string }>()).code).toBe("purpose_required");
    const ok = await setTracking("c1", { mode: "details" });
    expect(ok.status).toBe(200);
    expect((await ok.json<{ tracking: { purpose: string; retentionDays: number } }>()).tracking).toMatchObject({ purpose: "Follow-up with one candidate", retentionDays: 30 });
  });

  it("lets only admins change the rules, from a signed-in session", async () => {
    await addUser("manager@example.com", "manager", ["links.edit", "clicks.view", "clicks.ip", "settings.manage"]);
    expect((await putPolicy(OPEN_POLICY, "manager@example.com")).status).toBe(403);
    expect((await call(`${API}/tracking/policy`, { ...json(OPEN_POLICY), method: "PUT" })).status).toBe(403);
    expect((await putPolicy({ ...OPEN_POLICY, maxRetentionDays: 12 })).status).toBe(400);
  });

  it("brings links within tightened rules at once and drops what they no longer allow", async () => {
    await createLink("t1");
    await setTracking("t1", { mode: "ip", acknowledged: true, browser: true, pixel: true, retentionDays: 365 });
    await hit(visit("/t1", { ua: LINKEDIN_BOT, ip: "203.0.113.45" }));
    await env.DB.prepare("INSERT INTO tracked_click_details (click_id, data, created_at) VALUES ('x', '{}', 1)").run();
    const res = await putPolicy({ ...OPEN_POLICY, allowIp: false, allowBrowser: false, allowPixel: false, maxRetentionDays: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: 1, republishPending: 0 });
    const kv = await env.LINKS.get<Record<string, unknown>>("sh.example/t1", "json");
    expect(kv).toMatchObject({ tk: 1, tr: 30 });
    expect(kv).not.toHaveProperty("tj");
    expect(kv).not.toHaveProperty("tp");
    const row = await env.DB.prepare("SELECT ip_enc, expires_at - at AS kept FROM tracked_clicks").first<{ ip_enc: string | null; kept: number }>();
    expect(row).toEqual({ ip_enc: null, kept: 30 * 86400 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_click_details").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("checks the rules again on every click, whatever the published record says", async () => {
    await createLink("t2");
    await setTracking("t2", { mode: "ip", acknowledged: true, browser: true, pixel: true });
    // The rules change, but this link's KV record isn't republished yet.
    await saveTrackingPolicy(env, { ...OPEN_POLICY, allowIp: false, allowBrowser: false, allowPixel: false });
    const res = await hit(visit("/t2", { ip: "203.0.113.45" }));
    expect(res.status).toBe(302);
    await hit(visit("/_p/t2.gif"));
    const rows = await env.DB.prepare("SELECT event, ip_enc FROM tracked_clicks").all<{ event: string; ip_enc: string | null }>();
    expect(rows.results).toEqual([{ event: "click", ip_enc: null }]);
    // Switched off for the workspace: nothing is recorded at all.
    await saveTrackingPolicy(env, { ...OPEN_POLICY, enabled: false });
    await hit(visit("/t2"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 1 });
    expect((await setTracking("t2", { mode: "details" })).status).toBe(403);
    expect((await setTracking("t2", null)).status).toBe(200);
  });

  it("switches tracking on when a link is created, with the same rules as the tracking route", async () => {
    const create = (slug: string, tracking: unknown, email = "") => adminCall(email, "/links", { body: { slug, target: "https://example.com/page", tracking } });
    const res = await create("born", { mode: "details", pixel: true, notify: "first", purpose: "Follow-up with one candidate" });
    expect(res.status).toBe(201);
    const { link } = await res.json<{ link: { tracking: Record<string, unknown> } }>();
    expect(link.tracking).toMatchObject({ mode: "details", pixel: true, notify: "first", retentionDays: 30, purpose: "Follow-up with one candidate", ackAt: null });
    expect(await env.LINKS.get("sh.example/born", "json")).toMatchObject({ tk: 1, tr: 30, tn: 1, tp: 1 });
    await hit(visit("/born"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks WHERE slug = 'born'").first<{ n: number }>()).toEqual({ n: 1 });

    // Refused as a whole: no link is left behind without the tracking asked for.
    const noPurpose = await create("born2", { mode: "details" });
    expect(noPurpose.status).toBe(400);
    expect((await noPurpose.json<{ code: string }>()).code).toBe("purpose_required");
    const noAck = await create("born3", { mode: "ip", purpose: "Follow-up with one candidate" });
    expect((await noAck.json<{ code: string }>()).code).toBe("ack_required");
    const ip = await create("born4", { mode: "ip", acknowledged: true, purpose: "Follow-up with one candidate" });
    expect(ip.status).toBe(201);
    expect((await ip.json<{ link: { tracking: { ackAt: number | null } } }>()).link.tracking.ackAt).toBeTypeOf("number");
    for (const slug of ["born2", "born3"]) expect(await getLink(env.DB, "sh.example", slug)).toBeNull();

    // Creating links isn't enough: tracking needs See click logs, and IP addresses See IP addresses.
    await addUser("creator@example.com", "user", ["links.create"]);
    expect((await create("born5", { mode: "details", purpose: "Follow-up with one candidate" }, "creator@example.com")).status).toBe(403);
    await addUser("viewer@example.com", "user", ["links.create", "clicks.view"]);
    expect((await create("born6", { mode: "ip", acknowledged: true, purpose: "Follow-up with one candidate" }, "viewer@example.com")).status).toBe(403);
    expect((await create("born7", { mode: "details", purpose: "Follow-up with one candidate" }, "viewer@example.com")).status).toBe(201);

    await putPolicy({ ...OPEN_POLICY, enabled: false });
    expect((await create("born8", { mode: "details", purpose: "Follow-up with one candidate" })).status).toBe(403);
    expect((await create("born9", null)).status).toBe(201);
  });

  it("records pixel opens only where the pixel was switched on for the link", async () => {
    await createLink("nopx");
    await setTracking("nopx", { mode: "details" });
    await hit(visit("/_p/nopx.gif"));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

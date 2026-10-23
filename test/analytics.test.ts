import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDataPoint,
  classify,
  daySaltFor,
  detectBot,
  detectBrowser,
  detectDevice,
  detectOs,
  primaryLanguage,
  pruneDaySalts,
  referrerHostOf,
  resetDaySaltCache,
  resolveSource,
  siteHostOf,
  truncateUtf8,
  visitorHash,
} from "../src/worker/analytics";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const LINKEDIN_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CUBOT_PHONE =
  "Mozilla/5.0 (Linux; Android 12; CUBOT X50) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const req = (headers: Record<string, string> = {}, method = "GET") => new Request("https://sh.example/x", { method, headers });

describe("bot detection", () => {
  it("names link-preview bots", () => {
    expect(detectBot(req(), "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", 0)).toBe("LinkedIn");
    expect(detectBot(req(), "facebookexternalhit/1.1 Facebot Twitterbot/1.0", 0)).toBe("Facebook");
    expect(detectBot(req(), "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", 0)).toBe("Slack");
    expect(detectBot(req(), "WhatsApp/2.23.20.0 A", 0)).toBe("WhatsApp");
    expect(detectBot(req(), "TelegramBot (like TwitterBot)", 0)).toBe("Telegram");
  });

  it("flags scripts, empty UAs, HEAD, prefetch and datacenters", () => {
    expect(detectBot(req(), "curl/8.4.0", 0)).toBe("HTTP client");
    expect(detectBot(req(), "", 0)).toBe("No user agent");
    expect(detectBot(req({}, "HEAD"), MAC_CHROME, 0)).toBe("HEAD request");
    expect(detectBot(req({ "Sec-Purpose": "prefetch;prerender" }), MAC_CHROME, 0)).toBe("Prefetch");
    expect(detectBot(req(), MAC_CHROME, 16509)).toBe("Datacenter");
    expect(detectBot(req(), MAC_CHROME, 9009)).toBe("Datacenter");
    expect(detectBot(req(), "shorthop-check/1", 0)).toBe("Monitor");
  });

  it("does not flag real browsers, CUBOT phones or iCloud Private Relay", () => {
    expect(detectBot(req(), IPHONE_SAFARI, 0)).toBe("");
    expect(detectBot(req(), CUBOT_PHONE, 0)).toBe("");
    expect(detectBot(req(), IPHONE_SAFARI, 13335)).toBe("");
    expect(detectBot(req(), IPHONE_SAFARI, 36183)).toBe("");
  });
});

describe("device, OS, browser", () => {
  it("parses common user agents", () => {
    expect(detectDevice(IPHONE_SAFARI, null)).toBe("mobile");
    expect(detectDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", null)).toBe("tablet");
    expect(detectDevice(MAC_CHROME, null)).toBe("desktop");
    expect(detectDevice(MAC_CHROME, "?1")).toBe("mobile");
    expect(detectOs(IPHONE_SAFARI, null)).toBe("iOS");
    expect(detectOs(MAC_CHROME, '"macOS"')).toBe("macOS");
    expect(detectOs("x", '"Windows"')).toBe("Windows");
    expect(detectBrowser(IPHONE_SAFARI)).toBe("Safari");
    expect(detectBrowser(MAC_CHROME)).toBe("Chrome");
    expect(detectBrowser(LINKEDIN_APP)).toBe("LinkedIn app");
  });
});

describe("source attribution", () => {
  it("prefers the explicit tag, then QR, then in-app UA, then referrer", () => {
    expect(resolveSource("LI", false, MAC_CHROME, "")).toEqual({ source: "li", kind: "tag" });
    expect(resolveSource("bad tag!", true, MAC_CHROME, "")).toEqual({ source: "qr", kind: "tag" });
    expect(resolveSource(null, false, LINKEDIN_APP, "")).toEqual({ source: "li", kind: "inferred" });
    expect(resolveSource(null, false, MAC_CHROME, "lnkd.in")).toEqual({ source: "li", kind: "inferred" });
    expect(resolveSource(null, false, MAC_CHROME, "google.co.uk")).toEqual({ source: "google", kind: "inferred" });
    expect(resolveSource(null, false, MAC_CHROME, "blog.example.com")).toEqual({ source: "referral", kind: "inferred" });
    expect(resolveSource(null, false, MAC_CHROME, "")).toEqual({ source: "direct", kind: "none" });
  });

  it("counts referrals from the FALLBACK_URL host and its subdomains as the owner's site", () => {
    expect(siteHostOf({ FALLBACK_URL: "https://www.Owner.example/blog" } as Env)).toBe("owner.example");
    expect(siteHostOf({ FALLBACK_URL: "not a url" } as Env)).toBe("");
    expect(resolveSource(null, false, MAC_CHROME, "owner.example", "owner.example")).toEqual({ source: "site", kind: "inferred" });
    expect(resolveSource(null, false, MAC_CHROME, "blog.owner.example", "owner.example")).toEqual({ source: "site", kind: "inferred" });
    expect(resolveSource(null, false, MAC_CHROME, "notowner.example", "owner.example")).toEqual({ source: "referral", kind: "inferred" });
    expect(resolveSource("nl", false, MAC_CHROME, "owner.example", "owner.example")).toEqual({ source: "nl", kind: "tag" });
    // A fallback on a known platform (a profile page) doesn't swallow that platform's referrals.
    expect(resolveSource(null, false, MAC_CHROME, "linkedin.com", "linkedin.com")).toEqual({ source: "li", kind: "inferred" });
  });

  it("keeps only real hostnames as the referrer", () => {
    expect(referrerHostOf("https://www.Google.com/search?q=x", "sh.example")).toBe("google.com");
    expect(referrerHostOf("https://news.example.com./", "sh.example")).toBe("news.example.com");
    expect(referrerHostOf("http://203.0.113.7:8080/", "sh.example")).toBe("203.0.113.7");
    expect(referrerHostOf("https://sh.example/other", "sh.example")).toBe("");
    // The rollup's fold value must never arrive as a real referrer.
    for (const r of ["http://(other)/", "http://localhost:3000/", "http://[::1]/", "android-app:", "not a url", "http://a_b.example/"]) {
      expect(referrerHostOf(r, "sh.example"), r).toBe("");
    }
  });

  it("reads the primary language", () => {
    expect(primaryLanguage("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr-fr");
    expect(primaryLanguage("*")).toBe("");
    expect(primaryLanguage(null)).toBe("");
  });
});

describe("data point", () => {
  it("writes the documented data point layout", async () => {
    const request = new Request("https://sh.example/guide?s=nl", {
      headers: { "User-Agent": IPHONE_SAFARI, Referer: "https://www.linkedin.com/feed/", "Accept-Language": "en-US" },
    });
    const url = new URL(request.url);
    const c = classify(request, url, "nl", false);
    const p = buildDataPoint(request, c, { domain: "sh.example", slug: "guide", kind: "hit", sourceTag: "nl", qr: false }, "abcd1234abcd1234");
    expect(p.indexes).toEqual(["guide"]);
    expect(p.blobs).toHaveLength(18);
    expect(p.blobs?.[16]).toBe("sh.example");
    expect(p.blobs?.[17]).toBe(""); // route: smart-routed links only
    expect(p.blobs?.[0]).toBe("click");
    expect(p.blobs?.[7]).toBe("mobile");
    expect(p.blobs?.[10]).toBe("linkedin.com");
    expect(p.blobs?.[11]).toBe("nl");
    expect(p.blobs?.[12]).toBe("en-us");
    expect(p.blobs?.[14]).toBe("abcd1234abcd1234");
    expect(p.blobs?.[15]).toBe("tag");
    expect(p.doubles).toEqual([1, 0, 0]);
  });

  it("caps the index at 96 bytes without splitting characters", () => {
    const s = "ž".repeat(60);
    const t = truncateUtf8(s, 96);
    expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(96);
    expect(t).toBe("ž".repeat(48));
  });

  it("hashes visitors per day", async () => {
    const a = await visitorHash("1.2.3.4", "ua", "2026-10-19", "salt");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await visitorHash("1.2.3.4", "ua", "2026-10-19", "salt")).toBe(a);
    expect(await visitorHash("1.2.3.4", "ua", "2026-10-20", "salt")).not.toBe(a);
  });
});

describe("day salts", () => {
  const stored = async (date: string) =>
    (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`visitor_salt:${date}`).first<{ value: string }>())?.value;

  beforeEach(async () => {
    resetDaySaltCache();
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'visitor_salt:%'").run();
  });

  it("creates one random salt per day and shares it through D1", async () => {
    const a = await daySaltFor(env.DB, "2026-10-19");
    expect(a).toBe(await stored("2026-10-19"));
    // Another isolate (no memory of it) reads the same salt.
    resetDaySaltCache();
    expect(await daySaltFor(env.DB, "2026-10-19")).toBe(a);
    expect(await daySaltFor(env.DB, "2026-10-20")).not.toBe(a);
  });

  it("deletes the salts of finished days", async () => {
    await daySaltFor(env.DB, "2026-10-19");
    await daySaltFor(env.DB, "2026-10-20");
    await pruneDaySalts(env.DB, "2026-10-20");
    expect(await stored("2026-10-19")).toBeUndefined();
    expect(await stored("2026-10-20")).toBeDefined();
  });

  it("uses a salt that is never stored when D1 fails", async () => {
    const broken = { batch: async () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    const a = await daySaltFor(broken, "2026-10-19");
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(await daySaltFor(broken, "2026-10-19")).toBe(a);
    expect(await stored("2026-10-19")).toBeUndefined();
  });
});

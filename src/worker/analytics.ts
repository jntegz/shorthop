// Click classification and the Analytics Engine data point layout.
// Everything here runs inside ctx.waitUntil, after the redirect has been sent.

import { HOSTNAME_RE } from "../shared/domains";
import { getMissPolicy, hasLinkIgnoringCase } from "./misses";

export type HitEvent = "click" | "bot" | "miss";

/** Ordered: the first matching pattern names the bot. */
const BOT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["LinkedIn", /LinkedInBot/i],
  ["Facebook", /facebookexternalhit|facebookcatalog|Facebot|meta-externalagent|meta-externalfetcher/i],
  // Telegram and Discord mention "TwitterBot" in their UAs, so they go first.
  ["Telegram", /TelegramBot/i],
  ["Discord", /Discordbot/i],
  ["WhatsApp", /WhatsApp/i],
  ["Slack", /Slackbot|Slack-ImgProxy/i],
  ["X/Twitter", /Twitterbot/i],
  ["Skype/Teams", /SkypeUriPreview|MicrosoftPreview/i],
  ["Pinterest", /Pinterest(bot)?\//i],
  ["Reddit", /redditbot/i],
  ["Apple", /Applebot/i],
  ["Google", /Googlebot|Google-InspectionTool|GoogleOther|Google-Read-Aloud|APIs-Google|FeedFetcher-Google|Google-PageRenderer|Storebot-Google|Google-Safety|GoogleImageProxy/i],
  ["Bing", /bingbot|BingPreview|msnbot|adidxbot/i],
  ["Yandex", /YandexBot|YandexMobileBot|YandexImages/i],
  ["Baidu", /Baiduspider/i],
  ["DuckDuckGo", /DuckDuckBot|DuckAssistBot/i],
  ["AI crawler", /GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|PerplexityBot|Perplexity-User|CCBot|Amazonbot|cohere-ai|Diffbot|YouBot|Bytespider|Google-Extended/i],
  ["SEO crawler", /AhrefsBot|SemrushBot|MJ12bot|DotBot|PetalBot|DataForSeoBot|serpstatbot|BLEXBot|Screaming Frog|SeznamBot/i],
  ["Email scanner", /Proofpoint|Mimecast|Barracuda|Symantec|Forcepoint|Trend ?Micro|IronPort|FireEye|SafeLinks|Microsoft Office|MSOffice|ms-office|Outlook-iOS|Microsoft Outlook/i],
  ["Monitor", /UptimeRobot|Pingdom|StatusCake|Site24x7|Better ?Uptime|Checkly|shorthop-check/i],
  ["HTTP client", /^curl\/|Wget|python-requests|python-urllib|python-httpx|aiohttp|Go-http-client|node-fetch|undici|axios|okhttp|^Java\/|Apache-HttpClient|libwww-perl|^Ruby|^PHP\/|Guzzle|Scrapy|HeadlessChrome|PhantomJS|Puppeteer|Playwright|PostmanRuntime|insomnia/i],
  ["Other bot", /\bbot\b|[a-z]bot\/|crawler|spider|slurp|\bpreview\b|fetcher/i],
];

/**
 * Hosting and cloud networks: humans rarely click from these, scanners and
 * preview fetchers do. Cloudflare (13335) and Akamai (36183) are left out on
 * purpose, because iCloud Private Relay exits through them.
 */
const DATACENTER_ASNS: ReadonlySet<number> = new Set([
  16509, 14618, // AWS
  8075, // Microsoft / Azure (also Safe Links scanners)
  15169, 396982, // Google / GCP
  14061, // DigitalOcean
  24940, // Hetzner
  16276, // OVH
  63949, // Linode / Akamai Cloud
  20473, // Vultr
  31898, // Oracle Cloud
  45102, // Alibaba Cloud
  132203, // Tencent Cloud
  12876, // Scaleway
  51167, // Contabo
  37963, // Alibaba Cloud (China)
  45090, // Tencent Cloud (China)
  9009, // M247
  60781, 28753, // Leaseweb
  212238, // Datacamp / CDN77
  47583, // Hostinger
  8560, // IONOS
  197540, // netcup
  36352, // ColoCrossing
  53667, // FranTech / BuyVM
  62240, // Clouvider
  202425, // IP Volume
  398324, // Censys
]);

export interface Classification {
  isBot: boolean;
  botName: string;
  device: string;
  os: string;
  browser: string;
  referrerHost: string;
  source: string;
  sourceKind: "tag" | "inferred" | "none";
  language: string;
}

export function detectBot(request: Request, ua: string, asn: number): string {
  if (!ua) return "No user agent";
  if (request.method === "HEAD") return "HEAD request";
  const purpose = request.headers.get("Sec-Purpose") ?? request.headers.get("Purpose") ?? "";
  if (/prefetch|prerender/i.test(purpose)) return "Prefetch";
  for (const [name, re] of BOT_PATTERNS) if (re.test(ua)) return name;
  if (DATACENTER_ASNS.has(asn)) return "Datacenter";
  return "";
}

export function detectDevice(ua: string, chMobile: string | null): string {
  if (/iPad|Tablet|Kindle|Silk\/|PlayBook/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (chMobile === "?1" || /Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return "mobile";
  return "desktop";
}

const CH_PLATFORMS: Record<string, string> = {
  android: "Android",
  windows: "Windows",
  macos: "macOS",
  ios: "iOS",
  linux: "Linux",
  "chrome os": "ChromeOS",
  chromeos: "ChromeOS",
};

export function detectOs(ua: string, chPlatform: string | null): string {
  if (chPlatform) {
    const p = CH_PLATFORMS[chPlatform.replaceAll('"', "").trim().toLowerCase()];
    if (p) return p;
  }
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Other";
}

export function detectBrowser(ua: string): string {
  if (/LinkedInApp/i.test(ua)) return "LinkedIn app";
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return "Facebook app";
  if (/Instagram/.test(ua)) return "Instagram app";
  if (/Twitter for|TwitterAndroid/i.test(ua)) return "X app";
  if (/ GSA\//.test(ua)) return "Google app";
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox\/|FxiOS/.test(ua)) return "Firefox";
  if (/CriOS|Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  if (/AppleWebKit/.test(ua) && /Mobile\//.test(ua)) return "iOS in-app";
  return "Other";
}

const REFERRER_SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "li"],
  [/^t\.co$|(^|\.)x\.com$|(^|\.)twitter\.com$/, "x"],
  [/(^|\.)facebook\.com$|^fb\.me$/, "fb"],
  [/(^|\.)instagram\.com$/, "ig"],
  [/(^|\.)threads\.(net|com)$/, "threads"],
  [/(^|\.)bsky\.app$/, "bsky"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "yt"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/^news\.ycombinator\.com$/, "hn"],
  [/^mail\.google\.com$|^outlook\.(live|office|office365)\.com$|(^|\.)mail\.yahoo\.com$/, "email"],
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)duckduckgo\.com$/, "ddg"],
];

/** Host of FALLBACK_URL without "www.": referrals from it count as the owner's own site. */
export function siteHostOf(env: Env): string {
  try {
    return new URL(env.FALLBACK_URL).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sanitizeSourceTag(tag: string | null): string {
  if (!tag) return "";
  const t = tag.trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(t) ? t : "";
}

export function resolveSource(
  sourceTag: string | null,
  qr: boolean,
  ua: string,
  referrerHost: string,
  siteHost = "",
): { source: string; kind: Classification["sourceKind"] } {
  const tag = sanitizeSourceTag(sourceTag);
  if (tag) return { source: tag, kind: "tag" };
  if (qr) return { source: "qr", kind: "tag" };
  if (/LinkedInApp/i.test(ua)) return { source: "li", kind: "inferred" };
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return { source: "fb", kind: "inferred" };
  if (/Instagram/.test(ua)) return { source: "ig", kind: "inferred" };
  if (/Twitter for|TwitterAndroid/i.test(ua)) return { source: "x", kind: "inferred" };
  if (referrerHost) {
    for (const [re, src] of REFERRER_SOURCES) if (re.test(referrerHost)) return { source: src, kind: "inferred" };
    // After the known platforms, so a FALLBACK_URL on one (a profile page) doesn't swallow its referrals.
    if (siteHost && (referrerHost === siteHost || referrerHost.endsWith(`.${siteHost}`))) return { source: "site", kind: "inferred" };
    return { source: "referral", kind: "inferred" };
  }
  return { source: "direct", kind: "none" };
}

/** The referring site's host without "www.", or "" for our own host and anything that isn't a DNS name or IPv4 address. */
export function referrerHostOf(referer: string | null, ownHost: string): string {
  if (!referer) return "";
  try {
    const host = new URL(referer).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    // Only real hostnames: "(other)" is a valid URL host, but the rollup folds long tails into a value of that name.
    return host === ownHost || !HOSTNAME_RE.test(host) ? "" : host;
  } catch {
    return "";
  }
}

export function primaryLanguage(header: string | null): string {
  if (!header) return "";
  const first = header.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/.test(first) && first !== "*" ? first.slice(0, 16) : "";
}

export function classify(request: Request, url: URL, sourceTag: string | null, qr: boolean, siteHost = ""): Classification {
  const ua = request.headers.get("User-Agent") ?? "";
  const asn = Number(cfOf(request)?.asn ?? 0);
  const botName = detectBot(request, ua, asn);
  const referrerHost = referrerHostOf(request.headers.get("Referer"), url.hostname);
  const { source, kind } = resolveSource(sourceTag, qr, ua, referrerHost, siteHost);
  return {
    isBot: botName !== "",
    botName,
    device: botName ? "bot" : detectDevice(ua, request.headers.get("Sec-CH-UA-Mobile")),
    os: detectOs(ua, request.headers.get("Sec-CH-UA-Platform")),
    browser: detectBrowser(ua),
    referrerHost,
    source,
    sourceKind: kind,
    language: primaryLanguage(request.headers.get("Accept-Language")),
  };
}

/** SHA-256 of IP, UA, UTC date and a secret salt; first 16 hex chars. */
export async function visitorHash(ip: string, ua: string, date: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}|${ua}|${date}|${salt}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let hex = "";
  for (let i = 0; i < 8; i++) hex += (digest[i] ?? 0).toString(16).padStart(2, "0");
  return hex;
}

/** Settings key prefix of the per-day salts ("visitor_salt:2026-10-21"). */
const DAY_SALT_PREFIX = "visitor_salt:";

/** This isolate's copy of today's salt; `stored` is false for a stand-in used while D1 can't be read. */
let daySalt: { date: string; salt: string; stored: boolean } | null = null;

/** Forgets the in-memory salt (between tests). */
export function resetDaySaltCache(): void {
  daySalt = null;
}

/**
 * A random salt for one UTC day, shared by every isolate through D1. The daily
 * cron deletes it once the day is over (pruneDaySalts), so that day's visitor
 * hashes can't be recomputed from an IP address afterwards, not even by the
 * owner, who holds VISITOR_SALT.
 */
export async function daySaltFor(db: D1Database, date: string): Promise<string> {
  if (daySalt?.date === date && daySalt.stored) return daySalt.salt;
  const key = `${DAY_SALT_PREFIX}${date}`;
  try {
    const [, read] = await db.batch<{ value: string }>([
      db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING").bind(key, crypto.randomUUID()),
      db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key),
    ]);
    const salt = read?.results[0]?.value;
    if (!salt) throw new Error("day salt missing after insert");
    daySalt = { date, salt, stored: true };
    return salt;
  } catch (err) {
    console.error(JSON.stringify({ message: "day salt read failed", error: String(err) }));
    // Never stored, so nothing reversible is written; this isolate's uniques may count twice until D1 answers.
    if (daySalt?.date !== date) daySalt = { date, salt: crypto.randomUUID(), stored: false };
    return daySalt.salt;
  }
}

/** Deletes the salts of the days before `today` (YYYY-MM-DD, UTC). The daily cron runs it. */
export async function pruneDaySalts(db: D1Database, today: string): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key > ?1 AND key < ?2").bind(DAY_SALT_PREFIX, `${DAY_SALT_PREFIX}${today}`).run();
}

function cfOf(request: Request): IncomingRequestCfProperties | undefined {
  return request.cf as IncomingRequestCfProperties | undefined;
}

const BLOB_MAX = 200;
const INDEX_MAX_BYTES = 96;

function cap(s: string | undefined | null, max = BLOB_MAX): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

/** Truncates to a UTF-8 byte budget without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

export interface HitInput {
  /** The short domain the request came in on. */
  domain: string;
  slug: string;
  /** "hit" for a live link, "miss" for unknown, disabled or expired. */
  kind: "hit" | "miss";
  /** A miss on a path that looks like a scanner probe and isn't a real link. */
  probe?: boolean;
  sourceTag: string | null;
  qr: boolean;
}

/**
 * One Analytics Engine data point per hit; ae.ts queries by these positions.
 * index1: slug (96 bytes max). blob1 event (click|bot|miss), 2 country,
 * 3 region, 4 city, 5 continent, 6 AS organization, 7 colo, 8 device, 9 OS,
 * 10 browser, 11 referrer host, 12 source, 13 language, 14 bot name,
 * 15 daily visitor hash, 16 source kind, 17 short domain.
 * double1 1 (count), double2 bot (0|1), double3 ASN.
 */
export function buildDataPoint(
  request: Request,
  c: Classification,
  input: HitInput,
  hash: string,
): AnalyticsEngineDataPoint {
  const cf = cfOf(request);
  const event: HitEvent = input.kind === "miss" ? "miss" : c.isBot ? "bot" : "click";
  return {
    indexes: [truncateUtf8(input.slug, INDEX_MAX_BYTES)],
    blobs: [
      event,
      cap(cf?.country),
      cap(cf?.region),
      cap(cf?.city),
      cap(cf?.continent),
      cap(cf?.asOrganization),
      cap(cf?.colo),
      c.device,
      c.os,
      c.browser,
      cap(c.referrerHost),
      c.source,
      c.language,
      c.botName,
      hash,
      c.sourceKind,
      cap(input.domain),
    ],
    doubles: [1, c.isBot ? 1 : 0, Number(cf?.asn ?? 0)],
  };
}

/** Records one hit. Never throws: analytics must not affect redirects. */
export async function logHit(request: Request, env: Env, url: URL, input: HitInput): Promise<void> {
  try {
    const c = classify(request, url, input.sourceTag, input.qr, siteHostOf(env));
    // Scanner probes and bot misses are only recorded when the owner opts in.
    if (input.kind === "miss" && (input.probe || c.isBot) && !(await getMissPolicy(env.DB)).trackNoise) {
      // A path that looks like a probe but matches a link apart from case is a typo worth reporting.
      if (c.isBot || !(await hasLinkIgnoringCase(env.DB, input.domain, input.slug))) return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const hash = await visitorHash(
      request.headers.get("CF-Connecting-IP") ?? "",
      request.headers.get("User-Agent") ?? "",
      date,
      `${env.VISITOR_SALT ?? ""}|${await daySaltFor(env.DB, date)}`,
    );
    env.CLICKS.writeDataPoint(buildDataPoint(request, c, input, hash));
  } catch (err) {
    console.error(JSON.stringify({ message: "analytics write failed", domain: input.domain, slug: input.slug, error: String(err) }));
  }
}

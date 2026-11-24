// Advanced tracking (src/shared/tracking.ts): the per-link click log.
//
// A link with tracking on (KvLink.tk) writes one D1 row per hit, in the
// background of the redirect like the Analytics Engine data point: every
// detail Cloudflare gives about the request (request.cf, headers), and in IP
// mode the IP address, AES-GCM encrypted with ENCRYPTION_KEY (or
// SESSION_SECRET). With browser details on (KvLink.tj), people get a short
// page instead of the 302: it posts a few values the browser knows (screen,
// time zone, languages...) to /_k and then replaces itself with the
// destination. Bots, previews and prefetches always get the plain redirect.
//
// Tor exits come from Cloudflare (country "T1"), hosting networks from the
// ASN list in analytics.ts and the public X4BNet lists (downloaded by the
// 03:30 run). For people's clicks the IP's reverse DNS name is asked of
// Cloudflare's resolver (reverseDns), unless TRACKING_NET is "off".
//
// Rows expire after the link's retention (expires_at, set when written), and
// the 03:30 run (scheduledTracking) deletes them, with orphaned browser details.

import { APP_NAME } from "../shared/brand";
import { escapeHtml } from "../shared/html";
import { fromBase64Url, toBase64Url } from "../shared/password";
import {
  NOTIFY_EVERY_MIN_SEC,
  parseTrackingPolicy,
  PIXEL_PREFIX,
  TRACKING_BEACON_PATH,
  type BrowserDetails,
  type TrackingPolicy,
  type NetworkFlags,
  type TrackedClickDTO,
} from "../shared/tracking";
import { DATACENTER_ASNS, detectBot, detectBrowser, detectDevice, detectOs, referrerHostOf, resolveSource } from "./analytics";
import { isRoutableSlug } from "../shared/slug";
import { getSetting, isKvLink, KV_TIMEOUT_MS, kvKey, setSettingStmt, withTimeout, type KvLink } from "./db";
import { domainsOf } from "./domains";
import { mailerStatus, sendMail, withMailSettings } from "./mailer";
import { decryptSecret, emit, encryptSecret, type Background } from "./webhooks";

/** Cloudflare's country code for Tor exit nodes. */
const TOR_COUNTRY = "T1";
/** Networks iCloud Private Relay and Cloudflare WARP leave through (also listed as not-a-bot in analytics.ts). */
const RELAY_ASNS: ReadonlySet<number> = new Set([13335, 36183]);
/** How long the browser-details page has to report back. */
const BEACON_MAX_AGE_SEC = 600;
const BEACON_MAX_BYTES = 4096;
const DAY = 86400;

// ---- Keys -------------------------------------------------------------------------

let hashKey: { material: string; key: Promise<CryptoKey> } | null = null;

/** The HMAC key behind visitor numbers and IP lookups, from ENCRYPTION_KEY or SESSION_SECRET. */
function trackingKey(env: Env): Promise<CryptoKey> {
  const material = env.ENCRYPTION_KEY || env.SESSION_SECRET;
  if (!material) throw new Error("SESSION_SECRET is not set: tracked clicks can't be recorded.");
  if (hashKey?.material === material) return hashKey.key;
  const key = (async () => {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(material), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("shorthop-tracking"), info: new TextEncoder().encode("tracking-v1") },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
  })();
  hashKey = { material, key };
  return key;
}

async function hmacHex(env: Env, text: string, bytes: number): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await trackingKey(env), new TextEncoder().encode(text)));
  let hex = "";
  for (let i = 0; i < bytes; i++) hex += (sig[i] ?? 0).toString(16).padStart(2, "0");
  return hex;
}

/** The same browser on the same network, per link: a keyed hash, so it can't be tested against IP addresses without the key. */
export function visitorKey(env: Env, domain: string, slug: string, ip: string, ua: string): Promise<string> {
  return hmacHex(env, `visitor\n${domain}/${slug}\n${ip}\n${ua}`, 8);
}

/** Finds one IP address's clicks across links (access and erasure requests), without storing it in the clear. */
export function ipLookupKey(env: Env, ip: string): Promise<string> {
  // One key per address however it's written ("2001:db8::1" and "2001:0db8:0:0:0:0:0:1" alike).
  const normal = normalizeIp(ip);
  return hmacHex(env, `ip\n${canonicalIp(normal)}`, 16);
}

/** IPv4 as is; IPv6 lower-cased. */
export function normalizeIp(ip: string): string {
  return ip.trim().toLowerCase();
}

// ---- The workspace's rules ---------------------------------------------------------------

const POLICY_KEY = "tracking_policy";
const POLICY_TTL_MS = 60_000;
let policyCache: { value: TrackingPolicy; at: number } | null = null;

/**
 * The workspace's rules (src/shared/tracking.ts TrackingPolicy), cached a
 * minute per isolate. Read for tracked links only, so an untracked click
 * never pays for it. A failed read falls back to the cautious defaults.
 */
export async function trackingPolicy(env: Env): Promise<TrackingPolicy> {
  if (policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.value;
  let value: TrackingPolicy;
  try {
    value = parseTrackingPolicy(await getSetting(env.DB, POLICY_KEY));
  } catch (err) {
    console.error(JSON.stringify({ message: "tracking policy read failed", error: String(err) }));
    value = parseTrackingPolicy(null);
  }
  policyCache = { value, at: Date.now() };
  return value;
}

export async function saveTrackingPolicy(env: Env, policy: TrackingPolicy): Promise<void> {
  await setSettingStmt(env.DB, POLICY_KEY, JSON.stringify(policy)).run();
  policyCache = { value: policy, at: Date.now() };
}

/** Whether the browser-details page may be shown now (the rules may have changed since the link was published). */
export async function browserDetailsAllowed(env: Env): Promise<boolean> {
  const p = await trackingPolicy(env);
  return p.enabled && p.allowBrowser;
}

export function resetTrackingPolicy(): void {
  policyCache = null;
}

// ---- Parsing the request -------------------------------------------------------------

function cap(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

const unquote = (s: string | null) => (s ?? "").replaceAll('"', "").trim();

export function browserVersion(ua: string, browser: string): string {
  const patterns: Record<string, RegExp> = {
    Edge: /Edg(?:e|A|iOS)?\/([\d.]+)/,
    Opera: /OPR\/([\d.]+)/,
    "Samsung Internet": /SamsungBrowser\/([\d.]+)/,
    Firefox: /(?:Firefox|FxiOS)\/([\d.]+)/,
    Chrome: /(?:CriOS|Chrome)\/([\d.]+)/,
    Safari: /Version\/([\d.]+)/,
    "LinkedIn app": /LinkedInApp\/([\d.]+)/,
    "Facebook app": /FBAV\/([\d.]+)/,
    "Instagram app": /Instagram ([\d.]+)/,
  };
  const m = patterns[browser]?.exec(ua);
  return m ? cap(m[1], 32) : "";
}

export function osVersion(ua: string, os: string, chVersion: string | null): string {
  const ch = unquote(chVersion);
  if (ch) return cap(os === "Windows" ? windowsFromCh(ch) : ch, 32);
  let m: RegExpExecArray | null = null;
  if (os === "iOS") m = /OS (\d+(?:_\d+)*) like Mac/.exec(ua);
  else if (os === "Android") m = /Android (\d+(?:\.\d+)*)/.exec(ua);
  else if (os === "macOS") m = /Mac OS X (\d+(?:[_.]\d+)*)/.exec(ua);
  else if (os === "Windows") {
    const nt = /Windows NT (\d+\.\d+)/.exec(ua)?.[1];
    // Browsers report Windows 11 as NT 10.0 too; only the client hint tells them apart.
    return nt === "10.0" ? "10 or 11" : nt === "6.3" ? "8.1" : nt === "6.1" ? "7" : (nt ?? "");
  } else if (os === "ChromeOS") m = /CrOS \S+ ([\d.]+)/.exec(ua);
  return m ? cap(m[1]!.replaceAll("_", "."), 32) : "";
}

/** Sec-CH-UA-Platform-Version on Windows: 13 and up is Windows 11. */
function windowsFromCh(v: string): string {
  const major = Number(v.split(".")[0]);
  return Number.isFinite(major) && major >= 13 ? "11" : major > 0 ? "10" : v;
}

export function deviceModel(ua: string, chModel: string | null): string {
  const ch = unquote(chModel);
  if (ch) return cap(ch, 64);
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  // "Android 14; SM-S918B Build/..." or "Android 14; Pixel 8)"; reduced user agents say "K".
  const m = /Android [\d.]+; (?:[a-z]{2}-[a-z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?[;)]/i.exec(ua);
  const model = m?.[1]?.trim() ?? "";
  return model && model !== "K" && !/^wv$/i.test(model) ? cap(model, 64) : "";
}

export interface TrackInput {
  domain: string;
  slug: string;
  link: KvLink;
  /** The click's id; the browser-details page signs it. */
  id: string;
  sourceTag: string | null;
  qr: boolean;
  /** "open": the email pixel was loaded, not the link clicked. */
  kind?: "click" | "open";
}

export interface TrackedRow {
  id: string;
  domain: string;
  slug: string;
  at: number;
  expires_at: number;
  event: "click" | "open" | "bot";
  bot_name: string;
  ip_enc: string | null;
  ip_key: string | null;
  visitor: string;
  country: string;
  region: string;
  city: string;
  postal_code: string;
  metro_code: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  continent: string;
  is_eu: number;
  asn: number;
  as_org: string;
  colo: string;
  tls_version: string;
  http_protocol: string;
  rtt_ms: number | null;
  user_agent: string;
  device: string;
  os: string;
  os_version: string;
  browser: string;
  browser_version: string;
  device_model: string;
  languages: string;
  referrer: string;
  source: string;
  qr: number;
  tor: number;
  datacenter: number;
  private_relay: number;
  hostname: string;
  vpn_name: string;
}

const COLUMNS: readonly (keyof TrackedRow)[] = [
  "id", "domain", "slug", "at", "expires_at", "event", "bot_name", "ip_enc", "ip_key", "visitor",
  "country", "region", "city", "postal_code", "metro_code", "latitude", "longitude", "timezone", "continent", "is_eu",
  "asn", "as_org", "colo", "tls_version", "http_protocol", "rtt_ms",
  "user_agent", "device", "os", "os_version", "browser", "browser_version", "device_model", "languages",
  "referrer", "source", "qr", "tor", "datacenter", "private_relay", "hostname", "vpn_name",
];

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/** Whether this request gets the plain redirect: bots, previews, prefetches and HEAD requests never see the browser-details page. */
export function isAutomated(request: Request): boolean {
  const ua = request.headers.get("User-Agent") ?? "";
  return detectBot(request, ua, Number((request.cf as { asn?: number } | undefined)?.asn ?? 0)) !== "";
}

/**
 * Mail services that fetch images for their users through a proxy of their
 * own. The open is real (it happens when the email is opened), but the
 * location, network and device are the proxy's.
 */
export function mailProxy(ua: string): string {
  if (/GoogleImageProxy/i.test(ua)) return "Gmail image proxy";
  if (/YahooMailProxy/i.test(ua)) return "Yahoo Mail image proxy";
  return "";
}

/** Outlook and other Office apps open images themselves: for the pixel that's a person reading, not a link scanner. */
const MAIL_CLIENT = /Microsoft Outlook|MSOffice|Microsoft Office|ms-office|Outlook-iOS/i;

/** Web mail sites a reader may open the email in (when their browser sends a Referer at all). */
const WEBMAIL_HOST = /(^|\.)(mail|webmail|email|posta|outlook|seznam|centrum|proton|icloud|gmx|zoho|aol|fastmail|tutanota|tuta|yandex)\./;

/**
 * Who loaded the pixel: a person opening the email (perhaps through their
 * mail service's proxy), or a bot. A pixel loaded by a web page (it's public,
 * anyone can put it on a site) isn't an open: those visitors never got the
 * email, and their details are not what the link was tracked for.
 */
function classifyOpen(request: Request, ua: string, asn: number, ownHost: string): { event: "open" | "bot"; name: string } {
  const proxy = mailProxy(ua);
  if (proxy) return { event: "open", name: proxy };
  const embeddedOn = referrerHostOf(request.headers.get("Referer"), ownHost);
  if (embeddedOn && !WEBMAIL_HOST.test(`${embeddedOn}.`)) return { event: "bot", name: `Embedded on ${cap(embeddedOn, 60)}` };
  // Outlook and Office fetch images themselves, but Microsoft's link scanners use the same names from Microsoft's own network.
  if (MAIL_CLIENT.test(ua) && !DATACENTER_ASNS.has(asn)) return { event: "open", name: "" };
  const bot = detectBot(request, ua, asn);
  return bot ? { event: "bot", name: bot } : { event: "open", name: "" };
}

/** The row for one hit on a tracked link. */
export async function buildTrackedRow(request: Request, env: Env, url: URL, input: TrackInput, now = Math.floor(Date.now() / 1000)): Promise<TrackedRow> {
  const cf = (request.cf ?? {}) as Partial<IncomingRequestCfProperties> & { clientTcpRtt?: number };
  const h = request.headers;
  const ua = h.get("User-Agent") ?? "";
  const ip = h.get("CF-Connecting-IP") ?? "";
  const asn = Number(cf.asn ?? 0);
  const opened = input.kind === "open" ? classifyOpen(request, ua, asn, url.hostname) : null;
  const botName = opened ? (opened.event === "bot" ? opened.name : "") : detectBot(request, ua, asn);
  const event: TrackedRow["event"] = opened ? opened.event : botName ? "bot" : "click";
  const lists = await networkLists(env);
  const os = detectOs(ua, h.get("Sec-CH-UA-Platform"));
  const browser = detectBrowser(ua);
  const referrerHost = referrerHostOf(h.get("Referer"), url.hostname);
  const policy = await trackingPolicy(env);
  // The rules apply to every click, whatever the published record says (it may predate a change to them).
  const withIp = input.link.tk === 2 && ip !== "" && policy.allowIp;
  const retention = Math.min(Number.isFinite(input.link.tr) && (input.link.tr ?? 0) > 0 ? input.link.tr! : 30, policy.maxRetentionDays);
  return {
    id: input.id,
    domain: input.domain,
    slug: input.slug,
    at: now,
    expires_at: now + retention * DAY,
    event,
    bot_name: opened?.event === "open" ? opened.name : botName,
    ip_enc: withIp ? await encryptSecret(env, "tracking:ip", normalizeIp(ip)) : null,
    ip_key: withIp ? await ipLookupKey(env, ip) : null,
    visitor: await visitorKey(env, input.domain, input.slug, ip, ua),
    country: cap(cf.country, 8),
    region: cap(cf.region, 100),
    city: cap(cf.city, 100),
    postal_code: cap(cf.postalCode, 16),
    metro_code: cap(cf.metroCode, 16),
    latitude: num(cf.latitude),
    longitude: num(cf.longitude),
    timezone: cap(cf.timezone, 64),
    continent: cap(cf.continent, 8),
    is_eu: cf.isEUCountry === "1" ? 1 : 0,
    asn,
    as_org: cap(cf.asOrganization, 200),
    colo: cap(cf.colo, 8),
    tls_version: cap(cf.tlsVersion, 16),
    http_protocol: cap(cf.httpProtocol, 16),
    rtt_ms: num(cf.clientTcpRtt),
    user_agent: cap(ua, 512),
    device: botName ? "bot" : detectDevice(ua, h.get("Sec-CH-UA-Mobile")),
    os,
    os_version: osVersion(ua, os, h.get("Sec-CH-UA-Platform-Version")),
    browser,
    browser_version: browserVersion(ua, browser),
    device_model: deviceModel(ua, h.get("Sec-CH-UA-Model")),
    languages: cap(h.get("Accept-Language"), 200),
    referrer: cap(h.get("Referer"), 1000),
    source: resolveSource(input.sourceTag, input.qr, ua, referrerHost).source,
    qr: input.qr ? 1 : 0,
    tor: cf.country === TOR_COUNTRY ? 1 : 0,
    // The public hosting list also names Akamai, through which iCloud Private Relay leaves: that one is a relay, not a datacenter.
    datacenter: DATACENTER_ASNS.has(asn) || (lists.hosting.has(asn) && !RELAY_ASNS.has(asn)) ? 1 : 0,
    private_relay: RELAY_ASNS.has(asn) ? 1 : 0,
    hostname: "",
    vpn_name: cap(lists.vpn.get(asn), 80),
  };
}

// ---- Reverse DNS ----------------------------------------------------------------------

const DOH = "https://cloudflare-dns.com/dns-query";
const RDNS_TIMEOUT_MS = 1500;

/** The PTR query name of an IP address: 4.3.2.1.in-addr.arpa, or the nibbles of IPv6 under ip6.arpa. Null when it isn't an IP. */
export function ptrName(ip: string): string | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? `${v4.slice(1).reverse().join(".")}.in-addr.arpa` : null;
  if (!ip.includes(":") || !/^[0-9a-fA-F:]+$/.test(ip)) return null;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => g.length > 4)) return null;
  return `${groups.map((g) => g.padStart(4, "0")).join("").split("").reverse().join(".")}.ip6.arpa`;
}

/** An IPv6 address written out in full (8 groups of 4 hex digits), or the IPv4 address as is. */
export function canonicalIp(ip: string): string {
  const name = ptrName(ip);
  if (!name || name.endsWith(".in-addr.arpa")) return ip;
  const hex = name.replace(".ip6.arpa", "").split(".").reverse().join("");
  return hex.match(/.{4}/g)!.join(":");
}

async function doh(name: string, type: "PTR" | "A" | "AAAA", fetcher: typeof fetch): Promise<{ type: number; data: string }[]> {
  const res = await fetcher(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(RDNS_TIMEOUT_MS) });
  if (!res.ok) return [];
  const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
  return Array.isArray(body.Answer) ? body.Answer : [];
}

/**
 * The IP's reverse DNS name, asked of Cloudflare's resolver (1.1.1.1 over
 * HTTPS). That resolver asks the DNS servers of whoever runs the address (the
 * visitor's provider or company), as any reverse lookup does; they see a
 * lookup from Cloudflare, never who asked. The name is kept only when it is
 * forward-confirmed (it resolves back to the same address): whoever runs an
 * address can put any name in its PTR record, "mail.google.com" included.
 * "" when there is none, it isn't confirmed or the answer is slow: it runs
 * after the visitor has been sent on.
 */
export async function reverseDns(ip: string, fetcher: typeof fetch = fetch): Promise<string> {
  const name = ptrName(ip);
  if (!name) return "";
  try {
    const ptr = (await doh(name, "PTR", fetcher)).find((a) => a.type === 12)?.data ?? "";
    const host = ptr.replace(/\.$/, "").toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(host) || !host.includes(".")) return "";
    const v6 = ip.includes(":");
    const want = canonicalIp(ip.toLowerCase());
    const back = await doh(host, v6 ? "AAAA" : "A", fetcher);
    const confirmed = back.some((a) => a.type === (v6 ? 28 : 1) && canonicalIp(a.data.toLowerCase()) === want);
    return confirmed ? host : "";
  } catch {
    return "";
  }
}

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go"]);

/**
 * Without IP addresses, only the name's domain is kept: a reverse DNS name
 * often spells the address out ("ip-203-0-113-45.example.net"), and the
 * domain alone ("example.net", "firma.cz") is what tells who runs the network.
 */
export function hostDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels.at(-1)!;
  const second = labels.at(-2)!;
  const keep = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

// ---- Public VPN and hosting lists -------------------------------------------------------

/**
 * Networks of VPN providers and hosting companies, from the X4BNet/lists_vpn
 * project (MIT; curated ASN lists). Downloaded once a day by the cleanup job
 * into settings, then held in each isolate's memory for an hour: a tracked
 * click never waits on it, and an untracked one never reads it.
 */
export const NETWORK_LIST_URLS = {
  vpn: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/input/vpn/ASN.txt",
  hosting: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/input/datacenter/ASN.txt",
} as const;
const LISTS_KEY = "tracking_network_lists";
const LISTS_TTL_MS = 3_600_000;
const MAX_LIST_ENTRIES = 5_000;
/** The lists are a few kB to a few tens of kB; anything far bigger is refused rather than parsed in every isolate. */
const MAX_LIST_BYTES = 256 * 1024;

export interface NetworkLists {
  vpn: Map<number, string>;
  hosting: Set<number>;
}
interface StoredLists {
  vpn: [number, string][];
  hosting: number[];
  at: number;
}
const EMPTY_LISTS: NetworkLists = { vpn: new Map(), hosting: new Set() };
let listsCache: { value: NetworkLists; at: number } | null = null;

/** "AS9009 # M247, GB (NordVPN)" → [9009, "M247, GB (NordVPN)"]. */
export function parseAsnList(text: string): [number, string][] {
  const out: [number, string][] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*AS(\d{1,10})\b\s*(?:#\s*(.*))?$/i.exec(line);
    if (!m) continue;
    const asn = Number(m[1]);
    if (asn > 0 && asn < 4_294_967_296) out.push([asn, (m[2] ?? "").trim().slice(0, 80)]);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out;
}

/** The lists as this isolate knows them (empty until the first download). */
export async function networkLists(env: Env): Promise<NetworkLists> {
  if (listsCache && Date.now() - listsCache.at < LISTS_TTL_MS) return listsCache.value;
  let value = EMPTY_LISTS;
  try {
    const raw = await getSetting(env.DB, LISTS_KEY);
    if (raw) {
      const s = JSON.parse(raw) as StoredLists;
      value = { vpn: new Map(s.vpn), hosting: new Set(s.hosting) };
    }
  } catch (err) {
    console.error(JSON.stringify({ message: "network lists read failed", error: String(err) }));
  }
  listsCache = { value, at: Date.now() };
  return value;
}

export function resetNetworkLists(): void {
  listsCache = null;
}

/** Downloads both lists and stores them; keeps the old ones when a download fails or comes back empty. */
export async function refreshNetworkLists(env: Env, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (env.TRACKING_NET === "off" && fetcher === fetch) return false;
  const get = async (url: string) => {
    const res = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "ShorthopLinks/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await readStreamCapped(res.body, MAX_LIST_BYTES);
    if (text === null) throw new Error(`${url} is larger than ${MAX_LIST_BYTES} bytes`);
    return parseAsnList(text);
  };
  const [vpn, hosting] = await Promise.all([get(NETWORK_LIST_URLS.vpn), get(NETWORK_LIST_URLS.hosting)]);
  if (!vpn.length || !hosting.length) throw new Error("A network list came back empty");
  const stored: StoredLists = { vpn, hosting: hosting.map(([asn]) => asn), at: Math.floor(Date.now() / 1000) };
  await setSettingStmt(env.DB, LISTS_KEY, JSON.stringify(stored)).run();
  listsCache = null;
  return true;
}

/** Whether the lists were ever downloaded (a tracking change fetches them at once the first time). */
export async function hasNetworkLists(db: D1Database): Promise<boolean> {
  return (await getSetting(db, LISTS_KEY)) !== null;
}

/**
 * The half-hourly cron's 03:30 UTC run (src/shared/schedule.ts), in an
 * invocation of its own so it doesn't spend the 02:00 cleanup's budget. One
 * query when nothing is tracked. Expired clicks are deleted while any exist;
 * the lists are downloaded only while some link is tracked, so a workspace
 * without tracking never downloads anything.
 */
export async function scheduledTracking(env: Env): Promise<void> {
  const state = await env.DB.prepare(
    "SELECT EXISTS (SELECT 1 FROM links WHERE tracking IS NOT NULL) AS links, EXISTS (SELECT 1 FROM tracked_clicks) OR EXISTS (SELECT 1 FROM tracked_click_details) AS clicks",
  ).first<{ links: number; clicks: number }>();
  if (state?.clicks) {
    try {
      await pruneTrackedClicks(env.DB);
    } catch (err) {
      console.error(JSON.stringify({ message: "tracked clicks retention failed", error: String(err) }));
    }
  }
  if (state?.links) await refreshNetworkLists(env);
}

/** Records one hit on a tracked link and sends its notifications. Never throws: tracking must not affect redirects. */
export async function recordTrackedClick(request: Request, env: Env, url: URL, input: TrackInput, ctx?: Background): Promise<void> {
  let row: TrackedRow;
  try {
    const policy = await trackingPolicy(env);
    if (!policy.enabled || (input.kind === "open" && !(policy.allowPixel && input.link.tp === 1))) return;
    row = await buildTrackedRow(request, env, url, input);
    // People only: a scanner or crawler isn't worth a lookup. In IP mode the whole name; without, its domain.
    if (row.event !== "bot" && env.TRACKING_NET !== "off") {
      const host = await reverseDns(request.headers.get("CF-Connecting-IP") ?? "");
      row.hostname = cap(row.ip_enc !== null ? host : host ? hostDomain(host) : "", 253);
    }
    await env.DB.prepare(`INSERT INTO tracked_clicks (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, i) => `?${i + 1}`).join(", ")})`)
      .bind(...COLUMNS.map((c) => row[c]))
      .run();
  } catch (err) {
    console.error(JSON.stringify({ message: "tracked click write failed", domain: input.domain, slug: input.slug, error: String(err) }));
    return;
  }
  if (row.event === "bot") return;
  try {
    await notifyTrackedClick(env, input.link, row, ctx);
  } catch (err) {
    console.error(JSON.stringify({ message: "tracked click notification failed", domain: input.domain, slug: input.slug, error: String(err) }));
  }
}

// ---- Notifications --------------------------------------------------------------------

const NOTIFIED_PREFIX = "tracking_notified:";

/** The settings key that remembers the last email for a link. Cleared when tracking is changed, so "first click" applies afresh. */
export function notifiedKey(domain: string, slug: string, kind: "click" | "open" = "click"): string {
  return `${NOTIFIED_PREFIX}${domain}/${slug}${kind === "open" ? ":open" : ""}`;
}

/**
 * Claims the right to email about this click: "first" once per link (until
 * tracking is changed), "every" at most once per NOTIFY_EVERY_MIN_SEC. One
 * atomic write, so two clicks at once can't both send.
 */
async function claimNotification(db: D1Database, key: string, mode: 1 | 2, now: number): Promise<boolean> {
  const res =
    mode === 1
      ? await db.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING").bind(key, String(now)).run()
      : await db
          .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?3")
          .bind(key, String(now), now - NOTIFY_EVERY_MIN_SEC)
          .run();
  return (res.meta.changes ?? 0) > 0;
}

/** The click's visit number for its visitor (1 for a first visit). */
async function visitNumber(db: D1Database, row: TrackedRow): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM tracked_clicks WHERE domain = ?1 AND slug = ?2 AND visitor = ?3 AND event = ?4")
    .bind(row.domain, row.slug, row.visitor, row.event)
    .first<{ n: number }>();
  return Math.max(1, r?.n ?? 1);
}

function place(row: Pick<TrackedRow, "city" | "region" | "country" | "postal_code">): string {
  return [row.city, row.postal_code, row.region, row.country].filter(Boolean).join(", ") || "Unknown location";
}

function flagsOf(row: Pick<TrackedRow, "tor" | "datacenter" | "private_relay" | "vpn_name">): string[] {
  const out: string[] = [];
  if (row.vpn_name) out.push(`Known VPN provider: ${row.vpn_name}`);
  if (row.tor) out.push("Tor exit node");
  if (row.datacenter) out.push("Hosting / datacenter network (VPN or proxy likely)");
  if (row.private_relay) out.push("Relay network (iCloud Private Relay or Cloudflare WARP)");
  return out;
}

async function notifyTrackedClick(env: Env, link: KvLink, row: TrackedRow, ctx?: Background): Promise<void> {
  const visit = await visitNumber(env.DB, row);
  const ip = row.ip_enc ? await decryptSecret(env, "tracking:ip", row.ip_enc) : null;
  // Webhooks carry no full IP address: who receives them isn't known here (the admin shows it, with the permission).
  await emit(
    env,
    "link.tracked_click",
    {
      link: { domain: row.domain, slug: row.slug },
      id: row.id,
      event: row.event,
      at: new Date(row.at * 1000).toISOString(),
      visitor: row.visitor,
      visit,
      // Not even a masked one: its /24 or /48 is part of an IP address, and the event needs only clicks.view.
      ip_recorded: ip !== null,
      location: { country: row.country, region: row.region, city: row.city, postal_code: row.postal_code, timezone: row.timezone, latitude: row.latitude, longitude: row.longitude },
      // Without IP addresses the host name is only the network's domain, so it is safe to send; with them it can spell the address out.
      network: { asn: row.asn, organization: row.as_org, host: row.hostname ? hostDomain(row.hostname) : "", vpn: row.vpn_name || null, tor: row.tor === 1, datacenter: row.datacenter === 1, relay: row.private_relay === 1 },
      via: row.bot_name || null,
      device: { type: row.device, os: row.os, os_version: row.os_version, browser: row.browser, browser_version: row.browser_version, model: row.device_model },
      languages: row.languages,
      referrer: row.referrer,
      source: row.source,
    },
    ctx ? { ctx } : {},
  );
  if (!link.tn) return;
  const mailEnv = await withMailSettings(env);
  if (mailerStatus(mailEnv).problem || !mailEnv.DIGEST_TO) return;
  const opened = row.event === "open";
  if (!(await claimNotification(env.DB, notifiedKey(row.domain, row.slug, opened ? "open" : "click"), link.tn, row.at))) return;
  const short = `${row.domain}/${row.slug}`;
  const adminUrl = `https://${domainsOf(env).admin}/_admin/links/${encodeURIComponent(row.domain)}/${encodeURIComponent(row.slug)}#clicks`;
  const lines: [string, string][] = [
    ["When", `${new Date(row.at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`],
    ["Visitor", opened ? (visit === 1 ? "First open from this browser and network" : `Open ${visit} from this browser and network`) : visit === 1 ? "First visit from this browser and network" : `Visit ${visit} from this browser and network`],
    ...(row.bot_name ? ([["Through", `${row.bot_name}: the location and network below are the proxy's, not the reader's`]] as [string, string][]) : []),
    ["Where", place(row)],
    ["Network", [row.as_org, row.asn ? `AS${row.asn}` : "", row.hostname].filter(Boolean).join(" · ") || "Unknown"],
    ...(ip ? ([["IP address", ip]] as [string, string][]) : []),
    ["Device", [row.device, row.device_model, [row.os, row.os_version].filter(Boolean).join(" "), [row.browser, row.browser_version].filter(Boolean).join(" ")].filter(Boolean).join(" · ")],
    ["Came from", row.referrer || row.source || "Direct"],
  ];
  const flags = flagsOf(row);
  const subject = opened ? (link.tn === 1 ? `Email opened: ${short} (first time)` : `Email opened: ${short}`) : link.tn === 1 ? `First click on ${short}` : `New click on ${short}`;
  const text = [`${subject}`, "", ...lines.map(([k, v]) => `${k}: ${v}`), ...(flags.length ? ["", ...flags.map((f) => `! ${f}`)] : []), "", `Click log: ${adminUrl}`].join("\n");
  const html = `<div style="font:14px/1.5 system-ui,sans-serif;color:#222"><p style="font-size:16px;margin:0 0 12px"><strong>${escapeHtml(subject)}</strong></p>
<table style="border-collapse:collapse">${lines.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`).join("")}</table>
${flags.length ? `<ul style="color:#a15c00;padding-left:18px">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
<p><a href="${escapeHtml(adminUrl)}">Open the click log</a></p></div>`;
  await sendMail(mailEnv, { from: { email: mailEnv.DIGEST_FROM, name: APP_NAME }, to: mailEnv.DIGEST_TO, subject, text, html });
}

// ---- The browser-details page ------------------------------------------------------------

let beaconKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function beaconSigningKey(secret: string): Promise<CryptoKey> {
  if (beaconKey?.secret === secret) return beaconKey.key;
  const key = (async () => {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("shorthop-tracking-beacon"), info: new TextEncoder().encode("beacon-v1") },
      base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
  })();
  beaconKey = { secret, key };
  return key;
}

async function beaconMac(secret: string, body: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await beaconSigningKey(secret), new TextEncoder().encode(body))).slice(0, 16);
}

/** "<click id>.<unix seconds>.<mac>": lets the page report on its own click, once, for a few minutes. */
export async function signBeacon(secret: string, clickId: string, at: number): Promise<string> {
  const body = `${clickId}.${at}`;
  return `${body}.${toBase64Url(await beaconMac(secret, body))}`;
}

export async function verifyBeacon(secret: string, token: string, now: number): Promise<string | null> {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, atText, macText] = parts as [string, string, string];
  const at = Number(atText);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id) || !Number.isInteger(at) || at > now + 60 || now - at > BEACON_MAX_AGE_SEC) return null;
  const mac = fromBase64Url(macText);
  const want = await beaconMac(secret, `${id}.${at}`);
  if (!mac || mac.length !== want.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want[i]! ^ mac[i]!;
  return diff === 0 ? id : null;
}

/** A click id: random, URL-safe. */
export function newClickId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** JSON that is safe inside a <script> element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * The page people see for a moment on a link with browser details on. It
 * reads a few values, posts them with sendBeacon and replaces itself with the
 * destination (so Back skips it). Without JavaScript, a meta refresh and a
 * plain link take over.
 */
export function browserDetailsPage(location: string, token: string, head = false): Response {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const href = escapeHtml(location);
  const script = `(function(){var u=${scriptJson(location)},t=${scriptJson(token)},done=false;
function go(){if(done)return;done=true;location.replace(u)}
function send(d){try{var b=JSON.stringify({t:t,d:d});if(!(navigator.sendBeacon&&navigator.sendBeacon(${scriptJson(TRACKING_BEACON_PATH)},b))){fetch(${scriptJson(TRACKING_BEACON_PATH)},{method:"POST",body:b,keepalive:true,credentials:"omit"})}}catch(e){}go()}
try{var n=navigator,s=window.screen||{},c=n.connection||{},o=-new Date().getTimezoneOffset(),d={
screen:(s.width||0)+"x"+(s.height||0),viewport:(window.innerWidth||0)+"x"+(window.innerHeight||0),dpr:window.devicePixelRatio||null,
timezone:(Intl.DateTimeFormat().resolvedOptions().timeZone||""),tzOffset:o,languages:(n.languages||[n.language||""]).join(","),
platform:n.platform||"",cores:n.hardwareConcurrency||null,memory:n.deviceMemory||null,touch:typeof n.maxTouchPoints==="number"?n.maxTouchPoints:null,
connection:c.effectiveType||"",colorScheme:window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light",
dnt:n.doNotTrack==="1",gpc:n.globalPrivacyControl===true,model:"",platformVersion:"",fullVersion:""};
var ua=n.userAgentData;if(ua&&ua.getHighEntropyValues){var timer=setTimeout(function(){send(d)},150);
ua.getHighEntropyValues(["model","platformVersion","uaFullVersion"]).then(function(h){clearTimeout(timer);d.model=h.model||"";d.platformVersion=h.platformVersion||"";d.fullVersion=h.uaFullVersion||"";send(d)},function(){clearTimeout(timer);send(d)})}
else send(d)}catch(e){go()}
setTimeout(go,1500)})();`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Opening…</title>
<noscript><meta http-equiv="refresh" content="0;url=${href}"></noscript>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#fff;color:#555}@media (prefers-color-scheme:dark){body{background:#111;color:#aaa}}a{color:inherit}</style></head>
<body><p><a href="${href}">Continue</a></p><script nonce="${nonce}">${script}</script></body></html>`;
  return new Response(head ? null : html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : null);

/** Keeps only the expected fields, in their expected shapes and sizes. */
export function cleanDetails(raw: unknown, now: number): BrowserDetails | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const dims = (v: unknown) => (typeof v === "string" && /^\d{1,5}x\d{1,5}$/.test(v) ? v : "");
  return {
    screen: dims(d.screen),
    viewport: dims(d.viewport),
    dpr: int(d.dpr, 0.1, 10),
    timezone: /^[A-Za-z0-9_+\-/]{1,64}$/.test(str(d.timezone, 64)) ? str(d.timezone, 64) : "",
    tzOffset: int(d.tzOffset, -900, 900),
    languages: str(d.languages, 200),
    platform: str(d.platform, 64),
    cores: int(d.cores, 1, 1024),
    memory: int(d.memory, 0.1, 1024),
    touch: int(d.touch, 0, 64),
    connection: /^(slow-2g|2g|3g|4g)$/.test(str(d.connection, 16)) ? str(d.connection, 16) : "",
    colorScheme: d.colorScheme === "dark" ? "dark" : d.colorScheme === "light" ? "light" : "",
    dnt: d.dnt === true,
    gpc: d.gpc === true,
    model: str(d.model, 64),
    platformVersion: str(d.platformVersion, 32),
    fullVersion: str(d.fullVersion, 32),
    at: now,
  };
}

/** The body as text, or null once it passes `max` bytes (a chunked body has no Content-Length to check first). */
function readCapped(request: Request, max: number): Promise<string | null> {
  return readStreamCapped(request.body, max);
}

async function readStreamCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** POST /_k: what the browser-details page reports. Always 204 unless the request is malformed, so the page never waits on it. */
export async function handleBeacon(request: Request, env: Env): Promise<Response> {
  const noContent = new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (!env.SESSION_SECRET) return noContent;
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > BEACON_MAX_BYTES) return new Response("Too large", { status: 413 });
  let body: { t?: unknown; d?: unknown };
  try {
    const text = await readCapped(request, BEACON_MAX_BYTES);
    if (text === null) return new Response("Too large", { status: 413 });
    body = JSON.parse(text) as { t?: unknown; d?: unknown };
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const id = await verifyBeacon(env.SESSION_SECRET, String(body?.t ?? ""), now);
  const details = id ? cleanDetails(body.d, now) : null;
  if (!id || !details) return new Response("Bad request", { status: 400 });
  const policy = await trackingPolicy(env);
  if (!policy.enabled || !policy.allowBrowser) return noContent;
  try {
    await env.DB.prepare("INSERT INTO tracked_click_details (click_id, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (click_id) DO NOTHING")
      .bind(id, JSON.stringify(details), now)
      .run();
  } catch (err) {
    console.error(JSON.stringify({ message: "browser details write failed", error: String(err) }));
  }
  return noContent;
}

// ---- Reading, retention and erasure -------------------------------------------------------

export type StoredClick = TrackedRow & { details: string | null; visitor_no?: number; visitor_visits?: number };

/** IANA zone → minutes east of UTC at `at`; null when the zone isn't known. */
export function zoneOffset(zone: string, at: number): number | null {
  if (!zone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date(at * 1000));
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    if (name === "GMT") return 0;
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return null;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** The browser's clock disagrees with the IP's time zone: a VPN or proxy hint. Same offset under another name isn't a mismatch. */
export function tzMismatch(row: Pick<TrackedRow, "timezone" | "at">, details: BrowserDetails | null): boolean {
  if (!details || !row.timezone || (!details.timezone && details.tzOffset === null)) return false;
  if (details.timezone && details.timezone === row.timezone) return false;
  const ipOffset = zoneOffset(row.timezone, row.at);
  const browserOffset = details.tzOffset ?? zoneOffset(details.timezone, row.at);
  return ipOffset !== null && browserOffset !== null && ipOffset !== browserOffset;
}

function parseDetails(stored: string | null): BrowserDetails | null {
  if (!stored) return null;
  try {
    return JSON.parse(stored) as BrowserDetails;
  } catch {
    return null;
  }
}

/** A stored click as the admin sees it; the IP address only when `showIp`. */
export async function clickDTO(env: Env, r: StoredClick, showIp: boolean): Promise<TrackedClickDTO> {
  const details = parseDetails(r.details);
  const mismatch = tzMismatch(r, details);
  const flags: NetworkFlags = { tor: r.tor === 1, datacenter: r.datacenter === 1, privateRelay: r.private_relay === 1, knownVpn: r.vpn_name ?? "", vpnSuspected: Boolean(r.vpn_name) || r.datacenter === 1 || mismatch };
  return {
    id: r.id,
    at: r.at,
    domain: r.domain,
    slug: r.slug,
    event: r.event,
    botName: r.bot_name,
    ip: showIp && r.ip_enc ? await decryptSecret(env, "tracking:ip", r.ip_enc) : null,
    hasIp: r.ip_enc !== null,
    visitor: r.visitor_no ? `V${r.visitor_no}` : r.visitor.slice(0, 6),
    visitorVisits: r.visitor_visits ?? 1,
    country: r.country,
    region: r.region,
    city: r.city,
    postalCode: r.postal_code,
    metroCode: r.metro_code,
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
    continent: r.continent,
    isEU: r.is_eu === 1,
    asn: r.asn,
    asOrganization: r.as_org,
    // The whole name can spell the IP address out: only alongside the address itself, for those who may see it.
    hostname: showIp && r.ip_enc ? (r.hostname ?? "") : hostDomain(r.hostname ?? ""),
    colo: r.colo,
    tlsVersion: r.tls_version,
    httpProtocol: r.http_protocol,
    rttMs: r.rtt_ms,
    userAgent: r.user_agent,
    device: r.device,
    os: r.os,
    osVersion: details?.platformVersion && r.os !== "Windows" ? details.platformVersion : r.os === "Windows" && details?.platformVersion ? windowsFromCh(details.platformVersion) : r.os_version,
    browser: r.browser,
    browserVersion: details?.fullVersion || r.browser_version,
    deviceModel: details?.model || r.device_model,
    languages: r.languages,
    referrer: r.referrer,
    source: r.source,
    qr: r.qr === 1,
    flags,
    details,
    tzMismatch: mismatch,
  };
}

/** Deletes expired clicks and browser details whose click is gone (or never came). */
export async function pruneTrackedClicks(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM tracked_clicks WHERE expires_at <= ?1").bind(now),
    db.prepare("DELETE FROM tracked_click_details WHERE created_at <= ?1 AND click_id NOT IN (SELECT id FROM tracked_clicks)").bind(now - DAY),
  ]);
}

/** Deletes a link's whole click log (and its notification state). */
export function deleteLinkClicksStmts(db: D1Database, domain: string, slug: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM tracked_click_details WHERE click_id IN (SELECT id FROM tracked_clicks WHERE domain = ?1 AND slug = ?2)").bind(domain, slug),
    db.prepare("DELETE FROM tracked_clicks WHERE domain = ?1 AND slug = ?2").bind(domain, slug),
    db.prepare("DELETE FROM settings WHERE key IN (?1, ?2)").bind(notifiedKey(domain, slug), notifiedKey(domain, slug, "open")),
  ];
}

// ---- The email-open pixel ----------------------------------------------------------------

/** A transparent 1×1 GIF (43 bytes). */
const PIXEL_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="), (c) => c.charCodeAt(0));

function pixelResponse(head: boolean): Response {
  return new Response(head ? null : PIXEL_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL_GIF.byteLength),
      // Each open asks again (mail proxies may still keep a copy: Gmail does after its first fetch).
      "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}

/**
 * GET /_p/<slug>(.gif): the email-open pixel. Always the same transparent
 * GIF, whatever the slug, so an email never shows a broken image and the
 * address says nothing about whether a link exists. An open is recorded only
 * for a live link with Advanced tracking on, in the background, and isn't a
 * click: it stays out of the statistics, the click limit and the routing.
 */
export async function handlePixel(request: Request, env: Env, ctx: ExecutionContext, url: URL, domain: string, mayRecord: () => Promise<boolean> = async () => true): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const head = request.method === "HEAD";
  let slug: string;
  try {
    slug = decodeURIComponent(url.pathname.slice(PIXEL_PREFIX.length)).replace(/\.gif$/i, "");
  } catch {
    return pixelResponse(head);
  }
  if (head || !isRoutableSlug(slug)) return pixelResponse(head);
  try {
    const value = await withTimeout(env.LINKS.get(kvKey(domain, slug), { type: "json", cacheTtl: 60 }), KV_TIMEOUT_MS, "KV read");
    const link = isKvLink(value) ? value : null;
    const live = link !== null && link.a === 1 && (link.e === null || link.e * 1000 > Date.now());
    // The pixel records only where it was switched on for the link.
    // Each open is a D1 write: past the per-network brake the GIF still loads, nothing is recorded.
    if (live && link.tk && link.tp === 1 && (await mayRecord())) {
      ctx.waitUntil(recordTrackedClick(request, env, url, { domain, slug, link, id: newClickId(), sourceTag: url.searchParams.get("s"), qr: false, kind: "open" }, ctx));
    }
  } catch (err) {
    console.error(JSON.stringify({ message: "pixel lookup failed", domain, slug, error: String(err) }));
  }
  return pixelResponse(false);
}

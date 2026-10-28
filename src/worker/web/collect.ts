// The collector: POST /_t/e from the tracker on a tracked site. One event per
// request, a small JSON body sent as text/plain (no CORS preflight).
//
// Checked before anything is stored: the client isn't over the rate limit,
// the site exists, the request's Origin and the page URL both belong to it,
// and it isn't a bot. Every event updates the visit's D1 row and writes one data
// point to Analytics Engine (the AE_WEB_DATASET dataset, layout in WEB_BLOBS).
// No IP address is stored; cookieless sites get a visitor hash that changes
// every day and can't be linked across days.

import { hostBelongs, pathMatches, type SiteDTO } from "../../shared/sites";
import { daySaltFor, detectBot, detectBrowser, detectDevice, detectOs, primaryLanguage, truncateUtf8, visitorHash } from "../analytics";
import { readTextCapped } from "../body";
import { claimRefs } from "../revenue/match";
import { ipBucket } from "../session";
import { attributionOf, inAppBrowser } from "./source";
import { identifyVisitor, touchSession, type TouchKind } from "./sessions";
import { cachedSite } from "./sites";
import { verifyClickToken } from "./token";

export const COLLECT_PATH = "/_t/e";
const MAX_BODY = 8 * 1024;

const TYPES: Record<string, TouchKind | "identify"> = {
  pageview: "pageview",
  goal: "goal",
  outbound: "outbound",
  checkout: "checkout",
  engage: "engage",
  vitals: "vitals",
  identify: "identify",
};

interface Payload {
  /** Site id. */
  s: string;
  /** Event type (TYPES). */
  t: string;
  /** Page URL. */
  u: string;
  /** document.referrer. */
  r?: string;
  /** Screen width. */
  w?: number;
  /** Persistent visitor id (persistent sites only). */
  v?: string;
  /** Goal name, or the outbound/checkout URL. */
  n?: string;
  /** Goal properties. */
  p?: Record<string, unknown>;
  /** Engaged milliseconds (engage). */
  d?: number;
  /** Deepest scroll of the page so far, 0–100 (engage). */
  sd?: number;
  /** Page speed of the page as loaded (vitals): largest contentful paint and slowest interaction in ms, layout shift. */
  lcp?: number;
  cls?: number;
  inp?: number;
  /** The visitor consented to a persistent id (consent sites). */
  cs?: number;
  /** Short-link click token from ?sh_c=. */
  c?: string;
  /** Provider ids from a return page's URL (?session_id=, ?order_id=…). */
  k?: string[];
  /** identify: email, name, id. */
  e?: { email?: unknown; name?: unknown; id?: unknown };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

function reply(status: number, origin: string | null, body?: unknown): Response {
  return body === undefined
    ? new Response(null, { status, headers: cors(origin) })
    : new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}

/** "/Pricing/?x" → "/Pricing": decoded, no trailing slash, capped. */
export function normalizePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURI(p);
  } catch {
    // Keep it encoded.
  }
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "") || "/";
  return truncateUtf8(p || "/", 300);
}

function referrerHost(raw: string, site: SiteDTO): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol === "android-app:") return u.hostname.slice(0, 100);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return hostBelongs(host, site.domains) ? "" : host.slice(0, 200);
  } catch {
    return "";
  }
}

/** Visitors that asked not to be tracked across visits (Global Privacy Control, Do Not Track). */
function optedOut(request: Request): boolean {
  return request.headers.get("Sec-GPC") === "1" || request.headers.get("DNT") === "1";
}

export async function handleCollect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") return reply(204, origin);
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST, OPTIONS" } });

  const text = await readTextCapped(request, MAX_BODY);
  if (text === null) return reply(413, origin);
  let p: Payload;
  try {
    p = JSON.parse(text) as Payload;
  } catch {
    return reply(400, origin);
  }
  if (!p || typeof p !== "object" || typeof p.s !== "string" || typeof p.u !== "string") return reply(400, origin);
  const t = str(p.t, 20);
  const kind = Object.hasOwn(TYPES, t) ? TYPES[t] : undefined;
  if (!kind) return reply(400, origin);

  let page: URL;
  try {
    page = new URL(p.u);
  } catch {
    return reply(400, origin);
  }
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(p.s.replace(/^st_/, ""))) return reply(404, origin);

  // Per network, before the site is looked up, so made-up site IDs can't cost a D1 read each.
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (ip && env.COLLECT_LIMITER) {
    try {
      const { success } = await env.COLLECT_LIMITER.limit({ key: `collect:${ipBucket(ip)}` });
      if (!success) return reply(429, origin);
    } catch (err) {
      console.error(JSON.stringify({ message: "collect rate limiter failed", error: String(err) }));
    }
  }
  const site = await cachedSite(env.DB, p.s);
  if (!site) return reply(404, origin);

  // Both the browser's Origin and the page URL must be the site's (or a subdomain).
  let originHost = "";
  try {
    originHost = origin ? new URL(origin).hostname : "";
  } catch {
    // Unparseable: refused below.
  }
  if (!originHost || !hostBelongs(originHost, site.domains) || !hostBelongs(page.hostname, site.domains)) return reply(403, origin);
  // Paused: accepted and dropped, like a bot, so the site's console stays quiet.
  if (!site.tracking) return reply(202, origin);

  const ua = request.headers.get("User-Agent") ?? "";
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  if (detectBot(request, ua, Number(cf?.asn ?? 0))) return reply(202, origin);


  // The tracker sends the hash only for sites with data-hash, where "#/route" is the page.
  const path = normalizePath(page.hash.length > 1 ? `${page.pathname}${page.hash}` : page.pathname);
  if (site.excludePaths.some((g) => pathMatches(path, g))) return reply(202, origin);

  const now = Math.floor(Date.now() / 1000);
  const date = new Date(now * 1000).toISOString().slice(0, 10);

  // The visitor: the site's own first-party id, or a hash that changes daily.
  // Consent sites: only once the visitor said yes. GPC/DNT still wins when the site respects it.
  const wantsId = site.idMode === "persistent" || (site.idMode === "consent" && p.cs === 1);
  const gpcOff = site.respectGpc && optedOut(request);
  const persistent = wantsId && !gpcOff;
  // a: 1 lets a built-in consent banner know there's a question to ask (never when GPC/DNT already answered it).
  const mode = { m: persistent ? "p" : "c", ...(site.idMode === "consent" && !gpcOff ? { a: 1 } : {}) };
  let visitorId: string;
  if (persistent && typeof p.v === "string" && /^[A-Za-z0-9_-]{16,40}$/.test(p.v)) {
    visitorId = p.v;
  } else {
    let daily: string;
    try {
      daily = await daySaltFor(env.DB, date);
    } catch (err) {
      console.error(JSON.stringify({ message: "visitor salt unavailable", error: String(err) }));
      return reply(503, origin);
    }
    visitorId = await visitorHash(ip, `${ua}|${site.id}`, date, `${env.VISITOR_SALT ?? ""}|${daily}`);
  }

  if (kind === "identify") {
    const e = p.e ?? {};
    const email = str(e.email, 254);
    await identifyVisitor(env.DB, site.id, visitorId, { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined, name: str(e.name, 200), userId: str(e.id, 200) }, "client", now);
    return reply(200, origin, mode);
  }

  const click = kind === "pageview" && typeof p.c === "string" && env.SESSION_SECRET ? await verifyClickToken(env.SESSION_SECRET, p.c, now) : null;
  const refHost = referrerHost(str(p.r, 2000), site);
  const returnRefs = kind === "pageview" && Array.isArray(p.k) && p.k.length > 0;
  const attribution = attributionOf(page, refHost, click, { inApp: inAppBrowser(ua), checkoutReturn: returnRefs });
  const engagedMs = kind === "engage" && typeof p.d === "number" && Number.isFinite(p.d) ? Math.max(0, Math.round(p.d)) : 0;
  const scroll = kind === "engage" && typeof p.sd === "number" && Number.isFinite(p.sd) ? Math.min(100, Math.max(0, Math.round(p.sd))) : 0;
  const vitals = kind === "vitals" ? vitalsOf(p) : null;
  if (kind === "vitals" && !vitals) return reply(202, origin);
  const device = detectDevice(ua, request.headers.get("Sec-CH-UA-Mobile"));
  const width = typeof p.w === "number" && Number.isFinite(p.w) ? Math.round(p.w) : 0;
  const client = {
    // A "desktop" browser in a phone-sized window is a phone (in-app browsers, request-desktop-site).
    device: device === "desktop" && width > 0 && width < 600 ? "mobile" : device,
    os: detectOs(ua, request.headers.get("Sec-CH-UA-Platform")),
    browser: detectBrowser(ua),
    language: primaryLanguage(request.headers.get("Accept-Language")),
    screen: screenClass(width),
  };
  const geo = {
    country: str(cf?.country, 2),
    region: str(cf?.region, 100),
    city: str(cf?.city, 100),
    continent: str(cf?.continent, 2),
    timezone: str(cf?.timezone, 64),
    org: str(cf?.asOrganization, 120),
  };

  const session = await touchSession(env.DB, {
    siteId: site.id,
    visitorId,
    now,
    kind,
    path,
    hostname: page.hostname.toLowerCase(),
    engagedMs,
    attribution,
    referrerHost: refHost,
    geo,
    client,
  });
  if (!session) return reply(202, origin);

  const name = kind === "goal" ? str(p.n, 64).trim() : kind === "outbound" || kind === "checkout" ? outboundName(str(p.n, 2000)) : "";
  try {
    env.WEB?.writeDataPoint({
      indexes: [site.id],
      blobs: [
        kind,
        path,
        page.hostname.toLowerCase(),
        refHost,
        session.source,
        session.channel,
        session.utmSource,
        session.utmMedium,
        session.utmCampaign,
        geo.country,
        geo.region,
        geo.city,
        client.device,
        client.os,
        client.browser,
        session.id,
        visitorId,
        name,
        session.linkSlug,
        kind === "goal" ? goalProps(p.p) : client.language,
      ],
      // count, engaged ms, screen width, first event of a visit, scroll % (engage),
      // then (vitals) LCP ms, CLS × 1000 + 1, INP ms: 0 means not measured.
      doubles: [1, engagedMs, width, session.isNew ? 1 : 0, scroll, ...(vitals ? [vitals.lcp, vitals.cls, vitals.inp] : [])],
    });
  } catch (err) {
    console.error(JSON.stringify({ message: "web analytics write failed", site: site.id, error: String(err) }));
  }

  // A return page after checkout names the provider's ids: tie them to this visit.
  if (kind === "pageview" && Array.isArray(p.k) && p.k.length) {
    const refs = p.k.filter((r): r is string => typeof r === "string" && /^[A-Za-z0-9_:.-]{4,200}$/.test(r)).slice(0, 5);
    if (refs.length) ctx.waitUntil(claimRefs(env, site, session.id, visitorId, refs, now).catch((err: unknown) => console.error(JSON.stringify({ message: "payment claim failed", error: String(err) }))));
  }

  return reply(200, origin, { s: session.id, ...mode });
}

const metric = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(max, v) : 0);

/** A vitals event's numbers in the dataset's encoding (doubles 6–8); null when it measured nothing. */
export function vitalsOf(p: Pick<Payload, "lcp" | "cls" | "inp">): { lcp: number; cls: number; inp: number } | null {
  const lcp = Math.round(metric(p.lcp, 60_000));
  const inp = Math.round(metric(p.inp, 20_000));
  // A shift of 0 is a perfect score, so the stored value is offset by one.
  const cls = typeof p.cls === "number" && Number.isFinite(p.cls) && p.cls >= 0 ? Math.round(Math.min(10, p.cls) * 1000) + 1 : 0;
  if (!lcp && !inp) return null;
  return { lcp, cls: lcp ? cls : 0, inp };
}

/** The window width as a class: phone, tablet, laptop or wide ("" when not sent). */
export function screenClass(width: number): string {
  if (width <= 0) return "";
  if (width < 600) return "phone";
  if (width < 1024) return "tablet";
  if (width < 1600) return "laptop";
  return "wide";
}

/** An outbound link as origin + path: no query strings, which can carry personal data. */
function outboundName(raw: string): string {
  try {
    const u = new URL(raw);
    return truncateUtf8(`${u.hostname}${u.pathname === "/" ? "" : u.pathname}`, 200);
  } catch {
    return "";
  }
}

/** Goal properties as "k=v; k=v", capped (the goal props blob). */
function goalProps(props: unknown): string {
  if (!props || typeof props !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(props as Record<string, unknown>).slice(0, 10)) {
    if (/^[\w-]{1,32}$/.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) parts.push(`${k}=${String(v).slice(0, 60)}`);
  }
  return truncateUtf8(parts.join("; "), 300);
}

// The click path. A plain link is one KV read, then a 302; analytics is
// written afterwards via ctx.waitUntil. Some links wait for more before the
// response: a destination that may be a tracked site or a hosted checkout
// reads D1 (cached per isolate), a click limit asks its Durable Object, a
// password POST counts the attempt in D1, and a KV miss may try to recover a
// near-miss slug (KV reads, and D1 only on domains with mixed-case slugs).

import { isProbePath, isRoutableSlug } from "../shared/slug";
import { buildLocation, paramKey, renderUtm, splitOwnParams } from "../shared/target";
import { isPreviewCrawler } from "../shared/preview";
import { pickRoute, routeCountry, routeDevice } from "../shared/routing";
import { detectBot, detectBrowser, detectDevice, detectOs, logHit, PREFETCH, referrerHostOf, resolveSource, sendsPrivacySignal, siteHostOf } from "./analytics";
import { checkoutProvider, isCheckoutRefParam, withCheckoutRef, type CheckoutProvider } from "../shared/checkout";
import { newSessionId } from "./web/sessions";
import { deadLinkResponse, isUsableReplacement } from "./dead-link";
import { isKvLink, KV_TIMEOUT_MS, kvKey, OFF_HOME, splitKey, withTimeout, type KvLink, type KvRule } from "./db";
import { notFoundResponse, PAGE_HEADERS } from "./not-found";
import { shortOrigin } from "./domains";
import { capAdmit } from "./click-cap";
import { hasAccess, tryPassword } from "./link-password";
import { previewResponse } from "./preview";
import { limitPage, passwordPage, unavailablePage, unlockedPage, unsafePage } from "./protection-pages";
import { renderBio, type BioPage } from "../shared/bio";
import { limiterKey } from "./session";
import { connectedCheckoutProviders, trackedSiteFor } from "./web/sites";
import { sendClickWebhooks } from "./webhooks";
import { CLICK_PARAM, signClickToken } from "./web/token";
import { browserDetailsAllowed, browserDetailsPage, isAutomated, newClickId, recordTrackedClick, signBeacon } from "./tracking";

const MIN_CACHE_TTL = 30;
const DEFAULT_CACHE_TTL = 60;

const REDIRECT_HEADERS = {
  "Cache-Control": "private, max-age=0",
  "X-Robots-Tag": "noindex",
};

export function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { ...REDIRECT_HEADERS, Location: location } });
}

/**
 * A per-network brake for public pages that cost lookups (shared statistics
 * pages): a 429 once PUBLIC_LIMITER says no, otherwise null. A missing
 * binding or a limiter error lets the request through.
 */
export async function publicLimit(request: Request, env: Env): Promise<Response | null> {
  // Cloudflare always sets it; only local tools and tests go without.
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.PUBLIC_LIMITER) return null;
  try {
    const { success } = await env.PUBLIC_LIMITER.limit({ key: await limiterKey(env, "public", ip) });
    if (success) return null;
  } catch (err) {
    console.error(JSON.stringify({ message: "public rate limiter failed", error: String(err) }));
    return null;
  }
  return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
}

/**
 * Whether this click of a link with Advanced tracking is recorded. Each one is
 * a D1 row, lookups and a webhook delivery per subscriber, so one network's
 * clicks past PUBLIC_LIMITER's rate (its own "track" scope) still redirect but
 * aren't logged: a loop on a tracked link can't spend the day's D1 writes or
 * flood the receivers. A missing binding or a limiter error records it.
 */
export async function trackedClickAllowed(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !env.PUBLIC_LIMITER) return true;
  try {
    return (await env.PUBLIC_LIMITER.limit({ key: await limiterKey(env, "track", ip) })).success;
  } catch (err) {
    console.error(JSON.stringify({ message: "tracked click limiter failed", error: String(err) }));
    return true;
  }
}

/** Extracts the slug from a path: decoded once, one trailing "/" ignored. */
function slugFromPath(pathname: string): string | null {
  let raw = pathname.slice(1);
  if (raw.endsWith("/")) raw = raw.slice(0, -1);
  if (!raw || raw.length > 512) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Characters a pasted or quoted link picks up at its end ("see sh.example/guide)."). */
const TRAILING_JUNK_RE = /[.,;:!?)\]}>'"`*\u2019\u201D\u00BB\u2026]+$/;
/** The case-insensitive lookup must not hold up a not-found page. */
const RECOVERY_TIMEOUT_MS = 500;

/**
 * A near miss, after KV had nothing for the path as typed: the slug without
 * trailing punctuation, or the one link on this domain that matches apart
 * from case. Returns the slug to send the visitor to, or null. Scanner paths
 * are not looked up in D1, and two links that differ only by case are
 * ambiguous: neither is chosen.
 */
export async function recoverSlug(env: Env, domain: string, slug: string): Promise<string | null> {
  const candidate = slug.replace(TRAILING_JUNK_RE, "");
  if (!isRoutableSlug(candidate)) return null;
  try {
    if (candidate !== slug && (await readLink(env, kvKey(domain, candidate)))) return candidate;
    if (isProbePath(candidate)) return null;
    // With every slug on the domain in lower case, that form is the only possible match: one KV read, not D1 per miss.
    if (!(await hasMixedCaseSlugs(env.DB, domain))) {
      const lower = candidate.toLowerCase();
      return lower !== candidate && (await readLink(env, kvKey(domain, lower))) ? lower : null;
    }
    const { results } = await withTimeout(
      env.DB.prepare("SELECT slug FROM links WHERE domain = ?1 AND slug = ?2 COLLATE NOCASE LIMIT 2").bind(domain, candidate).all<{ slug: string }>(),
      RECOVERY_TIMEOUT_MS,
      "slug recovery read",
    );
    const found = results.length === 1 ? results[0]!.slug : null;
    // The same slug KV just missed would only redirect to another miss.
    return found !== null && found !== slug && found !== candidate ? found : null;
  } catch (err) {
    console.error(JSON.stringify({ message: "slug recovery failed", domain, slug: candidate, error: String(err) }));
    return null;
  }
}

const MIXED_CASE_TTL_MS = 60_000;
let mixedCase = new Map<string, { mixed: boolean; at: number }>();

/**
 * Whether any slug on the domain has a capital letter (one indexed read,
 * cached a minute per isolate, like a new link's KV miss). A failed read
 * counts as yes, so recovery looks in D1 as it would without this.
 */
async function hasMixedCaseSlugs(db: D1Database, domain: string): Promise<boolean> {
  const cached = mixedCase.get(domain);
  if (cached && Date.now() - cached.at < MIXED_CASE_TTL_MS) return cached.mixed;
  let mixed = true;
  try {
    const row = await withTimeout(db.prepare("SELECT 1 FROM links INDEXED BY links_mixed_case WHERE domain = ?1 AND slug != lower(slug) LIMIT 1").bind(domain).first(), RECOVERY_TIMEOUT_MS, "mixed-case slugs read");
    mixed = row !== null;
  } catch (err) {
    console.error(JSON.stringify({ message: "mixed-case slugs read failed", domain, error: String(err) }));
  }
  if (mixedCase.size >= 1000) mixedCase = new Map();
  mixedCase.set(domain, { mixed, at: Date.now() });
  return mixed;
}

export function resetSlugRecoveryCache(): void {
  mixedCase.clear();
}

function cacheTtl(env: Env): number {
  const n = Number(env.KV_CACHE_TTL);
  return Number.isFinite(n) && n >= MIN_CACHE_TTL ? Math.floor(n) : DEFAULT_CACHE_TTL;
}

async function readLink(env: Env, key: string): Promise<KvLink | null> {
  const value = await withTimeout(env.LINKS.get(key, { type: "json", cacheTtl: cacheTtl(env) }), KV_TIMEOUT_MS, "KV read");
  if (value === null) return null;
  if (!isKvLink(value)) throw new Error("Malformed KV record");
  return value;
}

/**
 * Smart routing for one request. Bots and link previews always get the
 * fallback, so previews stay stable and A/B results count people only. No
 * cookie is set: each visit is assigned afresh.
 */
export function chooseRoute(request: Request, rules: readonly KvRule[]): { url: string; key: string; variant: string } | null {
  const ua = request.headers.get("User-Agent") ?? "";
  const cf = request.cf as { country?: string; asn?: number } | undefined;
  // A prefetch comes from the visitor's own browser, which may show this very response.
  const bot = detectBot(request, ua, Number(cf?.asn ?? 0));
  if (bot && bot !== PREFETCH) return null;
  const device = routeDevice(detectOs(ua, request.headers.get("Sec-CH-UA-Platform")), detectDevice(ua, request.headers.get("Sec-CH-UA-Mobile")));
  const picked = pickRoute(rules, { device, country: routeCountry(cf?.country) }, Math.random());
  // A malformed record (no usable destination) gets the fallback.
  if (!picked || typeof picked.url !== "string" || !/^https?:\/\//i.test(picked.url)) return null;
  const rule = rules.find((r) => r.id === picked.ruleId);
  const variant = rule && rule.variants.length > 1 ? rule.variants.find((v) => v.id === picked.variantId)?.l : rule?.n;
  return { url: picked.url, key: picked.key, variant: variant || picked.key };
}

/**
 * Where a turned-off link sends visitors: the main site, or another link's
 * short URL (so its click is counted too) while that link still works. Null
 * shows the not-found page.
 */
async function offLocation(env: Env, off: string): Promise<string | null> {
  if (off === OFF_HOME) return env.FALLBACK_URL;
  const target = splitKey(off);
  if (!target) return null;
  try {
    const other = await readLink(env, kvKey(target.domain, target.slug));
    return isUsableReplacement(other) ? `https://${target.domain}/${encodeURIComponent(target.slug)}` : null;
  } catch (err) {
    console.error(JSON.stringify({ message: "kv read failed", domain: target.domain, slug: target.slug, error: String(err) }));
    return null;
  }
}

export async function handleRedirect(request: Request, env: Env, ctx: ExecutionContext, url: URL, domain: string): Promise<Response> {
  // POST only reaches a protected link's password form; anything else is turned away below.
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const notAllowed = () => new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

  const own = splitOwnParams(url.search);
  const slug = slugFromPath(url.pathname);

  // A near miss is sent to the link's own address, where everything (password, limits, routing, statistics) happens as usual.
  const canRecover = request.method === "GET" || request.method === "HEAD";
  const recovered = (canonical: string) => redirectTo(`${url.origin}/${encodeURIComponent(canonical)}${url.search}`);

  if (slug === null || !isRoutableSlug(slug)) {
    const near = slug !== null && canRecover ? await recoverSlug(env, domain, slug) : null;
    if (near) return recovered(near);
    ctx.waitUntil(logHit(request, env, url, { domain, slug: slug ?? url.pathname, kind: "miss", probe: true, sourceTag: own.sourceTag, qr: own.qr }));
    return notFoundResponse(env, domain, null);
  }

  let link: KvLink | null;
  try {
    link = await readLink(env, kvKey(domain, slug));
  } catch (err) {
    // KV is down or slow: never show an error to a visitor.
    console.error(JSON.stringify({ message: "kv read failed", domain, slug, error: String(err) }));
    return redirectTo(env.FALLBACK_URL);
  }

  if (request.method === "POST" && !link?.pw) return notAllowed();

  if (!link && canRecover) {
    const near = await recoverSlug(env, domain, slug);
    if (near) return recovered(near);
  }

  const expired = link !== null && link.e !== null && link.e * 1000 <= Date.now();
  // A visit to this link: the Analytics Engine data point, and with Advanced tracking the click log row. Returns the click's id.
  const hit = (route?: string): string => {
    const id = newClickId();
    ctx.waitUntil(logHit(request, env, url, { domain, slug, kind: "hit", sourceTag: own.sourceTag, qr: own.qr, route }));
    if (link?.tk) {
      ctx.waitUntil(
        trackedClickAllowed(request, env).then((ok) => (ok ? recordTrackedClick(request, env, url, { domain, slug, link, id, sourceTag: own.sourceTag, qr: own.qr }, ctx) : undefined)),
      );
    }
    return id;
  };
  if (link && link.a !== 1 && link.o && !expired) {
    // Turned off with somewhere to send visitors: still a visit to this link.
    const off = await offLocation(env, link.o);
    if (off) {
      hit();
      return redirectTo(off);
    }
  }

  if (!link || link.a !== 1 || expired) {
    ctx.waitUntil(logHit(request, env, url, { domain, slug, kind: "miss", probe: !link && isProbePath(slug), sourceTag: own.sourceTag, qr: own.qr }));
    return notFoundResponse(env, domain, slug);
  }

  if (link.b === 1) {
    // Still a visit to this link; the page points to the replacement, or on to a site.
    hit();
    const target = splitKey(link.r);
    let replacement: KvLink | null = null;
    if (target) {
      try {
        replacement = await readLink(env, kvKey(target.domain, target.slug));
      } catch (err) {
        console.error(JSON.stringify({ message: "kv read failed", domain: target.domain, slug: target.slug, error: String(err) }));
      }
    }
    return deadLinkResponse(env, domain, slug, target && { ...target, link: replacement });
  }

  const ua = request.headers.get("User-Agent") ?? "";
  const shortUrl = `${url.origin}/${encodeURIComponent(slug)}`;

  // Password first: nothing about the destination is revealed before it.
  if (link.pw) {
    // The access cookie is signed with SESSION_SECRET. A Deploy to Cloudflare install reads it
    // from D1; while that can't be read there is nothing to sign or check with, so hold the door.
    if (!env.SESSION_SECRET) {
      console.error(JSON.stringify({ message: "protected link needs SESSION_SECRET", domain, slug }));
      return unavailablePage(env, domain, slug);
    }
    if (request.method === "POST") {
      const attempt = await tryPassword(request, env, domain, slug, link.pw);
      // Back to the short link as a GET, which now redirects (and counts the click).
      if (attempt.ok) return unlockedPage(env, domain, slug, `${url.pathname}${url.search}`, attempt.cookie);
      if (attempt.reason === "limited") return passwordPage(env, domain, slug, { error: "Too many tries. Wait a minute, then try again.", status: 429, retryAfter: 60 });
      return passwordPage(env, domain, slug, { error: attempt.reason === "wrong" ? "That password isn't right. Check it and try again." : "Something went wrong. Try again.", status: 401 });
    }
    if (!(await hasAccess(request, env, domain, slug, link.pw))) {
      // A custom preview is the owner's choice to show; it never leads to the destination.
      if (link.og && isPreviewCrawler(ua)) return previewResponse(link.og, shortUrl, shortUrl, domain, request.method === "HEAD");
      return passwordPage(env, domain, slug, { error: null, status: 200 });
    }
  }

  // Click limit: everything that is sent on to the destination uses a click.
  // Link previews, prefetches and HEAD requests only look, so they aren't sent
  // on: anyone can claim to be one, and would otherwise get through for free.
  if (link.mc) {
    const lookOnly = request.method === "HEAD" || isPreviewCrawler(ua) || detectBot(request, ua, 0) === PREFETCH;
    try {
      const cap = await capAdmit(env, domain, slug, link.mc, !lookOnly, ctx, link.cs ?? 0);
      if (!cap.ok) return limitPage(env, domain, slug);
    } catch (err) {
      console.error(JSON.stringify({ message: "click counter failed", domain, slug, error: String(err) }));
      return unavailablePage(env, domain, slug);
    }
    if (lookOnly) {
      hit();
      if (link.og && isPreviewCrawler(ua)) return previewResponse(link.og, shortUrl, shortUrl, domain, request.method === "HEAD");
      return new Response(null, { status: 204, headers: REDIRECT_HEADERS });
    }
  }

  // A link-in-bio page: shown here instead of redirecting; its buttons are links of their own.
  if (link.bio) {
    let page: Response | null = null;
    try {
      page = bioResponse(env, request, link.bio, domain, slug, Boolean(link.pw || link.mc));
    } catch (err) {
      // A malformed page can't be drawn: on to the link's destination, like any other link.
      console.error(JSON.stringify({ message: "bio page failed", domain, slug, error: String(err) }));
    }
    if (page) {
      hit();
      return page;
    }
  }

  let routed: ReturnType<typeof chooseRoute> = null;
  try {
    routed = link.ro?.length ? chooseRoute(request, link.ro) : null;
  } catch (err) {
    // Malformed rules: the plain destination rather than an error.
    console.error(JSON.stringify({ message: "routing failed", domain, slug, error: String(err) }));
  }
  const target = routed?.url ?? link.u;
  let location = target;
  try {
    let utm: string | null = null;
    if (link.utm === 1 && link.t) {
      const source = link.t.includes("{source}")
        ? resolveSource(
            own.sourceTag,
            own.qr,
            request.headers.get("User-Agent") ?? "",
            referrerHostOf(request.headers.get("Referer"), url.hostname),
            siteHostOf(env),
          ).source
        : "";
      utm = renderUtm(link.t, { slug, source, domain, variant: routed?.variant });
    }
    location = buildLocation(target, link.qp === 1 ? visitorParams(target, own.passthrough) : [], utm);
  } catch (err) {
    // Fall back to the bare target rather than failing the click.
    console.error(JSON.stringify({ message: "location build failed", domain, slug, error: String(err) }));
  }

  try {
    location = await tagForTrackedSite(request, env, url, location, domain, slug, own.sourceTag, own.qr);
  } catch (err) {
    console.error(JSON.stringify({ message: "click token failed", domain, slug, error: String(err) }));
  }
  try {
    location = await tagForCheckout(request, env, ctx, url, location, domain, slug, own.sourceTag, own.qr);
  } catch (err) {
    console.error(JSON.stringify({ message: "checkout reference failed", domain, slug, error: String(err) }));
  }

  // A flagged destination: people see a warning with a way through; nothing is sent on automatically.
  // HEAD gets the same answer without the page, so it can't read where the link goes.
  if (link.w === 1) {
    hit();
    const page = await unsafePage(env, domain, slug, location);
    return request.method === "HEAD" ? new Response(null, { status: page.status, headers: page.headers }) : page;
  }

  const clickId = hit(link.ro?.length ? (routed?.key ?? "-") : undefined);
  ctx.waitUntil(clickWebhooks(request, env, url, domain, slug, own.sourceTag, own.qr));
  // Preview crawlers read the owner's preview; everyone else is redirected.
  if (link.og && isPreviewCrawler(request.headers.get("User-Agent") ?? "")) {
    return previewResponse(link.og, shortUrl, location, domain, request.method === "HEAD");
  }
  // Advanced tracking with browser details: people see a short page that reports back, then goes on (src/worker/tracking.ts).
  if (link.tk && link.tj === 1 && request.method === "GET" && env.SESSION_SECRET && !isAutomated(request) && (await browserDetailsAllowed(env))) {
    try {
      return browserDetailsPage(location, await signBeacon(env.SESSION_SECRET, clickId, Math.floor(Date.now() / 1000)));
    } catch (err) {
      console.error(JSON.stringify({ message: "browser details page failed", domain, slug, error: String(err) }));
    }
  }
  return redirectTo(location);
}

/**
 * What a visitor's query may add to a pass-through link. On a hosted checkout
 * never the payment reference: that is the owner's to set, or the redirect's
 * (tagForCheckout), and a visitor's own would credit the sale to any visit.
 */
function visitorParams(target: string, passthrough: string[]): string[] {
  let provider: CheckoutProvider | null = null;
  try {
    provider = checkoutProvider(new URL(target));
  } catch {
    // Not a URL: buildLocation appends as usual.
  }
  return provider ? passthrough.filter((pair) => !isCheckoutRefParam(paramKey(pair))) : passthrough;
}

/**
 * A link to one of the tracked websites carries a signed click token (?sh_c=)
 * naming that site, so the visit, and any payment it leads to, is credited to
 * this link (src/worker/web/token.ts). Bots and previews don't get one.
 */
async function tagForTrackedSite(request: Request, env: Env, url: URL, location: string, domain: string, slug: string, sourceTag: string | null, qr: boolean): Promise<string> {
  if (!env.SESSION_SECRET) return location;
  let host: string;
  try {
    host = new URL(location).hostname;
  } catch {
    return location;
  }
  const site = await trackedSiteFor(env.DB, host);
  if (!site) return location;
  const ua = request.headers.get("User-Agent") ?? "";
  if (detectBot(request, ua, Number((request.cf as { asn?: number } | undefined)?.asn ?? 0))) return location;
  const { source } = resolveSource(sourceTag, qr, ua, referrerHostOf(request.headers.get("Referer"), url.hostname));
  const token = await signClickToken(env.SESSION_SECRET, { domain, slug, source, at: Math.floor(Date.now() / 1000), site });
  return buildLocation(location, [], `${CLICK_PARAM}=${token}`);
}

/**
 * A link straight to a hosted checkout (Stripe Payment Links, Lemon Squeezy,
 * Dodo, Creem, Gumroad) carries a random reference in the checkout URL, and
 * the click is recorded under it (link_clicks). When the provider's webhook
 * brings the reference back, the sale is credited to this link
 * (sessionFromLinkClick in src/worker/revenue/match.ts). Only for people, and
 * only when that provider is connected on a site; no IP or visitor hash is kept.
 */
async function tagForCheckout(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  location: string,
  domain: string,
  slug: string,
  sourceTag: string | null,
  qr: boolean,
): Promise<string> {
  let provider: CheckoutProvider | null;
  try {
    provider = checkoutProvider(new URL(location));
  } catch {
    return location;
  }
  if (!provider) return location;
  // Global Privacy Control or Do Not Track: no reference, and no record of the click under one.
  if (sendsPrivacySignal(request)) return location;
  const ua = request.headers.get("User-Agent") ?? "";
  const cf = request.cf as { asn?: number; country?: string; region?: string; city?: string } | undefined;
  if (detectBot(request, ua, Number(cf?.asn ?? 0))) return location;
  if (!(await connectedCheckoutProviders(env.DB)).has(provider)) return location;
  const ref = newSessionId();
  const tagged = withCheckoutRef(location, ref);
  if (tagged === location) return location; // The owner set their own reference.
  const { source } = resolveSource(sourceTag, qr, ua, referrerHostOf(request.headers.get("Referer"), url.hostname));
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO link_clicks (ref, domain, slug, provider, source, country, region, city, device, os, browser, clicked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
      .bind(
        ref,
        domain,
        slug,
        provider,
        source,
        cf?.country ?? "",
        cf?.region ?? "",
        cf?.city ?? "",
        detectDevice(ua, request.headers.get("Sec-CH-UA-Mobile")),
        detectOs(ua, request.headers.get("Sec-CH-UA-Platform")),
        detectBrowser(ua),
        Math.floor(Date.now() / 1000),
      )
      .run()
      .then(
        () => undefined,
        (err: unknown) => console.error(JSON.stringify({ message: "checkout click record failed", domain, slug, error: String(err) })),
      ),
  );
  return tagged;
}

/** link.clicked for a person's click (src/worker/webhooks.ts): nothing when no webhook asks for it. */
async function clickWebhooks(request: Request, env: Env, url: URL, domain: string, slug: string, sourceTag: string | null, qr: boolean): Promise<void> {
  try {
    const ua = request.headers.get("User-Agent") ?? "";
    const cf = request.cf as { asn?: number; country?: string; city?: string } | undefined;
    if (detectBot(request, ua, Number(cf?.asn ?? 0))) return;
    const referrer = referrerHostOf(request.headers.get("Referer"), url.hostname);
    await sendClickWebhooks(env, {
      domain,
      slug,
      at: Math.floor(Date.now() / 1000),
      country: cf?.country ?? "",
      city: cf?.city ?? "",
      device: detectDevice(ua, request.headers.get("Sec-CH-UA-Mobile")),
      os: detectOs(ua, request.headers.get("Sec-CH-UA-Platform")),
      browser: detectBrowser(ua),
      source: resolveSource(sourceTag, qr, ua, referrer).source,
      referrer,
    }, fetch, request.headers.get("CF-Connecting-IP"));
  } catch (err) {
    console.error(JSON.stringify({ message: "click webhooks failed", domain, slug, error: String(err) }));
  }
}

function bioResponse(env: Env, request: Request, bio: BioPage, domain: string, slug: string, restricted: boolean): Response {
  if (typeof bio !== "object" || bio === null || !Array.isArray(bio.blocks)) throw new Error("Malformed bio record");
  const html = renderBio(bio, {
    domain,
    linkHref: (l) => `${shortOrigin(env, request, l.domain)}/${encodeURIComponent(l.slug)}?s=bio`,
    // The page's own address, without tags such as ?s=, for "Share this page".
    pageUrl: `${shortOrigin(env, request, domain)}/${encodeURIComponent(slug)}`,
  });
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      ...PAGE_HEADERS,
      // Indexable, unlike error pages: a bio page is meant to be found. Cached briefly at the browser.
      // Behind a password or a click limit it is neither: every view has to pass the check again.
      "Cache-Control": restricted ? "private, no-store" : "public, max-age=60",
      "X-Robots-Tag": restricted ? "noindex" : "all",
    },
  });
}

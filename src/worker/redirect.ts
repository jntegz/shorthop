// The click path: one KV read, then a 302. Nothing else runs before the
// response; analytics is written afterwards via ctx.waitUntil.

import { isProbePath, isRoutableSlug } from "../shared/slug";
import { buildLocation, renderUtm, splitOwnParams } from "../shared/target";
import { isPreviewCrawler } from "../shared/preview";
import { pickRoute, routeCountry, routeDevice } from "../shared/routing";
import { detectBot, detectDevice, detectOs, logHit, PREFETCH, referrerHostOf, resolveSource, siteHostOf } from "./analytics";
import { deadLinkResponse } from "./dead-link";
import { isKvLink, KV_TIMEOUT_MS, kvKey, splitKey, withTimeout, type KvLink, type KvRule } from "./db";
import { notFoundResponse } from "./not-found";
import { capAdmit } from "./click-cap";
import { hasAccess, tryPassword } from "./link-password";
import { previewResponse } from "./preview";
import { limitPage, passwordPage, unavailablePage, unlockedPage } from "./protection-pages";

const MIN_CACHE_TTL = 30;
const DEFAULT_CACHE_TTL = 60;

const REDIRECT_HEADERS = {
  "Cache-Control": "private, max-age=0",
  "X-Robots-Tag": "noindex",
  // After one HTTPS visit, browsers never ask this domain over plain HTTP, where a redirect could be altered.
  "Strict-Transport-Security": "max-age=31536000",
};

export function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { ...REDIRECT_HEADERS, Location: location } });
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
  if (!picked) return null;
  const rule = rules.find((r) => r.id === picked.ruleId);
  const variant = rule && rule.variants.length > 1 ? rule.variants.find((v) => v.id === picked.variantId)?.l : rule?.n;
  return { url: picked.url, key: picked.key, variant: variant || picked.key };
}

export async function handleRedirect(request: Request, env: Env, ctx: ExecutionContext, url: URL, domain: string): Promise<Response> {
  // POST only reaches a protected link's password form; anything else is turned away below.
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const notAllowed = () => new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

  const own = splitOwnParams(url.search);
  const slug = slugFromPath(url.pathname);

  if (slug === null || !isRoutableSlug(slug)) {
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

  if (!link || link.a !== 1 || (link.e !== null && link.e * 1000 <= Date.now())) {
    ctx.waitUntil(logHit(request, env, url, { domain, slug, kind: "miss", probe: !link && isProbePath(slug), sourceTag: own.sourceTag, qr: own.qr }));
    return notFoundResponse(env, domain, slug);
  }

  if (link.b === 1) {
    // Still a visit to this link; the page points to the replacement, or on to a site.
    ctx.waitUntil(logHit(request, env, url, { domain, slug, kind: "hit", sourceTag: own.sourceTag, qr: own.qr }));
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

  // Click limit: people use one click each; bots, previews and prefetches only look.
  if (link.mc) {
    const bot = detectBot(request, ua, Number((request.cf as { asn?: number } | undefined)?.asn ?? 0));
    try {
      const cap = await capAdmit(env, domain, slug, link.mc, !bot, ctx);
      if (!cap.ok) return limitPage(env, domain, slug);
    } catch (err) {
      console.error(JSON.stringify({ message: "click counter failed", domain, slug, error: String(err) }));
      return unavailablePage(env, domain, slug);
    }
  }

  const routed = link.ro?.length ? chooseRoute(request, link.ro) : null;
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
    location = buildLocation(target, link.qp === 1 ? own.passthrough : [], utm);
  } catch (err) {
    // Fall back to the bare target rather than failing the click.
    console.error(JSON.stringify({ message: "location build failed", domain, slug, error: String(err) }));
  }

  ctx.waitUntil(logHit(request, env, url, { domain, slug, kind: "hit", sourceTag: own.sourceTag, qr: own.qr, route: link.ro?.length ? (routed?.key ?? "-") : undefined }));
  // Preview crawlers read the owner's preview; everyone else is redirected.
  if (link.og && isPreviewCrawler(request.headers.get("User-Agent") ?? "")) {
    return previewResponse(link.og, shortUrl, location, domain, request.method === "HEAD");
  }
  return redirectTo(location);
}

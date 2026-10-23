// The click path: one KV read, then a 302. Nothing else runs before the
// response; analytics is written afterwards via ctx.waitUntil.

import { isProbePath, isRoutableSlug } from "../shared/slug";
import { buildLocation, renderUtm, splitOwnParams } from "../shared/target";
import { pickRoute, routeCountry, routeDevice } from "../shared/routing";
import { detectBot, detectDevice, detectOs, logHit, PREFETCH, referrerHostOf, resolveSource, siteHostOf } from "./analytics";
import { deadLinkResponse } from "./dead-link";
import { isKvLink, KV_TIMEOUT_MS, kvKey, splitKey, withTimeout, type KvLink, type KvRule } from "./db";
import { notFoundResponse } from "./not-found";

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
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

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
  return redirectTo(location);
}

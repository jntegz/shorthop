// Links marked "no longer working". The wording lives in KV next to the
// not-found settings (a key without a "/") and is kept in memory per isolate,
// like the not-found page. The replacement is read at click time, so deleting,
// disabling or breaking it needs no cleanup: visitors are then sent on to a site.

import { deadLinkRedirectUrl, DEFAULT_DEAD_LINK, normalizeDeadLink, renderDeadLink, type DeadLinkPage, type DeadLinkVariant } from "../shared/dead-link";
import { NOT_FOUND_IMAGE_PATH } from "../shared/not-found";
import { KV_TIMEOUT_MS, withTimeout, type KvLink } from "./db";
import { PAGE_HEADERS, publicNotFoundPage } from "./not-found";

const CONFIG_KEY = "cfg:dead-link";
const CACHE_TTL = 60;
const RETRY_AFTER_FAILURE_MS = 5_000;

async function readPage(env: Env, cached: boolean): Promise<DeadLinkPage> {
  const config = await env.LINKS.get<Partial<DeadLinkPage>>(CONFIG_KEY, cached ? { type: "json", cacheTtl: CACHE_TTL } : { type: "json" });
  return normalizeDeadLink(config);
}

/** For the admin: uncached, and a failed read throws rather than looking like the defaults. */
export function getDeadLinkPage(env: Env): Promise<DeadLinkPage> {
  return readPage(env, false);
}

let memo: { page: DeadLinkPage; until: number } | null = null;

/** Forgets the in-memory copy (after a save, and between tests). */
export function resetDeadLinkCache(): void {
  memo = null;
}

async function publicDeadLinkPage(env: Env): Promise<DeadLinkPage> {
  const now = Date.now();
  if (memo && now < memo.until) return memo.page;
  try {
    const page = await withTimeout(readPage(env, true), KV_TIMEOUT_MS, "KV read");
    memo = { page, until: now + CACHE_TTL * 1000 };
    return page;
  } catch (err) {
    console.error(JSON.stringify({ message: "dead-link page read failed", error: String(err) }));
    memo = { page: DEFAULT_DEAD_LINK, until: now + RETRY_AFTER_FAILURE_MS };
    return DEFAULT_DEAD_LINK;
  }
}

export async function saveDeadLinkSettings(env: Env, page: DeadLinkPage): Promise<void> {
  await env.LINKS.put(CONFIG_KEY, JSON.stringify(page));
  resetDeadLinkCache();
}

/** A replacement visitors can be sent to: active, not expired, and not itself marked as not working. */
export function isUsableReplacement(link: KvLink | null): link is KvLink {
  return !!link && link.a === 1 && (link.e === null || link.e * 1000 > Date.now()) && link.b !== 1;
}

/**
 * The page for a link marked "no longer working". `replacement` is the
 * replacement's KV record, or null when there is none or it can't be used.
 */
export async function deadLinkResponse(
  env: Env,
  domain: string,
  slug: string,
  replacement: { domain: string; slug: string; link: KvLink | null } | null,
): Promise<Response> {
  const [page, style] = await Promise.all([publicDeadLinkPage(env), publicNotFoundPage(env)]);
  let variant: DeadLinkVariant;
  if (replacement && isUsableReplacement(replacement.link)) {
    // The replacement's short link, so its click is counted too.
    const href = `https://${replacement.domain}/${encodeURIComponent(replacement.slug)}`;
    variant = { kind: "replaced", href, label: `${replacement.domain}/${replacement.slug}` };
  } else {
    variant = { kind: "gone", redirectUrl: deadLinkRedirectUrl(page, style, env.FALLBACK_URL) };
  }
  const html = renderDeadLink(
    page,
    style,
    {
      domain,
      address: `${domain}/${slug.length > 80 ? `${slug.slice(0, 80)}…` : slug}`,
      imageSrc: style.image ? `${NOT_FOUND_IMAGE_PATH}?v=${style.image.v}` : null,
    },
    variant,
  );
  return new Response(html, { status: 410, headers: PAGE_HEADERS });
}


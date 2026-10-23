// The owner's not-found page: its settings and image live in KV next to the
// links (keys without a "/", so they never collide with "domain/slug"). A 404
// mustn't cost a KV read each time (scanners send thousands), so the settings
// are kept in memory per isolate and the image in the edge cache.

import {
  DEFAULT_NOT_FOUND,
  NOT_FOUND_IMAGE_PATH,
  normalizeNotFound,
  renderNotFound,
  type NotFoundImage,
  type NotFoundImageType,
  type NotFoundPage,
} from "../shared/not-found";
import { KV_TIMEOUT_MS, withTimeout } from "./db";

/** Text and colors. */
const CONFIG_KEY = "cfg:not-found";
/** { v, type } of the current image; kept apart so no write has to read the other part first. */
const IMAGE_META_KEY = "cfg:not-found-image-meta";
/** The image bytes, with the same { v, type } as metadata. */
const IMAGE_KEY = "cfg:not-found-image";
const CACHE_TTL = 60;

export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, max-age=0",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export type NotFoundSettings = Omit<NotFoundPage, "image">;

async function readPage(env: Env, cached: boolean): Promise<NotFoundPage> {
  const opts = cached ? ({ type: "json", cacheTtl: CACHE_TTL } as const) : ({ type: "json" } as const);
  const [config, image] = await Promise.all([
    env.LINKS.get<Partial<NotFoundSettings>>(CONFIG_KEY, opts),
    env.LINKS.get<NotFoundImage>(IMAGE_META_KEY, opts),
  ]);
  return normalizeNotFound({ ...config, image });
}

/** For the admin: uncached, and a failed read throws rather than looking like the defaults. */
export function getNotFoundPage(env: Env): Promise<NotFoundPage> {
  return readPage(env, false);
}

let memo: { page: NotFoundPage; until: number } | null = null;
/** After a failed read the defaults are served briefly, then KV is tried again. */
const RETRY_AFTER_FAILURE_MS = 5_000;

/** Forgets the in-memory copy (after a save, and between tests). */
export function resetNotFoundCache(): void {
  memo = null;
}

/** For visitors: from memory for CACHE_TTL seconds, then KV, time-boxed; the defaults on any failure. */
export async function publicNotFoundPage(env: Env): Promise<NotFoundPage> {
  if (memo && Date.now() < memo.until) return memo.page;
  try {
    const page = await withTimeout(readPage(env, true), KV_TIMEOUT_MS, "KV read");
    memo = { page, until: Date.now() + CACHE_TTL * 1000 };
    return page;
  } catch (err) {
    console.error(JSON.stringify({ message: "not-found page read failed", error: String(err) }));
    memo = { page: DEFAULT_NOT_FOUND, until: Date.now() + RETRY_AFTER_FAILURE_MS };
    return DEFAULT_NOT_FOUND;
  }
}

export async function saveNotFoundSettings(env: Env, settings: NotFoundSettings): Promise<void> {
  await env.LINKS.put(CONFIG_KEY, JSON.stringify(settings));
  resetNotFoundCache();
}

/** Stores the image, then points the page at it. */
export async function saveNotFoundImage(env: Env, bytes: ArrayBuffer, type: NotFoundImageType): Promise<NotFoundImage> {
  const image: NotFoundImage = { v: Date.now(), type };
  await env.LINKS.put(IMAGE_KEY, bytes, { metadata: image });
  await env.LINKS.put(IMAGE_META_KEY, JSON.stringify(image));
  resetNotFoundCache();
  return image;
}

/** Unlinks the image from the page first, so the page never points at a missing file. */
export async function deleteNotFoundImage(env: Env): Promise<void> {
  await env.LINKS.delete(IMAGE_META_KEY);
  await env.LINKS.delete(IMAGE_KEY);
  resetNotFoundCache();
}

/** The stored image; `fresh` skips the edge cache (the admin reads right after an upload). */
export async function notFoundImage(env: Env, fresh = false): Promise<{ bytes: ArrayBuffer; type: string; v: number } | null> {
  const { value, metadata } = await env.LINKS.getWithMetadata<{ type: string; v: number }>(
    IMAGE_KEY,
    fresh ? { type: "arrayBuffer" } : { type: "arrayBuffer", cacheTtl: CACHE_TTL },
  );
  return value && metadata ? { bytes: value, type: metadata.type, v: metadata.v } : null;
}

/**
 * GET /_404.img?v=… on a short domain. A matching version is kept in the edge
 * cache, so repeat views cost no KV read. Right after a replace, an edge may
 * still hold the old image: that answer isn't cached under the new version.
 */
export async function serveNotFoundImage(env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const cache = await caches.open("not-found-image");
  // Keyed on the version alone, so extra query parameters can't each cost a KV read.
  const key = `${url.origin}${url.pathname}?v=${encodeURIComponent(url.searchParams.get("v") ?? "")}`;
  const hit = await cache.match(key);
  if (hit) return hit;
  const img = await notFoundImage(env).catch(() => null);
  if (!img) return new Response("Not found", { status: 404 });
  const current = url.searchParams.get("v") === String(img.v);
  const res = new Response(img.bytes, {
    headers: {
      "Content-Type": img.type,
      "Cache-Control": current ? "public, max-age=86400, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
  if (current) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** Signature checks, so only real images of the allowed types are stored. */
export function sniffImageType(bytes: Uint8Array): NotFoundImageType | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, j) => bytes[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** The 404 a visitor gets for an unknown, disabled or expired link. */
export async function notFoundResponse(env: Env, domain: string, slug: string | null): Promise<Response> {
  const page = await publicNotFoundPage(env);
  const html = renderNotFound(page, {
    domain,
    address: slug ? `${domain}/${slug.length > 80 ? `${slug.slice(0, 80)}…` : slug}` : null,
    fallbackUrl: env.FALLBACK_URL,
    imageSrc: page.image ? `${NOT_FOUND_IMAGE_PATH}?v=${page.image.v}` : null,
  });
  return new Response(html, { status: 404, headers: PAGE_HEADERS });
}

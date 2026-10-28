// Custom social previews: the page preview crawlers get, uploaded preview
// images (KV, served from /_og/ on every short domain), and reading a
// destination's own preview so the editor can start from it.

import { escapeHtml } from "../shared/html";
import { isFetchableUrl } from "../shared/link-check";
import {
  EXTENSION,
  imageSize,
  PREVIEW_IMAGE_KEY_RE,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_PATH,
  TYPE_OF_EXTENSION,
  type PreviewImageType,
} from "../shared/preview";
import { nowSec } from "./db";
import { CHECK_USER_AGENT } from "./link-check";
import { sniffImageType } from "./not-found";
import { HSTS } from "./pages";
import { planLimits } from "./plan";

/** The preview as the redirect needs it (in the link's KV record). */
export interface KvPreview {
  t: string;
  d: string;
  /** Absolute image URL, or a PREVIEW_IMAGE_PATH path on the short domain. */
  i: string | null;
  w?: number;
  h?: number;
}

const kvImageKey = (key: string) => `og:${key}`;
/** Unreferenced uploads (an editor closed without saving) are deleted after this. */
const ORPHAN_AFTER_SEC = 86400;

/**
 * The page a preview crawler gets instead of the redirect: the owner's title,
 * description and image as Open Graph and Twitter tags. Anyone else who lands
 * here is sent on to the destination at once.
 */
export function previewResponse(p: KvPreview, shortUrl: string, location: string, domain: string, head: boolean): Response {
  const origin = new URL(shortUrl).origin;
  const image = p.i ? (p.i.startsWith("/") ? `${origin}${p.i}` : p.i) : null;
  const e = escapeHtml;
  const meta = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${e(shortUrl)}">`,
    `<meta property="og:site_name" content="${e(domain)}">`,
    `<meta property="og:title" content="${e(p.t)}">`,
    p.d ? `<meta property="og:description" content="${e(p.d)}"><meta name="description" content="${e(p.d)}">` : "",
    image ? `<meta property="og:image" content="${e(image)}"><meta property="og:image:alt" content="${e(p.t)}">` : "",
    image && p.w && p.h ? `<meta property="og:image:width" content="${p.w}"><meta property="og:image:height" content="${p.h}">` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${e(p.t)}">`,
    p.d ? `<meta name="twitter:description" content="${e(p.d)}">` : "",
    image ? `<meta name="twitter:image" content="${e(image)}">` : "",
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(p.t)}</title>
${meta}
<meta http-equiv="refresh" content="0;url=${e(location)}">
</head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222438">
<h1 style="font-size:1.25rem">${e(p.t)}</h1>
${p.d ? `<p>${e(p.d)}</p>` : ""}
<p><a href="${e(location)}">Continue</a></p>
</body></html>`;
  return new Response(head ? null : html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=0",
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": "default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": HSTS,
    },
  });
}

export type UploadResult =
  | { ok: true; key: string; width: number | null; height: number | null; type: PreviewImageType; bytes: number }
  | { ok: false; status: 400 | 413; error: string };

/** Stores an uploaded preview image under a new random key. */
export async function savePreviewImage(env: Env, bytes: ArrayBuffer): Promise<UploadResult> {
  if (bytes.byteLength > PREVIEW_IMAGE_MAX_BYTES) return { ok: false, status: 413, error: "The image must be 5 MB or smaller." };
  const head = new Uint8Array(bytes);
  const type = sniffImageType(head);
  if (!type) return { ok: false, status: 400, error: "Use a PNG, JPEG, GIF or WebP image." };
  const size = imageSize(head);
  const rand = new Uint8Array(20);
  crypto.getRandomValues(rand);
  const key = `${[...rand].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}.${EXTENSION[type]}`;
  await env.LINKS.put(kvImageKey(key), bytes, { metadata: { type } });
  await env.DB.prepare("INSERT INTO preview_images (key, created_at, bytes, width, height) VALUES (?, ?, ?, ?, ?)")
    .bind(key, nowSec(), bytes.byteLength, size?.width ?? null, size?.height ?? null)
    .run();
  return { ok: true, key, width: size?.width ?? null, height: size?.height ?? null, type, bytes: bytes.byteLength };
}

/** GET /_og/<key>: an uploaded preview image. Keys never change content, so it's cached for good. */
export async function servePreviewImage(env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const key = url.pathname.slice(PREVIEW_IMAGE_PATH.length);
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!PREVIEW_IMAGE_KEY_RE.test(key)) return notFound();
  const cacheKey = new URL(`${PREVIEW_IMAGE_PATH}${key}`, url).toString();
  const cache = await caches.open("preview-images");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const bytes = await env.LINKS.get(kvImageKey(key), { type: "arrayBuffer" }).catch(() => null);
  if (!bytes) return notFound();
  const res = new Response(bytes, {
    headers: {
      "Content-Type": TYPE_OF_EXTENSION[key.split(".")[1]!]!,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Strict-Transport-Security": HSTS,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/** Daily: deletes uploads (preview images, QR logos) nothing uses, once they're a day old; a plan-sized batch per run (two calls each). */
export async function prunePreviewImages(env: Env, now = nowSec()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT key FROM preview_images p WHERE created_at < ?1
     AND NOT EXISTS (SELECT 1 FROM links WHERE instr(preview, p.key) > 0 OR instr(qr, p.key) > 0)
     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'qr_default' AND instr(value, p.key) > 0)
     AND NOT EXISTS (SELECT 1 FROM link_versions WHERE instr(snapshot, p.key) > 0)
     LIMIT ?2`,
  )
    .bind(now - ORPHAN_AFTER_SEC, planLimits(env).prunedUploads)
    .all<{ key: string }>();
  // A row goes only once its blob has; one that failed is tried again tomorrow.
  const settled = await Promise.allSettled(results.map(({ key }) => env.LINKS.delete(kvImageKey(key))));
  const gone = results.filter((_, i) => settled[i]?.status === "fulfilled").map((r) => r.key);
  if (gone.length) await env.DB.prepare("DELETE FROM preview_images WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(gone)).run();
  return gone.length;
}

export interface FetchedPreview {
  title: string;
  description: string;
  image: string | null;
  /** Where redirects ended. */
  url: string;
}

const MAX_HTML_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 8000;

/**
 * Reads a destination's own preview (Open Graph, Twitter or plain HTML tags)
 * so the editor can start from it. The same outbound safety as destination
 * checks: public hosts only, every redirect hop rechecked, a size and time cap.
 */
export async function fetchDestinationPreview(target: string, fetcher: typeof fetch = fetch): Promise<FetchedPreview | { error: string }> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { error: "That isn't a valid URL." };
  }
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let res: Response | null = null;
  try {
    for (let hops = 0; hops <= 5; hops++) {
      if (!isFetchableUrl(url)) return { error: "That address can't be read from here." };
      res = await fetcher(url.href, {
        redirect: "manual",
        headers: { "User-Agent": CHECK_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      const location = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        url = new URL(location, url);
        res = null;
        continue;
      }
      break;
    }
  } catch (err) {
    return { error: /timeout|abort/i.test(String(err)) ? "The page didn't answer within 8 seconds." : "Couldn't reach the page." };
  }
  if (!res) return { error: "The page redirects too many times." };
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { error: `The page answered with HTTP ${res.status}.` };
  }
  if (!/html/i.test(res.headers.get("Content-Type") ?? "")) {
    await res.body?.cancel().catch(() => undefined);
    return { error: "That address isn't a web page." };
  }

  // Only the start of the page is needed: the tags live in <head>.
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const html = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    html.set(c, at);
    at += c.byteLength;
  }

  const found: Record<string, string> = {};
  let docTitle = "";
  const take = (key: string, value: string | null) => {
    if (value && !found[key]) found[key] = value.trim();
  };
  await new HTMLRewriter()
    .on("meta", {
      element(el) {
        const name = (el.getAttribute("property") ?? el.getAttribute("name") ?? "").toLowerCase();
        if (["og:title", "og:description", "og:image", "og:image:url", "twitter:title", "twitter:description", "twitter:image", "description"].includes(name)) take(name, el.getAttribute("content"));
      },
    })
    .on("title", {
      text(t) {
        docTitle += t.text;
      },
    })
    .transform(new Response(html))
    .arrayBuffer();

  const decode = (s: string) =>
    s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" })[m] ?? m);
  const title = decode(found["og:title"] ?? found["twitter:title"] ?? docTitle.trim());
  const description = decode(found["og:description"] ?? found["twitter:description"] ?? found.description ?? "");
  let image: string | null = null;
  const rawImage = found["og:image"] ?? found["og:image:url"] ?? found["twitter:image"];
  if (rawImage) {
    try {
      const abs = new URL(decode(rawImage), url);
      if (abs.protocol === "https:") image = abs.href;
    } catch {
      image = null;
    }
  }
  return { title: title.replace(/\s+/g, " ").slice(0, 300), description: description.replace(/\s+/g, " ").slice(0, 600), image, url: url.href };
}

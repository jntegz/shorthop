// The page visitors see for an unknown, disabled or expired link. The owner
// edits its text, colors and image in Settings; the Worker renders it and the
// admin previews it with the same function.

import { escapeHtml } from "./html";

export interface NotFoundImage {
  /** Bumped on every upload, so cached copies are replaced. */
  v: number;
  type: NotFoundImageType;
}

export interface NotFoundPage {
  heading: string;
  message: string;
  /** Empty hides the button. */
  buttonLabel: string;
  /** Empty means FALLBACK_URL. */
  buttonUrl: string;
  background: string;
  card: string;
  text: string;
  accent: string;
  image: NotFoundImage | null;
}

export const NOT_FOUND_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type NotFoundImageType = (typeof NOT_FOUND_IMAGE_TYPES)[number];
export const NOT_FOUND_IMAGE_MAX_BYTES = 512 * 1024;
/** Served on every short domain; not a valid slug, so it can't shadow a link. */
export const NOT_FOUND_IMAGE_PATH = "/_404.img";
/** Shows the page without logging a miss; also not a valid slug. */
export const NOT_FOUND_PREVIEW_PATH = "/_404";

export const DEFAULT_NOT_FOUND: NotFoundPage = {
  heading: "This link doesn't exist or has expired",
  message: "Check the address for typos, or head to the homepage.",
  buttonLabel: "Go to the homepage",
  buttonUrl: "",
  background: "#f8f9fc",
  card: "#ffffff",
  text: "#222438",
  accent: "#6554c0",
  image: null,
};

export const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/** Black or white, whichever reads better on `hex`. */
function onColor(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  return l > 0.4 ? "#111111" : "#ffffff";
}

/** Keeps a stored or draft page safe to render: bad colors fall back to the defaults. */
export function normalizeNotFound(p: Partial<NotFoundPage> | null | undefined): NotFoundPage {
  const v = { ...DEFAULT_NOT_FOUND, ...p };
  const color = (k: "background" | "card" | "text" | "accent") => (HEX_COLOR_RE.test(v[k]) ? v[k] : DEFAULT_NOT_FOUND[k]);
  return {
    heading: String(v.heading || DEFAULT_NOT_FOUND.heading),
    message: String(v.message ?? ""),
    buttonLabel: String(v.buttonLabel ?? ""),
    buttonUrl: /^https?:\/\//i.test(String(v.buttonUrl)) ? String(v.buttonUrl) : "",
    background: color("background"),
    card: color("card"),
    text: color("text"),
    accent: color("accent"),
    image: v.image && typeof v.image.v === "number" && (NOT_FOUND_IMAGE_TYPES as readonly string[]).includes(v.image.type) ? v.image : null,
  };
}

/**
 * The full HTML document. `address` is what the visitor asked for
 * ("sh.example/gg"); `imageSrc` is where the page's image is served from.
 */
export function renderNotFound(p: NotFoundPage, opts: { domain: string; address: string | null; fallbackUrl: string; imageSrc: string | null }): string {
  const href = p.buttonUrl || opts.fallbackUrl;
  const message = escapeHtml(p.message).replace(/\r?\n/g, "<br>");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Link not found · ${escapeHtml(opts.domain)}</title>
<style>
  :root { --bg:${p.background}; --card:${p.card}; --fg:${p.text}; --accent:${p.accent}; --on-accent:${onColor(p.accent)};
          --muted:color-mix(in srgb, var(--fg) 68%, var(--card)); --line:color-mix(in srgb, var(--fg) 12%, var(--card)); }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--fg);
         font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { position:relative; width:100%; max-width:480px; background:var(--card); border:1px solid var(--line); border-radius:24px;
         padding:40px 36px 36px; box-shadow:0 24px 60px color-mix(in srgb, var(--fg) 8%, transparent); text-align:center; overflow:hidden; }
  .code { font-size:88px; line-height:1; font-weight:800; letter-spacing:-0.04em; color:color-mix(in srgb, var(--accent) 14%, var(--card)); margin:0 0 4px; user-select:none; }
  img { display:block; max-width:100%; max-height:220px; margin:0 auto 20px; border-radius:16px; object-fit:contain; }
  .mark { font-weight:700; font-size:13px; letter-spacing:0.02em; color:var(--accent); }
  h1 { font-size:24px; line-height:1.25; margin:10px 0 10px; letter-spacing:-0.015em; text-wrap:balance; }
  .addr { display:inline-block; max-width:100%; margin:0 0 16px; padding:4px 10px; border-radius:999px; background:color-mix(in srgb, var(--fg) 6%, var(--card));
          color:var(--muted); font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap:anywhere; text-decoration:line-through;
          text-decoration-color:color-mix(in srgb, var(--fg) 30%, transparent); }
  p { margin:0 0 24px; color:var(--muted); text-wrap:pretty; }
  a.btn { display:inline-flex; align-items:center; gap:8px; background:var(--accent); color:var(--on-accent); text-decoration:none;
          padding:12px 20px; border-radius:12px; font-weight:600; transition:transform .15s ease, box-shadow .15s ease; }
  a.btn:hover { transform:translateY(-1px); box-shadow:0 8px 20px color-mix(in srgb, var(--accent) 30%, transparent); }
  a.btn:focus-visible { outline:2px solid var(--fg); outline-offset:3px; }
  @media (max-width:420px) { main { padding:32px 22px 28px; } .code { font-size:72px; } h1 { font-size:21px; } }
  @media (prefers-reduced-motion:reduce) { a.btn { transition:none; } a.btn:hover { transform:none; } }
</style>
</head>
<body>
<main>
  ${opts.imageSrc ? `<img src="${escapeHtml(opts.imageSrc)}" alt="">` : `<div class="code" aria-hidden="true">404</div>`}
  <div class="mark">${escapeHtml(opts.domain)}</div>
  <h1>${escapeHtml(p.heading)}</h1>
  ${opts.address ? `<div class="addr">${escapeHtml(opts.address)}</div>` : ""}
  ${message ? `<p>${message}</p>` : ""}
  ${p.buttonLabel ? `<a class="btn" href="${escapeHtml(href)}">${escapeHtml(p.buttonLabel)} <span aria-hidden="true">→</span></a>` : ""}
</main>
</body>
</html>`;
}

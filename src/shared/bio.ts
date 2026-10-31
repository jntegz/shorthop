// Link-in-bio pages: a short link whose address shows a page of buttons
// instead of redirecting. Each button can be another short link, so its clicks,
// routing and revenue (checkout links too) are counted like any link's. Between
// the buttons: short texts and section titles. Social icons sit under the name
// or at the end, and a "Share this page" panel can follow. The Worker renders
// the page with no script; the admin previews it with the same function.

import { SHARE_ICON, SOCIAL_NETWORKS, type SocialNetwork } from "./bio-icons";
import { escapeHtml } from "./html";
import { HEX_COLOR_RE } from "./not-found";
import { PREVIEW_IMAGE_PATH } from "./preview";

export { SOCIAL_NETWORK_IDS, SOCIAL_NETWORKS, type SocialNetwork } from "./bio-icons";

export const BIO_THEMES = ["auto", "light", "dark"] as const;
export type BioTheme = (typeof BIO_THEMES)[number];
export const MAX_BIO_BLOCKS = 30;
export const MAX_BIO_SOCIALS = 12;
/** A text block holds as much as a post on X. */
export const BIO_TEXT_BLOCK_MAX = 280;
export const BIO_HEADING_MAX = 60;
/** Where the social icons go: under the name and text, or after everything else. */
export const BIO_SOCIAL_PLACES = ["top", "bottom"] as const;
export type BioSocialPlace = (typeof BIO_SOCIAL_PLACES)[number];

export type BioButton = { label: string; link: { domain: string; slug: string } } | { label: string; url: string };
export type BioTextBlock = { type: "text"; text: string };
/** A section title: starts a group of the buttons under it. */
export type BioHeadingBlock = { type: "heading"; label: string };
/** Buttons have no `type` (pages saved before texts and sections existed are all buttons). */
export type BioBlock = BioButton | BioTextBlock | BioHeadingBlock;

export function isBioButton(b: BioBlock): b is BioButton {
  return !("type" in b);
}

export interface BioSocial {
  network: SocialNetwork;
  /** https://… for networks and websites, mailto:… for email. */
  url: string;
}

export interface BioPage {
  name: string;
  text: string;
  /** An uploaded image (the same uploads as social previews), shown round above the name. */
  avatarKey: string | null;
  theme: BioTheme;
  /** The first button's colour (and the focus ring). */
  accent: string;
  blocks: BioBlock[];
  // Added later: pages saved before lack these and get the defaults.
  socials?: BioSocial[];
  socialsAt?: BioSocialPlace;
  /** Shows a "Share this page" panel at the end. */
  share?: boolean;
  /** Own colours; null follows the theme. A background sets the text colour to match and ignores the theme. */
  background?: string | null;
  buttonColor?: string | null;
  iconColor?: string | null;
}

export const DEFAULT_BIO: BioPage = {
  name: "",
  text: "",
  avatarKey: null,
  theme: "auto",
  accent: "#6554c0",
  blocks: [],
  socials: [],
  socialsAt: "top",
  share: false,
  background: null,
  buttonColor: null,
  iconColor: null,
};

export type BioProblem = { field: string; message: string };

const HTTPS_RE = /^https:\/\/[^\s/]+\.[^\s]+/;
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** An email social link as stored: "mailto:you@example.com" (the editor may send it without mailto:). */
function tidySocialUrl(network: SocialNetwork, raw: string): string {
  const url = raw.trim();
  if (network !== "email") return url;
  const address = url.replace(/^mailto:/i, "");
  return `mailto:${address}`;
}

/** Checks a bio page from the editor or the API; returns it tidied. */
export function validateBio(input: BioPage): { ok: true; bio: BioPage } | { ok: false; problems: BioProblem[] } {
  const problems: BioProblem[] = [];
  const name = String(input.name ?? "").trim();
  const text = String(input.text ?? "").trim();
  if (!name) problems.push({ field: "name", message: "Add a name or title." });
  if (name.length > 80) problems.push({ field: "name", message: "Keep the name to 80 characters." });
  if (text.length > 300) problems.push({ field: "text", message: "Keep the text to 300 characters." });
  if (!(BIO_THEMES as readonly string[]).includes(input.theme)) problems.push({ field: "theme", message: "Pick automatic, light or dark." });
  if (!HEX_COLOR_RE.test(input.accent ?? "")) problems.push({ field: "accent", message: "Use a colour such as #6554c0." });
  if (input.avatarKey !== null && !/^[A-Za-z0-9_-]{8,64}\.(png|jpe?g|gif|webp)$/.test(String(input.avatarKey))) problems.push({ field: "avatarKey", message: "That image isn't an upload." });

  const colour = (field: "background" | "buttonColor" | "iconColor", what: string): string | null => {
    const v = input[field];
    if (v === null || v === undefined || v === "") return null;
    if (!HEX_COLOR_RE.test(String(v))) problems.push({ field, message: `${what}: use a colour such as #ffffff, or the theme's.` });
    return String(v).toLowerCase();
  };
  const background = colour("background", "Background");
  const buttonColor = colour("buttonColor", "Buttons");
  const iconColor = colour("iconColor", "Icons");

  const socialsAt: BioSocialPlace = input.socialsAt ?? "top";
  if (!(BIO_SOCIAL_PLACES as readonly string[]).includes(socialsAt)) problems.push({ field: "socialsAt", message: "Put the social links under the name or at the end." });
  const share = input.share === true;

  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  const rawSocials = Array.isArray(input.socials) ? input.socials : [];
  if (!blocks.length && !rawSocials.length) problems.push({ field: "blocks", message: "Add at least one button, text or social link." });
  if (blocks.length > MAX_BIO_BLOCKS) problems.push({ field: "blocks", message: `Keep it to ${MAX_BIO_BLOCKS} buttons, texts and section titles.` });
  if (rawSocials.length > MAX_BIO_SOCIALS) problems.push({ field: "socials", message: `Keep it to ${MAX_BIO_SOCIALS} social links.` });

  let buttonNo = 0;
  const tidy: BioBlock[] = blocks.map((b, i): BioBlock => {
    if ("type" in b && b.type === "text") {
      const t = String(b.text ?? "").trim();
      if (!t) problems.push({ field: `blocks.${i}`, message: `Text ${i + 1}: write something, or remove it.` });
      if (t.length > BIO_TEXT_BLOCK_MAX) problems.push({ field: `blocks.${i}`, message: `Text ${i + 1}: keep it to ${BIO_TEXT_BLOCK_MAX} characters.` });
      return { type: "text", text: t };
    }
    if ("type" in b && b.type === "heading") {
      const label = String(b.label ?? "").trim();
      if (!label) problems.push({ field: `blocks.${i}`, message: `Section title ${i + 1}: add its text, or remove it.` });
      if (label.length > BIO_HEADING_MAX) problems.push({ field: `blocks.${i}`, message: `Section title ${i + 1}: keep it to ${BIO_HEADING_MAX} characters.` });
      return { type: "heading", label };
    }
    if ("type" in b) {
      problems.push({ field: `blocks.${i}`, message: `Block ${i + 1}: unknown kind.` });
      return b;
    }
    buttonNo++;
    const label = String(b.label ?? "").trim();
    if (!label) problems.push({ field: `blocks.${i}`, message: `Button ${buttonNo}: add its text.` });
    if (label.length > 80) problems.push({ field: `blocks.${i}`, message: `Button ${buttonNo}: keep the text to 80 characters.` });
    if ("link" in b && b.link) {
      if (!b.link.slug) problems.push({ field: `blocks.${i}`, message: `Button ${buttonNo}: pick one of your links.` });
      return { label, link: { domain: String(b.link.domain), slug: String(b.link.slug) } };
    }
    const url = "url" in b ? String(b.url ?? "").trim() : "";
    if (!HTTPS_RE.test(url)) problems.push({ field: `blocks.${i}`, message: `Button ${buttonNo}: pick one of your links, or a full https:// address.` });
    return { label, url };
  });

  const socials: BioSocial[] = rawSocials.map((s, i) => {
    const network = String(s?.network ?? "") as SocialNetwork;
    if (!(network in SOCIAL_NETWORKS)) {
      problems.push({ field: `socials.${i}`, message: `Social link ${i + 1}: pick a network.` });
      return { network, url: String(s?.url ?? "") };
    }
    const label = SOCIAL_NETWORKS[network].label;
    const url = tidySocialUrl(network, String(s.url ?? ""));
    if (network === "email" ? !EMAIL_RE.test(url.slice("mailto:".length)) : !HTTPS_RE.test(url)) {
      problems.push({ field: `socials.${i}`, message: network === "email" ? `${label}: use an address such as you@example.com.` : `${label}: use a full https:// address.` });
    }
    if (url.length > 2048) problems.push({ field: `socials.${i}`, message: `${label}: that address is too long.` });
    return { network, url };
  });

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    bio: { name, text, avatarKey: input.avatarKey, theme: input.theme, accent: input.accent, blocks: tidy, socials, socialsAt, share, background, buttonColor, iconColor },
  };
}

export function parseBio(json: string | null | undefined): BioPage | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as BioPage;
    return v && Array.isArray(v.blocks) ? v : null;
  } catch {
    return null;
  }
}

/** How many of a page's blocks are buttons (texts and section titles aren't). */
export function bioButtonCount(bio: BioPage): number {
  return bio.blocks.filter(isBioButton).length;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
}

/** Black or white, whichever reads better on `hex`. */
function onColor(hex: string): string {
  return luminance(hex) > 0.4 ? "#111111" : "#ffffff";
}

/** WCAG contrast ratio of two #rrggbb colours (for the editor's warnings). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The text colour the page uses on a custom background (or button). */
export function bioTextOn(hex: string): string {
  return onColor(hex);
}

const colourOr = (v: string | null | undefined): string | null => (v && HEX_COLOR_RE.test(v) ? v : null);

function iconSvg(network: SocialNetwork): string {
  const n = SOCIAL_NETWORKS[network];
  const paint = "stroke" in n && n.stroke ? 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' : 'fill="currentColor"';
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" ${paint}>${n.svg}</svg>`;
}

/** Share targets for the "Share this page" panel: plain links, so the page needs no script. */
function shareTargets(url: string, name: string): { network: SocialNetwork; label: string; href: string }[] {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(name);
  return [
    { network: "linkedin", label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${u}` },
    { network: "x", label: "X", href: `https://x.com/intent/post?url=${u}&text=${t}` },
    { network: "facebook", label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${u}` },
    { network: "whatsapp", label: "WhatsApp", href: `https://wa.me/?text=${encodeURIComponent(`${name} ${url}`)}` },
    { network: "telegram", label: "Telegram", href: `https://t.me/share/url?url=${u}&text=${t}` },
    { network: "email", label: "Email", href: `mailto:?subject=${t}&body=${u}` },
  ];
}

/**
 * The page's HTML. `linkHref` turns a block's short link into its address (the
 * short domain's origin plus slug), so a click goes through that link.
 * `scheme` forces one theme for the admin's preview. `pageUrl` is the page's
 * own address, for "Share this page".
 */
export function renderBio(
  bio: BioPage,
  opts: { domain: string; linkHref: (l: { domain: string; slug: string }) => string; scheme?: "light" | "dark"; avatarSrc?: string | null; pageUrl?: string },
): string {
  const light = `--bg:#f6f7f9; --card:#ffffff; --fg:#1a1b25; --muted:#5d6375; --line:#dcdfe6; color-scheme:light;`;
  const dark = `--bg:#0f1116; --card:#171a21; --fg:#e7e9ef; --muted:#a6acbb; --line:#2d323e; color-scheme:dark;`;
  const background = colourOr(bio.background);
  const buttonColor = colourOr(bio.buttonColor);
  const iconColor = colourOr(bio.iconColor);
  const theme = opts.scheme ?? bio.theme;
  let palette: string;
  if (background) {
    // Own background: text, lines and plain buttons are mixed from it, whatever the theme.
    const fg = onColor(background);
    palette = `:root { --bg:${background}; --fg:${fg}; --muted:color-mix(in srgb, ${fg} 80%, ${background}); --line:color-mix(in srgb, ${fg} 22%, ${background}); --card:color-mix(in srgb, ${fg} 8%, ${background}); color-scheme:${fg === "#ffffff" ? "dark" : "light"}; }`;
  } else {
    palette = theme === "dark" ? `:root { ${dark} }` : theme === "light" ? `:root { ${light} }` : `:root { ${light} }\n  @media (prefers-color-scheme: dark) { :root { ${dark} } }`;
  }
  const buttonVars = buttonColor ? `--btn:${buttonColor}; --on-btn:${onColor(buttonColor)}; --btn-line:transparent;` : `--btn:var(--card); --on-btn:var(--fg); --btn-line:var(--line);`;
  const avatar = opts.avatarSrc ?? (bio.avatarKey ? `${PREVIEW_IMAGE_PATH}${bio.avatarKey}` : null);

  let first = true;
  const blocks = bio.blocks
    .map((b) => {
      if (!isBioButton(b)) {
        return b.type === "heading" ? `<h2>${escapeHtml(b.label)}</h2>` : `<p class="note">${escapeHtml(b.text)}</p>`;
      }
      const href = "link" in b ? opts.linkHref(b.link) : b.url;
      const cls = first ? "btn first" : "btn";
      first = false;
      return `<a class="${cls}" href="${escapeHtml(href)}" rel="noopener">${escapeHtml(b.label)}</a>`;
    })
    .join("\n    ");

  const socials = (bio.socials ?? []).filter((s) => s.network in SOCIAL_NETWORKS);
  const socialList = socials.length
    ? `<ul class="socials${bio.socialsAt === "bottom" ? " at-end" : ""}" aria-label="Elsewhere">${socials
        .map((s) => {
          const label = SOCIAL_NETWORKS[s.network].label;
          // Email opens the mail app; everything else opens in a new tab. rel="me" lets Mastodon verify the page.
          const newTab = s.network === "email" ? "" : ` target="_blank" rel="me noopener noreferrer"`;
          return `<li><a href="${escapeHtml(s.url)}"${newTab} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${iconSvg(s.network)}</a></li>`;
        })
        .join("")}</ul>`
    : "";

  const share =
    bio.share && opts.pageUrl
      ? `<details class="share">
    <summary><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SHARE_ICON}</svg>Share this page</summary>
    <div class="share-panel">
      <p class="share-url" title="Tap to select, then copy">${escapeHtml(opts.pageUrl)}</p>
      <ul>${shareTargets(opts.pageUrl, bio.name)
        .map((t) => `<li><a href="${escapeHtml(t.href)}"${t.network === "email" ? "" : ` target="_blank" rel="noopener noreferrer"`}>${iconSvg(t.network)}${escapeHtml(t.label)}</a></li>`)
        .join("")}</ul>
    </div>
  </details>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(bio.name)}</title>
<meta property="og:title" content="${escapeHtml(bio.name)}">
${bio.text ? `<meta name="description" content="${escapeHtml(bio.text)}">\n<meta property="og:description" content="${escapeHtml(bio.text)}">` : ""}
${opts.pageUrl ? `<meta property="og:url" content="${escapeHtml(opts.pageUrl)}">` : ""}
<style>
  ${palette}
  :root { --accent:${bio.accent}; --on-accent:${onColor(bio.accent)}; ${buttonVars} --icon:${iconColor ?? "var(--fg)"}; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; background:var(--bg); color:var(--fg); font:16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:520px; margin:0 auto; padding:48px 20px 32px; text-align:center; }
  img { width:96px; height:96px; border-radius:50%; object-fit:cover; display:block; margin:0 auto 16px; border:1px solid var(--line); }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:-0.01em; }
  .intro { margin:0 0 24px; color:var(--muted); white-space:pre-line; }
  .blocks { display:grid; gap:12px; }
  .blocks h2 { margin:16px 0 0; font-size:13px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; color:var(--muted); }
  .blocks h2:first-child { margin-top:0; }
  .note { margin:0; color:var(--fg); white-space:pre-line; overflow-wrap:anywhere; }
  a.btn { display:block; padding:14px 18px; border-radius:14px; background:var(--btn); color:var(--on-btn); border:1px solid var(--btn-line); text-decoration:none; font-weight:600; overflow-wrap:anywhere;
          transition:transform .15s ease, border-color .15s ease; }
  a.btn.first { background:var(--accent); color:var(--on-accent); border-color:transparent; }
  a.btn:hover { transform:translateY(-1px); border-color:var(--accent); }
  a:focus-visible, summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
  .socials { list-style:none; display:flex; flex-wrap:wrap; justify-content:center; gap:4px; margin:0 0 24px; padding:0; }
  .socials.at-end { margin:28px 0 0; }
  .socials a { display:grid; place-items:center; width:44px; height:44px; border-radius:50%; color:var(--icon); transition:background-color .15s ease; }
  .socials a:hover { background:var(--card); }
  .share { margin-top:28px; }
  .share summary { display:inline-flex; align-items:center; gap:8px; min-height:44px; padding:0 18px; border-radius:999px; border:1px solid var(--line); color:var(--fg); font-weight:600; font-size:15px; cursor:pointer; list-style:none; }
  .share summary::-webkit-details-marker { display:none; }
  .share[open] summary { background:var(--card); }
  .share-panel { margin-top:12px; padding:14px; border-radius:14px; border:1px solid var(--line); background:var(--card); text-align:left; }
  .share-url { margin:0 0 12px; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--bg); font-size:14px; overflow-wrap:anywhere; user-select:all; -webkit-user-select:all; }
  .share-panel ul { list-style:none; display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:6px; margin:0; padding:0; }
  .share-panel a { display:flex; align-items:center; gap:10px; min-height:44px; padding:0 10px; border-radius:10px; color:var(--fg); text-decoration:none; font-size:15px; }
  .share-panel a:hover { background:var(--bg); }
  .share-panel svg { width:18px; height:18px; color:var(--icon); flex:none; }
  footer { margin-top:36px; font-size:12px; color:var(--muted); }
  footer a { color:inherit; }
  @media (prefers-reduced-motion:reduce) { a.btn, .socials a { transition:none; } a.btn:hover { transform:none; } }
</style>
</head>
<body>
<main>
  ${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : ""}
  <h1>${escapeHtml(bio.name)}</h1>
  ${bio.text ? `<p class="intro">${escapeHtml(bio.text)}</p>` : ""}
  ${bio.socialsAt === "bottom" ? "" : socialList}
  <section class="blocks">
    ${blocks}
  </section>
  ${bio.socialsAt === "bottom" ? socialList : ""}
  ${share}
  <footer><a href="/_privacy">Privacy</a> · ${escapeHtml(opts.domain)}</footer>
</main>
</body>
</html>`;
}

// Custom social previews: the title, description and image link-preview
// crawlers (LinkedIn, Slack, X, iMessage…) see for a short link, instead of
// whatever the destination's own page says. People are still redirected.

export const PREVIEW_TITLE_MAX = 120;
export const PREVIEW_DESCRIPTION_MAX = 300;
/** What most platforms show before cutting off. */
export const PREVIEW_TITLE_SHOWN = 70;
export const PREVIEW_DESCRIPTION_SHOWN = 160;
/** LinkedIn's and X's own upper limit. */
export const PREVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Large-card size most platforms recommend (1.91:1). */
export const PREVIEW_IMAGE_IDEAL = { width: 1200, height: 627 };
/** Below this, platforms show a small thumbnail or none at all. */
export const PREVIEW_IMAGE_MIN = { width: 200, height: 200 };
export const PREVIEW_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type PreviewImageType = (typeof PREVIEW_IMAGE_TYPES)[number];
/** Uploaded images are served from here on every short domain. */
export const PREVIEW_IMAGE_PATH = "/_og/";
export const PREVIEW_IMAGE_KEY_RE = /^[a-z0-9]{20}\.(png|jpg|gif|webp)$/;

export type PreviewImage =
  | { kind: "upload"; key: string; width: number | null; height: number | null }
  | { kind: "url"; url: string };

export interface LinkPreview {
  title: string;
  description: string;
  image: PreviewImage | null;
}

export const EXTENSION: Record<PreviewImageType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const TYPE_OF_EXTENSION: Record<string, PreviewImageType> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * Crawlers that build link previews and read the preview page instead of the
 * redirect. Names as analytics.ts detects them, plus a few it files elsewhere.
 * Search engines aren't here: they should index the destination. In-app
 * browsers people browse with (Teams, LINE, Snapchat…) mustn't match either.
 * iMessage previews arrive as facebookexternalhit + Twitterbot.
 */
const PREVIEW_CRAWLERS = [
  /LinkedInBot/i,
  /facebookexternalhit|Facebot|meta-externalagent/i,
  /Twitterbot/i,
  /Slackbot|Slack-ImgProxy/i,
  /Discordbot/i,
  /TelegramBot/i,
  /WhatsApp/i,
  /SkypeUriPreview|MicrosoftPreview/i,
  /Pinterest(bot)?\//i,
  /redditbot/i,
  /Applebot/i,
  /Mastodon\//i,
  /Bluesky|Cardyb/i,
  /Embedly|Iframely|vkShare/i,
];

export function isPreviewCrawler(ua: string): boolean {
  return PREVIEW_CRAWLERS.some((re) => re.test(ua));
}

export interface PreviewProblem {
  field: "title" | "description" | "image";
  message: string;
}

/** Validates and trims a preview; null input means "use the destination's own preview". */
export function validatePreview(p: LinkPreview): { ok: true; preview: LinkPreview } | { ok: false; problems: PreviewProblem[] } {
  const problems: PreviewProblem[] = [];
  const title = p.title.trim().replace(/\s+/g, " ");
  const description = p.description.trim().replace(/\s+/g, " ");
  if (!title) problems.push({ field: "title", message: "Add a title: every platform shows one." });
  if (title.length > PREVIEW_TITLE_MAX) problems.push({ field: "title", message: `Keep the title to ${PREVIEW_TITLE_MAX} characters.` });
  if (description.length > PREVIEW_DESCRIPTION_MAX) problems.push({ field: "description", message: `Keep the description to ${PREVIEW_DESCRIPTION_MAX} characters.` });
  let image: PreviewImage | null = null;
  if (p.image?.kind === "upload") {
    if (!PREVIEW_IMAGE_KEY_RE.test(p.image.key)) problems.push({ field: "image", message: "Upload the image again." });
    image = { kind: "upload", key: p.image.key, width: p.image.width ?? null, height: p.image.height ?? null };
  } else if (p.image?.kind === "url") {
    let ok = false;
    try {
      const u = new URL(p.image.url.trim());
      ok = u.protocol === "https:" && !u.username && !u.password && u.href.length <= 2048;
      if (ok) image = { kind: "url", url: u.href };
    } catch {
      ok = false;
    }
    if (!ok) problems.push({ field: "image", message: "Use an image address starting with https://." });
  }
  return problems.length ? { ok: false, problems } : { ok: true, preview: { title, description, image } };
}

export function parsePreview(json: string | null | undefined): LinkPreview | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as LinkPreview;
    return typeof p?.title === "string" ? p : null;
  } catch {
    return null;
  }
}

/** Width and height from an image's header (PNG, JPEG, GIF, WebP), or null. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50) return { width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49) return { width: u16le(6), height: u16le(8) };
  if (b.length >= 30 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      // Start-of-frame markers carry the size; DHT, JPG and DAC (C4, C8, CC) don't.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(i + 7), height: u16be(i + 5) };
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

// Slug rules shared by the redirect path, the API and the import tools.

/** Slugs created in the admin or API: letters, digits, "-" and "_". */
const NATIVE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Slugs imported from another shortener may also contain "." and "~", and be longer (up to 96: Analytics Engine indexes hold 96 bytes). */
export const IMPORT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,95}$/;

/** Paths the Worker owns. Compared case-insensitively. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "_admin",
  "health",
  "favicon.ico",
  "robots.txt",
  "cdn-cgi",
]);

function isReserved(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

export type SlugMode = "native" | "import";

export function validateSlug(slug: string, mode: SlugMode): string | null {
  const re = mode === "native" ? NATIVE_SLUG_RE : IMPORT_SLUG_RE;
  if (!re.test(slug)) {
    return mode === "native"
      ? "Use 1–64 letters, digits, '-' or '_', starting with a letter or digit."
      : "Use 1–96 letters, digits, '.', '~', '-' or '_', starting with a letter or digit.";
  }
  if (isReserved(slug)) return `"${slug}" is reserved.`;
  return null;
}

/** True when a path segment could be a live slug (the widest accepted charset). */
export function isRoutableSlug(slug: string): boolean {
  return IMPORT_SLUG_RE.test(slug) && !isReserved(slug);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random base62 slug from crypto.getRandomValues, without modulo bias. */
export function generateSlug(length = 6): string {
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 248 = 62 * 4: reject the top bytes so every character is equally likely.
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

// Paths vulnerability scanners request on every site: config and secrets files,
// scripts, archives and well-known admin tools.
const PROBE_EXT_RE = /\.(php\d?|aspx?|ashx|jsp|cgi|env|git|svn|hg|sql|sqlite3?|db|mdb|bak|backup|old|orig|save|swp|tmp|ini|conf|cfg|config|properties|ya?ml|toml|log|lock|zip|tar|t?gz|bz2|xz|rar|7z|war|jar|xml|json|map|js|ts|sh|bash|py|rb|pl|pem|key|crt|p12|pfx|kdbx|ds_store|htaccess|htpasswd|npmrc|dockerenv)$/i;
const PROBE_PREFIX_RE = /^(wp-|wp$|wordpress|xmlrpc|phpmyadmin|pma$|cgi-bin|vendor$|node_modules$|actuator|autodiscover|owa$|ecp$|boaform|hnap1|solr|druid|telescope|_ignition|dockerfile$|docker-compose|server-status$|server-info$|swagger|api-docs$|graphql$|geoserver|jenkins$|\.)/i;

/** True for a missed path that is almost certainly a scanner probe, not a mistyped link. */
export function isProbePath(slug: string): boolean {
  return !isRoutableSlug(slug) || PROBE_EXT_RE.test(slug) || PROBE_PREFIX_RE.test(slug);
}

// Free-form values that visitors or page addresses can fill (paths, goal names
// and properties, UTM tags, ?ref=) are kept for statistics. These screens take
// out what looks like an email address or a secret before anything is stored.
// They go by shape, so they miss some values. A false match costs more than it
// looks: it merges different pages or campaigns into one report row, so ordinary
// words, slugs and ids have to stay, however long they are.

// "logo@2x.png" is an image, not an address.
const EMAIL = /[^\s@/?#&=;:,"'<>()[\]]+(?:@|%40)(?!\d+x\.[a-z]+\b)[^\s@/?#&=;:,"'<>()[\]%]+\.[A-Za-z]{2,}/gi;
const JWT = /\beyJ[\w-]{6,}\.[\w-]{6,}(?:\.[\w-]*)?/g;
const HEX = /\b[a-f0-9]{32,}\b/gi;
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;
const SECRET_PARAM = /\b(access_token|id_token|refresh_token|token|api_?key|secret|password|passwd|pwd)=[^&;#\s]+/gi;

/** What text is made of: a word (capitalized or not), an acronym, a number. Random characters rarely form these. */
const WORD_LIKE = /[A-Z]?[a-z]{3,}|[A-Z]{3,}|[0-9]{3,}/g;
/** A random key has a long stretch without - or _; "Q1-Q2-Q3-2026-Report" doesn't. */
const MIN_KEY_STRETCH = 16;
/** Share of the characters in word-like pieces: about a third in random keys, 0.7 and up in slugs and campaign names. */
const MAX_WORD_SHARE = 0.6;

/** A long run that mixes lower case, capitals and digits and doesn't read as words: a key, not a slug. */
function randomLooking(run: string): boolean {
  if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/[0-9]/.test(run)) return false;
  const parts = run.split(/[-_]/);
  if (!parts.some((p) => p.length >= MIN_KEY_STRETCH)) return false;
  const text = parts.join("");
  const wordy = (text.match(WORD_LIKE) ?? []).reduce((n, w) => n + w.length, 0);
  return wordy / text.length < MAX_WORD_SHARE;
}

/** The value with email-shaped and token-shaped parts replaced by [email] and [redacted]. */
export function scrubText(value: string): string {
  if (value.length < 6) return value;
  return value
    .replace(SECRET_PARAM, "$1=[redacted]")
    .replace(JWT, "[redacted]")
    .replace(EMAIL, "[email]")
    .replace(HEX, "[redacted]")
    .replace(LONG_RUN, (m) => (randomLooking(m) ? "[redacted]" : m));
}

/**
 * A URL fragment as a page route: "#/orders/42" and "#!/orders/42" stay (without
 * anything after "?"). Other fragments ("#access_token=…", "#section") aren't routes.
 */
export function hashRoute(hash: string): string {
  return /^#!?\//.test(hash) ? hash.split("?")[0]! : "";
}

/** Visitor-chosen text for an email or notification: one line, short. */
export function shortText(value: string, max = 80): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

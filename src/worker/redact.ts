// What the Worker's own logs may say about a request. Some addresses are
// themselves secrets: a share page, an invite or reset link, a payment webhook.

/** Paths whose tail is a secret: the prefix stays, so the log still says what failed. */
const SECRET_PATHS = /\/(_share|_pay|_admin\/invite|_admin\/reset)\/[^\s"'<>]*/g;

/** A path that is safe to log. */
export function safePath(path: string): string {
  return path.replace(SECRET_PATHS, "/$1/[redacted]");
}

/** An error message or stack with any such path taken out, in case one quotes a URL. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATHS, "/$1/[redacted]");
}

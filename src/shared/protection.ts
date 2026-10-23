// Password-protected links and click limits: the rules shared by the API,
// the redirect and the admin.

export const LINK_PASSWORD_MIN = 4;
export const LINK_PASSWORD_MAX = 128;
/**
 * PBKDF2 iterations for link passwords: a few milliseconds of CPU per attempt,
 * so a check fits the Free plan's 10 ms per request. Attempts are rate-limited
 * per network and link; these protect a redirect, not an account.
 */
export const LINK_PASSWORD_ITERATIONS = 30_000;
/** How long a correct password keeps working in that browser. */
export const LINK_ACCESS_HOURS = 12;
export const MAX_CLICK_LIMIT = 10_000_000;

export function linkPasswordProblem(p: string): string | null {
  if (p.length < LINK_PASSWORD_MIN) return `Use at least ${LINK_PASSWORD_MIN} characters.`;
  if (p.length > LINK_PASSWORD_MAX) return `Use at most ${LINK_PASSWORD_MAX} characters.`;
  return null;
}

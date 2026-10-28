// Password-protected links and click limits: the rules shared by the API,
// the redirect and the admin.

export const LINK_PASSWORD_MIN = 8;
export const LINK_PASSWORD_MAX = 128;
/**
 * PBKDF2 iterations for link passwords, by Workers plan (WORKERS_PLAN): on Free
 * a few milliseconds of CPU per attempt, so a check fits its 10 ms per request;
 * on Paid the workerd maximum. Each hash records its own count, so changing
 * plan only affects passwords set afterwards. Attempts are rate-limited per
 * network and link, and counted per link across all networks
 * (LINK_PASSWORD_MAX_FAILS); these protect a redirect, not an account.
 */
export const LINK_PASSWORD_ITERATIONS = { free: 30_000, paid: 100_000 } as const;
/** Wrong passwords for one link, from anywhere, within the window before it locks. */
export const LINK_PASSWORD_MAX_FAILS = 20;
export const LINK_PASSWORD_WINDOW_SEC = 60 * 60;
/** The lock doubles from a minute with each lockout in a row, up to this. */
export const LINK_PASSWORD_LOCK_MAX_SEC = 15 * 60;
/** How long a correct password keeps working in that browser. */
export const LINK_ACCESS_HOURS = 12;
export const MAX_CLICK_LIMIT = 10_000_000;

export function linkPasswordProblem(p: string): string | null {
  if (p.length < LINK_PASSWORD_MIN) return `Use at least ${LINK_PASSWORD_MIN} characters.`;
  if (p.length > LINK_PASSWORD_MAX) return `Use at most ${LINK_PASSWORD_MAX} characters.`;
  return null;
}

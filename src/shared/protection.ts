// Password-protected links and click limits: the rules shared by the API,
// the redirect and the admin.

export const LINK_PASSWORD_MIN = 8;
export const LINK_PASSWORD_MAX = 128;
/**
 * PBKDF2 iterations for link passwords, by Workers plan (WORKERS_PLAN): on Free
 * a few milliseconds of CPU per attempt, so a check fits its 10 ms per request;
 * on Paid the workerd maximum. Each hash records its own count, so changing
 * plan only affects passwords set afterwards. Wrong passwords lock the network
 * that sent them (LINK_PASSWORD_NETWORK_MAX_FAILS), and are counted per link
 * across all networks (LINK_PASSWORD_MAX_FAILS); these protect a redirect, not
 * an account.
 */
export const LINK_PASSWORD_ITERATIONS = { free: 30_000, paid: 100_000 } as const;
/** Wrong passwords for one link from one network within the window before that network is locked out. */
export const LINK_PASSWORD_NETWORK_MAX_FAILS = 10;
/**
 * Wrong passwords for one link from anywhere within the window before the
 * link's brake goes on (a minute, doubling up to LINK_PASSWORD_LOCK_MAX_SEC).
 * The brake holds back networks that have already guessed wrong; every other
 * network gets one try, within LINK_PASSWORD_BRAKE_TOTAL for all of them.
 */
export const LINK_PASSWORD_MAX_FAILS = 20;
/**
 * The tries all networks that hadn't guessed yet get together during the
 * link's brakes in one window, so guesses spread over many networks (an IPv6
 * /48 holds 65,536 of them) stay bounded. The price: once someone guessing has
 * spent it, a visitor who knows the password also waits until the brake runs
 * out. A cap that let the right password through would cap nothing.
 */
export const LINK_PASSWORD_BRAKE_TOTAL = 20;
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

// Admin password login policy, shared by the Worker, the help texts and tests.

/** `__Host-` pins the cookie to this exact host, HTTPS and Path=/. */
export const SESSION_COOKIE = "__Host-sh_admin";
/** Session lifetime: 12 hours. */
export const SESSION_TTL_SEC = 12 * 60 * 60;

/** Failed attempts per network within WINDOW_SEC before it is locked. */
export const MAX_FAILS = 5;
export const WINDOW_SEC = 15 * 60;
/** First lockout; each further lockout doubles it, up to LOCK_MAX_SEC. */
export const LOCK_BASE_SEC = 60;
export const LOCK_MAX_SEC = 24 * 60 * 60;

/** Failures across all networks that pause every login for GLOBAL_LOCK_SEC, when they come from at least GLOBAL_MIN_NETWORKS networks. */
export const GLOBAL_MAX_FAILS = 30;
export const GLOBAL_MIN_NETWORKS = 5;
export const GLOBAL_WINDOW_SEC = 60 * 60;
export const GLOBAL_LOCK_SEC = 15 * 60;

/** Wrong API keys or tokens per network within API_WINDOW_SEC before it is locked (same doubling as logins). */
export const API_MAX_FAILS = 10;
export const API_WINDOW_SEC = 60;
/**
 * API lockouts stop doubling at an hour (logins go up to a day): the network is
 * often an office or home shared by several people and devices, and one script
 * with a stale key mustn't shut the rest of them out of the API for a day.
 */
export const API_LOCK_MAX_SEC = 60 * 60;

/** Login events (success and failure) are kept this long. */
export const LOGIN_EVENT_RETENTION_SEC = 30 * 24 * 60 * 60;

/** "Forgot password" links work once, for this long. */
export const RESET_TTL_SEC = 60 * 60;
/** Reset emails (or notes to an admin): one per person per cooldown, a few a day, per network and overall. */
export const RESET_COOLDOWN_SEC = 15 * 60;
export const RESET_MAX_PER_DAY = 3;
export const RESET_MAX_PER_NETWORK_HOUR = 5;
export const RESET_MAX_GLOBAL_HOUR = 20;

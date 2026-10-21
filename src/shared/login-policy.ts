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

/** Failures across all networks that pause every login for GLOBAL_LOCK_SEC. */
export const GLOBAL_MAX_FAILS = 30;
export const GLOBAL_WINDOW_SEC = 60 * 60;
export const GLOBAL_LOCK_SEC = 15 * 60;

/** Login events (success and failure) are kept this long. */
export const LOGIN_EVENT_RETENTION_SEC = 30 * 24 * 60 * 60;

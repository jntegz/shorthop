// Cron triggers. The setup wizard writes these into wrangler.jsonc, and the
// Worker tells its jobs apart by them, so they're defined once, here.

/** Hourly at :15: website alerts, except the 01:15 UTC run, which does the daily rollups. */
export const ROLLUP_CRON = "15 * * * *";
/** Mondays at 07:00 UTC: the weekly digest. */
export const DIGEST_CRON = "0 7 * * 1";
/** Every 30 minutes: the destination checks that are due. */
export const CHECKS_CRON = "*/30 * * * *";

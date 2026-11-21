// Cron triggers. The setup wizard writes these into wrangler.jsonc, and the
// Worker tells its jobs apart by them, so they're defined once, here.

/** Hourly at :15: website alerts, except the 01:15 UTC run, which does the daily rollups. */
export const ROLLUP_CRON = "15 * * * *";
/**
 * Mondays at 07:00 UTC: the weekly digest. The weekday is a name: Cloudflare
 * counts a number from Sunday = 1, so the "0 7 * * 1" that earlier versions
 * wrote ran it on Sundays (LEGACY_DIGEST_CRON).
 */
export const DIGEST_CRON = "0 7 * * MON";
/** The digest's trigger in a wrangler.jsonc from an earlier version; still answered until `npm run setup -- upgrade`. */
export const LEGACY_DIGEST_CRON = "0 7 * * 1";
/** Every 30 minutes: the destination checks that are due. */
export const CHECKS_CRON = "*/30 * * * *";
/**
 * Not a trigger: names the daily run when it is started by hand at any hour
 * (README, local development). The hourly cron only does it at 01:15 UTC.
 * Older configs had it as their rollup trigger.
 */
export const DAILY_RUN = "15 1 * * *";

/** The half-hourly cron's 02:00 UTC slot runs the daily cleanup instead of destination checks. */
export function isCleanupRun(now: Date): boolean {
  return now.getUTCHours() === 2 && now.getUTCMinutes() < 30;
}

/** The half-hourly cron's 02:30 UTC slot copies website totals to D1 instead of checking destinations. */
export function isWebRollupRun(now: Date): boolean {
  return now.getUTCHours() === 2 && now.getUTCMinutes() >= 30;
}

/** The half-hourly cron's 03:00 UTC slot does the revenue work instead of destination checks. */
export function isRevenueRun(now: Date): boolean {
  return now.getUTCHours() === 3 && now.getUTCMinutes() < 30;
}

/** The half-hourly cron's 03:30 UTC slot does Advanced tracking's housekeeping: retention and the public VPN lists. */
export function isTrackingRun(now: Date): boolean {
  return now.getUTCHours() === 3 && now.getUTCMinutes() >= 30;
}

/** The half-hourly slots of a day that check destinations: the 48 without those above. */
export const CHECK_RUNS_PER_DAY = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 0, 5, 0, i * 30))).filter(
  (d) => !isCleanupRun(d) && !isWebRollupRun(d) && !isRevenueRun(d) && !isTrackingRun(d),
).length;

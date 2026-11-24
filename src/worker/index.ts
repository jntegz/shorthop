import { NOT_FOUND_IMAGE_PATH, NOT_FOUND_PREVIEW_PATH } from "../shared/not-found";
import { CHECKS_CRON, DAILY_RUN, DIGEST_CRON, LEGACY_DIGEST_CRON, ROLLUP_CRON } from "../shared/schedule";
import { serveAdmin } from "./admin";
import { app } from "./app";
import { SERVED_BY_HEADER } from "./dns-check";
import { resolveSite } from "./domains";
import { runSiteAlerts } from "./web/alerts";
import { isCleanupRun, isRevenueRun, isTrackingRun, isWebRollupRun, scheduledCleanup, scheduledDaily, scheduledDigest, scheduledLinkChecks, scheduledRevenue, scheduledWebRollup } from "./health";
import { backupPending, isBackupRun, scheduledBackup } from "./backup";
import { planLimits } from "./plan";
import { PREVIEW_IMAGE_PATH } from "../shared/preview";
import { servePreviewImage } from "./preview";
import { loginApp } from "./login";
import { notFoundResponse, serveNotFoundImage } from "./not-found";
import { serveShare, SHARE_PREFIX } from "./share";
import { handleRedirect, publicLimit, redirectTo } from "./redirect";
import { handlePaymentWebhook, PAY_PREFIX } from "./revenue/ingest";
import { redactSecrets, safePath } from "./redact";
import { withHsts } from "./hsts";
import { withGeneratedSecrets } from "./secrets";
import { COLLECT_PATH, handleCollect } from "./web/collect";
import { SCRIPT_PATH, serveScript } from "./web/script";
import { PIXEL_PREFIX, TRACKING_BEACON_PATH } from "../shared/tracking";
import { handleBeacon, handlePixel, scheduledTracking } from "./tracking";

/** Server-rendered password pages (src/worker/login.ts). */
const LOGIN_PATHS = new Set([
  "/_admin/login",
  "/_admin/login/2fa",
  "/_admin/login/2fa-setup",
  "/_admin/login/passkey",
  "/_admin/login/passkey/options",
  "/_admin/login/passkey.js",
  "/_admin/logout",
  "/_admin/forgot",
  "/_admin/bot-check",
]);

// The click-limit counter (a Durable Object class must be exported here).
export { ClickCap } from "./click-cap";

/** Every request but the headers all responses carry (withHsts). */
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const site = resolveSite(request, env, url);
  // A domain that reaches this Worker but isn't in SHORT_DOMAINS (the setup check reads the header).
  if (!site) return new Response("Not found", { status: 404, headers: { [SERVED_BY_HEADER]: "unconfigured" } });

  // The admin and the API live on the admin host only (ADMIN_HOST, or the primary domain).
  const isAdmin = path.startsWith("/api/") || path === "/_admin" || path.startsWith("/_admin/");
  if (isAdmin && !site.admin) return notFoundResponse(env, site.domain, null);
  // Preview images also load on the admin host, where the link editor shows them.
  const isPreviewImage = path.startsWith(PREVIEW_IMAGE_PATH);
  // Website analytics and payment webhooks answer on every host, the admin host included.
  if (path === SCRIPT_PATH) return serveScript(request);
  if (path === COLLECT_PATH) return handleCollect(request, env, ctx);
  if (path.startsWith(PAY_PREFIX)) return handlePaymentWebhook(request, env, ctx, path);
  // Shared statistics pages: public, on the admin host only (outside /_admin, so Access doesn't cover them).
  if (path.startsWith(SHARE_PREFIX)) return site.admin ? serveShare(request, env, ctx, url) : notFoundResponse(env, site.domain, null);
  if (site.adminOnly && !isAdmin && path !== "/health" && !isPreviewImage) {
    return path === "/" ? new Response(null, { status: 302, headers: { Location: "/_admin/" } }) : new Response("Not found", { status: 404 });
  }
  // Access protects /_admin/*; the bare /_admin may not be covered, so it never reaches the auth check.
  if (path === "/_admin") return new Response(null, { status: 301, headers: { Location: `/_admin/${url.search}` } });
  if (path.startsWith("/api/") || path.startsWith("/_admin/api/")) return app.fetch(request, env, ctx);
  if (LOGIN_PATHS.has(path) || path.startsWith("/_admin/invite/") || path.startsWith("/_admin/reset/")) return loginApp.fetch(request, env, ctx);
  if (path.startsWith("/_admin/")) return serveAdmin(request, env, url);
  if (path === "/") return redirectTo(env.FALLBACK_URL);
  // The not-found page as visitors see it, without logging a miss (Settings links here).
  if (path === NOT_FOUND_PREVIEW_PATH) return notFoundResponse(env, site.domain, "example");
  if (path === NOT_FOUND_IMAGE_PATH && (request.method === "GET" || request.method === "HEAD")) return serveNotFoundImage(env, url, ctx);
  if (path === "/health") return new Response("ok", { headers: { "Cache-Control": "no-store", [SERVED_BY_HEADER]: "ok" } });
  if (isPreviewImage && (request.method === "GET" || request.method === "HEAD")) return servePreviewImage(env, url, ctx);

  // The browser-details page of a link with Advanced tracking reports here (src/worker/tracking.ts). Each report is a D1 write: braked per network.
  if (path === TRACKING_BEACON_PATH) return (await publicLimit(request, env)) ?? handleBeacon(request, env);
  // The email-open pixel of a tracked link (src/worker/tracking.ts). The image always loads; past the brake, opens aren't recorded.
  if (path.startsWith(PIXEL_PREFIX)) return handlePixel(request, env, ctx, url, site.domain, async () => !(await publicLimit(request, env)));

  // Everything else is a slug on this domain. No framework on this path.
  return handleRedirect(request, env, ctx, url, site.domain);
}

export default {
  async fetch(request, env, ctx) {
    // Only Deploy to Cloudflare installs lack these secrets (one D1 read per isolate).
    env = await withGeneratedSecrets(env);
    let res: Response;
    try {
      res = await route(request, env, ctx);
    } catch (err) {
      // Logged with its detail, answered without: and still with HSTS, unlike the runtime's own error page.
      // Addresses can be secrets (shares, invite and reset links, payment webhooks): never logged as they came.
      console.error(JSON.stringify({ message: "request failed", path: safePath(new URL(request.url).pathname), error: redactSecrets(String(err)), stack: err instanceof Error && err.stack ? redactSecrets(err.stack) : undefined }));
      res = new Response("Something went wrong. Try again in a moment.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return withHsts(res, env);
  },

  // One job per invocation, so each stays inside the plan's subrequest limit
  // (src/worker/plan.ts). The half-hourly cron's 02:00 UTC slot does the
  // daily cleanup, its 02:30 slot the website rollup and its 03:00 slot the
  // revenue work, instead of that run's destination checks; from 04:00 to 07:30
  // its slots copy the weekly backup, started on Sunday, until that is complete. The hourly cron
  // does the daily run at 01:15 UTC and website alerts (spikes, daily
  // digests) the other hours.
  async scheduled(controller, env, ctx) {
    env = await withGeneratedSecrets(env);
    const now = new Date(controller.scheduledTime);
    const run = (what: string, work: Promise<unknown>) =>
      ctx.waitUntil(work.catch((err: unknown) => console.error(JSON.stringify({ message: `${what} failed`, error: String(err) }))));
    if (controller.cron === DIGEST_CRON || controller.cron === LEGACY_DIGEST_CRON) run("digest run", scheduledDigest(env, now));
    else if (controller.cron === CHECKS_CRON) {
      if (isCleanupRun(now)) run("cleanup run", scheduledCleanup(env, now));
      else if (isWebRollupRun(now)) run("website rollup run", scheduledWebRollup(env, now));
      else if (isRevenueRun(now)) run("revenue run", scheduledRevenue(env));
      else if (isTrackingRun(now)) run("tracking run", scheduledTracking(env));
      // Early mornings copy the weekly backup to R2, when a bucket is bound (BACKUPS) and one is due or unfinished.
      // Once it is complete, the remaining slots check destinations as on any other day.
      else if (isBackupRun(now) && (env as { BACKUPS?: unknown }).BACKUPS && (await backupPending(env, now))) run("backup run", scheduledBackup(env, now, planLimits(env).backupCalls));
      else run("link checks run", scheduledLinkChecks(env));
    } else if (controller.cron === ROLLUP_CRON) {
      if (now.getUTCHours() === 1) run("daily run", scheduledDaily(env, now));
      else run("site alerts run", runSiteAlerts(env, Math.floor(now.getTime() / 1000)));
    } else if (controller.cron === DAILY_RUN) run("daily run", scheduledDaily(env, now));
    // A cron in wrangler.jsonc that no job answers to: nothing runs under a guess.
    else console.error(JSON.stringify({ message: "unknown cron, nothing run", cron: controller.cron }));
  },
} satisfies ExportedHandler<Env>;

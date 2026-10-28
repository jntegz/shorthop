import { NOT_FOUND_IMAGE_PATH, NOT_FOUND_PREVIEW_PATH } from "../shared/not-found";
import { CHECKS_CRON, DIGEST_CRON, ROLLUP_CRON } from "../shared/schedule";
import { serveAdmin } from "./admin";
import { app } from "./app";
import { SERVED_BY_HEADER } from "./dns-check";
import { resolveSite } from "./domains";
import { runSiteAlerts } from "./web/alerts";
import { isCleanupRun, isRevenueRun, isWebRollupRun, scheduledCleanup, scheduledDaily, scheduledDigest, scheduledLinkChecks, scheduledRevenue, scheduledWebRollup } from "./health";
import { PREVIEW_IMAGE_PATH } from "../shared/preview";
import { servePreviewImage } from "./preview";
import { loginApp } from "./login";
import { notFoundResponse, serveNotFoundImage } from "./not-found";
import { serveShare, SHARE_PREFIX } from "./share";
import { handleRedirect, redirectTo } from "./redirect";
import { handlePaymentWebhook, PAY_PREFIX } from "./revenue/ingest";
import { withGeneratedSecrets } from "./secrets";
import { COLLECT_PATH, handleCollect } from "./web/collect";
import { SCRIPT_PATH, serveScript } from "./web/script";

/** Server-rendered password pages (src/worker/login.ts). */
const LOGIN_PATHS = new Set(["/_admin/login", "/_admin/logout", "/_admin/forgot", "/_admin/bot-check"]);

// The click-limit counter (a Durable Object class must be exported here).
export { ClickCap } from "./click-cap";

export default {
  async fetch(request, env, ctx) {
    // Only Deploy to Cloudflare installs lack these secrets (one D1 read per isolate).
    env = await withGeneratedSecrets(env);
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

    // Everything else is a slug on this domain. No framework on this path.
    return handleRedirect(request, env, ctx, url, site.domain);
  },

  // One job per invocation, so each stays inside the plan's subrequest limit
  // (src/worker/plan.ts). The half-hourly cron's 02:00 UTC slot does the
  // daily cleanup, its 02:30 slot the website rollup and its 03:00 slot the
  // revenue work, instead of that run's destination checks. The hourly cron
  // does the daily run at 01:15 UTC and website alerts (spikes, daily
  // digests) the other hours.
  async scheduled(controller, env, ctx) {
    env = await withGeneratedSecrets(env);
    const now = new Date(controller.scheduledTime);
    const run = (what: string, work: Promise<unknown>) =>
      ctx.waitUntil(work.catch((err: unknown) => console.error(JSON.stringify({ message: `${what} failed`, error: String(err) }))));
    if (controller.cron === DIGEST_CRON) run("digest run", scheduledDigest(env, now));
    else if (controller.cron === CHECKS_CRON) {
      if (isCleanupRun(now)) run("cleanup run", scheduledCleanup(env, now));
      else if (isWebRollupRun(now)) run("website rollup run", scheduledWebRollup(env, now));
      else if (isRevenueRun(now)) run("revenue run", scheduledRevenue(env));
      else run("link checks run", scheduledLinkChecks(env));
    } else if (controller.cron === ROLLUP_CRON && now.getUTCHours() !== 1) run("site alerts run", runSiteAlerts(env, Math.floor(now.getTime() / 1000)));
    else run("daily run", scheduledDaily(env, now));
  },
} satisfies ExportedHandler<Env>;

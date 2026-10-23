import { utcDate } from "../shared/dates";
import { NOT_FOUND_IMAGE_PATH, NOT_FOUND_PREVIEW_PATH } from "../shared/not-found";
import { CHECKS_CRON, DIGEST_CRON } from "../shared/schedule";
import { serveAdmin } from "./admin";
import { pruneDaySalts } from "./analytics";
import { app } from "./app";
import { nowSec } from "./db";
import { SERVED_BY_HEADER } from "./dns-check";
import { resolveSite } from "./domains";
import { scheduledDaily, scheduledDigest, scheduledLinkChecks } from "./health";
import { PREVIEW_IMAGE_PATH } from "../shared/preview";
import { pruneHistory } from "./history";
import { prunePreviewImages, servePreviewImage } from "./preview";
import { loginApp } from "./login";
import { notFoundResponse, serveNotFoundImage } from "./not-found";
import { handleRedirect, redirectTo } from "./redirect";
import { pruneLoginState } from "./session";
import { pruneApiKeys } from "./users";

// The click-limit counter (a Durable Object class must be exported here).
export { ClickCap } from "./click-cap";

export default {
  async fetch(request, env, ctx) {
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
    if (site.adminOnly && !isAdmin && path !== "/health" && !isPreviewImage) {
      return path === "/" ? new Response(null, { status: 302, headers: { Location: "/_admin/" } }) : new Response("Not found", { status: 404 });
    }
    // Access protects /_admin/*; the bare /_admin may not be covered, so it never reaches the auth check.
    if (path === "/_admin") return new Response(null, { status: 301, headers: { Location: `/_admin/${url.search}` } });
    if (path.startsWith("/api/") || path.startsWith("/_admin/api/")) return app.fetch(request, env, ctx);
    if (path === "/_admin/login" || path === "/_admin/logout" || path.startsWith("/_admin/invite/")) return loginApp.fetch(request, env, ctx);
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

  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron === DIGEST_CRON) ctx.waitUntil(scheduledDigest(env, now));
    else if (controller.cron === CHECKS_CRON) ctx.waitUntil(scheduledLinkChecks(env));
    else {
      ctx.waitUntil(scheduledDaily(env, now));
      ctx.waitUntil(pruneLoginState(env.DB, nowSec()));
      ctx.waitUntil(pruneDaySalts(env.DB, utcDate(now)));
      ctx.waitUntil(pruneApiKeys(env.DB, nowSec()));
      ctx.waitUntil(prunePreviewImages(env).catch((err) => console.error(JSON.stringify({ message: "preview image prune failed", error: String(err) }))));
      ctx.waitUntil(pruneHistory(env.DB).catch((err) => console.error(JSON.stringify({ message: "history prune failed", error: String(err) }))));
    }
  },
} satisfies ExportedHandler<Env>;

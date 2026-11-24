// Admin API, mounted twice with different auth:
//   /_admin/api/*  CSRF and origin checks + Cloudflare Access JWT + password session (admin SPA)
//   /api/*         Bearer: personal API key or API_TOKEN (scripts, iOS Shortcuts)
// Then every route is checked against its rule in src/worker/permissions.ts.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { checksApi } from "./api/checks";
import { keysApi } from "./api/keys";
import { linksApi } from "./api/links";
import { meApi } from "./api/me";
import { previewsApi } from "./api/previews";
import { qrApi } from "./api/qr";
import { utmApi } from "./api/utm";
import { webhooksApi } from "./api/webhooks";
import { settingsApi } from "./api/settings";
import { backupApi } from "./api/backup";
import { mcpApi } from "./mcp";
import { sharesApi } from "./api/shares";
import { trackingApi } from "./api/tracking";
import { sitesApi } from "./api/sites";
import { statsApi } from "./api/stats";
import { usersApi } from "./api/users";
import { fullTokenScope, TOKEN_SCOPE_ERROR, verifyAdmin, verifyBearer, type AuthResult, type WaitUntil } from "./auth";
import { PREVIEW_IMAGE_MAX_BYTES } from "../shared/preview";
import type { AppEnv } from "./hono";
import { authorize, routeKey, TOKEN_READS, TOKEN_WRITES } from "./permissions";
import { redactSecrets, safePath } from "./redact";

/** Room for a preview image upload and its form encoding. */
const MAX_API_BODY = PREVIEW_IMAGE_MAX_BYTES + 64 * 1024;

export const api = new Hono<AppEnv>()
  .route("/", linksApi)
  .route("/", sharesApi)
  .route("/", trackingApi)
  .route("/stats", statsApi)
  .route("/settings", settingsApi)
  .route("/", backupApi)
  .route("/checks", checksApi)
  .route("/previews", previewsApi)
  .route("/utm-presets", utmApi)
  .route("/qr", qrApi)
  .route("/webhooks", webhooksApi)
  .route("/me", meApi)
  .route("/users", usersApi)
  .route("/keys", keysApi)
  .route("/sites", sitesApi)
  .route("/", mcpApi);

/**
 * Keeps the API_TOKEN secret to the reads in TOKEN_READS and to creating unless
 * API_TOKEN_SCOPE is "full", so a token leaked from a phone or a script can't
 * retarget links people already have, or collect webhook addresses, share
 * addresses, payment connections and customer data that would give it more.
 * Personal API keys carry their own permissions instead.
 */
const tokenScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("actor").via === "token" && !fullTokenScope(c.env)) {
    const key = routeKey(c);
    // No route matched: the app's 404.
    if (key && !(TOKEN_READS.has(key) || TOKEN_WRITES.has(key))) return c.json({ error: TOKEN_SCOPE_ERROR }, 403);
  }
  await next();
};

/**
 * State changes on the admin API come from the admin's own pages. The cookie is
 * SameSite=Strict and JSON needs a preflight nobody answers; this doesn't lean on
 * either. Browsers send Origin with every such request, or at least
 * Sec-Fetch-Site; a request with neither isn't from a browser, so no other site
 * can have caused it, and it still needs a session.
 */
const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    const site = c.req.header("Sec-Fetch-Site");
    const ok = origin !== undefined ? origin === new URL(c.req.url).origin : site === undefined || site === "same-origin" || site === "none";
    if (!ok) return c.json({ error: "This request came from another site, so it was refused.", code: "cross_origin" }, 403);
  }
  await next();
};

function guard(check: (req: Request, env: Env, ctx?: WaitUntil) => Promise<AuthResult>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = await check(c.req.raw, c.env, executionCtx(c));
    if (!auth.ok) {
      // A CSV download link is a navigation: send it to the login page, not a JSON file.
      if (auth.code === "login_required" && c.req.header("Sec-Fetch-Mode") === "navigate") {
        return c.redirect("/_admin/login", 303);
      }
      return c.json({ error: auth.reason, code: auth.code }, auth.status);
    }
    c.set("actor", auth.actor);
    c.set("identity", auth.identity);
    if (auth.sessionExp) c.set("sessionExp", auth.sessionExp);
    await next();
  };
}

/** The execution context, when the runtime passed one (tests calling app.request may not). */
function executionCtx(c: Context<AppEnv>): WaitUntil | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

export const app = new Hono<AppEnv>();

app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", referrerPolicy: "no-referrer", strictTransportSecurity: false }));
// The largest body any route takes is a preview image; uploads check their own tighter caps.
app.use("*", bodyLimit({ maxSize: MAX_API_BODY, onError: (c) => c.json({ error: "The request is too large" }, 413) }));
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
app.use("/_admin/api/*", csrf(), sameOrigin, guard(verifyAdmin), authorize);
app.use("/api/*", guard(verifyBearer), tokenScope, authorize);
app.route("/_admin/api", api);
app.route("/api", api);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message || "Request rejected" }, err.status);
  // The route's pattern, not the address: paths can hold emails and slugs.
  console.error(JSON.stringify({ message: "api error", route: routeKey(c) ?? safePath(c.req.path), error: redactSecrets(String(err)), stack: err.stack && redactSecrets(err.stack) }));
  return c.json({ error: "Internal error" }, 500);
});

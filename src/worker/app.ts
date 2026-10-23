// Admin API, mounted twice with different auth:
//   /_admin/api/*  CSRF check + Cloudflare Access JWT + password session (admin SPA)
//   /api/*         Bearer: personal API key or API_TOKEN (scripts, iOS Shortcuts)
// Then every route is checked against its rule in src/worker/permissions.ts.

import { Hono, type Context, type MiddlewareHandler } from "hono";
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
import { statsApi } from "./api/stats";
import { usersApi } from "./api/users";
import { fullTokenScope, TOKEN_SCOPE_ERROR, verifyAdmin, verifyBearer, type AuthResult, type WaitUntil } from "./auth";
import type { AppEnv } from "./hono";
import { authorize } from "./permissions";

export const api = new Hono<AppEnv>()
  .route("/", linksApi)
  .route("/stats", statsApi)
  .route("/settings", settingsApi)
  .route("/checks", checksApi)
  .route("/previews", previewsApi)
  .route("/utm-presets", utmApi)
  .route("/qr", qrApi)
  .route("/webhooks", webhooksApi)
  .route("/me", meApi)
  .route("/users", usersApi)
  .route("/keys", keysApi);

/** The writes the API token may make by default (import also refuses overwrite mode). */
const TOKEN_WRITES = new Set(["POST /api/links", "POST /api/import", "POST /api/settings/digest/test"]);

/**
 * Keeps the API_TOKEN secret to reading and creating unless API_TOKEN_SCOPE is
 * "full", so a token leaked from a phone or a script can't retarget the links
 * people already have. Personal API keys carry their own permissions instead.
 */
const tokenScope: MiddlewareHandler<AppEnv> = async (c, next) => {
  const read = c.req.method === "GET" || c.req.method === "HEAD";
  if (c.get("actor").via === "token" && !read && !fullTokenScope(c.env) && !TOKEN_WRITES.has(`${c.req.method} ${c.req.path}`)) {
    return c.json({ error: TOKEN_SCOPE_ERROR }, 403);
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

app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", referrerPolicy: "no-referrer" }));
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
app.use("/_admin/api/*", csrf(), guard(verifyAdmin), authorize);
app.use("/api/*", guard(verifyBearer), authorize, tokenScope);
app.route("/_admin/api", api);
app.route("/api", api);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message || "Request rejected" }, err.status);
  console.error(JSON.stringify({ message: "api error", path: c.req.path, error: String(err), stack: err.stack }));
  return c.json({ error: "Internal error" }, 500);
});

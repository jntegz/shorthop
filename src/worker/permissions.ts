// Who may call which API route. One table for every route of `api`
// (src/worker/app.ts), keyed by the exact pattern the router matched, so the
// check can never disagree with routing. A route without a rule is refused,
// and test/permissions.test.ts fails until it has one.

import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { readsLinks, type Actor, type Permission } from "../shared/permissions";
import type { AppEnv } from "./hono";

type Need =
  | "signed-in"
  /** Anyone holding a permission, and signed-in managers and admins (readsLinks). */
  | "links.read"
  | Permission
  | { any: Permission[] }
  | { all: Permission[] }
  /** Admins only. */
  | "admin"
  /** Admins and managers (who are limited further in src/worker/api/users.ts). */
  | "people"
  /** Anyone with a users row: owners change their password in wrangler config. */
  | "self-non-owner";

/** sessionOnly: refused for API keys and the API token, so a leaked key can't add people or mint keys. */
export interface Rule {
  need: Need;
  sessionOnly?: true;
}

const signedIn: Rule = { need: "signed-in" };
const linkReader: Rule = { need: "links.read" };
const need = (p: Need): Rule => ({ need: p });
const session = (p: Need): Rule => ({ need: p, sessionOnly: true });

export const RULES: Record<string, Rule> = {
  // Links: viewing and copying them takes some permission, whichever it is. Destinations
  // and notes of password-protected links also need links.edit (checked in the handlers).
  "GET /links": linkReader,
  "POST /links": need("links.create"),
  "GET /links/:domain/:slug": linkReader,
  "PATCH /links/:domain/:slug": need("links.edit"),
  "GET /links/:domain/:slug/dependents": linkReader,
  "DELETE /links/:domain/:slug": need("links.delete"),
  "GET /links/:domain/:slug/history": linkReader,
  "POST /links/:domain/:slug/history/:id/restore": need("links.edit"),
  "GET /links/:domain/:slug/cap": linkReader,
  "POST /links/:domain/:slug/cap/reset": need("links.edit"),
  // Advanced tracking: the click log. Switching IP recording on also needs clicks.ip (checked in the handler).
  "PUT /links/:domain/:slug/tracking": need({ all: ["links.edit", "clicks.view"] }),
  "GET /links/:domain/:slug/clicks": need("clicks.view"),
  "GET /links/:domain/:slug/clicks.csv": need("clicks.view"),
  "DELETE /links/:domain/:slug/clicks": need({ all: ["links.edit", "clicks.view"] }),
  "DELETE /links/:domain/:slug/clicks/:id": need({ all: ["links.edit", "clicks.view"] }),
  // The workspace's rules for Advanced tracking: readable by everyone signed in (the link editor shows them), set by admins.
  "GET /tracking/policy": signedIn,
  "PUT /tracking/policy": session("admin"),
  // A person's clicks by IP address (access and erasure requests).
  "POST /clicks/by-ip": need({ all: ["clicks.view", "clicks.ip"] }),
  "POST /clicks/by-ip/erase": need({ all: ["clicks.view", "clicks.ip", "links.edit"] }),
  "GET /deleted": linkReader,
  "POST /deleted/:domain/:slug/restore": need("links.delete"),
  "GET /tags": linkReader,
  "POST /tags/rename": need("links.edit"),
  "DELETE /tags/:tag": need("links.edit"),
  "GET /links/by-target": linkReader,
  // Enable, disable and tags need links.edit, delete links.delete (checked in the handler).
  "POST /links/bulk": need({ any: ["links.edit", "links.delete"] }),
  // Overwriting existing links also needs links.edit (checked in the handler).
  "POST /import": need("links.create"),
  // Takes another service's API key: only from a signed-in session, never from a script's key.
  "POST /import/pull": session("links.create"),
  "GET /export/links.json": linkReader,
  // Everything the workspace holds (without secrets): admins, from a signed-in session.
  // MCP for AI assistants: any signed-in key; each tool's own route then checks its permission.
  "POST /mcp": signedIn,
  "GET /mcp": signedIn,
  // Code Mode: whatever its code asks for goes through these rules again, route by route.
  "POST /mcp/code": signedIn,
  "GET /mcp/code": signedIn,
  "GET /openapi.json": signedIn,
  "GET /backup": session("admin"),
  "GET /backup/:table": session("admin"),
  "POST /resync": need({ any: ["links.edit", "settings.manage"] }),
  "GET /export/links.csv": linkReader,
  // Shared statistics pages: they publish a link's stats, so both are needed.
  "GET /links/:domain/:slug/shares": need({ all: ["stats.view", "links.edit"] }),
  "POST /links/:domain/:slug/shares": need({ all: ["stats.view", "links.edit"] }),
  "GET /shares": need({ all: ["stats.view", "links.edit"] }),
  // Showing revenue on a report also needs revenue.view (checked in the handler).
  "POST /shares": need({ all: ["stats.view", "links.edit"] }),
  "PATCH /shares/:id": need({ all: ["stats.view", "links.edit"] }),
  "DELETE /shares/:id": need({ all: ["stats.view", "links.edit"] }),

  // Statistics, and missed visits (which belong to Link health).
  "GET /stats/overview": need("stats.view"),
  "GET /stats/account": need("stats.view"),
  "GET /stats/links/:domain/:slug": need("stats.view"),
  "GET /stats/live": need("stats.view"),
  "GET /stats/peak-hours": need("stats.view"),
  "GET /stats/links/:domain/:slug/peak-hours": need("stats.view"),
  "GET /stats/recent": need("stats.view"),
  "GET /stats/export.csv": need("stats.view"),
  "GET /stats/misses": need("health.manage"),
  "POST /stats/misses/clear": need("health.manage"),
  "POST /stats/misses/ignore": need("health.manage"),
  "POST /stats/misses/unignore": need("health.manage"),
  "GET /stats/misses/ignored": need("health.manage"),
  "GET /stats/misses/ignored.csv": need("health.manage"),
  "POST /stats/misses/ignored/clear": need("health.manage"),
  "GET /stats/misses/export.csv": need("health.manage"),
  "PUT /stats/misses/policy": need("settings.manage"),

  // Destination checks.
  "GET /checks": need("health.manage"),
  "PUT /checks/settings": need("settings.manage"),
  "POST /checks/recheck": need("health.manage"),
  "PUT /checks/confirmed": need("health.manage"),
  "GET /checks/links/:domain/:slug": linkReader,
  "POST /checks/links/:domain/:slug": need("health.manage"),

  // Link editor helpers.
  "POST /previews/images": need({ any: ["links.create", "links.edit"] }),
  "POST /previews/fetch": need({ any: ["links.create", "links.edit"] }),
  "POST /previews/ai/slug": need({ any: ["links.create", "links.edit"] }),
  "POST /previews/ai/preview": need({ any: ["links.create", "links.edit"] }),
  "GET /utm-presets": signedIn,
  "POST /utm-presets": need("settings.manage"),
  "PUT /utm-presets/:id": need("settings.manage"),
  "DELETE /utm-presets/:id": need("settings.manage"),
  "GET /qr/default": signedIn,
  "PUT /qr/default": need("settings.manage"),

  // Webhooks.
  "GET /webhooks": need("settings.manage"),
  "POST /webhooks": need("settings.manage"),
  "PUT /webhooks/:id": need("settings.manage"),
  "POST /webhooks/:id/rotate": need("settings.manage"),
  "DELETE /webhooks/:id": need("settings.manage"),
  "POST /webhooks/:id/test": need("settings.manage"),
  "GET /webhooks/:id/deliveries": need("settings.manage"),
  "POST /webhooks/deliveries/:delivery/redeliver": need("settings.manage"),

  // Workspace settings.
  "GET /settings": need("settings.manage"),
  "PUT /settings": need("settings.manage"),
  "GET /settings/not-found": need("settings.manage"),
  "PUT /settings/not-found": need("settings.manage"),
  "GET /settings/not-found/image": need("settings.manage"),
  "PUT /settings/not-found/image": need("settings.manage"),
  "DELETE /settings/not-found/image": need("settings.manage"),
  "GET /settings/dead-link": need("settings.manage"),
  "PUT /settings/dead-link": need("settings.manage"),
  "POST /settings/rollup": need("settings.manage"),
  "GET /settings/health": need("settings.manage"),
  "GET /settings/version": need("settings.manage"),
  "POST /settings/health/test-alert": need("settings.manage"),
  // The digest shows click statistics.
  "GET /settings/digest/preview": need({ all: ["settings.manage", "stats.view"] }),
  "POST /settings/digest/test": need("settings.manage"),
  // Which email secrets are set, and whether security email goes out at all: never for a key or token that may sit in a script.
  // Changing it is for admins: turned off, it silences the two-factor, lockout and reset notices of everyone, owners included.
  "GET /settings/mail": session("settings.manage"),
  "PUT /settings/mail": session("admin"),
  "DELETE /settings/mail": session("admin"),
  "GET /settings/domains/check": need("settings.manage"),
  // Deletes a domain's links and stats: admins in the admin only, never a leaked key.
  "POST /settings/domains/purge": session("admin"),
  "DELETE /settings/demo": need("settings.manage"),
  "POST /settings/sessions/revoke": session("admin"),
  "GET /settings/turnstile": session("admin"),
  "PUT /settings/turnstile": session("admin"),
  "DELETE /settings/turnstile": session("admin"),
  "PUT /settings/two-factor": session("admin"),

  // The signed-in person, people and API keys.
  "GET /me": signedIn,
  "POST /me/password": session("self-non-owner"),
  // Your own two-factor sign-in: a session only, never a key.
  "GET /me/security": session("signed-in"),
  "POST /me/totp/setup": session("signed-in"),
  "POST /me/totp/confirm": session("signed-in"),
  "POST /me/passkeys/options": session("signed-in"),
  "POST /me/passkeys": session("signed-in"),
  "PATCH /me/factors/:id": session("signed-in"),
  "DELETE /me/factors/:id": session("signed-in"),
  "POST /me/recovery-codes": session("signed-in"),
  "GET /users": session("people"),
  "POST /users": session("people"),
  "PATCH /users/:email": session("people"),
  "DELETE /users/:email": session("people"),
  "POST /users/:email/invite": session("people"),
  "POST /users/:email/pause": session("people"),
  "POST /users/:email/resume": session("people"),
  "POST /users/:email/sign-out": session("people"),
  "POST /users/:email/revoke-keys": session("people"),
  "POST /users/:email/two-factor/reset": session("people"),
  "GET /keys": session("api.use"),
  "POST /keys": session("api.use"),
  "DELETE /keys/:id": session("api.use"),

  // Tracked websites and their revenue. Traffic is statistics; money needs revenue.view.
  "GET /sites": need("stats.view"),
  "POST /sites": need("sites.manage"),
  "GET /sites/by-link/:domain/:slug": need("revenue.view"),
  "GET /sites/:id": need("stats.view"),
  "PATCH /sites/:id": need("sites.manage"),
  "DELETE /sites/:id": need("sites.manage"),
  "GET /sites/:id/overview": need("stats.view"),
  "GET /sites/:id/breakdown": need("stats.view"),
  "GET /sites/:id/events": need("stats.view"),
  "GET /sites/:id/goal-props": need("stats.view"),
  "GET /sites/:id/live": need("stats.view"),
  "GET /sites/:id/peak-hours": need("stats.view"),
  "GET /sites/:id/engagement": need("stats.view"),
  "GET /sites/:id/page-speed": need("stats.view"),
  "GET /sites/:id/purchase-paths": need("revenue.view"),
  "GET /sites/:id/customer-value": need("revenue.view"),
  "GET /sites/:id/install-status": need("stats.view"),
  "GET /sites/:id/payments": need("revenue.view"),
  "GET /sites/:id/payments.csv": need("revenue.view"),
  // Searches: POST so that an email searched for stays out of URLs. They change nothing.
  "POST /sites/:id/payments/search": need("revenue.view"),
  "POST /sites/:id/payments/search.csv": need("revenue.view"),
  "GET /sites/:id/subscriptions": need("revenue.view"),
  "GET /sites/:id/visitors/:visitor": need("revenue.view"),
  // One person's records: finding, exporting and erasing them touches customers' details, so both are needed.
  "POST /sites/:id/privacy/lookup": need({ all: ["sites.manage", "revenue.view"] }),
  "POST /sites/:id/privacy/export": need({ all: ["sites.manage", "revenue.view"] }),
  "POST /sites/:id/privacy/erase": need({ all: ["sites.manage", "revenue.view"] }),
  "POST /sites/:id/privacy/reapply": need({ all: ["sites.manage", "revenue.view"] }),
  "GET /sites/:id/privacy/requests": need({ all: ["sites.manage", "revenue.view"] }),
  "POST /sites/:id/rematch": need("sites.manage"),
  "GET /sites/:id/funnels": need("stats.view"),
  "POST /sites/:id/funnels": need("sites.manage"),
  "DELETE /sites/:id/funnels/:funnel": need("sites.manage"),
  "GET /sites/:id/funnels/:funnel/report": need("stats.view"),
  "GET /sites/:id/connections": need("sites.manage"),
  "POST /sites/:id/connections": need("sites.manage"),
  "PATCH /sites/:id/connections/:conn": need("sites.manage"),
  "DELETE /sites/:id/connections/:conn": need("sites.manage"),
  "POST /sites/:id/connections/:conn/import": need("sites.manage"),
  "POST /sites/:id/connections/:conn/check": need("sites.manage"),
  "POST /sites/:id/payments": need("sites.manage"),
  "POST /sites/:id/identify": need("sites.manage"),
};

/** The writes the API token may make by default (import also refuses overwrite mode). */
export const TOKEN_WRITES: ReadonlySet<string> = new Set(["POST /links", "POST /import", "POST /settings/digest/test"]);

/**
 * What the API_TOKEN secret may read unless API_TOKEN_SCOPE is "full": links,
 * statistics and the workspace basics. A list, so a new route stays closed until
 * it is added here. Never add a route that returns a value granting further
 * access (webhook addresses, share addresses, payment connections) or customer
 * data. Its writes are TOKEN_WRITES; src/worker/app.ts applies both.
 */
export const TOKEN_READS: ReadonlySet<string> = new Set([
  "GET /me",
  "GET /openapi.json",
  "GET /links",
  "GET /links/by-target",
  "GET /links/:domain/:slug",
  "GET /links/:domain/:slug/dependents",
  "GET /links/:domain/:slug/history",
  "GET /links/:domain/:slug/cap",
  "GET /deleted",
  "GET /tags",
  "GET /export/links.json",
  "GET /export/links.csv",
  "GET /stats/overview",
  "GET /stats/account",
  "GET /stats/live",
  "GET /stats/peak-hours",
  "GET /stats/recent",
  "GET /stats/export.csv",
  "GET /stats/links/:domain/:slug",
  "GET /stats/links/:domain/:slug/peak-hours",
  "GET /checks",
  "GET /checks/links/:domain/:slug",
  "GET /utm-presets",
  "GET /qr/default",
  "GET /settings",
  "GET /settings/health",
  "GET /settings/version",
]);

export function allowed(actor: Actor, rule: Rule): boolean {
  if (rule.sessionOnly && actor.via !== "session") return false;
  const n = rule.need;
  if (n === "signed-in") return true;
  if (n === "links.read") return readsLinks(actor);
  if (n === "admin") return actor.role === "admin";
  if (n === "people") return actor.role === "admin" || actor.role === "manager";
  if (n === "self-non-owner") return !actor.owner;
  if (typeof n === "object") return "any" in n ? n.any.some((p) => actor.permissions.includes(p)) : n.all.every((p) => actor.permissions.includes(p));
  return actor.permissions.includes(n);
}

const MOUNTS = ["/_admin/api", "/api"];

export const FORBIDDEN = { error: "You don't have permission to do this.", code: "forbidden" } as const;

/** The route the router chose, as "METHOD /path" with the mount taken off; null when only middleware matched. */
export function routeKey(c: Context<AppEnv>): string | null {
  // The router has already chosen the handler; ALL entries are middleware.
  const route = matchedRoutes(c).find((r) => r.method !== "ALL");
  if (!route) return null;
  const mount = MOUNTS.find((m) => route.path.startsWith(`${m}/`));
  return `${route.method} ${mount ? route.path.slice(mount.length) : route.path}`;
}

/** Runs after the auth guard: refuses what the actor may not do, and any route without a rule. */
export const authorize: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = routeKey(c);
  if (!key) return next(); // nothing but middleware matched: the app's 404
  const rule = RULES[key];
  if (!rule || !allowed(c.get("actor"), rule)) return c.json(FORBIDDEN, 403);
  await next();
};

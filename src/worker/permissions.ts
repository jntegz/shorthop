// Who may call which API route. One table for every route of `api`
// (src/worker/app.ts), keyed by the exact pattern the router matched, so the
// check can never disagree with routing. A route without a rule is refused,
// and test/permissions.test.ts fails until it has one.

import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { Actor, Permission } from "../shared/permissions";
import type { AppEnv } from "./hono";

type Need =
  | "signed-in"
  | Permission
  | { any: Permission[] }
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
const need = (p: Need): Rule => ({ need: p });
const session = (p: Need): Rule => ({ need: p, sessionOnly: true });

export const RULES: Record<string, Rule> = {
  // Links: everyone can view and copy them.
  "GET /links": signedIn,
  "POST /links": need("links.create"),
  "GET /links/:domain/:slug": signedIn,
  "PATCH /links/:domain/:slug": need("links.edit"),
  "GET /links/:domain/:slug/dependents": signedIn,
  "DELETE /links/:domain/:slug": need("links.delete"),
  "GET /links/:domain/:slug/history": signedIn,
  "POST /links/:domain/:slug/history/:id/restore": need("links.edit"),
  "GET /links/:domain/:slug/cap": signedIn,
  "POST /links/:domain/:slug/cap/reset": need("links.edit"),
  "GET /deleted": signedIn,
  "POST /deleted/:domain/:slug/restore": need("links.delete"),
  "GET /tags": signedIn,
  // Overwriting existing links also needs links.edit (checked in the handler).
  "POST /import": need("links.create"),
  "POST /resync": need({ any: ["links.edit", "settings.manage"] }),
  "GET /export/links.csv": signedIn,

  // Statistics, and missed visits (which belong to Link health).
  "GET /stats/overview": need("stats.view"),
  "GET /stats/account": need("stats.view"),
  "GET /stats/links/:domain/:slug": need("stats.view"),
  "GET /stats/recent": need("stats.view"),
  "GET /stats/export.csv": need("stats.view"),
  "GET /stats/misses": need("health.manage"),
  "POST /stats/misses/clear": need("health.manage"),
  "GET /stats/misses/export.csv": need("health.manage"),
  "PUT /stats/misses/policy": need("settings.manage"),

  // Destination checks.
  "GET /checks": need("health.manage"),
  "PUT /checks/settings": need("settings.manage"),
  "POST /checks/recheck": need("health.manage"),
  "GET /checks/links/:domain/:slug": signedIn,
  "POST /checks/links/:domain/:slug": need("health.manage"),

  // Link editor helpers.
  "POST /previews/images": need({ any: ["links.create", "links.edit"] }),
  "POST /previews/fetch": need({ any: ["links.create", "links.edit"] }),
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
  "POST /settings/health/test-alert": need("settings.manage"),
  "GET /settings/digest/preview": need("settings.manage"),
  "POST /settings/digest/test": need("settings.manage"),
  // Which email secrets are set: never for a key or token that may sit in a script.
  "GET /settings/mail": session("settings.manage"),
  "PUT /settings/mail": need("settings.manage"),
  "DELETE /settings/mail": need("settings.manage"),
  "GET /settings/domains/check": need("settings.manage"),
  // Deletes a domain's links and stats: admins in the admin only, never a leaked key.
  "POST /settings/domains/purge": session("admin"),
  "DELETE /settings/demo": need("settings.manage"),
  "POST /settings/sessions/revoke": session("admin"),

  // The signed-in person, people and API keys.
  "GET /me": signedIn,
  "POST /me/password": session("self-non-owner"),
  "GET /users": session("people"),
  "POST /users": session("people"),
  "PATCH /users/:email": session("people"),
  "DELETE /users/:email": session("people"),
  "POST /users/:email/invite": session("people"),
  "GET /keys": session("api.use"),
  "POST /keys": session("api.use"),
  "DELETE /keys/:id": session("api.use"),
};

export function allowed(actor: Actor, rule: Rule): boolean {
  if (rule.sessionOnly && actor.via !== "session") return false;
  const n = rule.need;
  if (n === "signed-in") return true;
  if (n === "admin") return actor.role === "admin";
  if (n === "people") return actor.role === "admin" || actor.role === "manager";
  if (n === "self-non-owner") return !actor.owner;
  if (typeof n === "object") return n.any.some((p) => actor.permissions.includes(p));
  return actor.permissions.includes(n);
}

const MOUNTS = ["/_admin/api", "/api"];

/** The rule for a matched route ("GET /_admin/api/links/:domain/:slug"), whichever mount it came through. */
export function ruleFor(method: string, path: string): Rule | undefined {
  const mount = MOUNTS.find((m) => path.startsWith(`${m}/`));
  return mount ? RULES[`${method} ${path.slice(mount.length)}`] : undefined;
}

export const FORBIDDEN = { error: "You don't have permission to do this.", code: "forbidden" } as const;

/** Runs after the auth guard: refuses what the actor may not do, and any route without a rule. */
export const authorize: MiddlewareHandler<AppEnv> = async (c, next) => {
  // The router has already chosen the handler; ALL entries are middleware.
  const route = matchedRoutes(c).find((r) => r.method !== "ALL");
  if (!route) return next(); // nothing but middleware matched: the app's 404
  const rule = ruleFor(route.method, route.path);
  if (!rule || !allowed(c.get("actor"), rule)) return c.json(FORBIDDEN, 403);
  await next();
};

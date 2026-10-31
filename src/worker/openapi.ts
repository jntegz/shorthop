// The public API as an OpenAPI 3.0 document, built from the same zod schemas
// the routes validate with (z.toJSONSchema, input side). Every route with a
// permission rule is either described here or listed in INTERNAL;
// test/openapi.test.ts fails on a route that is neither, so new endpoints get
// documented. Rules a schema expresses with .refine() (such as "target or url")
// aren't in JSON Schema; the summaries say so where it matters.

import { z } from "zod";
import {
  bulkSchema,
  byTargetQuerySchema,
  checkSettingsSchema,
  createCampaignShareSchema,
  createLinkSchema,
  createShareSchema,
  exportQuerySchema,
  fetchPreviewSchema,
  importSchema,
  listQuerySchema,
  missPolicySchema,
  rangeQuerySchema,
  tagRenameSchema,
  updateLinkSchema,
  updateShareSchema,
  utmPresetSchema,
} from "../shared/schemas";
import { apiIdentifySchema, apiPaymentSchema, breakdownQuerySchema, createSiteSchema, eventListQuerySchema, funnelSchema, goalPropsQuerySchema, paymentsQuerySchema, peakQuerySchema, siteQuerySchema, updateSiteSchema } from "../shared/sites";
import { RULES } from "./permissions";

interface Route {
  summary: string;
  tag: string;
  query?: z.ZodType;
  body?: z.ZodType;
  /** The response isn't JSON. */
  produces?: "text/csv" | "text/plain";
}

/** "METHOD /path" as in RULES → its description. */
export const CATALOG: Record<string, Route> = {
  "GET /me": { tag: "Account", summary: "Who the key acts as, its permissions, and the workspace basics" },

  "GET /links": { tag: "Links", summary: "List links with clicks in a period (up to 5,000)", query: listQuerySchema },
  "POST /links": { tag: "Links", summary: "Create a link (target or url is required). ?format=text returns just the short URL.", body: createLinkSchema },
  "GET /links/:domain/:slug": { tag: "Links", summary: "One link with all its settings" },
  "PATCH /links/:domain/:slug": { tag: "Links", summary: "Change any of a link's settings; only the fields sent change", body: updateLinkSchema },
  "DELETE /links/:domain/:slug": { tag: "Links", summary: "Delete a link (restorable for 90 days)" },
  "GET /links/:domain/:slug/dependents": { tag: "Links", summary: "Links that send their visitors to this one" },
  "GET /links/:domain/:slug/history": { tag: "Links", summary: "A link's saved versions" },
  "POST /links/:domain/:slug/history/:id/restore": { tag: "Links", summary: "Put a link back the way it was in a version" },
  "GET /links/:domain/:slug/cap": { tag: "Links", summary: "A capped link's click counter" },
  "POST /links/:domain/:slug/cap/reset": { tag: "Links", summary: "Start a capped link's count again" },
  "GET /links/by-target": { tag: "Links", summary: "Links that already go to a destination", query: byTargetQuerySchema },
  "POST /links/bulk": { tag: "Links", summary: "Enable, disable, tag, untag or delete many links (20 per request on Workers Free, 100 on Paid)", body: bulkSchema },
  "GET /deleted": { tag: "Links", summary: "Recently deleted links" },
  "POST /deleted/:domain/:slug/restore": { tag: "Links", summary: "Restore a deleted link" },
  "GET /tags": { tag: "Links", summary: "Tags, with how many links have each" },
  "POST /tags/rename": { tag: "Links", summary: "Rename a tag on every link, or merge it into another", body: tagRenameSchema },
  "DELETE /tags/:tag": { tag: "Links", summary: "Remove a tag from every link" },
  "POST /import": { tag: "Links", summary: "Import links (20 rows per request on Workers Free, 100 on Paid)", body: importSchema },
  "POST /resync": { tag: "Links", summary: "Republish links to the edge, a page at a time; call again with next until it is null" },
  "GET /export/links.csv": { tag: "Links", summary: "Links as CSV, optionally filtered", query: exportQuerySchema, produces: "text/csv" },
  "GET /export/links.json": { tag: "Links", summary: "Every link with its settings, as import rows (never passwords)" },

  "GET /links/:domain/:slug/shares": { tag: "Sharing", summary: "A link's shared statistics pages" },
  "POST /links/:domain/:slug/shares": { tag: "Sharing", summary: "Share a link's statistics on a read-only page", body: createShareSchema },
  "GET /shares": { tag: "Sharing", summary: "Shared campaign reports (a tag or a set of links)" },
  "POST /shares": { tag: "Sharing", summary: "Share a report on every link with a tag, or a set of links (a tag or links is required)", body: createCampaignShareSchema },
  "PATCH /shares/:id": { tag: "Sharing", summary: "Change or stop a share", body: updateShareSchema },
  "DELETE /shares/:id": { tag: "Sharing", summary: "Remove an ended share from the list" },

  "GET /stats/overview": { tag: "Statistics", summary: "All links: totals, daily series, top links, countries, sources, devices, comparison", query: rangeQuerySchema },
  "GET /stats/account": { tag: "Statistics", summary: "The overview with every breakdown", query: rangeQuerySchema },
  "GET /stats/links/:domain/:slug": { tag: "Statistics", summary: "One link's statistics with every breakdown", query: rangeQuerySchema },
  "GET /stats/peak-hours": { tag: "Statistics", summary: "All links' clicks by weekday and hour (tz, days up to 89)" },
  "GET /stats/links/:domain/:slug/peak-hours": { tag: "Statistics", summary: "One link's clicks by weekday and hour (tz, days up to 89)" },
  "GET /stats/live": { tag: "Statistics", summary: "Human clicks with a city-level location in the last minutes (minutes, default 15; domain), for a live map" },
  "GET /stats/recent": { tag: "Statistics", summary: "Latest hits (domain, slug, limit, event, country, device, hours)" },
  "GET /stats/export.csv": { tag: "Statistics", summary: "Daily clicks per link as CSV", query: rangeQuerySchema, produces: "text/csv" },
  "GET /stats/misses": { tag: "Link health", summary: "Addresses opened that have no link", query: rangeQuerySchema },
  "POST /stats/misses/clear": { tag: "Link health", summary: "Clear missed-link counts" },
  "POST /stats/misses/ignore": { tag: "Link health", summary: "Stop listing missed paths, optionally sending them to a link" },
  "POST /stats/misses/unignore": { tag: "Link health", summary: "List ignored paths again" },
  "GET /stats/misses/ignored": { tag: "Link health", summary: "Ignored paths" },
  "GET /stats/misses/ignored.csv": { tag: "Link health", summary: "Ignored paths as CSV", produces: "text/csv" },
  "POST /stats/misses/ignored/clear": { tag: "Link health", summary: "List every ignored path again" },
  "GET /stats/misses/export.csv": { tag: "Link health", summary: "Missed links as CSV", produces: "text/csv" },
  "PUT /stats/misses/policy": { tag: "Link health", summary: "Which misses are recorded, and how many kept", body: missPolicySchema },
  "GET /checks": { tag: "Link health", summary: "Destination checks for every link" },
  "PUT /checks/settings": { tag: "Link health", summary: "Turn checks on or off, and how often", body: checkSettingsSchema },
  "POST /checks/recheck": { tag: "Link health", summary: "Check destinations with problems now" },
  "GET /checks/links/:domain/:slug": { tag: "Link health", summary: "One link's destination checks" },
  "POST /checks/links/:domain/:slug": { tag: "Link health", summary: "Check one link's destinations now" },

  "POST /previews/images": { tag: "Tools", summary: "Upload a social-preview image (raw bytes, up to 5 MB)" },
  "POST /previews/fetch": { tag: "Tools", summary: "Read a page's own title, description and image", body: fetchPreviewSchema },
  "POST /previews/ai/slug": { tag: "Tools", summary: "Workers AI: slug ideas for a destination (501 without the AI binding)", body: fetchPreviewSchema },
  "POST /previews/ai/preview": { tag: "Tools", summary: "Workers AI: a preview title and description (501 without the AI binding)", body: fetchPreviewSchema },
  "GET /utm-presets": { tag: "Tools", summary: "Saved UTM templates" },
  "POST /utm-presets": { tag: "Tools", summary: "Save a UTM template", body: utmPresetSchema },
  "PUT /utm-presets/:id": { tag: "Tools", summary: "Change a UTM template", body: utmPresetSchema },
  "DELETE /utm-presets/:id": { tag: "Tools", summary: "Delete a UTM template" },
  "GET /qr/default": { tag: "Tools", summary: "The default QR code design" },
  "PUT /qr/default": { tag: "Tools", summary: "Set the default QR code design" },
  "GET /webhooks": { tag: "Webhooks", summary: "Webhooks and their delivery status" },
  "POST /webhooks": { tag: "Webhooks", summary: "Add a webhook" },
  "PUT /webhooks/:id": { tag: "Webhooks", summary: "Change a webhook" },
  "POST /webhooks/:id/rotate": { tag: "Webhooks", summary: "Make a new signing secret" },
  "DELETE /webhooks/:id": { tag: "Webhooks", summary: "Delete a webhook" },
  "POST /webhooks/:id/test": { tag: "Webhooks", summary: "Send a test event" },
  "GET /webhooks/:id/deliveries": { tag: "Webhooks", summary: "The last deliveries" },
  "POST /webhooks/deliveries/:delivery/redeliver": { tag: "Webhooks", summary: "Send a delivery again" },
  "POST /mcp": { tag: "AI assistants", summary: "Model Context Protocol server (JSON-RPC): tools to create links and read statistics" },

  "GET /sites": { tag: "Websites", summary: "Tracked websites with visitors and revenue" },
  "POST /sites": { tag: "Websites", summary: "Add a website", body: createSiteSchema },
  "GET /sites/by-link/:domain/:slug": { tag: "Websites", summary: "Revenue a short link brought to your websites" },
  "GET /sites/:id": { tag: "Websites", summary: "One website's settings" },
  "PATCH /sites/:id": { tag: "Websites", summary: "Change a website's settings", body: updateSiteSchema },
  "DELETE /sites/:id": { tag: "Websites", summary: "Delete a website and all its data" },
  "GET /sites/:id/overview": { tag: "Websites", summary: "Visitors, sessions, revenue and conversion, with a series", query: siteQuerySchema },
  "GET /sites/:id/breakdown": { tag: "Websites", summary: "Visitors and revenue by one dimension", query: breakdownQuerySchema },
  "GET /sites/:id/events": { tag: "Websites", summary: "Pages, goals or outbound links", query: eventListQuerySchema },
  "GET /sites/:id/goal-props": { tag: "Websites", summary: "The properties sent with a goal", query: goalPropsQuerySchema },
  "GET /sites/:id/live": { tag: "Websites", summary: "Visitors online now and the latest visits" },
  "GET /sites/:id/peak-hours": { tag: "Websites", summary: "Visits, sales or revenue by weekday and hour", query: peakQuerySchema },
  "GET /sites/:id/engagement": { tag: "Websites", summary: "Reading time and scroll depth per page", query: siteQuerySchema },
  "GET /sites/:id/page-speed": { tag: "Websites", summary: "Core Web Vitals at the 75th percentile", query: siteQuerySchema },
  "GET /sites/:id/purchase-paths": { tag: "Websites", summary: "How long new customers took, and where they came from", query: siteQuerySchema },
  "GET /sites/:id/customer-value": { tag: "Websites", summary: "Customer value by first source", query: siteQuerySchema },
  "GET /sites/:id/install-status": { tag: "Websites", summary: "Whether the tracker is sending visits" },
  "GET /sites/:id/payments": { tag: "Revenue", summary: "Payments and the visits they were matched to", query: paymentsQuerySchema },
  "GET /sites/:id/payments.csv": { tag: "Revenue", summary: "Payments as CSV", query: paymentsQuerySchema, produces: "text/csv" },
  "GET /sites/:id/subscriptions": { tag: "Revenue", summary: "MRR, new subscriptions and churn", query: siteQuerySchema },
  "GET /sites/:id/visitors/:visitor": { tag: "Revenue", summary: "One visitor's visits and payments" },
  "POST /sites/:id/rematch": { tag: "Revenue", summary: "Try matching unmatched payments again" },
  "GET /sites/:id/funnels": { tag: "Websites", summary: "Saved funnels" },
  "POST /sites/:id/funnels": { tag: "Websites", summary: "Save a funnel", body: funnelSchema },
  "DELETE /sites/:id/funnels/:funnel": { tag: "Websites", summary: "Delete a funnel" },
  "GET /sites/:id/funnels/:funnel/report": { tag: "Websites", summary: "How many visitors reach each step", query: siteQuerySchema },
  "POST /sites/:id/payments": { tag: "Revenue", summary: "Record a payment from your own backend (billing without a provider adapter)", body: apiPaymentSchema },
  "POST /sites/:id/identify": { tag: "Revenue", summary: "Tell who a visitor is, from your own backend", body: apiIdentifySchema },
};

/** Routes left out of the public reference: admin-only settings, people, keys, secrets and other sign-in-only tools. */
export const INTERNAL = new Set([
  "GET /mcp",
  "GET /openapi.json",
  "POST /import/pull",
  "GET /backup",
  "GET /backup/:table",
  "POST /me/password",
  "GET /settings",
  "PUT /settings",
  "GET /settings/not-found",
  "PUT /settings/not-found",
  "GET /settings/not-found/image",
  "PUT /settings/not-found/image",
  "DELETE /settings/not-found/image",
  "GET /settings/dead-link",
  "PUT /settings/dead-link",
  "POST /settings/rollup",
  "GET /settings/health",
  "POST /settings/health/test-alert",
  "GET /settings/digest/preview",
  "POST /settings/digest/test",
  "GET /settings/mail",
  "PUT /settings/mail",
  "DELETE /settings/mail",
  "GET /settings/domains/check",
  "POST /settings/domains/purge",
  "DELETE /settings/demo",
  "GET /settings/version",
  "POST /settings/sessions/revoke",
  "GET /settings/turnstile",
  "PUT /settings/turnstile",
  "DELETE /settings/turnstile",
  "GET /users",
  "POST /users",
  "PATCH /users/:email",
  "DELETE /users/:email",
  "POST /users/:email/invite",
  "POST /users/:email/pause",
  "POST /users/:email/resume",
  "POST /users/:email/sign-out",
  "GET /keys",
  "POST /keys",
  "DELETE /keys/:id",
  "POST /sites/:id/privacy/lookup",
  "POST /sites/:id/privacy/export",
  "POST /sites/:id/privacy/erase",
  "GET /sites/:id/privacy/requests",
  "GET /sites/:id/connections",
  "POST /sites/:id/connections",
  "PATCH /sites/:id/connections/:conn",
  "DELETE /sites/:id/connections/:conn",
  "POST /sites/:id/connections/:conn/import",
  "POST /sites/:id/connections/:conn/check",
]);

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  try {
    const out = z.toJSONSchema(schema, { io: "input", target: "openapi-3.0", unrepresentable: "any" }) as Record<string, unknown>;
    delete out.$schema;
    return out;
  } catch {
    return { type: "object" };
  }
}

function permissionText(key: string): string {
  const rule = RULES[key];
  if (!rule) return "";
  const need = rule.need;
  const text =
    need === "signed-in"
      ? "any key"
      : typeof need === "string"
        ? need
        : "any" in need
          ? `one of ${need.any.join(", ")}`
          : "all" in need
            ? `all of ${need.all.join(", ")}`
            : String(need);
  return ` Needs: ${text}.`;
}

/** The OpenAPI document for this workspace's API at `origin`. */
export function openApiDocument(origin: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, route] of Object.entries(CATALOG)) {
    const [method, rawPath] = key.split(" ") as [string, string];
    const path = rawPath.replace(/:([a-z]+)/gi, "{$1}");
    const params = [...rawPath.matchAll(/:([a-z]+)/gi)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const query = route.query ? jsonSchema(route.query) : null;
    const queryParams = query
      ? Object.entries((query.properties ?? {}) as Record<string, Record<string, unknown>>).map(([name, schema]) => ({
          name,
          in: "query",
          required: ((query.required as string[] | undefined) ?? []).includes(name) && !("default" in schema),
          schema,
        }))
      : [];
    paths[path] ??= {};
    paths[path][method.toLowerCase()] = {
      tags: [route.tag],
      summary: route.summary,
      description: `${route.summary}.${permissionText(key)}`,
      parameters: [...params, ...queryParams],
      ...(route.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(route.body) } } } } : {}),
      responses: {
        "200": { description: "OK", content: { [route.produces ?? "application/json"]: { schema: route.produces ? { type: "string" } : { type: "object" } } } },
        "400": { description: "The request isn't valid: { error, details }" },
        "401": { description: "Missing or invalid API key" },
        "403": { description: "The key may not do this" },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "Shorthop API",
      version: "1",
      description:
        "Short links, statistics, websites and revenue. Every request needs a personal API key from Settings → API keys: Authorization: Bearer shp_…. A key can do what it was given, and never more than its owner can.",
    },
    servers: [{ url: `${origin}/api` }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "A personal API key (shp_…)" } } },
    paths,
  };
}

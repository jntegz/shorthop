// A Model Context Protocol server at POST /api/mcp, so AI assistants (Claude
// Code, Cursor, VS Code…) can create links and read statistics with a personal
// API key (Authorization: Bearer shp_…). Stateless JSON-RPC over HTTP: every
// request stands alone, no sessions or streams, so it runs on the Free plan
// without a Durable Object.
//
// Each tool calls the existing API route with the caller's own key, so the
// key's permissions, validation, money hiding, history, webhooks and
// publishing all apply exactly as they do for a script.

import { Hono } from "hono";
import { app } from "./app";
import { openApiDocument } from "./openapi";
import type { AppEnv } from "./hono";

/** Protocol versions this server speaks; it answers in the client's when it can. */
const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER = { name: "shorthop", title: "Shorthop", version: "1.0.0" };
const INSTRUCTIONS =
  "Short links on the owner's own domain, with click statistics, websites and the revenue each link brought. Links are identified by domain and slug (domain/slug). Ranges: today, 7d, 30d, 90d, 365d, all.";

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The API call the tool makes, from its arguments. */
  call: (a: Record<string, unknown>) => { method: string; path: string; body?: unknown };
  readOnly?: boolean;
  /** Trims a big answer to what an assistant needs. */
  shape?: (body: unknown, a: Record<string, unknown>) => unknown;
}

const s = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const enc = encodeURIComponent;
const linkPath = (a: Record<string, unknown>) => `/links/${enc(s(a.domain))}/${enc(s(a.slug))}`;
const query = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const t = q.toString();
  return t ? `?${t}` : "";
};

const RANGE = { type: "string", enum: ["today", "7d", "30d", "90d", "365d", "all"], description: "Period, in UTC days. Default 30d." };
const LINK = {
  domain: { type: "string", description: "The short domain, such as sh.example" },
  slug: { type: "string", description: "The part after the domain (case-sensitive)" },
};

export const TOOLS: Tool[] = [
  {
    name: "create_link",
    title: "Create a short link",
    description: "Creates a short link to a URL. Leave slug out for a random one. Returns the link with its shortUrl.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Destination, https://…" },
        slug: { type: "string", description: "Optional back-half: letters, digits, - and _" },
        domain: { type: "string", description: "Optional short domain; the primary one when left out" },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
      },
      required: ["url"],
    },
    call: (a) => ({ method: "POST", path: "/links", body: { url: a.url, slug: a.slug, domain: a.domain, title: a.title, tags: a.tags, notes: a.notes } }),
  },
  {
    name: "list_links",
    title: "List links",
    description: "Lists links, newest first, with clicks in the period. Filter by search text, tag or status.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search slug, destination, title and notes" },
        tag: { type: "string" },
        status: { type: "string", enum: ["all", "active", "disabled", "expired", "broken", "failing", "shared"] },
        period: { type: "string", enum: ["7d", "14d", "30d", "90d", "180d", "365d", "all"], description: "Period for clicksPeriod. Default 7d." },
        limit: { type: "number", description: "Most links to return (default 50, at most 500)" },
      },
    },
    readOnly: true,
    call: (a) => ({ method: "GET", path: `/links${query({ q: a.q, tag: a.tag, status: a.status, period: a.period })}` }),
    shape: (body, a) => {
      const links = ((body as { links?: Record<string, unknown>[] }).links ?? []).slice(0, Math.min(500, Math.max(1, Number(a.limit) || 50)));
      return {
        links: links.map((l) => ({ shortUrl: l.shortUrl, domain: l.domain, slug: l.slug, target: l.target, title: l.title, tags: l.tags, active: l.active, clicksPeriod: l.clicksPeriod, clicksTotal: l.clicksTotal, createdAt: l.createdAt })),
        total: (body as { links?: unknown[] }).links?.length ?? 0,
      };
    },
  },
  {
    name: "get_link",
    title: "Get a link",
    description: "One link with all its settings.",
    inputSchema: { type: "object", properties: LINK, required: ["domain", "slug"] },
    readOnly: true,
    call: (a) => ({ method: "GET", path: linkPath(a) }),
  },
  {
    name: "update_link",
    title: "Update a link",
    description: "Changes a link: its destination, title, tags, notes, or turns it on or off. Only the fields given change.",
    inputSchema: {
      type: "object",
      properties: { ...LINK, url: { type: "string", description: "New destination" }, title: { type: "string" }, tags: { type: "array", items: { type: "string" } }, notes: { type: "string" }, active: { type: "boolean" } },
      required: ["domain", "slug"],
    },
    call: (a) => ({ method: "PATCH", path: linkPath(a), body: { target: a.url, title: a.title, tags: a.tags, notes: a.notes, active: a.active } }),
  },
  {
    name: "delete_link",
    title: "Delete a link",
    description: "Deletes a link. It can be restored from Recently deleted for 90 days.",
    inputSchema: { type: "object", properties: LINK, required: ["domain", "slug"] },
    call: (a) => ({ method: "DELETE", path: linkPath(a) }),
  },
  {
    name: "list_tags",
    title: "List tags",
    description: "Every tag with how many links have it.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    call: () => ({ method: "GET", path: "/tags" }),
  },
  {
    name: "stats_overview",
    title: "Statistics overview",
    description: "Clicks for all links: totals, a daily series, top links, countries, sources and devices, compared with the previous period.",
    inputSchema: { type: "object", properties: { range: RANGE } },
    readOnly: true,
    call: (a) => ({ method: "GET", path: `/stats/overview${query({ range: a.range ?? "30d" })}` }),
  },
  {
    name: "link_stats",
    title: "Statistics for a link",
    description: "One link's clicks with every breakdown: countries, cities, sources, referrers, devices, browsers, languages.",
    inputSchema: { type: "object", properties: { ...LINK, range: RANGE }, required: ["domain", "slug"] },
    readOnly: true,
    call: (a) => ({ method: "GET", path: `/stats${linkPath(a)}${query({ range: a.range ?? "30d" })}` }),
  },
  {
    name: "recent_hits",
    title: "Recent clicks",
    description: "The latest clicks, newest first: time, place, device and source. Optionally for one link.",
    inputSchema: { type: "object", properties: { ...LINK, limit: { type: "number", description: "1 to 200, default 50" }, hours: { type: "number", description: "How far back, 1 to 720 (default 168)" } } },
    readOnly: true,
    call: (a) => ({ method: "GET", path: `/stats/recent${query({ domain: a.domain, slug: a.slug, limit: a.limit, hours: a.hours, event: "click" })}` }),
  },
  {
    name: "missed_links",
    title: "Missed links",
    description: "Addresses on your short domains that people opened but that have no link (typos, deleted links), with counts.",
    inputSchema: { type: "object", properties: { range: RANGE } },
    readOnly: true,
    call: (a) => ({ method: "GET", path: `/stats/misses${query({ range: a.range ?? "30d" })}` }),
  },
  {
    name: "list_sites",
    title: "List websites",
    description: "Tracked websites with visitors and revenue (revenue needs the revenue permission).",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    call: () => ({ method: "GET", path: "/sites" }),
  },
  {
    name: "site_overview",
    title: "Website overview",
    description: "A tracked website's visitors, sessions, revenue and conversion for a period.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The site id, st_…" }, range: RANGE }, required: ["id"] },
    readOnly: true,
    call: (a) => ({ method: "GET", path: `/sites/${enc(s(a.id))}/overview${query({ range: a.range ?? "30d" })}` }),
  },
  {
    name: "link_revenue",
    title: "Revenue from a link",
    description: "Payments credited to a short link on your tracked websites, and the visits it brought.",
    inputSchema: { type: "object", properties: { ...LINK, days: { type: "number", description: "How far back, default 365" } }, required: ["domain", "slug"] },
    readOnly: true,
    call: (a) => ({ method: "GET", path: `/sites/by-link/${enc(s(a.domain))}/${enc(s(a.slug))}${query({ days: a.days })}` }),
  },
  {
    name: "fetch_preview",
    title: "Read a page's preview",
    description: "Reads a URL's own title, description and image, as social networks would show it.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    readOnly: true,
    call: (a) => ({ method: "POST", path: "/previews/fetch", body: { url: a.url } }),
  },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** An Origin header's host, or null when it isn't a URL (such as "null"). */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

const result = (id: Rpc["id"], value: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: value });
const failure = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function describeTools() {
  return TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: Boolean(t.readOnly), destructiveHint: t.name === "delete_link" } }));
}

export const mcpApi = new Hono<AppEnv>()
  .post("/mcp", async (c) => {
    // Browsers send Origin; a page on another site (or an opaque "null" origin) mustn't drive this server.
    const origin = c.req.header("Origin");
    if (origin && originHost(origin) !== new URL(c.req.url).host) return c.json(failure(null, -32600, "Origin not allowed"), 403);
    let msg: Rpc;
    try {
      msg = (await c.req.json()) as Rpc;
    } catch {
      return c.json(failure(null, -32700, "Parse error"), 400);
    }
    if (Array.isArray(msg)) return c.json(failure(null, -32600, "Batches aren't supported"), 400);
    // Notifications (no id) need no answer.
    if (msg.id === undefined || msg.method?.startsWith("notifications/")) return c.body(null, 202);

    switch (msg.method) {
      case "initialize": {
        const asked = s(msg.params?.protocolVersion);
        return c.json(result(msg.id, { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS }));
      }
      case "server/discover":
        return c.json(result(msg.id, { supportedVersions: VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS }));
      case "ping":
        return c.json(result(msg.id, {}));
      case "tools/list":
        return c.json(result(msg.id, { tools: describeTools() }));
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === s(msg.params?.name));
        if (!tool) return c.json(failure(msg.id, -32602, `Unknown tool: ${s(msg.params?.name)}`));
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const req = tool.call(args);
        // The same API, with the caller's key: its permissions decide.
        const base = new URL(c.req.url);
        const prefix = base.pathname.startsWith("/_admin/api") ? "/_admin/api" : "/api";
        const res = await app.fetch(
          new Request(`${base.origin}${prefix}${req.path}`, {
            method: req.method,
            headers: {
              Authorization: c.req.header("Authorization") ?? "",
              Cookie: c.req.header("Cookie") ?? "",
              // The admin's session is checked together with its Cloudflare Access login.
              "Cf-Access-Jwt-Assertion": c.req.header("Cf-Access-Jwt-Assertion") ?? "",
              Origin: base.origin,
              ...(req.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
          }),
          c.env,
          c.executionCtx,
        );
        const body = (await res.json().catch(() => ({}))) as unknown;
        if (!res.ok) {
          const error = s((body as { error?: unknown }).error) || `Request failed (${res.status})`;
          return c.json(result(msg.id, { content: [{ type: "text", text: error }], isError: true }));
        }
        const shaped = tool.shape ? tool.shape(body, args) : body;
        return c.json(result(msg.id, { content: [{ type: "text", text: JSON.stringify(shaped) }], structuredContent: shaped }));
      }
      default:
        return c.json(failure(msg.id, -32601, `Method not found: ${s(msg.method)}`));
    }
  })
  // No server-sent stream: everything is answered in the POST.
  .get("/mcp", (c) => c.body(null, 405, { Allow: "POST" }))

  /** The API described as OpenAPI 3.0, for API tools, client generators and AI assistants. */
  .get("/openapi.json", (c) => c.json(openApiDocument(new URL(c.req.url).origin)));

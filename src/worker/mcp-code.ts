// Code Mode at POST /api/mcp/code: an MCP server with two tools instead of one
// per task. `search` lets the assistant read the API's OpenAPI document with a
// line of JavaScript; `execute` runs its JavaScript against the API, so a task
// that takes many calls (find, filter, update a batch) is one round trip and
// the intermediate data never fills its context.
//
// The code runs in a Dynamic Worker (@cloudflare/codemode's executor) with no
// network at all. Its only way out is codemode.request(), a function here in
// the host that accepts the public API's routes (the OpenAPI catalog) and
// sends each through the whole app with the caller's own key or session, so
// every permission rule, validation, history entry and webhook applies as it
// does for a script. Needs the LOADER binding (Workers Paid); without it the
// tools say so, and the standard /api/mcp keeps working.

import type { Context } from "hono";
import { fullTokenScope } from "./auth";
import { allowed, RULES, TOKEN_READS, TOKEN_WRITES } from "./permissions";
import type { AppEnv } from "./hono";
import { dispatch, safePath, textResult, withoutIps, type McpServer, type ToolResult } from "./mcp";
import { CATALOG, openApiDocument } from "./openapi";

/** At most this many API requests per run. */
export const MAX_REQUESTS = 50;
/** A run's wall-clock limit. */
export const TIMEOUT_MS = 30_000;
const MAX_CODE_CHARS = 20_000;
/** A response body handed to the code, and the run's result handed back, are cut to this many characters. */
const MAX_BODY_CHARS = 24_000;
const MAX_RESULT_CHARS = 24_000;
const MAX_LOG_LINES = 50;
const MAX_LOG_CHARS = 500;

/** Not from code: the MCP servers themselves, and lookups by IP address (those stay in the admin). */
const NOT_FROM_CODE = new Set(["POST /mcp", "POST /mcp/code", "GET /links/:domain/:slug/clicks.csv", "POST /clicks/by-ip", "POST /clicks/by-ip/erase"]);
/** Answers that may carry IP addresses: they're removed, as the click_log tool does. */
const STRIP_IPS = new Set(["GET /links/:domain/:slug/clicks"]);

interface Route {
  key: string;
  method: string;
  pattern: RegExp;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every route code may call, with a pattern for its concrete paths (":slug" → one path segment). */
export const CODE_ROUTES: Route[] = Object.keys(CATALOG)
  .filter((key) => !NOT_FROM_CODE.has(key))
  .map((key) => {
    const [method, path] = key.split(" ") as [string, string];
    const pattern = new RegExp(`^${path
      .split("/")
      .map((seg) => (seg.startsWith(":") ? "[^/]+" : escape(seg)))
      .join("/")}$`);
    return { key, method, pattern };
  });

// safePath lives in mcp.ts, next to dispatch(); the tests import it from here.
export { safePath };

export function routeFor(method: string, path: string): Route | null {
  return CODE_ROUTES.find((r) => r.method === method && r.pattern.test(path)) ?? null;
}

/**
 * Whether this caller may call the route at all (the API checks again, with the
 * real request), so the spec and the route list show only what would work. The
 * API_TOKEN secret, unless its scope is "full", reaches only its own reads and
 * writes (src/worker/app.ts).
 */
function canCall(c: Context<AppEnv>, key: string): boolean {
  const rule = RULES[key];
  const actor = c.get("actor");
  if (actor.via === "token" && !fullTokenScope(c.env) && !TOKEN_READS.has(key) && !TOKEN_WRITES.has(key)) return false;
  return Boolean(rule && allowed(actor, rule) && !NOT_FROM_CODE.has(key));
}

const specFor = (c: Context<AppEnv>) => openApiDocument(new URL(c.req.url).origin, (key) => canCall(c, key));

/** Routes this caller may call, by tag, in a few lines for the tool description. */
function routeList(c: Context<AppEnv>): string {
  const byTag = new Map<string, string[]>();
  for (const [key, route] of Object.entries(CATALOG)) {
    if (!canCall(c, key)) continue;
    byTag.set(route.tag, [...(byTag.get(route.tag) ?? []), key]);
  }
  return [...byTag].map(([tag, keys]) => `${tag}: ${keys.join(", ")}`).join("\n");
}

// --- Running code -----------------------------------------------------------------

type Fns = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** Runs `code` in a Dynamic Worker with `fns` as codemode.*; null when this Worker has no LOADER binding. */
async function inSandbox(env: Env, code: string, fns: Fns): Promise<{ result: unknown; error?: string; logs?: string[] } | null> {
  const loader = (env as { LOADER?: WorkerLoader }).LOADER;
  if (!loader) return null;
  // Loaded on first use, so short-link cold starts don't carry it.
  const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
  // globalOutbound null: fetch() and connect() throw in the sandbox. Only codemode.* reaches out.
  const executor = new DynamicWorkerExecutor({ loader, timeout: TIMEOUT_MS, globalOutbound: null });
  return executor.execute(code, [{ name: "codemode", fns }]);
}

const NO_LOADER =
  "Code Mode isn't available on this deployment: it needs the Worker Loader binding (worker_loaders: LOADER in wrangler.jsonc, Workers Paid plan). Use the standard MCP server at /api/mcp instead.";

/** Cuts a value to `max` characters of JSON, keeping it valid JSON where it can. */
async function cut(value: unknown, max: number): Promise<unknown> {
  const { truncateResult } = await import("@cloudflare/codemode");
  return truncateResult(value, { maxChars: max });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** codemode.request(): one API call from the code, checked against the catalog, as the caller. */
function requester(c: Context<AppEnv>) {
  let count = 0;
  return async (raw: unknown) => {
    const opts = (raw ?? {}) as { method?: unknown; path?: unknown; query?: unknown; body?: unknown };
    if (++count > MAX_REQUESTS) throw new Error(`At most ${MAX_REQUESTS} requests per run. Do the rest in another run.`);
    const method = (str(opts.method) || "GET").toUpperCase();
    const path = str(opts.path).replace(/^\/api(?=\/)/, "");
    if (!safePath(path)) {
      throw new Error(`"${path}" isn't a valid path. Use one like /links or /links/{domain}/{slug} (values percent-encoded), with query parameters in query.`);
    }
    const route = routeFor(method, path);
    if (!route) throw new Error(`${method} ${path} isn't part of the API Code Mode can use. Search the spec for the right method and path.`);
    const q = new URLSearchParams();
    if (opts.query && typeof opts.query === "object") {
      for (const [k, v] of Object.entries(opts.query as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) for (const item of v) q.append(k, String(item));
        else q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    const qs = q.toString();
    const res = await dispatch(c, { method, path: `${path}${qs ? `?${qs}` : ""}`, body: method === "GET" || method === "HEAD" ? undefined : opts.body });
    if (!res) throw new Error(`"${path}" isn't a valid path.`);
    const body = STRIP_IPS.has(route.key) ? withoutIps(res.body) : res.body;
    return { status: res.status, ok: res.ok, body: await cut(body, MAX_BODY_CHARS) };
  };
}

/** Best effort per key or person: a brake on runs, not a quota. */
async function runAllowed(c: Context<AppEnv>): Promise<boolean> {
  const limiter = (c.env as { CODE_LIMITER?: RateLimit }).CODE_LIMITER;
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key: `code:${c.get("actor").email}` })).success;
  } catch (err) {
    console.error(JSON.stringify({ message: "code mode rate limiter failed", error: String(err) }));
    return true;
  }
}

async function run(c: Context<AppEnv>, code: unknown, fns: Fns): Promise<ToolResult> {
  if (typeof code !== "string" || !code.trim()) return textResult("Pass code: an async arrow function, such as async () => { … }.", true);
  if (code.length > MAX_CODE_CHARS) return textResult(`The code is longer than ${MAX_CODE_CHARS} characters. Split the task.`, true);
  if (!(await runAllowed(c))) return textResult("Too many Code Mode runs this minute. Wait a moment, then try again.", true);
  const started = Date.now();
  const out = await inSandbox(c.env, code, fns);
  if (!out) return textResult(NO_LOADER, true);
  const logs = (out.logs ?? []).slice(-MAX_LOG_LINES).map((l) => (l.length > MAX_LOG_CHARS ? `${l.slice(0, MAX_LOG_CHARS)}…` : l));
  console.log(JSON.stringify({ message: "code mode run", by: c.get("identity"), ms: Date.now() - started, ok: !out.error }));
  if (out.error) return textResult(`Error: ${out.error}${logs.length ? `\n\nLogs:\n${logs.join("\n")}` : ""}`, true);
  const value = await cut({ result: out.result ?? null, ...(logs.length ? { logs } : {}) }, MAX_RESULT_CHARS);
  return textResult(JSON.stringify(value));
}

// --- The MCP server ---------------------------------------------------------------

const CODE_PARAM = {
  type: "object",
  properties: { code: { type: "string", description: "An async arrow function, such as async () => { … return value; }" } },
  required: ["code"],
};

function tools(c: Context<AppEnv>): unknown[] {
  return [
    {
      name: "search",
      title: "Search the API",
      description: `Look things up in this Shorthop API's OpenAPI 3 document by running JavaScript. \`await codemode.spec()\` returns it (only the routes this key may call); return just the part you need, never the whole document.
Example: async () => { const s = await codemode.spec(); return Object.entries(s.paths).filter(([p]) => p.startsWith("/links")).map(([p, ops]) => [p, Object.keys(ops)]); }`,
      inputSchema: CODE_PARAM,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "execute",
      title: "Run code against the API",
      description: `Run JavaScript against this Shorthop API (short links, click statistics, websites and revenue) in a sandbox without internet access. Write an async arrow function. Inside it:
- \`await codemode.request({ method, path, query, body })\` calls the API and returns { status, ok, body }. path as listed below with values filled in (no /api prefix), such as /links/sh.example/guide; query is an object; body is JSON.
- \`await codemode.spec()\` returns the OpenAPI document.
Return what the user needs; console.log output comes back too. Each request uses this connection's key and permissions. At most ${MAX_REQUESTS} requests and ${TIMEOUT_MS / 1000} seconds per run. POST, PUT, PATCH and DELETE change real data. Links are identified by domain and slug; statistics ranges: today, 7d, 30d, 90d, 365d, all.
Example: async () => { const { body } = await codemode.request({ method: "GET", path: "/links", query: { sort: "clicks", period: "7d" } }); return body.links.slice(0, 5).map((l) => ({ url: l.shortUrl, clicks: l.clicksPeriod })); }
Routes you can call:
${routeList(c)}`,
      inputSchema: CODE_PARAM,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}

export const CODE_MODE: McpServer = {
  info: { name: "shorthop-code", title: "Shorthop (Code Mode)", version: "1.0.0" },
  instructions:
    "Shorthop's API through code: search reads the OpenAPI document, execute runs JavaScript that calls the API with your key. Prefer one execute run that does the whole task over many small ones.",
  tools,
  async call(c, name, args) {
    if (name === "search") return run(c, args.code, { spec: async () => specFor(c) });
    if (name === "execute") return run(c, args.code, { spec: async () => specFor(c), request: requester(c) });
    return null;
  },
};

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CODE_ROUTES, MAX_REQUESTS, routeFor, safePath } from "../src/worker/mcp-code";
import { INTERNAL } from "../src/worker/openapi";
import { API, bearer, call, ORIGIN, resetData } from "./helpers";
import { addKey, addUser } from "./people";

beforeEach(resetData);

const rpc = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = bearer) =>
  call(`${API}/mcp/code`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

type Result = { content: { text: string }[]; isError?: boolean };
const tool = async (name: string, code: string, headers: Record<string, string> = bearer): Promise<Result> =>
  (await (await rpc("tools/call", { name, arguments: { code } }, headers)).json<{ result: Result }>()).result;
const value = (r: Result) => JSON.parse(r.content[0]!.text) as { result: unknown; logs?: string[] };

describe("Code Mode MCP server", () => {
  it("offers search and execute, with the routes this key may call", async () => {
    const init = await (await rpc("initialize", { protocolVersion: "2025-06-18" })).json<{ result: { serverInfo: { name: string } } }>();
    expect(init.result.serverInfo.name).toBe("shorthop-code");
    const list = await (await rpc("tools/list")).json<{ result: { tools: { name: string; description: string; annotations: Record<string, boolean> }[] } }>();
    expect(list.result.tools.map((t) => t.name)).toEqual(["search", "execute"]);
    const execute = list.result.tools[1]!;
    expect(execute.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(execute.description).toContain("GET /links");
    expect(execute.description).not.toContain("POST /mcp");
    expect(execute.description).not.toContain("by-ip");

    await addUser("ben@example.com", "user", ["api.use", "stats.view"]);
    const { auth } = await addKey("ben@example.com", ["stats.view"]);
    const narrow = await (await rpc("tools/list", {}, auth)).json<{ result: { tools: { description: string }[] } }>();
    expect(narrow.result.tools[1]!.description).not.toContain("POST /links,");
  });

  it("runs a whole task in one call, through the API with the caller's key", async () => {
    const r = await tool(
      "execute",
      `async () => {
        for (const slug of ["one", "two", "three"]) {
          const res = await codemode.request({ method: "POST", path: "/links", body: { url: "https://example.com/" + slug, slug } });
          if (!res.ok) throw new Error(JSON.stringify(res.body));
        }
        const { body } = await codemode.request({ method: "GET", path: "/api/links", query: { sort: "slug" } });
        console.log("found", body.links.length);
        return body.links.map((l) => l.slug);
      }`,
    );
    expect(r.isError).toBeUndefined();
    expect(value(r)).toEqual({ result: ["one", "three", "two"], logs: ["found 3"] });
    expect((await call(`${ORIGIN}/two`)).headers.get("Location")).toBe("https://example.com/two");
  });

  it("searches the spec, limited to what the key may call", async () => {
    await addUser("ben@example.com", "user", ["api.use", "stats.view"]);
    const { auth } = await addKey("ben@example.com", ["stats.view"]);
    const r = await tool("search", `async () => Object.entries((await codemode.spec()).paths).filter(([p]) => p === "/links").map(([, ops]) => Object.keys(ops))`, auth);
    expect(value(r).result).toEqual([["get"]]);
    // search can't call the API.
    expect((await tool("search", `async () => codemode.request({ path: "/links" })`, auth)).isError).toBe(true);
  });

  it("keeps each request to the key's permissions", async () => {
    await addUser("ben@example.com", "user", ["api.use", "stats.view"]);
    const { auth } = await addKey("ben@example.com", ["stats.view"]);
    const r = await tool("execute", `async () => (await codemode.request({ method: "POST", path: "/links", body: { url: "https://example.com" } })).status`, auth);
    expect(value(r).result).toBe(403);
  });

  it("refuses routes outside the public API, and too many requests", async () => {
    for (const path of ["/keys", "/users", "/settings/two-factor", "/mcp/code", "/me/security", "/../links", "//links"]) {
      const r = await tool("execute", `async () => codemode.request({ method: "POST", path: ${JSON.stringify(path)}, body: {} })`);
      expect(r.isError, path).toBe(true);
    }
    const ip = await tool("execute", `async () => codemode.request({ method: "POST", path: "/clicks/by-ip", body: { ip: "203.0.113.1" } })`);
    expect(ip.isError).toBe(true);
    const many = await tool("execute", `async () => { for (let i = 0; i <= ${MAX_REQUESTS}; i++) await codemode.request({ path: "/tags" }); }`);
    expect(many.isError).toBe(true);
    expect(many.content[0]!.text).toContain(`At most ${MAX_REQUESTS} requests`);
  });

  it("refuses paths the URL parser would turn into another route", async () => {
    for (const path of [
      "/checks/links/x/..\\..\\..\\clicks\\by-ip",
      "/links/sh.example/one\\clicks.csv",
      "/links/x/%2e%2e/%2e%2e/settings",
      "/links/%2e%2e/openapi.json",
      "/links/.%2e/mcp",
      "/links/a%2Fb/c",
      "/links/a%5Cb/c",
      "/links/sh.example/one%",
    ]) {
      expect(safePath(path), path).toBe(false);
      const r = await tool("execute", `async () => codemode.request({ method: "POST", path: ${JSON.stringify(path)}, body: { ip: "203.0.113.1" } })`);
      expect(r.isError, path).toBe(true);
    }
    expect(safePath("/links/sh.example/my%20slug")).toBe(true);
    expect(safePath("/tags/summer%20sale")).toBe(true);
  });

  it("matches only public routes, and none of them stands for an internal one", () => {
    expect(routeFor("GET", "/links/sh.example/guide")?.key).toBe("GET /links/:domain/:slug");
    expect(routeFor("GET", "/links/sh.example/guide/clicks.csv")).toBeNull();
    expect(routeFor("DELETE", "/keys/abc")).toBeNull();
    // An internal or excluded route's path must never fit an allowed pattern of the same method.
    for (const key of [...INTERNAL, "POST /mcp", "POST /mcp/code", "GET /links/:domain/:slug/clicks.csv", "POST /clicks/by-ip", "POST /clicks/by-ip/erase"]) {
      const [method, path] = key.split(" ") as [string, string];
      const concrete = path.replace(/:[a-z]+/gi, "x");
      const hit = CODE_ROUTES.find((r) => r.method === method && r.pattern.test(concrete));
      expect(hit?.key, `${key} looks like ${hit?.key}`).toBeUndefined();
    }
  });

  it("cuts big answers and reports errors with their logs", async () => {
    const big = await tool("execute", `async () => "x".repeat(100000)`);
    expect(big.content[0]!.text.length).toBeLessThan(30_000);
    expect(big.content[0]!.text).toContain("TRUNCATED");
    const failed = await tool("execute", `async () => { console.log("before"); throw new Error("boom"); }`);
    expect(failed).toMatchObject({ isError: true });
    expect(failed.content[0]!.text).toBe("Error: boom\n\nLogs:\nbefore");
    expect((await tool("execute", "")).isError).toBe(true);
  });

  it("says so when the deployment has no Worker Loader", async () => {
    const r = await (
      await call(`${API}/mcp/code`, { method: "POST", headers: { "Content-Type": "application/json", ...bearer }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute", arguments: { code: "async () => 1" } } }) }, { LOADER: undefined } as Partial<Env>)
    ).json<{ result: Result }>();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("Worker Loader");
  });

  it("refuses other sites' pages and GET", async () => {
    expect((await rpc("tools/list", {}, { ...bearer, Origin: "https://evil.example" })).status).toBe(403);
    expect((await call(`${API}/mcp/code`, { headers: bearer })).status).toBe(405);
  });

  it("runs in a sandbox without internet", async () => {
    expect((env as { LOADER?: unknown }).LOADER).toBeDefined();
    const r = await tool("execute", `async () => { let net = "blocked"; try { await fetch("https://example.com"); net = "open"; } catch {} return net; }`);
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(value(r).result).toBe("blocked");
  });
});

describe("Code Mode and the API_TOKEN secret", () => {
  const list = (extra: Partial<Env>) =>
    call(`${API}/mcp/code`, { method: "POST", headers: { "Content-Type": "application/json", ...bearer }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }, extra);

  it("isn't open to the token's default scope, like the standard server", async () => {
    expect((await list({ API_TOKEN_SCOPE: "create" })).status).toBe(403);
  });

  it("lists what the token may do with the full scope", async () => {
    const r = await (await list({ API_TOKEN_SCOPE: "full" })).json<{ result: { tools: { description: string }[] } }>();
    expect(r.result.tools[1]!.description).toContain("PATCH /links/:domain/:slug");
  });
});

describe("the standard MCP tools", () => {
  it("stay on their own route, whatever a domain or slug says", async () => {
    const call1 = async (name: string, args: Record<string, unknown>) =>
      (
        await (
          await call(`${API}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...bearer }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })
        ).json<{ result: Result }>()
      ).result;
    for (const [name, args] of [
      ["get_link", { domain: "..", slug: "settings" }],
      ["link_stats", { domain: "..", slug: ".." }],
      ["get_link", { domain: "", slug: "x" }],
    ] as const) {
      expect((await call1(name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

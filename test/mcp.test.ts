import { beforeEach, describe, expect, it } from "vitest";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";
import { addKey, addUser } from "./people";

beforeEach(resetData);

const rpc = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = bearer, id: number | undefined = 1) =>
  call(`${API}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) });

const tool = async (name: string, args: Record<string, unknown>, headers: Record<string, string> = bearer) =>
  (await (await rpc("tools/call", { name, arguments: args }, headers)).json<{ result: { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean } }>()).result;

describe("MCP server", () => {
  it("initializes in the client's protocol version and lists its tools", async () => {
    const init = await (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json<{ result: { protocolVersion: string; serverInfo: { name: string } } }>();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "shorthop" } });
    expect((await rpc("notifications/initialized", {}, bearer, undefined)).status).toBe(202);
    const list = await (await rpc("tools/list")).json<{ result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }>();
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("create_link");
    expect(names).toContain("link_stats");
    expect(list.result.tools.find((t) => t.name === "list_links")!.annotations.readOnlyHint).toBe(true);
  });

  it("creates a link and lists it, through the API with the caller's key", async () => {
    const created = await tool("create_link", { url: "https://example.com/mcp", slug: "from-ai", tags: ["ai"] });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ link: { slug: "from-ai", shortUrl: `${ORIGIN}/from-ai` } });
    const listed = await tool("list_links", { tag: "ai" });
    expect(listed.structuredContent).toMatchObject({ total: 1, links: [{ slug: "from-ai" }] });
    expect((await call(`${ORIGIN}/from-ai`)).headers.get("Location")).toBe("https://example.com/mcp");
  });

  it("a key without a permission gets a tool error, not the data", async () => {
    await addUser("ben@example.com", "user", ["api.use", "stats.view"]);
    const { key } = await addKey("ben@example.com", ["stats.view"]);
    const res = await tool("create_link", { url: "https://example.com/x" }, { Authorization: `Bearer ${key}` });
    expect(res.isError).toBe(true);
  });

  it("refuses other sites' pages, unknown methods and GET", async () => {
    expect((await rpc("tools/list", {}, { ...bearer, Origin: "https://evil.example" })).status).toBe(403);
    // An opaque origin (a sandboxed page, a file) is refused too, not an error.
    expect((await rpc("tools/list", {}, { ...bearer, Origin: "null" })).status).toBe(403);
    expect(await (await rpc("nope")).json()).toMatchObject({ error: { code: -32601 } });
    expect((await call(`${API}/mcp`, { headers: bearer })).status).toBe(405);
    expect((await call(`${API}/mcp`, json({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: "Bearer wrong" }))).status).toBe(401);
  });
});

import { describe, expect, it } from "vitest";
import { CATALOG, INTERNAL } from "../src/worker/openapi";
import { RULES } from "../src/worker/permissions";
import { API, bearer, call } from "./helpers";

describe("API reference", () => {
  it("describes every route, or lists it as internal", () => {
    const missing = Object.keys(RULES).filter((k) => !(k in CATALOG) && !INTERNAL.has(k));
    expect(missing).toEqual([]);
    const stale = [...Object.keys(CATALOG), ...INTERNAL].filter((k) => !(k in RULES));
    expect(stale).toEqual([]);
  });

  it("serves a valid OpenAPI document with the request schemas", async () => {
    const res = await call(`${API}/openapi.json`, { headers: bearer });
    expect(res.status).toBe(200);
    const doc = await res.json<{ openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> }; parameters: { name: string; in: string }[] }>> }>();
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.servers[0]!.url).toMatch(/\/api$/);
    const create = doc.paths["/links"]!.post!;
    expect(Object.keys(create.requestBody!.content["application/json"]!.schema.properties!)).toContain("slug");
    const one = doc.paths["/links/{domain}/{slug}"]!.get!;
    expect(one.parameters.map((p) => p.name)).toEqual(["domain", "slug"]);
    expect(doc.paths["/users"]).toBeUndefined();
  });
});

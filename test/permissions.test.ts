import { beforeEach, describe, expect, it } from "vitest";
import { api } from "../src/worker/app";
import { RULES } from "../src/worker/permissions";
import { API, call, resetData } from "./helpers";
import { addKey, addUser, adminCall } from "./people";

beforeEach(resetData);

const registered = () => new Set(api.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));

/** A path with placeholder values for its parameters. */
const fill = (path: string) =>
  path
    .replace(":domain", "sh.example")
    .replace(":slug", "nope")
    .replace(":email", "someone%40example.com")
    .replace(":delivery", "1")
    .replace(":id", "abcd1234");

describe("route rules", () => {
  it("has a rule for every route, and no rule for a route that's gone", () => {
    const routes = registered();
    expect([...routes].filter((r) => !(r in RULES)), "routes without a rule").toEqual([]);
    expect(Object.keys(RULES).filter((r) => !routes.has(r)), "rules without a route").toEqual([]);
  });

  it("has no catch-all routes, which the rule lookup would skip", () => {
    expect(api.routes.filter((r) => r.method === "ALL")).toEqual([]);
  });

  it("lets a view-only key through only where everyone signed in may go", async () => {
    await addUser("viewer@example.com", "user", ["api.use"]);
    const { auth } = await addKey("viewer@example.com", []);
    const wrong: string[] = [];
    for (const [route, rule] of Object.entries(RULES)) {
      const [method, path] = route.split(" ") as [string, string];
      const res = await call(`${API}${fill(path)}`, { method, headers: { ...auth, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      const refused = res.status === 403 && (await res.clone().json<{ code?: string }>()).code === "forbidden";
      if (refused !== (rule.need !== "signed-in" || rule.sessionOnly === true)) wrong.push(`${route} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("lets an owner's full key through everywhere except the browser-only routes", async () => {
    const { auth } = await addKey("owner@example.com", ["links.create", "links.edit", "links.delete", "stats.view", "health.manage", "settings.manage"]);
    const wrong: string[] = [];
    for (const [route, rule] of Object.entries(RULES)) {
      const [method, path] = route.split(" ") as [string, string];
      const res = await call(`${API}${fill(path)}`, { method, headers: { ...auth, "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" });
      const refused = res.status === 403 && (await res.clone().json<{ code?: string }>()).code === "forbidden";
      if (refused !== (rule.sessionOnly === true)) wrong.push(`${route} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("applies the same rules to signed-in people", async () => {
    await addUser("viewer@example.com");
    expect((await adminCall("viewer@example.com", "/links")).status).toBe(200);
    expect((await adminCall("viewer@example.com", "/me")).status).toBe(200);
    for (const [path, init] of [
      ["/links", { body: { url: "https://example.com" } }],
      ["/links/sh.example/x", { method: "PATCH", body: {} }],
      ["/links/sh.example/x", { method: "DELETE" }],
      ["/stats/overview", {}],
      ["/settings", {}],
      ["/users", {}],
      ["/keys", {}],
    ] as const) {
      const res = await adminCall("viewer@example.com", path, init);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden" });
    }
  });

  it("answers unknown paths with 404, not 403", async () => {
    await addUser("viewer@example.com");
    expect((await adminCall("viewer@example.com", "/nope")).status).toBe(404);
  });
});

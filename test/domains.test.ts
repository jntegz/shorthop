import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainCheckDTO } from "../src/shared/types";
import { API, bearer, call, ORIGIN } from "./helpers";

afterEach(() => vi.restoreAllMocks());

type Zone = Record<string, { status?: number; NS?: string[]; A?: string[]; AAAA?: string[]; CNAME?: string[] }>;
const TYPE = { A: 1, NS: 2, CNAME: 5, AAAA: 28 } as const;

/** Answers DNS-over-HTTPS lookups from `zone` and https://<host>/health from `health`. */
function mockNet(zone: Zone, health: Record<string, Response | "down">) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      const type = url.searchParams.get("type") as keyof typeof TYPE;
      const entry = zone[name];
      const Answer = (entry?.[type] ?? []).map((data) => ({ name: `${name}.`, type: TYPE[type], data: `${data}.` }));
      return Response.json({ Status: entry?.status ?? (entry ? 0 : 3), Answer });
    }
    if (url.pathname === "/health") {
      const r = health[url.hostname];
      if (!r || r === "down") throw new Error("connect failed");
      return r;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const check = async (domain: string, env: Partial<Env> = {}) => {
  const res = await call(`${API}/settings/domains/check?domain=${encodeURIComponent(domain)}`, { headers: bearer }, env);
  return { status: res.status, body: (await res.json()) as DomainCheckDTO };
};

describe("domain setup check", () => {
  it("spots a domain that's still on its registrar's nameservers and on another host", async () => {
    mockNet({ "alt.example": { NS: ["ns1.registrar.example", "ns2.registrar.example"], A: ["192.0.2.10"] } }, { "alt.example": new Response("old", { status: 301 }) });
    const { body } = await check("Alt.example");
    expect(body).toMatchObject({
      domain: "alt.example",
      configured: false,
      exists: true,
      zone: "alt.example",
      nameservers: ["ns1.registrar.example", "ns2.registrar.example"],
      onCloudflare: false,
      records: [{ type: "A", value: "192.0.2.10" }],
      serving: "no",
      error: null,
    });
    expect(body.servingDetail).toMatch(/another server \(HTTP 301\)/);
  });

  it("says so when the domain still points to a host that doesn't answer", async () => {
    mockNet({ "alt.example": { NS: ["andy.ns.cloudflare.com", "olga.ns.cloudflare.com"], A: ["192.0.2.10"] } }, { "alt.example": "down" });
    const { body } = await check("alt.example");
    expect(body.servingDetail).toBe("No HTTPS answer from alt.example: it still points elsewhere (A 192.0.2.10).");
  });

  it("confirms a configured domain that is live on this Worker", async () => {
    mockNet(
      { "alt.example": { NS: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], A: ["104.21.1.1"] } },
      { "alt.example": new Response("ok", { headers: { "X-Shorthop": "ok" } }) },
    );
    const { body } = await check("alt.example", { SHORT_DOMAINS: "sh.example,alt.example" });
    expect(body).toMatchObject({ configured: true, onCloudflare: true, serving: "yes", records: [{ type: "A", value: "104.21.1.1" }] });
  });

  it("explains a domain that reaches the Worker before it's in SHORT_DOMAINS", async () => {
    mockNet(
      { "alt.example": { NS: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"] } },
      { "alt.example": new Response("Not found", { status: 404, headers: { "X-Shorthop": "unconfigured" } }) },
    );
    const { body } = await check("alt.example");
    expect(body.serving).toBe("no");
    expect(body.servingDetail).toMatch(/isn't in SHORT_DOMAINS/);
  });

  it("finds the parent zone's nameservers for a subdomain", async () => {
    mockNet(
      { "go.example.com": { status: 0, CNAME: ["old-host.example.net"] }, "example.com": { NS: ["kim.ns.cloudflare.com", "lou.ns.cloudflare.com"] } },
      { "go.example.com": "down" },
    );
    const { body } = await check("go.example.com");
    expect(body).toMatchObject({ zone: "example.com", onCloudflare: true, records: [{ type: "CNAME", value: "old-host.example.net" }], serving: "no" });
    expect(body.servingDetail).toMatch(/No HTTPS answer/);
  });

  it("reports names that don't exist", async () => {
    mockNet({}, {});
    const { body } = await check("not-registered-yet.link");
    expect(body).toMatchObject({ exists: false, nameservers: [], onCloudflare: false });
  });

  it("rejects anything that isn't a domain", async () => {
    for (const bad of ["localhost", "https://x.com/y", "a b.com", ""]) {
      expect((await check(bad)).status, bad).toBe(400);
    }
  });

  it("marks the Worker's own answers so the check can recognize them", async () => {
    const health = await call(`${ORIGIN}/health`);
    expect(health.headers.get("X-Shorthop")).toBe("ok");
    const unknownHost = await call("https://not-configured.example/health");
    expect(unknownHost.status).toBe(404);
    expect(unknownHost.headers.get("X-Shorthop")).toBe("unconfigured");
  });
});

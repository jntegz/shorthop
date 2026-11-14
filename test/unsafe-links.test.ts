import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkDTO } from "../src/shared/types";
import { checkUnsafeBacklog } from "../src/worker/health";
import { API, bearer, call, json, ORIGIN, resetData } from "./helpers";

const ON = { SAFETY_DNS: "" } as Partial<Env>;
let dnsDown = false;
/** Hosts asked at the security DNS, in order. */
let asked: string[] = [];

beforeEach(async () => {
  await resetData();
  dnsDown = false;
  asked = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "security.cloudflare-dns.com") {
      if (dnsDown) throw new Error("network down");
      const name = url.searchParams.get("name") ?? "";
      asked.push(name);
      if (name.startsWith("broken")) return new Response("busy", { status: 503 });
      const bad = name.startsWith("phish.");
      return Response.json({ Status: 0, Answer: [{ name, type: 1, data: bad ? "0.0.0.0" : "93.184.215.14" }], ...(bad ? { Comment: ["EDE(16): Censored"] } : {}) });
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const create = async (slug: string, target: string) => {
  const res = await call(`${API}/links`, json({ slug, target }), ON);
  expect(res.status).toBe(201);
  return ((await res.json()) as { link: LinkDTO }).link;
};
const open = (slug: string) => call(`${ORIGIN}/${slug}`, { headers: { "User-Agent": "Mozilla/5.0 Safari/605.1.15" }, redirect: "manual" }, ON);

describe("unsafe destinations", () => {
  it("warns visitors before a flagged destination, with a way through", async () => {
    const link = await create("bad", "https://phish.example.net/login");
    expect(link.unsafe).toBe("flagged");
    expect(await env.LINKS.get("sh.example/bad", "json")).toMatchObject({ w: 1 });
    const res = await open("bad");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("may not be safe");
    expect(html).toContain('href="https://phish.example.net/login"');
  });

  it("lets the owner trust it, and checks a new destination again", async () => {
    await create("bad", "https://phish.example.net/");
    const trusted = await call(`${API}/links/sh.example/bad`, { ...json({ trustDestination: true }), method: "PATCH" }, ON);
    expect(((await trusted.json()) as { link: LinkDTO }).link.unsafe).toBe("trusted");
    expect((await open("bad")).status).toBe(302);

    const moved = await call(`${API}/links/sh.example/bad`, { ...json({ target: "https://fine.example.org/" }), method: "PATCH" }, ON);
    expect(((await moved.json()) as { link: LinkDTO }).link.unsafe).toBeNull();
  });

  it("never blocks a save when the lookup fails", async () => {
    dnsDown = true;
    // A host not looked up before (answers are cached for a few minutes).
    const link = await create("ok", "https://phish.never-seen.example/");
    expect(link.unsafe).toBeNull();
    expect((await open("ok")).status).toBe(302);
  });

  it("treats a failed lookup as unknown, not clean, and looks it up again later", async () => {
    dnsDown = true;
    await create("later", "https://phish.retry-later.example/");
    const at = () => env.DB.prepare("SELECT unsafe, unsafe_at, unsafe_tried_at FROM links WHERE slug = 'later'").first<{ unsafe: number; unsafe_at: number | null; unsafe_tried_at: number | null }>();
    expect(await at()).toEqual({ unsafe: 0, unsafe_at: null, unsafe_tried_at: null });

    // Still down: tried, and still not checked.
    expect(await checkUnsafeBacklog({ ...env, ...ON } as Env, 10)).toEqual({ checked: 0, flagged: 0, unknown: 1 });
    expect(await at()).toMatchObject({ unsafe: 0, unsafe_at: null });
    expect((await at())!.unsafe_tried_at).toBeGreaterThan(0);
    expect((await open("later")).status).toBe(302);

    dnsDown = false;
    expect(await checkUnsafeBacklog({ ...env, ...ON } as Env, 10)).toEqual({ checked: 1, flagged: 1, unknown: 0 });
    expect(await at()).toMatchObject({ unsafe: 1, unsafe_tried_at: null });
    expect((await at())!.unsafe_at).toBeGreaterThan(0);
    expect(await env.LINKS.get("sh.example/later", "json")).toMatchObject({ w: 1 });
  });

  it("forgets the old answer when a changed destination can't be looked up", async () => {
    await create("moved", "https://fine.example.org/");
    dnsDown = true;
    const res = await call(`${API}/links/sh.example/moved`, { ...json({ target: "https://phish.moved-here.example/" }), method: "PATCH" }, ON);
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT unsafe, unsafe_at FROM links WHERE slug = 'moved'").first()).toEqual({ unsafe: 0, unsafe_at: null });
    dnsDown = false;
    expect((await checkUnsafeBacklog({ ...env, ...ON } as Env, 10)).flagged).toBe(1);
  });

  it("puts a changed destination back at the front of the backlog, whatever the old one's lookups did", async () => {
    dnsDown = true;
    await create("edited", "https://old.keeps-failing.example/");
    await checkUnsafeBacklog({ ...env, ...ON } as Env, 10);
    const tried = () => env.DB.prepare("SELECT unsafe_tried_at FROM links WHERE slug = 'edited'").first<number | null>("unsafe_tried_at");
    expect(await tried()).toBeGreaterThan(0);
    // Another change keeps the mark: the destinations are the same.
    expect((await call(`${API}/links/sh.example/edited`, { ...json({ title: "Renamed" }), method: "PATCH" }, ON)).status).toBe(200);
    expect(await tried()).toBeGreaterThan(0);
    // A new destination that can't be looked up either: not tried yet, so it goes first.
    expect((await call(`${API}/links/sh.example/edited`, { ...json({ target: "https://phish.new-host.example/" }), method: "PATCH" }, ON)).status).toBe(200);
    expect(await env.DB.prepare("SELECT unsafe_at, unsafe_tried_at FROM links WHERE slug = 'edited'").first()).toEqual({ unsafe_at: null, unsafe_tried_at: null });
  });

  it("doesn't let destinations whose lookup keeps failing hold up the rest", async () => {
    const rows = [
      { slug: "a1", target: "https://broken1.starve.example/" },
      { slug: "a2", target: "https://broken2.starve.example/" },
      { slug: "z1", target: "https://phish.starve.example/" },
      { slug: "z2", target: "https://fine.starve.example/" },
    ];
    // Imported with no answers, so all four wait for the backlog.
    dnsDown = true;
    await call(`${API}/import`, json({ rows }), ON);
    dnsDown = false;
    const run = () => checkUnsafeBacklog({ ...env, ...ON } as Env, 2);
    // Two a run: the failing pair comes first by name, then moves behind the ones never tried.
    expect(await run()).toEqual({ checked: 0, flagged: 0, unknown: 2 });
    expect(await run()).toEqual({ checked: 2, flagged: 1, unknown: 0 });
    expect(await env.LINKS.get("sh.example/z1", "json")).toMatchObject({ w: 1 });
    // Only the failing pair is left, and it is still retried.
    expect(await run()).toEqual({ checked: 0, flagged: 0, unknown: 2 });
    const left = await env.DB.prepare("SELECT slug FROM links WHERE unsafe_at IS NULL ORDER BY slug").all<{ slug: string }>();
    expect(left.results.map((r) => r.slug)).toEqual(["a1", "a2"]);
  });

  it("checks imported links in the background when the import couldn't, and republishes flagged ones", async () => {
    dnsDown = true;
    await call(`${API}/import`, json({ rows: [{ slug: "imp", target: "https://phish.bg-import.example/x" }, { slug: "fine", target: "https://fine.bg-import.example/" }] }), ON);
    expect(await env.LINKS.get("sh.example/imp", "json")).not.toHaveProperty("w");
    dnsDown = false;
    const r = await checkUnsafeBacklog({ ...env, ...ON } as Env, 10);
    expect(r).toEqual({ checked: 2, flagged: 1, unknown: 0 });
    expect(await env.LINKS.get("sh.example/imp", "json")).toMatchObject({ w: 1 });
    const fine = (await (await call(`${API}/links/sh.example/fine`, { headers: bearer })).json()) as { link: LinkDTO };
    expect(fine.link.unsafe).toBeNull();
  });
});

/** One always-on rule sending everyone it matches to these URLs, in equal shares. */
const routed = (...urls: string[]) => ({
  rules: [
    {
      id: "r1",
      name: "",
      enabled: true,
      devices: ["ios"],
      countries: [],
      countryMode: "in",
      variants: urls.map((url, i) => ({ id: `v${i}`, label: `V${i}`, url, weight: i === 0 ? 100 - Math.floor(100 / urls.length) * (urls.length - 1) : Math.floor(100 / urls.length) })),
    },
  ],
});
const state = (slug: string) =>
  env.DB.prepare("SELECT unsafe, unsafe_at IS NOT NULL AS looked, unsafe_tried_at IS NOT NULL AS tried FROM links WHERE slug = ?").bind(slug).first<{ unsafe: number; looked: number; tried: number }>();
const backlog = (limit = 10, publishes?: number, plan: Partial<Env> = {}) => checkUnsafeBacklog({ ...env, ...ON, ...plan } as Env, limit, publishes);
const importRows = (body: Record<string, unknown>, extra: Partial<Env> = {}) => call(`${API}/import`, json(body), { ...ON, ...extra });

describe("unsafe destinations behind routing rules", () => {
  it("flags a new link when only a routed destination is flagged", async () => {
    const res = await call(`${API}/links`, json({ slug: "split", target: "https://fine.rt-create.example/", routing: routed("https://phish.rt-create.example/a") }), ON);
    expect(((await res.json()) as { link: LinkDTO }).link.unsafe).toBe("flagged");
    expect(await env.LINKS.get("sh.example/split", "json")).toMatchObject({ w: 1 });
  });

  it("looks routed destinations up again when the rules change, and when an old version or a deleted link comes back", async () => {
    await create("r", "https://fine.rt-edit.example/");
    const patch = (body: unknown) => call(`${API}/links/sh.example/r`, { ...json(body), method: "PATCH" }, ON);
    expect(((await (await patch({ routing: routed("https://phish.rt-edit.example/") })).json()) as { link: LinkDTO }).link.unsafe).toBe("flagged");
    expect(((await (await patch({ routing: null })).json()) as { link: LinkDTO }).link.unsafe).toBeNull();

    const { versions } = (await (await call(`${API}/links/sh.example/r/history`, { headers: bearer })).json()) as { versions: { id: number; snapshot: { routing: string | null } }[] };
    const withRule = versions.find((v) => v.snapshot.routing)!;
    const back = await call(`${API}/links/sh.example/r/history/${withRule.id}/restore`, { method: "POST", headers: bearer }, ON);
    expect(((await back.json()) as { link: LinkDTO }).link.unsafe).toBe("flagged");

    await call(`${API}/links/sh.example/r`, { method: "DELETE", headers: bearer }, ON);
    const restored = await call(`${API}/deleted/sh.example/r/restore`, { method: "POST", headers: bearer }, ON);
    expect(restored.status).toBe(201);
    expect(((await restored.json()) as { link: LinkDTO }).link.unsafe).toBe("flagged");
    expect(await state("r")).toMatchObject({ unsafe: 1, looked: 1 });
  });

  it("leaves a link unknown when a routed lookup fails and none is flagged, and flagged when one is", async () => {
    const mk = (slug: string, ...urls: string[]) => call(`${API}/links`, json({ slug, target: "https://fine.rt-mixed.example/", routing: routed(...urls) }), ON);
    await mk("unk", "https://broken.rt-mixed.example/", "https://fine2.rt-mixed.example/");
    await mk("bad", "https://broken2.rt-mixed.example/", "https://phish.rt-mixed.example/");
    expect(await state("unk")).toMatchObject({ unsafe: 0, looked: 0 });
    expect(await state("bad")).toMatchObject({ unsafe: 1, looked: 1 });
    // The backlog reaches the same answer.
    expect(await backlog()).toEqual({ checked: 0, flagged: 0, unknown: 1 });
    expect(await state("unk")).toMatchObject({ unsafe: 0, looked: 0, tried: 1 });
  });

  it("checks routed destinations in the backlog, each host once", async () => {
    dnsDown = true;
    await importRows({
      rows: [
        { slug: "b1", target: "https://fine.rt-backlog.example/1", config: { routing: routed("https://phish.rt-backlog.example/", "https://fine.rt-backlog.example/2") } },
        { slug: "b2", target: "https://fine.rt-backlog.example/3", config: { routing: routed("https://other.rt-backlog.example/") } },
        { slug: "b3", target: "https://fine.rt-backlog.example/4" },
      ],
    });
    dnsDown = false;
    asked = [];
    expect(await backlog()).toEqual({ checked: 3, flagged: 1, unknown: 0 });
    expect(asked.sort()).toEqual(["fine.rt-backlog.example", "other.rt-backlog.example", "phish.rt-backlog.example"]);
    expect(await state("b1")).toMatchObject({ unsafe: 1, looked: 1 });
    expect(await state("b2")).toMatchObject({ unsafe: 0, looked: 1 });
    expect(await env.LINKS.get("sh.example/b1", "json")).toMatchObject({ w: 1 });
    expect(await env.LINKS.get("sh.example/b2", "json")).not.toHaveProperty("w");
  });

  it("ignores rules that are turned off", async () => {
    const routing = routed("https://phish.rt-off.example/");
    routing.rules[0]!.enabled = false;
    const res = await call(`${API}/links`, json({ slug: "off", target: "https://fine.rt-off.example/", routing }), ON);
    expect(((await res.json()) as { link: LinkDTO }).link.unsafe).toBeNull();
  });

  it("finishes a link with more hosts than a run has lookups over several runs, never over the limit", async () => {
    dnsDown = true;
    const urls = [1, 2, 3, 4].map((n) => `https://h${n}.rt-many.example/`);
    await importRows({ rows: [{ slug: "many", target: "https://h0.rt-many.example/", config: { routing: routed(...urls, "https://phish.rt-many.example/") } }, { slug: "after", target: "https://h9.rt-many.example/" }] });
    dnsDown = false;
    asked = [];
    // Another isolate each run: only what the backlog saved carries over.
    const run = async () => {
      const before = asked.length;
      vi.setSystemTime(Date.now() + 15 * 60_000);
      const r = await backlog(2);
      return { ...r, lookups: asked.length - before };
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await run()).toEqual({ checked: 0, flagged: 0, unknown: 0, lookups: 2 });
      expect(await state("many")).toMatchObject({ looked: 0, tried: 0 });
      expect(await run()).toEqual({ checked: 0, flagged: 0, unknown: 0, lookups: 2 });
      expect(await run()).toEqual({ checked: 1, flagged: 1, unknown: 0, lookups: 2 });
      expect(await state("many")).toMatchObject({ unsafe: 1, looked: 1 });
      expect(await run()).toEqual({ checked: 1, flagged: 0, unknown: 0, lookups: 1 });
      expect(new Set(asked).size).toBe(asked.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("republishes at most the run's share of flagged links and leaves the rest for the next run", async () => {
    dnsDown = true;
    await importRows({ rows: [1, 2, 3].map((n) => ({ slug: `p${n}`, target: `https://phish.rt-cap.example/${n}` })) });
    dnsDown = false;
    expect(await backlog(10, 2)).toEqual({ checked: 2, flagged: 2, unknown: 0 });
    expect(await state("p3")).toMatchObject({ unsafe: 0, looked: 0 });
    expect(await backlog(10, 2)).toEqual({ checked: 1, flagged: 1, unknown: 0 });
    expect(await env.LINKS.get("sh.example/p3", "json")).toMatchObject({ w: 1 });
  });
});

describe("unsafe destinations in an import", () => {
  it("warns right away when an overwrite brings a flagged destination, without waiting for the cron", async () => {
    await create("ow", "https://fine.imp-ow.example/");
    const res = await importRows({ mode: "overwrite", rows: [{ slug: "ow", target: "https://phish.imp-ow.example/" }, { slug: "new", target: "https://phish.imp-ow.example/n" }, { slug: "ok", target: "https://fine.imp-ow.example/2" }] });
    expect(await res.json()).toMatchObject({ created: 2, updated: 1 });
    expect(await state("ow")).toMatchObject({ unsafe: 1, looked: 1 });
    expect(await state("new")).toMatchObject({ unsafe: 1, looked: 1 });
    expect(await state("ok")).toMatchObject({ unsafe: 0, looked: 1 });
    expect(await env.LINKS.get("sh.example/ow", "json")).toMatchObject({ w: 1 });
    expect((await open("ow")).status).toBe(200);
    expect(await backlog()).toEqual({ checked: 0, flagged: 0, unknown: 0 });
  });

  it("keeps a trusted or flagged answer when the overwrite changes no destination, and drops it when one changes", async () => {
    await create("keep", "https://phish.imp-keep.example/");
    await call(`${API}/links/sh.example/keep`, { ...json({ trustDestination: true }), method: "PATCH" }, ON);
    asked = [];
    await importRows({ mode: "overwrite", rows: [{ slug: "keep", target: "https://phish.imp-keep.example/", title: "Renamed" }] });
    expect(await state("keep")).toMatchObject({ unsafe: 2, looked: 1 });
    expect(asked).toEqual([]);
    await importRows({ mode: "overwrite", rows: [{ slug: "keep", target: "https://phish.imp-keep2.example/" }] });
    expect(await state("keep")).toMatchObject({ unsafe: 1, looked: 1 });
  });

  it("counts the routing an overwrite keeps, and the routing it brings", async () => {
    await call(`${API}/links`, json({ slug: "kept", target: "https://fine.imp-rt.example/", routing: routed("https://phish.imp-rt.example/") }), ON);
    await call(`${API}/links/sh.example/kept`, { ...json({ trustDestination: true }), method: "PATCH" }, ON);
    // No settings in the row: the rules stay, and so does their flagged destination.
    await importRows({ mode: "overwrite", rows: [{ slug: "kept", target: "https://fine.imp-rt.example/moved" }] });
    expect(await state("kept")).toMatchObject({ unsafe: 1, looked: 1 });
    // Settings in the row replace the rules.
    await importRows({ mode: "overwrite", rows: [{ slug: "kept", target: "https://fine.imp-rt.example/moved", config: { routing: null } }] });
    expect(await state("kept")).toMatchObject({ unsafe: 0, looked: 1 });
    await importRows({ mode: "overwrite", rows: [{ slug: "kept", target: "https://fine.imp-rt.example/moved", config: { routing: routed("https://phish.imp-rt2.example/") } }] });
    expect(await state("kept")).toMatchObject({ unsafe: 1, looked: 1 });
    expect(await env.LINKS.get("sh.example/kept", "json")).toMatchObject({ w: 1 });
  });

  it("looks up each host once across the batch, up to the plan's share, and leaves the rest to the next backlog run", async () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ slug: `c${i}`, target: `https://h${i}.imp-cap.example/` })),
      { slug: "same1", target: "https://h0.imp-cap.example/a" },
      { slug: "same2", target: "https://h11.imp-cap.example/b" },
    ];
    await importRows({ rows }, { WORKERS_PLAN: "free" });
    expect(asked.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `h${i}.imp-cap.example`).sort());
    const waiting = await env.DB.prepare("SELECT slug FROM links WHERE unsafe_at IS NULL ORDER BY slug").all<{ slug: string }>();
    expect(waiting.results.map((r) => r.slug)).toEqual(["c10", "c11", "same2"]);
    // The next half-hourly run takes links never looked up before the ones whose lookup failed earlier.
    await env.DB.prepare("INSERT INTO links (domain, slug, target, unsafe_tried_at, created_at, updated_at) VALUES ('sh.example', 'aaa', 'https://a.tried-before.example/', 5, 1, 1)").run();
    expect(await backlog(2)).toEqual({ checked: 3, flagged: 0, unknown: 0 });
    expect((await env.DB.prepare("SELECT slug FROM links WHERE unsafe_at IS NULL").all<{ slug: string }>()).results.map((r) => r.slug)).toEqual(["aaa"]);
  });

  it("doesn't trust a lookup made for rules the link no longer has", async () => {
    await call(`${API}/links`, json({ slug: "race", target: "https://fine.imp-race.example/", routing: routed("https://fine2.imp-race.example/") }), ON);
    // The rules change between the import reading the link and writing it.
    const real = env.DB.batch.bind(env.DB);
    let done = false;
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p !== "batch") {
          const v = Reflect.get(t, p) as unknown;
          return typeof v === "function" ? v.bind(t) : v;
        }
        return async (stmts: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await env.DB.prepare("UPDATE links SET routing = ?1 WHERE slug = 'race'").bind(JSON.stringify({ ...routed("https://phish.imp-race.example/"), changedAt: 1 })).run();
          }
          return real(stmts);
        };
      },
    });
    await importRows({ mode: "overwrite", rows: [{ slug: "race", target: "https://fine.imp-race.example/new" }] }, { DB });
    expect(await state("race")).toMatchObject({ unsafe: 0, looked: 0 });
    expect(await backlog()).toEqual({ checked: 1, flagged: 1, unknown: 0 });
  });
});

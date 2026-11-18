// Link write integrity, destination rules, click-limit restarts, backup order
// and health, webhook fairness, vendor import limits, the outbound guard, and
// keyed rate-limiter keys (2.0.3).

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bioButtonUrls, renderBio, validateBio, type BioPage } from "../src/shared/bio";
import { isFetchableUrl } from "../src/shared/link-check";
import type { SiteDTO } from "../src/shared/sites";
import type { LinkDTO, VersionDTO } from "../src/shared/types";
import { daySaltFor } from "../src/worker/analytics";
import { BACKUP_TABLE_NAMES, manifest, scheduledBackup } from "../src/worker/backup";
import { pruneSaltsAndBudget, systemHealth } from "../src/worker/health";
import { pullLinks, VendorError } from "../src/worker/import/vendors";
import { publicLimit } from "../src/worker/redirect";
import { limiterKey } from "../src/worker/session";
import { runSiteAlerts } from "../src/worker/web/alerts";
import { deliver, encryptSecret } from "../src/worker/webhooks";
import { API, bearer, call, json, ORIGIN, putLink, resetData } from "./helpers";
import { adminCall } from "./people";

beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

const TARGET = "https://example.com/start";
const create = async (slug: string, extra: Record<string, unknown> = {}) => {
  const res = await call(`${API}/links`, json({ slug, target: TARGET, ...extra }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { link: LinkDTO }).link;
};
const patch = (slug: string, body: Record<string, unknown>, over: Partial<Env> = {}) => call(`${API}/links/sh.example/${slug}`, { ...json(body), method: "PATCH" }, over);
const row = (slug: string) => env.DB.prepare("SELECT * FROM links WHERE domain = 'sh.example' AND slug = ?").bind(slug).first<Record<string, unknown>>();
const kv = (slug: string) => env.LINKS.get(`sh.example/${slug}`, "json") as Promise<Record<string, unknown> | null>;
const versions = async (slug: string) => ((await (await call(`${API}/links/sh.example/${slug}/history`, { headers: bearer })).json()) as { versions: VersionDTO[] }).versions;
const restore = (slug: string, id: number, query = "") => call(`${API}/links/sh.example/${slug}/history/${id}/restore${query}`, { method: "POST", headers: bearer });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Holds the security DNS's answer for one host until released, so a save can be caught halfway. */
function holdDns(host: string) {
  const reached = deferred();
  const release = deferred();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "security.cloudflare-dns.com") return real(input, init);
    if (url.searchParams.get("name") === host) {
      reached.resolve();
      await release.promise;
    }
    return Response.json({ Status: 0, Answer: [{ type: 1, data: "93.184.215.14" }] });
  });
  return { reached, release };
}

describe("edits that overlap", () => {
  it("keeps both changes: an edit writes only the fields it changed", async () => {
    await create("both", { title: "Old title", notes: "old notes" });
    const { reached, release } = holdDns("slow.example.com");
    // Reads the link, then waits at the security lookup for its new destination.
    const slow = patch("both", { target: "https://slow.example.com/new" }, { SAFETY_DNS: "" } as Partial<Env>);
    await reached.promise;
    expect((await patch("both", { title: "New title", maxClicks: 7 })).status).toBe(200);
    release.resolve();
    expect((await slow).status).toBe(200);

    expect(await row("both")).toMatchObject({ target: "https://slow.example.com/new", title: "New title", max_clicks: 7, notes: "old notes" });
    expect(await kv("both")).toMatchObject({ u: "https://slow.example.com/new", mc: 7 });
    // Each version records the link as it then was, the other edit's field included.
    expect((await versions("both"))[0]!.snapshot).toMatchObject({ target: "https://slow.example.com/new", title: "New title", max_clicks: 7 });
  });

  it("ends with KV matching D1 when an older save reaches KV last", async () => {
    await create("order");
    const reached = deferred();
    const release = deferred();
    let held = false;
    const real = env.LINKS;
    const LINKS = {
      get: real.get.bind(real),
      delete: real.delete.bind(real),
      list: real.list.bind(real),
      put: async (key: string, value: string) => {
        if (!held) {
          held = true;
          reached.resolve();
          await release.promise;
        }
        await real.put(key, value);
      },
    } as unknown as KVNamespace;
    const first = patch("order", { target: "https://example.com/first" }, { LINKS });
    await reached.promise;
    // The second edit commits and publishes while the first one's KV write is still on its way.
    expect((await patch("order", { active: false })).status).toBe(200);
    release.resolve();
    expect((await first).status).toBe(200);
    expect(await kv("order")).toMatchObject({ u: "https://example.com/first", a: 0 });
  });

  it("refuses an edit based on an older version, and leaves clients without one alone", async () => {
    const made = await create("versioned");
    expect(made.version).toBe("0");
    const saved = ((await (await patch("versioned", { title: "One" })).json()) as { link: LinkDTO }).link;
    expect(saved.version).not.toBe("0");

    const stale = await patch("versioned", { title: "Stale", version: made.version });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "version_conflict", version: saved.version });
    expect((await row("versioned"))!.title).toBe("One");

    expect((await patch("versioned", { title: "Two", version: saved.version })).status).toBe(200);
    expect((await patch("versioned", { title: "Three" })).status).toBe(200);
    expect((await row("versioned"))!.title).toBe("Three");
  });

  it("doesn't count a save that changes nothing as a new version", async () => {
    const { version } = ((await (await patch((await create("same")).slug, { title: "T" })).json()) as { link: LinkDTO }).link;
    const again = ((await (await patch("same", { title: "T", version })).json()) as { link: LinkDTO }).link;
    expect(again.version).toBe(version);
    expect(await versions("same")).toHaveLength(2);
  });

  it("bulk actions leave the other fields alone and record what D1 holds", async () => {
    await create("bulk", { title: "Before" });
    await env.DB.prepare("UPDATE links SET title = 'Newer' WHERE slug = 'bulk'").run();
    const res = await call(`${API}/links/bulk`, json({ links: [{ domain: "sh.example", slug: "bulk" }], action: "disable" }));
    expect(await res.json()).toMatchObject({ changed: 1 });
    expect(await row("bulk")).toMatchObject({ title: "Newer", active: 0 });
    expect((await versions("bulk"))[0]!.snapshot).toMatchObject({ title: "Newer", active: 0 });
    expect(await kv("bulk")).toMatchObject({ a: 0 });
  });
});

describe("restoring a version and the password", () => {
  const hash = async (slug: string) => (await row(slug))!.password_hash as string | null;

  it("keeps the current password unless the version's is asked for", async () => {
    await create("locked", { password: "first-password-1" });
    const firstHash = await hash("locked");
    await patch("locked", { password: "second-password-2", notes: "later" });
    const secondHash = await hash("locked");
    const original = (await versions("locked")).at(-1)!;

    expect((await restore("locked", original.id)).status).toBe(200);
    expect(await hash("locked")).toBe(secondHash);
    expect((await kv("locked"))!.pw).toBe(secondHash);
    expect((await row("locked"))!.notes).toBe("");

    expect((await restore("locked", original.id, "?password=version")).status).toBe(200);
    expect(await hash("locked")).toBe(firstHash);
    expect((await kv("locked"))!.pw).toBe(firstHash);
  });

  it("doesn't take protection off, and says so when nothing else differs", async () => {
    await create("open");
    await patch("open", { password: "added-password-1" });
    const before = (await versions("open")).at(-1)!;
    const res = await restore("open", before.id);
    expect(res.status).toBe(409);
    expect(await hash("open")).not.toBeNull();
    expect((await restore("open", before.id, "?password=version")).status).toBe(200);
    expect(await hash("open")).toBeNull();
  });
});

describe("one rule for destinations", () => {
  it("refuses http:// import rows one by one, with the reason, and imports the rest", async () => {
    const rows = [
      { slug: "plain", target: "http://example.com/x" },
      { slug: "fine", target: "https://example.com/y" },
    ];
    const result = (await (await call(`${API}/import`, json({ rows }))).json()) as { created: number; errors: number; rows: { slug: string; status: string; message?: string }[] };
    expect(result).toMatchObject({ created: 1, errors: 1 });
    expect(result.rows.find((r) => r.slug === "plain")).toMatchObject({ status: "error", message: expect.stringContaining("https://") });
    expect(await row("plain")).toBeNull();
    await create("exists");
    const over = (await (await call(`${API}/import`, json({ rows: [{ slug: "exists", target: "http://example.com/x" }], mode: "overwrite" }))).json()) as { errors: number };
    expect(over.errors).toBe(1);
    expect((await row("exists"))!.target).toBe(TARGET);
  });

  it("lets an older import keep its http:// destination, but not get a new one", async () => {
    await env.DB.prepare("INSERT INTO links (domain, slug, target, source, created_at, updated_at) VALUES ('sh.example', 'legacy', 'http://example.com/old', 'import', 1, 1)").run();
    expect((await patch("legacy", { target: "http://example.com/old", title: "Kept" })).status).toBe(200);
    expect((await patch("legacy", { target: "http://example.com/other" })).status).toBe(400);
    expect((await row("legacy"))!.target).toBe("http://example.com/old");
  });

  it("applies the link rules to bio buttons when saved", async () => {
    const page = (url: string): BioPage => ({ name: "Me", text: "", avatarKey: null, theme: "auto", accent: "#6554c0", blocks: [{ label: "Go", url }] });
    expect(validateBio(page("https://example.com/ok")).ok).toBe(true);
    for (const bad of ["https://user:pass@example.com/", "https://sh.example/own"]) {
      const res = await call(`${API}/links`, json({ slug: "b", target: TARGET, bio: page(bad) }));
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Button 1/);
    }
  });

  it("keeps an older bio page working, without a button that breaks the rules", () => {
    const html = renderBio(
      { name: "Me", text: "", avatarKey: null, theme: "auto", accent: "#6554c0", blocks: [{ label: "Own", url: "https://sh.example/own" }, { label: "Trick", url: "https://paypal.com@evil.example/" }] },
      { domain: "sh.example", linkHref: () => "" },
    );
    expect(html).toContain("Own");
    expect(html).not.toContain("Trick");
  });

  it("checks bio buttons as destinations", async () => {
    await create("page", { bio: { name: "Me", text: "", avatarKey: null, theme: "auto", accent: "#6554c0", blocks: [{ label: "Go", url: "https://example.com/button" }] } });
    const { results } = await env.DB.prepare("SELECT url FROM link_destinations WHERE slug = 'page' ORDER BY url").all<{ url: string }>();
    expect(results.map((r) => r.url)).toEqual(["https://example.com/button", TARGET]);
    expect(bioButtonUrls({ name: "", text: "", avatarKey: null, theme: "auto", accent: "#000000", blocks: [{ type: "text", text: "x" }, { label: "Mine", link: { domain: "sh.example", slug: "a" } }] })).toEqual([]);
  });

  it("gives HEAD on a flagged link the warning's status and no address", async () => {
    await putLink("flagged", { u: "https://phish.example/steal", w: 1 });
    const head = await call(`${ORIGIN}/flagged`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Location")).toBeNull();
    expect(await head.text()).toBe("");
    expect(await (await call(`${ORIGIN}/flagged`)).text()).toContain("phish.example");
  });
});

describe("click limits after an import", () => {
  const click = (slug: string) => call(`${ORIGIN}/${slug}`, { headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } });
  const cfg = (slug: string, maxClicks: number) => ({ slug, target: TARGET, config: { maxClicks } });

  it("starts from zero when a link comes back through an import", async () => {
    await create("again", { maxClicks: 1 });
    expect((await click("again")).status).toBe(302);
    expect((await click("again")).status).toBe(410);
    expect((await call(`${API}/links/sh.example/again`, { method: "DELETE", headers: bearer })).status).toBe(200);
    expect(await (await call(`${API}/import`, json({ rows: [cfg("again", 1)] }))).json()).toMatchObject({ created: 1 });
    expect(await (await call(`${API}/links/sh.example/again/cap`, { headers: bearer })).json()).toEqual({ limit: 1, count: 0 });
    expect((await click("again")).status).toBe(302);
    expect((await click("again")).status).toBe(410);
  });

  it("keeps the count when an import overwrites a link that already has a limit", async () => {
    await create("kept", { maxClicks: 1 });
    expect((await click("kept")).status).toBe(302);
    await call(`${API}/import`, json({ rows: [cfg("kept", 1)], mode: "overwrite" }));
    expect((await click("kept")).status).toBe(410);
  });
});

function memoryBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string) => void objects.set(key, value),
      list: async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), delimitedPrefixes: [] }),
      delete: async () => undefined,
    } as unknown as R2Bucket,
  };
}

describe("the weekly backup", () => {
  const SUNDAY = new Date("2026-11-01T04:00:00Z");
  const job = async () => JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_job'").first<{ value: string }>())!.value) as { id: string; table: number; order?: number };
  const check = async (e: Env, now = SUNDAY) => (await systemHealth(e, now)).checks.find((c) => c.id === "backup");

  it("copies what can't be rebuilt before the tables that grow with traffic", () => {
    const at = (t: (typeof BACKUP_TABLE_NAMES)[number]) => BACKUP_TABLE_NAMES.indexOf(t);
    for (const t of ["links", "settings", "users", "sites", "payments", "subscriptions", "payment_connections"] as const) expect(at(t), t).toBeLessThan(at("daily_stats"));
    expect(BACKUP_TABLE_NAMES.at(-1)).toBe("web_sessions");
  });

  it("carries on where it stopped, the next day and the next week, instead of starting over", async () => {
    const { objects, bucket } = memoryBucket();
    const e = { ...env, BACKUPS: bucket } as Env;
    await create("one");
    // Three tables a run at this budget.
    await scheduledBackup(e, SUNDAY, 10);
    const started = await job();
    expect(started.table).toBe(3);
    await scheduledBackup(e, new Date("2026-11-03T04:30:00Z"), 10);
    expect(await job()).toMatchObject({ id: started.id, table: 6 });
    // A week on, Sunday's first slot finds it unfinished, and goes on with it.
    await env.DB.prepare("UPDATE settings SET value = json_set(value, '$.startedAt', json_extract(value, '$.startedAt') - ?) WHERE key = 'backup_job'").bind(7 * 86400).run();
    await scheduledBackup(e, new Date("2026-11-08T04:00:00Z"), 10);
    expect(await job()).toMatchObject({ id: started.id, table: 9 });
    let done = false;
    for (let i = 0; i < 12 && !done; i++) done = (await scheduledBackup(e, new Date("2026-11-08T05:00:00Z"), 10))?.done ?? false;
    expect(done).toBe(true);
    expect(objects.has(`backups/${started.id}/manifest.json`)).toBe(true);
    expect(objects.has(`backups/${started.id}/web_sessions/00000.json`)).toBe(true);
  });

  it("starts over a job from the old table order, whose position means nothing", async () => {
    const { bucket } = memoryBucket();
    const e = { ...env, BACKUPS: bucket } as Env;
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('backup_job', ?)").bind(JSON.stringify({ id: "old", table: 14, offset: 0, counts: {}, startedAt: Math.floor(SUNDAY.getTime() / 1000) - 7200 })).run();
    await scheduledBackup(e, new Date("2026-11-01T05:00:00Z"), 10);
    const j = await job();
    expect(j.id).not.toBe("old");
    expect(j.table).toBe(3);
  });

  it("reports a stuck or failing backup, and stays quiet without a bucket", async () => {
    const e = { ...env, BACKUPS: memoryBucket().bucket } as Env;
    const now = Math.floor(SUNDAY.getTime() / 1000);
    expect(await check(env)).toBeUndefined();
    expect(await check(e)).toMatchObject({ status: "ok" });
    const put = (key: string, value: unknown) => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, JSON.stringify(value)).run();
    await put("backup_last", { id: "x", at: now - 20 * 86400, rows: 5 });
    expect(await check(e)).toMatchObject({ status: "warn", detail: expect.stringContaining("one should run every Sunday") });
    await put("backup_job", { id: "y", table: 2, offset: 0, counts: {}, startedAt: now - 10 * 86400, order: 2 });
    expect(await check(e)).toMatchObject({ status: "warn", detail: expect.stringContaining("hasn't finished") });
    await put("backup_job", { id: "y", table: 2, offset: 0, counts: {}, startedAt: now, order: 2, error: "R2 said no" });
    expect(await check(e)).toMatchObject({ status: "warn", detail: expect.stringContaining("R2 said no") });
  });

  it("says when backups ran and the bucket is gone, which stops them without an error", async () => {
    const now = Math.floor(SUNDAY.getTime() / 1000);
    const put = (value: unknown) => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_last', ?)").bind(JSON.stringify(value)).run();
    await put({ id: "x", at: now - 3 * 86400, rows: 5 });
    const gone = (await systemHealth(env, SUNDAY)).checks.find((c) => c.id === "backup");
    expect(gone).toMatchObject({ status: "warn", detail: expect.stringContaining("no longer has a BACKUPS bucket") });
    expect(gone?.advisory).toBeFalsy();
    // Long ago it reads as a decision: still said, but it doesn't turn the status yellow.
    await put({ id: "x", at: now - 90 * 86400, rows: 5 });
    expect(await check(env)).toMatchObject({ status: "warn", advisory: true });
  });

  it("says in the manifest that team details are in every backup", () => {
    expect(manifest({}, false).team).toMatch(/team's emails and names/);
  });
});

describe("restoring links from links.json", () => {
  const PAGE = { name: "Me", text: "", avatarKey: null, theme: "auto", accent: "#6554c0", blocks: [{ label: "Go", url: "https://example.com/button" }, { label: "Next", link: { domain: "sh.example", slug: "dest" } }] };
  type Exported = { slug: string; target: string; config: Record<string, unknown> };
  const exported = async () => ((await (await adminCall("", "/export/links.json")).json()) as { links: Exported[] }).links;
  const importRows = async (rows: unknown[], mode = "skip") => (await (await adminCall("", "/import", { body: { rows, mode } })).json()) as { created: number; updated: number; skipped: number; errors: number; rows: { slug: string; status: string; message?: string }[] };
  async function forget() {
    await env.DB.batch([env.DB.prepare("DELETE FROM links"), env.DB.prepare("DELETE FROM link_versions")]);
    const { keys } = await env.LINKS.list();
    await Promise.all(keys.map((k) => env.LINKS.delete(k.name)));
  }

  it("brings back bio pages, broken and off settings, and destination checks", async () => {
    await create("dest");
    await create("me", { bio: PAGE });
    await create("gone");
    expect((await patch("gone", { broken: true, replacement: { domain: "sh.example", slug: "dest" }, neverCheck: true })).status).toBe(200);
    await create("off");
    expect((await patch("off", { active: false, offRedirect: { domain: "sh.example", slug: "dest" }, monitor: true })).status).toBe(200);
    await create("home");
    expect((await patch("home", { active: false, offRedirect: "home" })).status).toBe(200);
    const before = await Promise.all(["me", "gone", "off", "home"].map(row));
    const file = await exported();

    await forget();
    // Links before the ones they name: an import comes in batches, in any order.
    const order = ["me", "gone", "off", "home", "dest"].map((s) => file.find((l) => l.slug === s)!);
    expect(await importRows(order)).toMatchObject({ created: 5, errors: 0 });

    for (const [i, slug] of ["me", "gone", "off", "home"].entries()) {
      const r = (await row(slug))!;
      for (const col of ["bio", "broken", "replacement", "off_redirect", "monitor", "active"]) expect(r[col], `${slug}.${col}`).toEqual(before[i]![col]);
    }
    expect((await kv("me"))!.bio).toBeTruthy();
    const page = await call(`${ORIGIN}/me`, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("https://example.com/button");
  });

  it("leaves those settings alone when an older file, without them, overwrites a link", async () => {
    await create("dest");
    await create("me", { bio: PAGE });
    expect((await patch("me", { broken: true })).status).toBe(200);
    const { bio, broken, replacement, offRedirect, monitor, neverCheck, passwordProtected, ...older } = (await exported()).find((l) => l.slug === "me")!.config;
    void [bio, broken, replacement, offRedirect, monitor, neverCheck, passwordProtected];
    expect(await importRows([{ slug: "me", target: TARGET, config: { ...older, notes: "from an old file" } }], "overwrite")).toMatchObject({ updated: 1, errors: 0 });
    const r = (await row("me"))!;
    expect(r.notes).toBe("from an old file");
    expect(r.bio).toBeTruthy();
    expect(r.broken).toBe(1);
  });

  it("brings a link that had a password back turned off, and says so", async () => {
    await create("locked", { password: "a-long-secret-1" });
    const file = await exported();
    expect(file[0]!.config.passwordProtected).toBe(true);
    expect(JSON.stringify(file)).not.toContain("password_hash");
    await forget();
    const res = await importRows(file);
    expect(res.rows[0]).toMatchObject({ status: "created", message: expect.stringContaining("had a password") });
    expect(await row("locked")).toMatchObject({ active: 0, password_hash: null });
    expect((await call(`${ORIGIN}/locked`, { redirect: "manual" })).headers.get("Location") ?? "").not.toContain("example.com/start");
  });

  it("leaves a password that is still on the link in place", async () => {
    await create("locked", { password: "a-long-secret-1" });
    const hash = (await row("locked"))!.password_hash;
    const res = await importRows(await exported(), "overwrite");
    expect(res.rows[0]!.message ?? "").not.toContain("password");
    expect(await row("locked")).toMatchObject({ active: 1, password_hash: hash });
  });

  it("keeps an http:// destination the link already has, and reports one it would be getting", async () => {
    await env.DB.prepare("INSERT INTO links (domain, slug, target, source, created_at, updated_at) VALUES ('sh.example', 'legacy', 'http://example.com/old', 'import', 1, 1)").run();
    const file = await exported();
    expect(await importRows(file)).toMatchObject({ skipped: 1, errors: 0 });
    expect(await importRows(file, "overwrite")).toMatchObject({ updated: 1, errors: 0 });
    expect((await row("legacy"))!.target).toBe("http://example.com/old");

    expect((await importRows([{ ...file[0]!, target: "http://example.com/other" }], "overwrite")).rows[0]).toMatchObject({ status: "error", message: expect.stringContaining("http://") });
    await forget();
    const res = await importRows(file);
    expect(res.rows[0]).toMatchObject({ status: "error", message: expect.stringContaining("docs/SETUP.md#restore") });
    expect(await row("legacy")).toBeNull();
  });

  it("reports a row whose settings can't be restored, and imports the others", async () => {
    await create("fine");
    const [fine] = await exported();
    await forget();
    const res = await importRows([
      { slug: "bad-bio", target: TARGET, config: { bio: { ...PAGE, name: "" } } },
      { slug: "odd-bio", target: TARGET, config: { bio: { ...PAGE, blocks: [1] } } },
      { slug: "loop", target: TARGET, config: { replacement: { domain: "sh.example", slug: "loop" } } },
      { slug: "self", target: TARGET, config: { offRedirect: { domain: "sh.example", slug: "self" } } },
      fine,
    ]);
    expect(res).toMatchObject({ created: 1, errors: 4 });
    expect(res.rows.slice(0, 4).map((r) => r.message)).toEqual([expect.stringContaining("bio:"), expect.stringContaining("bio:"), expect.stringContaining("replace itself"), expect.stringContaining("itself")]);
  });
});

describe("webhook fairness", () => {
  const HOOK = "https://hooks.example.com/in";
  async function hook(events: string[]): Promise<number> {
    const secret = await encryptSecret(env, "webhook", "whsec_test");
    const r = await env.DB.prepare("INSERT INTO webhooks (url, description, events, secret, active, created_at, updated_at) VALUES (?, '', ?, ?, 1, 1, 1) RETURNING id").bind(HOOK, JSON.stringify(events), secret).first<{ id: number }>();
    return r!.id;
  }
  const delivery = (id: string, hookId: number, type: string, nextAt: number) =>
    env.DB.prepare("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, payload, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, '{}', 'pending', 0, ?, 1)").bind(id, hookId, `e_${id}`, type, nextAt);

  async function sentOrder(budget: number): Promise<string[]> {
    const sent: string[] = [];
    await deliver(env, { budget, fetcher: (async (_url: string, init: RequestInit) => { sent.push(new Headers(init.headers).get("X-Shorthop-Delivery")!); return new Response("ok"); }) as unknown as typeof fetch });
    return sent;
  }

  it("sends a payment ahead of older spike alerts, and still gives others a turn", async () => {
    const id = await hook(["site.payment", "site.traffic_spike", "link.created"]);
    await env.DB.batch([
      delivery("spike1", id, "site.traffic_spike", 1),
      delivery("spike2", id, "site.traffic_spike", 2),
      delivery("link1", id, "link.created", 5),
      delivery("pay1", id, "site.payment", 9),
      delivery("pay2", id, "site.payment", 10),
    ]);
    const first = await sentOrder(2);
    expect(first).toContain("pay1");
    // Of the rest, the link event goes first: spikes wait behind everything else.
    expect(first).toContain("link1");
    expect(first).not.toContain("spike1");
    expect(await sentOrder(2)).toContain("pay2");
  });

  it("caps what one run of spike alerts sends, with a count of the rest", async () => {
    await call(`${API}/webhooks`, json({ url: HOOK, events: ["site.traffic_spike"] }));
    const site = (await (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json()) as SiteDTO;
    const t = Math.floor(Date.now() / 1000);
    const stmt = env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews, source, channel) VALUES (?, ?, ?, ?, ?, 1, ?, 'Referral')");
    const rows = [];
    for (let s = 0; s < 6; s++) for (let i = 0; i < 20 + s; i++) rows.push(stmt.bind(`s${s}x${i}`, site.id, `v${s}${i}`, t - 1000, t - 900, `made-up-${s}`));
    await env.DB.batch(rows);
    expect(await runSiteAlerts(env, t)).toMatchObject({ spikes: 6 });
    const { results } = await env.DB.prepare("SELECT payload FROM webhook_deliveries WHERE event_type = 'site.traffic_spike'").all<{ payload: string }>();
    expect(results).toHaveLength(3);
    const events = results.map((r) => (JSON.parse(r.payload) as { data: { source: string; other_sources?: number } }).data);
    expect(events.find((d) => d.source === "made-up-5")).toMatchObject({ other_sources: 3 });
  });
});

describe("pulling from another shortener", () => {
  const stub = (body: string | ((url: string) => Response)) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => (typeof body === "string" ? new Response(body) : body(String(input))));

  it("keeps a page when one short link has a malformed path", async () => {
    stub((url) =>
      url.endsWith("/v4/user")
        ? Response.json({ default_group_guid: "G1" })
        : Response.json({ links: [{ id: "bit.ly/ok", long_url: "https://example.com/a", link: "https://bit.ly/ok" }, { id: "bit.ly/bad", long_url: "https://example.com/b", link: "https://bit.ly/100%" }], pagination: {} }),
    );
    const page = await pullLinks("bitly", "key", null, 5, { clicks: false });
    expect(page.rows.map((r) => r.slug)).toEqual(["ok", "100%"]);
  });

  it("refuses an oversized or unreadable answer with a clear message", async () => {
    stub("x".repeat(5_000_001));
    await expect(pullLinks("dub", "key", null, 1, { clicks: false })).rejects.toBeInstanceOf(VendorError);
    vi.restoreAllMocks();
    stub("<html>not json</html>");
    await expect(pullLinks("dub", "key", null, 1, { clicks: false })).rejects.toThrow(/isn't readable/);
  });
});

describe("the outbound address guard", () => {
  it.each([
    "https://192.0.2.1/",
    "https://198.51.100.1/",
    "https://203.0.113.1/",
    "https://192.88.99.1/",
    "https://[2001:db8::1]/",
    "https://[3fff::1]/",
    "https://[2001:2::1]/",
    "https://[::ffff:203.0.113.1]/",
  ])("refuses the reserved address %s", (url) => expect(isFetchableUrl(new URL(url))).toBe(false));

  it.each(["https://8.8.8.8/", "https://203.0.114.1/", "https://198.51.101.1/", "https://[2606:4700::1111]/", "https://[3fff:1000::1]/"])("still allows %s", (url) => expect(isFetchableUrl(new URL(url))).toBe(true));
});

describe("day salts", () => {
  const NOON = new Date("2026-11-10T12:00:00Z");
  const check = async () => (await systemHealth(env, NOON)).checks.find((c) => c.id === "salts");

  it("tries the prune again when D1 fails, and deletes finished days' salts", async () => {
    await daySaltFor(env.DB, "2026-11-08");
    await daySaltFor(env.DB, "2026-11-10");
    let calls = 0;
    const real = env.DB;
    const DB = new Proxy(real, {
      get(target, key) {
        if (key !== "batch") {
          const v = Reflect.get(target, key) as unknown;
          return typeof v === "function" ? v.bind(target) : v;
        }
        return (stmts: D1PreparedStatement[]) => (++calls === 1 ? Promise.reject(new Error("D1 busy")) : target.batch(stmts));
      },
    });
    await pruneSaltsAndBudget({ ...env, DB } as Env, NOON);
    expect(calls).toBe(2);
    expect(await env.DB.prepare("SELECT key FROM settings WHERE key LIKE 'visitor_salt:%' ORDER BY key").all<{ key: string }>().then((r) => r.results.map((x) => x.key))).toEqual(["visitor_salt:2026-11-10"]);
  });

  it("reports salts that outlived their day", async () => {
    await daySaltFor(env.DB, "2026-11-10");
    expect(await check()).toBeUndefined();
    await daySaltFor(env.DB, "2026-11-08");
    expect(await check()).toMatchObject({ status: "warn" });
  });
});

describe("rate limiter keys", () => {
  const IP = "203.0.113.77";

  it("hold a keyed hash of the network, the same for every request from it", async () => {
    const a = await limiterKey(env, "public", IP);
    expect(a).toMatch(/^public:[0-9a-f]{32}$/);
    expect(a).not.toContain(IP);
    expect(await limiterKey(env, "public", IP)).toBe(a);
    expect(await limiterKey(env, "public", "203.0.113.78")).not.toBe(a);
    // Addresses in one IPv6 /64 are one network, as before.
    expect(await limiterKey(env, "public", "2001:4860::1")).toBe(await limiterKey(env, "public", "2001:4860::2"));
    expect(await limiterKey({ SESSION_SECRET: "" }, "public", IP)).toMatch(/^public:[0-9a-f]{32}$/);
  });

  it("reach the limiter without the address", async () => {
    const keys: string[] = [];
    await publicLimit(new Request(ORIGIN, { headers: { "CF-Connecting-IP": IP } }), { ...env, PUBLIC_LIMITER: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) } } as Env);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(IP);
  });
});

describe("stored secrets in System status", () => {
  it("warns properly, not just as a note, while the key sits in the database", async () => {
    const { resetGeneratedSecretsCache, withGeneratedSecrets } = await import("../src/worker/secrets");
    resetGeneratedSecretsCache();
    const button = await withGeneratedSecrets({ ...env, SESSION_SECRET: "" } as Env);
    const checks = (await systemHealth(button)).checks;
    expect(checks.find((c) => c.id === "encryption")).toMatchObject({ status: "warn" });
    expect(checks.find((c) => c.id === "encryption")?.advisory).toBeUndefined();
    button.ENCRYPTION_KEY = "an-encryption-key-0123456789abcdef-0123";
    const after = (await systemHealth(button)).checks;
    expect(after.find((c) => c.id === "encryption")).toBeUndefined();
    expect(after.find((c) => c.id === "generatedsecrets")).toMatchObject({ status: "warn", advisory: true });
  });
});

// Backups that can really be restored: paging that stays cheap at depth and
// resumes correctly, and every kind of backup loaded back into an empty database.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_VERSION, insertSql, newEpochSql, newRestoreContext, NOBODY_VISITOR_PREFIX, restoreRow, type BackupRow, type RestoreContext } from "../src/shared/backup-restore";
import type { PrivacyEraseDTO, PrivacyReapplyDTO, SiteDTO } from "../src/shared/sites";
import { BACKUP_PAGE, BACKUP_TABLE_NAMES, BACKUP_TABLES, backupPage, manifest, scheduledBackup, type TableSpec } from "../src/worker/backup";
import { ERASED_VISITOR_PREFIX } from "../src/worker/revenue/match";
import { encryptSecret } from "../src/worker/webhooks";
import { API, call, json, ORIGIN, resetData } from "./helpers";
import { addKey, addUser, adminCall } from "./people";

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const SUNDAY = new Date("2026-11-01T04:00:00Z");
const VISITOR = "alice-visitor-0001";

beforeEach(async () => {
  await resetData();
  await env.DB.batch(["link_clicks", "site_spikes", "web_daily_events"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => (String(input instanceof Request ? input.url : input).includes("frankfurter") ? Promise.resolve(new Response("offline", { status: 503 })) : real(input, init)));
});
afterEach(() => vi.restoreAllMocks());

function memoryBucket(failPut?: (key: string) => boolean) {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string) => {
        if (failPut?.(key)) throw new Error("R2 said no");
        objects.set(key, value);
      },
      list: async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), delimitedPrefixes: [] }),
      delete: async () => undefined,
    } as unknown as R2Bucket,
  };
}

/** The rows of one table in an R2 backup, page files in order. */
function r2Rows(objects: Map<string, string>, id: string, table: string): BackupRow[] {
  return [...objects.keys()]
    .filter((k) => k.startsWith(`backups/${id}/${table}/`))
    .sort()
    .flatMap((k) => JSON.parse(objects.get(k)!) as BackupRow[]);
}

async function runBackup(e: Env, budget = 40): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const res = await scheduledBackup(e, new Date(SUNDAY.getTime() + i * 1800_000), budget);
    if (res?.done) return JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'backup_last'").first<{ value: string }>())!.value).id as string;
  }
  throw new Error("the backup never finished");
}

/** What Settings → Backup downloads: every table, page by page through the API's own function. */
async function zipBackup(personal: boolean): Promise<Record<string, BackupRow[]>> {
  const out: Record<string, BackupRow[]> = {};
  for (const table of BACKUP_TABLE_NAMES) {
    out[table] = [];
    let cursor: string | null = null;
    do {
      const page: { rows: BackupRow[]; next: string | null } = await backupPage(env.DB, table, cursor, { personal });
      out[table].push(...page.rows);
      cursor = page.next;
    } while (cursor);
  }
  return out;
}

/** D1 as migrations leave it. KV is left alone: restoring D1 doesn't touch it. */
async function emptyDatabase(): Promise<void> {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'").all<{ name: string }>();
  await env.DB.batch(results.map((t) => env.DB.prepare(t.name === "settings" ? "DELETE FROM settings WHERE key != 'default_utm'" : `DELETE FROM ${t.name}`)));
}

async function restore(tables: Record<string, BackupRow[]>): Promise<RestoreContext> {
  const c = newRestoreContext(Math.floor(Date.now() / 1000), () => crypto.randomUUID());
  const sql: string[] = [];
  for (const table of BACKUP_TABLE_NAMES) {
    for (const row of tables[table] ?? []) {
      const restored = restoreRow(table, row, c);
      if (restored) sql.push(insertSql(table, restored));
    }
  }
  sql.push(newEpochSql(c));
  for (let i = 0; i < sql.length; i += 50) await env.DB.batch(sql.slice(i, i + 50).map((s) => env.DB.prepare(s)));
  return c;
}

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const first = <T>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<T>();

async function createSite(): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"], idMode: "persistent" }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

async function visit(site: SiteDTO, visitor: string): Promise<string> {
  const res = await call(`${ORIGIN}/_t/e`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/?utm_source=newsletter`, r: "", w: 1440, v: visitor }),
  });
  expect(res.status).toBe(200);
  return (await res.json<{ s: string }>()).s;
}

/** A workspace with one of everything a restore has to deal with. */
async function populate() {
  expect((await call(`${API}/links`, json({ slug: "open", target: "https://example.com/open" }))).status).toBe(201);
  expect((await call(`${API}/links`, json({ slug: "locked", target: "https://example.com/locked", password: "a-long-secret-1" }))).status).toBe(201);
  await addUser("editor@example.com", "user", ["links.edit"], { password: "another-long-secret" });
  const key = await addKey("editor@example.com", ["links.create"]);
  const secret = await encryptSecret(env, "webhook", "whsec_original");
  await env.DB.prepare("INSERT INTO webhooks (url, events, secret, active, created_at, updated_at) VALUES ('https://hooks.example.com/in', '[\"link.created\"]', ?, 1, 1, 1)").bind(secret).run();
  await env.DB.prepare("INSERT INTO stat_shares (id, domain, slug, secret_hash, secret_enc, created_by, created_at) VALUES ('sh1', 'sh.example', 'open', 'hash', 'enc', 'owner', 1)").run();
  const site = await createSite();
  const visitId = await visit(site, VISITOR);
  expect((await call(`${API}/sites/${site.id}/identify`, json({ visitorId: VISITOR, email: "alice@example.com", name: "Alice" }))).status).toBe(200);
  expect((await call(`${API}/sites/${site.id}/payments`, json({ id: "p1", amount: 50, currency: "USD", email: "alice@example.com", customerId: "cus_A", visitorId: VISITOR, ref: visitId }))).status).toBe(201);
  return { site, visitId, key };
}

describe("backup pages", () => {
  /** env.DB, noting the rows each query read. */
  function countingDb() {
    const reads: number[] = [];
    const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
      ({
        bind: (...v: unknown[]) => wrap(st.bind(...v)),
        all: async () => {
          const r = await st.all();
          reads.push(r.meta.rows_read);
          return r;
        },
      }) as unknown as D1PreparedStatement;
    return { reads, db: { prepare: (sql: string) => wrap(env.DB.prepare(sql)) } as unknown as D1Database };
  }

  const fill = (n: number) =>
    env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) SELECT printf('v%06d', i), 'st', 'someone', 1, 1 FROM n`,
      ).bind(n),
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO daily_dims (date, domain, slug, dim, value, clicks, bots) SELECT '2026-11-01', 'sh.example', 'a', 'country', printf('c%06d', i), 1, 0 FROM n`,
      ).bind(n),
    ]);

  for (const table of ["web_sessions", "daily_dims"] as const) {
    it(`reads about one page of ${table} however deep it is`, async () => {
      await fill(BACKUP_PAGE * 4 + 300);
      const { db, reads } = countingDb();
      const seen: BackupRow[] = [];
      let cursor: string | null = null;
      do {
        const page: { rows: BackupRow[]; next: string | null } = await backupPage(db, table, cursor, { personal: false });
        seen.push(...page.rows);
        cursor = page.next;
      } while (cursor);
      expect(seen).toHaveLength(BACKUP_PAGE * 4 + 300);
      const key = (r: BackupRow) => (table === "web_sessions" ? r.id : r.value);
      expect(new Set(seen.map(key)).size).toBe(seen.length);
      expect(reads).toHaveLength(5);
      // OFFSET read 1,000, 2,000, ... 5,000 here.
      expect(Math.max(...reads)).toBeLessThanOrEqual(BACKUP_PAGE + 2);
    });
  }

  it("pages along each table's whole primary key", async () => {
    for (const table of BACKUP_TABLE_NAMES) {
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; pk: number }>();
      const pk = results.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      expect((BACKUP_TABLES[table] as TableSpec).order, table).toBe(pk.join(", "));
    }
  });

  it("keeps leaving secret settings out on later pages", async () => {
    await env.DB.batch([["alpha", "1"], ["session_epoch", "secret"], ["zulu", "2"]].map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(k, v)));
    const { rows } = await backupPage(env.DB, "settings", JSON.stringify(["alpha"]), { personal: false });
    expect(rows.map((r) => r.key)).toEqual(["default_utm", "zulu"]);
  });

  it("hands the browser a position, and refuses anything else", async () => {
    await fill(BACKUP_PAGE + 5);
    const one = await (await adminCall("", "/backup/web_sessions")).json<{ rows: unknown[]; next: string }>();
    expect(one.rows).toHaveLength(BACKUP_PAGE);
    const two = await (await adminCall("", `/backup/web_sessions?cursor=${encodeURIComponent(one.next)}`)).json<{ rows: unknown[]; next: string | null }>();
    expect(two).toMatchObject({ next: null });
    expect(two.rows).toHaveLength(5);
    expect((await adminCall("", "/backup/web_sessions?cursor=nonsense")).status).toBe(400);
    // A tab open across the upgrade sends the new position as its old offset: it stops rather than loops.
    expect((await adminCall("", `/backup/web_sessions?offset=${encodeURIComponent(one.next)}`)).status).toBe(400);
  });
});

describe("the weekly copy, across runs", () => {
  it("gets every row of a large table exactly once, also when a run fails halfway", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2600)
       INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) SELECT printf('v%06d', i), 'st', 'someone', 1, 1 FROM n`,
    ).run();
    let failures = 1;
    const { objects, bucket } = memoryBucket((key) => key.endsWith("web_sessions/00001.json") && failures-- > 0);
    const e = { ...env, BACKUPS: bucket } as Env;
    let id = "";
    for (let i = 0; i < 40 && !id; i++) {
      try {
        const res = await scheduledBackup(e, new Date(SUNDAY.getTime() + i * 1800_000), 12);
        if (res?.done) id = "2026-11-01T04-00";
      } catch {
        // The job kept its place; the next slot goes on.
      }
    }
    expect(id).not.toBe("");
    const ids = r2Rows(objects, id, "web_sessions").map((r) => r.id);
    expect(ids).toHaveLength(2600);
    expect(new Set(ids).size).toBe(2600);
    expect(JSON.parse(objects.get(`backups/${id}/manifest.json`)!)).toMatchObject({ version: BACKUP_VERSION, tables: { web_sessions: 2600 } });
  });
});

describe("restoring into an empty database", () => {
  it("has a value for every required column a backup leaves out", async () => {
    const c = newRestoreContext(1, () => "00000000-0000-4000-8000-000000000000");
    const missing: string[] = [];
    for (const table of BACKUP_TABLE_NAMES) {
      const spec: TableSpec = BACKUP_TABLES[table];
      const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; notnull: number; dflt_value: unknown; pk: number }>();
      const dropped = new Set([...(spec.secret ?? []), ...(spec.personal ?? [])]);
      const required = results.filter((col) => dropped.has(col.name) && col.notnull && col.dflt_value === null && !col.pk);
      const row = restoreRow(table, { id: "x", domain: "d", slug: "s", key: "k" }, c);
      for (const col of required) if (row?.[col.name] === undefined) missing.push(`${table}.${col.name}`);
    }
    expect(missing).toEqual([]);
    expect(NOBODY_VISITOR_PREFIX).toBe(ERASED_VISITOR_PREFIX);
  });

  it("restores the weekly R2 copy, which holds no secrets and no people", async () => {
    const { visitId, key, site } = await populate();
    const { objects, bucket } = memoryBucket();
    const id = await runBackup({ ...env, BACKUPS: bucket } as Env);
    expect(JSON.parse(objects.get(`backups/${id}/manifest.json`)!).version).toBe(BACKUP_VERSION);
    const tables = Object.fromEntries(BACKUP_TABLE_NAMES.map((t) => [t, r2Rows(objects, id, t)]));
    const before = Object.fromEntries(await Promise.all((["links", "users", "api_keys", "webhooks", "stat_shares", "payments", "web_sessions", "sites"] as const).map(async (t) => [t, await count(t)])));

    await emptyDatabase();
    const { report } = await restore(tables);
    for (const [t, n] of Object.entries(before)) expect(await count(t), t).toBe(n);
    expect(report).toMatchObject({ passwordLinks: ["sh.example/locked"], people: 1, apiKeys: 1, webhooks: 1, shares: 1, anonymousVisits: 1 });

    // By design not in this backup.
    expect(await count("web_visitors")).toBe(0);
    expect(await first("SELECT email, customer_id, visitor_id FROM payments WHERE id LIKE '%p1'")).toEqual({ email: null, customer_id: null, visitor_id: null });
    expect(await first("SELECT value FROM settings WHERE key IN ('backup_job', 'backup_last')")).toBeNull();

    // The visit is there for revenue by source, belonging to nobody.
    const v = await first<{ visitor_id: string; utm_source: string }>("SELECT visitor_id, utm_source FROM web_sessions WHERE id = ?", visitId);
    expect(v!.visitor_id.startsWith(ERASED_VISITOR_PREFIX)).toBe(true);
    expect(v!.visitor_id).not.toBe(VISITOR);
    expect(v!.utm_source).toBe("newsletter");
    expect(await first<{ n: number }>("SELECT COUNT(*) AS n FROM payments p JOIN web_sessions s ON s.id = p.credited_session_id")).toEqual({ n: 1 });

    // Nothing that needed a secret comes back working.
    expect(await first("SELECT active, password_hash FROM links WHERE slug = 'locked'")).toEqual({ active: 0, password_hash: null });
    expect(await first("SELECT active FROM links WHERE slug = 'open'")).toEqual({ active: 1 });
    expect((await call(`${API}/links`, { headers: key.auth })).status).toBe(401);
    expect(await first("SELECT active FROM webhooks")).toEqual({ active: 0 });
    const hooks = await (await adminCall("", "/webhooks")).json<{ webhooks: { secretReadable: boolean }[] }>();
    expect(hooks.webhooks[0]!.secretReadable).toBe(false);
    expect((await first<{ revoked_at: number | null }>("SELECT revoked_at FROM stat_shares"))!.revoked_at).toBeGreaterThan(0);

    // The workspace works: links publish and redirect, and the erasure pass runs over the restored rows.
    await env.LINKS.delete("sh.example/open");
    expect((await adminCall("", "/resync", { method: "POST" })).status).toBe(200);
    const res = await call(`${ORIGIN}/open`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("https://example.com/open");
    expect((await call(`${ORIGIN}/locked`, { redirect: "manual" })).status).not.toBe(302);
    let cursor: string | null = null;
    do {
      const r: PrivacyReapplyDTO = await (await call(`${API}/sites/${site.id}/privacy/reapply`, json({ cursor }))).json();
      cursor = r.cursor;
    } while (cursor);
    expect(await count("web_sessions")).toBe(before.web_sessions);

    // Loading it again changes nothing.
    await restore(tables);
    expect(await count("links")).toBe(before.links);
  });

  it("signs out everyone who was signed in before the restore", async () => {
    await addUser("editor@example.com", "user", ["links.edit"]);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('session_epoch', 'old')").run();
    const tables = await zipBackup(false);
    await emptyDatabase();
    await restore(tables);
    expect(await first("SELECT value FROM settings WHERE key = 'session_epoch' AND value = 'old'")).toBeNull();
    expect(await first("SELECT value FROM settings WHERE key = 'session_epoch'")).not.toBeNull();
    expect((await first<{ session_epoch: string }>("SELECT session_epoch FROM users"))!.session_epoch).not.toBe("");
  });

  it("restores a download with people's details, and re-applying erases who was erased since", async () => {
    const { site } = await populate();
    const tables = await zipBackup(true);
    expect(tables.web_sessions![0]).toMatchObject({ visitor_id: VISITOR });
    expect(tables.web_visitors).toHaveLength(1);

    const erased = await call(`${API}/sites/${site.id}/privacy/erase`, json({ email: "alice@example.com", confirm: true }));
    expect(erased.status).toBe(200);
    await erased.json<PrivacyEraseDTO>();

    // D1 goes back to before the erasure. The ledger isn't in that backup; its copy in KV survives.
    await emptyDatabase();
    const { report } = await restore(tables);
    expect(report.anonymousVisits).toBe(0);
    expect(await first("SELECT email FROM web_visitors")).toEqual({ email: "alice@example.com" });
    expect(await first("SELECT email FROM payments")).toEqual({ email: "alice@example.com" });
    expect(await count("erasure_ledger")).toBe(0);

    let cursor: string | null = null;
    let identities = 0;
    do {
      const r: PrivacyReapplyDTO = await (await call(`${API}/sites/${site.id}/privacy/reapply`, json({ cursor }))).json();
      expect(r.unreadable).toBe(0);
      identities += r.erased.identities;
      cursor = r.cursor;
    } while (cursor);
    expect(identities).toBe(1);
    expect(await count("web_visitors")).toBe(0);
    expect(await first("SELECT email, customer_id, visitor_id FROM payments")).toEqual({ email: null, customer_id: null, visitor_id: null });
    expect(await first("SELECT id FROM web_sessions WHERE visitor_id = ?", VISITOR)).toBeNull();
  });

  it("says how in the manifest, for whoever finds a backup later", () => {
    expect(manifest({}, false)).toMatchObject({ version: BACKUP_VERSION, restore: expect.stringContaining("scripts/restore-backup.ts") });
  });
});

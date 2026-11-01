import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BACKUP_TABLE_NAMES, BACKUP_TABLES, NOT_BACKED_UP, scheduledBackup, type TableSpec } from "../src/worker/backup";
import { API, call, json, resetData } from "./helpers";
import { addUser, adminCall } from "./people";

beforeEach(resetData);

/** Every column, of every table, by table. */
async function schema(): Promise<Map<string, string[]>> {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const out = new Map<string, string[]>();
  for (const { name } of results) {
    // Cloudflare's own tables can't be read.
    if (name.startsWith("_cf_") || name.startsWith("sqlite_")) continue;
    const cols = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
    out.set(name, cols.results.map((c) => c.name));
  }
  return out;
}

/** Columns known to hold no secret, per table; anything else must be listed as secret or personal in BACKUP_TABLES. */
const SAFE_SECRETLIKE = /hash|secret|epoch|token|salt|key|password/i;

describe("what a backup holds", () => {
  it("covers every table, or leaves it out on purpose", async () => {
    const tables = [...(await schema()).keys()].filter((t) => !t.startsWith("sqlite_") && !t.startsWith("_cf_"));
    const unclassified = tables.filter((t) => !(BACKUP_TABLE_NAMES as string[]).includes(t) && !(NOT_BACKED_UP as readonly string[]).includes(t));
    expect(unclassified).toEqual([]);
  });

  it("lists every secret-looking column as secret, personal or known safe", async () => {
    const known = new Set(["preview_images.key", "settings.key", "api_keys.id", "payments.order_ref", "payments.ref", "link_clicks.ref", "payment_connections.webhook_secret_ref", "payment_connections.api_key_ref"]);
    const s = await schema();
    const missing: string[] = [];
    for (const table of BACKUP_TABLE_NAMES) {
      const spec: TableSpec = BACKUP_TABLES[table];
      for (const col of s.get(table) ?? []) {
        if (!SAFE_SECRETLIKE.test(col)) continue;
        if (spec.secret?.includes(col) || spec.personal?.includes(col) || known.has(`${table}.${col}`)) continue;
        missing.push(`${table}.${col}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("never sends a password hash, even inside link history", async () => {
    await call(`${API}/links`, json({ slug: "locked", target: "https://example.com/", password: "a-long-secret-1" }));
    const links = await (await adminCall("", "/backup/links")).json<{ rows: Record<string, unknown>[] }>();
    expect(links.rows[0]).not.toHaveProperty("password_hash");
    const versions = await (await adminCall("", "/backup/link_versions")).json<{ rows: { snapshot: string }[] }>();
    expect(versions.rows.length).toBeGreaterThan(0);
    for (const v of versions.rows) expect(v.snapshot).not.toContain("password_hash");
    const users = await adminCall("", "/backup/settings");
    expect(await users.text()).not.toContain("session_epoch");
  });

  it("leaves out secrets kept as settings rows: generated secrets, visitor salts, logged-out sessions", async () => {
    await env.DB.batch(
      [
        ["generated_session_secret", "generated-secret-value"],
        ["generated_visitor_salt", "generated-salt-value"],
        ["visitor_salt:2026-11-01", "daily-salt-value"],
        ["revoked_session:abc", "1"],
        ["default_utm", "utm_source=x"],
      ].map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(k, v)),
    );
    const text = await (await adminCall("", "/backup/settings")).text();
    for (const secret of ["generated-secret-value", "generated-salt-value", "daily-salt-value", "revoked_session:"]) expect(text).not.toContain(secret);
    expect(text).toContain("default_utm");
  });

  it("includes people's details only when asked, and only for people who may see revenue", async () => {
    await env.DB.prepare("INSERT INTO sites (id, name, domains, created_at, updated_at) VALUES ('st_1', 'Shop', '[\"shop.example.com\"]', 1, 1)").run();
    await env.DB.prepare("INSERT INTO web_visitors (site_id, id, first_seen, email) VALUES ('st_1', 'v1', 1, 'buyer@example.com')").run();
    expect((await (await adminCall("", "/backup/web_visitors")).json<{ rows: unknown[] }>()).rows).toEqual([]);
    expect(JSON.stringify(await (await adminCall("", "/backup/web_visitors?personal=1")).json())).toContain("buyer@example.com");

    await addUser("admin2@example.com", "admin", []);
    // Admins have every permission, so check a non-admin is refused the whole backup.
    await addUser("editor@example.com", "user", ["links.edit", "stats.view"]);
    expect((await adminCall("editor@example.com", "/backup/links")).status).toBe(403);
    // A script's key can't read it either.
    expect((await call(`${API}/backup/links`, { headers: json({}).headers })).status).toBe(403);
  });
});

/** Just enough of an R2 bucket for the backup job. */
function memoryBucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string) => void objects.set(key, value),
      list: async ({ prefix, delimiter }: { prefix: string; delimiter?: string }) => {
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        if (!delimiter) return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [] };
        const prefixes = [...new Set(keys.map((k) => prefix + k.slice(prefix.length).split(delimiter)[0] + delimiter))];
        return { objects: [], delimitedPrefixes: prefixes };
      },
      delete: async (keys: string[]) => keys.forEach((k) => objects.delete(k)),
    } as unknown as R2Bucket,
  };
}

describe("the weekly copy to R2", () => {
  it("resumes across runs, writes a manifest, and keeps the newest eight", async () => {
    await call(`${API}/links`, json({ slug: "a", target: "https://example.com/" }));
    const { objects, bucket } = memoryBucket();
    // Old backups to prune.
    for (let i = 0; i < 9; i++) objects.set(`backups/2026-01-0${i}T04-00/manifest.json`, "{}");
    const sunday = new Date("2026-11-01T04:00:00Z");
    const e = { ...env, BACKUPS: bucket } as Env;
    const first = await scheduledBackup(e, sunday, 10);
    expect(first).toMatchObject({ done: false });
    let runs = 1;
    let res = first;
    while (!res?.done && runs < 20) {
      res = await scheduledBackup(e, new Date(sunday.getTime() + runs * 30 * 60_000), 10);
      runs++;
    }
    expect(res?.done).toBe(true);
    const id = "2026-11-01T04-00";
    expect(JSON.parse(objects.get(`backups/${id}/manifest.json`)!)).toMatchObject({ format: "shorthop-backup", tables: { links: 1 } });
    expect(objects.get(`backups/${id}/links/00000.json`)).toContain("example.com");
    const folders = new Set([...objects.keys()].map((k) => k.split("/")[1]));
    expect(folders.size).toBe(8);
    expect(folders.has(id)).toBe(true);
  });

  it("does nothing without a bucket", async () => {
    expect(await scheduledBackup(env as Env, new Date("2026-11-01T04:00:00Z"), 40)).toBeNull();
  });
});

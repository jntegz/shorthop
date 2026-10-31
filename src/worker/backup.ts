// A full backup of the workspace's data, a table at a time, for the admin to
// zip in the browser (Settings → Backup) or for the weekly copy to R2. Secrets
// never leave: password and key hashes, encrypted secrets, session epochs and
// the daily visitor salts are dropped, and link history is scrubbed of
// passwords. People's details (emails, customer ids, visitor ids) are only
// included when asked for, by someone who may see revenue.
//
// Every column of every table must be classified here; test/backup.test.ts
// fails on a new column that isn't, so a new secret can't slip into backups.

import { getSetting, nowSec, setSettingStmt } from "./db";

export interface TableSpec {
  /** ORDER BY for stable paging (the primary key). */
  order: string;
  /** Never exported. */
  secret?: readonly string[];
  /** Exported only with people's details. */
  personal?: readonly string[];
  /** The whole table is people's details. */
  personalTable?: boolean;
  /** Rows left out (SQL). */
  where?: string;
}

/** Tables in a backup, in restore order. Tables not listed (login lockouts, delivery logs, raw webhook ids) aren't backed up. */
export const BACKUP_TABLES = {
  links: { order: "domain, slug", secret: ["password_hash"] },
  link_versions: { order: "id" },
  daily_stats: { order: "date, domain, slug, country, device, source" },
  daily_dims: { order: "date, domain, slug, dim, value" },
  settings: { order: "key", where: "key != 'session_epoch' AND key NOT LIKE 'visitor_salt:%'" },
  target_checks: { order: "target" },
  preview_images: { order: "key" },
  utm_presets: { order: "id" },
  webhooks: { order: "id", secret: ["secret"] },
  link_milestones: { order: "domain, slug" },
  users: { order: "email", secret: ["password_hash", "session_epoch", "invite_hash", "reset_hash"] },
  api_keys: { order: "id", secret: ["hash"] },
  stat_shares: { order: "id", secret: ["secret_hash", "secret_enc", "password_hash"] },
  sites: { order: "id" },
  web_sessions: { order: "id", personal: ["visitor_id"] },
  web_visitors: { order: "site_id, id", personalTable: true },
  payment_connections: { order: "id", secret: ["webhook_secret", "api_key"] },
  payments: { order: "id", personal: ["email", "customer_id", "visitor_id"] },
  subscriptions: { order: "id", personal: ["customer_id"] },
  fx_rates: { order: "date, currency" },
  funnels: { order: "id" },
  site_spikes: { order: "site_id, source, detected_at" },
  web_daily_events: { order: "site_id, day, kind, name" },
  privacy_requests: { order: "id" },
  link_clicks: { order: "ref" },
} as const satisfies Record<string, TableSpec>;

export type BackupTable = keyof typeof BACKUP_TABLES;
export const BACKUP_TABLE_NAMES = Object.keys(BACKUP_TABLES) as BackupTable[];

/** Tables kept out of backups on purpose (checked by the test, like the columns). */
export const NOT_BACKED_UP = ["auth_failures", "login_events", "webhook_deliveries", "payment_events", "payment_claims", "d1_migrations", "_cf_KV", "sqlite_sequence"] as const;

export const BACKUP_PAGE = 1000;

/** One page of a table, as plain objects without secrets. */
export async function backupPage(db: D1Database, table: BackupTable, offset: number, opts: { personal: boolean }): Promise<{ rows: Record<string, unknown>[]; next: number | null }> {
  const spec: TableSpec = BACKUP_TABLES[table];
  if (spec.personalTable && !opts.personal) return { rows: [], next: null };
  const { results } = await db
    .prepare(`SELECT * FROM ${table}${spec.where ? ` WHERE ${spec.where}` : ""} ORDER BY ${spec.order} LIMIT ${BACKUP_PAGE} OFFSET ?1`)
    .bind(offset)
    .all<Record<string, unknown>>();
  const drop = [...(spec.secret ?? []), ...(opts.personal ? [] : (spec.personal ?? []))];
  const rows = results.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const col of drop) delete out[col];
    // A version's snapshot holds the link as it was, password hash included.
    if (table === "link_versions" && typeof out.snapshot === "string") out.snapshot = scrubSnapshot(out.snapshot);
    return out;
  });
  return { rows, next: results.length === BACKUP_PAGE ? offset + BACKUP_PAGE : null };
}

function scrubSnapshot(json: string): string {
  try {
    const s = JSON.parse(json) as Record<string, unknown>;
    delete s.password_hash;
    return JSON.stringify(s);
  } catch {
    return "{}";
  }
}

// ---- The weekly copy to R2 ------------------------------------------------------------------------

/** Backups kept in the bucket; older ones are deleted. */
const KEEP = 8;
const JOB_KEY = "backup_job";

interface Job {
  /** "2026-11-01T04-00", the backup's folder. */
  id: string;
  table: number;
  offset: number;
  counts: Record<string, number>;
  startedAt: number;
}

/** The half-hourly cron's Sunday slots from 04:00 to 07:30 UTC copy the backup to R2 (when BACKUPS is bound). */
export function isBackupRun(now: Date): boolean {
  return now.getUTCDay() === 0 && now.getUTCHours() >= 4 && now.getUTCHours() < 8;
}

type BackupEnv = Env & { BACKUPS?: R2Bucket };

/**
 * Copies the next pages of the backup to R2: as many as the plan's call budget
 * allows (each page is a D1 read and an R2 write), carrying on in the next
 * slot. A new backup starts with the first Sunday slot; once complete, a
 * manifest is written and backups past the newest eight are removed. People's
 * details aren't included, as in a download without them.
 */
export async function scheduledBackup(env: BackupEnv, now: Date, budget: number): Promise<{ done: boolean; pages: number } | null> {
  const bucket = env.BACKUPS;
  if (!bucket) return null;
  const saved = await getSetting(env.DB, JOB_KEY);
  let job: Job | null = saved ? (JSON.parse(saved) as Job) : null;
  const firstSlot = now.getUTCHours() === 4 && now.getUTCMinutes() < 30;
  // A job left from an earlier week (or none at all) starts over in the first slot.
  if (!job || (firstSlot && nowSec() - job.startedAt > 3600)) {
    if (!firstSlot && !job) return { done: true, pages: 0 };
    job = { id: now.toISOString().slice(0, 16).replace(":", "-"), table: 0, offset: 0, counts: {}, startedAt: nowSec() };
  }
  let pages = 0;
  // Two calls a page; keep a few for the job's own bookkeeping.
  while (job.table < BACKUP_TABLE_NAMES.length && (pages + 1) * 2 + 4 <= budget) {
    const table = BACKUP_TABLE_NAMES[job.table]!;
    const page = await backupPage(env.DB, table, job.offset, { personal: false });
    if (page.rows.length || job.offset === 0) {
      await bucket.put(`backups/${job.id}/${table}/${String(job.offset / BACKUP_PAGE).padStart(5, "0")}.json`, JSON.stringify(page.rows), { httpMetadata: { contentType: "application/json" } });
    }
    pages++;
    job.counts[table] = (job.counts[table] ?? 0) + page.rows.length;
    if (page.next === null) {
      job.table++;
      job.offset = 0;
    } else job.offset = page.next;
  }
  if (job.table < BACKUP_TABLE_NAMES.length) {
    await env.DB.batch([setSettingStmt(env.DB, JOB_KEY, JSON.stringify(job))]);
    return { done: false, pages };
  }
  await bucket.put(`backups/${job.id}/manifest.json`, JSON.stringify(manifest(job.counts, false, new Date(job.startedAt * 1000))), { httpMetadata: { contentType: "application/json" } });
  await env.DB.batch([setSettingStmt(env.DB, "backup_last", JSON.stringify({ id: job.id, at: nowSec(), rows: Object.values(job.counts).reduce((a, b) => a + b, 0) })), env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(JOB_KEY)]);
  await pruneBackups(bucket);
  return { done: true, pages };
}

async function pruneBackups(bucket: R2Bucket): Promise<void> {
  const listed = await bucket.list({ prefix: "backups/", delimiter: "/" });
  const folders = listed.delimitedPrefixes.sort();
  for (const folder of folders.slice(0, Math.max(0, folders.length - KEEP))) {
    const objects = await bucket.list({ prefix: folder });
    if (objects.objects.length) await bucket.delete(objects.objects.map((o) => o.key));
  }
}

/** What a backup holds, written first in the ZIP and last in R2. */
export function manifest(counts: Record<string, number>, personal: boolean, at = new Date()) {
  return {
    format: "shorthop-backup",
    version: 1,
    createdAt: at.toISOString(),
    personal,
    tables: counts,
    restore:
      "Links and their settings: import links.json (Import → a file). Everything: see docs/SETUP.md, \"Restore a backup\". Secrets (passwords, API keys, webhook and payment secrets) are never in a backup: set them again.",
  };
}

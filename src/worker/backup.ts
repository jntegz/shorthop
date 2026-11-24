// A full backup of the workspace's data, a table at a time, for the admin to
// zip in the browser (Settings → Backup) or for the weekly copy to R2. Secrets
// never leave: password and key hashes, encrypted secrets, session epochs, the
// generated session secret and visitor salts are dropped, and link history is scrubbed of
// passwords. Customers' and visitors' details (emails, customer ids, visitor ids)
// are only included when asked for, by someone who may see revenue. Your team's
// emails and names are always in: the users table, and who did what in link
// history, shares, API keys and privacy requests. Restoring one is
// scripts/restore-backup.ts, with src/shared/backup-restore.ts.
//
// Every column of every table must be classified here; test/backup.test.ts
// fails on a new column that isn't, so a new secret can't slip into backups.

import { BACKUP_VERSION } from "../shared/backup-restore";
import { getSetting, nowSec, setSettingStmt } from "./db";

export interface TableSpec {
  /** The primary key: pages follow it, so a deep page costs what the first one does. */
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

/**
 * Tables in a backup, in restore order. What can't be rebuilt and stays small
 * comes first, so a backup too big for its runs still holds it; the tables that
 * grow with traffic come last, web_sessions at the very end. No table refers to
 * another, so any order restores. Tables not listed (login lockouts, delivery
 * logs, raw webhook ids) aren't backed up.
 */
export const BACKUP_TABLES = {
  links: { order: "domain, slug", secret: ["password_hash"] },
  // Secrets kept as settings rows: the session epoch, daily visitor salts, the SESSION_SECRET and
  // VISITOR_SALT a Deploy to Cloudflare install generates (src/worker/secrets.ts), and logged-out sessions.
  settings: {
    order: "key",
    where:
      "key NOT IN ('session_epoch', 'generated_session_secret', 'generated_visitor_salt') AND substr(key, 1, 13) != 'visitor_salt:' AND substr(key, 1, 16) != 'revoked_session:' AND substr(key, 1, 12) != 'owner_epoch:'",
  },
  users: { order: "email", secret: ["password_hash", "session_epoch", "invite_hash", "reset_hash"] },
  api_keys: { order: "id", secret: ["hash"] },
  webhooks: { order: "id", secret: ["secret"] },
  stat_shares: { order: "id", secret: ["secret_hash", "secret_enc", "password_hash"] },
  utm_presets: { order: "id" },
  sites: { order: "id" },
  funnels: { order: "id" },
  payment_connections: { order: "id", secret: ["webhook_secret", "api_key"] },
  payments: { order: "id", personal: ["email", "customer_id", "visitor_id"] },
  subscriptions: { order: "id", personal: ["customer_id"] },
  privacy_requests: { order: "id" },
  // Keyed hashes only: what a restore has to erase again (src/worker/web/erasure.ts).
  erasure_ledger: { order: "site_id, kind, hash" },
  fx_rates: { order: "date, currency" },
  link_milestones: { order: "domain, slug" },
  target_checks: { order: "target" },
  preview_images: { order: "key" },
  link_versions: { order: "id" },
  link_clicks: { order: "ref" },
  // Advanced tracking's click log: people's details as a whole; IP addresses never leave, not even encrypted.
  tracked_clicks: { order: "id", personalTable: true, secret: ["ip_enc", "ip_key"] },
  tracked_click_details: { order: "click_id", personalTable: true },
  site_spikes: { order: "site_id, source, detected_at" },
  web_daily_events: { order: "site_id, day, kind, name" },
  web_visitors: { order: "site_id, id", personalTable: true },
  daily_stats: { order: "date, domain, slug, country, device, source" },
  daily_dims: { order: "date, domain, slug, dim, value" },
  web_sessions: { order: "id", personal: ["visitor_id"] },
} as const satisfies Record<string, TableSpec>;

export type BackupTable = keyof typeof BACKUP_TABLES;
export const BACKUP_TABLE_NAMES = Object.keys(BACKUP_TABLES) as BackupTable[];

/** Tables kept out of backups on purpose (checked by the test, like the columns). */
// Two-factor sign-in is all secrets (authenticator keys, passkeys, recovery code hashes): after a restore, people set it up again.
export const NOT_BACKED_UP = ["auth_failures", "login_events", "auth_factors", "recovery_codes", "auth_challenges", "webhook_deliveries", "payment_events", "payment_claims", "payment_links", "payment_anomalies", "d1_migrations", "_cf_KV", "sqlite_sequence"] as const;

export const BACKUP_PAGE = 1000;

export class BadBackupCursor extends Error {
  override message = "That isn't a position in this table.";
}

/** Where a page ended: the key of its last row, as JSON. */
function pageAfter(columns: string[], cursor: string): unknown[] {
  let key: unknown;
  try {
    key = JSON.parse(cursor);
  } catch {
    key = null;
  }
  if (!Array.isArray(key) || key.length !== columns.length || !key.every((v) => typeof v === "string" || typeof v === "number")) throw new BadBackupCursor();
  return key;
}

/**
 * One page of a table, as plain objects without secrets. `next` is the page after
 * it. Pages go by primary key rather than OFFSET, which would read every row before
 * the page again: on a large table that alone uses up D1 Free's 5 million rows a day.
 */
export async function backupPage(db: D1Database, table: BackupTable, cursor: string | null, opts: { personal: boolean }): Promise<{ rows: Record<string, unknown>[]; next: string | null }> {
  const spec: TableSpec = BACKUP_TABLES[table];
  if (spec.personalTable && !opts.personal) return { rows: [], next: null };
  const columns = spec.order.split(", ");
  const after = cursor === null ? [] : pageAfter(columns, cursor);
  const where = [...(spec.where ? [`(${spec.where})`] : []), ...(after.length ? [`(${columns.join(", ")}) > (${columns.map((_, i) => `?${i + 1}`).join(", ")})`] : [])];
  const { results } = await db
    .prepare(`SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${spec.order} LIMIT ${BACKUP_PAGE}`)
    .bind(...after)
    .all<Record<string, unknown>>();
  const drop = [...(spec.secret ?? []), ...(opts.personal ? [] : (spec.personal ?? []))];
  const rows = results.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const col of drop) delete out[col];
    // Not the hash, but that there was one: a restore must not leave such a link open.
    if (table === "links" && r.password_hash) out.password_protected = 1;
    // A version's snapshot holds the link as it was, password hash included.
    if (table === "link_versions" && typeof out.snapshot === "string") out.snapshot = scrubSnapshot(out.snapshot);
    return out;
  });
  const last = results.length === BACKUP_PAGE ? results.at(-1)! : null;
  return { rows, next: last ? JSON.stringify(columns.map((c) => last[c])) : null };
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
export const BACKUP_JOB_KEY = "backup_job";
export const BACKUP_LAST_KEY = "backup_last";
const JOB_KEY = BACKUP_JOB_KEY;
/** Which table order and paging a job's position is in. A job from another one starts over. */
const JOB_ORDER = 3;
/** A job this old is abandoned, and the next Sunday starts afresh. */
const JOB_MAX_AGE_SEC = 35 * 86400;

export interface BackupJob {
  /** "2026-11-01T04-00", the backup's folder. */
  id: string;
  table: number;
  /** Where the table's next page starts; null at its beginning. */
  cursor: string | null;
  /** The next page's number within the table, which names its file. */
  page: number;
  counts: Record<string, number>;
  startedAt: number;
  order?: number;
  /** Why the last run stopped early, until a run gets through. */
  error?: string;
}
type Job = BackupJob;

/**
 * The half-hourly cron's slots from 04:00 to 07:30 UTC can copy the backup to R2
 * (when BACKUPS is bound); backupPending says which still have to. A new backup
 * starts on Sunday; one that didn't finish carries on the following days.
 */
export function isBackupRun(now: Date): boolean {
  return now.getUTCHours() >= 4 && now.getUTCHours() < 8;
}

type BackupEnv = Env & { BACKUPS?: R2Bucket };

/** Sunday's first slot starts a backup; later ones only carry on one that isn't finished. */
const isFirstSlot = (now: Date) => now.getUTCDay() === 0 && now.getUTCHours() === 4 && now.getUTCMinutes() < 30;

/**
 * Whether a backup slot has work to do: a new backup to start, or one to
 * carry on. False once the week's backup is complete, so the slots after it
 * go back to destination checks and webhook deliveries. A failed read counts
 * as nothing to do, for the same reason.
 */
export async function backupPending(env: Env, now: Date): Promise<boolean> {
  if (isFirstSlot(now)) return true;
  try {
    return (await getSetting(env.DB, JOB_KEY)) !== null;
  } catch (err) {
    console.error(JSON.stringify({ message: "backup job read failed", error: String(err) }));
    return false;
  }
}

/**
 * Copies the next pages of the backup to R2: as many as the plan's call budget
 * allows (each page is a D1 read and an R2 write), carrying on in the next
 * slot, the next day and, for a very large database, the next week: it resumes
 * where it stopped instead of starting over and never reaching the last tables.
 * A new backup starts with the first Sunday slot when none is unfinished; once
 * complete, a manifest is written and backups past the newest eight are removed.
 * Customers' details aren't included, as in a download without them. System
 * status reports a backup that is late or stuck (src/worker/health.ts).
 */
export async function scheduledBackup(env: BackupEnv, now: Date, budget: number): Promise<{ done: boolean; pages: number } | null> {
  const bucket = env.BACKUPS;
  if (!bucket) return null;
  const saved = await getSetting(env.DB, JOB_KEY);
  let job: Job | null = saved ? (JSON.parse(saved) as Job) : null;
  // Started by a version with another table order: its position means nothing now.
  const unusable = job !== null && job.order !== JOB_ORDER;
  const abandoned = job !== null && nowSec() - job.startedAt > JOB_MAX_AGE_SEC;
  if (!job && !isFirstSlot(now)) return { done: true, pages: 0 };
  if (!job || unusable || abandoned) job = { id: now.toISOString().slice(0, 16).replace(":", "-"), table: 0, cursor: null, page: 0, counts: {}, startedAt: nowSec(), order: JOB_ORDER };
  let pages = 0;
  try {
    // Two calls a page; keep a few for the job's own bookkeeping.
    while (job.table < BACKUP_TABLE_NAMES.length && (pages + 1) * 2 + 4 <= budget) {
      const table = BACKUP_TABLE_NAMES[job.table]!;
      const page = await backupPage(env.DB, table, job.cursor, { personal: false });
      if (page.rows.length || job.page === 0) {
        await bucket.put(`backups/${job.id}/${table}/${String(job.page).padStart(5, "0")}.json`, JSON.stringify(page.rows), { httpMetadata: { contentType: "application/json" } });
      }
      pages++;
      job.counts[table] = (job.counts[table] ?? 0) + page.rows.length;
      if (page.next === null) {
        job.table++;
        job.cursor = null;
        job.page = 0;
      } else {
        job.cursor = page.next;
        job.page++;
      }
    }
    delete job.error;
    if (job.table < BACKUP_TABLE_NAMES.length) {
      await env.DB.batch([setSettingStmt(env.DB, JOB_KEY, JSON.stringify(job))]);
      return { done: false, pages };
    }
  } catch (err) {
    // Keep the place reached and say why: the next slot carries on, and System status shows it.
    job.error = String(err).slice(0, 200);
    await env.DB.batch([setSettingStmt(env.DB, JOB_KEY, JSON.stringify(job))]);
    throw err;
  }
  await bucket.put(`backups/${job.id}/manifest.json`, JSON.stringify(manifest(job.counts, false, new Date(job.startedAt * 1000))), { httpMetadata: { contentType: "application/json" } });
  await env.DB.batch([setSettingStmt(env.DB, BACKUP_LAST_KEY, JSON.stringify({ id: job.id, at: nowSec(), rows: Object.values(job.counts).reduce((a, b) => a + b, 0) })), env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(JOB_KEY)]);
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
    version: BACKUP_VERSION,
    createdAt: at.toISOString(),
    personal,
    tables: counts,
    team: "Holds your team's emails and names (users, API keys, and who changed what in link history, shares and privacy requests), whether or not customer details are included. Keep it as safely as the workspace.",
    restore:
      "Links and their settings: import links.json (Import → a file). Everything: scripts/restore-backup.ts, see docs/SETUP.md, \"Restore a backup\". Secrets (passwords, API keys, webhook and payment secrets) are never in a backup: set them again.",
  };
}

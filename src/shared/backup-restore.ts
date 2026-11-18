// Turns the rows of a backup into SQL (scripts/restore-backup.ts, docs/SETUP.md#restore).
//
// A backup leaves secrets out, and without people's details visitor ids too
// (src/worker/backup.ts). Some of those columns are required, so a restore fills
// them with values that can't open anything: what depended on a secret comes back
// switched off, for the owner to set up again. A visit whose visitor isn't in the
// backup comes back belonging to nobody, one anonymous visitor per visit.

export type BackupRow = Record<string, unknown>;

/** manifest.json's version. From 2, links say whether they had a password. */
export const BACKUP_VERSION = 2;

/** A visitor id that belongs to nobody: matching and identify ignore it (ERASED_VISITOR_PREFIX in src/worker/revenue/match.ts). */
export const NOBODY_VISITOR_PREFIX = "erased_";

/** Never the output of a hash or of encryption, so nothing can match or decrypt it. */
const NO_SECRET = "restored-without-secret";

/** Settings about the old install's own backup job: the restored one starts afresh. */
const SKIPPED_SETTINGS = new Set(["backup_job", "backup_last"]);

export interface RestoreReport {
  /** "domain/slug" of links that had a password: turned off. */
  passwordLinks: string[];
  people: number;
  apiKeys: number;
  webhooks: number;
  shares: number;
  /** Visits whose visitor isn't in the backup. */
  anonymousVisits: number;
}

export interface RestoreContext {
  now: number;
  /** A random id, such as crypto.randomUUID(). */
  random: () => string;
  report: RestoreReport;
}

export function newRestoreContext(now: number, random: () => string): RestoreContext {
  return { now, random, report: { passwordLinks: [], people: 0, apiKeys: 0, webhooks: 0, shares: 0, anonymousVisits: 0 } };
}

const RULES: Record<string, (row: BackupRow, c: RestoreContext) => BackupRow | null> = {
  // A link that had a password must not come back open to anyone with the address.
  links: ({ password_protected: hadPassword, ...row }, c) => {
    if (!hadPassword) return row;
    c.report.passwordLinks.push(`${String(row.domain)}/${String(row.slug)}`);
    return { ...row, active: 0 };
  },
  settings: (row) => (SKIPPED_SETTINGS.has(String(row.key)) ? null : row),
  // A new epoch: no session from before the restore fits it. They get a password through a new invite.
  users: (row, c) => {
    c.report.people++;
    return { ...row, session_epoch: c.random() };
  },
  api_keys: (row, c) => {
    c.report.apiKeys++;
    return { ...row, hash: `${NO_SECRET}:${String(row.id)}`, expires_at: c.now };
  },
  // The stored value can't be decrypted, so System status and the webhook's page ask for a new secret.
  webhooks: (row, c) => {
    c.report.webhooks++;
    return { ...row, secret: NO_SECRET, active: 0 };
  },
  stat_shares: (row, c) => {
    c.report.shares++;
    return { ...row, secret_hash: `${NO_SECRET}:${String(row.id)}`, secret_enc: NO_SECRET, revoked_at: row.revoked_at ?? c.now };
  },
  web_sessions: (row, c) => {
    if (row.visitor_id) return row;
    c.report.anonymousVisits++;
    return { ...row, visitor_id: `${NOBODY_VISITOR_PREFIX}${c.random().replace(/-/g, "").slice(0, 18)}` };
  },
};

/** The row to insert for a row of a backup, or null to leave it out. */
export function restoreRow(table: string, row: BackupRow, c: RestoreContext): BackupRow | null {
  return RULES[table] ? RULES[table](row, c) : row;
}

function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`"${name}" isn't a table or column name.`);
  return `"${name}"`;
}

function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return v.split("\0").map((part) => `'${part.replace(/'/g, "''")}'`).join(" || char(0) || ");
  throw new Error(`A backup holds only text and numbers, not ${JSON.stringify(v)?.slice(0, 80)}.`);
}

/** One row as SQL. It replaces a row with the same key, so a restore can be run again. */
export function insertSql(table: string, row: BackupRow): string {
  const cols = Object.keys(row);
  return `INSERT OR REPLACE INTO ${identifier(table)} (${cols.map(identifier).join(", ")}) VALUES (${cols.map((c) => sqlValue(row[c])).join(", ")});`;
}

/** Last of a restore: sessions from before it stop working (logged-out ones aren't in a backup). */
export const newEpochSql = (c: RestoreContext): string => insertSql("settings", { key: "session_epoch", value: c.random() });

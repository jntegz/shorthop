// Turns a backup into SQL files to load into a freshly migrated database. It reads
// local files and writes local files; loading them is up to you (docs/SETUP.md#restore).
//
//   npx tsx scripts/restore-backup.ts --backup <folder> [--out restore-sql] [--rows-per-file 5000]
//
// <folder> is an unzipped Settings → Backup download (manifest.json, tables/*.json)
// or a backup folder copied from R2 (manifest.json, <table>/00000.json, ...).

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKUP_VERSION, insertSql, newEpochSql, newRestoreContext, restoreRow, type BackupRow } from "../src/shared/backup-restore";
import { args, fail } from "./lib";

/** D1 refuses a longer statement. */
const MAX_STATEMENT = 100_000;

const { flags, opts } = args();
const backup = opts.get("backup");
if (!backup) fail("Usage: npx tsx scripts/restore-backup.ts --backup <folder> [--out restore-sql] [--rows-per-file 5000] [--accept-lost-passwords]");
const dir = resolve(backup);
const out = resolve(opts.get("out") ?? "restore-sql");
const perFile = Number(opts.get("rows-per-file") ?? 5000);
if (!Number.isInteger(perFile) || perFile < 1) fail("--rows-per-file must be a whole number above 0.");

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

if (!existsSync(join(dir, "manifest.json"))) fail(`${dir} has no manifest.json. A backup in R2 gets one when it is complete, so a folder without it isn't a whole backup.`);
const manifest = readJson(join(dir, "manifest.json")) as { format?: string; version?: number; personal?: boolean; tables?: Record<string, number> };
if (manifest.format !== "shorthop-backup" || !manifest.tables) fail(`${join(dir, "manifest.json")} isn't a Shorthop backup's manifest.`);
if ((manifest.version ?? 1) < BACKUP_VERSION && !flags.has("accept-lost-passwords")) {
  fail(
    "This backup was made before 2.0.3, so it doesn't say which links had a password, and they would come back open to anyone with the address. " +
      "Use a newer backup, or run this again with --accept-lost-passwords and set those links' passwords before you deploy.",
  );
}

function rowsOf(table: string): BackupRow[] {
  const zipped = join(dir, "tables", `${table}.json`);
  if (existsSync(zipped)) return readJson(zipped) as BackupRow[];
  const folder = join(dir, table);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => readJson(join(folder, f)) as BackupRow[]);
}

const context = newRestoreContext(Math.floor(Date.now() / 1000), randomUUID);
const statements: string[] = [];
const left: string[] = [];
for (const [table, count] of Object.entries(manifest.tables)) {
  const rows = rowsOf(table);
  if (rows.length !== count) fail(`${table}: the manifest says ${count} rows, the files hold ${rows.length}. Copy the whole backup again.`);
  if (!count) left.push(table);
  for (const row of rows) {
    const restored = restoreRow(table, row, context);
    if (restored) statements.push(insertSql(table, restored));
  }
}
statements.push(newEpochSql(context));

const tooLong = statements.filter((s) => Buffer.byteLength(s) > MAX_STATEMENT).length;
mkdirSync(out, { recursive: true });
const files: string[] = [];
for (let i = 0; i < statements.length; i += perFile) {
  const file = join(out, `restore-${String(files.length + 1).padStart(4, "0")}.sql`);
  writeFileSync(file, `${statements.slice(i, i + perFile).join("\n")}\n`);
  files.push(file);
}

const { report } = context;
console.log(`${statements.length} statements in ${files.length} ${files.length === 1 ? "file" : "files"}, in ${out}. Load them in order:\n`);
for (const f of files) console.log(`  npx wrangler d1 execute <your-db-name> --remote --file=${f}`);
console.log("\nWhat needs you afterwards (docs/SETUP.md#restore):");
if (report.passwordLinks.length) console.log(`- ${report.passwordLinks.length} links had a password and are turned off until you set a new one:\n${report.passwordLinks.map((l) => `    ${l}`).join("\n")}`);
if (report.people) console.log(`- ${report.people} people need a new invite to choose a password.`);
if (report.apiKeys) console.log(`- ${report.apiKeys} API keys no longer work: create new ones.`);
if (report.webhooks) console.log(`- ${report.webhooks} webhooks are turned off: make a new secret for each, then turn it on.`);
if (report.shares) console.log(`- ${report.shares} shared statistics pages are revoked: share again.`);
if (report.anonymousVisits) console.log(`- ${report.anonymousVisits} visits have no visitor in this backup and come back as one anonymous visitor each, so older visitor counts go up.`);
if (!manifest.personal) console.log("- This backup has no customer emails or ids: payments and subscriptions come back without them, and identified visitors don't come back.");
if (tooLong) console.log(`- ${tooLong} statements are longer than D1's ${MAX_STATEMENT.toLocaleString("en")} bytes and will be refused.`);
if (left.length) console.log(`- Empty in this backup: ${left.join(", ")}.`);
console.log("- Then: put kv.json back if you have it, Republish all links, and Re-apply erasures on every website.");

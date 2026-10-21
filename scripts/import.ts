// Imports an export file through the token API (works before Access is set up).
//
//   SHORTHOP_TOKEN=... npx tsx scripts/import.ts --base https://<admin host> \
//     [--data data/links.json] [--default-domain sh.example] [--overwrite] [--dry-run]
//
// Each row keeps its own domain; rows without one go to --default-domain
// (the primary short domain when omitted). Existing slugs are skipped;
// --overwrite replaces their targets and needs API_TOKEN_SCOPE="full".

import { mkdir, writeFile } from "node:fs/promises";
import type { ImportResult } from "../src/shared/types";
import { args, fail, readExport } from "./lib";

const { flags, opts } = args();
const base = (opts.get("base") ?? fail("Pass --base, e.g. --base https://sh.example")).replace(/\/+$/, "");
const token = process.env.SHORTHOP_TOKEN ?? fail("Set SHORTHOP_TOKEN to the Worker's API_TOKEN secret.");
const rows = await readExport(opts.get("data") ?? "data/links.json");
const dryRun = flags.has("dry-run");
const mode = flags.has("overwrite") ? "overwrite" : "skip";
const defaultDomain = opts.get("default-domain");

const total: ImportResult = { dryRun, created: 0, updated: 0, skipped: 0, errors: 0, rows: [] };
for (let i = 0; i < rows.length; i += 100) {
  const chunk = rows.slice(i, i + 100);
  const res = await fetch(`${base}/api/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rows: chunk, mode, dryRun, defaultDomain }),
  });
  if (!res.ok) fail(`Import failed at row ${i}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const r = (await res.json()) as ImportResult;
  total.created += r.created;
  total.updated += r.updated;
  total.skipped += r.skipped;
  total.errors += r.errors;
  total.rows.push(...r.rows);
  process.stdout.write(`\r${Math.min(i + 100, rows.length)}/${rows.length}`);
}

await mkdir("data", { recursive: true });
await writeFile("data/import-report.json", JSON.stringify(total, null, 2));
console.log(`\n\n${dryRun ? "Dry run: " : ""}${total.created} created, ${total.updated} updated, ${total.skipped} skipped, ${total.errors} errors`);
for (const r of total.rows.filter((r) => r.status === "error" || r.message)) {
  console.log(`  ${r.status === "error" ? "✖" : "ℹ"} ${r.domain}/${r.slug}: ${r.message}`);
}
console.log("Full report: data/import-report.json");
if (total.errors) process.exit(1);

// Brings a Deploy to Cloudflare copy of shorthop up to this version. The Update
// Shorthop workflow (.github/workflows/update-shorthop.yml) runs it from the new
// version's release, against a checkout of the copy:
//
//   npx tsx scripts/setup/update-copy.ts --target <copy> [--previous <old release>] [--summary <file>] [--dry-run]
//
// Every file of this version is copied over the copy, and files the previous
// version had but this one doesn't are deleted. Not touched: .github/workflows
// (the workflow's token can't write them; the summary lists what changed) and
// anything listed in the copy's .shorthop-keep, one path or glob per line.
// wrangler.toml is merged: this version's config with the owner's values.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { args, fail } from "../lib";
import { BUTTON_FILE, mergeButtonConfig } from "./template";

const REPO = "https://github.com/jntegz/shorthop";
const WORKFLOWS = ".github/workflows/";
const KEEP_FILE = ".shorthop-keep";
/** Never part of a release, even after `npm ci` in it. `.git` is a file in a worktree. */
const SKIP = new Set([".git", "node_modules", "dist", ".wrangler"]);
/** A copy's own files, never in a release: run from a working tree, they must not travel. */
const LOCAL_ONLY = /^(wrangler\.jsonc|\.dev\.vars(?!\.example$).*|\.env.*)$/;

/** Every file under a directory, as forward-slash paths relative to it. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || (dir === root && LOCAL_ONLY.test(entry.name))) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.isFile()) out.push(relative(root, join(dir, entry.name)).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** A .shorthop-keep line as a matcher: "docs/" keeps a folder, * and ** are globs, anything else an exact path. */
export function keepMatcher(text: string): (path: string) => boolean {
  const patterns = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const p = l.replace(/^\/+/, "");
      const glob = p.endsWith("/") ? `${p}**` : p;
      const source = glob
        .split(/(\*\*\/?|\*)/)
        .map((part) => (part === "**" || part === "**/" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      return new RegExp(`^${source}$`);
    });
  return (path) => patterns.some((re) => re.test(path));
}

export interface Plan {
  /** Upstream files written to the copy (new or changed). */
  write: string[];
  /** Files the previous version had, this one doesn't, and the copy still has. */
  remove: string[];
  /** Workflow files that differ, left for the owner. */
  workflows: string[];
  /** Kept by .shorthop-keep although this version changed them. */
  kept: string[];
  /** The merged wrangler.toml, when it differs from the copy's. */
  wrangler: string | null;
}

/** What updating `target` from `source` would change, without changing anything. */
export function planUpdate(source: string, target: string, previous?: string): Plan {
  const keep = existsSync(join(target, KEEP_FILE)) ? keepMatcher(readFileSync(join(target, KEEP_FILE), "utf8")) : () => false;
  const upstream = listFiles(source);
  const upstreamSet = new Set(upstream);
  const read = (root: string, path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path)) : null);
  const plan: Plan = { write: [], remove: [], workflows: [], kept: [], wrangler: null };

  for (const path of upstream) {
    if (path === BUTTON_FILE) continue;
    const ours = read(source, path)!;
    const theirs = read(target, path);
    if (theirs && theirs.equals(ours)) continue;
    if (path.startsWith(WORKFLOWS)) plan.workflows.push(path);
    else if (keep(path)) plan.kept.push(path);
    else plan.write.push(path);
  }
  if (previous) {
    for (const path of listFiles(previous)) {
      if (upstreamSet.has(path) || !existsSync(join(target, path))) continue;
      if (path.startsWith(WORKFLOWS)) plan.workflows.push(path);
      else if (keep(path)) plan.kept.push(path);
      else plan.remove.push(path);
    }
  }

  const own = read(target, BUTTON_FILE)?.toString("utf8");
  const upstreamToml = read(source, BUTTON_FILE)?.toString("utf8");
  if (upstreamToml && !keep(BUTTON_FILE)) {
    const merged = own ? mergeButtonConfig(own, upstreamToml) : upstreamToml;
    if (merged !== own) plan.wrangler = merged;
  }
  return plan;
}

export function applyUpdate(source: string, target: string, plan: Plan): void {
  for (const path of plan.write) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(join(source, path), join(target, path));
  }
  for (const path of plan.remove) rmSync(join(target, path), { force: true });
  if (plan.wrangler !== null) writeFileSync(join(target, BUTTON_FILE), plan.wrangler);
}

const version = (root: string): string => {
  try {
    return String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
};

/** The changelog's section for one version, without its heading. */
export function changelogSection(changelog: string, v: string): string {
  const start = changelog.search(new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\]`, "m"));
  if (start < 0) return "";
  const body = changelog.slice(start).replace(/^[^\n]*\n/, "");
  const end = body.search(/^## \[|^\[[^\]]+\]: /m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

export function summarize(plan: Plan, from: string, to: string, changelog: string): string {
  const list = (paths: string[]) => paths.map((p) => `- \`${p}\``).join("\n");
  const parts = [`## Shorthop ${from} → ${to}`, ""];
  parts.push(`${plan.write.length} files updated, ${plan.remove.length} removed${plan.wrangler !== null ? ", and `wrangler.toml` brought up to date (your ids, routes and vars kept)" : ""}.`);
  parts.push("", `Before merging, read the Upgrading notes in the [changelog](${REPO}/blob/v${to}/CHANGELOG.md).`);
  if (plan.workflows.length) {
    parts.push(
      "",
      "### Workflow files to update by hand",
      "",
      "GitHub doesn't let a workflow change workflow files. Copy these from the release on GitHub (Add file → Upload, or edit and paste):",
      "",
      list(plan.workflows),
      "",
      `They're at ${REPO}/tree/v${to}/.github/workflows.`,
    );
  }
  if (plan.kept.length) parts.push("", "### Kept by `.shorthop-keep`", "", "This version changes them, but your copy keeps its own:", "", list(plan.kept));
  if (plan.remove.length) parts.push("", "### Removed", "", list(plan.remove));
  const notes = changelogSection(changelog, to);
  if (notes) parts.push("", `### What's new in ${to}`, "", notes);
  return `${parts.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags, opts } = args();
  const source = resolve(opts.get("source") ?? fileURLToPath(new URL("../..", import.meta.url)));
  const targetOpt = opts.get("target");
  if (!targetOpt) fail("Usage: tsx scripts/setup/update-copy.ts --target <your copy> [--previous <old release>] [--summary <file>] [--dry-run]");
  const target = resolve(targetOpt);
  if (target === source) fail("--target is this release itself. Point it at your copy of the repository.");
  if (!existsSync(join(target, "package.json"))) fail(`${target} has no package.json: is it a copy of shorthop?`);
  const previous = opts.get("previous");
  if (previous && !existsSync(previous)) fail(`--previous ${previous} doesn't exist.`);

  const from = version(target);
  const to = version(source);
  const plan = planUpdate(source, target, previous ? resolve(previous) : undefined);
  if (!flags.has("dry-run")) applyUpdate(source, target, plan);
  const changelog = existsSync(join(source, "CHANGELOG.md")) ? readFileSync(join(source, "CHANGELOG.md"), "utf8") : "";
  const summary = summarize(plan, from, to, changelog);
  const summaryFile = opts.get("summary");
  if (summaryFile) writeFileSync(summaryFile, summary);
  console.log(summary);
  if (flags.has("dry-run")) console.log(`Dry run: nothing written. Would update:\n${[...plan.write, ...(plan.wrangler !== null ? [BUTTON_FILE] : [])].join("\n")}`);
}

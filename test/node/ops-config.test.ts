// The Wrangler logging settings, `setup -- upgrade` keeping what the owner added,
// the update workflow (its structure, and its steps run against real older copies),
// what the update summary says, and scripts/restore-backup.ts (2.0.3).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { parse as parseToml } from "smol-toml";
import { summarize, type Plan } from "../../scripts/setup/update-copy";
import { buildBranchProblem, configFromText, EXAMPLE_CONFIG, keepOwnSettings, mergeButtonConfig, outdatedProblems, parseJsonc, renderButtonConfig, renderConfig, type SetupConfig } from "../../scripts/setup/template";

const WORKFLOW = readFileSync(new URL("../../.github/workflows/update-shorthop.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const CI = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const OLD_COPY = readFileSync(new URL("./fixtures/wrangler-1.1.1.toml", import.meta.url), "utf8");

type Observability = { enabled: boolean; logs: { enabled: boolean; invocation_logs?: boolean }; traces: { enabled: boolean } };

function assertMinimal(o: Observability): void {
  assert.equal(o.enabled, true);
  assert.equal(o.logs.enabled, true, "the Worker's own logs stay");
  assert.equal(o.logs.invocation_logs, false);
  assert.equal(o.traces.enabled, false);
}

describe("platform logging", () => {
  it("keeps the Worker's logs and turns off invocation logs and traces in every config", () => {
    assertMinimal(parseJsonc(renderConfig(EXAMPLE_CONFIG), "wrangler.jsonc").observability as Observability);
    assertMinimal((parseToml(renderButtonConfig()) as { observability: Observability }).observability);
  });

  it("reaches a copy through the normal update", () => {
    assert.match(OLD_COPY, /\[observability\.traces\]\s+enabled = true/);
    assertMinimal((parseToml(mergeButtonConfig(OLD_COPY)) as unknown as { observability: Observability }).observability);
  });
});

describe("a config from before 2.0.3", () => {
  const REAL: SetupConfig = { ...EXAMPLE_CONFIG, accountId: "a".repeat(32), kvId: "b".repeat(32), d1Id: "00000000-0000-4000-8000-000000000000", shortDomains: ["go.example.net"], digestFrom: "digest@go.example.net", digestTo: "me@example.net" };
  const OLD_LOGGING = `"observability": {
    "enabled": true,
    "logs": { "enabled": true, "head_sampling_rate": 1 },
    "traces": { "enabled": true, "head_sampling_rate": 0.05 }
  }`;
  const withOldLogging = (text: string) => text.replace(/"observability": \{[\s\S]*?\n  \}/, OLD_LOGGING);
  /** What someone following the docs and comments ends up with. */
  const handEdited = withOldLogging(renderConfig(REAL))
    .replace('// "ai": { "binding": "AI" },', '"ai": { "binding": "AI" },')
    .replace('// "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "shorthop-backups" }],', '"r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "my-backups" }],')
    .replace('// , { "name": "PEOPLE_MAIL", "allowed_sender_addresses": ["you@your-domain"] }', ', { "name": "PEOPLE_MAIL", "allowed_sender_addresses": ["people@go.example.net"] }')
    .replace('"KV_CACHE_TTL": "60"', '"KV_CACHE_TTL": "30",\n    "MY_OWN_VAR": "kept"')
    .replace('"workers_dev": false', '"workers_dev": true, "placement": { "mode": "smart" }')
    .replace('"kv_namespaces": [{ "binding": "LINKS", "id": "' + "b".repeat(32) + '" }]', '"kv_namespaces": [{ "binding": "LINKS", "id": "' + "b".repeat(32) + '", "preview_id": "preview" }, { "binding": "EXTRA", "id": "extra" }]')
    .replace('"routes": [\n', '"routes": [\n    { "pattern": "go.example.net/special/*", "zone_name": "example.net" },\n');
  const upgrade = (own: string, change: (c: SetupConfig) => SetupConfig = (c) => c) => keepOwnSettings(renderConfig(change(configFromText(own))), own);
  type Raw = Record<string, any>;

  it("was really written by hand in this test", () => {
    const raw = parseJsonc(handEdited, "own") as Raw;
    assert.deepEqual(raw.ai, { binding: "AI" });
    assert.equal(raw.vars.KV_CACHE_TTL, "30");
    assert.equal(raw.routes.length, 2);
    assert.equal(raw.send_email.length, 2);
    assert.equal(raw.workers_dev, true);
  });

  it("keeps what the owner added, and takes the new version's settings", () => {
    const text = upgrade(handEdited);
    const raw = parseJsonc(text, "upgraded") as Raw;
    assert.deepEqual(raw.r2_buckets, [{ binding: "BACKUPS", bucket_name: "my-backups" }]);
    assert.deepEqual(raw.ai, { binding: "AI" });
    assert.deepEqual(raw.placement, { mode: "smart" });
    assert.equal(raw.vars.KV_CACHE_TTL, "30");
    assert.equal(raw.vars.MY_OWN_VAR, "kept");
    assert.equal(raw.workers_dev, true);
    assert.deepEqual(raw.send_email.map((s: Raw) => s.name), ["DIGEST", "PEOPLE_MAIL"]);
    assert.deepEqual(raw.kv_namespaces, [{ binding: "LINKS", id: "b".repeat(32), preview_id: "preview" }, { binding: "EXTRA", id: "extra" }]);
    assert.deepEqual(raw.routes, [{ pattern: "go.example.net", custom_domain: true }, { pattern: "go.example.net/special/*", zone_name: "example.net" }]);
    assertMinimal(raw.observability);
    assert.deepEqual(outdatedProblems(text), []);
    assert.match(text, /Cloudflare's record of/, "the template's comments stay");
    assert.equal(upgrade(text), text, "upgrading again changes nothing");
  });

  it("keeps the workers.dev admin for a config that had workers_dev on before the setting existed", () => {
    const before = handEdited.replace(/\s*"WORKERS_DEV_ADMIN": "off",/, "");
    assert.equal((parseJsonc(before, "own") as Raw).vars.WORKERS_DEV_ADMIN, undefined);
    const text = upgrade(before);
    assert.equal((parseJsonc(text, "upgraded") as Raw).vars.WORKERS_DEV_ADMIN, "");
    assert.equal(upgrade(text), text, "upgrading again changes nothing");
    const off = before.replace('"workers_dev": true', '"workers_dev": false');
    assert.equal((parseJsonc(upgrade(off), "upgraded") as Raw).vars.WORKERS_DEV_ADMIN, "off");
    assert.equal((parseJsonc(upgrade(handEdited), "upgraded") as Raw).vars.WORKERS_DEV_ADMIN, "off", "an explicit choice stays");
  });

  it("doesn't bring back what the setup just changed", () => {
    const raw = parseJsonc(
      upgrade(handEdited, (c) => ({ ...c, digestProvider: "resend", shortDomains: ["new.example.net"] })),
      "changed",
    ) as Raw;
    assert.deepEqual(raw.send_email.map((s: Raw) => s.name), ["PEOPLE_MAIL"], "the digest's sender went with the provider");
    assert.equal(raw.vars.SHORT_DOMAINS, "new.example.net");
    assert.deepEqual(raw.routes.map((r: Raw) => r.pattern), ["new.example.net", "go.example.net/special/*"]);
  });

  it("leaves a config that needs nothing as it is", () => {
    const text = renderConfig(REAL);
    assert.equal(keepOwnSettings(text, text), text);
  });

  it("keeps invocation logs an owner turned on after the setting existed", () => {
    const own = renderConfig(REAL).replace('"invocation_logs": false', '"invocation_logs": true').replace('"traces": { "enabled": false }', '"traces": { "enabled": true }');
    assert.deepEqual(outdatedProblems(own), [], "a choice, not an old config");
    const raw = parseJsonc(upgrade(own), "own") as Raw;
    assert.equal(raw.observability.logs.invocation_logs, true);
    assert.equal(raw.observability.traces.enabled, true);
  });

  it("stops a plain deploy until the logging settings have been decided", () => {
    const problems = outdatedProblems(withOldLogging(renderConfig(REAL)));
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0]!, /invocation_logs/);
  });
});

describe("the update workflow", () => {
  const [head, updateJob] = WORKFLOW.split("\n  update:\n");

  it("gives no job more than it needs", () => {
    assert.match(WORKFLOW, /^permissions: \{\}$/m);
    const check = head!.slice(head!.indexOf("\n  check:\n"));
    assert.match(check, /permissions:\n\s+contents: read\n/);
    assert.doesNotMatch(check, /: write/);
    assert.match(updateJob!, /contents: write/);
  });

  it("doesn't run the release's code in the job that can write", () => {
    assert.ok(updateJob, "there is an update job");
    assert.doesNotMatch(updateJob!, /cd "?\$RUNNER_TEMP\/new/);
    assert.doesNotMatch(updateJob!, /working-directory:.*\/new/);
    assert.match(updateJob!, /git -C copy archive HEAD/);
    assert.match(updateJob!, /--source "\$RUNNER_TEMP\/new"/);
    for (const m of WORKFLOW.matchAll(/npm ci[^\n]*/g)) assert.match(m[0], /--ignore-scripts/);
  });

  it("hands the token only to the last step, and keeps both modes", () => {
    const tokenLines = updateJob!.split("\n").filter((l) => l.includes("github.token"));
    assert.equal(tokenLines.length, 1);
    assert.ok(updateJob!.indexOf("github.token") > updateJob!.indexOf("name: Commit"));
    assert.match(updateJob!, /core\.hooksPath \/dev\/null/);
    assert.match(updateJob!, /git push origin "HEAD:\$DEFAULT_BRANCH"/);
    assert.match(updateJob!, /gh pr create/);
  });

  it("refuses an older release unless asked, comparing versions properly", () => {
    assert.match(head!, /allow_downgrade:/);
    assert.match(head!, /sort -V/);
    assert.match(head!, /ALLOW_DOWNGRADE" != "true"/);
  });

  it("pins every action to a full commit", () => {
    for (const text of [WORKFLOW, CI]) for (const m of text.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1]!, /@[0-9a-f]{40}$/, m[1]);
  });
});

describe("CI's dependency audit", () => {
  it("still fails on what ships, and only reports on build tools", () => {
    assert.match(CI, /- run: npm audit --omit=dev --audit-level=high/);
    const step = CI.slice(CI.indexOf("Report advisories in build tools"));
    assert.match(step, /if ! npm audit --audit-level=high/);
    assert.match(step, /::warning::/);
  });
});

describe("an update branch in Workers Builds", () => {
  it("doesn't deploy or migrate until it is merged", () => {
    assert.match(buildBranchProblem("shorthop-update-v2.0.3")!, /merge its pull request/);
    for (const branch of ["main", "master", undefined]) assert.equal(buildBranchProblem(branch), null);
  });
});

const REPO = resolve(import.meta.dirname, "../..");
const BASH = process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const TSX = join(REPO, "node_modules/tsx/dist/cli.mjs");
const hasBash = spawnSync(BASH, ["--version"]).status === 0;
const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" });
const hasTag = (tag: string) => git(REPO, "rev-parse", "-q", "--verify", `refs/tags/${tag}`).status === 0;
const slash = (p: string) => p.split("\\").join("/");

/** A step's `run` script, from the workflow as written, seeing the stubs in `stubs` before anything installed. */
function stepScript(name: string, stubs: string): string {
  const lines = WORKFLOW.split("\n");
  let i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `no step "${name}"`);
  while (!lines[i]!.trim().startsWith("run: |")) i++;
  const body: string[] = [];
  const indent = lines[i + 1]!.search(/\S/);
  for (i++; i < lines.length && (lines[i]!.trim() === "" || lines[i]!.search(/\S/) >= indent); i++) body.push(lines[i]!.slice(indent));
  // Set here: Git for Windows' bash puts its own folders, and its curl, ahead of an inherited PATH.
  return `set -e\nexport PATH="$(cd "${slash(stubs)}" && pwd):$PATH"\n${body.join("\n")}\n`;
}

/**
 * The workflow's own step scripts, run in temporary folders. GitHub isn't involved:
 * `npm ci` links this repository's packages (and checks --ignore-scripts), `npx`
 * runs tsx from them, and `curl` serves one prepared archive and logs what was asked.
 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "shorthop-update-"));
  const stubs = join(root, "stubs");
  mkdirSync(stubs);
  const modules = slash(join(REPO, "node_modules"));
  writeFileSync(
    join(stubs, "npm.cjs"),
    `if (!process.argv.includes("--ignore-scripts")) { console.error("npm ran with install scripts"); process.exit(3); }
     require("fs").symlinkSync(${JSON.stringify(modules)}, "node_modules", "junction");`,
  );
  writeFileSync(join(stubs, "npm"), `#!/usr/bin/env bash\nexec node "${slash(stubs)}/npm.cjs" "$@"\n`);
  writeFileSync(join(stubs, "npx"), `#!/usr/bin/env bash\n[ "$1" = "--no-install" ] && [ "$2" = "tsx" ] || exit 4\nshift 2\nexec node "${slash(TSX)}" "$@"\n`);
  writeFileSync(join(stubs, "curl"), `#!/usr/bin/env bash\nfor a; do url="$a"; done\necho "$url" >> "${slash(root)}/curl.log"\n[ -f "${slash(root)}/archive.tgz" ] || exit 22\ncat "${slash(root)}/archive.tgz"\n`);
  const temp = join(root, "runner");
  const work = join(root, "work");
  for (const d of [temp, work, join(temp, "new")]) mkdirSync(d, { recursive: true });
  const summary = join(root, "summary.md");
  const run = (step: string, cwd: string) => {
    const script = join(root, "step.sh");
    writeFileSync(script, stepScript(step, stubs));
    return spawnSync(BASH, [slash(script)], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: slash(temp),
        GITHUB_WORKSPACE: slash(work),
        GITHUB_STEP_SUMMARY: slash(summary),
        UPSTREAM: "jntegz/shorthop",
        FALLBACK_UPDATER: /FALLBACK_UPDATER: (\S+)/.exec(WORKFLOW)![1]!,
      },
    });
  };
  return {
    root,
    temp,
    copy: join(work, "copy"),
    release: join(temp, "new"),
    run,
    summary: () => (existsSync(summary) ? readFileSync(summary, "utf8") : ""),
    curled: () => (existsSync(join(root, "curl.log")) ? readFileSync(join(root, "curl.log"), "utf8") : ""),
    /** Set up the updater, then update the files, as the job does. */
    update() {
      const setup = run("Set up the updater", work);
      assert.equal(setup.status, 0, setup.stderr + setup.stdout);
      const files = run("Update the files", join(temp, "updater"));
      assert.equal(files.status, 0, files.stderr + files.stdout);
    },
  };
}

const UPDATER_FILES = ["scripts", "src/shared", "package.json"];
function copyTree(into: string, paths = UPDATER_FILES): void {
  for (const p of paths) cpSync(join(REPO, p), join(into, p), { recursive: true });
}
function commitAll(dir: string): void {
  assert.equal(git(dir, "init", "-q").status, 0);
  git(dir, "add", "-A");
  const res = git(dir, "commit", "-q", "-m", "copy");
  assert.equal(res.status, 0, res.stderr);
}
function exportTag(tag: string, into: string): void {
  mkdirSync(into, { recursive: true });
  const tar = join(into, "..", `${tag}.tar`);
  assert.equal(git(REPO, "archive", "-o", tar, tag).status, 0);
  const res = spawnSync(BASH, ["-c", `tar -xf - -C "${slash(into)}" < "${slash(tar)}"`], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
}
/** This tree as the release being installed: what the updater reads, at a new version. */
function makeRelease(dir: string, version = "9.9.9"): void {
  copyTree(dir);
  cpSync(join(REPO, "wrangler.toml"), join(dir, "wrangler.toml"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/update-shorthop.yml"), WORKFLOW);
  writeFileSync(join(dir, "NEW-IN-THIS-RELEASE.txt"), "new\n");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version }, null, 2));
}
function assertUpdated(copy: string): void {
  assert.equal((JSON.parse(readFileSync(join(copy, "package.json"), "utf8")) as { version: string }).version, "9.9.9");
  assert.ok(existsSync(join(copy, "NEW-IN-THIS-RELEASE.txt")));
  const toml = parseToml(readFileSync(join(copy, "wrangler.toml"), "utf8")) as unknown as { name: string; observability: Observability };
  assert.equal(toml.name, "links", "the copy's own values stay");
  assertMinimal(toml.observability);
}

describe("updating a copy, with the workflow's own steps", { skip: hasBash ? false : "needs bash" }, () => {
  const places: string[] = [];
  after(() => places.forEach((p) => rmSync(p, { recursive: true, force: true })));
  const space = () => {
    const w = workspace();
    places.push(w.root);
    return w;
  };

  it("runs the updater a copy already has, and downloads nothing", () => {
    const w = space();
    mkdirSync(w.copy, { recursive: true });
    copyTree(w.copy);
    writeFileSync(join(w.copy, "wrangler.toml"), OLD_COPY);
    commitAll(w.copy);
    makeRelease(w.release);
    w.update();
    assertUpdated(w.copy);
    assert.equal(w.curled(), "");
  });

  it("gives a copy without an updater the pinned one, and still updates it", () => {
    const w = space();
    mkdirSync(w.copy, { recursive: true });
    writeFileSync(join(w.copy, "package.json"), JSON.stringify({ name: "shorthop", version: "1.1.1" }));
    writeFileSync(join(w.copy, "wrangler.toml"), OLD_COPY);
    commitAll(w.copy);
    makeRelease(w.release);
    // The archive GitHub would serve: one top folder holding the updater's version of the code.
    const top = join(w.root, "archive/shorthop-pinned");
    mkdirSync(top, { recursive: true });
    copyTree(top);
    assert.equal(spawnSync(BASH, ["-c", `cd "${slash(join(w.root, "archive"))}" && tar -czf - shorthop-pinned > "${slash(join(w.root, "archive.tgz"))}"`]).status, 0);
    w.update();
    assertUpdated(w.copy);
    const pin = /FALLBACK_UPDATER: (\S+)/.exec(WORKFLOW)![1]!;
    assert.match(pin, /^[0-9a-f]{40}$/);
    assert.equal(w.curled().trim(), `https://github.com/jntegz/shorthop/archive/${pin}.tar.gz`);
    assert.match(w.summary(), /before 1\.2\.0/);
  });

  it("stops with a way forward when that download fails", () => {
    const w = space();
    mkdirSync(w.copy, { recursive: true });
    writeFileSync(join(w.copy, "package.json"), JSON.stringify({ name: "shorthop", version: "1.1.1" }));
    commitAll(w.copy);
    const res = w.run("Set up the updater", join(w.copy, ".."));
    assert.notEqual(res.status, 0);
    assert.match(res.stdout, /Update with git instead/);
    assert.notEqual(w.curled(), "", "it asked the stub, not the network");
  });

  for (const tag of ["v1.2.0", "v2.0.2"]) {
    it(`updates a real ${tag} copy with that version's own updater`, { skip: hasTag(tag) ? false : "tags not fetched" }, () => {
      const w = space();
      exportTag(tag, w.copy);
      writeFileSync(join(w.copy, "wrangler.toml"), OLD_COPY);
      commitAll(w.copy);
      makeRelease(w.release);
      w.update();
      assertUpdated(w.copy);
      assert.equal(w.curled(), "");
    });
  }

  it("updates a real v1.1.1 copy through the pinned v2.0.2 updater", { skip: hasTag("v1.1.1") && hasTag("v2.0.2") ? false : "tags not fetched" }, () => {
    const w = space();
    exportTag("v1.1.1", w.copy);
    assert.ok(!existsSync(join(w.copy, "scripts/setup/update-copy.ts")));
    writeFileSync(join(w.copy, "wrangler.toml"), OLD_COPY);
    commitAll(w.copy);
    makeRelease(w.release);
    assert.equal(git(REPO, "archive", "--format=tar.gz", "--prefix=shorthop-pinned/", "-o", join(w.root, "archive.tgz"), "v2.0.2").status, 0);
    w.update();
    assertUpdated(w.copy);
    assert.notEqual(w.curled(), "");
    assert.equal(/FALLBACK_UPDATER: (\S+)/.exec(WORKFLOW)![1], git(REPO, "rev-parse", "v2.0.2^{commit}").stdout.trim(), "the pin is v2.0.2");
  });

  it("still works from an old workflow, which runs the release's updater, and says what that means", () => {
    const w = space();
    mkdirSync(join(w.copy, ".github/workflows"), { recursive: true });
    writeFileSync(join(w.copy, ".github/workflows/update-shorthop.yml"), "name: Update Shorthop\n# the old one\n");
    writeFileSync(join(w.copy, "package.json"), JSON.stringify({ name: "shorthop", version: "2.0.2" }));
    writeFileSync(join(w.copy, "wrangler.toml"), OLD_COPY);
    makeRelease(w.release);
    symlinkSync(join(REPO, "node_modules"), join(w.release, "node_modules"), "junction");
    const out = join(w.root, "old-summary.md");
    const res = spawnSync(process.execPath, [TSX, "scripts/setup/update-copy.ts", "--target", w.copy, "--summary", out], { cwd: w.release, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assertUpdated(w.copy);
    const text = readFileSync(out, "utf8");
    assert.match(text, /### Your update workflow is out of date/);
    assert.match(text, /installs and runs the new release's code/);
    assert.match(readFileSync(join(w.copy, ".github/workflows/update-shorthop.yml"), "utf8"), /the old one/, "an update never changes workflows");
  });
});

describe("restoring a backup with the script", () => {
  const places: string[] = [];
  after(() => places.forEach((p) => rmSync(p, { recursive: true, force: true })));

  /** A database as `wrangler d1 migrations apply` leaves it. */
  function freshDatabase(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    const dir = join(REPO, "migrations");
    for (const f of readdirSync(dir).sort()) if (f.endsWith(".sql")) db.exec(readFileSync(join(dir, f), "utf8"));
    return db;
  }

  const TABLES: Record<string, Record<string, unknown>[]> = {
    links: [
      { domain: "sh.example", slug: "open", target: "http://example.com/it's", active: 1, created_at: 1, updated_at: 1 },
      { domain: "sh.example", slug: "locked", target: "https://example.com/l", active: 1, created_at: 1, updated_at: 1, password_protected: 1 },
    ],
    settings: [
      { key: "last_rolled", value: "2026-11-01" },
      { key: "backup_job", value: "{}" },
    ],
    users: [{ email: "a@example.com", role: "user", created_by: "o", created_at: 1, updated_at: 1 }],
    api_keys: [{ id: "k1", owner: "a@example.com", name: "K", created_at: 1 }],
    webhooks: [{ id: 1, url: "https://h.example.com", events: "[]", active: 1, created_at: 1, updated_at: 1 }],
    stat_shares: [{ id: "s1", domain: "sh.example", slug: "open", created_by: "o", created_at: 1 }],
    web_sessions: [{ id: "v1", site_id: "st", started_at: 1, last_seen_at: 1, source: "direct" }],
    web_visitors: [],
  };
  const manifest = (over: Record<string, unknown> = {}) => ({ format: "shorthop-backup", version: 2, personal: false, tables: Object.fromEntries(Object.entries(TABLES).map(([t, r]) => [t, r.length])), ...over });

  function folder(layout: "zip" | "r2", over: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "shorthop-backup-"));
    places.push(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(over)));
    for (const [table, rows] of Object.entries(TABLES)) {
      const file = layout === "zip" ? join(dir, "tables", `${table}.json`) : join(dir, table, "00000.json");
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(rows));
    }
    return dir;
  }
  const script = (dir: string, ...extra: string[]) => spawnSync(process.execPath, [TSX, join(REPO, "scripts/restore-backup.ts"), "--backup", dir, "--out", join(dir, "sql"), ...extra], { cwd: REPO, encoding: "utf8" });

  for (const layout of ["zip", "r2"] as const) {
    it(`loads a ${layout === "zip" ? "downloaded" : "R2"} backup into a freshly migrated database`, () => {
      const dir = folder(layout);
      const res = script(dir, "--rows-per-file", "4");
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /1 links had a password/);
      const db = freshDatabase();
      const files = readdirSync(join(dir, "sql")).sort();
      assert.ok(files.length > 1, "split into files");
      // Twice: a file that failed halfway can simply be loaded again.
      for (const round of [1, 2]) for (const f of files) assert.doesNotThrow(() => db.exec(readFileSync(join(dir, "sql", f), "utf8")), `${f}, round ${round}`);
      const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
      assert.equal(one("SELECT target FROM links WHERE slug = 'open'").target, "http://example.com/it's");
      assert.equal(one("SELECT active FROM links WHERE slug = 'locked'").active, 0);
      assert.equal(one("SELECT COUNT(*) AS n FROM settings WHERE key = 'backup_job'").n, 0);
      assert.equal(one("SELECT value FROM settings WHERE key = 'last_rolled'").value, "2026-11-01");
      assert.ok(one("SELECT value FROM settings WHERE key = 'session_epoch'").value);
      assert.equal(one("SELECT active FROM webhooks").active, 0);
      assert.ok(one("SELECT revoked_at FROM stat_shares").revoked_at);
      assert.match(String(one("SELECT visitor_id FROM web_sessions").visitor_id), /^erased_[0-9a-f]{18}$/);
      assert.match(String(one("SELECT hash FROM api_keys").hash), /^restored-without-secret:/);
      db.close();
    });
  }

  it("refuses a backup that doesn't say which links had a password, unless told", () => {
    const dir = folder("r2", { version: 1 });
    const res = script(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /accept-lost-passwords/);
    assert.equal(script(dir, "--accept-lost-passwords").status, 0);
  });

  it("refuses an incomplete copy", () => {
    const dir = folder("r2");
    rmSync(join(dir, "links"), { recursive: true });
    const res = script(dir);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /links: the manifest says 2 rows, the files hold 0/);
    rmSync(join(dir, "manifest.json"));
    assert.match(script(dir).stderr, /no manifest\.json/);
  });
});

describe("the update summary", () => {
  const plan = (workflows: string[]): Plan => ({ write: [], remove: [], workflows, kept: [], wrangler: null });

  it("calls out an update workflow that differs from the release's", () => {
    const text = summarize(plan([".github/workflows/update-shorthop.yml"]), "2.0.2", "2.0.3", "");
    assert.match(text, /### Your update workflow is out of date/);
    assert.match(text, /blob\/v2\.0\.3\/\.github\/workflows\/update-shorthop\.yml/);
    assert.doesNotMatch(summarize(plan([".github/workflows/ci.yml"]), "2.0.2", "2.0.3", ""), /out of date/);
  });
});

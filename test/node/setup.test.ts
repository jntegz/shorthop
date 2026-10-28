// Node-side tests for the setup wizard's pure parts: npm test runs them after
// the Workers suite (tsx --test).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { args } from "../../scripts/lib";
import { CHECKS_CRON, DIGEST_CRON, ROLLUP_CRON } from "../../src/shared/schedule";
import { parse as parseToml } from "smol-toml";
import {
  BUTTON_CONFIG,
  BUTTON_FILE,
  configFromText,
  deployProblems,
  EXAMPLE_CONFIG,
  EXAMPLE_FILE,
  mergeButtonConfig,
  outdatedProblems,
  parseJsonc,
  renderButtonConfig,
  renderConfig,
  routeHosts,
  type SetupConfig,
  webDatasetFor,
} from "../../scripts/setup/template";
import { applyUpdate, changelogSection, keepMatcher, planUpdate } from "../../scripts/setup/update-copy";
import {
  datasetProblem,
  defaultSender,
  httpsUrlProblem,
  isAud,
  isEmail,
  normalizeHost,
  normalizeTeamDomain,
  parseHosts,
  passwordProblem,
  workerNameProblem,
  zoneFor,
} from "../../scripts/setup/validate";

const REAL: SetupConfig = {
  ...EXAMPLE_CONFIG,
  workerName: "links",
  accountId: "0123456789abcdef0123456789abcdef",
  shortDomains: ["go.example.net", "example.org"],
  adminHost: "admin.example.net",
  fallbackUrl: "https://www.example.net",
  accessTeamDomain: "team.cloudflareaccess.com",
  accessAud: "a".repeat(64),
  adminEmail: "me@example.net",
  kvId: "f".repeat(32),
  d1Name: "links",
  d1Id: "00000000-0000-4000-8000-000000000000",
  aeDataset: "links_clicks",
  plan: "paid",
  tokenScope: "full",
  hsts: "subdomains",
  digestProvider: "mailgun",
  digestFrom: "digest@example.net",
  digestTo: "me@example.net",
  mailgunDomain: "mg.example.net",
  mailgunRegion: "eu",
};

describe("config template", () => {
  it("renders the committed example exactly (run npm run config:example after changing the template)", () => {
    assert.equal(renderConfig(EXAMPLE_CONFIG), readFileSync(EXAMPLE_FILE, "utf8"));
  });

  it("keeps account and resource ids out of the example", () => {
    const raw = parseJsonc(readFileSync(EXAMPLE_FILE, "utf8"), EXAMPLE_FILE);
    assert.equal(raw.account_id, undefined);
    const text = JSON.stringify(raw);
    assert.doesNotMatch(text, /"id"|database_id/);
    assert.equal(raw.workers_dev, false);
  });

  it("reads back what it writes", () => {
    assert.deepEqual(configFromText(renderConfig(REAL)), REAL);
    assert.deepEqual(configFromText(renderConfig(EXAMPLE_CONFIG)), EXAMPLE_CONFIG);
    const pw = { ...REAL, authMode: "password" as const, digestProvider: "cloudflare" as const, mailgunDomain: "", mailgunRegion: "us" as const };
    assert.deepEqual(configFromText(renderConfig(pw)), pw);
  });

  it("writes the crons the Worker dispatches on, and routes for every host", () => {
    const raw = parseJsonc(renderConfig(REAL), "x") as { triggers: { crons: string[] }; routes: { pattern: string }[]; send_email?: unknown };
    assert.deepEqual(raw.triggers.crons, [ROLLUP_CRON, DIGEST_CRON, CHECKS_CRON]);
    assert.deepEqual(raw.routes.map((r) => r.pattern), ["go.example.net", "example.org", "admin.example.net"]);
    assert.equal(raw.send_email, undefined);
    assert.deepEqual(routeHosts({ ...REAL, adminHost: "example.org" }), ["go.example.net", "example.org"]);
    const cfEmail = parseJsonc(renderConfig({ ...REAL, digestProvider: "cloudflare" }), "x") as { send_email: { destination_address: string }[] };
    assert.equal(cfEmail.send_email[0]!.destination_address, "me@example.net");
  });

  it("refuses to deploy the example or a config without ids", () => {
    assert.deepEqual(deployProblems(REAL), []);
    const problems = deployProblems(EXAMPLE_CONFIG).join(" ");
    for (const p of ["account_id", "KV", "database_id", "placeholder"]) assert.match(problems, new RegExp(p));
    assert.match(deployProblems({ ...REAL, adminHost: "admin.example" }).join(), /placeholder/);
  });
});

describe("configs from older versions", () => {
  it("accepts the current template", () => {
    assert.deepEqual(outdatedProblems(renderConfig(REAL)), []);
  });

  it("names the cron, rate limiter and Durable Object an older config lacks", () => {
    const old = renderConfig(REAL)
      .replace(`, ${JSON.stringify(CHECKS_CRON)}`, "")
      .replace(/\n\s*\/\/ Password attempts on a protected short link[^\n]*\n[^\n]*LINK_PASSWORD_LIMITER[^\n]*/, "")
      .replace(/\n\s*\/\/ Exact click limits[\s\S]*?"migrations": \[[^\n]*\],/, "");
    assert.equal(parseJsonc(old, "old").durable_objects, undefined);
    const problems = outdatedProblems(old);
    assert.equal(problems.length, 3);
    assert.match(problems.join(" "), /\*\/30 \* \* \* \*.*LINK_PASSWORD_LIMITER.*CLICK_CAPS/);
  });

  it("names the hourly cron, rate limiters and dataset a config from before websites lacks", () => {
    const old = renderConfig(REAL)
      .replace(JSON.stringify(ROLLUP_CRON), JSON.stringify("15 1 * * *"))
      .replace(/,\n\s*\/\/ Website analytics events from[^\n]*\n[^\n]*"WEB"[^\n]*/, "")
      .replace(/,\n\s*\/\/ Shared statistics pages[\s\S]*?COLLECT_LIMITER[^\n]*/, "");
    const problems = outdatedProblems(old);
    assert.equal(problems.length, 4, problems.join("\n"));
    assert.match(problems.join(" "), /15 \* \* \* \*.*PUBLIC_LIMITER.*COLLECT_LIMITER.*WEB/);
  });
});

describe("Deploy to Cloudflare button config", () => {
  it("renders the committed wrangler.toml exactly (run npm run config:example after changing the template)", () => {
    assert.equal(readFileSync(BUTTON_FILE, "utf8"), renderButtonConfig());
  });

  it("is the JSON config as TOML: workers.dev, no routes, no ids, no required secrets", () => {
    // Through JSON: smol-toml builds null-prototype objects.
    const toml = JSON.parse(JSON.stringify(parseToml(renderButtonConfig()))) as Record<string, unknown>;
    const json = parseJsonc(renderConfig(BUTTON_CONFIG), "x");
    delete json.$schema;
    delete json.routes;
    delete json.secrets;
    assert.equal(toml.account_id, undefined);
    assert.deepEqual(toml.kv_namespaces, [{ binding: "LINKS" }]);
    assert.equal((toml.d1_databases as { database_id?: string }[])[0]!.database_id, undefined);
    assert.equal(toml.send_email, undefined);
    assert.equal((toml.vars as Record<string, string>).ADMIN_AUTH, "password");
    assert.equal((toml.vars as Record<string, string>).SHORT_DOMAINS, "");
    assert.deepEqual(outdatedProblems(JSON.stringify(toml)), []);
    // Last: deepEqual narrows the type.
    assert.deepEqual(toml, { ...json, workers_dev: true });
  });
});

describe("updating a button copy", () => {
  // Through JSON: smol-toml builds null-prototype objects.
  const toml = (text: string) => JSON.parse(JSON.stringify(parseToml(text))) as Record<string, any>;
  const OLD = readFileSync("test/node/fixtures/wrangler-1.1.1.toml", "utf8");

  it("names a missing website dataset after the click dataset", () => {
    assert.equal(webDatasetFor("links_clicks"), "links_web");
    assert.equal(webDatasetFor("stats"), "stats_web");
    const old = renderConfig(REAL)
      .replace(/,\n\s*\/\/ Website analytics events from[^\n]*\n[^\n]*"WEB"[^\n]*/, "")
      .replace(/\n\s*"AE_WEB_DATASET"[^\n]*/, "");
    assert.equal(configFromText(old).webDataset, "links_web");
  });

  it("keeps a 1.1.1 copy's ids, routes and vars, and adds what this version needs", () => {
    const merged = mergeButtonConfig(OLD);
    const raw = toml(merged);
    assert.equal(raw.name, "links");
    assert.deepEqual(raw.routes, [{ pattern: "go.example.net", custom_domain: true }]);
    assert.equal(raw.workers_dev, true);
    assert.deepEqual(raw.kv_namespaces, [{ binding: "LINKS", id: "f".repeat(32) }]);
    assert.equal(raw.d1_databases[0].database_id, "00000000-0000-4000-8000-000000000000");
    assert.equal(raw.d1_databases[0].database_name, "links-db");
    assert.deepEqual(raw.analytics_engine_datasets, [
      { binding: "CLICKS", dataset: "links_clicks" },
      { binding: "WEB", dataset: "links_web" },
    ]);
    assert.equal(raw.vars.SHORT_DOMAINS, "go.example.net");
    assert.equal(raw.vars.CF_ACCOUNT_ID, "0123456789abcdef0123456789abcdef");
    assert.equal(raw.vars.WORKERS_PLAN, "paid");
    assert.equal(raw.vars.DIGEST_MAILGUN_DOMAIN, "mg.example.net");
    assert.equal(raw.vars.AE_WEB_DATASET, "links_web");
    assert.deepEqual(raw.send_email, [{ name: "DIGEST", destination_address: "me@example.net" }]);
    assert.deepEqual(raw.triggers.crons, [ROLLUP_CRON, DIGEST_CRON, CHECKS_CRON]);
    assert.deepEqual(outdatedProblems(JSON.stringify(raw)), []);
    assert.equal(mergeButtonConfig(merged), merged, "merging again changes nothing");
  });

  it("leaves an untouched button config as this version's", () => {
    assert.equal(mergeButtonConfig(renderButtonConfig()), renderButtonConfig());
  });

  it("copies the release over the copy, except workflows and kept files, and deletes what the release removed", () => {
    const root = mkdtempSync(join(tmpdir(), "shorthop-update-"));
    const write = (dir: string, files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, dir, path)), { recursive: true });
        writeFileSync(join(root, dir, path), text);
      }
    };
    try {
      write("old", { "package.json": '{"version":"1.1.1"}', "src/a.ts": "a1", "src/gone.ts": "x", ".github/workflows/ci.yml": "ci1", "wrangler.toml": renderButtonConfig() });
      write("new", { "package.json": '{"version":"1.2.0"}', "src/a.ts": "a2", "src/new.ts": "n", "docs/x.md": "d2", ".github/workflows/ci.yml": "ci2", ".github/workflows/update-shorthop.yml": "u", "wrangler.toml": renderButtonConfig(), "node_modules/m/index.js": "m" });
      write("copy", { "package.json": '{"version":"1.1.1"}', "src/a.ts": "a1", "src/gone.ts": "x", "src/mine.ts": "mine", "docs/x.md": "mine", ".github/workflows/ci.yml": "ci1", "wrangler.toml": OLD, ".shorthop-keep": "# mine\ndocs/\n" });
      const plan = planUpdate(join(root, "new"), join(root, "copy"), join(root, "old"));
      assert.deepEqual(plan.write, ["package.json", "src/a.ts", "src/new.ts"]);
      assert.deepEqual(plan.remove, ["src/gone.ts"]);
      assert.deepEqual(plan.workflows.sort(), [".github/workflows/ci.yml", ".github/workflows/update-shorthop.yml"]);
      assert.deepEqual(plan.kept, ["docs/x.md"]);
      applyUpdate(join(root, "new"), join(root, "copy"), plan);
      const read = (path: string) => readFileSync(join(root, "copy", path), "utf8");
      assert.equal(read("src/a.ts"), "a2");
      assert.equal(read("src/mine.ts"), "mine");
      assert.equal(read("docs/x.md"), "mine");
      assert.equal(read(".github/workflows/ci.yml"), "ci1");
      assert.throws(() => read("src/gone.ts"));
      assert.throws(() => read("node_modules/m/index.js"));
      assert.equal(toml(read("wrangler.toml")).kv_namespaces[0].id, "f".repeat(32));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches .shorthop-keep paths and globs, and finds a version's changelog", () => {
    const keep = keepMatcher("README.md\npublic/*.png\nsrc/**/custom.ts\n");
    assert.ok(keep("README.md") && keep("public/logo.png") && keep("src/a/b/custom.ts"));
    assert.ok(!keep("docs/README.md") && !keep("public/x/logo.png") && !keep("public/logo.svg"));
    const log = "# Changelog\n\n## [Unreleased]\n\n## [1.2.0] - 2026-10-28\n\nNew.\n\n## [1.1.1] - x\n\nOld.\n\n[1.2.0]: https://x\n";
    assert.equal(changelogSection(log, "1.2.0"), "New.");
    assert.equal(changelogSection(log, "1.1.1"), "Old.");
    assert.equal(changelogSection(log, "9.9.9"), "");
  });
});

describe("setup validators", () => {
  it("checks names, hosts and addresses", () => {
    assert.equal(workerNameProblem("shorthop"), null);
    for (const bad of ["", "-x", "x-", "Upper", "a_b", "x".repeat(64)]) assert.notEqual(workerNameProblem(bad), null, bad);
    assert.equal(normalizeHost("https://Go.Example.net/path?q"), "go.example.net");
    assert.equal(normalizeHost("localhost"), null);
    assert.deepEqual(parseHosts("a.dev, B.dev a.dev"), { hosts: ["a.dev", "b.dev"] });
    assert.deepEqual(parseHosts("a.dev, nope"), { bad: "nope" });
    assert.ok(isEmail("me@example.net"));
    assert.ok(!isEmail("me@example"));
    assert.equal(httpsUrlProblem("https://www.example.net"), null);
    assert.notEqual(httpsUrlProblem("http://example.net"), null);
    assert.equal(datasetProblem("links_clicks"), null);
    assert.notEqual(datasetProblem("links-clicks"), null);
  });

  it("checks Access settings and passwords", () => {
    assert.equal(normalizeTeamDomain("team"), "team.cloudflareaccess.com");
    assert.equal(normalizeTeamDomain("https://team.cloudflareaccess.com/"), "team.cloudflareaccess.com");
    assert.equal(normalizeTeamDomain("team.example.com"), null);
    assert.ok(isAud("ab".repeat(32)));
    assert.ok(!isAud("xyz"));
    assert.notEqual(passwordProblem("short"), null);
    assert.notEqual(passwordProblem("8-chars!"), null);
    assert.equal(passwordProblem("9-chars!!"), null);
    assert.equal(passwordProblem("a-long-enough-passphrase"), null);
  });

  it("finds the zone a host is in", () => {
    assert.equal(zoneFor("go.example.net", ["example.net", "go.example.net", "example.org"]), "go.example.net");
    assert.equal(zoneFor("x.example.net", ["example.net"]), "example.net");
    assert.equal(zoneFor("notexample.net", ["example.net"]), null);
    assert.equal(defaultSender("go.example.net", ["example.net"]), "digest@example.net");
  });
});

describe("script arguments", () => {
  it("never reads the next word as the value of a boolean flag", () => {
    const { flags, opts } = args(["--dry-run", "domains", "--data", "x.json", "--rotate", "--salt", "--concurrency=4"]);
    assert.deepEqual([...flags].sort(), ["dry-run", "rotate", "salt"]);
    assert.equal(opts.get("data"), "x.json");
    assert.equal(opts.get("concurrency"), "4");
    assert.equal(opts.has("dry-run"), false);
  });

  it("refuses an ADMIN_AUTH value it doesn't know instead of rewriting it", () => {
    const text = renderConfig(REAL).replace('"ADMIN_AUTH": "access+password"', '"ADMIN_AUTH": "locked"');
    assert.throws(() => configFromText(text), /ADMIN_AUTH/);
  });
});

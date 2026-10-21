// Node-side tests for the setup wizard's pure parts: npm test runs them after
// the Workers suite (tsx --test).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { args } from "../../scripts/lib";
import { DIGEST_CRON, ROLLUP_CRON } from "../../src/shared/schedule";
import { configFromText, deployProblems, EXAMPLE_CONFIG, EXAMPLE_FILE, parseJsonc, renderConfig, routeHosts, type SetupConfig } from "../../scripts/setup/template";
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
    assert.deepEqual(raw.triggers.crons, [ROLLUP_CRON, DIGEST_CRON]);
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

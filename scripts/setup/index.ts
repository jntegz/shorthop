// npm run setup: sets up (or changes) a Shorthop deployment on Cloudflare.
//
//   npm run setup                         # everything, step by step; safe to re-run
//   npm run setup -- domains              # short domains, admin host, fallback URL
//   npm run setup -- access               # Cloudflare Access, or password-only sign-in
//   npm run setup -- password             # a new admin password
//   npm run setup -- analytics            # the Analytics Engine read token
//   npm run setup -- email                # digest and alert delivery
//   npm run setup -- secrets --rotate     # new session secret, and API_TOKEN if you still have one (--salt: visitor salt too)
//   npm run setup -- deploy               # build, migrate the database, deploy
//   npm run setup -- check                # test the live deployment
//   npm run setup -- local                # write .dev.vars for npm run dev
//   npm run setup -- upgrade              # after pulling a new version: config, migrations, deploy
//   ... --dry-run                         # print what would change, touch nothing
//
// Secrets go to Cloudflare through stdin and are never written to disk (only
// `local` writes .dev.vars, with throwaway dev values). The admin password and
// API token are shown once, when they're created.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "../../src/shared/brand";
import { hashPassword, PLAN_ITERATIONS } from "../../src/shared/password";
import { generateSlug } from "../../src/shared/slug";
import { args, fail } from "../lib";
import * as cf from "./cf";
import { ask, bad, choose, color, confirm, heading, info, ok, requireTty, secret, warn, type Choice } from "./prompt";
import { CONFIG_FILE, configFromText, deployProblems, EXAMPLE_CONFIG, isPlaceholderHost, renderConfig, routeHosts, type Provider, type SetupConfig } from "./template";
import {
  datasetProblem,
  defaultSender,
  httpsUrlProblem,
  isAud,
  isEmail,
  MIN_PASSWORD_LENGTH,
  normalizeHost,
  normalizeTeamDomain,
  parseHosts,
  passwordProblem,
  workerNameProblem,
  zoneFor,
} from "./validate";

interface State {
  cfg: SetupConfig;
  /** wrangler.jsonc existed when the setup started. */
  hadConfig: boolean;
  /** Secrets to upload; null deletes one. */
  secrets: Record<string, string | null>;
  /** Secret names the Worker already has. */
  existing: Set<string>;
  zones: cf.Zone[];
  /** Shown once at the end. */
  shown: { password?: string; apiToken?: string; webhookSecret?: string };
}

const { flags } = args();
const command = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
cf.setDryRun(flags.has("dry-run"));

const randomSecret = (length: number) => generateSlug(length);

function loadState(): State {
  const hadConfig = existsSync(CONFIG_FILE);
  const cfg = hadConfig ? configFromText(readFileSync(CONFIG_FILE, "utf8")) : structuredClone(EXAMPLE_CONFIG);
  return { cfg, hadConfig, secrets: {}, existing: new Set(), zones: [], shown: {} };
}

function requireConfig(s: State): void {
  if (!s.hadConfig) fail(`${CONFIG_FILE} doesn't exist yet. Run \`npm run setup\` first.`);
}

// --- 1. Account ------------------------------------------------------------------

async function accountStep(s: State, interactive: boolean): Promise<void> {
  heading("Cloudflare account");
  const me = cf.whoami();
  if (!me) {
    if (cf.isDryRun()) {
      warn("Not logged in to Wrangler: the dry run continues without account checks.");
      cf.goOffline();
      return;
    }
    fail("Wrangler isn't logged in. Run `npx wrangler login`, then `npm run setup` again.");
  }
  if (!me.accounts.length) fail("This login has no Cloudflare accounts.");
  info(`Logged in${me.email ? ` as ${color.bold(me.email)}` : ""}.`);
  let id = s.cfg.accountId;
  if (!me.accounts.some((a) => a.id === id)) {
    if (id && !interactive) fail(`The account in ${CONFIG_FILE} (${id}) isn't available to this login. Log in to it, or run \`npm run setup\` to move to another account.`);
    if (id) warn(`The account in ${CONFIG_FILE} (${id}) isn't available to this login.`);
    id =
      me.accounts.length === 1
        ? me.accounts[0]!.id
        : await choose(
            "Which account should Shorthop live in?",
            me.accounts.map((a) => ({ value: a.id, label: a.name, hint: a.id })),
          );
    if (s.cfg.accountId) {
      // The old account's KV namespace and database don't exist here: find or create new ones.
      s.cfg.kvId = null;
      s.cfg.d1Id = null;
    }
  }
  cf.useAccount(id);
  s.cfg.accountId = id;
  ok(`Account: ${me.accounts.find((a) => a.id === id)?.name ?? id}`);
  try {
    s.zones = await cf.zones();
  } catch (err) {
    warn(`Couldn't list the account's zones (${String(err instanceof Error ? err.message : err)}); domain checks are skipped.`);
  }
  s.existing = cf.secretNames(s.cfg.workerName);
}

// --- 2. Worker and plan -------------------------------------------------------------

async function workerStep(s: State): Promise<void> {
  heading("Worker");
  const name = await ask("Worker name", { default: s.cfg.workerName, check: workerNameProblem });
  if (!s.hadConfig) {
    s.cfg.d1Name = name;
    s.cfg.aeDataset = `${name.replaceAll("-", "_")}_clicks`;
  }
  const renamed = name !== s.cfg.workerName;
  s.cfg.workerName = name;
  s.cfg.aeDataset = await ask("Analytics Engine dataset", { default: s.cfg.aeDataset, check: datasetProblem });
  s.cfg.plan = await choose(
    "Which Workers plan is the account on?",
    [
      { value: "free", label: "Free", hint: "10 ms CPU per request: the password hash uses 25,000 iterations" },
      { value: "paid", label: "Paid ($5/month)", hint: "100,000 iterations" },
    ],
    s.cfg.plan,
  );
  if (renamed) s.existing = cf.secretNames(name);
}

// --- 3. Domains ---------------------------------------------------------------------

async function domainsStep(s: State): Promise<void> {
  heading("Domains");
  info("Short links live on one or more domains you own; each must be a zone in this Cloudflare account.");
  info(color.dim("The first one is the primary: new links default to it, and it hosts the admin unless you pick a separate admin host."));
  const zoneNames = s.zones.map((z) => z.name);
  for (;;) {
    const current = s.cfg.shortDomains.filter((d) => !isPlaceholderHost(d)).join(",");
    const answer = await ask("Short domains, primary first (comma-separated)", {
      default: current || undefined,
      check: (v) => {
        const p = parseHosts(v);
        return "bad" in p ? `"${p.bad}" isn't a domain name.` : p.hosts.some(isPlaceholderHost) ? "Use domains you own, not placeholder ones such as .example." : null;
      },
    });
    const hosts = (parseHosts(answer) as { hosts: string[] }).hosts;
    const adminHost = await ask(`Separate admin host (empty: the primary domain${s.cfg.adminHost ? "; - to remove it" : ""})`, {
      default: s.cfg.adminHost || undefined,
      allowEmpty: true,
      check: (v) => (normalizeHost(v) ? null : "That isn't a domain name."),
    });
    const next = { ...s.cfg, shortDomains: hosts, adminHost: adminHost ? normalizeHost(adminHost)! : "" };
    if (next.adminHost && hosts.includes(next.adminHost)) next.adminHost = "";
    if (await domainsUsable(s, next, zoneNames)) {
      s.cfg = next;
      break;
    }
  }
  const fallback = s.cfg.fallbackUrl && !/\/\/example\.com/.test(s.cfg.fallbackUrl) ? s.cfg.fallbackUrl : undefined;
  s.cfg.fallbackUrl = await ask("Fallback URL (where / goes, and clicks when links can't be read; e.g. your website)", { default: fallback, check: httpsUrlProblem });
}

/** Zones exist, no other Worker owns a hostname, and existing DNS records are pointed out. */
async function domainsUsable(s: State, c: SetupConfig, zoneNames: string[]): Promise<boolean> {
  const hosts = routeHosts(c);
  if (s.zones.length) {
    const missing = hosts.filter((h) => !zoneFor(h, zoneNames));
    if (missing.length) {
      bad(`Not in a zone of this account: ${missing.join(", ")}. Add the domain to Cloudflare first (docs/SETUP.md#zone).`);
      return false;
    }
  }
  try {
    const taken = (await cf.workerDomains()).filter((d) => hosts.includes(d.hostname) && d.service !== c.workerName);
    if (taken.length) {
      for (const t of taken) bad(`${t.hostname} already belongs to the Worker "${t.service}".`);
      info("Deploying would move it to this Worker. Detach it there first (Workers & Pages → that Worker → Settings → Domains & Routes), or pick another hostname.");
      info(color.dim("  If that's this Worker under an old name, delete the old one: npx wrangler delete <old name>."));
      return false;
    }
  } catch (err) {
    warn(`Couldn't check which Worker owns each hostname (${String(err instanceof Error ? err.message : err)}).`);
    if (!(await confirm("Continue without that check?", false))) return false;
  }
  for (const h of hosts) {
    const zone = s.zones.find((z) => z.name === zoneFor(h, zoneNames));
    if (!zone) continue;
    try {
      const records = (await cf.dnsRecords(zone.id, h)).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
      if (records.length) {
        warn(`${h} has DNS records: ${records.map((r) => `${r.type} ${r.content}`).join(", ")}.`);
        info(color.dim("  The deploy asks before it replaces them with the Worker. MX and TXT records are never touched."));
      }
    } catch {
      // The DNS read scope is optional: the deploy itself shows conflicts.
    }
  }
  ok(`Domains: ${hosts.join(", ")}`);
  return true;
}

// --- 4. Sign-in -----------------------------------------------------------------------

async function signinStep(s: State): Promise<void> {
  heading("Admin sign-in");
  const adminHost = s.cfg.adminHost || s.cfg.shortDomains[0] || "<admin host>";
  const mode = await choose(
    "How should the admin be protected?",
    [
      { value: "access", label: "Cloudflare Access + password (recommended)", hint: "free for up to 50 users; nobody reaches the login page without your email" },
      { value: "password", label: "Password only", hint: "simpler, but anyone can try passwords at the login page" },
      { value: "later", label: "Decide later", hint: "the admin stays closed until you run: npm run setup -- access" },
    ],
    s.cfg.authMode === "password" ? "password" : "access",
  );

  if (mode === "password") {
    warn("Without Access, the login page is public. The lockout slows guessing, but a long random password matters.");
    info(color.dim("  Recommended: the WAF rate-limit rule in SECURITY.md."));
    if (await confirm("Use password-only sign-in?", true)) {
      s.cfg = { ...s.cfg, authMode: "password", accessTeamDomain: "", accessAud: "" };
      return;
    }
    return signinStep(s);
  }
  s.cfg.authMode = "access+password";
  if (mode === "later") {
    warn("The admin fails closed until Access is configured.");
    return;
  }

  info(`
In the Zero Trust dashboard (${color.bold("https://one.dash.cloudflare.com")}):
  1. Pick a team name if asked (the Free plan covers 50 users).
  2. ${color.bold("Settings → Authentication")}: add the ${color.bold("One-time PIN")} login method.
  3. ${color.bold("Access → Applications → Add an application → Self-hosted")}. Add two public hostnames:
       ${color.bold(adminHost)}  path ${color.bold("_admin")}
       ${color.bold(adminHost)}  path ${color.bold("_admin/*")}
     Protect only these paths: short links and /api must stay reachable.
  4. Add a policy: Action ${color.bold("Allow")}, Include ${color.bold("Emails")} → your email address.
  5. Save, then copy the ${color.bold("Application Audience (AUD) Tag")} from the application's overview.
Details: docs/SETUP.md#access`);

  for (;;) {
    const raw = await ask("Team domain (yourteam or yourteam.cloudflareaccess.com)", {
      default: s.cfg.accessTeamDomain || undefined,
      check: (v) => (normalizeTeamDomain(v) ? null : "Expected yourteam.cloudflareaccess.com."),
    });
    const team = normalizeTeamDomain(raw)!;
    if (cf.isDryRun() || (await cf.accessTeamWorks(team))) {
      s.cfg.accessTeamDomain = team;
      break;
    }
    bad(`https://${team}/cdn-cgi/access/certs didn't answer with signing keys. Check the team name.`);
  }
  s.cfg.accessAud = await ask("Application Audience (AUD) Tag", {
    default: s.cfg.accessAud || undefined,
    check: (v) => (isAud(v) ? null : "The AUD tag is 64 hexadecimal characters."),
  });
  s.cfg.adminEmail = await ask("Email address(es) allowed in the admin (comma-separated)", {
    default: s.cfg.adminEmail && s.cfg.adminEmail !== EXAMPLE_CONFIG.adminEmail ? s.cfg.adminEmail : undefined,
    check: (v) => (v.split(",").every((e) => isEmail(e)) ? null : "Use email addresses, comma-separated."),
  });
  ok("Cloudflare Access configured.");
}

// --- 5. Password -------------------------------------------------------------------

async function passwordStep(s: State, force: boolean): Promise<void> {
  heading("Admin password");
  if (!force && s.existing.has("ADMIN_PASSWORD_HASH") && (await confirm("The Worker already has an admin password. Keep it?", true))) return;
  const how = await choose(
    "Admin password",
    [
      { value: "generate", label: "Generate a random one (recommended)", hint: "shown once at the end: save it in your password manager" },
      { value: "type", label: "Type my own", hint: `at least ${MIN_PASSWORD_LENGTH} characters` },
    ],
    "generate",
  );
  let password: string;
  if (how === "generate") {
    password = randomSecret(32);
    s.shown.password = password;
  } else {
    for (;;) {
      password = await secret("Password (hidden)", passwordProblem);
      if ((await secret("Repeat it")) === password) break;
      bad("The passwords don't match.");
    }
  }
  const iterations = PLAN_ITERATIONS[s.cfg.plan];
  s.secrets.ADMIN_PASSWORD_HASH = await hashPassword(password, iterations);
  // Sessions aren't tied to the password: a new session secret ends the ones signed in with the old password.
  s.secrets.SESSION_SECRET = randomSecret(48);
  ok(`Password hashed (PBKDF2, ${iterations.toLocaleString("en")} iterations). Existing admin sessions end when it's uploaded.`);
}

// --- 6. Analytics ---------------------------------------------------------------------

async function analyticsStep(s: State, force: boolean): Promise<void> {
  heading("Analytics");
  info("Clicks are always recorded. Reading them back (stats, the daily rollup) needs an API token with Account Analytics Read.");
  if (!force && s.existing.has("CF_ANALYTICS_TOKEN") && (await confirm("The Worker already has an analytics token. Keep it?", true))) return;
  info(`
  1. ${color.bold("https://dash.cloudflare.com/profile/api-tokens")} → Create Token → Custom token.
  2. Permissions: ${color.bold("Account → Account Analytics → Read")}.
  3. Account Resources: include only this account. Create, then copy the token.`);
  if (!(await confirm("Add the token now?", true))) {
    warn("Skipped: stats stay empty until you run `npm run setup -- analytics`.");
    return;
  }
  for (;;) {
    const token = await secret("Analytics token (hidden)");
    const check = cf.isDryRun() ? { ok: true, detail: "Not checked in a dry run." } : await cf.analyticsTokenWorks(token);
    if (check.ok) {
      s.secrets.CF_ANALYTICS_TOKEN = token;
      ok(check.detail);
      return;
    }
    bad(check.detail);
    if (!(await confirm("Try another token?", true))) return;
  }
}

// --- 7. Email ---------------------------------------------------------------------------

const PROVIDER_CHOICES: Choice<Provider>[] = [
  { value: "cloudflare", label: "Cloudflare Email Service", hint: "no extra account; sends from a domain in this Cloudflare account" },
  { value: "resend", label: "Resend" },
  { value: "emailit", label: "Emailit" },
  { value: "postmark", label: "Postmark" },
  { value: "sendgrid", label: "SendGrid" },
  { value: "mailgun", label: "Mailgun" },
  { value: "custom", label: "Custom email API", hint: "any HTTPS JSON email API, such as Brevo" },
  { value: "webhook", label: "Signed webhook", hint: "n8n, Zapier, Make or your own endpoint" },
  { value: "off", label: "Off", hint: "problems only show on the dashboard" },
];
/** Each provider's own key secret (src/worker/mailer.ts reads the same names). */
const KEY_SECRET: Partial<Record<Provider, string>> = {
  resend: "RESEND_API_KEY",
  emailit: "EMAILIT_API_KEY",
  postmark: "POSTMARK_API_KEY",
  sendgrid: "SENDGRID_API_KEY",
  mailgun: "MAILGUN_API_KEY",
  custom: "DIGEST_CUSTOM_API_KEY",
};

async function emailStep(s: State): Promise<void> {
  heading("Email (weekly digest and alerts)");
  info(color.dim("  A service picked in the admin (Settings → Weekly digest → Set up email) wins over this until you press “Use wrangler.jsonc” there."));
  const previous = s.cfg.digestProvider;
  const provider = await choose("How should email be sent?", PROVIDER_CHOICES, previous);
  const label = PROVIDER_CHOICES.find((c) => c.value === provider)!.label;
  s.cfg.digestProvider = provider;
  // Other providers' own secrets stay, so Settings → Set up email can switch to
  // them. The older shared DIGEST_API_KEY belongs to whichever provider
  // DIGEST_PROVIDER names, so it goes when that changes.
  const legacyKey = s.existing.has("DIGEST_API_KEY");
  if (legacyKey && provider !== previous) s.secrets.DIGEST_API_KEY = null;
  if (provider === "off") return;

  const knownEmail = (e: string) => (e && e !== EXAMPLE_CONFIG.digestTo ? e : undefined);
  const toDefault = knownEmail(s.cfg.digestTo) ?? knownEmail(s.cfg.adminEmail.split(",")[0]?.trim() ?? "");
  s.cfg.digestTo = await ask("Send to (the only recipient)", { default: toDefault, check: (v) => (isEmail(v) ? null : "That isn't an email address.") });

  const zoneNames = s.zones.map((z) => z.name);
  if (provider === "webhook") {
    // Not used for sending, but kept real: the config shouldn't carry a placeholder.
    if (s.cfg.digestFrom.endsWith(".example")) s.cfg.digestFrom = defaultSender(s.cfg.shortDomains[0] ?? "", zoneNames);
    const has = s.existing.has("DIGEST_WEBHOOK_URL") && s.existing.has("DIGEST_WEBHOOK_SECRET");
    if (has && (await confirm("Keep the existing webhook URL and signing secret?", true))) return;
    s.secrets.DIGEST_WEBHOOK_URL = await ask("Webhook URL (https)", { check: httpsUrlProblem });
    s.secrets.DIGEST_WEBHOOK_SECRET = randomSecret(48);
    s.shown.webhookSecret = s.secrets.DIGEST_WEBHOOK_SECRET;
    info(color.dim("  Requests carry X-Shorthop-Signature: an HMAC-SHA256 of the body with this secret (docs/SETUP.md#webhook)."));
    return;
  }

  const fromDefault = s.cfg.digestFrom && !s.cfg.digestFrom.endsWith(".example") ? s.cfg.digestFrom : defaultSender(s.cfg.shortDomains[0] ?? "", zoneNames);
  s.cfg.digestFrom = await ask("Send from", { default: fromDefault, check: (v) => (isEmail(v) ? null : "That isn't an email address.") });
  const fromDomain = s.cfg.digestFrom.split("@")[1]!;

  if (provider === "cloudflare") return cloudflareEmail(s, fromDomain, zoneNames);
  if (provider === "mailgun") {
    s.cfg.mailgunDomain = (await ask("Mailgun sending domain", { default: s.cfg.mailgunDomain || fromDomain, check: (v) => (normalizeHost(v) ? null : "That isn't a domain.") })).toLowerCase();
    s.cfg.mailgunRegion = await choose("Mailgun region", [{ value: "us", label: "US" }, { value: "eu", label: "EU" }], s.cfg.mailgunRegion);
  }
  if (provider === "custom") {
    if (!s.existing.has("DIGEST_CUSTOM_URL") || !(await confirm("Keep the existing API URL?", true))) {
      s.secrets.DIGEST_CUSTOM_URL = await ask("Email API URL (https)", { check: httpsUrlProblem });
    }
  }
  const keyName = KEY_SECRET[provider]!;
  const hasKey = s.existing.has(keyName) || (legacyKey && provider === previous);
  if (!hasKey || !(await confirm("Keep the existing API key?", true))) {
    s.secrets[keyName] = await secret(`${label} API key (hidden)`);
    if (legacyKey) s.secrets.DIGEST_API_KEY = null;
  }
  if (provider === "custom") {
    info(color.dim("  The key is sent as Authorization: Bearer, and the body is Resend-style JSON. For another"));
    info(color.dim("  header or body, set DIGEST_CUSTOM_AUTH and DIGEST_CUSTOM_BODY in wrangler.jsonc (docs/SETUP.md#custom)."));
  }
  info(color.dim(`  Make sure ${fromDomain} is verified as a sending domain with ${label}.`));
}

async function cloudflareEmail(s: State, fromDomain: string, zoneNames: string[]): Promise<void> {
  if (s.zones.length && !zoneFor(fromDomain, zoneNames)) {
    warn(`${fromDomain} isn't a zone in this account; Cloudflare Email Service can only send from domains it manages.`);
  }
  try {
    cf.wrangler(["email", "sending", "enable", fromDomain], { mutates: true });
    ok(`Email Sending enabled for ${fromDomain}.`);
  } catch (err) {
    warn(`Couldn't enable Email Sending for ${fromDomain} (it may already be on): ${errorLine(err)}`);
  }
  try {
    let addr = (await cf.routingAddresses()).find((a) => a.email.toLowerCase() === s.cfg.digestTo.toLowerCase());
    if (!addr) {
      addr = await cf.addRoutingAddress(s.cfg.digestTo);
      if (cf.isDryRun()) return;
      info(`Cloudflare sent a verification email to ${color.bold(s.cfg.digestTo)}.`);
    }
    for (let i = 0; !addr?.verified && i < 5; i++) {
      await ask(`Click the link in that email, then press Enter`, { allowEmpty: true });
      addr = (await cf.routingAddresses()).find((a) => a.email.toLowerCase() === s.cfg.digestTo.toLowerCase());
    }
    if (addr?.verified) ok(`${s.cfg.digestTo} is verified.`);
    else warn(`${s.cfg.digestTo} isn't verified yet: email fails until it is (Email → Email Routing → Destination addresses).`);
  } catch (err) {
    warn(`Couldn't check the destination address (${String(err instanceof Error ? err.message : err)}). Verify it under Email → Email Routing → Destination addresses.`);
  }
}

/** The line of a failed command that names the error, rather than whatever it printed last. */
function errorLine(err: unknown): string {
  const output = err instanceof cf.CommandError ? err.output : String(err instanceof Error ? err.message : err);
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error/i.test(l)) ?? lines.at(-1) ?? "unknown error";
}

// --- 8-9. Resources and config -------------------------------------------------------------

function resourcesStep(s: State): void {
  heading("Storage");
  s.cfg.kvId ??= cf.ensureKv(`${s.cfg.workerName}-links`);
  s.cfg.d1Id ??= cf.ensureD1(s.cfg.d1Name);
  ok(`KV namespace ${s.cfg.kvId ?? "(created on a real run)"}, D1 database ${s.cfg.d1Name} ${s.cfg.d1Id ?? ""}`.trim());
}

/** Shows what changes in wrangler.jsonc and writes it after a yes. Returns whether it changed. */
async function writeConfigStep(s: State): Promise<boolean> {
  heading(CONFIG_FILE);
  const next = renderConfig(s.cfg);
  const current = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
  if (current === next) {
    ok("No changes.");
    return false;
  }
  if (cf.isDryRun()) {
    info(color.dim(`Would write ${CONFIG_FILE}:\n`));
    if (current) printDiff(current, next);
    else console.log(next);
    return true;
  }
  if (current) printDiff(current, next);
  else info(`A new ${CONFIG_FILE} (gitignored), for ${routeHosts(s.cfg).join(", ")}.`);
  if (!(await confirm(`Write ${CONFIG_FILE}?`, true))) fail(`Stopped before writing ${CONFIG_FILE}.`);
  writeFileSync(CONFIG_FILE, next);
  ok(`Wrote ${CONFIG_FILE}.`);
  return true;
}

/** A unified diff through git (exit code 1 just means "different"); the whole file without git. */
function printDiff(a: string, b: string): void {
  const dir = mkdtempSync(join(tmpdir(), "shorthop-"));
  try {
    writeFileSync(join(dir, "current"), a);
    writeFileSync(join(dir, "new"), b);
    const res = spawnSync("git", ["diff", "--no-index", "--no-color", "--", join(dir, "current"), join(dir, "new")], { encoding: "utf8" });
    const out = res.stdout ?? "";
    console.log(out.includes("@@") ? out.slice(out.indexOf("@@")) : b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 10. Secrets ---------------------------------------------------------------------------

/**
 * Uploads pending secrets (generating any that are missing). Returns whether
 * anything was sent. API_TOKEN is no longer created: scripts use personal API
 * keys (Settings → API & webhooks). An existing one is kept, and rotated with
 * --rotate.
 */
function secretsStep(s: State, rotate = false): boolean {
  heading("Secrets");
  if (rotate && s.existing.has("API_TOKEN")) {
    s.secrets.API_TOKEN = randomSecret(40);
    s.shown.apiToken = s.secrets.API_TOKEN;
  }
  if (rotate || !s.existing.has("SESSION_SECRET")) s.secrets.SESSION_SECRET ??= randomSecret(48);
  if (flags.has("salt") || !s.existing.has("VISITOR_SALT")) s.secrets.VISITOR_SALT = randomSecret(32);
  const names = Object.keys(s.secrets);
  if (!names.length) {
    ok("Nothing to change.");
    return false;
  }
  cf.putSecrets(s.cfg.workerName, s.secrets);
  for (const [n, v] of Object.entries(s.secrets)) {
    if (v === null) s.existing.delete(n);
    else s.existing.add(n);
  }
  ok(`${cf.isDryRun() ? "Would update" : "Updated"} ${names.join(", ")} (through stdin; nothing is written to disk).`);
  s.secrets = {};
  return true;
}

// --- 11. Build, migrate, deploy ---------------------------------------------------------------

function deployStep(s: State): void {
  heading("Deploy");
  const problems = deployProblems(s.cfg);
  if (problems.length) {
    const text = `${CONFIG_FILE} isn't ready:\n  - ${problems.join("\n  - ")}`;
    if (!cf.isDryRun()) fail(text);
    warn(`${text}\n  (a real run would stop here)`);
  }
  cf.npmRun("build", { inherit: true, mutates: true });
  cf.wrangler(["d1", "migrations", "apply", "DB", "--remote"], { inherit: true, mutates: true, project: true });
  info(color.dim("Wrangler may ask before it attaches a hostname that has DNS records: answer yes only for hostnames listed above."));
  cf.wrangler(["deploy"], { inherit: true, mutates: true, project: true });
  if (!cf.isDryRun()) ok("Deployed.");
}

// --- 12. Checks ---------------------------------------------------------------------------------

async function fetchSoft(url: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    return await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
  } catch {
    return null;
  }
}

async function checkStep(s: State, token = s.shown.apiToken): Promise<void> {
  heading("Checks");
  if (cf.isDryRun()) {
    info(color.dim("  [dry run] would check /health, the admin protection and the API."));
    return;
  }
  const primary = s.cfg.shortDomains[0]!;
  const admin = s.cfg.adminHost || primary;
  let healthy = false;
  for (let i = 0; i < 18 && !healthy; i++) {
    const res = await fetchSoft(`https://${primary}/health`);
    healthy = res?.status === 200 && (await res.text()) === "ok";
    if (!healthy) {
      if (i === 0) info(`Waiting for https://${primary} (DNS and the certificate can take a few minutes)…`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  if (healthy) ok(`https://${primary}/health answers.`);
  else bad(`https://${primary}/health doesn't answer yet. Try \`npm run setup -- check\` in a few minutes; see docs/SETUP.md#troubleshooting.`);

  const shell = await fetchSoft(`https://${admin}/_admin/`);
  if (!shell) bad(`https://${admin}/_admin/ didn't answer.`);
  else if (shell.status === 200) bad(`https://${admin}/_admin/ is open without signing in! Check ADMIN_AUTH and the Access application.`);
  else {
    const where = shell.headers.get("Location") ?? "";
    const via = where.includes("cloudflareaccess.com") ? "Cloudflare Access" : where.includes("/_admin/login") ? "the password login" : `HTTP ${shell.status}`;
    ok(`The admin is protected (${via}).`);
    if (s.cfg.authMode === "access+password" && s.cfg.accessAud && !where.includes("cloudflareaccess.com")) {
      warn("Access didn't intercept /_admin/. Check the application's hostnames and paths.");
    }
  }

  token ??= (await confirm("Check the API with a personal API key (Settings → API & webhooks)?", false)) ? await secret("API key (hidden)") : undefined;
  if (!token) return;
  const apiRes = await fetchSoft(`https://${admin}/api/links?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  if (apiRes?.status === 200) ok("The API accepts the key.");
  else if (apiRes?.headers.get("Location")?.includes("cloudflareaccess.com")) {
    bad("Cloudflare Access intercepts /api, so scripts and the iOS Shortcut can't reach it. Limit the Access application to the paths _admin and _admin/* (docs/SETUP.md#access).");
  } else bad(`The API answered ${apiRes ? `HTTP ${apiRes.status}` : "nothing"} to the key.`);
  if (apiRes?.status === 200 && s.cfg.digestProvider !== "off" && (await confirm(`Send a test digest to ${s.cfg.digestTo}?`, true))) {
    const t = await fetchSoft(`https://${admin}/api/settings/digest/test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const body = (await t?.json().catch(() => null)) as { status?: string; reason?: string } | null;
    if (t?.ok && body?.status === "sent") ok("Test digest sent.");
    else bad(`The test digest wasn't sent${body?.reason ? `: ${body.reason}` : ""}. See Dashboard → System status.`);
  }
}

// --- 13. Summary ------------------------------------------------------------------------------

function summary(s: State): void {
  heading("Done");
  const admin = s.cfg.adminHost || s.cfg.shortDomains[0];
  info(`Admin: ${color.bold(`https://${admin}/_admin/`)}`);
  const { password, apiToken, webhookSecret } = s.shown;
  if (password || apiToken || webhookSecret) {
    console.log(
      cf.isDryRun()
        ? color.yellow("\nA real run would show these once (dry run: they were not saved anywhere):\n")
        : color.yellow("\nShown only this once. Save these in your password manager now:\n"),
    );
    if (password) console.log(`  Admin password   ${color.bold(password)}`);
    if (apiToken) console.log(`  API token        ${color.bold(apiToken)}   (the older Bearer token for /api; personal API keys replace it)`);
    if (webhookSecret) console.log(`  Webhook secret   ${color.bold(webhookSecret)}   (verifies X-Shorthop-Signature)`);
    console.log("");
  }
  info(`For scripts and the iOS Shortcut, create a personal API key in ${color.bold("Settings → API & webhooks")}.`);
  info(color.dim("Change anything later with `npm run setup -- <domains|access|password|analytics|email>`; the dashboard's System status shows what's left."));
}

// --- Local development ----------------------------------------------------------------------

async function localStep(): Promise<void> {
  heading("Local development (.dev.vars)");
  if (existsSync(".dev.vars") && !(await confirm(".dev.vars exists. Replace it?", false))) return;
  let hash = "";
  if (await confirm("Require a password on localhost too?", false)) {
    const pw = await secret("Local password (hidden)", passwordProblem);
    hash = await hashPassword(pw, PLAN_ITERATIONS.free);
  }
  const lines = [
    "# Written by `npm run setup -- local`. Never commit this file.",
    `VISITOR_SALT=${randomSecret(32)}`,
    `ADMIN_PASSWORD_HASH=${hash}`,
    `SESSION_SECRET=${randomSecret(48)}`,
    "# Opens the admin on localhost without Cloudflare Access. Ignored on any other host.",
    "DEV_AUTH_BYPASS=1",
    "# With the bypass, act as someone from Settings → People to see their view. Empty means an owner.",
    "DEV_AUTH_EMAIL=",
    "# Optional: override vars from the config, e.g. to try a second short domain.",
    "# SHORT_DOMAINS=sh.example,alt.example",
    "",
  ];
  if (cf.isDryRun()) {
    info(color.dim("  [dry run] would write .dev.vars"));
    return;
  }
  writeFileSync(".dev.vars", lines.join("\n"), { mode: 0o600 });
  chmodSync(".dev.vars", 0o600); // The mode above only applies to a new file.
  ok("Wrote .dev.vars. Next: npm run db:migrate:local && npm run dev");
}

// --- Commands -------------------------------------------------------------------------------

async function deployIfWanted(s: State, changed: boolean): Promise<void> {
  if (changed && !cf.isDryRun() && (await confirm("Deploy now so the change takes effect?", true))) {
    deployStep(s);
    await checkStep(s);
  } else if (changed) info(color.dim("Run `npm run setup -- deploy` to apply it."));
}

async function main(): Promise<void> {
  requireTty();
  console.log(color.bold(`\n${APP_NAME} setup${cf.isDryRun() ? color.yellow(" (dry run: nothing is changed)") : ""}`));
  const s = loadState();

  switch (command) {
    case "": {
      if (s.hadConfig) info(`Reading ${CONFIG_FILE}: your answers are the defaults. Existing secrets are kept unless you replace them.`);
      await accountStep(s, true);
      await workerStep(s);
      await domainsStep(s);
      await signinStep(s);
      await passwordStep(s, false);
      await analyticsStep(s, false);
      await emailStep(s);
      resourcesStep(s);
      await writeConfigStep(s);
      secretsStep(s);
      if (cf.isDryRun() || (await confirm("Build and deploy now?", true))) {
        deployStep(s);
        await checkStep(s);
      }
      summary(s);
      return;
    }
    case "domains":
    case "access":
    case "email": {
      requireConfig(s);
      await accountStep(s, false);
      if (command === "domains") await domainsStep(s);
      if (command === "access") await signinStep(s);
      if (command === "email") await emailStep(s);
      const changed = await writeConfigStep(s);
      const uploaded = secretsStep(s);
      await deployIfWanted(s, changed);
      if (!changed && uploaded && !cf.isDryRun()) ok("Secrets take effect right away.");
      summary(s);
      return;
    }
    case "password":
    case "analytics": {
      requireConfig(s);
      await accountStep(s, false);
      if (command === "password") await passwordStep(s, true);
      else await analyticsStep(s, true);
      if (secretsStep(s) && !cf.isDryRun()) ok("Secrets take effect right away (Wrangler deploys them as a new version).");
      summary(s);
      return;
    }
    case "secrets": {
      requireConfig(s);
      if (!flags.has("rotate")) fail("Use `npm run setup -- secrets --rotate` (add --salt to rotate the visitor salt too).");
      await accountStep(s, false);
      warn("A new API token breaks scripts and the iOS Shortcut until you update them; a new session secret logs everyone out.");
      if (!(await confirm("Rotate them?", false))) return;
      secretsStep(s, true);
      summary(s);
      return;
    }
    case "deploy": {
      requireConfig(s);
      await accountStep(s, false);
      deployStep(s);
      await checkStep(s);
      return;
    }
    case "check": {
      requireConfig(s);
      await checkStep(s);
      return;
    }
    case "local":
      return localStep();
    case "upgrade": {
      requireConfig(s);
      await accountStep(s, false);
      info("Re-rendering the config with this version's template (your values are kept).");
      await writeConfigStep(s);
      deployStep(s);
      await checkStep(s);
      return;
    }
    default:
      fail(`Unknown command "${command}". See the top of scripts/setup/index.ts, or docs/SETUP.md.`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.message === "Cancelled") fail("Cancelled.");
  fail(err instanceof Error ? err.message : String(err));
});

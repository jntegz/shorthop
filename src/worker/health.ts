// System status: what the scheduled jobs last did, plus live checks of the
// bindings and configuration. The daily cron emails the owner when a problem
// appears (and once it's resolved), so a silent failure doesn't go unnoticed.

import { APP_NAME } from "../shared/brand";
import { rollupWebEvents } from "./web/rollup";
import { addDays, daysBetween, isoWeek, utcDate } from "../shared/dates";
import { isPlaceholderHost } from "../shared/domains";
import { escapeHtml } from "../shared/html";
import type { HealthCheck, HealthStatus, JobRun, SystemHealthDTO } from "../shared/types";
import { MIN_ADMIN_PASSWORD_LENGTH, parsePasswordHash, PLAN_ITERATIONS } from "../shared/password";
import { aeAvailable } from "./ae";
import { pruneDaySalts } from "./analytics";
import { accessConfigured, adminAuthMode, legacyApiToken } from "./auth";
import { getSetting, nowSec, setSettingStmt } from "./db";
import { autoClearDemo } from "./demo";
import { domainsOf } from "./domains";
import { runDigest } from "./digest";
import { pruneHistory } from "./history";
import { MailerError, mailerStatus, providerName, sendMail, withMailSettings } from "./mailer";
import { planLimits } from "./plan";
import { prunePreviewImages } from "./preview";
import { runRollup, type RollupResult } from "./rollup";
import { getCheckSettings, runLinkChecks } from "./link-check";
import { pruneApiKeys } from "./users";
import { checkMilestones, deliver, pruneDeliveries } from "./webhooks";
import { loginConfig, plainAdminPassword, pruneLoginState } from "./session";
import { refreshFx } from "./revenue/fx";
import { rematchAll } from "./revenue/match";
import { listSites } from "./web/sites";

type Job = "rollup" | "digest" | "alert" | "links";
const JOBS_KEY = "job_runs";
const ALERT_KEY = "health_alert";
/** A problem that stays unresolved is reported again after a week. */
const REMIND_AFTER_SEC = 7 * 86400;
/** The rollup cron runs at 01:15 UTC; after this hour yesterday should be saved. */
const ROLLUP_DUE_HOUR = 2;
const MIN_API_TOKEN = 32;
const MIN_SALT = 16;

/** The checks cron runs every 30 minutes; this much silence means it stopped. */
const LINK_CHECKS_LATE_SEC = 3 * 3600;

const RANK: Record<HealthStatus, number> = { ok: 0, warn: 1, error: 2 };

async function jobRuns(db: D1Database): Promise<Partial<Record<Job, JobRun>>> {
  try {
    return JSON.parse((await getSetting(db, JOBS_KEY)) ?? "{}") as Partial<Record<Job, JobRun>>;
  } catch {
    return {};
  }
}

/** Records a job's outcome. Never throws: a failed write must not hide the job's own result. */
export async function recordJob(db: D1Database, job: Job, ok: boolean, error?: string): Promise<void> {
  try {
    const runs = await jobRuns(db);
    runs[job] = { ok, at: nowSec(), ...(ok ? {} : { error: String(error ?? "Unknown error").slice(0, 300) }) };
    await setSettingStmt(db, JOBS_KEY, JSON.stringify(runs)).run();
  } catch (err) {
    console.error(JSON.stringify({ message: "job record failed", job, error: String(err) }));
  }
}

export async function lastJobRun(db: D1Database, job: Job): Promise<JobRun | null> {
  return (await jobRuns(db))[job] ?? null;
}

/** The half-hourly cron: due destination checks, with the outcome recorded. */
export async function scheduledLinkChecks(env: Env): Promise<void> {
  // Webhook deliveries that are due go first, with a few of the run's outbound requests.
  try {
    await deliver(env);
  } catch (err) {
    console.error(JSON.stringify({ message: "webhook deliveries failed", error: String(err) }));
  }
  try {
    const r = await runLinkChecks(env);
    if (!r.skipped) await recordJob(env.DB, "links", true);
    console.log(JSON.stringify({ message: "link checks", ...r, newlyDown: r.newlyDown.length, recovered: r.recovered.length }));
  } catch (err) {
    console.error(JSON.stringify({ message: "link checks failed", error: String(err) }));
    await recordJob(env.DB, "links", false, String(err));
  }
}

/** The half-hourly cron's 02:00 UTC slot runs the daily cleanup instead of destination checks. */
export function isCleanupRun(now: Date): boolean {
  return now.getUTCHours() === 2 && now.getUTCMinutes() < 30;
}

/**
 * The daily cleanup, in the half-hourly cron's 02:00 UTC slot, after the
 * 01:15 rollup: due webhook deliveries, milestone events from the fresh
 * rollup, each prune in turn, then the health alert. It has that invocation
 * to itself, so the deletes (one KV and one D1 call per unused upload) can't
 * crowd out the rollups' Analytics Engine queries or a run's destination
 * checks on the Free plan's 50 subrequests. One job failing doesn't stop the others.
 */
export async function scheduledCleanup(env: Env, now = new Date()): Promise<void> {
  const jobs: [string, () => Promise<unknown>][] = [
    ["webhook deliveries", () => deliver(env)],
    ["webhook milestones", () => checkMilestones(env)],
    ["webhook delivery prune", () => pruneDeliveries(env)],
    ["login state prune", () => pruneLoginState(env.DB, nowSec())],
    ["day salt prune", () => pruneDaySalts(env.DB, utcDate(now))],
    ["api key prune", () => pruneApiKeys(env.DB, nowSec())],
    ["history prune", () => pruneHistory(env.DB)],
    ["upload prune", () => prunePreviewImages(env)],
    ["health alert", () => checkAndAlert(env, now)],
    ["payment events prune", () => prunePaymentEvents(env.DB, nowSec())],
  ];
  for (const [name, run] of jobs) {
    try {
      await run();
    } catch (err) {
      console.error(JSON.stringify({ message: `${name} failed`, error: String(err) }));
    }
  }
}

/** Forgets jobs' last outcomes, such as digest and alert failures that a new mail setup may have fixed. */
export async function forgetJob(db: D1Database, ...jobs: Job[]): Promise<void> {
  try {
    const runs = await jobRuns(db);
    if (!jobs.some((job) => runs[job])) return;
    for (const job of jobs) delete runs[job];
    await setSettingStmt(db, JOBS_KEY, JSON.stringify(runs)).run();
  } catch (err) {
    console.error(JSON.stringify({ message: "job record failed", jobs, error: String(err) }));
  }
}

/** The rollup, with its outcome recorded (cron and the Settings button). */
export async function trackedRollup(env: Env, now = new Date()): Promise<RollupResult> {
  try {
    const result = await runRollup(env, now);
    await recordJob(env.DB, "rollup", !result.skipped, result.skipped);
    return result;
  } catch (err) {
    await recordJob(env.DB, "rollup", false, String(err));
    throw err;
  }
}

/** The Monday cron: rollup and digest, each outcome recorded, then the alert check. */
export async function scheduledDigest(env: Env, now = new Date()): Promise<void> {
  try {
    await trackedRollup(env, now);
  } catch (err) {
    console.error(JSON.stringify({ message: "rollup before digest failed", error: String(err) }));
  }
  try {
    const r = await runDigest(env, now);
    if (r.status !== "skipped") await recordJob(env.DB, "digest", r.status === "sent", r.reason);
  } catch (err) {
    console.error(JSON.stringify({ message: "digest failed", error: String(err) }));
    await recordJob(env.DB, "digest", false, String(err));
  }
  // No health alert here: with the rollup and the email this run has no room left on
  // the Free plan. The 02:00 cleanup checks every day, a failed digest included.
}

const when = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The last day the rollup should have saved by `now`. */
function rollupDueThrough(now: Date): string {
  const today = utcDate(now);
  return addDays(today, now.getUTCHours() >= ROLLUP_DUE_HOUR ? -1 : -2);
}

/** The ISO week whose digest should have gone out by `now` (Mondays 07:00 UTC, plus an hour's grace). */
function digestDueWeek(now: Date): string {
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = addDays(utcDate(now), -sinceMonday);
  const dueMonday = sinceMonday === 0 && now.getUTCHours() < 8 ? addDays(monday, -7) : monday;
  return isoWeek(addDays(dueMonday, -1));
}

type Extra = Pick<HealthCheck, "fix" | "docs" | "advisory">;

export async function systemHealth(env: Env, now = new Date()): Promise<SystemHealthDTO> {
  const checks: HealthCheck[] = [];
  const add = (id: string, label: string, status: HealthStatus, detail: string, extra: Extra = {}) =>
    checks.push({ id, label, status, detail, ...(status === "ok" ? {} : extra) });

  // Bindings: one tiny read each.
  try {
    await env.LINKS.get("cfg:not-found");
    add("kv", "Link storage (KV)", "ok", "Redirects can read links.");
  } catch (err) {
    add("kv", "Link storage (KV)", "error", `Reads fail, so every short link goes to the fallback page: ${String(err).slice(0, 200)}`);
  }
  let runs: Partial<Record<Job, JobRun>> = {};
  let lastRolled: string | null = null;
  let lastDigestWeek: string | null = null;
  let alert: JobRun | null = null;
  try {
    [runs, lastRolled, lastDigestWeek] = await Promise.all([jobRuns(env.DB), getSetting(env.DB, "last_rolled"), getSetting(env.DB, "last_digest_week")]);
    alert = runs.alert ?? null;
    add("d1", "Database (D1)", "ok", "Links, stats and settings are readable.");
  } catch (err) {
    add("d1", "Database (D1)", "error", `Queries fail, so the admin and stats don't work: ${String(err).slice(0, 200)}`);
  }

  // Analytics and the daily rollup.
  const aeFix: Extra = { fix: "npm run setup -- analytics", docs: "docs/SETUP.md#analytics" };
  if (!aeAvailable(env)) {
    add("ae", "Analytics Engine", "warn", "Clicks are recorded, but without CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN they can't be read: no stats and no daily rollup.", { ...aeFix, advisory: true });
  } else if (runs.rollup && !runs.rollup.ok) {
    add("ae", "Analytics Engine", "error", `The last rollup (${when(runs.rollup.at)}) failed: ${runs.rollup.error}. Check that the API token is valid and has Account Analytics Read.`, aeFix);
  } else {
    add("ae", "Analytics Engine", "ok", "Clicks are recorded and can be queried.");
  }
  const due = rollupDueThrough(now);
  const behind = lastRolled ? daysBetween(lastRolled, due) : null;
  if (behind === null) {
    add("rollup", "Daily rollup", "warn", "No day has been saved yet. Run it from Settings → Statistics.", aeAvailable(env) ? {} : { ...aeFix, advisory: true });
  } else if (behind <= 0) {
    add("rollup", "Daily rollup", "ok", `Saved through ${lastRolled}.`);
  } else {
    add(
      "rollup",
      "Daily rollup",
      behind > 7 ? "error" : "warn",
      `Saved through ${lastRolled}, ${behind} ${behind === 1 ? "day" : "days"} behind. Analytics Engine keeps clicks for about 90 days, so days not saved by then are lost.`,
    );
  }

  // Weekly digest (and therefore alert email).
  const mail = mailerStatus(await withMailSettings(env));
  const mailFix: Extra = { fix: "npm run setup -- email", docs: "docs/SETUP.md#email" };
  if (mail.provider === "off") {
    add("digest", "Weekly digest and alerts", "warn", "Email is turned off (Settings → Statistics & email → Weekly digest), so alerts can only be seen here.", { ...mailFix, advisory: true });
  } else if (mail.problem) {
    add("digest", "Weekly digest and alerts", "error", `${providerName(mail.provider)} can't send: ${mail.problem}`, mailFix);
  } else if (runs.digest && !runs.digest.ok) {
    add("digest", "Weekly digest and alerts", "error", `The last digest (${when(runs.digest.at)}) failed: ${runs.digest.error}`, mailFix);
  } else if (lastDigestWeek && lastDigestWeek < digestDueWeek(now)) {
    add("digest", "Weekly digest and alerts", "warn", `The last digest was for ${lastDigestWeek}; this Monday's wasn't sent. Check that the cron triggers are deployed.`);
  } else {
    add("digest", "Weekly digest and alerts", "ok", `Sent with ${providerName(mail.provider)} to ${env.DIGEST_TO}.`);
  }
  // With email off, an old failed alert is no longer something to fix.
  if (alert && !alert.ok && mail.provider !== "off") {
    add("alert", "Alert email", "error", `The last alert (${when(alert.at)}) couldn't be sent: ${alert.error}`);
  }

  // Destination checks (the half-hourly cron).
  const checkSettings = await getCheckSettings(env.DB).catch(() => null);
  const linksRun = runs.links;
  if (checkSettings && !checkSettings.enabled) {
    add("links", "Destination checks", "ok", "Automatic checking is off (Link health → Activate automatic checking).");
  } else if (linksRun && !linksRun.ok) {
    add("links", "Destination checks", "error", `The last run (${when(linksRun.at)}) failed: ${linksRun.error}`);
  } else if (linksRun && nowSec() - linksRun.at > LINK_CHECKS_LATE_SEC) {
    add("links", "Destination checks", "warn", `The last run was ${when(linksRun.at)}; they run every 30 minutes. Check that the cron triggers are deployed.`);
  } else {
    add("links", "Destination checks", "ok", linksRun ? `Last run ${when(linksRun.at)}.` : "The first run starts within 30 minutes.");
  }

  setupChecks(env, add);

  // Advisory warnings are deliberate choices: they don't turn the overall status (and the banner) yellow.
  const status = checks.reduce<HealthStatus>((w, c) => (!c.advisory && RANK[c.status] > RANK[w] ? c.status : w), "ok");
  return { checks, status, checkedAt: nowSec(), alertsTo: mail.problem ? null : env.DIGEST_TO, lastAlert: alert };
}

/** Configuration the setup wizard writes. Lengths and counts only: never a secret's value. */
function setupChecks(env: Env, add: (id: string, label: string, status: HealthStatus, detail: string, extra?: Extra) => void): void {
  const { list, admin } = domainsOf(env);
  const configured = list.filter((d) => !d.endsWith(".invalid"));
  const placeholders = [...new Set([...configured, admin])].filter((h) => isPlaceholderHost(h));
  const domainFix: Extra = { fix: "npm run setup -- domains", docs: "docs/SETUP.md#domains" };
  if (!configured.length) {
    add(
      "domains",
      "Short domains",
      "error",
      "SHORT_DOMAINS is empty or invalid, so links can't be created or served. Installed with the Deploy to Cloudflare button? Add your domain in wrangler.toml in your copy of the repository.",
      { fix: "npm run setup -- domains", docs: "docs/SETUP.md#deploy-button" },
    );
  } else if (placeholders.length) add("domains", "Short domains", "error", `${placeholders.join(", ")} ${placeholders.length === 1 ? "is a placeholder" : "are placeholders"}: set your own domain.`, domainFix);
  else add("domains", "Short domains", "ok", `${configured.join(", ")}${admin !== configured[0] ? `; admin on ${admin}` : ""}.`);

  // Sign-in: Access (unless deliberately off) and the password.
  const mode = adminAuthMode(env);
  const accessFix: Extra = { fix: "npm run setup -- access", docs: "docs/SETUP.md#access" };
  const accessSet = accessConfigured(env);
  const anyAccessVar = Boolean(env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD);
  if (!mode) {
    add("security", "Admin sign-in", "error", 'ADMIN_AUTH must be empty, "access+password" or "password". The admin stays closed until it is.', accessFix);
  } else if (mode === "password") {
    add(
      "security",
      "Admin sign-in",
      "warn",
      anyAccessVar
        ? 'Cloudflare Access is off (ADMIN_AUTH is "password"), although Access settings are filled in: they are ignored. Remove them, or turn Access on.'
        : "Cloudflare Access is off: the admin password is the only lock. Use a long random password and the rate-limit rule from SECURITY.md.",
      { ...accessFix, docs: "docs/SETUP.md#password-only", advisory: !anyAccessVar },
    );
  } else if (!accessSet) {
    add("security", "Admin sign-in", "error", "Cloudflare Access isn't configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAIL), so the admin stays closed.", accessFix);
  } else {
    add("security", "Admin sign-in", "ok", "Cloudflare Access plus the admin password.");
  }

  const passwordFix: Extra = { fix: "npm run setup -- password", docs: "docs/SETUP.md#password" };
  const hash = parsePasswordHash(env.ADMIN_PASSWORD_HASH ?? "");
  const plain = plainAdminPassword(env);
  if (!loginConfig(env)) {
    const password = hash
      ? ""
      : plain
        ? plain.length < MIN_ADMIN_PASSWORD_LENGTH
          ? `ADMIN_PASSWORD (${MIN_ADMIN_PASSWORD_LENGTH} or more characters)`
          : ""
        : "ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD)";
    const missing = [password, (env.SESSION_SECRET ?? "").length >= 32 ? "" : "SESSION_SECRET (32+ characters)"].filter(Boolean);
    add("password", "Admin password", "error", `Missing or invalid: ${missing.join(" and ")}. The admin stays closed until it's set.`, passwordFix);
  } else if (!hash) {
    add(
      "password",
      "Admin password",
      "warn",
      "Set as the plain ADMIN_PASSWORD secret. A hashed one (ADMIN_PASSWORD_HASH) is safer if the secret ever leaks: run npm run setup -- password, then delete ADMIN_PASSWORD.",
      { ...passwordFix, advisory: true },
    );
  } else if (env.WORKERS_PLAN !== "paid" && hash!.iterations > PLAN_ITERATIONS.free) {
    add(
      "password",
      "Admin password",
      "warn",
      `The hash uses ${hash!.iterations.toLocaleString("en")} iterations; on the Workers Free plan (10 ms CPU) logins may fail. Re-hash it with ${PLAN_ITERATIONS.free.toLocaleString("en")}, or set WORKERS_PLAN to "paid".`,
      passwordFix,
    );
  } else if (env.WORKERS_PLAN === "paid" && hash!.iterations < PLAN_ITERATIONS.paid) {
    add("password", "Admin password", "warn", `The hash uses ${hash!.iterations.toLocaleString("en")} iterations; on Workers Paid it can use ${PLAN_ITERATIONS.paid.toLocaleString("en")}.`, { ...passwordFix, advisory: true });
  } else {
    add("password", "Admin password", "ok", `Set (${hash!.iterations.toLocaleString("en")} iterations).`);
  }

  const weak = [
    // Optional since personal API keys: only a token that is set must be long enough.
    legacyApiToken(env) && legacyApiToken(env).length < MIN_API_TOKEN ? `API_TOKEN (${MIN_API_TOKEN}+ characters)` : "",
    (env.VISITOR_SALT ?? "").length < MIN_SALT ? `VISITOR_SALT (${MIN_SALT}+ characters)` : "",
  ].filter(Boolean);
  if (weak.length) add("secrets", "Secrets", "warn", `Too short or missing: ${weak.join(", ")}.`, { fix: "npm run setup -- secrets --rotate", docs: "docs/SETUP.md#secrets" });
  else add("secrets", "Secrets", "ok", legacyApiToken(env) ? "API token and visitor salt are set." : "The visitor salt is set.");

  if (env.DEV_AUTH_BYPASS) {
    add("devbypass", "Local development flag", "warn", "DEV_AUTH_BYPASS is set. It only works on localhost, but belongs in .dev.vars, not in the deployed config.", { fix: "npm run setup", docs: "docs/SETUP.md#configuration" });
  }

  let fallback: URL | null = null;
  try {
    fallback = new URL(env.FALLBACK_URL);
  } catch {
    // Reported below.
  }
  const fallbackFix: Extra = { fix: "npm run setup", docs: "docs/SETUP.md#configuration" };
  if (!fallback || fallback.protocol !== "https:") add("fallback", "Fallback URL", "warn", "FALLBACK_URL should be an https:// address: visitors land there from / and when a link can't be read.", fallbackFix);
  else if (isPlaceholderHost(fallback.hostname)) add("fallback", "Fallback URL", "warn", `FALLBACK_URL still points to ${fallback.hostname}.`, fallbackFix);
  else add("fallback", "Fallback URL", "ok", `${fallback.origin}.`);
}

interface AlertState {
  /** Problem ids and statuses last reported; empty once resolved. */
  fingerprint: string;
  at: number;
}

function renderAlert(problems: HealthCheck[], resolved: boolean, adminUrl: string): { subject: string; text: string; html: string } {
  if (resolved) {
    const text = `Every check on the ${APP_NAME} status page is OK again.\n\n${adminUrl}`;
    return { subject: `${APP_NAME}: all systems OK again`, text, html: `<p>Every check on the ${APP_NAME} status page is OK again.</p><p><a href="${escapeHtml(adminUrl)}">Open the dashboard</a></p>` };
  }
  const lines = problems.map((p) => `${p.status === "error" ? "ERROR" : "Warning"} · ${p.label}: ${p.detail}`);
  return {
    subject: `${APP_NAME}: ${problems.length} ${problems.length === 1 ? "problem needs" : "problems need"} attention`,
    text: `${lines.join("\n\n")}\n\n${adminUrl}`,
    html: `<ul>${problems.map((p) => `<li><strong>${escapeHtml(p.label)}</strong> (${p.status === "error" ? "error" : "warning"}): ${escapeHtml(p.detail)}</li>`).join("")}</ul><p><a href="${escapeHtml(adminUrl)}">Open the dashboard</a></p>`,
  };
}

/**
 * Emails the owner when the set of problems changes (a new one, or all
 * resolved), and again weekly while one persists. `force` sends the current
 * state now (Dashboard → Send test alert).
 */
export async function checkAndAlert(baseEnv: Env, now = new Date(), force = false): Promise<{ sent: boolean; reason?: string }> {
  const env = await withMailSettings(baseEnv);
  const health = await systemHealth(env, now);
  const problems = health.checks.filter((c) => c.status !== "ok" && c.id !== "alert" && !c.advisory);
  const fingerprint = problems.map((p) => `${p.id}:${p.status}`).join(",");
  let last: AlertState = { fingerprint: "", at: 0 };
  try {
    last = { ...last, ...(JSON.parse((await getSetting(env.DB, ALERT_KEY)) ?? "{}") as Partial<AlertState>) };
  } catch {
    // Treat as never alerted.
  }
  const sec = nowSec();
  const changed = fingerprint !== last.fingerprint;
  const remind = fingerprint !== "" && sec - last.at >= REMIND_AFTER_SEC;
  const retry = health.lastAlert !== null && !health.lastAlert.ok;
  if (!force && !changed && !remind && !retry) return { sent: false, reason: "Nothing new to report" };
  if (mailerStatus(env).problem) return { sent: false, reason: "Email can't be sent; see the status page" };

  const { subject, text, html } = renderAlert(problems, fingerprint === "", `https://${domainsOf(env).admin}/_admin/`);
  try {
    await sendMail(env, { from: { email: env.DIGEST_FROM, name: APP_NAME }, to: env.DIGEST_TO, subject, text, html });
  } catch (err) {
    const reason = err instanceof MailerError ? err.code : String(err);
    await recordJob(env.DB, "alert", false, reason);
    console.error(JSON.stringify({ message: "health alert failed", error: reason }));
    return { sent: false, reason };
  }
  console.log(JSON.stringify({ message: "health alert sent", fingerprint, force }));
  // The email went out; failing to remember it (D1 down) only means it may be repeated.
  try {
    await setSettingStmt(env.DB, ALERT_KEY, JSON.stringify({ fingerprint, at: sec } satisfies AlertState)).run();
  } catch (err) {
    console.error(JSON.stringify({ message: "health alert state not saved", error: String(err) }));
  }
  await recordJob(env.DB, "alert", true);
  return { sent: true };
}

/** The 01:15 UTC cron: rollup, click milestones (from the fresh rollup), then the alert check. */
export async function scheduledDaily(env: Env, now = new Date()): Promise<void> {
  try {
    await trackedRollup(env, now);
  } catch (err) {
    console.error(JSON.stringify({ message: "rollup failed", error: String(err) }));
  }
  try {
    await autoClearDemo(env);
  } catch (err) {
    console.error(JSON.stringify({ message: "demo cleanup failed", error: String(err) }));
  }
}

/** The half-hourly cron's 02:30 UTC slot copies website totals to D1 instead of checking destinations. */
export function isWebRollupRun(now: Date): boolean {
  return now.getUTCHours() === 2 && now.getUTCMinutes() >= 30;
}

/**
 * Website page, goal and outbound totals from Analytics Engine to D1, in an
 * invocation of its own: after a catch-up the link rollup leaves no room for
 * it on the Free plan. Up to webRollupDays a run (src/worker/plan.ts).
 */
export async function scheduledWebRollup(env: Env, now = new Date()): Promise<void> {
  try {
    const days = await rollupWebEvents(env, now);
    if (days.length) console.log(JSON.stringify({ message: "website rollup complete", from: days[0], to: days.at(-1) }));
  } catch (err) {
    console.error(JSON.stringify({ message: "website rollup failed", error: String(err) }));
  }
}

/** The half-hourly cron's 03:00 UTC slot does the revenue work instead of destination checks. */
export function isRevenueRun(now: Date): boolean {
  return now.getUTCHours() === 3 && now.getUTCMinutes() < 30;
}

/**
 * Exchange rates for revenue, then another go at payments no visit was found
 * for yet, in an invocation of its own and sized to the plan (src/worker/plan.ts).
 */
export async function scheduledRevenue(env: Env): Promise<void> {
  const sites = await listSites(env.DB);
  if (!sites.length) return;
  const limits = planLimits(env);
  try {
    await refreshFx(env.DB, limits.fxDays, undefined, limits.fxPending);
  } catch (err) {
    console.error(JSON.stringify({ message: "fx refresh failed", error: String(err) }));
  }
  try {
    const r = await rematchAll(env.DB, sites, limits.rematchPayments);
    if (r.tried) console.log(JSON.stringify({ message: "payment rematch", ...r }));
  } catch (err) {
    console.error(JSON.stringify({ message: "payment rematch failed", error: String(err) }));
  }
}

/**
 * Accepted webhook events are remembered 400 days: providers retry for 3 at
 * most, but some sign without a timestamp, so a delivery captured earlier must
 * still be known when it's sent again. Return-page claims are kept 90.
 */
async function prunePaymentEvents(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM payment_events WHERE received_at < ?1").bind(now - 400 * 86400),
    db.prepare("DELETE FROM payment_claims WHERE claimed_at < ?1").bind(now - 90 * 86400),
  ]);
}

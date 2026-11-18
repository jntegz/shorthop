// System status: what the scheduled jobs last did, plus live checks of the
// bindings and configuration. The daily cron emails the owner when a problem
// appears (and once it's resolved), so a silent failure doesn't go unnoticed.

import { APP_NAME } from "../shared/brand";
import { rollupWebEvents } from "./web/rollup";
import { addDays, daysBetween, isoWeek, utcDate } from "../shared/dates";
import { isPlaceholderHost } from "../shared/domains";
// The half-hourly slots that do other work, defined with the crons (src/worker/index.ts uses them).
export { isCleanupRun, isRevenueRun, isWebRollupRun } from "../shared/schedule";
import { escapeHtml } from "../shared/html";
import type { HealthCheck, HealthStatus, JobRun, SystemHealthDTO } from "../shared/types";
import { MIN_ADMIN_PASSWORD_LENGTH, parsePasswordHash, PLAN_ITERATIONS } from "../shared/password";
import { aeAvailable } from "./ae";
import { daySaltPruneStmt, daySaltRange, pruneDaySalts } from "./analytics";
import { BACKUP_JOB_KEY, BACKUP_LAST_KEY, BACKUP_TABLE_NAMES, type BackupJob } from "./backup";
import { SHORT_ADMIN_PASSWORD } from "../shared/login-policy";
import { accessConfigured, adminAuthMode, legacyApiToken } from "./auth";
import { getDefaultUtm, getSetting, nowSec, publish, setSettingStmt, type LinkRow } from "./db";
import { autoClearDemo } from "./demo";
import { destinationsOf, hostsOf, safetyOfEach, UNSAFE_FLAGGED, UNSAFE_NONE, UNSAFE_TRUSTED } from "./safety";
import { configuredDomains, domainsOf, workersDevAdmin } from "./domains";
import { runDigest } from "./digest";
import { pruneHistory } from "./history";
import { MailerError, mailerStatus, providerName, sendMail, withMailSettings } from "./mailer";
import { planLimits } from "./plan";
import { prunePreviewImages } from "./preview";
import { reencryptSecrets } from "./reencrypt";
import { secretsFromD1 } from "./secrets";
import { runRollup, type RollupResult } from "./rollup";
import { getCheckSettings, runLinkChecks } from "./link-check";
import { pruneApiKeys } from "./users";
import { checkMilestones, deliver, pruneDeliveries } from "./webhooks";
import { loginConfig, plainAdminPassword, pruneLoginState } from "./session";
import { anomalyCounts } from "./revenue/anomalies";
import { refreshFx } from "./revenue/fx";
import { rematchAll } from "./revenue/match";
import { pruneCustomerData } from "./web/privacy";
import { listSites } from "./web/sites";
import { budgetKey, collectBudgetPruneStmt } from "./web/budget";

type Job = "rollup" | "digest" | "alert" | "links";
const JOBS_KEY = "job_runs";
const ALERT_KEY = "health_alert";
/** A problem that stays unresolved is reported again after a week. */
const REMIND_AFTER_SEC = 7 * 86400;
/** The rollup cron runs at 01:15 UTC; after this hour yesterday should be saved. */
const ROLLUP_DUE_HOUR = 2;
const MIN_API_TOKEN = 32;
const MIN_SALT = 16;
const MIN_ENCRYPTION_KEY = 32;
/** A row name no setting can have: the count that shares the settings query. */
const FLAGGED_HOOKS = "*webhooks_flagged";
/** Likewise: day salts that should have been deleted by now. */
const OVERDUE_SALTS = "*salts_overdue";
/** The daily cleanup and its retry have both run by this hour (UTC). */
const SALT_PRUNE_DONE_HOUR = 3;
/** Attempts at the day-salt prune in the cleanup run, and the wait between them. */
const SALT_PRUNE_TRIES = 3;
const SALT_PRUNE_WAIT_MS = 1_000;
/** A weekly backup that finished longer ago than this has missed a run. */
const BACKUP_LATE_SEC = 8 * 86400;
/** How long backups that stopped with their bucket's binding keep the status page yellow. */
const BACKUP_GONE_ADVISORY_SEC = 60 * 86400;

/** The checks cron runs every 30 minutes; this much silence means it stopped. */
const LINK_CHECKS_LATE_SEC = 3 * 3600;

const RANK: Record<HealthStatus, number> = { ok: 0, warn: 1, error: 2 };

async function jobRuns(db: D1Database): Promise<Partial<Record<Job, JobRun>>> {
  return parseRuns(await getSetting(db, JOBS_KEY));
}

function parseRuns(raw: string | null): Partial<Record<Job, JobRun>> {
  try {
    return JSON.parse(raw ?? "{}") as Partial<Record<Job, JobRun>>;
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

/**
 * Deletes finished days' visitor salts with the website budget rows, trying
 * again if D1 fails: while a salt exists, that day's hashes can be recomputed
 * by someone holding it. System status reports any that stay (systemHealth).
 */
export async function pruneSaltsAndBudget(env: Env, now: Date): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      // One batch: one of the run's 50 calls on Workers Free.
      await env.DB.batch([daySaltPruneStmt(env.DB, utcDate(now)), collectBudgetPruneStmt(env.DB, utcDate(now))]);
      return;
    } catch (err) {
      if (attempt >= SALT_PRUNE_TRIES) throw err;
      console.error(JSON.stringify({ message: "day salt prune failed, trying again", attempt, error: String(err) }));
      await new Promise((r) => setTimeout(r, SALT_PRUNE_WAIT_MS));
    }
  }
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
  // Destinations never looked up at the security DNS (imports, links from before it): a few each run.
  try {
    const { unsafeLookups, unsafePublishes } = planLimits(env);
    await checkUnsafeBacklog(env, unsafeLookups, unsafePublishes);
  } catch (err) {
    console.error(JSON.stringify({ message: "unsafe-link backlog failed", error: String(err) }));
  }
}

/** Links one backlog run reads: far more than it has lookups for, since many links share a host. */
const UNSAFE_LINKS_PER_RUN = 200;
/** Hosts found clean for links still waiting on other hosts, so the next run doesn't spend its lookups on them again. */
const CLEAN_HOSTS_KEY = "safety_clean_hosts";
const CLEAN_HOST_SEC = 86400;
const MAX_CLEAN_HOSTS = 500;

/**
 * Looks up the destinations of links no one has checked yet: the target and
 * every enabled routing variant, each host once, at most `limit` lookups a run.
 * A link is flagged when any of its destinations is (and republished, so
 * visitors are warned; at most `publishes` a run, the rest wait for the next).
 * Links the owner trusts stay trusted. A lookup that fails is no answer: the
 * link stays unchecked (unsafe_at NULL) and is tried again, after the ones
 * never tried, so a host whose lookup keeps failing can't hold up the rest. A
 * link with more hosts than a run has lookups is finished over several runs.
 * Counts are links.
 */
export async function checkUnsafeBacklog(env: Env, limit: number, publishes = Number.POSITIVE_INFINITY): Promise<{ checked: number; flagged: number; unknown: number }> {
  type Row = Pick<LinkRow, "domain" | "slug" | "target" | "routing" | "unsafe">;
  const [linkRows, settingRows] = await env.DB.batch<Row | { value: string }>([
    env.DB.prepare(
      `SELECT domain, slug, target, routing, unsafe FROM links WHERE unsafe_at IS NULL
       ORDER BY COALESCE(unsafe_tried_at, 0), target, domain, slug LIMIT ${UNSAFE_LINKS_PER_RUN}`,
    ),
    env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(CLEAN_HOSTS_KEY),
  ]);
  const results = (linkRows?.results ?? []) as Row[];
  if (!results.length) return { checked: 0, flagged: 0, unknown: 0 };
  const now = nowSec();
  let clean: Record<string, number> = {};
  try {
    clean = JSON.parse((settingRows?.results[0] as { value: string } | undefined)?.value ?? "{}") as Record<string, number>;
  } catch {
    // Not JSON: start again.
  }
  const fresh = Object.entries(clean).filter(([, at]) => now - at < CLEAN_HOST_SEC);

  const destinations = results.map((r) => destinationsOf(r.target, r.routing));
  const { verdicts, looked } = await safetyOfEach(env, destinations, Math.max(0, Math.floor(limit)), new Set(fresh.map(([h]) => h)));

  const stmts: D1PreparedStatement[] = [];
  const flagged: [string, string][] = [];
  const waiting = new Set<string>();
  const count = { checked: 0, flagged: 0, unknown: 0 };
  let toPublish = 0;
  results.forEach((r, i) => {
    const verdict = verdicts[i];
    if (verdict === "flagged" && r.unsafe !== UNSAFE_TRUSTED && ++toPublish > publishes) return;
    if (verdict === "pending" || verdict === "unknown") for (const h of hostsOf(destinations[i] ?? [])) waiting.add(h);
    if (verdict === "pending" || verdict === undefined) return;
    if (verdict === "unknown") {
      count.unknown++;
      stmts.push(env.DB.prepare("UPDATE links SET unsafe_tried_at = ?1 WHERE domain = ?2 AND slug = ?3 AND unsafe_at IS NULL").bind(now, r.domain, r.slug));
      return;
    }
    count.checked++;
    if (verdict === "flagged") {
      count.flagged++;
      flagged.push([r.domain, r.slug]);
    }
    // Only while the link still has the destinations looked up.
    stmts.push(
      env.DB.prepare(
        `UPDATE links SET unsafe = CASE WHEN unsafe = ${UNSAFE_TRUSTED} THEN ${UNSAFE_TRUSTED} ELSE ?1 END, unsafe_at = ?2, unsafe_tried_at = NULL
         WHERE domain = ?3 AND slug = ?4 AND unsafe_at IS NULL AND target = ?5 AND routing IS ?6`,
      ).bind(verdict === "flagged" ? UNSAFE_FLAGGED : UNSAFE_NONE, now, r.domain, r.slug, r.target, r.routing),
    );
  });
  // Clean answers are kept only for links that are still waiting: a finished link needs none.
  const kept = [...fresh, ...[...looked].filter(([, s]) => s === "clean").map(([h]) => [h, now] as [string, number])].filter(([h]) => waiting.has(h));
  if (kept.length || Object.keys(clean).length) stmts.push(setSettingStmt(env.DB, CLEAN_HOSTS_KEY, JSON.stringify(Object.fromEntries(kept.slice(-MAX_CLEAN_HOSTS)))));
  if (stmts.length) await env.DB.batch(stmts);
  if (flagged.length) {
    const { results: links } = await env.DB.prepare(
      `SELECT * FROM links WHERE unsafe = ${UNSAFE_FLAGGED} AND (domain, slug) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))`,
    )
      .bind(JSON.stringify(flagged))
      .all<LinkRow>();
    const defaultUtm = await getDefaultUtm(env.DB);
    await Promise.all(links.map((r) => publish(env, r, defaultUtm)));
  }
  return count;
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
    ["day salt and website budget prune", () => pruneSaltsAndBudget(env, now)],
    ["api key prune", () => pruneApiKeys(env.DB, nowSec())],
    ["history prune", () => pruneHistory(env.DB)],
    ["upload prune", () => prunePreviewImages(env)],
    ["health alert", () => checkAndAlert(env, now)],
    ["payment events prune", () => prunePaymentEvents(env.DB, nowSec())],
    ["customer data retention", () => pruneCustomerData(env.DB, nowSec(), planLimits(env).prunedVisits)],
    ["secret re-encryption", () => reencryptSecrets(env)],
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
  let collected = 0;
  let flaggedHooks = 0;
  let overdueSalts = 0;
  let backupLast: string | null = null;
  let backupJob: string | null = null;
  try {
    // One query for every setting the checks read (a call each would count against Free's 50 per run).
    // Today's and yesterday's salts are in use; after the cleanup, so far only today's should be left.
    const [saltsFrom, saltsTo] = daySaltRange(now.getUTCHours() >= SALT_PRUNE_DONE_HOUR ? utcDate(now) : addDays(utcDate(now), -1));
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (?1, ?2, ?3, ?4, ?5, ?6)
       UNION ALL SELECT '${FLAGGED_HOOKS}', COUNT(*) FROM webhooks WHERE key_revoked_at IS NOT NULL
       UNION ALL SELECT '${OVERDUE_SALTS}', COUNT(*) FROM settings WHERE key > ?7 AND key < ?8`,
    )
      .bind(JOBS_KEY, "last_rolled", "last_digest_week", budgetKey(utcDate(now)), BACKUP_LAST_KEY, BACKUP_JOB_KEY, saltsFrom, saltsTo)
      .all<{ key: string; value: string }>();
    const setting = (key: string) => results.find((r) => r.key === key)?.value ?? null;
    runs = parseRuns(setting(JOBS_KEY));
    lastRolled = setting("last_rolled");
    lastDigestWeek = setting("last_digest_week");
    collected = Number(setting(budgetKey(utcDate(now))) ?? 0);
    flaggedHooks = Number(setting(FLAGGED_HOOKS) ?? 0);
    overdueSalts = Number(setting(OVERDUE_SALTS) ?? 0);
    backupLast = setting(BACKUP_LAST_KEY);
    backupJob = setting(BACKUP_JOB_KEY);
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

  // Website events: on Workers Free they may write a daily budget of D1 rows (src/worker/web/budget.ts).
  const budget = planLimits(env).collectRows;
  if (Number.isFinite(budget)) {
    const rows = collected;
    const planFix: Extra = { docs: "docs/CLOUDFLARE-FREE-TIER.md" };
    if (rows >= budget) {
      add("collect", "Website events", "warn", `Today's budget of ${budget.toLocaleString("en")} database rows for website events (Workers Free) is used up, so visits aren't recorded again until 00:00 UTC. The budget keeps D1's daily write allowance for logins, links and payments. Workers Paid has none.`, planFix);
    } else if (rows >= budget * 0.8) {
      add("collect", "Website events", "warn", `Website events have written ${rows.toLocaleString("en")} of today's ${budget.toLocaleString("en")} database rows (the Workers Free budget). Past it, visits aren't recorded until 00:00 UTC.`, planFix);
    }
  }

  await paymentChecks(env.DB, add);

  if (flaggedHooks > 0) {
    add(
      "webhookkeys",
      "Webhooks from revoked keys",
      "warn",
      `${flaggedHooks} ${flaggedHooks === 1 ? "webhook was" : "webhooks were"} last changed with an API key that has since been revoked, and still ${flaggedHooks === 1 ? "sends" : "send"} data. Check where each one points: open it in Settings → API, MCP & webhooks and save it, or delete it.`,
    );
  }

  if (overdueSalts > 0) {
    add(
      "salts",
      "Visitor salts",
      "warn",
      `${overdueSalts} daily visitor ${overdueSalts === 1 ? "salt is" : "salts are"} still stored after ${overdueSalts === 1 ? "its day" : "their days"} ended, so those days' visitor hashes can still be recomputed. The daily cleanup deletes them and tries again; if this stays, check that the cron triggers are deployed and that D1 accepts writes.`,
    );
  }

  backupCheck(env, backupLast, backupJob, add);

  setupChecks(env, add);

  // Advisory warnings are deliberate choices: they don't turn the overall status (and the banner) yellow.
  const status = checks.reduce<HealthStatus>((w, c) => (!c.advisory && RANK[c.status] > RANK[w] ? c.status : w), "ok");
  return { checks, status, checkedAt: nowSec(), alertsTo: mail.problem ? null : env.DIGEST_TO, lastAlert: alert };
}

/**
 * The weekly copy to R2: a backup that is failing, unfinished or missing is said so
 * here. So is a bucket gone from the config after backups ran, which stops them
 * without any error; after a while that counts as a choice and stops being a problem.
 */
function backupCheck(env: Env, lastRaw: string | null, jobRaw: string | null, add: (id: string, label: string, status: HealthStatus, detail: string, extra?: Extra) => void): void {
  const docs: Extra = { docs: "docs/SETUP.md#backup" };
  const parsed = <T>(raw: string | null): T | null => {
    try {
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  };
  const last = parsed<{ at: number; rows: number }>(lastRaw);
  const job = parsed<BackupJob>(jobRaw);
  const now = nowSec();
  if (!(env as { BACKUPS?: unknown }).BACKUPS) {
    const ranAt = last?.at ?? job?.startedAt;
    if (ranAt === undefined) return;
    add(
      "backup",
      "Weekly backup",
      "warn",
      `Weekly backups have stopped: they last ran ${when(ranAt)}, and this Worker no longer has a BACKUPS bucket. Add r2_buckets back to your Wrangler config and deploy. If you removed it on purpose, nothing more is needed.`,
      { ...docs, advisory: now - ranAt > BACKUP_GONE_ADVISORY_SEC },
    );
    return;
  }
  const place = job ? `It has copied ${Math.min(job.table, BACKUP_TABLE_NAMES.length)} of ${BACKUP_TABLE_NAMES.length} tables and carries on by itself.` : "";
  if (job?.error) add("backup", "Weekly backup", "warn", `The last backup run stopped: ${job.error.slice(0, 200)}. ${place}`, docs);
  else if (job && now - job.startedAt > BACKUP_LATE_SEC) add("backup", "Weekly backup", "warn", `The backup started ${when(job.startedAt)} hasn't finished. ${place} Older backups stay in the bucket.`, docs);
  else if (!job && last && now - last.at > BACKUP_LATE_SEC) add("backup", "Weekly backup", "warn", `The last complete backup is from ${when(last.at)}; one should run every Sunday. Check that the cron triggers are deployed.`, docs);
  else add("backup", "Weekly backup", "ok", last ? `Last complete backup ${when(last.at)}, ${last.rows.toLocaleString("en")} rows.` : "The first backup runs on Sunday from 04:00 UTC.");
}

/** How long a payment anomaly stays on the status page after the last one. */
const ANOMALY_SHOWN_SEC = 30 * 86400;

/** What the payment checks found lately (src/worker/revenue/anomalies.ts), and connections nothing can confirm. */
async function paymentChecks(db: D1Database, add: (id: string, label: string, status: HealthStatus, detail: string, extra?: Extra) => void): Promise<void> {
  try {
    const [counts, unchecked] = await Promise.all([
      anomalyCounts(db, nowSec() - ANOMALY_SHOWN_SEC),
      // One query: the daily run has a fixed number of calls to spend.
      db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM payment_connections WHERE provider = 'gumroad' AND enabled != 0 AND api_key IS NULL AND api_key_ref IS NULL) AS n,
             (SELECT COUNT(*) FROM subscriptions WHERE unconfirmed_end IS NOT NULL AND unconfirmed_at >= ?1) AS ends`,
        )
        .bind(nowSec() - ANOMALY_SHOWN_SEC)
        .first<{ n: number; ends: number }>(),
    ]);
    const say = (n: number | undefined, one: string, many: string) => (n ? `${n.toLocaleString("en")} ${n === 1 ? one : many}` : "");
    const problems = [
      say(counts.id_conflict, "payment or subscription was refused because its id belongs to another site.", "payments or subscriptions were refused because their ids belong to another site."),
      say(counts.refund_capped, "refund was larger than its charge and was capped at it.", "refunds were larger than their charges and were capped at them."),
      say(counts.refund_currency, "refund or dispute is in another currency than its charge.", "refunds or disputes are in another currency than their charges."),
      say(counts.refund_unknown, "partial refund came without its amount and counts as 0.", "partial refunds came without their amounts and count as 0."),
      say(counts.fx_rate, "exchange-rate update looked wrong.", "exchange-rate updates looked wrong."),
      say(unchecked?.ends, "subscription cancellation couldn't be confirmed with the provider, so the subscription stays as it was.", "subscription cancellations couldn't be confirmed with the provider, so those subscriptions stay as they were."),
    ].filter(Boolean);
    if (problems.length) add("payments", "Payment checks", "warn", `In the last 30 days: ${problems.join(" ")} Flagged payments are marked in each site's Payments list; the log has the details.`);
    if (unchecked?.n) {
      add("gumroad", "Gumroad payments", "warn", `${say(unchecked.n, "Gumroad connection has", "Gumroad connections have")} no access token, so anyone who gets the webhook address can add payments. They are labelled unverified. Add an access token to have each sale confirmed with Gumroad.`, { advisory: true });
    }
  } catch (err) {
    console.error(JSON.stringify({ message: "payment checks failed", error: String(err) }));
  }
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
  } else if (!hash && mode === "password" && plain.length < SHORT_ADMIN_PASSWORD) {
    add(
      "password",
      "Admin password",
      "warn",
      `Cloudflare Access is off and ADMIN_PASSWORD is shorter than ${SHORT_ADMIN_PASSWORD} characters, so the login page is one short password away from anyone. It keeps working: replace it with a long random one, or turn Access on.`,
      passwordFix,
    );
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
    env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.length < MIN_ENCRYPTION_KEY ? `ENCRYPTION_KEY (${MIN_ENCRYPTION_KEY}+ characters)` : "",
  ].filter(Boolean);
  if (weak.length) add("secrets", "Secrets", "warn", `Too short or missing: ${weak.join(", ")}.`, { fix: "npm run setup -- secrets --rotate", docs: "docs/SETUP.md#secrets" });
  else add("secrets", "Secrets", "ok", legacyApiToken(env) ? "API token and visitor salt are set." : "The visitor salt is set.");

  // Deploy to Cloudflare installs: the generated SESSION_SECRET sits in D1, next to the secrets it would encrypt.
  // Worth acting on, so not advisory: anyone who can read the database could read those secrets too.
  const fromD1 = secretsFromD1(env);
  if (!env.ENCRYPTION_KEY && fromD1.includes("SESSION_SECRET")) {
    add(
      "encryption",
      "Stored secrets",
      "warn",
      "Webhook, share and payment secrets are encrypted with a key kept in the same database, so one read of the database exposes them. Add an ENCRYPTION_KEY secret (32+ random characters) in the Worker's Settings → Variables and Secrets, or with npx wrangler secret put ENCRYPTION_KEY. The daily cleanup then moves them over; nothing stops working and nobody is signed out. Keep a copy of the key: without it they can't be read.",
      { docs: "docs/SETUP.md#secrets" },
    );
  } else if (fromD1.length) {
    add(
      "generatedsecrets",
      "Generated secrets",
      "warn",
      `${fromD1.join(" and ")} ${fromD1.length === 1 ? "is" : "are"} generated and kept in the database. To keep ${fromD1.length === 1 ? "it" : "them"} out of it, set your own as Worker secrets once System status shows no other warning here. A new SESSION_SECRET signs everyone out and a new VISITOR_SALT restarts visitor counting.`,
      { docs: "docs/SETUP.md#secrets", advisory: true },
    );
  }

  // Whether workers_dev is on isn't visible from here, so this says what it means if it is.
  if (configuredDomains(env).length && workersDevAdmin(env)) {
    add(
      "workersdev",
      "Admin on workers.dev",
      "warn",
      'If workers_dev is on in your Wrangler config, the admin and the API also answer on your workers.dev address, where rate-limiting rules in your zone don\'t apply. It is handy when your domain breaks. Once the domain works, set workers_dev to false, or WORKERS_DEV_ADMIN to "off" to keep the address for links only.',
      { docs: "docs/SETUP.md#deploy-button", advisory: true },
    );
  }

  if (env.DEV_AUTH_BYPASS) {
    add("devbypass", "Local development flag", "warn", "DEV_AUTH_BYPASS is set. It only works on localhost, but belongs in .dev.vars, not in the deployed config.", { fix: "npm run setup", docs: "README.md#local-development" });
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


/**
 * Website page, goal and outbound totals from Analytics Engine to D1, in an
 * invocation of its own: after a catch-up the link rollup leaves no room for
 * it on the Free plan. Up to webRollupDays a run (src/worker/plan.ts).
 */
export async function scheduledWebRollup(env: Env, now = new Date()): Promise<void> {
  // A second go at the day salts, half an hour after the daily cleanup: one query, nothing to do if that worked.
  try {
    await pruneDaySalts(env.DB, utcDate(now));
  } catch (err) {
    console.error(JSON.stringify({ message: "day salt prune failed", error: String(err) }));
  }
  try {
    const days = await rollupWebEvents(env, now);
    if (days.length) console.log(JSON.stringify({ message: "website rollup complete", from: days[0], to: days.at(-1) }));
  } catch (err) {
    console.error(JSON.stringify({ message: "website rollup failed", error: String(err) }));
  }
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
 * still be known when it's sent again. Return-page claims and checkout-link
 * clicks are kept 90.
 */
async function prunePaymentEvents(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM payment_events WHERE received_at < ?1").bind(now - 400 * 86400),
    db.prepare("DELETE FROM payment_claims WHERE claimed_at < ?1").bind(now - 90 * 86400),
    // Checkout-link clicks wait 90 days for their payment, like return-page claims.
    db.prepare("DELETE FROM link_clicks WHERE clicked_at < ?1").bind(now - 90 * 86400),
  ]);
}

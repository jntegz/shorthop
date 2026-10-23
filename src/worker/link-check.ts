// Destination checks: visits each link's target on a schedule and records
// whether it still loads. A target shared by several links is checked once.
//
// Budget: a Free-plan invocation may make 50 outbound requests, and every
// redirect hop is one. A run stops starting new checks when its budget is
// nearly spent; whatever is left stays due and is picked up next time, the
// longest-waiting first.
//
// Safety: only links' own targets are ever fetched (never a URL from a
// request), redirects are followed by hand so every hop is checked against
// private and reserved addresses, bodies are never read, and no cookies or
// credentials are sent.

import { linkLabel } from "../shared/domains";
import { escapeHtml } from "../shared/html";
import {
  CHECK_TIMEOUT_MS,
  DOWN_AFTER_FAILS,
  classifyStatus,
  isCheckProblem,
  isFetchableUrl,
  MAX_HOPS,
  nextRecord,
  problemText,
  STATE_LABEL,
  type CheckOutcome,
  type CheckProblem,
  type CheckRecord,
  type CheckStatus,
} from "../shared/link-check";
import type { CheckSettings, LinkChecksDTO, TargetCheckDTO } from "../shared/types";
import { getSetting, nowSec, setSettingStmt } from "./db";
import { domainsOf } from "./domains";
import { MailerError, mailerStatus, sendMail, withMailSettings } from "./mailer";
import { emit } from "./webhooks";

/** Outbound requests one run may spend on checks (leaves room for an email). */
export const RUN_BUDGET = 40;
/** Most destinations one scheduled run looks at. */
export const RUN_LIMIT = 25;
/** Concurrent checks in a run. */
const POOL = 4;
/** A check is only started with at least this much budget left. */
const MIN_BUDGET_PER_CHECK = 3;
/** Spreads rechecks so they don't all fall due in the same run. */
const JITTER_SEC = 30 * 60;
/** Must match the cron in wrangler.jsonc. */
export const RUNS_PER_DAY = 48;

/** Sent with every check. Browser-like, so fewer sites refuse it, and named, so site owners can tell what it is. */
export const CHECK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 ShorthopLinkCheck/1.0";

const SETTINGS_KEY = "link_checks";
export const DEFAULT_CHECK_SETTINGS: CheckSettings = { enabled: true, notify: true };

export async function getCheckSettings(db: D1Database): Promise<CheckSettings> {
  try {
    const saved = JSON.parse((await getSetting(db, SETTINGS_KEY)) ?? "{}") as Partial<CheckSettings>;
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_CHECK_SETTINGS.enabled,
      notify: typeof saved.notify === "boolean" ? saved.notify : DEFAULT_CHECK_SETTINGS.notify,
    };
  } catch {
    return { ...DEFAULT_CHECK_SETTINGS };
  }
}

export async function saveCheckSettings(db: D1Database, s: CheckSettings): Promise<void> {
  await setSettingStmt(db, SETTINGS_KEY, JSON.stringify(s)).run();
}

/** Outbound requests left in this invocation. */
export interface Budget {
  left: number;
}

class OutOfBudget extends Error {}

/** Cloudflare's own 52x answers say what went wrong between it and the site. */
function cloudflareProblem(status: number): CheckProblem | null {
  if (status === 530) return "dns";
  if (status === 525 || status === 526) return "tls";
  if (status === 522 || status === 524) return "timeout";
  if (status === 521 || status === 523) return "network";
  return null;
}

function errorProblem(err: unknown): CheckProblem {
  const name = (err as { name?: string } | null)?.name ?? "";
  const msg = String(err);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(msg)) return "timeout";
  if (/dns|resolve|not known|ENOTFOUND|no such host/i.test(msg)) return "dns";
  if (/tls|ssl|certificate|handshake/i.test(msg)) return "tls";
  return "network";
}

/**
 * Checks one URL: HEAD first, then GET where HEAD isn't answered properly,
 * following up to MAX_HOPS redirects by hand. Returns null when the budget ran
 * out before an answer (the target stays due).
 */
export async function checkUrl(target: string, budget: Budget, fetcher: typeof fetch = fetch): Promise<CheckOutcome | null> {
  const started = Date.now();
  const deadline = started + CHECK_TIMEOUT_MS;
  const done = (o: Omit<CheckOutcome, "ms">): CheckOutcome => ({ ...o, ms: Date.now() - started });
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return done({ kind: "fail", httpStatus: null, problem: "client_error", finalUrl: null, hops: 0 });
  }
  const finalUrl = () => (url.href === target ? null : url.href);

  const request = async (method: "HEAD" | "GET"): Promise<Response> => {
    if (budget.left <= 0) throw new OutOfBudget();
    budget.left--;
    const res = await fetcher(url.href, {
      method,
      redirect: "manual",
      cache: "no-store",
      headers: {
        "User-Agent": CHECK_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en;q=0.9",
      },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    // The body is never needed; release the connection.
    await res.body?.cancel().catch(() => undefined);
    return res;
  };

  try {
    for (let hops = 0; ; hops++) {
      if (!isFetchableUrl(url)) return done({ kind: "fail", httpStatus: null, problem: "unsafe_redirect", finalUrl: finalUrl(), hops });
      let res = await request("HEAD");
      // Plenty of servers answer HEAD wrongly; only a GET's answer is trusted for a failure.
      if (res.status >= 400) res = await request("GET");
      const location = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hops >= MAX_HOPS) return done({ kind: "fail", httpStatus: res.status, problem: "too_many_redirects", finalUrl: finalUrl(), hops });
        try {
          url = new URL(location, url);
        } catch {
          return done({ kind: "fail", httpStatus: res.status, problem: "client_error", finalUrl: finalUrl(), hops });
        }
        continue;
      }
      const viaCloudflare = cloudflareProblem(res.status);
      if (viaCloudflare) return done({ kind: "fail", httpStatus: res.status, problem: viaCloudflare, finalUrl: finalUrl(), hops });
      const challenged = res.headers.get("cf-mitigated") === "challenge";
      const { kind, problem } = classifyStatus(res.status, challenged);
      return done({ kind, httpStatus: res.status, problem, finalUrl: finalUrl(), hops });
    }
  } catch (err) {
    if (err instanceof OutOfBudget) return null;
    return done({ kind: "fail", httpStatus: null, problem: errorProblem(err), finalUrl: finalUrl(), hops: 0 });
  }
}

interface CheckRow {
  target: string;
  status: CheckStatus;
  http_status: number | null;
  problem: string | null;
  final_url: string | null;
  hops: number;
  ms: number | null;
  fails: number;
  checked_at: number;
  last_ok_at: number | null;
  since: number;
  next_at: number;
  notified: number;
}

const toRecord = (r: CheckRow): CheckRecord => ({ status: r.status, fails: r.fails, since: r.since, lastOkAt: r.last_ok_at, notified: r.notified === 1 });

/**
 * Links whose destinations are checked: live (active, not expired, not marked
 * as not working) and not excluded. Used on link_destinations, which lists a
 * link's target and every destination of its enabled routing rules.
 */
const MONITORED = (now: string) => `active = 1 AND broken = 0 AND monitor = 1 AND (expires_at IS NULL OR expires_at > ${now})`;

/** Targets due now, the longest-waiting first (never-checked ones before all). */
async function dueTargets(db: D1Database, now: number, limit: number, only?: "problems"): Promise<{ target: string; row: CheckRow | null }[]> {
  const filter = only === "problems" ? "AND (c.target IS NULL OR c.status IN ('warning', 'down'))" : "AND (c.next_at IS NULL OR c.next_at <= ?1)";
  const { results } = await db
    .prepare(
      `SELECT t.target, c.status, c.http_status, c.problem, c.final_url, c.hops, c.ms, c.fails, c.checked_at, c.last_ok_at, c.since, c.next_at, c.notified
       FROM (SELECT DISTINCT url AS target FROM link_destinations WHERE ${MONITORED("?1")}) t
       LEFT JOIN target_checks c ON c.target = t.target
       WHERE 1 = 1 ${filter}
       ORDER BY c.next_at IS NOT NULL, c.next_at
       LIMIT ?2`,
    )
    .bind(now, limit)
    .all<CheckRow & { status: CheckStatus | null }>();
  return results.map((r) => ({ target: r.target, row: r.status === null ? null : r }));
}

export interface CheckRunResult {
  checked: number;
  /** Due targets this run couldn't get to (budget or limit). */
  remaining: number;
  /** Targets that turned "down" in this run and haven't been emailed. */
  newlyDown: string[];
  /** Emailed-as-down targets that work again. */
  recovered: string[];
}

/** Checks the given targets (in order, within the budget) and stores the results. */
async function checkAndStore(
  env: Env,
  items: { target: string; row: CheckRow | null }[],
  budget: Budget,
  fetcher: typeof fetch,
): Promise<CheckRunResult> {
  const now = nowSec();
  const queue = [...items];
  const results: { target: string; prev: CheckRow | null; outcome: CheckOutcome }[] = [];
  const worker = async () => {
    while (queue.length && budget.left >= MIN_BUDGET_PER_CHECK) {
      const item = queue.shift()!;
      const outcome = await checkUrl(item.target, budget, fetcher);
      if (outcome) results.push({ target: item.target, prev: item.row, outcome });
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, worker));

  const newlyDown: string[] = [];
  const recovered: string[] = [];
  const stmt = env.DB.prepare(
    `INSERT INTO target_checks (target, status, http_status, problem, final_url, hops, ms, fails, checked_at, last_ok_at, since, next_at, notified)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT (target) DO UPDATE SET status = excluded.status, http_status = excluded.http_status, problem = excluded.problem,
       final_url = excluded.final_url, hops = excluded.hops, ms = excluded.ms, fails = excluded.fails, checked_at = excluded.checked_at,
       last_ok_at = excluded.last_ok_at, since = excluded.since, next_at = excluded.next_at, notified = excluded.notified`,
  );
  const writes = results.map(({ target, prev, outcome }) => {
    const next = nextRecord(prev ? toRecord(prev) : null, outcome, now);
    if (next.status === "down" && !next.notified) newlyDown.push(target);
    if (prev?.notified === 1 && next.status === "ok") recovered.push(target);
    const jitter = next.status === "ok" || next.status === "blocked" ? Math.floor(Math.random() * JITTER_SEC) : 0;
    return stmt.bind(
      target,
      next.status,
      outcome.httpStatus,
      outcome.problem,
      outcome.finalUrl,
      outcome.hops,
      outcome.ms,
      next.fails,
      now,
      next.lastOkAt,
      next.since,
      next.nextAt + jitter,
      next.notified ? 1 : 0,
    );
  });
  if (writes.length) await env.DB.batch(writes);
  await emitHealthChanges(env, results, now);
  return { checked: results.length, remaining: items.length - results.length, newlyDown, recovered };
}

/**
 * link.health_changed webhooks: a destination confirmed down, or working again
 * after being down. "Problem, confirming" isn't announced: it may be a blip.
 * Sent by the next cron run.
 */
async function emitHealthChanges(env: Env, results: { target: string; prev: CheckRow | null; outcome: CheckOutcome }[], now: number): Promise<void> {
  for (const { target, prev, outcome } of results) {
    const next = nextRecord(prev ? toRecord(prev) : null, outcome, now);
    const wentDown = next.status === "down" && prev?.status !== "down";
    const cameBack = prev?.status === "down" && next.status === "ok";
    if (!wentDown && !cameBack) continue;
    const { results: links } = await env.DB.prepare("SELECT DISTINCT domain, slug, title FROM link_destinations WHERE url = ? ORDER BY domain, slug")
      .bind(target)
      .all<{ domain: string; slug: string; title: string | null }>();
    await emit(env, "link.health_changed", {
      destination: target,
      state: wentDown ? "down" : "working",
      previous_state: prev?.status ?? "unchecked",
      problem: outcome.problem,
      http_status: outcome.httpStatus,
      failing_since: wentDown ? new Date(next.since * 1000).toISOString() : null,
      links: links.map((l) => ({ ...l, short_url: `https://${l.domain}/${encodeURIComponent(l.slug)}` })),
    });
  }
}

/** The scheduled run: due targets, the email for changes, and cleanup of rows no link uses. */
export async function runLinkChecks(env: Env, opts: { budget?: Budget; fetcher?: typeof fetch; force?: boolean } = {}): Promise<CheckRunResult & { skipped?: string }> {
  const settings = await getCheckSettings(env.DB);
  if (!settings.enabled && !opts.force) return { checked: 0, remaining: 0, newlyDown: [], recovered: [], skipped: "Destination checks are turned off" };
  const budget = opts.budget ?? { left: RUN_BUDGET };
  const due = await dueTargets(env.DB, nowSec(), RUN_LIMIT);
  const result = await checkAndStore(env, due, budget, opts.fetcher ?? fetch);
  await env.DB.prepare("DELETE FROM target_checks WHERE target NOT IN (SELECT url FROM link_destinations)").run();
  if (settings.notify) await notifyChanges(env);
  return result;
}

/** "Check problems now": warnings, failures and never-checked targets, as far as one request's budget goes. */
export async function recheckProblems(env: Env, fetcher: typeof fetch = fetch): Promise<CheckRunResult> {
  const items = await dueTargets(env.DB, nowSec(), 200, "problems");
  const result = await checkAndStore(env, items, { left: RUN_BUDGET }, fetcher);
  if ((await getCheckSettings(env.DB)).notify) await notifyChanges(env);
  return result;
}

interface LinkRef {
  domain: string;
  slug: string;
  title: string | null;
  target: string;
}

/**
 * Emails the owner about targets that became "not working" and haven't been
 * reported, and about reported ones that work again. Each is reported once.
 * Never throws: a failed email is retried with the next run.
 */
export async function notifyChanges(baseEnv: Env): Promise<{ sent: boolean; reason?: string }> {
  try {
    const env = await withMailSettings(baseEnv);
    const db = env.DB;
    const { results: down } = await db
      .prepare("SELECT * FROM target_checks WHERE status = 'down' AND notified = 0 ORDER BY since")
      .all<CheckRow>();
    // A recovered target has notified = 0 again, so "back" is tracked separately.
    const backKey = "link_checks_reported";
    const reported = new Set<string>(JSON.parse((await getSetting(db, backKey)) ?? "[]") as string[]);
    const { results: nowOk } = reported.size
      ? await db.prepare("SELECT target FROM target_checks WHERE status = 'ok' AND target IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...reported])).all<{ target: string }>()
      : { results: [] as { target: string }[] };
    const back = nowOk.map((r) => r.target);
    if (!down.length && !back.length) return { sent: false, reason: "Nothing new to report" };
    if (mailerStatus(env).problem) return { sent: false, reason: "Email can't be sent" };

    const targets = [...down.map((d) => d.target), ...back];
    const { results: links } = await db
      .prepare(`SELECT DISTINCT domain, slug, title, url AS target FROM link_destinations WHERE url IN (SELECT value FROM json_each(?1)) ORDER BY domain, slug`)
      .bind(JSON.stringify(targets))
      .all<LinkRef>();
    const { subject, text, html } = renderCheckEmail(env, down, back, links);
    await sendMail(env, { from: { email: env.DIGEST_FROM, name: "Shorthop" }, to: env.DIGEST_TO, subject, text, html });

    for (const d of down) reported.add(d.target);
    for (const t of back) reported.delete(t);
    // Targets no longer stored can't come back; drop them so the list stays small.
    await db.batch([
      db.prepare("UPDATE target_checks SET notified = 1 WHERE target IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(down.map((d) => d.target))),
      setSettingStmt(db, backKey, JSON.stringify([...reported].slice(-500))),
    ]);
    console.log(JSON.stringify({ message: "link check email sent", down: down.length, back: back.length }));
    return { sent: true };
  } catch (err) {
    const reason = err instanceof MailerError ? err.code : String(err);
    console.error(JSON.stringify({ message: "link check email failed", error: reason }));
    return { sent: false, reason };
  }
}

function renderCheckEmail(env: Env, down: CheckRow[], back: string[], links: LinkRef[]): { subject: string; text: string; html: string } {
  const { admin, primary } = domainsOf(env);
  const pageUrl = `https://${admin}/_admin/health`;
  const label = (l: LinkRef) => linkLabel(l.domain, l.slug, primary);
  const linksOf = (target: string) => links.filter((l) => l.target === target);
  const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const subject = down.length
    ? `Shorthop: ${down.length === 1 ? "a link stopped working" : `${down.length} links stopped working`}`
    : `Shorthop: ${back.length === 1 ? "a link works again" : `${back.length} links work again`}`;

  const textDown = down.map((d) => {
    const names = linksOf(d.target).map(label).join(", ") || "(no links)";
    return `- ${names}\n  ${d.target}\n  ${problemText(isCheckProblem(d.problem) ? d.problem : null, d.http_status)}, failing since ${day(d.since)}`;
  });
  const textBack = back.map((t) => `- ${linksOf(t).map(label).join(", ") || t}`);
  const text = [
    down.length ? `These destinations failed ${DOWN_AFTER_FAILS} or more checks in a row:\n\n${textDown.join("\n\n")}` : "",
    back.length ? `Working again:\n${textBack.join("\n")}` : "",
    `Mark a link as no longer working, or change its destination, on the Link health page:\n${pageUrl}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const item = (d: CheckRow) => {
    const own = linksOf(d.target);
    const names = own
      .map((l) => `<a href="https://${escapeHtml(admin)}/_admin/links/${encodeURIComponent(l.domain)}/${encodeURIComponent(l.slug)}" style="color:#6554c0;font-weight:600;text-decoration:none;">${escapeHtml(label(l))}</a>`)
      .join(", ");
    return `<li style="margin:0 0 12px;">${names || "(no links)"}<br><span style="color:#656b80;font-size:13px;word-break:break-all;">${escapeHtml(d.target)}</span><br><span style="font-size:13px;">${escapeHtml(problemText(isCheckProblem(d.problem) ? d.problem : null, d.http_status))} · failing since ${escapeHtml(day(d.since))}</span></li>`;
  };
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f8f9fc;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222438;">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e6e8ef;border-radius:12px;padding:24px;">
  <div style="color:#6554c0;font-weight:700;font-size:14px;">Shorthop · Link health</div>
  ${down.length ? `<h1 style="font-size:18px;margin:8px 0 12px;">${escapeHtml(STATE_LABEL.down)}: ${down.length} ${down.length === 1 ? "destination" : "destinations"}</h1><ul style="padding-left:18px;margin:0 0 16px;">${down.map(item).join("")}</ul>` : ""}
  ${back.length ? `<h2 style="font-size:15px;margin:8px 0;">Working again</h2><p style="font-size:14px;margin:0 0 16px;">${back.map((t) => escapeHtml(linksOf(t).map(label).join(", ") || t)).join("<br>")}</p>` : ""}
  <p style="margin:16px 0 0;"><a href="${escapeHtml(pageUrl)}" style="display:inline-block;background:#6554c0;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;">Open Link health</a></p>
</div></body></html>`;
  return { subject, text, html };
}

function toDTO(target: string, row: CheckRow | undefined, links: TargetCheckDTO["links"]): TargetCheckDTO {
  return {
    target,
    state: row?.status ?? "unchecked",
    httpStatus: row?.http_status ?? null,
    problem: row && isCheckProblem(row.problem) ? row.problem : null,
    finalUrl: row?.final_url ?? null,
    hops: row?.hops ?? 0,
    ms: row?.ms ?? null,
    fails: row?.fails ?? 0,
    checkedAt: row?.checked_at ?? null,
    lastOkAt: row?.last_ok_at ?? null,
    since: row?.since ?? null,
    nextAt: row?.next_at ?? null,
    links,
  };
}

/** Everything the Link health page shows. */
export async function listChecks(env: Env): Promise<Omit<LinkChecksDTO, "lastRun">> {
  const now = nowSec();
  const db = env.DB;
  const [monitored, rows, excluded, settings] = await Promise.all([
    db.prepare(`SELECT DISTINCT domain, slug, title, url AS target FROM link_destinations WHERE ${MONITORED("?1")} ORDER BY domain, slug`).bind(now).all<LinkRef>(),
    db.prepare("SELECT * FROM target_checks").all<CheckRow>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM links WHERE monitor = 0 AND active = 1 AND broken = 0 AND (expires_at IS NULL OR expires_at > ?1)")
      .bind(now)
      .first<{ n: number }>(),
    getCheckSettings(db),
  ]);
  const byTarget = new Map(rows.results.map((r) => [r.target, r]));
  const grouped = new Map<string, TargetCheckDTO["links"]>();
  for (const l of monitored.results) {
    const list = grouped.get(l.target) ?? [];
    list.push({ domain: l.domain, slug: l.slug, title: l.title });
    grouped.set(l.target, list);
  }
  const items = [...grouped.entries()].map(([target, links]) => toDTO(target, byTarget.get(target), links));
  const overdue = items.filter((i) => i.nextAt !== null && i.nextAt < now - 3600).length + items.filter((i) => i.state === "unchecked").length;
  return { settings, items, excluded: excluded?.n ?? 0, overdue, capacityPerDay: RUNS_PER_DAY * RUN_LIMIT };
}

/** One link's checks (its target, and any smart-routing destinations), or why it isn't checked. */
export async function linkCheck(
  env: Env,
  domain: string,
  slug: string,
): Promise<{ check: TargetCheckDTO | null; routed: TargetCheckDTO[]; monitored: boolean; reason: string | null } | null> {
  const now = nowSec();
  const link = await env.DB.prepare("SELECT target, active, broken, monitor, expires_at FROM links WHERE domain = ? AND slug = ?")
    .bind(domain, slug)
    .first<{ target: string; active: number; broken: number; monitor: number; expires_at: number | null }>();
  if (!link) return null;
  const reason = !link.monitor
    ? "Checks are turned off for this link."
    : !link.active
      ? "Disabled links aren't checked."
      : link.expires_at !== null && link.expires_at <= now
        ? "Expired links aren't checked."
        : link.broken
          ? "Links marked as no longer working aren't checked."
          : null;
  const { results: urls } = await env.DB.prepare("SELECT DISTINCT url FROM link_destinations WHERE domain = ? AND slug = ? AND url != target")
    .bind(domain, slug)
    .all<{ url: string }>();
  const all = [link.target, ...urls.map((u) => u.url)];
  const [rows, users] = await Promise.all([
    env.DB.prepare("SELECT * FROM target_checks WHERE target IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(all)).all<CheckRow>(),
    env.DB.prepare(`SELECT DISTINCT domain, slug, title, url AS target FROM link_destinations WHERE url IN (SELECT value FROM json_each(?1)) AND ${MONITORED("?2")} ORDER BY domain, slug`)
      .bind(JSON.stringify(all), now)
      .all<LinkRef>(),
  ]);
  const rowOf = new Map(rows.results.map((r) => [r.target, r]));
  const dto = (url: string) => toDTO(url, rowOf.get(url), users.results.filter((u) => u.target === url).map(({ domain, slug, title }) => ({ domain, slug, title })));
  const row = rowOf.get(link.target);
  return {
    check: row || !reason ? dto(link.target) : null,
    routed: reason ? [] : urls.map((u) => dto(u.url)),
    monitored: reason === null,
    reason,
  };
}

/** Checks every destination of one link now. False when none could be checked. */
export async function checkLinkNow(env: Env, domain: string, slug: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const { results } = await env.DB.prepare(
    `SELECT d.url AS target, c.status, c.http_status, c.problem, c.final_url, c.hops, c.ms, c.fails, c.checked_at, c.last_ok_at, c.since, c.next_at, c.notified
     FROM (SELECT DISTINCT url FROM link_destinations WHERE domain = ? AND slug = ?) d LEFT JOIN target_checks c ON c.target = d.url`,
  )
    .bind(domain, slug)
    .all<CheckRow & { status: CheckStatus | null }>();
  const result = await checkAndStore(env, results.map((r) => ({ target: r.target, row: r.status === null ? null : r })), { left: RUN_BUDGET }, fetcher);
  if (result.checked && (await getCheckSettings(env.DB)).notify) await notifyChanges(env);
  return result.checked > 0;
}

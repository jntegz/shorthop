import { Hono, type Context } from "hono";
import { linkKey } from "../../shared/domains";
import { sameSnapshot, snapshotOf, type HistoryAction, type Snapshot } from "../../shared/history";
import { parsePreview, validatePreview, type LinkPreview } from "../../shared/preview";
import { validateQrStyle } from "../../shared/qr";
import { capCount, capReset } from "../click-cap";
import { hashLinkPassword } from "../link-password";
import { parseRouting, splitChanged, validateRouting, type RouteRule, type Routing, type RoutingError } from "../../shared/routing";
import { pullLinks, VendorError } from "../import/vendors";
import { destinationsOf, safetyOf, safetyOfEach, UNSAFE_FLAGGED, UNSAFE_NONE, UNSAFE_TRUSTED } from "../safety";
import { bioButtonUrls, parseBio, validateBio, type BioPage } from "../../shared/bio";
import { bulkSchema, byTargetQuerySchema, pullSchema, createLinkSchema, exportQuerySchema, importSchema, linkParamSchema, normalizeTags, restoreVersionQuerySchema, tagParamSchema, tagRenameSchema, versionParamSchema, listQuerySchema, resyncQuerySchema, updateLinkSchema } from "../../shared/schemas";
import { isCheckProblem, isChecked, MONITOR_DEFAULT, MONITOR_NEVER, MONITOR_ON, type CheckStatus } from "../../shared/link-check";
import { can, PERMISSION_INFO } from "../../shared/permissions";
import { generateSlug, validateSlug } from "../../shared/slug";
import { normalizeTarget, validateUtmTemplate } from "../../shared/target";
import type { BulkResult, CapDTO, ImportResult, ImportRowResult, LinkDTO, LinkListItem } from "../../shared/types";
import { fullTokenScope, TOKEN_SCOPE_ERROR } from "../auth";
import { getDefaultUtm, getLink, kvKey, nowSec, OFF_HOME, publish, splitKey, toDTO, toKv, type LinkRow } from "../db";
import { configuredDomains, domainsOf, isConfiguredDomain, NO_DOMAIN_ERROR, selfHosts, shortOrigin } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { planLimits } from "../plan";
import { changedFields, emit, emitAll, linkPayload, type Event } from "../webhooks";
import { deletedLinks, getVersion, listVersions, savedVersionStmt, SNAPSHOT_SQL, versionStmt } from "../history";
import { clicksByLink } from "../stats-data";
import { checkedSql, getCheckSettings } from "../link-check";

function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(err));
}

/** A link as the API returns it, with the short URL of its own domain. */
function dto(c: Context<AppEnv>, row: LinkRow): LinkDTO {
  const link = toDTO(row, shortOrigin(c.env, c.req.raw, row.domain));
  // Clicks counted before an import are statistics too.
  const shown = seesStats(c) ? link : { ...link, importedClicks: null };
  return link.protected && !seesProtected(c) ? { ...shown, target: "", notes: "", utmTemplate: null, routing: null, bio: null } : shown;
}

const seesStats = (c: Context<AppEnv>) => can(c.get("actor"), "stats.view");
/** Where a password-protected link goes, and its notes: for people who can edit links. */
const seesProtected = (c: Context<AppEnv>) => can(c.get("actor"), "links.edit");

/**
 * Tags this person may not put on a link, with why: a tag report publishes the
 * statistics (and maybe revenue) of every link with its tag, so tagging a link
 * needs what that report shows. An expired report counts too: extending it brings
 * back every link with its tag. Only a revoked one, which can't return, doesn't.
 */
async function reportTagProblems(c: Context<AppEnv>, tags: string[]): Promise<Map<string, string>> {
  const problems = new Map<string, string>();
  const actor = c.get("actor");
  const stats = can(actor, "stats.view");
  const revenue = can(actor, "revenue.view");
  if (!tags.length || (stats && revenue)) return problems;
  const { results } = await c.env.DB.prepare(
    `SELECT tag, MAX(show_revenue) AS revenue FROM stat_shares
     WHERE scope = 'tag' AND revoked_at IS NULL AND tag IN (SELECT value FROM json_each(?1))
     GROUP BY tag`,
  )
    .bind(JSON.stringify([...new Set(tags)]))
    .all<{ tag: string; revenue: number }>();
  for (const r of results) {
    const missing = !stats ? "stats.view" : r.revenue === 1 && !revenue ? "revenue.view" : null;
    if (missing) problems.set(r.tag, `tags: "${r.tag}" feeds a shared report, so adding it to a link needs the ${PERMISSION_INFO[missing].label} permission.`);
  }
  return problems;
}

/** Why the tags this request adds can't be added (one feeds a report the person may not extend); null when they can. */
async function refusedTags(c: Context<AppEnv>, added: string[]): Promise<string | null> {
  const [problem] = (await reportTagProblems(c, added)).values();
  return problem ?? null;
}

/** Tags in `next` that `before` doesn't have (comma-separated, as stored). */
const addedTags = (before: string, next: string) => {
  const had = new Set(before.split(","));
  return next.split(",").filter((t) => t && !had.has(t));
};

const notConfigured = (domain: string) => `domain: "${domain}" is not one of your short domains (SHORT_DOMAINS).`;

function insertStmt(db: D1Database, r: LinkRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, broken, replacement, off_redirect, monitor, routing, preview, qr, password_hash, max_clicks, unsafe, unsafe_at, bio, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.domain, r.slug, r.target, r.active, r.expires_at, r.utm, r.utm_template, r.pass_query, r.title, r.tags, r.notes, r.source, r.imported_clicks, r.broken, r.replacement, r.off_redirect, r.monitor, r.routing, r.preview, r.qr, r.password_hash, r.max_clicks, r.unsafe ?? 0, r.unsafe_at ?? null, r.bio ?? null, r.created_at, r.updated_at);
}

/** What an edit can change on a link, column by column. */
const EDITED_COLUMNS = ["target", "active", "expires_at", "utm", "utm_template", "pass_query", "title", "tags", "notes", "broken", "replacement", "off_redirect", "monitor", "routing", "preview", "qr", "password_hash", "max_clicks", "bio"] as const satisfies readonly (keyof LinkRow)[];

const newRev = () => crypto.randomUUID().slice(0, 13);

/**
 * Saves an edit: only the columns that differ from `before`, the row this edit
 * was worked out from, so two edits at once can't undo each other's other
 * fields. Every change gets a new `rev`. With `expected` the write only goes
 * through while the link is still at that version. New destinations are new to
 * the security-DNS backlog too: failed lookups of the old ones don't put them
 * last (src/worker/health.ts).
 */
function updateStmt(db: D1Database, before: LinkRow, r: LinkRow, rev: string, expected?: string): D1PreparedStatement {
  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    binds.push(value);
  };
  for (const column of EDITED_COLUMNS) if ((r[column] ?? null) !== (before[column] ?? null)) set(column, r[column] ?? null);
  if ((r.unsafe ?? null) !== (before.unsafe ?? null)) set("unsafe", r.unsafe ?? 0);
  if ((r.unsafe_at ?? null) !== (before.unsafe_at ?? null)) set("unsafe_at", r.unsafe_at ?? null);
  if (r.target !== before.target || (r.routing ?? null) !== (before.routing ?? null)) sets.push("unsafe_tried_at = NULL");
  // Saving without a change (to publish again) is no new version.
  if (sets.length) set("rev", rev);
  set("updated_at", r.updated_at);
  binds.push(r.domain, r.slug);
  if (expected !== undefined) binds.push(expected);
  return db.prepare(`UPDATE links SET ${sets.join(", ")} WHERE domain = ? AND slug = ?${expected !== undefined ? " AND COALESCE(rev, '0') = ?" : ""} RETURNING *`).bind(...binds);
}

/** Publishes a saved link to KV; false when that failed (it's saved in D1 either way: answer 502 with the link). */
async function published(env: Env, row: LinkRow): Promise<boolean> {
  try {
    await publishSaved(env, row);
    return true;
  } catch (err) {
    console.error(JSON.stringify({ message: "kv publish failed", domain: row.domain, slug: row.slug, error: String(err) }));
    return false;
  }
}

/** Whether two states of a link publish the same record ("" stands in for the default UTM template on both sides). */
const samePublished = (a: LinkRow, b: LinkRow) => JSON.stringify(toKv(a, "")) === JSON.stringify(toKv(b, ""));

/**
 * Publishes a saved link and reads it back. Two saves can reach KV in the
 * opposite order from D1; whoever publishes last then sees that D1 holds
 * something else and publishes that, so KV ends up matching D1. "gone": the
 * link was deleted meanwhile, and its record is removed again.
 */
async function publishLatest(env: Env, saved: LinkRow): Promise<"ok" | "failed" | "gone"> {
  let row = saved;
  for (let round = 0; round < 3; round++) {
    if (!(await published(env, row))) return "failed";
    const latest = await getLink(env.DB, row.domain, row.slug);
    if (!latest) {
      // Together with the delete's second KV pass, KV ends up matching D1 whichever way the two interleave.
      await env.LINKS.delete(kvKey(row.domain, row.slug));
      return "gone";
    }
    if (samePublished(latest, row)) return "ok";
    row = latest;
  }
  return "ok";
}

/** The answer when `version` no longer matches. It names the current version so a client can read the link and decide. */
const versionConflict = (c: Context<AppEnv>, current: LinkRow) =>
  c.json({ error: "This link was changed since you loaded it. Load it again and repeat your change.", code: "version_conflict", version: current.rev ?? "0" }, 409);

/**
 * Saves an edit of an existing link, with a version when `record` says what
 * to call it, runs onSaved (webhook events) once D1 has it, then publishes it.
 * RETURNING: a link deleted since it was read must not be published back to KV.
 */
async function saveEdit(c: Context<AppEnv>, before: LinkRow, next: LinkRow, record: { action: HistoryAction; restoredFrom?: number } | null, opts: { expected?: string; onSaved?: (saved: LinkRow) => Promise<void> } = {}) {
  const rev = newRev();
  const [updated] = await c.env.DB.batch<LinkRow>([
    updateStmt(c.env.DB, before, next, rev, opts.expected),
    ...(record ? [savedVersionStmt(c.env.DB, next, rev, record.action, c.get("identity"), { at: next.updated_at, restoredFrom: record.restoredFrom })] : []),
  ]);
  const saved = updated?.results[0];
  if (!saved) {
    const current = opts.expected !== undefined ? await getLink(c.env.DB, next.domain, next.slug) : null;
    return current ? versionConflict(c, current) : c.json({ error: "Link not found" }, 404);
  }
  await opts.onSaved?.(saved);
  const outcome = await publishLatest(c.env, saved);
  if (outcome === "failed") return c.json({ error: PUBLISH_FAILED, link: dto(c, saved) }, 502);
  if (outcome === "gone") return c.json({ error: "Link not found" }, 404);
  return c.json({ link: dto(c, saved) });
}

const SEVERITY: Record<CheckStatus, number> = { down: 3, warning: 2, blocked: 1, ok: 0 };
function worstCheck<T extends { status: CheckStatus }>(checks: (T | undefined)[]): T | undefined {
  let worst: T | undefined;
  for (const ch of checks) if (ch && (!worst || SEVERITY[ch.status] > SEVERITY[worst.status])) worst = ch;
  return worst;
}

type RoutingInput = { rules: Omit<RouteRule, never>[] } | null | undefined;

/**
 * The routing JSON to store: unchanged when not sent, null when turned off,
 * otherwise validated. changedAt moves only when destinations or weights do,
 * so results before it aren't mixed with the new setup.
 */
function routingFor(c: Context<AppEnv>, input: RoutingInput, prev: string | null): { ok: true; json: string | null } | { ok: false; error: string; details: RoutingError[] } {
  if (input === undefined) return { ok: true, json: prev };
  if (input === null || input.rules.length === 0) return { ok: true, json: null };
  const checked = validateRouting(input, { selfHosts: selfHosts(c.env, c.req.raw) });
  if (!checked.ok) {
    const first = checked.errors[0]!;
    return { ok: false, error: `routing: ${first.rule >= 0 ? `Rule ${first.rule + 1}: ` : ""}${first.message}`, details: checked.errors };
  }
  const before = parseRouting(prev);
  const changedAt = before && !splitChanged(before.rules, checked.rules) ? before.changedAt : nowSec();
  const routing: Routing = { rules: checked.rules, changedAt };
  return { ok: true, json: JSON.stringify(routing) };
}

/** Zeroes a link's click counter. Logged, not fatal: the link itself is saved. */
async function resetCounter(env: Env, row: LinkRow): Promise<void> {
  try {
    await capReset(env, row.domain, row.slug);
  } catch (err) {
    console.error(JSON.stringify({ message: "click counter reset failed", domain: row.domain, slug: row.slug, error: String(err) }));
  }
}

type PreviewInput = LinkPreview | null | undefined;

/** The preview JSON to store: unchanged when not sent, null when turned off, otherwise validated. */
function previewFor(input: PreviewInput, prev: string | null): { ok: true; json: string | null } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, json: prev };
  if (input === null) return { ok: true, json: null };
  const checked = validatePreview(input);
  if (!checked.ok) return { ok: false, error: `preview: ${checked.problems[0]!.message}` };
  return { ok: true, json: JSON.stringify(checked.preview) };
}

/** A link with an older version's fields, saved now. */
function withSnapshot(row: LinkRow, s: Snapshot, now = nowSec()): LinkRow {
  return {
    ...row,
    target: s.target,
    active: s.active,
    expires_at: s.expires_at,
    utm: s.utm,
    utm_template: s.utm_template,
    pass_query: s.pass_query,
    title: s.title,
    tags: s.tags,
    notes: s.notes,
    broken: s.broken,
    replacement: s.replacement,
    off_redirect: s.off_redirect ?? null,
    monitor: s.monitor ?? 1,
    routing: s.routing ?? null,
    preview: s.preview ?? null,
    qr: s.qr ?? null,
    password_hash: s.password_hash ?? null,
    max_clicks: s.max_clicks ?? null,
    bio: s.bio ?? null,
    updated_at: now,
  };
}

/** Rules may have tightened since a version was saved; a restore must still pass them. */
function restoreProblem(c: Context<AppEnv>, r: LinkRow): string | null {
  const target = normalizeTarget(r.target, { allowHttp: r.source === "import", selfHosts: selfHosts(c.env, c.req.raw) });
  if (!target.ok) return `This version can't be restored: ${target.error}`;
  if (r.utm_template) {
    const err = validateUtmTemplate(r.utm_template);
    if (err) return `This version can't be restored: utmTemplate: ${err}`;
  }
  if (r.replacement === linkKey(r.domain, r.slug)) return "This version can't be restored: a link can't replace itself.";
  if (r.off_redirect === linkKey(r.domain, r.slug)) return "This version can't be restored: a link can't send visitors to itself.";
  const preview = parsePreview(r.preview);
  if (preview && !validatePreview(preview).ok) return "This version can't be restored: its social preview is no longer valid.";
  const routing = parseRouting(r.routing);
  if (routing) {
    const checked = validateRouting(routing, { selfHosts: selfHosts(c.env, c.req.raw) });
    if (!checked.ok) return `This version can't be restored: smart routing: ${checked.errors[0]!.message}`;
  }
  const bio = parseBio(r.bio);
  if (bio) {
    const checked = validateBio(bio, { selfHosts: selfHosts(c.env, c.req.raw) });
    if (!checked.ok) return `This version can't be restored: bio page: ${checked.problems[0]!.message}`;
  }
  return null;
}

/**
 * The bio JSON to store: unchanged when not sent, null to turn it off,
 * otherwise checked, and its buttons' short links must exist (here, now).
 */
async function bioFor(c: Context<AppEnv>, input: BioPage | null | undefined, prev: string | null): Promise<{ ok: true; json: string | null } | { ok: false; error: string }> {
  if (input === undefined) return { ok: true, json: prev };
  if (input === null) return { ok: true, json: null };
  const checked = validateBio(input, { selfHosts: selfHosts(c.env, c.req.raw) });
  if (!checked.ok) return { ok: false, error: `bio: ${checked.problems[0]!.message}` };
  const linked = checked.bio.blocks.flatMap((b) => ("link" in b ? [linkKey(b.link.domain, b.link.slug)] : []));
  if (linked.length) {
    const { results } = await c.env.DB.prepare("SELECT domain || '/' || slug AS k FROM links WHERE (domain || '/' || slug) IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify(linked))
      .all<{ k: string }>();
    const found = new Set(results.map((r) => r.k));
    const missing = linked.find((k) => !found.has(k));
    if (missing) return { ok: false, error: `bio: ${missing} doesn't exist.` };
  }
  return { ok: true, json: JSON.stringify(checked.bio) };
}

/**
 * Looks a link's destinations up at the security DNS (the target and every
 * enabled routing variant) and sets its flag. A lookup that failed, or a host
 * past the request's lookups, is no answer: unsafe_at stays empty and the
 * cron's backlog looks it up (src/worker/health.ts).
 */
async function checkSafety(env: Env, row: Pick<LinkRow, "target" | "routing" | "unsafe" | "unsafe_at">): Promise<void> {
  const safety = await safetyOf(env, destinationsOf(row.target, row.routing), planLimits(env).inlineLookups);
  row.unsafe = safety === "flagged" ? UNSAFE_FLAGGED : UNSAFE_NONE;
  row.unsafe_at = safety === "unknown" ? null : nowSec();
}

/** stat_shares rows that still work (not revoked, not expired), for the links list. */
const ACTIVE_SHARE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())";

/** The links list's filters as SQL (shared by the list and its export). */
/** Escapes LIKE wildcards for a pattern used with ESCAPE '\'. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function listFilter(f: { domain?: string; q?: string; tag?: string; status: string }, scope: Parameters<typeof checkedSql>[0], hideProtected: boolean): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.domain) {
    params.push(f.domain);
    where.push(`domain = ?${params.length}`);
  }
  if (f.q) {
    params.push(`%${likeEscape(f.q)}%`);
    const n = params.length;
    // Searching a hidden destination or note would reveal it, a guess at a time.
    const hidden = `(target LIKE ?${n} ESCAPE '\\' OR notes LIKE ?${n} ESCAPE '\\')`;
    where.push(`(slug LIKE ?${n} ESCAPE '\\' OR title LIKE ?${n} ESCAPE '\\' OR ${hideProtected ? `(password_hash IS NULL AND ${hidden})` : hidden})`);
  }
  if (f.tag) {
    params.push(`%,${likeEscape(f.tag)},%`);
    where.push(`(',' || tags || ',') LIKE ?${params.length} ESCAPE '\\'`);
  }
  const now = nowSec();
  if (f.status === "active") where.push(`active = 1 AND (expires_at IS NULL OR expires_at > ${now}) AND broken = 0`);
  if (f.status === "broken") where.push(`active = 1 AND (expires_at IS NULL OR expires_at > ${now}) AND broken = 1`);
  if (f.status === "disabled") where.push("active = 0");
  if (f.status === "expired") where.push(`expires_at IS NOT NULL AND expires_at <= ${now}`);
  if (f.status === "shared") where.push(`(domain, slug) IN (SELECT domain, slug FROM stat_shares WHERE ${ACTIVE_SHARE})`);
  if (f.status === "bio") where.push("bio IS NOT NULL");
  if (f.status === "failing") {
    where.push(`active = 1 AND (expires_at IS NULL OR expires_at > ${now}) AND broken = 0 AND ${checkedSql(scope)}`);
    where.push(
      "(domain, slug) IN (SELECT domain, slug FROM link_destinations WHERE url IN (SELECT target FROM target_checks WHERE status IN ('warning', 'down')))",
    );
  }
  return { where, params };
}

/** Renames (to) or removes (to = null) a tag across links: D1 only, since tags aren't published. */
async function retag(c: Context<AppEnv>, from: string, to: string | null): Promise<{ changed: number }> {
  const pattern = `%,${from.replace(/[\\%_]/g, (m) => `\\${m}`)},%`;
  const { results } = await c.env.DB.prepare("SELECT * FROM links WHERE (',' || tags || ',') LIKE ? ESCAPE '\\'").bind(pattern).all<LinkRow>();
  if (!results.length) return { changed: 0 };
  const now = nowSec();
  const identity = c.get("identity");
  const updates = results.map((r) => {
    const tags = normalizeTags(r.tags.split(",").flatMap((t) => (t === from ? (to ? [to] : []) : [t])));
    return { before: r, after: { ...r, tags: tags.join(","), updated_at: now }, rev: newRev() };
  });
  await c.env.DB.batch(updates.flatMap(({ before, after, rev }) => [updateStmt(c.env.DB, before, after, rev), savedVersionStmt(c.env.DB, after, rev, "update", identity, { at: now })]));
  await emitAll(c.env, updates.map(({ before, after }) => ({ type: "link.updated", data: { link: linkPayload(after), changes: changedFields(before, after) } })), { ctx: c.executionCtx });
  return { changed: updates.length };
}

const PUBLISH_FAILED = "Saved, but publishing to KV failed. Save it again in a minute, or use “Republish all links” in Settings → General.";

/** Rows GET /links returns at most. */
const LIST_LIMIT = 5000;

/** Publishes a link D1 already holds, trying once more after a short pause (KV writes can fail transiently). */
async function publishSaved(env: Env, row: LinkRow): Promise<void> {
  const defaultUtm = await getDefaultUtm(env.DB);
  try {
    await publish(env, row, defaultUtm);
  } catch {
    await new Promise((r) => setTimeout(r, 300));
    await publish(env, row, defaultUtm);
  }
}

export const linksApi = new Hono<AppEnv>()
  .get("/links", validate("query", listQuerySchema), async (c) => {
    const { domain, q, tag, status, sort, period } = c.req.valid("query");
    const { scope } = await getCheckSettings(c.env.DB);
    const { where, params } = listFilter({ domain, q, tag, status }, scope, !seesProtected(c));
    // Click counts are statistics: only for people who may see those.
    const seesClicks = can(c.get("actor"), "stats.view");
    const counts = seesClicks
      ? Promise.all([clicksByLink(c.env, "all"), period === "all" ? null : clicksByLink(c.env, period)])
      : Promise.resolve<[Map<string, number>, Map<string, number> | null]>([new Map(), null]);
    let order = sort === "slug" ? "slug COLLATE NOCASE ASC, domain" : sort === "updated" ? "updated_at DESC" : "created_at DESC";
    let join = "";
    if (sort === "clicks") {
      // Rank in SQL too, so the cap keeps the most clicked links rather than the newest.
      // The unranked rest (fewer clicks than any ranked link) follows newest first.
      const [totals, inPeriod] = await counts;
      const byPeriod = inPeriod ?? totals;
      const ranked = [...new Set([...byPeriod.keys(), ...totals.keys()])]
        .map((key) => ({ key, p: byPeriod.get(key) ?? 0, t: totals.get(key) ?? 0 }))
        .filter((r) => r.p > 0 || r.t > 0)
        .sort((a, b) => b.p - a.p || b.t - a.t)
        .slice(0, LIST_LIMIT);
      params.push(JSON.stringify(ranked.map((r) => r.key)));
      join = ` LEFT JOIN json_each(?${params.length}) r ON r.value = links.domain || '/' || links.slug`;
      order = "r.key IS NULL, r.key, created_at DESC";
    }
    const sql = `SELECT links.* FROM links${join} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ${LIST_LIMIT}`;
    const [{ results }, [totals, inPeriod], checks, shared] = await Promise.all([
      c.env.DB.prepare(sql)
        .bind(...params)
        .all<LinkRow>(),
      counts,
      // A refused destination a person confirmed counts as working, as on Link health (src/worker/link-check.ts).
      c.env.DB.prepare("SELECT target, CASE WHEN status = 'blocked' AND confirmed_at IS NOT NULL THEN 'ok' ELSE status END AS status, problem, http_status, checked_at FROM target_checks").all<{
        target: string;
        status: CheckStatus;
        problem: string | null;
        http_status: number | null;
        checked_at: number;
      }>(),
      c.env.DB.prepare(`SELECT domain, slug, COUNT(*) AS n FROM stat_shares WHERE ${ACTIVE_SHARE} GROUP BY domain, slug`).all<{ domain: string; slug: string; n: number }>(),
    ]);
    const shareCount = new Map(shared.results.map((r) => [linkKey(r.domain, r.slug), r.n]));
    const clicks = inPeriod ?? totals;
    const checkOf = new Map(checks.results.map((r) => [r.target, r]));
    let links: LinkListItem[] = results.map((r) => {
      const key = linkKey(r.domain, r.slug);
      // The worst state across the target, every routed destination and the bio page's own buttons.
      const urls = [r.target, ...(parseRouting(r.routing)?.rules.filter((x) => x.enabled).flatMap((x) => x.variants.map((v) => v.url)) ?? []), ...bioButtonUrls(parseBio(r.bio))];
      const ch = isChecked(r.monitor, scope) ? worstCheck(urls.map((u) => checkOf.get(u))) : undefined;
      return {
        ...dto(c, r),
        clicksPeriod: clicks.get(key) ?? 0,
        clicksTotal: totals.get(key) ?? 0,
        shares: shareCount.get(key) ?? 0,
        check: ch ? { state: ch.status, problem: isCheckProblem(ch.problem) ? ch.problem : null, httpStatus: ch.http_status, checkedAt: ch.checked_at } : null,
      };
    });
    if (sort === "clicks") links = links.sort((a, b) => b.clicksPeriod - a.clicksPeriod || b.clicksTotal - a.clicksTotal);
    return c.json({ links });
  })

  /** Links that already go to this destination (the link form warns before making another). */
  .get("/links/by-target", validate("query", byTargetQuerySchema), async (c) => {
    const target = normalizeTarget(c.req.valid("query").url, { allowHttp: true, selfHosts: selfHosts(c.env, c.req.raw) });
    if (!target.ok) return c.json({ links: [] });
    // A protected link would confirm where it goes.
    const { results } = await c.env.DB.prepare(`SELECT * FROM links WHERE target = ?${seesProtected(c) ? "" : " AND password_hash IS NULL"} ORDER BY created_at LIMIT 10`).bind(target.url).all<LinkRow>();
    return c.json({ links: results.map((r) => dto(c, r)) });
  })

  /**
   * One action on many links: enable, disable, add or remove a tag, delete.
   * Each change keeps a version and sends its webhook, as one at a time would.
   * The plan caps a request (bulkRows); the admin sends a big selection in parts.
   */
  .post("/links/bulk", validate("json", bulkSchema), async (c) => {
    const { links, action, tag: rawTag } = c.req.valid("json");
    const actor = c.get("actor");
    const needs = action === "delete" ? "links.delete" : "links.edit";
    if (!can(actor, needs)) return c.json({ error: `This needs the ${needs} permission.`, code: "forbidden" }, 403);
    const { bulkRows } = planLimits(c.env);
    if (links.length > bulkRows) {
      return c.json({ error: `Change at most ${bulkRows} links per request on this Workers plan; send the rest in further requests.`, code: "too_many_rows" }, 413);
    }
    const tag = normalizeTags([rawTag ?? ""])[0] ?? "";
    if (action === "addTag") {
      const refused = await refusedTags(c, [tag]);
      if (refused) return c.json({ error: refused, code: "forbidden" }, 403);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM links WHERE (domain, slug) IN (SELECT json_extract(value, '$.domain'), json_extract(value, '$.slug') FROM json_each(?))`,
    )
      .bind(JSON.stringify(links))
      .all<LinkRow>();
    const found = new Map(results.map((r) => [linkKey(r.domain, r.slug), r]));
    const result: BulkResult = { changed: 0, unchanged: 0, failed: [] };
    const seen = new Set<string>();
    const rows: LinkRow[] = [];
    for (const l of links) {
      const key = linkKey(l.domain, l.slug);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = found.get(key);
      if (row) rows.push(row);
      else result.failed.push({ ...l, error: "Link not found" });
    }
    const identity = c.get("identity");
    const now = nowSec();

    if (action === "delete") {
      // KV first, as for one link: a failure leaves the link in D1 to delete again.
      const removed = await Promise.all(
        rows.map(async (r) => {
          try {
            await c.env.LINKS.delete(kvKey(r.domain, r.slug));
            return r;
          } catch (err) {
            console.error(JSON.stringify({ message: "kv delete failed", domain: r.domain, slug: r.slug, error: String(err) }));
            result.failed.push({ domain: r.domain, slug: r.slug, error: "Couldn't remove it from KV; try again." });
            return null;
          }
        }),
      );
      const gone = removed.filter((r): r is LinkRow => r !== null);
      if (gone.length) {
        await c.env.DB.batch(
          gone.flatMap((r) => [
            c.env.DB.prepare("DELETE FROM links WHERE domain = ? AND slug = ?").bind(r.domain, r.slug),
            versionStmt(c.env.DB, r, "delete", identity),
            c.env.DB.prepare("UPDATE stat_shares SET revoked_at = ? WHERE domain = ? AND slug = ? AND revoked_at IS NULL").bind(now, r.domain, r.slug),
          ]),
        );
        await emitAll(c.env, gone.map((r) => ({ type: "link.deleted", data: { link: linkPayload(r) } })), { ctx: c.executionCtx });
      }
      result.changed = gone.length;
      return c.json(result);
    }

    const changed: { before: LinkRow; after: LinkRow; rev: string }[] = [];
    for (const r of rows) {
      const next: LinkRow = { ...r, updated_at: now };
      if (action === "enable" || action === "disable") next.active = action === "enable" ? 1 : 0;
      else {
        const current = r.tags ? r.tags.split(",") : [];
        const tags = action === "addTag" ? normalizeTags([...current, tag]) : current.filter((t) => t !== tag);
        next.tags = tags.join(",");
      }
      if (next.active === r.active && next.tags === r.tags) result.unchanged++;
      else changed.push({ before: r, after: next, rev: newRev() });
    }
    let saved: { row: LinkRow; before: LinkRow; after: LinkRow }[] = [];
    if (changed.length) {
      const written = await c.env.DB.batch<LinkRow>(changed.flatMap(({ before, after, rev }) => [updateStmt(c.env.DB, before, after, rev), savedVersionStmt(c.env.DB, after, rev, "update", identity, { at: now })]));
      // What D1 holds now, a concurrent edit included. A link deleted meanwhile isn't published back.
      saved = changed.flatMap(({ before, after }, i) => {
        const row = written[i * 2]?.results[0];
        return row ? [{ row, before, after }] : [];
      });
      // Tags aren't part of the published record; turning a link on or off is.
      if (action === "enable" || action === "disable") {
        const defaultUtm = await getDefaultUtm(c.env.DB);
        const publishRow = async (row: LinkRow) => {
          try {
            await publish(c.env, row, defaultUtm);
          } catch (err) {
            console.error(JSON.stringify({ message: "kv publish failed", domain: row.domain, slug: row.slug, error: String(err) }));
            result.failed.push({ domain: row.domain, slug: row.slug, error: "Saved, but publishing failed; use Republish all links in Settings." });
          }
        };
        await Promise.all(saved.map(({ row }) => publishRow(row)));
        // One read for all of them: an edit that landed meanwhile may have reached KV first (publishLatest).
        if (saved.length) {
          const { results: latest } = await c.env.DB.prepare(
            `SELECT l.* FROM json_each(?1) j JOIN links l ON l.domain = json_extract(j.value, '$[0]') AND l.slug = json_extract(j.value, '$[1]')`,
          )
            .bind(JSON.stringify(saved.map(({ row }) => [row.domain, row.slug])))
            .all<LinkRow>();
          const sent = new Map(saved.map(({ row }) => [linkKey(row.domain, row.slug), row]));
          await Promise.all(latest.filter((row) => !samePublished(row, sent.get(linkKey(row.domain, row.slug))!)).map(publishRow));
        }
      }
      const events: Event[] = saved.map(({ row, before, after }) => ({ type: "link.updated", data: { link: linkPayload(row), changes: changedFields(before, after) } }));
      await emitAll(c.env, events, { ctx: c.executionCtx });
    }
    result.changed = saved.length;
    return c.json(result);
  })

  .post("/links", validate("json", createLinkSchema), async (c) => {
    if (!configuredDomains(c.env).length) return c.json({ error: NO_DOMAIN_ERROR, code: "no_domain" }, 409);
    const body = c.req.valid("json");
    const domain = body.domain || domainsOf(c.env).primary;
    if (!isConfiguredDomain(c.env, domain)) return c.json({ error: notConfigured(domain) }, 400);
    const target = normalizeTarget(body.target ?? body.url ?? "", { selfHosts: selfHosts(c.env, c.req.raw) });
    if (!target.ok) return c.json({ error: target.error }, 400);
    if (body.utmTemplate) {
      const err = validateUtmTemplate(body.utmTemplate);
      if (err) return c.json({ error: `utmTemplate: ${err}` }, 400);
    }

    const routing = routingFor(c, body.routing, null);
    if (!routing.ok) return c.json({ error: routing.error, details: routing.details }, 400);
    const preview = previewFor(body.preview, null);
    if (!preview.ok) return c.json({ error: preview.error }, 400);
    const bio = await bioFor(c, body.bio, null);
    if (!bio.ok) return c.json({ error: bio.error }, 400);
    const refusedTag = await refusedTags(c, body.tags ?? []);
    if (refusedTag) return c.json({ error: refusedTag, code: "forbidden" }, 403);

    const now = nowSec();
    // Malware or phishing, per Cloudflare's security DNS: saved, but visitors are warned first.
    const checked = { target: target.url, routing: routing.json } as Pick<LinkRow, "target" | "routing" | "unsafe" | "unsafe_at">;
    await checkSafety(c.env, checked);
    const base: Omit<LinkRow, "slug"> = {
      domain,
      unsafe: checked.unsafe,
      unsafe_at: checked.unsafe_at,
      bio: bio.json,
      target: target.url,
      active: body.active === false ? 0 : 1,
      expires_at: body.expiresAt ?? null,
      utm: body.utm ? 1 : 0,
      utm_template: body.utmTemplate || null,
      pass_query: body.passQuery ? 1 : 0,
      title: body.title || null,
      tags: (body.tags ?? []).join(","),
      notes: body.notes ?? "",
      source: "native",
      imported_clicks: null,
      broken: 0,
      replacement: null,
      off_redirect: null,
      monitor: body.neverCheck ? MONITOR_NEVER : body.monitor ? MONITOR_ON : MONITOR_DEFAULT,
      routing: routing.json,
      preview: preview.json,
      qr: null,
      password_hash: body.password ? await hashLinkPassword(c.env, body.password) : null,
      max_clicks: body.maxClicks ?? null,
      created_at: now,
      updated_at: now,
    };

    const custom = body.slug?.trim();
    if (custom) {
      const err = validateSlug(custom, "native");
      if (err) return c.json({ error: `slug: ${err}` }, 400);
    }

    let row: LinkRow | null = null;
    for (let attempt = 0; attempt < (custom ? 1 : 5); attempt++) {
      const candidate: LinkRow = { slug: custom || generateSlug(6), ...base };
      try {
        await c.env.DB.batch([insertStmt(c.env.DB, candidate), versionStmt(c.env.DB, candidate, "create", c.get("identity"), { at: now })]);
        row = candidate;
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (custom) return c.json({ error: `slug: "${custom}" is already taken on ${domain}.` }, 409);
      }
    }
    if (!row) return c.json({ error: "Could not generate a free slug. Try again." }, 500);
    // A deleted link with this slug may have left a count behind.
    if (row.max_clicks) await resetCounter(c.env, row);

    try {
      await publishSaved(c.env, row);
    } catch (err) {
      console.error(JSON.stringify({ message: "kv publish failed", domain: row.domain, slug: row.slug, error: String(err) }));
      return c.json({ error: PUBLISH_FAILED, link: dto(c, row) }, 502);
    }
    await emit(c.env, "link.created", { link: linkPayload(row) }, { ctx: c.executionCtx });
    const link = dto(c, row);
    if (c.req.query("format") === "text") return c.text(link.shortUrl, 201);
    return c.json({ link }, 201);
  })

  .get("/links/:domain/:slug", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const row = await getLink(c.env.DB, domain, slug);
    if (!row) return c.json({ error: "Link not found" }, 404);
    return c.json({ link: dto(c, row) });
  })

  .patch("/links/:domain/:slug", validate("param", linkParamSchema), validate("json", updateLinkSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const row = await getLink(c.env.DB, domain, slug);
    if (!row) return c.json({ error: "Link not found" }, 404);
    const body = c.req.valid("json");
    if (body.version !== undefined && body.version !== (row.rev ?? "0")) return versionConflict(c, row);
    const next: LinkRow = { ...row, updated_at: nowSec() };

    if (body.target !== undefined) {
      // An http:// destination from an older import may stay; no link gets a new one.
      const own = selfHosts(c.env, c.req.raw);
      const same = normalizeTarget(body.target, { allowHttp: true, selfHosts: own });
      const target = same.ok && same.url === row.target ? same : normalizeTarget(body.target, { selfHosts: own });
      if (!target.ok) return c.json({ error: target.error }, 400);
      next.target = target.url;
    }
    if (body.utmTemplate !== undefined) {
      if (body.utmTemplate) {
        const err = validateUtmTemplate(body.utmTemplate);
        if (err) return c.json({ error: `utmTemplate: ${err}` }, 400);
      }
      next.utm_template = body.utmTemplate || null;
    }
    if (body.title !== undefined) next.title = body.title || null;
    if (body.tags !== undefined) {
      next.tags = body.tags.join(",");
      const refused = await refusedTags(c, addedTags(row.tags, next.tags));
      if (refused) return c.json({ error: refused, code: "forbidden" }, 403);
    }
    if (body.notes !== undefined) next.notes = body.notes;
    if (body.expiresAt !== undefined) next.expires_at = body.expiresAt;
    if (body.active !== undefined) next.active = body.active ? 1 : 0;
    if (body.utm !== undefined) next.utm = body.utm ? 1 : 0;
    if (body.passQuery !== undefined) next.pass_query = body.passQuery ? 1 : 0;
    if (body.monitor !== undefined || body.neverCheck !== undefined) {
      // Switching one on switches the other off; "never" wins when both come on.
      const never = body.neverCheck ?? (body.monitor ? false : row.monitor === MONITOR_NEVER);
      const on = !never && (body.monitor ?? row.monitor === MONITOR_ON);
      next.monitor = never ? MONITOR_NEVER : on ? MONITOR_ON : MONITOR_DEFAULT;
    }
    const routing = routingFor(c, body.routing, row.routing);
    if (!routing.ok) return c.json({ error: routing.error, details: routing.details }, 400);
    next.routing = routing.json;
    const preview = previewFor(body.preview, row.preview);
    if (!preview.ok) return c.json({ error: preview.error }, 400);
    next.preview = preview.json;
    const bio = await bioFor(c, body.bio, row.bio ?? null);
    if (!bio.ok) return c.json({ error: bio.error }, 400);
    next.bio = bio.json;
    if (body.password !== undefined) next.password_hash = body.password === null ? null : await hashLinkPassword(c.env, body.password);
    if (body.maxClicks !== undefined) next.max_clicks = body.maxClicks;
    if (body.qr !== undefined) {
      if (body.qr === null) next.qr = null;
      else {
        const qr = validateQrStyle(body.qr);
        if (!qr.ok) return c.json({ error: `qr: ${qr.error}` }, 400);
        next.qr = JSON.stringify(qr.style);
      }
    }
    if (body.broken !== undefined) next.broken = body.broken ? 1 : 0;
    if (body.replacement !== undefined) {
      const r = body.replacement;
      if (r) {
        if (r.domain === domain && r.slug === slug) return c.json({ error: "replacement: A link can't replace itself." }, 400);
        if (!(await getLink(c.env.DB, r.domain, r.slug))) return c.json({ error: `replacement: ${linkKey(r.domain, r.slug)} doesn't exist.` }, 400);
      }
      next.replacement = r ? linkKey(r.domain, r.slug) : null;
    }
    if (body.offRedirect !== undefined) {
      const o = body.offRedirect;
      if (o && o !== "home") {
        if (o.domain === domain && o.slug === slug) return c.json({ error: "offRedirect: A link can't send visitors to itself." }, 400);
        if (!(await getLink(c.env.DB, o.domain, o.slug))) return c.json({ error: `offRedirect: ${linkKey(o.domain, o.slug)} doesn't exist.` }, 400);
      }
      next.off_redirect = o === "home" ? OFF_HOME : o ? linkKey(o.domain, o.slug) : null;
    }

    // New destinations are looked up again; trusting a flagged one is the owner's call.
    const destinationsChanged = next.target !== row.target || next.routing !== row.routing;
    if (destinationsChanged) await checkSafety(c.env, next);
    if (body.trustDestination !== undefined && (next.unsafe ?? 0) !== UNSAFE_NONE) next.unsafe = body.trustDestination ? UNSAFE_TRUSTED : UNSAFE_FLAGGED;
    const unsafeChanged = (next.unsafe ?? 0) !== (row.unsafe ?? 0);

    // A new limit counts from now; changing an existing one keeps the count.
    if (row.max_clicks === null && next.max_clicks !== null) await resetCounter(c.env, next);
    const changed = !sameSnapshot(snapshotOf(row), snapshotOf(next)) || unsafeChanged;
    return saveEdit(c, row, next, changed ? { action: "update" } : null, {
      expected: body.version,
      onSaved: async (saved) => {
        if (changed) await emit(c.env, "link.updated", { link: linkPayload(saved), changes: changedFields(row, next) }, { ctx: c.executionCtx });
      },
    });
  })

  /** Links that point visitors to this one while marked "no longer working" or turned off. */
  .get("/links/:domain/:slug/dependents", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const key = linkKey(domain, slug);
    const { results } = await c.env.DB.prepare("SELECT * FROM links WHERE (replacement = ?1 AND broken = 1) OR (off_redirect = ?1 AND active = 0) ORDER BY domain, slug")
      .bind(key)
      .all<LinkRow>();
    return c.json({ links: results.map((r) => dto(c, r)) });
  })

  .delete("/links/:domain/:slug", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const existing = await getLink(c.env.DB, domain, slug);
    if (!existing) return c.json({ error: "Link not found" }, 404);
    // KV first: if this fails the link still exists in D1 and the delete can be retried;
    // the other way round, a leftover KV record would keep redirecting.
    try {
      await c.env.LINKS.delete(kvKey(domain, slug));
    } catch (err) {
      console.error(JSON.stringify({ message: "kv delete failed", domain, slug, error: String(err) }));
      return c.json({ error: "Couldn't remove the link from KV, so it wasn't deleted. Try again in a minute.", link: dto(c, existing) }, 502);
    }
    // The delete's version keeps the link as D1 holds it, so it can be restored.
    const [, removed] = await c.env.DB.batch<LinkRow>([
      c.env.DB.prepare(
        `INSERT INTO link_versions (domain, slug, at, action, actor, snapshot)
         SELECT domain, slug, ?1, 'delete', ?2, ${SNAPSHOT_SQL} FROM links WHERE domain = ?3 AND slug = ?4`,
      ).bind(nowSec(), c.get("identity"), domain, slug),
      c.env.DB.prepare("DELETE FROM links WHERE domain = ? AND slug = ? RETURNING *").bind(domain, slug),
      // Its shared statistics pages end for good, even if the link is restored.
      c.env.DB.prepare("UPDATE stat_shares SET revoked_at = ? WHERE domain = ? AND slug = ? AND revoked_at IS NULL").bind(nowSec(), domain, slug),
    ]);
    // Again, for an edit that published between the two steps above (its own check covers later ones).
    await c.env.LINKS.delete(kvKey(domain, slug));
    // Only the request that removed the row reports it.
    const row = removed?.results[0];
    if (row) await emit(c.env, "link.deleted", { link: linkPayload(row) }, { ctx: c.executionCtx });
    return c.json({ deleted: slug, domain });
  })

  .get("/links/:domain/:slug/history", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const versions = await listVersions(c.env.DB, domain, slug);
    // Destinations and notes stay hidden in every version of a protected link, and of any version that had a password.
    const hide = !seesProtected(c);
    const protectedNow = hide && Boolean((await getLink(c.env.DB, domain, slug))?.password_hash);
    return c.json({
      versions: versions.map((v) => {
        const secret = hide && (protectedNow || Boolean(v.snapshot.password_hash));
        return {
          ...v,
          snapshot: {
            ...v.snapshot,
            // Each version remembers the clicks imported with the link: statistics, like the link's own.
            imported_clicks: seesStats(c) ? v.snapshot.imported_clicks : null,
            ...(secret ? { target: "", notes: "", utm_template: null, routing: null, bio: null } : {}),
          },
        };
      }),
    });
  })

  /**
   * Puts a link back the way it was in an earlier version. The password stays
   * as it is now unless ?password=version asks for the version's: a restore
   * must not quietly bring back an old password or take the protection off.
   */
  .post("/links/:domain/:slug/history/:id/restore", validate("param", versionParamSchema), validate("query", restoreVersionQuerySchema), async (c) => {
    const { domain, slug, id } = c.req.valid("param");
    const { password } = c.req.valid("query");
    const [row, version] = await Promise.all([getLink(c.env.DB, domain, slug), getVersion(c.env.DB, domain, slug, id)]);
    if (!row) return c.json({ error: "Link not found" }, 404);
    if (!version || version.action === "delete") return c.json({ error: "That version doesn't exist." }, 404);
    const next = withSnapshot(row, version.snapshot);
    if (password === "keep") next.password_hash = row.password_hash;
    const invalid = restoreProblem(c, next);
    if (invalid) return c.json({ error: invalid }, 400);
    if (sameSnapshot(snapshotOf(row), snapshotOf(next))) return c.json({ error: "The link already matches this version." }, 409);
    const refusedTag = await refusedTags(c, addedTags(row.tags, next.tags));
    if (refusedTag) return c.json({ error: refusedTag, code: "forbidden" }, 403);
    // An older destination is looked up again, as a saved change would be: a flag or "trusted anyway" was about the current one.
    if (next.target !== row.target || next.routing !== row.routing) await checkSafety(c.env, next);
    return saveEdit(c, row, next, { action: "restore", restoredFrom: id }, {
      onSaved: async (saved) => {
        await emit(c.env, "link.updated", { link: linkPayload(saved), changes: changedFields(row, next), restored_version: id }, { ctx: c.executionCtx });
      },
    });
  })

  /** A capped link's counter. */
  .get("/links/:domain/:slug/cap", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const row = await getLink(c.env.DB, domain, slug);
    if (!row) return c.json({ error: "Link not found" }, 404);
    // The limit is a setting; how far the count has got is statistics.
    const cap: CapDTO = { limit: row.max_clicks, count: !seesStats(c) ? null : row.max_clicks ? await capCount(c.env, domain, slug, row.cap_since ?? 0) : 0 };
    return c.json(cap);
  })

  /** Starts the count again, so the limit allows its full number of clicks. */
  .post("/links/:domain/:slug/cap/reset", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const row = await getLink(c.env.DB, domain, slug);
    if (!row) return c.json({ error: "Link not found" }, 404);
    await capReset(c.env, domain, slug);
    const cap: CapDTO = { limit: row.max_clicks, count: 0 };
    return c.json(cap);
  })

  .get("/deleted", async (c) => c.json({ links: await deletedLinks(c.env.DB, undefined, { hideProtected: !seesProtected(c) }) }))

  /** Brings a deleted link back with its slug, settings and stats. */
  .post("/deleted/:domain/:slug/restore", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const gone = (await deletedLinks(c.env.DB)).find((d) => d.domain === domain && d.slug === slug);
    if (!gone) {
      if (await getLink(c.env.DB, domain, slug)) return c.json({ error: `${linkKey(domain, slug)} is in use by another link now.` }, 409);
      return c.json({ error: "That deleted link can't be restored anymore." }, 404);
    }
    const version = await getVersion(c.env.DB, domain, slug, gone.versionId);
    if (!version) return c.json({ error: "That deleted link can't be restored anymore." }, 404);
    const now = nowSec();
    const s = version.snapshot;
    const row = withSnapshot({ domain, slug, source: s.source, imported_clicks: s.imported_clicks, created_at: s.created_at } as LinkRow, s, now);
    const invalid = restoreProblem(c, row);
    if (invalid) return c.json({ error: invalid }, 400);
    const refusedTag = await refusedTags(c, addedTags("", row.tags));
    if (refusedTag) return c.json({ error: refusedTag, code: "forbidden" }, 403);
    // Looked up as a new link would be: what was known when it was deleted may no longer hold.
    await checkSafety(c.env, row);
    try {
      await c.env.DB.batch([insertStmt(c.env.DB, row), versionStmt(c.env.DB, row, "restore", c.get("identity"), { at: now, restoredFrom: gone.versionId })]);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: `${linkKey(domain, slug)} is in use by another link now.` }, 409);
      throw err;
    }
    await emit(c.env, "link.created", { link: linkPayload(row), restored: true }, { ctx: c.executionCtx });
    if (!(await published(c.env, row))) return c.json({ error: PUBLISH_FAILED, link: dto(c, row) }, 502);
    return c.json({ link: dto(c, row) }, 201);
  })

  .get("/tags", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT tags FROM links WHERE tags != ''").all<{ tags: string }>();
    const counts = new Map<string, number>();
    for (const r of results) for (const t of r.tags.split(",")) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tags = [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    return c.json({ tags });
  })

  /** Renames a tag on every link that has it (or merges it into an existing one). */
  .post("/tags/rename", validate("json", tagRenameSchema), async (c) => {
    const { from, to: raw } = c.req.valid("json");
    const to = normalizeTags([raw])[0];
    if (!to) return c.json({ error: "Name the new tag" }, 400);
    // Every link with the old tag gets the new one, which may feed a report.
    if (to !== from) {
      const refused = await refusedTags(c, [to]);
      if (refused) return c.json({ error: refused, code: "forbidden" }, 403);
    }
    return c.json(await retag(c, from, to));
  })

  /** Removes a tag from every link that has it. */
  .delete("/tags/:tag", validate("param", tagParamSchema), async (c) => c.json(await retag(c, c.req.valid("param").tag, null)))

  .post("/import", validate("json", importSchema), async (c) => {
    if (!configuredDomains(c.env).length) return c.json({ error: NO_DOMAIN_ERROR, code: "no_domain" }, 409);
    const { rows, mode, dryRun, defaultDomain, from } = c.req.valid("json");
    // Each row costs a KV write, and an invocation has 50 subrequests on Workers Free (src/worker/plan.ts).
    const { importRows, deliveriesNow } = planLimits(c.env);
    if (rows.length > importRows) {
      return c.json({ error: `Import at most ${importRows} rows per request on this Workers plan; send the rest in further requests.`, code: "too_many_rows" }, 413);
    }
    // Up front, even for a dry run, so a chunked import can't stop halfway.
    // Overwriting would retarget existing links, which the API token's default scope can't do.
    if (mode === "overwrite" && c.get("actor").via === "token" && !fullTokenScope(c.env)) {
      return c.json({ error: TOKEN_SCOPE_ERROR }, 403);
    }
    if (mode === "overwrite" && !can(c.get("actor"), "links.edit")) {
      return c.json({ error: "Overwriting existing links needs the Edit links permission." }, 403);
    }
    const tagProblems = await reportTagProblems(c, rows.flatMap((r) => r.tags ?? []));
    const now = nowSec();
    const results: ImportRowResult[] = [];
    const valid: LinkRow[] = [];
    const seen = new Set<string>();
    const seenLower = new Map<string, string>();
    const fallbackDomain = defaultDomain || domainsOf(c.env).primary;
    /** Rows that brought their own settings: an overwrite replaces those too. */
    const withConfig = new Set<string>();
    /** Rows carrying the settings exports hold since 2.0.3: an older file leaves those alone. */
    const withLinkState = new Set<string>();
    const domainFor = (r: (typeof rows)[number]) => r.domain || fallbackDomain;

    const { results: existing } = await c.env.DB.prepare(
      `SELECT json_extract(j.value, '$[0]') AS domain, json_extract(j.value, '$[1]') AS wanted, l.slug, l.target, l.routing, l.password_hash IS NOT NULL AS has_password
       FROM json_each(?1) j
       JOIN links l ON l.domain = json_extract(j.value, '$[0]') AND l.slug = json_extract(j.value, '$[1]') COLLATE NOCASE`,
    )
      .bind(JSON.stringify(rows.map((r) => [domainFor(r), r.slug])))
      .all<{ domain: string; wanted: string; slug: string; target: string; routing: string | null; has_password: number }>();
    /** The links an overwrite would replace, as they are now. */
    const before = new Map(existing.filter((e) => e.wanted === e.slug).map((e) => [linkKey(e.domain, e.slug), e]));
    const exact = new Set(before.keys());
    const caseClash = new Map(existing.filter((e) => e.wanted !== e.slug).map((e) => [linkKey(e.domain, e.wanted), e.slug]));

    for (const r of rows) {
      const domain = domainFor(r);
      const key = linkKey(domain, r.slug);
      const fail = (message: string) => results.push({ domain, slug: r.slug, status: "error", message });
      if (!isConfiguredDomain(c.env, domain)) {
        fail(`Domain ${domain} is not one of your short domains.`);
        continue;
      }
      const slugErr = validateSlug(r.slug, "import");
      if (slugErr) {
        fail(slugErr);
        continue;
      }
      if (seen.has(key)) {
        fail("Duplicate slug in this batch.");
        continue;
      }
      seen.add(key);
      const tagProblem = (r.tags ?? []).flatMap((t) => tagProblems.get(t) ?? [])[0];
      if (tagProblem) {
        fail(tagProblem);
        continue;
      }
      // The same rule as a new link: nobody is sent on over plain http from here. A destination
      // the link already has isn't a new one, as when saving the link (an older import's http://).
      const own = selfHosts(c.env, c.req.raw);
      const same = before.has(key) ? normalizeTarget(r.target, { allowHttp: true, selfHosts: own }) : null;
      const target = same?.ok && same.url === before.get(key)!.target ? same : normalizeTarget(r.target, { selfHosts: own });
      if (!target.ok) {
        fail(/^\s*http:/i.test(r.target) ? "Destination uses http://. Imports take https:// only: change it to https:// and import this row again. A full restore keeps it (docs/SETUP.md#restore)." : target.error);
        continue;
      }
      const exists = exact.has(key);
      if (exists && mode === "skip") {
        results.push({ domain, slug: r.slug, status: "skipped", message: "Already exists." });
        continue;
      }
      const notes: string[] = [];
      if (target.url !== r.target.trim()) notes.push(`Target normalized to ${target.url}`);
      const clash = caseClash.get(key);
      if (clash) notes.push(`Differs only in case from existing "${clash}"`);
      const lowerKey = linkKey(domain, r.slug.toLowerCase());
      const batchClash = seenLower.get(lowerKey);
      if (batchClash && batchClash !== r.slug) notes.push(`Differs only in case from "${batchClash}" in this import`);
      seenLower.set(lowerKey, r.slug);
      // Another workspace's JSON export carries each link's settings: check them as a save would.
      const cfg = r.config;
      let routing: string | null = null;
      let preview: string | null = null;
      let qrStyle: string | null = null;
      let bio: string | null = null;
      if (cfg) {
        const rt = routingFor(c, cfg.routing ?? undefined, null);
        if (!rt.ok) {
          fail(rt.error);
          continue;
        }
        const pv = previewFor(cfg.preview ?? undefined, null);
        if (!pv.ok) {
          fail(pv.error);
          continue;
        }
        if (cfg.qr) {
          const qr = validateQrStyle(cfg.qr);
          if (!qr.ok) {
            fail(`qr: ${qr.error}`);
            continue;
          }
          qrStyle = JSON.stringify(qr.style);
        }
        const utmProblem = cfg.utmTemplate ? validateUtmTemplate(cfg.utmTemplate) : null;
        if (utmProblem) {
          fail(`utmTemplate: ${utmProblem}`);
          continue;
        }
        if (cfg.bio) {
          // Not bioFor: the links its buttons name may come later in this import.
          let checked: ReturnType<typeof validateBio>;
          try {
            checked = validateBio(cfg.bio as unknown as BioPage, { selfHosts: own });
          } catch {
            fail("bio: This page can't be read.");
            continue;
          }
          if (!checked.ok) {
            fail(`bio: ${checked.problems[0]!.message}`);
            continue;
          }
          bio = JSON.stringify(checked.bio);
        }
        if (cfg.replacement && linkKey(cfg.replacement.domain, cfg.replacement.slug) === key) {
          fail("replacement: A link can't replace itself.");
          continue;
        }
        if (cfg.offRedirect && cfg.offRedirect !== "home" && linkKey(cfg.offRedirect.domain, cfg.offRedirect.slug) === key) {
          fail("offRedirect: A link can't send visitors to itself.");
          continue;
        }
        routing = rt.json;
        preview = pv.json;
        if ([cfg.bio, cfg.broken, cfg.replacement, cfg.offRedirect, cfg.monitor, cfg.neverCheck].some((v) => v !== undefined)) withLinkState.add(key);
      }
      // Passwords are never in a file: a link that had one mustn't arrive open to anyone with the address.
      const lostPassword = Boolean(cfg?.passwordProtected) && !before.get(key)?.has_password;
      if (lostPassword) notes.push("This link had a password, which isn't in the file, so it is turned off. Set a new password, then turn it on.");
      const off = cfg?.offRedirect;
      valid.push({
        domain,
        slug: r.slug,
        target: target.url,
        active: cfg?.active === false || lostPassword ? 0 : 1,
        expires_at: cfg?.expiresAt ?? null,
        utm: cfg?.utm ? 1 : 0,
        utm_template: cfg?.utmTemplate || null,
        pass_query: cfg?.passQuery ? 1 : 0,
        title: r.title || null,
        tags: (r.tags ?? []).join(","),
        notes: cfg?.notes ?? "",
        source: "import",
        imported_clicks: r.clicks ?? null,
        import_from: from ?? null,
        broken: cfg?.broken ? 1 : 0,
        replacement: cfg?.replacement ? linkKey(cfg.replacement.domain, cfg.replacement.slug) : null,
        off_redirect: off === "home" ? OFF_HOME : off ? linkKey(off.domain, off.slug) : null,
        monitor: cfg?.neverCheck ? MONITOR_NEVER : cfg?.monitor ? MONITOR_ON : MONITOR_DEFAULT,
        bio,
        routing,
        preview,
        qr: qrStyle,
        password_hash: null,
        max_clicks: cfg?.maxClicks ?? null,
        rev: newRev(),
        // A deleted link with this slug may have left a count behind: this limit starts from now.
        cap_since: cfg?.maxClicks ? now : null,
        created_at: r.createdAt ?? now,
        updated_at: now,
      });
      if (cfg) withConfig.add(key);
      results.push({ domain, slug: r.slug, status: exists ? "updated" : "created", message: notes.join("; ") || undefined });
    }

    if (!dryRun && valid.length > 0) {
      // Skip mode never overwrites, even a link created since the check above.
      // Settings from a JSON export (?30 = 1) replace the existing link's; otherwise they're kept.
      // The ones exports added in 2.0.3 only when the row has them (?32 = 1).
      // New links and new destinations are looked up at the security DNS now, each host once across the
      // batch, while the request has lookups left (the plan's inlineLookups). The rest, and lookups that
      // failed, keep unsafe_at NULL: the cron's backlog takes those first (src/worker/health.ts).
      const lookups = valid.map((r) => {
        const key = linkKey(r.domain, r.slug);
        const old = before.get(key);
        // An overwrite without settings keeps the link's routing: those destinations stay in use.
        const routing = old && !withConfig.has(key) ? old.routing : r.routing;
        return { routing, urls: !old || old.target !== r.target || old.routing !== routing ? destinationsOf(r.target, routing) : null };
      });
      const { verdicts } = await safetyOfEach(c.env, lookups.flatMap((l) => (l.urls ? [l.urls] : [])), planLimits(c.env).inlineLookups);
      let looked = 0;
      const safety = lookups.map((l) => (l.urls ? verdicts[looked++] : undefined));
      // A changed destination's old flag (or "trusted anyway") doesn't carry over. The answer looked up is used
      // only while the link still has the routing it was looked up with (?31); otherwise the backlog decides.
      const DESTINATIONS_CHANGED = "(links.target != excluded.target OR (?30 = 1 AND links.routing IS NOT excluded.routing))";
      const LOOKED_UP = "(?30 = 1 OR links.routing IS ?31)";
      const fromConfig = (col: string) => `${col} = CASE WHEN ?30 = 1 THEN excluded.${col} ELSE links.${col} END`;
      const fromLinkState = (col: string) => `${col} = CASE WHEN ?32 = 1 THEN excluded.${col} ELSE links.${col} END`;
      const onConflict =
        mode === "overwrite"
          ? `DO UPDATE SET target = excluded.target, title = COALESCE(excluded.title, links.title),
           imported_clicks = COALESCE(excluded.imported_clicks, links.imported_clicks), source = 'import',
           import_from = COALESCE(excluded.import_from, links.import_from),
           unsafe = CASE WHEN NOT ${DESTINATIONS_CHANGED} THEN links.unsafe WHEN ${LOOKED_UP} THEN excluded.unsafe ELSE 0 END,
           unsafe_at = CASE WHEN NOT ${DESTINATIONS_CHANGED} THEN links.unsafe_at WHEN ${LOOKED_UP} THEN excluded.unsafe_at ELSE NULL END,
           unsafe_tried_at = CASE WHEN ${DESTINATIONS_CHANGED} THEN NULL ELSE links.unsafe_tried_at END,
           ${["active", "expires_at", "utm", "utm_template", "pass_query", "notes", "routing", "preview", "qr", "max_clicks"].map(fromConfig).join(", ")},
           ${["bio", "broken", "replacement", "off_redirect", "monitor"].map(fromLinkState).join(", ")},
           cap_since = CASE WHEN ?30 = 1 AND links.max_clicks IS NULL AND excluded.max_clicks IS NOT NULL THEN excluded.cap_since ELSE links.cap_since END,
           rev = excluded.rev, updated_at = excluded.updated_at`
          : "DO NOTHING";
      const stmt = c.env.DB.prepare(
        `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, monitor,
           routing, preview, qr, max_clicks, import_from, created_at, updated_at, unsafe, unsafe_at, rev, cap_since, bio, broken, replacement, off_redirect)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)
         ON CONFLICT (domain, slug) ${onConflict}`,
      );
      const keysJson = JSON.stringify(valid.map((r) => [r.domain, r.slug]));
      await c.env.DB.batch([
        ...valid.map((r, i) =>
          stmt.bind(
            r.domain,
            r.slug,
            r.target,
            r.active,
            r.expires_at,
            r.utm,
            r.utm_template,
            r.pass_query,
            r.title,
            r.tags,
            r.notes,
            r.source,
            r.imported_clicks,
            r.monitor,
            r.routing,
            r.preview,
            r.qr,
            r.max_clicks,
            r.import_from ?? null,
            r.created_at,
            r.updated_at,
            safety[i] === "flagged" ? UNSAFE_FLAGGED : UNSAFE_NONE,
            safety[i] === "flagged" || safety[i] === "clean" ? now : null,
            r.rev ?? null,
            r.cap_since ?? null,
            r.bio ?? null,
            r.broken,
            r.replacement,
            r.off_redirect,
            // ?30 to ?32 only appear in the overwrite statement.
            ...(mode === "overwrite" ? [withConfig.has(linkKey(r.domain, r.slug)) ? 1 : 0, lookups[i]?.routing ?? null, withLinkState.has(linkKey(r.domain, r.slug)) ? 1 : 0] : []),
          ),
        ),
        // A version per imported link, with what D1 now holds (an overwrite keeps the link's other settings).
        // Only rows this import wrote: a link created meanwhile in skip mode isn't one.
        c.env.DB.prepare(
          `INSERT INTO link_versions (domain, slug, at, action, actor, snapshot)
           SELECT domain, slug, ?1, 'import', ?2, ${SNAPSHOT_SQL} FROM links
           WHERE (domain, slug) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?3))
             AND source = 'import' AND updated_at = ?1`,
        ).bind(now, c.get("identity"), keysJson),
      ]);
      // Publish what D1 now holds (an overwrite keeps the link's other settings).
      const { results: saved } = await c.env.DB.prepare(
        `SELECT l.* FROM json_each(?1) j
         JOIN links l ON l.domain = json_extract(j.value, '$[0]') AND l.slug = json_extract(j.value, '$[1]')
         WHERE l.source = 'import' AND l.updated_at = ?2`,
      )
        .bind(keysJson, now)
        .all<LinkRow>();
      const defaultUtm = await getDefaultUtm(c.env.DB);
      const failed = new Set<string>();
      await Promise.all(
        saved.map((r) =>
          publish(c.env, r, defaultUtm).catch(() => {
            failed.add(linkKey(r.domain, r.slug));
          }),
        ),
      );
      // New links only, queued in one round trip. The first few deliveries go now; the cron sends the rest, a few each run.
      const created = new Set(results.filter((r) => r.status === "created").map((r) => linkKey(r.domain, r.slug)));
      await emitAll(
        c.env,
        saved.filter((r) => created.has(linkKey(r.domain, r.slug))).map((r) => ({ type: "link.created" as const, data: { link: linkPayload(r), imported: true } })),
        { ctx: c.executionCtx, now: deliveriesNow },
      );
      for (const res of results) {
        if (failed.has(linkKey(res.domain, res.slug))) {
          res.status = "error";
          res.message = "Saved to D1 but KV publish failed. Run “Republish all links” in Settings.";
        }
      }
    }

    const count = (s: ImportRowResult["status"]) => results.filter((r) => r.status === s).length;
    const result: ImportResult = {
      dryRun,
      created: count("created"),
      updated: count("updated"),
      skipped: count("skipped"),
      errors: count("error"),
      rows: results,
    };
    return c.json(result);
  })

  /**
   * One page of links from Bitly, Rebrandly, Short.io or Dub, for the import
   * page to preview and import like a file. The key is used for this request
   * only: never stored, never logged, never sent back.
   */
  .post("/import/pull", validate("json", pullSchema), async (c) => {
    const { vendor, apiKey, cursor, clicks } = c.req.valid("json");
    try {
      const page = await pullLinks(vendor, apiKey, cursor ?? null, planLimits(c.env).pullCalls, { clicks });
      return c.json(page);
    } catch (err) {
      if (err instanceof VendorError) return c.json({ error: err.message }, err.status);
      console.error(JSON.stringify({ message: "import pull failed", vendor, error: String(err) }));
      return c.json({ error: "Reading the links failed. Try again." }, 502);
    }
  })

  .post("/resync", validate("query", resyncQuerySchema), async (c) => {
    // Republishes links to KV in pages sized to the Workers plan (one KV write
    // each; src/worker/plan.ts). Call again with `next` until it is null.
    const { after = "", scope } = c.req.valid("query");
    const page = planLimits(c.env).bulkPage;
    const cut = after.indexOf("/");
    const [afterDomain, afterSlug] = cut === -1 ? [after, ""] : [after.slice(0, cut), after.slice(cut + 1)];
    const onlyDefaultUtm = scope === "default-utm" ? " AND utm = 1 AND utm_template IS NULL" : "";
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM links WHERE (domain > ?1 OR (domain = ?1 AND slug > ?2))${onlyDefaultUtm} ORDER BY domain, slug LIMIT ?3`,
    )
      .bind(afterDomain, afterSlug, page)
      .all<LinkRow>();
    const defaultUtm = await getDefaultUtm(c.env.DB);
    await Promise.all(results.map((r) => publish(c.env, r, defaultUtm)));
    const last = results.at(-1);
    return c.json({ published: results.length, next: results.length === page && last ? linkKey(last.domain, last.slug) : null });
  })

  .get("/export/links.csv", validate("query", exportQuerySchema), async (c) => {
    const { links: picked, ...filter } = c.req.valid("query");
    const { scope } = await getCheckSettings(c.env.DB);
    const hide = !seesProtected(c);
    const { where, params } = listFilter(filter, scope, hide);
    if (picked) {
      // A selection: "domain/slug" keys, comma-separated.
      params.push(JSON.stringify(picked.split(",").filter(Boolean)));
      where.push(`(domain || '/' || slug) IN (SELECT value FROM json_each(?${params.length}))`);
    }
    const { results } = await c.env.DB.prepare(`SELECT * FROM links ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`)
      .bind(...params)
      .all<LinkRow>();
    // An out-of-range date (an import from elsewhere) is left blank rather than failing the export.
    const iso = (s: number | null) => {
      const d = new Date((s ?? NaN) * 1000);
      return Number.isFinite(d.getTime()) ? d.toISOString() : "";
    };
    const secret = (r: LinkRow) => hide && Boolean(r.password_hash);
    const body = csv([
      ["domain", "slug", "short_url", "target", "active", "expires_at", "utm", "utm_template", "pass_query", "title", "tags", "notes", "source", "imported_clicks", "created_at", "updated_at", "broken", "replacement", "monitor", "routing", "preview", "qr", "password_protected", "max_clicks", "off_redirect"],
      ...results.map((r) => [
        r.domain,
        r.slug,
        dto(c, r).shortUrl,
        secret(r) ? "" : r.target,
        r.active,
        iso(r.expires_at),
        r.utm,
        secret(r) ? null : r.utm_template,
        r.pass_query,
        r.title,
        r.tags,
        secret(r) ? "" : r.notes,
        r.source,
        seesStats(c) ? r.imported_clicks : null,
        iso(r.created_at),
        iso(r.updated_at),
        r.broken,
        r.replacement,
        r.monitor,
        secret(r) ? null : r.routing,
        r.preview,
        r.qr,
        r.password_hash ? 1 : 0,
        r.max_clicks,
        r.off_redirect,
      ]),
    ]);
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-links-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  })

  /**
   * Every link with its settings, for another workspace's import: the rows are
   * import rows, settings in `config`. Clicks are the lifetime total (counted
   * here, plus any imported before). Passwords are never exported, only that a
   * link had one, so importing it can't leave it open. Protected links are left
   * out for someone who may not see where they go.
   */
  .get("/export/links.json", async (c) => {
    const stats = seesStats(c);
    const [{ results }, counted] = await Promise.all([
      c.env.DB.prepare(`SELECT * FROM links${seesProtected(c) ? "" : " WHERE password_hash IS NULL"} ORDER BY created_at`).all<LinkRow>(),
      stats ? clicksByLink(c.env, "all") : Promise.resolve(new Map<string, number>()),
    ]);
    const links = results.map((r) => {
      // Without stats.view the export carries no counts at all, imported ones included.
      const clicks = stats ? (r.imported_clicks ?? 0) + (counted.get(linkKey(r.domain, r.slug)) ?? 0) : 0;
      return {
        domain: r.domain,
        slug: r.slug,
        target: r.target,
        title: r.title,
        tags: r.tags ? r.tags.split(",") : [],
        clicks: clicks || null,
        createdAt: r.created_at,
        config: {
          notes: r.notes,
          active: r.active === 1,
          expiresAt: r.expires_at,
          utm: r.utm === 1,
          utmTemplate: r.utm_template,
          passQuery: r.pass_query === 1,
          routing: parseRouting(r.routing),
          preview: parsePreview(r.preview),
          qr: r.qr ? (JSON.parse(r.qr) as Record<string, unknown>) : null,
          maxClicks: r.max_clicks,
          bio: parseBio(r.bio),
          broken: r.broken === 1,
          replacement: splitKey(r.replacement),
          offRedirect: r.off_redirect === OFF_HOME ? "home" : splitKey(r.off_redirect),
          monitor: r.monitor === MONITOR_ON,
          neverCheck: r.monitor === MONITOR_NEVER,
          passwordProtected: r.password_hash !== null,
        },
      };
    });
    const body = JSON.stringify({ format: "shorthop-links", version: 1, exportedAt: new Date().toISOString(), links }, null, 1);
    return c.body(body, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-links-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  });

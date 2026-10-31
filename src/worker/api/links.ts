import { Hono, type Context } from "hono";
import { linkKey } from "../../shared/domains";
import { sameSnapshot, snapshotOf, type Snapshot } from "../../shared/history";
import { parsePreview, validatePreview, type LinkPreview } from "../../shared/preview";
import { validateQrStyle } from "../../shared/qr";
import { capCount, capReset } from "../click-cap";
import { hashLinkPassword } from "../link-password";
import { parseRouting, splitChanged, validateRouting, type RouteRule, type Routing, type RoutingError } from "../../shared/routing";
import { pullLinks, VendorError } from "../import/vendors";
import { anyFlagged, UNSAFE_FLAGGED, UNSAFE_NONE, UNSAFE_TRUSTED } from "../safety";
import { validateBio, type BioPage } from "../../shared/bio";
import { bulkSchema, byTargetQuerySchema, pullSchema, createLinkSchema, exportQuerySchema, importSchema, linkParamSchema, normalizeTags, tagParamSchema, tagRenameSchema, versionParamSchema, listQuerySchema, resyncQuerySchema, updateLinkSchema } from "../../shared/schemas";
import { isCheckProblem, isChecked, MONITOR_DEFAULT, MONITOR_NEVER, MONITOR_ON, type CheckStatus } from "../../shared/link-check";
import { can } from "../../shared/permissions";
import { generateSlug, validateSlug } from "../../shared/slug";
import { normalizeTarget, validateUtmTemplate } from "../../shared/target";
import type { BulkResult, CapDTO, ImportResult, ImportRowResult, LinkDTO, LinkListItem } from "../../shared/types";
import { fullTokenScope, TOKEN_SCOPE_ERROR } from "../auth";
import { getDefaultUtm, getLink, kvKey, nowSec, OFF_HOME, publish, toDTO, type LinkRow } from "../db";
import { configuredDomains, domainsOf, isConfiguredDomain, NO_DOMAIN_ERROR, selfHosts, shortOrigin } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { planLimits } from "../plan";
import { changedFields, emit, emitAll, linkPayload, type Event } from "../webhooks";
import { deletedLinks, getVersion, listVersions, SNAPSHOT_SQL, versionStmt } from "../history";
import { clicksByLink } from "../stats-data";
import { checkedSql, getCheckSettings } from "../link-check";

function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(err));
}

/** A link as the API returns it, with the short URL of its own domain. */
function dto(c: Context<AppEnv>, row: LinkRow): LinkDTO {
  return toDTO(row, shortOrigin(c.env, c.req.raw, row.domain));
}

const notConfigured = (domain: string) => `domain: "${domain}" is not one of your short domains (SHORT_DOMAINS).`;

function insertStmt(db: D1Database, r: LinkRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, broken, replacement, off_redirect, monitor, routing, preview, qr, password_hash, max_clicks, unsafe, unsafe_at, bio, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.domain, r.slug, r.target, r.active, r.expires_at, r.utm, r.utm_template, r.pass_query, r.title, r.tags, r.notes, r.source, r.imported_clicks, r.broken, r.replacement, r.off_redirect, r.monitor, r.routing, r.preview, r.qr, r.password_hash, r.max_clicks, r.unsafe ?? 0, r.unsafe_at ?? null, r.bio ?? null, r.created_at, r.updated_at);
}

function updateStmt(db: D1Database, r: LinkRow): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE links SET target = ?, active = ?, expires_at = ?, utm = ?, utm_template = ?, pass_query = ?,
       title = ?, tags = ?, notes = ?, broken = ?, replacement = ?, off_redirect = ?, monitor = ?, routing = ?, preview = ?, qr = ?, password_hash = ?, max_clicks = ?,
       unsafe = COALESCE(?, unsafe), unsafe_at = COALESCE(?, unsafe_at), bio = ?, updated_at = ? WHERE domain = ? AND slug = ? RETURNING *`,
    )
    .bind(r.target, r.active, r.expires_at, r.utm, r.utm_template, r.pass_query, r.title, r.tags, r.notes, r.broken, r.replacement, r.off_redirect, r.monitor, r.routing, r.preview, r.qr, r.password_hash, r.max_clicks, r.unsafe ?? null, r.unsafe_at ?? null, r.bio ?? null, r.updated_at, r.domain, r.slug);
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

/**
 * Saves an edit of an existing link with its version, runs onSaved (webhook
 * events) once D1 has it, then publishes it.
 * RETURNING: a link deleted since it was read must not be published back to KV.
 */
async function saveEdit(c: Context<AppEnv>, next: LinkRow, version: D1PreparedStatement | null, onSaved?: (saved: LinkRow) => Promise<void>) {
  const [updated] = await c.env.DB.batch<LinkRow>([updateStmt(c.env.DB, next), ...(version ? [version] : [])]);
  const saved = updated?.results[0];
  if (!saved) return c.json({ error: "Link not found" }, 404);
  await onSaved?.(saved);
  if (!(await published(c.env, saved))) return c.json({ error: PUBLISH_FAILED, link: dto(c, saved) }, 502);
  // A delete that ran between the update and the publish would leave a record
  // for a link that's gone. Together with the delete's second KV pass, KV ends
  // up matching D1 whichever way the two interleave.
  if (!(await getLink(c.env.DB, saved.domain, saved.slug))) {
    await c.env.LINKS.delete(kvKey(saved.domain, saved.slug));
    return c.json({ error: "Link not found" }, 404);
  }
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
  return null;
}

/**
 * The bio JSON to store: unchanged when not sent, null to turn it off,
 * otherwise checked, and its buttons' short links must exist (here, now).
 */
async function bioFor(c: Context<AppEnv>, input: BioPage | null | undefined, prev: string | null): Promise<{ ok: true; json: string | null } | { ok: false; error: string }> {
  if (input === undefined) return { ok: true, json: prev };
  if (input === null) return { ok: true, json: null };
  const checked = validateBio(input);
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

/** A link's destinations: its target and every enabled routing variant. */
function destinationsOf(target: string, routing: string | null): string[] {
  const rules = parseRouting(routing)?.rules.filter((r) => r.enabled) ?? [];
  return [target, ...rules.flatMap((r) => r.variants.map((v) => v.url))];
}

/** stat_shares rows that still work (not revoked, not expired), for the links list. */
const ACTIVE_SHARE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())";

/** The links list's filters as SQL (shared by the list and its export). */
/** Escapes LIKE wildcards for a pattern used with ESCAPE '\'. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function listFilter(f: { domain?: string; q?: string; tag?: string; status: string }, scope: Parameters<typeof checkedSql>[0]): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.domain) {
    params.push(f.domain);
    where.push(`domain = ?${params.length}`);
  }
  if (f.q) {
    params.push(`%${likeEscape(f.q)}%`);
    const n = params.length;
    where.push(`(slug LIKE ?${n} ESCAPE '\\' OR target LIKE ?${n} ESCAPE '\\' OR title LIKE ?${n} ESCAPE '\\' OR notes LIKE ?${n} ESCAPE '\\')`);
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
    return { before: r, after: { ...r, tags: tags.join(","), updated_at: now } };
  });
  await c.env.DB.batch(updates.flatMap(({ after }) => [updateStmt(c.env.DB, after), versionStmt(c.env.DB, after, "update", identity)]));
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
    const { where, params } = listFilter({ domain, q, tag, status }, scope);
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
      c.env.DB.prepare("SELECT target, status, problem, http_status, checked_at FROM target_checks").all<{
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
      // The worst state across the target and every routed destination.
      const urls = [r.target, ...(parseRouting(r.routing)?.rules.filter((x) => x.enabled).flatMap((x) => x.variants.map((v) => v.url)) ?? [])];
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
    const { results } = await c.env.DB.prepare("SELECT * FROM links WHERE target = ? ORDER BY created_at LIMIT 10").bind(target.url).all<LinkRow>();
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

    const changed: { before: LinkRow; after: LinkRow }[] = [];
    for (const r of rows) {
      const next: LinkRow = { ...r, updated_at: now };
      if (action === "enable" || action === "disable") next.active = action === "enable" ? 1 : 0;
      else {
        const current = r.tags ? r.tags.split(",") : [];
        const tags = action === "addTag" ? normalizeTags([...current, tag]) : current.filter((t) => t !== tag);
        next.tags = tags.join(",");
      }
      if (next.active === r.active && next.tags === r.tags) result.unchanged++;
      else changed.push({ before: r, after: next });
    }
    if (changed.length) {
      await c.env.DB.batch(changed.flatMap(({ after }) => [updateStmt(c.env.DB, after), versionStmt(c.env.DB, after, "update", identity)]));
      // Tags aren't part of the published record; turning a link on or off is.
      if (action === "enable" || action === "disable") {
        const defaultUtm = await getDefaultUtm(c.env.DB);
        await Promise.all(
          changed.map(async ({ after }) => {
            try {
              await publish(c.env, after, defaultUtm);
            } catch (err) {
              console.error(JSON.stringify({ message: "kv publish failed", domain: after.domain, slug: after.slug, error: String(err) }));
              result.failed.push({ domain: after.domain, slug: after.slug, error: "Saved, but publishing failed; use Republish all links in Settings." });
            }
          }),
        );
      }
      const events: Event[] = changed.map(({ before, after }) => ({ type: "link.updated", data: { link: linkPayload(after), changes: changedFields(before, after) } }));
      await emitAll(c.env, events, { ctx: c.executionCtx });
    }
    result.changed = changed.length;
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

    const now = nowSec();
    // Malware or phishing, per Cloudflare's security DNS: saved, but visitors are warned first.
    const flagged = await anyFlagged(c.env, destinationsOf(target.url, routing.json));
    const base: Omit<LinkRow, "slug"> = {
      domain,
      unsafe: flagged ? UNSAFE_FLAGGED : UNSAFE_NONE,
      unsafe_at: now,
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
    const next: LinkRow = { ...row, updated_at: nowSec() };

    if (body.target !== undefined) {
      const target = normalizeTarget(body.target, {
        allowHttp: row.source === "import",
        selfHosts: selfHosts(c.env, c.req.raw),
      });
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
    if (body.tags !== undefined) next.tags = body.tags.join(",");
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
    if (destinationsChanged) {
      next.unsafe = (await anyFlagged(c.env, destinationsOf(next.target, next.routing))) ? UNSAFE_FLAGGED : UNSAFE_NONE;
      next.unsafe_at = nowSec();
    }
    if (body.trustDestination !== undefined && (next.unsafe ?? 0) !== UNSAFE_NONE) next.unsafe = body.trustDestination ? UNSAFE_TRUSTED : UNSAFE_FLAGGED;
    const unsafeChanged = (next.unsafe ?? 0) !== (row.unsafe ?? 0);

    // A new limit counts from now; changing an existing one keeps the count.
    if (row.max_clicks === null && next.max_clicks !== null) await resetCounter(c.env, next);
    const changed = !sameSnapshot(snapshotOf(row), snapshotOf(next)) || unsafeChanged;
    return saveEdit(c, next, changed ? versionStmt(c.env.DB, next, "update", c.get("identity"), { at: next.updated_at }) : null, async (saved) => {
      if (changed) await emit(c.env, "link.updated", { link: linkPayload(saved), changes: changedFields(row, saved) }, { ctx: c.executionCtx });
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
    return c.json({ versions: await listVersions(c.env.DB, domain, slug) });
  })

  /** Puts a link back the way it was in an earlier version. */
  .post("/links/:domain/:slug/history/:id/restore", validate("param", versionParamSchema), async (c) => {
    const { domain, slug, id } = c.req.valid("param");
    const [row, version] = await Promise.all([getLink(c.env.DB, domain, slug), getVersion(c.env.DB, domain, slug, id)]);
    if (!row) return c.json({ error: "Link not found" }, 404);
    if (!version || version.action === "delete") return c.json({ error: "That version doesn't exist." }, 404);
    const next = withSnapshot(row, version.snapshot);
    const invalid = restoreProblem(c, next);
    if (invalid) return c.json({ error: invalid }, 400);
    if (sameSnapshot(snapshotOf(row), snapshotOf(next))) return c.json({ error: "The link already matches this version." }, 409);
    return saveEdit(c, next, versionStmt(c.env.DB, next, "restore", c.get("identity"), { at: next.updated_at, restoredFrom: id }), async (saved) => {
      await emit(c.env, "link.updated", { link: linkPayload(saved), changes: changedFields(row, saved), restored_version: id }, { ctx: c.executionCtx });
    });
  })

  /** A capped link's counter. */
  .get("/links/:domain/:slug/cap", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const row = await getLink(c.env.DB, domain, slug);
    if (!row) return c.json({ error: "Link not found" }, 404);
    const cap: CapDTO = { limit: row.max_clicks, count: row.max_clicks ? await capCount(c.env, domain, slug) : 0 };
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

  .get("/deleted", async (c) => c.json({ links: await deletedLinks(c.env.DB) }))

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
    if (mode === "overwrite" && !can(c.get("actor"), "links.edit")) {
      return c.json({ error: "Overwriting existing links needs the Edit links permission." }, 403);
    }
    // Overwriting would retarget existing links, which the API token's default scope can't do.
    if (mode === "overwrite" && c.get("actor").via === "token" && !fullTokenScope(c.env)) {
      return c.json({ error: TOKEN_SCOPE_ERROR }, 403);
    }
    const now = nowSec();
    const results: ImportRowResult[] = [];
    const valid: LinkRow[] = [];
    const seen = new Set<string>();
    const seenLower = new Map<string, string>();
    const fallbackDomain = defaultDomain || domainsOf(c.env).primary;
    /** Rows that brought their own settings: an overwrite replaces those too. */
    const withConfig = new Set<string>();
    const domainFor = (r: (typeof rows)[number]) => r.domain || fallbackDomain;

    const { results: existing } = await c.env.DB.prepare(
      `SELECT json_extract(j.value, '$[0]') AS domain, json_extract(j.value, '$[1]') AS wanted, l.slug
       FROM json_each(?1) j
       JOIN links l ON l.domain = json_extract(j.value, '$[0]') AND l.slug = json_extract(j.value, '$[1]') COLLATE NOCASE`,
    )
      .bind(JSON.stringify(rows.map((r) => [domainFor(r), r.slug])))
      .all<{ domain: string; wanted: string; slug: string }>();
    const exact = new Set(existing.filter((e) => e.wanted === e.slug).map((e) => linkKey(e.domain, e.slug)));
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
      const target = normalizeTarget(r.target, { allowHttp: true, selfHosts: selfHosts(c.env, c.req.raw) });
      if (!target.ok) {
        fail(target.error);
        continue;
      }
      const exists = exact.has(key);
      if (exists && mode === "skip") {
        results.push({ domain, slug: r.slug, status: "skipped", message: "Already exists." });
        continue;
      }
      const notes: string[] = [];
      if (target.url !== r.target.trim()) notes.push(`Target normalized to ${target.url}`);
      if (target.url.startsWith("http:")) notes.push("Target uses http://");
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
        routing = rt.json;
        preview = pv.json;
      }
      valid.push({
        domain,
        slug: r.slug,
        target: target.url,
        active: cfg?.active === false ? 0 : 1,
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
        broken: 0,
        replacement: null,
        off_redirect: null,
        monitor: MONITOR_DEFAULT,
        routing,
        preview,
        qr: qrStyle,
        password_hash: null,
        max_clicks: cfg?.maxClicks ?? null,
        created_at: r.createdAt ?? now,
        updated_at: now,
      });
      if (cfg) withConfig.add(key);
      results.push({ domain, slug: r.slug, status: exists ? "updated" : "created", message: notes.join("; ") || undefined });
    }

    if (!dryRun && valid.length > 0) {
      // Skip mode never overwrites, even a link created since the check above.
      // Settings from a JSON export (?22 = 1) replace the existing link's; otherwise they're kept.
      const fromConfig = (col: string) => `${col} = CASE WHEN ?22 = 1 THEN excluded.${col} ELSE links.${col} END`;
      const onConflict =
        mode === "overwrite"
          ? `DO UPDATE SET target = excluded.target, title = COALESCE(excluded.title, links.title),
           imported_clicks = COALESCE(excluded.imported_clicks, links.imported_clicks), source = 'import',
           import_from = COALESCE(excluded.import_from, links.import_from),
           ${["active", "expires_at", "utm", "utm_template", "pass_query", "notes", "routing", "preview", "qr", "max_clicks"].map(fromConfig).join(", ")},
           updated_at = excluded.updated_at`
          : "DO NOTHING";
      const stmt = c.env.DB.prepare(
        `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, monitor,
           routing, preview, qr, max_clicks, import_from, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
         ON CONFLICT (domain, slug) ${onConflict}`,
      );
      const keysJson = JSON.stringify(valid.map((r) => [r.domain, r.slug]));
      await c.env.DB.batch([
        ...valid.map((r) =>
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
            // ?22 only appears in the overwrite statement.
            ...(mode === "overwrite" ? [withConfig.has(linkKey(r.domain, r.slug)) ? 1 : 0] : []),
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
    const { where, params } = listFilter(filter, scope);
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
    const body = csv([
      ["domain", "slug", "short_url", "target", "active", "expires_at", "utm", "utm_template", "pass_query", "title", "tags", "notes", "source", "imported_clicks", "created_at", "updated_at", "broken", "replacement", "monitor", "routing", "preview", "qr", "password_protected", "max_clicks", "off_redirect"],
      ...results.map((r) => [
        r.domain,
        r.slug,
        dto(c, r).shortUrl,
        r.target,
        r.active,
        iso(r.expires_at),
        r.utm,
        r.utm_template,
        r.pass_query,
        r.title,
        r.tags,
        r.notes,
        r.source,
        r.imported_clicks,
        iso(r.created_at),
        iso(r.updated_at),
        r.broken,
        r.replacement,
        r.monitor,
        r.routing,
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
   * here, plus any imported before). Passwords are never exported.
   */
  .get("/export/links.json", async (c) => {
    const [{ results }, counted] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM links ORDER BY created_at").all<LinkRow>(),
      can(c.get("actor"), "stats.view") ? clicksByLink(c.env, "all") : Promise.resolve(new Map<string, number>()),
    ]);
    const links = results.map((r) => {
      const clicks = (r.imported_clicks ?? 0) + (counted.get(linkKey(r.domain, r.slug)) ?? 0);
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
        },
      };
    });
    const body = JSON.stringify({ format: "shorthop-links", version: 1, exportedAt: new Date().toISOString(), links }, null, 1);
    return c.body(body, 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-links-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  });

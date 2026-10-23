import { Hono, type Context } from "hono";
import { linkKey } from "../../shared/domains";
import { sameSnapshot, snapshotOf, type Snapshot } from "../../shared/history";
import { parsePreview, validatePreview, type LinkPreview } from "../../shared/preview";
import { validateQrStyle } from "../../shared/qr";
import { capCount, capReset } from "../click-cap";
import { hashLinkPassword } from "../link-password";
import { parseRouting, splitChanged, validateRouting, type RouteRule, type Routing, type RoutingError } from "../../shared/routing";
import { createLinkSchema, importSchema, linkParamSchema, versionParamSchema, listQuerySchema, resyncQuerySchema, updateLinkSchema } from "../../shared/schemas";
import { isCheckProblem, type CheckStatus } from "../../shared/link-check";
import { can } from "../../shared/permissions";
import { generateSlug, validateSlug } from "../../shared/slug";
import { normalizeTarget, validateUtmTemplate } from "../../shared/target";
import type { CapDTO, ImportResult, ImportRowResult, LinkDTO, LinkListItem } from "../../shared/types";
import { fullTokenScope, TOKEN_SCOPE_ERROR } from "../auth";
import { getDefaultUtm, getLink, kvKey, nowSec, publish, toDTO, type LinkRow } from "../db";
import { domainsOf, isConfiguredDomain, selfHosts, shortOrigin } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { changedFields, emit, linkPayload } from "../webhooks";
import { deletedLinks, getVersion, listVersions, SNAPSHOT_SQL, versionStmt } from "../history";
import { clicksByLink } from "../stats-data";

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
      `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, broken, replacement, monitor, routing, preview, qr, password_hash, max_clicks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.domain, r.slug, r.target, r.active, r.expires_at, r.utm, r.utm_template, r.pass_query, r.title, r.tags, r.notes, r.source, r.imported_clicks, r.broken, r.replacement, r.monitor, r.routing, r.preview, r.qr, r.password_hash, r.max_clicks, r.created_at, r.updated_at);
}

function updateStmt(db: D1Database, r: LinkRow): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE links SET target = ?, active = ?, expires_at = ?, utm = ?, utm_template = ?, pass_query = ?,
       title = ?, tags = ?, notes = ?, broken = ?, replacement = ?, monitor = ?, routing = ?, preview = ?, qr = ?, password_hash = ?, max_clicks = ?, updated_at = ? WHERE domain = ? AND slug = ? RETURNING *`,
    )
    .bind(r.target, r.active, r.expires_at, r.utm, r.utm_template, r.pass_query, r.title, r.tags, r.notes, r.broken, r.replacement, r.monitor, r.routing, r.preview, r.qr, r.password_hash, r.max_clicks, r.updated_at, r.domain, r.slug);
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
    monitor: s.monitor ?? 1,
    routing: s.routing ?? null,
    preview: s.preview ?? null,
    qr: s.qr ?? null,
    password_hash: s.password_hash ?? null,
    max_clicks: s.max_clicks ?? null,
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
  const preview = parsePreview(r.preview);
  if (preview && !validatePreview(preview).ok) return "This version can't be restored: its social preview is no longer valid.";
  const routing = parseRouting(r.routing);
  if (routing) {
    const checked = validateRouting(routing, { selfHosts: selfHosts(c.env, c.req.raw) });
    if (!checked.ok) return `This version can't be restored: smart routing: ${checked.errors[0]!.message}`;
  }
  return null;
}

/** Import events sent straight away; the rest wait for the cron (outbound request limits). */
const IMPORT_EVENTS_NOW = 5;

const PUBLISH_FAILED = "Saved, but publishing to KV failed. Save it again in a minute, or use “Republish all links” in Settings → General.";

/** Rows GET /links returns at most. */
const LIST_LIMIT = 5000;

/** Escapes LIKE wildcards for a pattern used with ESCAPE '\'. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

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
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (domain) {
      params.push(domain);
      where.push(`domain = ?${params.length}`);
    }
    if (q) {
      params.push(`%${likeEscape(q)}%`);
      const n = params.length;
      where.push(`(slug LIKE ?${n} ESCAPE '\\' OR target LIKE ?${n} ESCAPE '\\' OR title LIKE ?${n} ESCAPE '\\' OR notes LIKE ?${n} ESCAPE '\\')`);
    }
    if (tag) {
      params.push(`%,${likeEscape(tag)},%`);
      where.push(`(',' || tags || ',') LIKE ?${params.length} ESCAPE '\\'`);
    }
    const now = nowSec();
    if (status === "active") where.push(`active = 1 AND (expires_at IS NULL OR expires_at > ${now}) AND broken = 0`);
    if (status === "broken") where.push(`active = 1 AND (expires_at IS NULL OR expires_at > ${now}) AND broken = 1`);
    if (status === "disabled") where.push("active = 0");
    if (status === "expired") where.push(`expires_at IS NOT NULL AND expires_at <= ${now}`);
    if (status === "failing") {
      where.push(`active = 1 AND (expires_at IS NULL OR expires_at > ${now}) AND broken = 0 AND monitor = 1`);
      where.push(
        "(domain, slug) IN (SELECT domain, slug FROM link_destinations WHERE url IN (SELECT target FROM target_checks WHERE status IN ('warning', 'down')))",
      );
    }
    const counts = Promise.all([clicksByLink(c.env, "all"), period === "all" ? null : clicksByLink(c.env, period)]);
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
    const [{ results }, [totals, inPeriod], checks] = await Promise.all([
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
    ]);
    const clicks = inPeriod ?? totals;
    const checkOf = new Map(checks.results.map((r) => [r.target, r]));
    let links: LinkListItem[] = results.map((r) => {
      const key = linkKey(r.domain, r.slug);
      // The worst state across the target and every routed destination.
      const urls = [r.target, ...(parseRouting(r.routing)?.rules.filter((x) => x.enabled).flatMap((x) => x.variants.map((v) => v.url)) ?? [])];
      const ch = r.monitor ? worstCheck(urls.map((u) => checkOf.get(u))) : undefined;
      return {
        ...dto(c, r),
        clicksPeriod: clicks.get(key) ?? 0,
        clicksTotal: totals.get(key) ?? 0,
        check: ch ? { state: ch.status, problem: isCheckProblem(ch.problem) ? ch.problem : null, httpStatus: ch.http_status, checkedAt: ch.checked_at } : null,
      };
    });
    if (sort === "clicks") links = links.sort((a, b) => b.clicksPeriod - a.clicksPeriod || b.clicksTotal - a.clicksTotal);
    return c.json({ links });
  })

  .post("/links", validate("json", createLinkSchema), async (c) => {
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

    const now = nowSec();
    const base: Omit<LinkRow, "slug"> = {
      domain,
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
      monitor: body.monitor === false ? 0 : 1,
      routing: routing.json,
      preview: preview.json,
      qr: null,
      password_hash: body.password ? await hashLinkPassword(body.password) : null,
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
    if (body.monitor !== undefined) next.monitor = body.monitor ? 1 : 0;
    const routing = routingFor(c, body.routing, row.routing);
    if (!routing.ok) return c.json({ error: routing.error, details: routing.details }, 400);
    next.routing = routing.json;
    const preview = previewFor(body.preview, row.preview);
    if (!preview.ok) return c.json({ error: preview.error }, 400);
    next.preview = preview.json;
    if (body.password !== undefined) next.password_hash = body.password === null ? null : await hashLinkPassword(body.password);
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

    // A new limit counts from now; changing an existing one keeps the count.
    if (row.max_clicks === null && next.max_clicks !== null) await resetCounter(c.env, next);
    const changed = !sameSnapshot(snapshotOf(row), snapshotOf(next));
    return saveEdit(c, next, changed ? versionStmt(c.env.DB, next, "update", c.get("identity"), { at: next.updated_at }) : null, async (saved) => {
      if (changed) await emit(c.env, "link.updated", { link: linkPayload(saved), changes: changedFields(row, saved) }, { ctx: c.executionCtx });
    });
  })

  /** Links that point visitors to this one while marked "no longer working". */
  .get("/links/:domain/:slug/dependents", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const { results } = await c.env.DB.prepare("SELECT * FROM links WHERE replacement = ? AND broken = 1 ORDER BY domain, slug")
      .bind(linkKey(domain, slug))
      .all<LinkRow>();
    return c.json({ links: results.map((r) => dto(c, r)) });
  })

  .delete("/links/:domain/:slug", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    if (!(await getLink(c.env.DB, domain, slug))) return c.json({ error: "Link not found" }, 404);
    // KV first: if this fails the link still exists in D1 and the delete can be retried;
    // the other way round, a leftover KV record would keep redirecting.
    await c.env.LINKS.delete(kvKey(domain, slug));
    // The delete's version keeps the link as D1 holds it, so it can be restored.
    const [, removed] = await c.env.DB.batch<LinkRow>([
      c.env.DB.prepare(
        `INSERT INTO link_versions (domain, slug, at, action, actor, snapshot)
         SELECT domain, slug, ?1, 'delete', ?2, ${SNAPSHOT_SQL} FROM links WHERE domain = ?3 AND slug = ?4`,
      ).bind(nowSec(), c.get("identity"), domain, slug),
      c.env.DB.prepare("DELETE FROM links WHERE domain = ? AND slug = ? RETURNING *").bind(domain, slug),
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

  .post("/import", validate("json", importSchema), async (c) => {
    const { rows, mode, dryRun, defaultDomain } = c.req.valid("json");
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
      valid.push({
        domain,
        slug: r.slug,
        target: target.url,
        active: 1,
        expires_at: null,
        utm: 0,
        utm_template: null,
        pass_query: 0,
        title: r.title || null,
        tags: (r.tags ?? []).join(","),
        notes: "",
        source: "import",
        imported_clicks: r.clicks ?? null,
        broken: 0,
        replacement: null,
        monitor: 1,
        routing: null,
        preview: null,
        qr: null,
        password_hash: null,
        max_clicks: null,
        created_at: r.createdAt ?? now,
        updated_at: now,
      });
      results.push({ domain, slug: r.slug, status: exists ? "updated" : "created", message: notes.join("; ") || undefined });
    }

    if (!dryRun && valid.length > 0) {
      // Skip mode never overwrites, even a link created since the check above.
      const onConflict =
        mode === "overwrite"
          ? `DO UPDATE SET target = excluded.target, title = COALESCE(excluded.title, links.title),
           imported_clicks = COALESCE(excluded.imported_clicks, links.imported_clicks), source = 'import',
           updated_at = excluded.updated_at`
          : "DO NOTHING";
      const stmt = c.env.DB.prepare(
        `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            r.created_at,
            r.updated_at,
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
      // New links only. The first few are sent now; the cron sends the rest, a few each run.
      const created = new Set(results.filter((r) => r.status === "created").map((r) => linkKey(r.domain, r.slug)));
      let sentNow = 0;
      for (const r of saved) {
        if (!created.has(linkKey(r.domain, r.slug))) continue;
        await emit(c.env, "link.created", { link: linkPayload(r), imported: true }, sentNow++ < IMPORT_EVENTS_NOW ? { ctx: c.executionCtx } : {});
      }
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

  .post("/resync", validate("query", resyncQuerySchema), async (c) => {
    // Republishes links to KV in pages of 200 (keeps each call well inside
    // per-invocation limits). Call again with `next` until it is null.
    const { after = "", scope } = c.req.valid("query");
    const cut = after.indexOf("/");
    const [afterDomain, afterSlug] = cut === -1 ? [after, ""] : [after.slice(0, cut), after.slice(cut + 1)];
    const onlyDefaultUtm = scope === "default-utm" ? " AND utm = 1 AND utm_template IS NULL" : "";
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM links WHERE (domain > ?1 OR (domain = ?1 AND slug > ?2))${onlyDefaultUtm} ORDER BY domain, slug LIMIT 200`,
    )
      .bind(afterDomain, afterSlug)
      .all<LinkRow>();
    const defaultUtm = await getDefaultUtm(c.env.DB);
    await Promise.all(results.map((r) => publish(c.env, r, defaultUtm)));
    const last = results.at(-1);
    return c.json({ published: results.length, next: results.length === 200 && last ? linkKey(last.domain, last.slug) : null });
  })

  .get("/export/links.csv", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM links ORDER BY created_at").all<LinkRow>();
    // An out-of-range date (an import from elsewhere) is left blank rather than failing the export.
    const iso = (s: number | null) => {
      const d = new Date((s ?? NaN) * 1000);
      return Number.isFinite(d.getTime()) ? d.toISOString() : "";
    };
    const body = csv([
      ["domain", "slug", "short_url", "target", "active", "expires_at", "utm", "utm_template", "pass_query", "title", "tags", "notes", "source", "imported_clicks", "created_at", "updated_at", "broken", "replacement", "monitor", "routing", "preview", "qr", "password_protected", "max_clicks"],
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
      ]),
    ]);
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-links-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  });

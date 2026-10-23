import { Hono, type Context } from "hono";
import { linkKey } from "../../shared/domains";
import { createLinkSchema, importSchema, linkParamSchema, listQuerySchema, resyncQuerySchema, updateLinkSchema } from "../../shared/schemas";
import { isCheckProblem, type CheckStatus } from "../../shared/link-check";
import { generateSlug, validateSlug } from "../../shared/slug";
import { normalizeTarget, validateUtmTemplate } from "../../shared/target";
import type { ImportResult, ImportRowResult, LinkDTO, LinkListItem } from "../../shared/types";
import { fullTokenScope, TOKEN_SCOPE_ERROR } from "../auth";
import { getDefaultUtm, getLink, kvKey, nowSec, publish, toDTO, type LinkRow } from "../db";
import { domainsOf, isConfiguredDomain, selfHosts, shortOrigin } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { clicksByLink } from "../stats-data";

function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(err));
}

/** A link as the API returns it, with the short URL of its own domain. */
function dto(c: Context<AppEnv>, row: LinkRow): LinkDTO {
  return toDTO(row, shortOrigin(c.env, c.req.raw, row.domain));
}

const notConfigured = (domain: string) => `domain: "${domain}" is not one of your short domains (SHORT_DOMAINS).`;

const PUBLISH_FAILED = "Saved, but publishing to KV failed. Run “Republish all links” in Settings.";

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
      where.push("target IN (SELECT target FROM target_checks WHERE status IN ('warning', 'down'))");
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
      const ch = r.monitor ? checkOf.get(r.target) : undefined;
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
        await c.env.DB.prepare(
          `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, monitor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            candidate.domain,
            candidate.slug,
            candidate.target,
            candidate.active,
            candidate.expires_at,
            candidate.utm,
            candidate.utm_template,
            candidate.pass_query,
            candidate.title,
            candidate.tags,
            candidate.notes,
            candidate.source,
            candidate.imported_clicks,
            candidate.monitor,
            candidate.created_at,
            candidate.updated_at,
          )
          .run();
        row = candidate;
        break;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (custom) return c.json({ error: `slug: "${custom}" is already taken on ${domain}.` }, 409);
      }
    }
    if (!row) return c.json({ error: "Could not generate a free slug. Try again." }, 500);

    try {
      await publishSaved(c.env, row);
    } catch (err) {
      console.error(JSON.stringify({ message: "kv publish failed", domain: row.domain, slug: row.slug, error: String(err) }));
      return c.json({ error: PUBLISH_FAILED, link: dto(c, row) }, 502);
    }
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
    if (body.broken !== undefined) next.broken = body.broken ? 1 : 0;
    if (body.replacement !== undefined) {
      const r = body.replacement;
      if (r) {
        if (r.domain === domain && r.slug === slug) return c.json({ error: "replacement: A link can't replace itself." }, 400);
        if (!(await getLink(c.env.DB, r.domain, r.slug))) return c.json({ error: `replacement: ${linkKey(r.domain, r.slug)} doesn't exist.` }, 400);
      }
      next.replacement = r ? linkKey(r.domain, r.slug) : null;
    }

    // RETURNING: a link deleted since the read above must not be published back to KV.
    const saved = await c.env.DB.prepare(
      `UPDATE links SET target = ?, active = ?, expires_at = ?, utm = ?, utm_template = ?, pass_query = ?,
       title = ?, tags = ?, notes = ?, broken = ?, replacement = ?, monitor = ?, updated_at = ? WHERE domain = ? AND slug = ? RETURNING *`,
    )
      .bind(
        next.target,
        next.active,
        next.expires_at,
        next.utm,
        next.utm_template,
        next.pass_query,
        next.title,
        next.tags,
        next.notes,
        next.broken,
        next.replacement,
        next.monitor,
        next.updated_at,
        next.domain,
        next.slug,
      )
      .first<LinkRow>();
    if (!saved) return c.json({ error: "Link not found" }, 404);

    try {
      await publishSaved(c.env, saved);
    } catch (err) {
      console.error(JSON.stringify({ message: "kv publish failed", domain: saved.domain, slug: saved.slug, error: String(err) }));
      return c.json({ error: PUBLISH_FAILED, link: dto(c, saved) }, 502);
    }
    // A delete that ran between the update and the publish would leave a record
    // for a link that's gone. Together with the delete's second KV pass, KV ends
    // up matching D1 whichever way the two interleave.
    if (!(await getLink(c.env.DB, saved.domain, saved.slug))) {
      await c.env.LINKS.delete(kvKey(saved.domain, saved.slug));
      return c.json({ error: "Link not found" }, 404);
    }
    return c.json({ link: dto(c, saved) });
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
    await c.env.DB.prepare("DELETE FROM links WHERE domain = ? AND slug = ?").bind(domain, slug).run();
    // Again, for an edit that published between the two steps above (its own check covers later ones).
    await c.env.LINKS.delete(kvKey(domain, slug));
    return c.json({ deleted: slug, domain });
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
    // Overwriting would retarget existing links, which the default token scope can't do.
    if (mode === "overwrite" && c.get("identity") === "api-token" && !fullTokenScope(c.env)) {
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
        created_at: r.createdAt ?? now,
        updated_at: now,
      });
      results.push({ domain, slug: r.slug, status: exists ? "updated" : "created", message: notes.join("; ") || undefined });
    }

    if (!dryRun && valid.length > 0) {
      const stmt = c.env.DB.prepare(
        `INSERT INTO links (domain, slug, target, active, expires_at, utm, utm_template, pass_query, title, tags, notes, source, imported_clicks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (domain, slug) DO UPDATE SET target = excluded.target, title = COALESCE(excluded.title, links.title),
           imported_clicks = COALESCE(excluded.imported_clicks, links.imported_clicks), source = 'import',
           updated_at = excluded.updated_at`,
      );
      await c.env.DB.batch(
        valid.map((r) =>
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
      );
      // Publish what D1 now holds (an overwrite keeps the link's other settings).
      const { results: saved } = await c.env.DB.prepare(
        `SELECT l.* FROM json_each(?1) j
         JOIN links l ON l.domain = json_extract(j.value, '$[0]') AND l.slug = json_extract(j.value, '$[1]')`,
      )
        .bind(JSON.stringify(valid.map((r) => [r.domain, r.slug])))
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
      ["domain", "slug", "short_url", "target", "active", "expires_at", "utm", "utm_template", "pass_query", "title", "tags", "notes", "source", "imported_clicks", "created_at", "updated_at", "broken", "replacement", "monitor"],
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
      ]),
    ]);
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-links-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  });

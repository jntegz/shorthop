import { Hono } from "hono";
import { z } from "zod";
import { rangeBounds } from "../../shared/dates";
import { HOSTNAME_RE, linkLabel } from "../../shared/domains";
import { clearMissesSchema, linkParamSchema, missExportQuerySchema, missPolicySchema, rangeQuerySchema } from "../../shared/schemas";
import { IMPORT_SLUG_RE } from "../../shared/slug";
import type { RecentHit } from "../../shared/types";
import { aeAvailable, queryRecent, queryScanners } from "../ae";
import { domainsOf } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { clearMisses, saveMissPolicy } from "../misses";
import { linkStats, missReport, overview } from "../stats-data";

const recentQuerySchema = z.object({
  /** With a slug and no domain, the primary domain. */
  domain: z.string().regex(HOSTNAME_RE).optional(),
  slug: z.string().regex(IMPORT_SLUG_RE).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Misses only, each marked with whether the scanner rule counts it as a bot. */
  event: z.literal("miss").optional(),
});

export const statsApi = new Hono<AppEnv>()
  .get("/overview", validate("query", rangeQuerySchema), async (c) => {
    return c.json(await overview(c.env, c.req.valid("query").range));
  })

  .get("/links/:domain/:slug", validate("param", linkParamSchema), validate("query", rangeQuerySchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    return c.json(await linkStats(c.env, domain, slug, c.req.valid("query").range));
  })

  .get("/misses", validate("query", rangeQuerySchema), async (c) => {
    return c.json(await missReport(c.env, c.req.valid("query").range));
  })

  .post("/misses/clear", validate("json", clearMissesSchema), async (c) => {
    const { links, probes } = c.req.valid("json");
    const target = links ?? (probes ? "probes" : "all");
    await clearMisses(c.env, target);
    const cleared: "all" | "probes" | number = Array.isArray(target) ? target.length : target;
    console.log(JSON.stringify({ message: "misses cleared", count: cleared }));
    return c.json({ cleared });
  })

  .put("/misses/policy", validate("json", missPolicySchema), async (c) => {
    const policy = c.req.valid("json");
    const removed = await saveMissPolicy(c.env, policy);
    console.log(JSON.stringify({ message: "miss policy saved", ...policy, removed }));
    return c.json({ policy, removed });
  })

  .get("/misses/export.csv", validate("query", missExportQuerySchema), async (c) => {
    const { range, probes, bots } = c.req.valid("query");
    const { rows } = await missReport(c.env, range);
    const { primary } = domainsOf(c.env);
    const why = (r: (typeof rows)[number]) =>
      r.link === "disabled"
        ? "link disabled"
        : r.link === "expired"
          ? "link expired"
          : r.link === "active"
            ? "created since"
            : r.probe
              ? "scanner probe"
              : r.suggestion
                ? "case differs"
                : "no such link";
    const body = csv([
      ["domain", "path", "link", "human_visits", "bot_visits", "last_seen", "why", "case_match"],
      ...rows
        .filter((r) => (probes === "1" || !r.probe) && (bots === "1" || r.hits > 0))
        .map((r) => [r.domain, r.slug, linkLabel(r.domain, r.slug, primary), r.hits, r.bots, r.lastSeen, why(r), r.suggestion ?? ""]),
    ]);
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-misses-${range}-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  })

  .get("/recent", validate("query", recentQuerySchema), async (c) => {
    const { slug, limit, event } = c.req.valid("query");
    const domain = c.req.valid("query").domain ?? (slug ? domainsOf(c.env).primary : undefined);
    if (!aeAvailable(c.env)) return c.json({ aeAvailable: false, hits: [] as RecentHit[] });
    try {
      const nowSec = Date.now() / 1000;
      const since = nowSec - 7 * 86400;
      const misses = event === "miss";
      const [rows, scanners] = await Promise.all([
        queryRecent(c.env, since, { domain, slug }, limit, misses),
        misses ? queryScanners(c.env, since, nowSec + 60) : Promise.resolve([]),
      ]);
      const flagged = new Set(scanners);
      // The visitor hash stays on the server.
      const hits: RecentHit[] = rows.map(({ visitor, ...r }) => ({
        ...r,
        event: r.event === "bot" || r.event === "miss" ? r.event : "click",
        ...(misses ? { scanner: flagged.has(visitor) } : {}),
      }));
      return c.json({ aeAvailable: true, hits });
    } catch (err) {
      console.error(JSON.stringify({ message: "recent hits query failed", error: String(err) }));
      return c.json({ aeAvailable: false, hits: [] as RecentHit[] });
    }
  })

  .get("/export.csv", validate("query", rangeQuerySchema), async (c) => {
    // Daily totals per link from the D1 rollups (completed days only).
    const { range } = c.req.valid("query");
    const { from, to } = rangeBounds(range);
    const { results } = await c.env.DB.prepare(
      `SELECT date, domain, slug, clicks, uniques, bots FROM daily_dims WHERE dim = 'total' AND date BETWEEN ?1 AND ?2
       ORDER BY date, domain, slug`,
    )
      .bind(from, to)
      .all<{ date: string; domain: string; slug: string; clicks: number; uniques: number; bots: number }>();
    const body = csv([
      ["date", "domain", "slug", "clicks", "daily_uniques", "bots"],
      ...results.map((r) => [r.date, r.domain, r.slug, r.clicks, r.uniques, r.bots]),
    ]);
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-stats-${range}-${to}.csv"`,
    });
  });

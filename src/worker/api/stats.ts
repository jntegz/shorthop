import { Hono } from "hono";
import { z } from "zod";
import { periodBounds } from "../../shared/dates";
import { HOSTNAME_RE, linkLabel } from "../../shared/domains";
import { clearMissesSchema, linkParamSchema, missExportQuerySchema, missPolicySchema, rangeQuerySchema } from "../../shared/schemas";
import { IMPORT_SLUG_RE } from "../../shared/slug";
import type { RecentHit } from "../../shared/types";
import { aeAvailable, HIT_DEVICES, HIT_EVENTS, queryRecent, queryScanners } from "../ae";
import { domainsOf } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { clearMisses, saveMissPolicy } from "../misses";
import { linkStats, missReport, overview } from "../stats-data";

const recentQuerySchema = z.object({
  /** With a slug and no domain, the primary domain. */
  domain: z.string().regex(HOSTNAME_RE).optional(),
  slug: z.string().regex(IMPORT_SLUG_RE).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Only one hit type. "miss" also marks each miss with whether the scanner rule counts it as a bot. */
  event: z.enum(HIT_EVENTS).optional(),
  country: z.string().regex(/^[A-Z0-9]{2}$/).optional(),
  device: z.enum(HIT_DEVICES).optional(),
  /** How far back to look. Analytics Engine keeps 90 days. */
  hours: z.coerce.number().int().min(1).max(30 * 24).default(7 * 24),
});

export const statsApi = new Hono<AppEnv>()
  .get("/overview", validate("query", rangeQuerySchema), async (c) => {
    return c.json(await overview(c.env, c.req.valid("query")));
  })

  .get("/account", validate("query", rangeQuerySchema), async (c) => {
    return c.json(await overview(c.env, c.req.valid("query"), undefined, { dims: true }));
  })

  .get("/links/:domain/:slug", validate("param", linkParamSchema), validate("query", rangeQuerySchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    return c.json(await linkStats(c.env, domain, slug, c.req.valid("query")));
  })

  .get("/misses", validate("query", rangeQuerySchema), async (c) => {
    return c.json(await missReport(c.env, c.req.valid("query")));
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
    const { probes, bots, ...period } = c.req.valid("query");
    const { range } = period;
    const { rows } = await missReport(c.env, period);
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
    const { slug, limit, event, country, device, hours } = c.req.valid("query");
    const domain = c.req.valid("query").domain ?? (slug ? domainsOf(c.env).primary : undefined);
    if (!aeAvailable(c.env)) return c.json({ aeAvailable: false, hits: [] as RecentHit[], error: undefined as string | undefined });
    try {
      const nowSec = Date.now() / 1000;
      const since = nowSec - hours * 3600;
      const misses = event === "miss";
      const [rows, scanners] = await Promise.all([
        queryRecent(c.env, since, { domain, slug, event, country, device }, limit),
        misses ? queryScanners(c.env, since, nowSec + 60) : Promise.resolve([]),
      ]);
      const flagged = new Set(scanners);
      // The visitor hash stays on the server.
      const hits: RecentHit[] = rows.map(({ visitor, ...r }) => ({
        ...r,
        event: r.event === "bot" || r.event === "miss" ? r.event : "click",
        ...(misses ? { scanner: flagged.has(visitor) } : {}),
      }));
      return c.json({ aeAvailable: true, hits, error: undefined as string | undefined });
    } catch (err) {
      // Configured but failing: say so, rather than "not configured".
      console.error(JSON.stringify({ message: "recent hits query failed", error: String(err) }));
      return c.json({ aeAvailable: true, hits: [] as RecentHit[], error: err instanceof Error ? err.message : String(err) });
    }
  })

  .get("/export.csv", validate("query", rangeQuerySchema), async (c) => {
    // Daily totals per link from the D1 rollups (completed days only).
    const period = c.req.valid("query");
    const { range } = period;
    const { from, to } = periodBounds(period);
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

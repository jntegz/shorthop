// Website analytics and revenue: sites, their dashboards, payment provider
// connections, and the server-side API (payments, identify) for sites whose
// billing has no native adapter.

import { Hono } from "hono";
import { z } from "zod";
import { HOSTNAME_RE } from "../../shared/domains";
import { can, type Actor } from "../../shared/permissions";
import {
  apiIdentifySchema,
  apiPaymentSchema,
  breakdownQuerySchema,
  connectionSchema,
  connectionUpdateSchema,
  createSiteSchema,
  funnelSchema,
  siteFunnelParamSchema,
  eventListQuerySchema,
  minorFactor,
  paymentsQuerySchema,
  privacyEraseSchema,
  privacyPersonSchema,
  goalPropsQuerySchema,
  peakQuerySchema,
  siteConnParamSchema,
  type GoalPropRow,
  type PageSpeedDTO,
  siteParamSchema,
  siteQuerySchema,
  updateSiteSchema,
  PROVIDER_INFO,
  type Provider,
  type SiteListItem,
  type InstallStatusDTO,
  type SiteOverviewDTO,
} from "../../shared/sites";
import { IMPORT_SLUG_RE } from "../../shared/slug";
import { aeAvailable } from "../ae";
import { configuredDomains, domainsOf } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { actorLabel } from "../users";
import { recreditSite } from "../revenue/attribute";
import { reconvertSite, refreshFx } from "../revenue/fx";
import { importPage } from "../revenue/backfill";
import { checkConnection, connectionChanges, connectionSecrets, connectionView, settingsOf } from "../revenue/connections";
import { applyEvent, storePayment, type ConnectionRow } from "../revenue/ingest";
import { liveSession, rematchSite } from "../revenue/match";
import { announcePayments } from "../revenue/notify";
import { erasePerson, exportPerson, listPrivacyRequests, logExport, personCounts, resolvePerson } from "../web/privacy";
import { identifyVisitor } from "../web/sessions";
import { breakdown, eventList, filtersOf, goalProps, linkRevenue, onlineNow, payments, previousWindow, recentSessions, series, siteSummaries, spikesIn, subscriptionStats, totals, unmatchedCount, visitorProfile, windowOf } from "../web/queries";
import { funnelDTO, funnelReport, type FunnelRow } from "../web/funnels";
import { customerValue, engagement, pageSpeed, peakHours, purchasePaths } from "../web/insights";
import { createSite, deleteSite, getSite, listSites, newId, updateSite } from "../web/sites";

/**
 * Where providers send webhooks: the primary short domain (always public,
 * never behind Access), or this Worker's own address while none is set.
 */
const webhookOrigin = (env: Env, req: Request) => (configuredDomains(env).length ? `https://${domainsOf(env).primary}` : new URL(req.url).origin);

/** People who may see statistics but not revenue get the traffic with every amount zeroed. */
function hideMoney<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const k of ["revenue", "grossRevenue", "refunds", "payments", "customers", "conversion", "revenuePerVisitor"]) if (k in out) out[k] = 0;
  return out as T;
}

const seesMoney = (actor: Actor) => can(actor, "revenue.view");

const IMPORT_PAGES_PER_CALL = 5;
const importSchema = z.object({ days: z.number().int().min(1).max(3 * 365).default(365), cursor: z.string().max(2000).nullish() });

const visitorParamSchema = z.object({ id: siteParamSchema.shape.id, visitor: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/) });
const linkParamSchema = z.object({ domain: z.string().regex(HOSTNAME_RE), slug: z.string().regex(IMPORT_SLUG_RE) });
const linkRevenueQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(3650).default(365) });

/**
 * Pointing a connection at a Worker secret by name is for owners only: the
 * Worker's secrets are theirs, and anyone else could name one meant for
 * something else. Others paste values, kept encrypted and never shown again.
 * Removing a name (null) is fine for anyone with sites.manage.
 */
const namesSecret = (input: { webhookSecretRef?: string | null; apiKeyRef?: string | null }) => Boolean(input.webhookSecretRef || input.apiKeyRef);
const OWNERS_NAME_SECRETS = { error: "Only an owner can choose a Cloudflare secret for a connection. Paste the value instead, or ask an owner.", code: "forbidden" } as const;

export const sitesApi = new Hono<AppEnv>()
  .get("/", async (c) => {
    const sites = await listSites(c.env.DB);
    const summary = await siteSummaries(c.env.DB, sites);
    const money = seesMoney(c.get("actor"));
    const rows: SiteListItem[] = sites.map((s) => {
      const sum = summary.get(s.id)!;
      return { ...s, ...sum, ...(money ? {} : { revenue30d: 0, revenuePrev30d: 0, customers30d: 0 }) };
    });
    return c.json({ sites: rows });
  })

  .post("/", validate("json", createSiteSchema), async (c) => {
    const site = await createSite(c.env.DB, c.req.valid("json"));
    console.log(JSON.stringify({ message: "site created", site: site.id, by: c.get("identity") }));
    return c.json(site, 201);
  })

  .get("/by-link/:domain/:slug", validate("param", linkParamSchema), validate("query", linkRevenueQuerySchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const since = Math.floor(Date.now() / 1000) - c.req.valid("query").days * 86400;
    return c.json(await linkRevenue(c.env.DB, domain, slug, since));
  })

  .get("/:id", validate("param", siteParamSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    return site ? c.json(site) : c.json({ error: "Site not found" }, 404);
  })

  .patch("/:id", validate("param", siteParamSchema), validate("json", updateSiteSchema), async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    // Retention removes customers' details for good: only for people who may see them.
    if (input.customerRetentionMonths !== undefined && !seesMoney(c.get("actor"))) {
      return c.json({ error: "Changing customer data retention needs the See revenue permission.", code: "forbidden" }, 403);
    }
    const before = await getSite(c.env.DB, id);
    if (!before) return c.json({ error: "Site not found" }, 404);
    const site = await updateSite(c.env.DB, id, input);
    if (!site) return c.json({ error: "Site not found" }, 404);
    if (site.customerRetentionMonths !== before.customerRetentionMonths) {
      console.log(JSON.stringify({ message: "customer retention changed", site: site.id, months: site.customerRetentionMonths, by: actorLabel(c.get("actor")) }));
    }
    // Revenue follows the new currency and the new attribution rules.
    if (site.currency !== before.currency) await reconvertSite(c.env.DB, site.id, site.currency);
    if (site.attributionModel !== before.attributionModel || site.lookbackDays !== before.lookbackDays) await recreditSite(c.env.DB, site);
    return c.json(site);
  })

  .delete("/:id", validate("param", siteParamSchema), async (c) => {
    const deleted = await deleteSite(c.env.DB, c.req.valid("param").id);
    if (!deleted) return c.json({ error: "Site not found" }, 404);
    console.log(JSON.stringify({ message: "site deleted", site: c.req.valid("param").id, by: c.get("identity") }));
    return c.json({ deleted: true });
  })

  .get("/:id/overview", validate("param", siteParamSchema), validate("query", siteQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const w = windowOf(site, q);
    const f = filtersOf(q, 4);
    const span = w.end - w.start;
    const [current, previous, points, previousPoints, spikes, online, unmatched] = await Promise.all([
      totals(c.env.DB, site, w.start, w.end, f),
      // The period before, of the same length; none for all time.
      q.range === "all" ? Promise.resolve(null) : totals(c.env.DB, site, w.start - span, w.start, f),
      series(c.env.DB, site, w, f),
      q.range === "all" ? Promise.resolve(null) : series(c.env.DB, site, previousWindow(site, w), f),
      spikesIn(c.env.DB, site.id, w),
      onlineNow(c.env.DB, site.id),
      unmatchedCount(c.env.DB, site.id, w.start, w.end),
    ]);
    const money = seesMoney(c.get("actor"));
    const dto: SiteOverviewDTO = {
      site,
      from: w.from,
      to: w.to,
      granularity: w.granularity,
      totals: money ? current : hideMoney(current),
      previous: money || !previous ? previous : hideMoney(previous),
      series: money ? points : points.map(hideMoney),
      previousSeries: !previousPoints ? null : money ? previousPoints : previousPoints.map(hideMoney),
      spikes,
      online,
      unmatched: money ? unmatched : 0,
      aeAvailable: aeAvailable(c.env),
    };
    return c.json(dto);
  })

  .get("/:id/breakdown", validate("param", siteParamSchema), validate("query", breakdownQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const rows = await breakdown(c.env.DB, site, q.dim, windowOf(site, q), filtersOf(q, 4), q.limit);
    return c.json({ dim: q.dim, rows: seesMoney(c.get("actor")) ? rows : rows.filter((r) => r.visitors > 0).map(hideMoney) });
  })

  .get("/:id/events", validate("param", siteParamSchema), validate("query", eventListQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    try {
      const rows = await eventList(c.env, site, q.list, windowOf(site, q));
      return c.json({ list: q.list, available: aeAvailable(c.env), rows: seesMoney(c.get("actor")) ? rows : rows.map(hideMoney) });
    } catch (err) {
      console.error(JSON.stringify({ message: "site events query failed", site: site.id, error: String(err) }));
      return c.json({ list: q.list, available: false, error: String(err).slice(0, 300), rows: [] });
    }
  })

  .get("/:id/goal-props", validate("param", siteParamSchema), validate("query", goalPropsQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    try {
      return c.json({ available: aeAvailable(c.env), rows: await goalProps(c.env, site, q.name, windowOf(site, q)) });
    } catch (err) {
      console.error(JSON.stringify({ message: "goal properties query failed", site: site.id, error: String(err) }));
      return c.json({ available: false, error: String(err).slice(0, 300), rows: [] as GoalPropRow[] });
    }
  })

  .get("/:id/peak-hours", validate("param", siteParamSchema), validate("query", peakQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    // Sales and revenue are money; without revenue.view only visits are shown.
    const metric = seesMoney(c.get("actor")) ? q.metric : "visits";
    return c.json(await peakHours(c.env.DB, site, windowOf(site, q), filtersOf(q, 4), metric));
  })

  .get("/:id/page-speed", validate("param", siteParamSchema), validate("query", siteQuerySchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    try {
      return c.json(await pageSpeed(c.env, site, windowOf(site, c.req.valid("query"))));
    } catch (err) {
      console.error(JSON.stringify({ message: "site page speed query failed", site: site.id, error: String(err) }));
      return c.json({ available: false, error: String(err).slice(0, 300), overall: null, pages: [] } satisfies PageSpeedDTO);
    }
  })

  .get("/:id/engagement", validate("param", siteParamSchema), validate("query", siteQuerySchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    try {
      const report = await engagement(c.env, site, windowOf(site, c.req.valid("query")));
      // Who paid is revenue information.
      return c.json(seesMoney(c.get("actor")) ? report : { ...report, buyers: [], others: [] });
    } catch (err) {
      console.error(JSON.stringify({ message: "site engagement query failed", site: site.id, error: String(err) }));
      return c.json({ available: false, error: String(err).slice(0, 300), all: [], buyers: [], others: [] });
    }
  })

  .get("/:id/purchase-paths", validate("param", siteParamSchema), validate("query", siteQuerySchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    return c.json(await purchasePaths(c.env.DB, site, windowOf(site, c.req.valid("query"))));
  })

  .get("/:id/customer-value", validate("param", siteParamSchema), validate("query", siteQuerySchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    return c.json(await customerValue(c.env.DB, site, windowOf(site, c.req.valid("query"))));
  })

  .get("/:id/install-status", validate("param", siteParamSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const [latest, day] = await c.env.DB.batch<{ last_seen_at?: number; hostname?: string; n?: number }>([
      c.env.DB.prepare("SELECT last_seen_at, hostname FROM web_sessions WHERE site_id = ?1 ORDER BY last_seen_at DESC LIMIT 1").bind(site.id),
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions WHERE site_id = ?1 AND started_at >= ?2").bind(site.id, Math.floor(Date.now() / 1000) - 86400),
    ]);
    const row = latest?.results[0];
    const dto: InstallStatusDTO = { lastSeenAt: row?.last_seen_at ?? null, hostname: row?.hostname || null, visits24h: day?.results[0]?.n ?? 0 };
    return c.json(dto);
  })

  .get("/:id/live", validate("param", siteParamSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    return c.json({ online: await onlineNow(c.env.DB, site.id), sessions: await recentSessions(c.env.DB, site.id, 50) });
  })

  .get("/:id/payments", validate("param", siteParamSchema), validate("query", paymentsQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    return c.json(await payments(c.env.DB, site, windowOf(site, q), q));
  })

  .get("/:id/payments.csv", validate("param", siteParamSchema), validate("query", paymentsQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const w = windowOf(site, q);
    // The whole period, not just a page: up to 50,000 rows, read in pages.
    const list = [];
    for (let offset = 0; offset < 50_000; offset += 500) {
      const page = await payments(c.env.DB, site, w, { ...q, limit: 500, offset });
      list.push(...page.payments);
      if (page.payments.length < 500) break;
    }
    const body = csv([
      ["date", "provider", "kind", "billing", "amount", "currency", `amount_${site.currency}`, "email", "matched_by", "confidence", "channel", "source", "campaign", "short_link", "landing_page", "unmatched_reason", "test"],
      ...list.map((p) => [
        new Date(p.occurredAt * 1000).toISOString(),
        p.provider,
        p.kind,
        p.billing,
        (p.amountMinor / minorFactor(p.currency)).toFixed(Math.log10(minorFactor(p.currency))),
        p.currency,
        p.amountSiteMinor === null ? "" : (p.amountSiteMinor / minorFactor(site.currency)).toFixed(Math.log10(minorFactor(site.currency))),
        p.email,
        p.matchedBy,
        p.confidence,
        p.credited?.channel,
        p.credited?.source,
        p.credited?.campaign,
        p.credited?.link,
        p.credited?.entry,
        p.unmatchedReason,
        p.testMode ? "yes" : "",
      ]),
    ]);
    return c.body(body, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="payments-${site.id}-${w.from}-${w.to}.csv"` });
  })

  .get("/:id/subscriptions", validate("param", siteParamSchema), validate("query", siteQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    return c.json(await subscriptionStats(c.env.DB, site, windowOf(site, q)));
  })

  .get("/:id/visitors/:visitor", validate("param", visitorParamSchema), async (c) => {
    const { id, visitor } = c.req.valid("param");
    const site = await getSite(c.env.DB, id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    return c.json(await visitorProfile(c.env.DB, site, visitor));
  })

  // ---- Requests from visitors and customers: who is named travels in the body, never the URL, so it stays out of request logs.

  .post("/:id/privacy/lookup", validate("param", siteParamSchema), validate("json", privacyPersonSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const person = await resolvePerson(c.env.DB, site, c.req.valid("json"));
    return c.json(await personCounts(c.env.DB, site, person));
  })

  .post("/:id/privacy/export", validate("param", siteParamSchema), validate("json", privacyPersonSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const person = await resolvePerson(c.env.DB, site, c.req.valid("json"));
    const data = await exportPerson(c.env.DB, site, person);
    await logExport(c.env.DB, site, actorLabel(c.get("actor")), await personCounts(c.env.DB, site, person));
    const day = new Date().toISOString().slice(0, 10);
    return c.body(JSON.stringify(data, null, 2), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="shorthop-${site.id}-person-${day}.json"`,
    });
  })

  .post("/:id/privacy/erase", validate("param", siteParamSchema), validate("json", privacyEraseSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const person = await resolvePerson(c.env.DB, site, c.req.valid("json"));
    const by = actorLabel(c.get("actor"));
    const result = await erasePerson(c.env.DB, site, person, by);
    console.log(JSON.stringify({ message: "person erased", site: site.id, by, counts: result.counts }));
    return c.json(result);
  })

  .get("/:id/privacy/requests", validate("param", siteParamSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    return c.json({ requests: await listPrivacyRequests(c.env.DB, site) });
  })

  .post("/:id/rematch", validate("param", siteParamSchema), async (c) => {
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    // Also another go at amounts still waiting for an exchange rate.
    let converted = 0;
    try {
      converted = (await refreshFx(c.env.DB, 10, site.id)).converted;
    } catch (err) {
      console.error(JSON.stringify({ message: "fx refresh failed", site: site.id, error: String(err) }));
    }
    return c.json({ ...(await rematchSite(c.env.DB, site, 500)), converted });
  })

  // ---- Funnels.

  .get("/:id/funnels", validate("param", siteParamSchema), async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM funnels WHERE site_id = ?1 ORDER BY created_at").bind(c.req.valid("param").id).all<FunnelRow>();
    return c.json({ funnels: results.map(funnelDTO) });
  })

  .post("/:id/funnels", validate("param", siteParamSchema), validate("json", funnelSchema), async (c) => {
    const { id } = c.req.valid("param");
    if (!(await getSite(c.env.DB, id))) return c.json({ error: "Site not found" }, 404);
    const body = c.req.valid("json");
    const row: FunnelRow = { id: newId("fn_"), site_id: id, name: body.name, steps: JSON.stringify(body.steps), window_hours: body.windowHours, created_at: Math.floor(Date.now() / 1000) };
    await c.env.DB.prepare("INSERT INTO funnels (id, site_id, name, steps, window_hours, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(row.id, row.site_id, row.name, row.steps, row.window_hours, row.created_at)
      .run();
    return c.json(funnelDTO(row), 201);
  })

  .delete("/:id/funnels/:funnel", validate("param", siteFunnelParamSchema), async (c) => {
    const { id, funnel } = c.req.valid("param");
    const res = await c.env.DB.prepare("DELETE FROM funnels WHERE id = ?1 AND site_id = ?2").bind(funnel, id).run();
    return res.meta.changes ? c.json({ deleted: true }) : c.json({ error: "Funnel not found" }, 404);
  })

  .get("/:id/funnels/:funnel/report", validate("param", siteFunnelParamSchema), validate("query", siteQuerySchema), async (c) => {
    const { id, funnel } = c.req.valid("param");
    const site = await getSite(c.env.DB, id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const row = await c.env.DB.prepare("SELECT * FROM funnels WHERE id = ?1 AND site_id = ?2").bind(funnel, id).first<FunnelRow>();
    if (!row) return c.json({ error: "Funnel not found" }, 404);
    const report = await funnelReport(c.env, site, funnelDTO(row), windowOf(site, c.req.valid("query")));
    return c.json(seesMoney(c.get("actor")) ? report : { ...report, paid: { visitors: 0, revenue: 0 } });
  })

  // ---- Payment provider connections.

  .get("/:id/connections", validate("param", siteParamSchema), async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM payment_connections WHERE site_id = ?1 ORDER BY created_at").bind(c.req.valid("param").id).all<ConnectionRow>();
    return c.json({ connections: await Promise.all(results.map((r) => connectionView(c.env, r, webhookOrigin(c.env, c.req.raw)))) });
  })

  .post("/:id/connections", validate("param", siteParamSchema), validate("json", connectionSchema), async (c) => {
    const { id } = c.req.valid("param");
    if (!(await getSite(c.env.DB, id))) return c.json({ error: "Site not found" }, 404);
    const body = c.req.valid("json");
    if (namesSecret(body) && !c.get("actor").owner) return c.json(OWNERS_NAME_SECRETS, 403);
    // Providers that authenticate by a token in the webhook address get a random one.
    if (PROVIDER_INFO[body.provider].urlToken && !body.webhookSecret && !body.webhookSecretRef) body.webhookSecret = newId("", 24);
    const connId = newId("pc_");
    const changes = await connectionChanges(c.env, body, null);
    const cols = ["id", "site_id", "provider", "created_at", ...Object.keys(changes)];
    const values = [connId, id, body.provider, Math.floor(Date.now() / 1000), ...Object.values(changes)];
    await c.env.DB.prepare(`INSERT INTO payment_connections (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
      .bind(...values)
      .run();
    const row = await c.env.DB.prepare("SELECT * FROM payment_connections WHERE id = ?1").bind(connId).first<ConnectionRow>();
    return c.json(await connectionView(c.env, row!, webhookOrigin(c.env, c.req.raw)), 201);
  })

  .patch("/:id/connections/:conn", validate("param", siteConnParamSchema), validate("json", connectionUpdateSchema), async (c) => {
    const { id, conn } = c.req.valid("param");
    const current = await c.env.DB.prepare("SELECT * FROM payment_connections WHERE id = ?1 AND site_id = ?2").bind(conn, id).first<ConnectionRow>();
    if (!current) return c.json({ error: "Connection not found" }, 404);
    if (namesSecret(c.req.valid("json")) && !c.get("actor").owner) return c.json(OWNERS_NAME_SECRETS, 403);
    const changes = await connectionChanges(c.env, c.req.valid("json"), current);
    const cols = Object.keys(changes);
    if (cols.length) {
      await c.env.DB.prepare(`UPDATE payment_connections SET ${cols.map((col, i) => `${col} = ?${i + 2}`).join(", ")} WHERE id = ?1`)
        .bind(conn, ...Object.values(changes))
        .run();
    }
    const row = await c.env.DB.prepare("SELECT * FROM payment_connections WHERE id = ?1").bind(conn).first<ConnectionRow>();
    return c.json(await connectionView(c.env, row!, webhookOrigin(c.env, c.req.raw)));
  })

  .post("/:id/connections/:conn/check", validate("param", siteConnParamSchema), async (c) => {
    const { id, conn } = c.req.valid("param");
    const row = await c.env.DB.prepare("SELECT * FROM payment_connections WHERE id = ?1 AND site_id = ?2").bind(conn, id).first<ConnectionRow>();
    if (!row) return c.json({ error: "Connection not found" }, 404);
    return c.json(await checkConnection(c.env, row));
  })

  .post("/:id/connections/:conn/import", validate("param", siteConnParamSchema), validate("json", importSchema), async (c) => {
    const { id, conn } = c.req.valid("param");
    const { days, cursor } = c.req.valid("json");
    const site = await getSite(c.env.DB, id);
    const row = await c.env.DB.prepare("SELECT * FROM payment_connections WHERE id = ?1 AND site_id = ?2").bind(conn, id).first<ConnectionRow>();
    if (!site || !row) return c.json({ error: "Connection not found" }, 404);
    const provider = row.provider as Provider;
    if (!PROVIDER_INFO[provider].importable) return c.json({ error: "Importing past payments isn't available for this provider" }, 400);
    const { apiKey } = await connectionSecrets(c.env, row);
    if (!apiKey.value) return c.json({ error: apiKey.problem ?? "Set an API key for this connection first" }, 400);
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const now = Math.floor(Date.now() / 1000);
    const ctx = { apiKey: apiKey.value, settings: settingsOf(row) };
    let next: string | null = cursor ?? null;
    let imported = 0;
    let seen = 0;
    try {
      // A few pages per call; the admin calls again with the cursor until it's null.
      for (let i = 0; i < IMPORT_PAGES_PER_CALL; i++) {
        const page = await importPage(provider, ctx, since, next);
        seen += page.events.length;
        for (const event of page.events) imported += (await applyEvent(c.env, site, provider, row, event, now)).length;
        next = page.next;
        if (!next) break;
      }
    } catch (err) {
      return c.json({ error: `Import stopped: ${String(err).slice(0, 300)}`, imported, next }, 502);
    }
    return c.json({ imported, seen, next });
  })

  .delete("/:id/connections/:conn", validate("param", siteConnParamSchema), async (c) => {
    const { id, conn } = c.req.valid("param");
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM payment_connections WHERE id = ?1 AND site_id = ?2").bind(conn, id),
      c.env.DB.prepare("DELETE FROM payment_events WHERE connection_id = ?1").bind(conn),
    ]);
    return res?.meta.changes ? c.json({ deleted: true }) : c.json({ error: "Connection not found" }, 404);
  })

  // ---- Server-side API: payments from billing without an adapter, and trusted identify.

  .post("/:id/payments", validate("param", siteParamSchema), validate("json", apiPaymentSchema), async (c) => {
    const body = c.req.valid("json");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    const occurredAt = body.occurredAt === undefined ? Math.floor(Date.now() / 1000) : typeof body.occurredAt === "number" ? body.occurredAt : Math.floor(Date.parse(body.occurredAt) / 1000);
    // A visitor id from shorthop.visitor(): its latest visit stands in as the reference.
    let ref = body.ref ?? null;
    if (!ref && body.visitorId) {
      const s = await c.env.DB.prepare("SELECT id FROM web_sessions WHERE site_id = ?1 AND visitor_id = ?2 AND started_at <= ?3 ORDER BY started_at DESC LIMIT 1")
        .bind(site.id, body.visitorId, occurredAt + 60)
        .first<{ id: string }>();
      ref = s?.id ?? null;
    }
    const id = await storePayment(c.env.DB, site, "api", null, {
      kind: body.kind,
      providerId: body.id,
      occurredAt,
      amountMinor: Math.round(body.amount * minorFactor(body.currency)),
      currency: body.currency,
      billing: body.kind === "charge" ? (body.renewal ? "sub_renewal" : body.subscriptionId ? null : "one_time") : null,
      customerId: body.customerId ?? null,
      email: body.email?.toLowerCase() ?? null,
      subscriptionId: body.subscriptionId ?? null,
      refs: [],
      parentRef: body.parentId ?? null,
      ref,
      productIds: [],
      testMode: false,
    });
    const row = id ? await c.env.DB.prepare("SELECT id, session_id, matched_by, unmatched_reason FROM payments WHERE id = ?1").bind(id).first() : null;
    if (id) c.executionCtx.waitUntil(announcePayments(c.env, site, [id], c.executionCtx));
    return c.json({ payment: row }, 201);
  })

  .post("/:id/identify", validate("param", siteParamSchema), validate("json", apiIdentifySchema), async (c) => {
    const body = c.req.valid("json");
    const site = await getSite(c.env.DB, c.req.valid("param").id);
    if (!site) return c.json({ error: "Site not found" }, 404);
    let visitorId = body.visitorId ?? null;
    if (!visitorId && body.ref) {
      const s = await c.env.DB.prepare(`SELECT visitor_id FROM web_sessions s WHERE id = ?1 AND site_id = ?2 AND ${liveSession("s")}`).bind(body.ref, site.id).first<{ visitor_id: string }>();
      visitorId = s?.visitor_id ?? null;
    }
    if (!visitorId) return c.json({ error: "Unknown visit reference" }, 404);
    await identifyVisitor(c.env.DB, site.id, visitorId, { email: body.email, name: body.name, userId: body.userId }, "server", Math.floor(Date.now() / 1000));
    // A newly known email can match payments that were waiting for it.
    await rematchSite(c.env.DB, site, 50);
    return c.json({ ok: true });
  });

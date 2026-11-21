// Advanced tracking: switching it on per link, and reading, exporting and
// erasing the click log (src/worker/tracking.ts). IP addresses are decrypted
// only for clicks.ip; turning IP recording on needs it too, and the GDPR
// warning accepted (who and when is kept with the setting).

import { Hono, type Context } from "hono";
import { z } from "zod";
import { can } from "../../shared/permissions";
import { linkParamSchema } from "../../shared/schemas";
import {
  clicksQuerySchema,
  DEFAULT_TRACKING_RETENTION,
  ipSchema,
  parseTracking,
  PURPOSE_MIN,
  trackingPolicySchema,
  trackingSchema,
  withinPolicy,
  type TrackingPolicy,
  type TrackedClickDTO,
  type TrackedClicksDTO,
  type TrackingConfig,
  type TrackingRetention,
} from "../../shared/tracking";
import { getLink, nowSec, publishLatest, toDTO, type LinkRow } from "../db";
import { planLimits } from "../plan";
import { shortOrigin } from "../domains";
import { csv, validate, type AppEnv } from "../hono";
import { hasNetworkLists, refreshNetworkLists, saveTrackingPolicy, trackingPolicy } from "../tracking";
import { clickDTO, deleteLinkClicksStmts, ipLookupKey, notifiedKey, type StoredClick } from "../tracking";

const CSV_MAX = 20_000;

/** Drops recorded IP addresses, and the full reverse-DNS names stored with them, which can spell the address out. */
const DROP_IPS_SQL = "UPDATE tracked_clicks SET ip_enc = NULL, ip_key = NULL, hostname = '' WHERE ip_enc IS NOT NULL";

const clickParamSchema = linkParamSchema.extend({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

const seesIp = (c: Context<AppEnv>) => can(c.get("actor"), "clicks.ip");

/** The click rows of one link, newest first, each with its visitor's number (V1 = first seen) and visit count. */
const CLICKS_SQL = (where: string, limit: string) => `
  WITH v AS (
    SELECT visitor, MIN(at) AS first_at, MIN(rowid) AS first_row, COUNT(*) AS visits FROM tracked_clicks WHERE domain = ?1 AND slug = ?2 GROUP BY visitor
  ), n AS (
    SELECT visitor, visits, ROW_NUMBER() OVER (ORDER BY first_at, first_row) AS visitor_no FROM v
  )
  SELECT t.*, d.data AS details, n.visitor_no, n.visits AS visitor_visits
  FROM tracked_clicks t
  LEFT JOIN tracked_click_details d ON d.click_id = t.id
  JOIN n ON n.visitor = t.visitor
  WHERE t.domain = ?1 AND t.slug = ?2 ${where}
  ORDER BY t.at DESC, t.rowid DESC ${limit}`;

function filters(q: z.infer<typeof clicksQuerySchema>): { where: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.event && q.event !== "all") {
    params.push(q.event);
    where.push(`AND t.event = ?${params.length + 2}`);
  }
  if (q.visitor) {
    params.push(q.visitor);
    where.push(`AND t.visitor = ?${params.length + 2}`);
  }
  return { where: where.join(" "), params };
}

export type TrackingInputBody = NonNullable<z.infer<typeof trackingSchema>>;

/**
 * Settings asked for, checked against the workspace's rules (Settings →
 * Access & security), the caller's permissions and the GDPR warning, and
 * merged with the link's current settings (null for a new link). Used by
 * PUT …/tracking and by creating a link with tracking already on.
 */
export function resolveTracking(
  c: Context<AppEnv>,
  input: TrackingInputBody,
  before: TrackingConfig | null,
  policy: TrackingPolicy,
): { ok: true; config: TrackingConfig } | { ok: false; error: string; code: string; status: 400 | 403 } {
  const refuse = (error: string, code: string, status: 400 | 403 = 400) => ({ ok: false as const, error, code, status });
  if (!policy.enabled) return refuse("Advanced tracking is turned off for this workspace by an admin.", "policy", 403);
  if (input.mode === "ip" && !policy.allowIp) return refuse("Recording IP addresses isn't allowed in this workspace. An admin can allow it in Settings → Access & security.", "policy");
  const browser = input.browser ?? before?.browser ?? false;
  if (browser && !policy.allowBrowser) return refuse("Browser details aren't allowed in this workspace.", "policy");
  const pixel = input.pixel ?? before?.pixel ?? false;
  if (pixel && !policy.allowPixel) return refuse("The email-open pixel isn't allowed in this workspace.", "policy");
  const retention = (input.retentionDays as TrackingRetention | undefined) ?? before?.retentionDays ?? Math.min(DEFAULT_TRACKING_RETENTION, policy.maxRetentionDays);
  if (retention > policy.maxRetentionDays) return refuse(`Clicks can be kept for at most ${policy.maxRetentionDays} days in this workspace.`, "policy");
  const purpose = (input.purpose ?? before?.purpose ?? "").trim();
  if (policy.requirePurpose && purpose.length < PURPOSE_MIN) return refuse(`Say why this link is tracked (at least ${PURPOSE_MIN} characters): this workspace requires a purpose.`, "purpose_required");
  if (input.mode === "ip") {
    if (!seesIp(c)) return refuse("Recording IP addresses needs the See IP addresses permission.", "forbidden", 403);
    const alreadyAccepted = before?.mode === "ip" && before.ackAt !== null;
    if (!input.acknowledged && !alreadyAccepted) return refuse("Recording IP addresses needs the GDPR warning accepted: send acknowledged: true.", "ack_required");
  }
  const now = nowSec();
  const keepAck = input.mode === "ip" && before?.mode === "ip" && before.ackAt !== null && !input.acknowledged;
  return {
    ok: true,
    config: {
      mode: input.mode,
      retentionDays: retention as TrackingRetention,
      browser,
      notify: input.notify ?? before?.notify ?? "off",
      ackAt: input.mode === "ip" ? (keepAck ? before!.ackAt : now) : null,
      ackBy: input.mode === "ip" ? (keepAck ? before!.ackBy : c.get("identity")) : null,
      since: before && before.mode === input.mode ? before.since : now,
      pixel,
      purpose,
    },
  };
}

/** The first time tracking is switched on, the VPN and hosting lists are fetched now rather than at the next daily run. */
export async function fetchNetworkListsOnce(c: Context<AppEnv>): Promise<void> {
  if (c.env.TRACKING_NET === "off" || (await hasNetworkLists(c.env.DB))) return;
  c.executionCtx.waitUntil(refreshNetworkLists(c.env).catch((err: unknown) => console.error(JSON.stringify({ message: "network lists refresh failed", error: String(err) }))));
}

export const trackingApi = new Hono<AppEnv>()
  /**
   * Switches Advanced tracking on, changes it, or (null) switches it off.
   * Switching it off keeps the click log until its retention ends; delete it
   * with DELETE …/clicks.
   */
  .put("/links/:domain/:slug/tracking", validate("param", linkParamSchema), validate("json", trackingSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const row = await getLink(c.env.DB, domain, slug);
    if (!row) return c.json({ error: "Link not found" }, 404);
    const input = c.req.valid("json");
    const before = parseTracking(row.tracking);
    let next: TrackingConfig | null = null;
    if (input) {
      const resolved = resolveTracking(c, input, before, await trackingPolicy(c.env));
      if (!resolved.ok) return c.json({ error: resolved.error, code: resolved.code }, resolved.status);
      next = resolved.config;
    }
    const json = next ? JSON.stringify(next) : null;
    // RETURNING: the row as D1 holds it after this update, so an edit saved meanwhile (a new destination) isn't overwritten in KV by the copy read above.
    const [updated] = await c.env.DB.batch<LinkRow>([
      c.env.DB.prepare("UPDATE links SET tracking = ?1, updated_at = ?2 WHERE domain = ?3 AND slug = ?4 RETURNING *").bind(json, nowSec(), row.domain, row.slug),
      // "Email me on the first click" applies afresh after any change.
      c.env.DB.prepare("DELETE FROM settings WHERE key IN (?1, ?2)").bind(notifiedKey(row.domain, row.slug), notifiedKey(row.domain, row.slug, "open")),
      // Leaving IP mode: the addresses already recorded are dropped at once; the rest of each click stays until its retention ends.
      ...(before?.mode === "ip" && next?.mode !== "ip"
        ? [c.env.DB.prepare(DROP_IPS_SQL + " AND domain = ?1 AND slug = ?2").bind(row.domain, row.slug)]
        : []),
    ]);
    const current = updated?.results[0];
    if (!current) return c.json({ error: "Link not found" }, 404);
    if (next) await fetchNetworkListsOnce(c);
    // Reads D1 back after the KV write, so a save that reached KV in the other order is published again.
    const outcome = await publishLatest(c.env, current);
    if (outcome === "gone") return c.json({ error: "Link not found" }, 404);
    if (outcome === "failed") return c.json({ error: "Saved, but the redirect hasn't picked it up yet. Save again in a minute.", tracking: next }, 502);
    const link = toDTO(current, shortOrigin(c.env, c.req.raw, row.domain));
    // Clicks counted before an import are statistics, as on the other link routes.
    return c.json({ tracking: next, link: can(c.get("actor"), "stats.view") ? link : { ...link, importedClicks: null } });
  })

  /** The click log, newest first. IP addresses only for clicks.ip. */
  .get("/links/:domain/:slug/clicks", validate("param", linkParamSchema), validate("query", clicksQuerySchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const found = await getLink(c.env.DB, domain, slug);
    if (!found) return c.json({ error: "Link not found" }, 404);
    const q = c.req.valid("query");
    const limit = q.limit ?? 100;
    const { where, params } = filters(q);
    const [rows, counts] = await Promise.all([
      c.env.DB.prepare(CLICKS_SQL(where, `LIMIT ${limit + 1} OFFSET ${q.offset ?? 0}`))
        .bind(found.domain, found.slug, ...params)
        .all<StoredClick>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(event = 'click') AS people, SUM(event = 'open') AS opens, SUM(event = 'bot') AS bots, COUNT(DISTINCT CASE WHEN event = 'click' THEN visitor END) AS visitors FROM tracked_clicks WHERE domain = ?1 AND slug = ?2",
      )
        .bind(found.domain, found.slug)
        .first<{ total: number; people: number | null; opens: number | null; bots: number | null; visitors: number }>(),
    ]);
    const showIp = seesIp(c);
    const page = rows.results.slice(0, limit);
    const out: TrackedClicksDTO = {
      tracking: parseTracking(found.tracking),
      clicks: await Promise.all(page.map((r) => clickDTO(c.env, r, showIp))),
      total: counts?.total ?? 0,
      people: counts?.people ?? 0,
      bots: counts?.bots ?? 0,
      opens: counts?.opens ?? 0,
      visitors: counts?.visitors ?? 0,
      more: rows.results.length > limit,
      canSeeIp: showIp,
    };
    return c.json(out);
  })

  /** The whole click log as CSV (newest first, up to CSV_MAX rows). */
  .get("/links/:domain/:slug/clicks.csv", validate("param", linkParamSchema), validate("query", clicksQuerySchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const found = await getLink(c.env.DB, domain, slug);
    if (!found) return c.json({ error: "Link not found" }, 404);
    const { where, params } = filters(c.req.valid("query"));
    const { results } = await c.env.DB.prepare(CLICKS_SQL(where, `LIMIT ${CSV_MAX}`))
      .bind(found.domain, found.slug, ...params)
      .all<StoredClick>();
    const showIp = seesIp(c);
    const clicks: (TrackedClickDTO & { visitorKey: string })[] = await Promise.all(results.map(async (r) => ({ ...(await clickDTO(c.env, r, showIp)), visitorKey: r.visitor })));
    const yes = (b: boolean) => (b ? "yes" : "");
    const body = csv([
      [
        "time_utc", "event", "bot", "visitor", "visitor_key", "visitor_visits", "ip", "country", "region", "city", "postal_code", "latitude", "longitude", "ip_timezone",
        "asn", "network", "hostname", "known_vpn", "tor", "datacenter", "relay", "vpn_suspected", "device", "model", "os", "os_version", "browser", "browser_version",
        "languages", "referrer", "source", "qr", "screen", "viewport", "browser_timezone", "timezone_mismatch", "cores", "memory_gb", "connection", "user_agent", "cloudflare_colo", "tls", "http", "rtt_ms",
      ],
      ...clicks.map((k) => [
        new Date(k.at * 1000).toISOString(), k.event, k.botName, k.visitor, k.visitorKey, k.visitorVisits, k.ip ?? (k.hasIp ? "(hidden)" : ""), k.country, k.region, k.city, k.postalCode, k.latitude, k.longitude, k.timezone,
        k.asn || "", k.asOrganization, k.hostname, k.flags.knownVpn, yes(k.flags.tor), yes(k.flags.datacenter), yes(k.flags.privateRelay), yes(k.flags.vpnSuspected), k.device, k.deviceModel, k.os, k.osVersion, k.browser, k.browserVersion,
        k.languages, k.referrer, k.source, yes(k.qr), k.details?.screen ?? "", k.details?.viewport ?? "", k.details?.timezone ?? "", yes(k.tzMismatch), k.details?.cores ?? "", k.details?.memory ?? "", k.details?.connection ?? "", k.userAgent, k.colo, k.tlsVersion, k.httpProtocol, k.rttMs ?? "",
      ]),
    ]);
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="clicks-${found.domain}-${found.slug.replace(/[^A-Za-z0-9_-]/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  })

  /** Deletes a link's whole click log. */
  .delete("/links/:domain/:slug/clicks", validate("param", linkParamSchema), async (c) => {
    const { domain, slug } = c.req.valid("param");
    const found = await getLink(c.env.DB, domain, slug);
    if (!found) return c.json({ error: "Link not found" }, 404);
    const before = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_clicks WHERE domain = ?1 AND slug = ?2").bind(found.domain, found.slug).first<{ n: number }>();
    await c.env.DB.batch(deleteLinkClicksStmts(c.env.DB, found.domain, found.slug));
    return c.json({ deleted: before?.n ?? 0 });
  })

  /** Deletes one click. */
  .delete("/links/:domain/:slug/clicks/:id", validate("param", clickParamSchema), async (c) => {
    const { domain, slug, id } = c.req.valid("param");
    const [, del] = await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM tracked_click_details WHERE click_id = (SELECT id FROM tracked_clicks WHERE id = ?1 AND domain = ?2 AND slug = ?3)").bind(id, domain, slug),
      c.env.DB.prepare("DELETE FROM tracked_clicks WHERE id = ?1 AND domain = ?2 AND slug = ?3").bind(id, domain, slug),
    ]);
    if (!del?.meta.changes) return c.json({ error: "Click not found" }, 404);
    return c.json({ deleted: 1 });
  })

  /** The workspace's rules for Advanced tracking: everyone who can switch it on sees them. */
  .get("/tracking/policy", async (c) => c.json({ policy: await trackingPolicy(c.env) }))

  /**
   * Changes the rules (admins, from a signed-in session). Links that break the
   * new rules are brought within them at once: IP addresses already recorded
   * are dropped where IP mode is no longer allowed, and stored clicks are cut
   * to the new longest retention.
   */
  .put("/tracking/policy", validate("json", trackingPolicySchema), async (c) => {
    const policy = c.req.valid("json") as TrackingPolicy;
    await saveTrackingPolicy(c.env, policy);
    const { results } = await c.env.DB.prepare("SELECT * FROM links WHERE tracking IS NOT NULL").all<LinkRow>();
    let changed = 0;
    // Index in stmts of each link's UPDATE … RETURNING, whose row is then published.
    const linkUpdates = new Set<number>();
    const stmts: D1PreparedStatement[] = [];
    for (const row of results) {
      const before = parseTracking(row.tracking);
      if (!before) continue;
      const after = withinPolicy(before, policy);
      const json = after ? JSON.stringify(after) : null;
      if (json === JSON.stringify(before)) continue;
      changed++;
      linkUpdates.add(stmts.length);
      stmts.push(c.env.DB.prepare("UPDATE links SET tracking = ?1 WHERE domain = ?2 AND slug = ?3 RETURNING *").bind(json, row.domain, row.slug));
      if (before.mode === "ip" && after?.mode !== "ip") {
        stmts.push(c.env.DB.prepare(DROP_IPS_SQL + " AND domain = ?1 AND slug = ?2").bind(row.domain, row.slug));
      }
    }
    if (!policy.allowIp) stmts.push(c.env.DB.prepare(DROP_IPS_SQL));
    if (!policy.allowBrowser) stmts.push(c.env.DB.prepare("DELETE FROM tracked_click_details"));
    stmts.push(c.env.DB.prepare("UPDATE tracked_clicks SET expires_at = at + ?1 WHERE expires_at > at + ?1").bind(policy.maxRetentionDays * 86400));
    const saved: LinkRow[] = [];
    for (let i = 0; i < stmts.length; i += 50) {
      const results = await c.env.DB.batch<LinkRow>(stmts.slice(i, i + 50));
      results.forEach((r, k) => {
        const row = linkUpdates.has(i + k) ? r.results[0] : undefined;
        if (row) saved.push(row);
      });
    }
    // Republish what fits in this request (each is a KV write and a D1 read back); the click-time
    // check covers the rest until Settings → Republish (POST /resync) runs.
    const budget = planLimits(c.env).policyPublishes;
    let republished = 0;
    for (const row of saved.slice(0, budget)) {
      if ((await publishLatest(c.env, row)) !== "failed") republished++;
    }
    return c.json({ policy, changed, republishPending: saved.length - republished });
  })

  /** One IP address's clicks on every link (a person's access request). */
  .post("/clicks/by-ip", validate("json", ipSchema), async (c) => {
    const key = await ipLookupKey(c.env, c.req.valid("json").ip);
    const { results } = await c.env.DB.prepare(
      `SELECT t.*, d.data AS details FROM tracked_clicks t LEFT JOIN tracked_click_details d ON d.click_id = t.id WHERE t.ip_key = ?1 ORDER BY t.at DESC LIMIT ${CSV_MAX}`,
    )
      .bind(key)
      .all<StoredClick>();
    return c.json({ clicks: await Promise.all(results.map((r) => clickDTO(c.env, r, true))) });
  })

  /** Erases one IP address's clicks on every link (a person's erasure request). */
  .post("/clicks/by-ip/erase", validate("json", ipSchema), async (c) => {
    const key = await ipLookupKey(c.env, c.req.valid("json").ip);
    const [, del] = await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM tracked_click_details WHERE click_id IN (SELECT id FROM tracked_clicks WHERE ip_key = ?1)").bind(key),
      c.env.DB.prepare("DELETE FROM tracked_clicks WHERE ip_key = ?1").bind(key),
    ]);
    return c.json({ deleted: del?.meta.changes ?? 0 });
  });

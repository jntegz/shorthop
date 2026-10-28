// The tracked sites: rows, DTOs and the per-isolate caches the collector and
// the redirect path read (so neither costs a D1 query per request).

import { toBase64Url } from "../../shared/password";
import { hostBelongs, ID_MODES, type AttributionModel, type CreateSiteInput, type IdMode, type SiteDTO, type UpdateSiteInput } from "../../shared/sites";
import { nowSec, withTimeout } from "../db";

export interface SiteRow {
  id: string;
  name: string;
  domains: string;
  timezone: string;
  currency: string;
  id_mode: string;
  respect_gpc: number;
  attribution_model: string;
  lookback_days: number;
  exclude_paths: string;
  tag_links: number;
  notify_payments: number;
  server_emails_only: number;
  spike_alerts: number;
  daily_digest: number;
  digest_hour: number;
  digest_sent_on: string | null;
  tracking: number;
  created_at: number;
  updated_at: number;
}

function parseList(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function siteDTO(row: SiteRow): SiteDTO {
  return {
    id: row.id,
    name: row.name,
    domains: parseList(row.domains),
    timezone: row.timezone,
    currency: row.currency,
    idMode: isIdMode(row.id_mode) ? row.id_mode : "cookieless",
    respectGpc: row.respect_gpc === 1,
    attributionModel: (["last_touch", "first_touch"].includes(row.attribution_model) ? row.attribution_model : "last_non_direct") as AttributionModel,
    lookbackDays: row.lookback_days,
    excludePaths: parseList(row.exclude_paths),
    tagLinks: row.tag_links === 1,
    notifyPayments: row.notify_payments === 1,
    serverEmailsOnly: row.server_emails_only === 1,
    spikeAlerts: row.spike_alerts === 1,
    dailyDigest: row.daily_digest === 1,
    digestHour: row.digest_hour,
    tracking: row.tracking !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const newId = (prefix: string, bytes = 9) => `${prefix}${toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))}`;

export async function listSites(db: D1Database): Promise<SiteDTO[]> {
  const { results } = await db.prepare("SELECT * FROM sites ORDER BY name COLLATE NOCASE").all<SiteRow>();
  return results.map(siteDTO);
}

export async function getSite(db: D1Database, id: string): Promise<SiteDTO | null> {
  const row = await db.prepare("SELECT * FROM sites WHERE id = ?").bind(id).first<SiteRow>();
  return row ? siteDTO(row) : null;
}

export async function createSite(db: D1Database, input: Required<CreateSiteInput>): Promise<SiteDTO> {
  const now = nowSec();
  const id = newId("st_");
  await db
    .prepare(
      `INSERT INTO sites (id, name, domains, timezone, currency, id_mode, respect_gpc, attribution_model, lookback_days, exclude_paths, tag_links, created_at, updated_at, notify_payments, server_emails_only,
         spike_alerts, daily_digest, digest_hour, tracking)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    )
    .bind(
      id,
      input.name,
      JSON.stringify(input.domains),
      input.timezone,
      input.currency,
      input.idMode,
      input.respectGpc ? 1 : 0,
      input.attributionModel,
      input.lookbackDays,
      JSON.stringify(input.excludePaths),
      input.tagLinks ? 1 : 0,
      now,
      input.notifyPayments ? 1 : 0,
      input.serverEmailsOnly ? 1 : 0,
      input.spikeAlerts ? 1 : 0,
      input.dailyDigest ? 1 : 0,
      input.digestHour,
      input.tracking ? 1 : 0,
    )
    .run();
  resetSiteCaches();
  return (await getSite(db, id))!;
}

export async function updateSite(db: D1Database, id: string, input: UpdateSiteInput): Promise<SiteDTO | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?${values.length + 1}`);
    values.push(v);
  };
  if (input.name !== undefined) set("name", input.name);
  if (input.domains !== undefined) set("domains", JSON.stringify(input.domains));
  if (input.timezone !== undefined) set("timezone", input.timezone);
  if (input.currency !== undefined) set("currency", input.currency);
  if (input.idMode !== undefined) set("id_mode", input.idMode);
  if (input.respectGpc !== undefined) set("respect_gpc", input.respectGpc ? 1 : 0);
  if (input.attributionModel !== undefined) set("attribution_model", input.attributionModel);
  if (input.lookbackDays !== undefined) set("lookback_days", input.lookbackDays);
  if (input.excludePaths !== undefined) set("exclude_paths", JSON.stringify(input.excludePaths));
  if (input.tagLinks !== undefined) set("tag_links", input.tagLinks ? 1 : 0);
  if (input.notifyPayments !== undefined) set("notify_payments", input.notifyPayments ? 1 : 0);
  if (input.serverEmailsOnly !== undefined) set("server_emails_only", input.serverEmailsOnly ? 1 : 0);
  if (input.spikeAlerts !== undefined) set("spike_alerts", input.spikeAlerts ? 1 : 0);
  if (input.dailyDigest !== undefined) set("daily_digest", input.dailyDigest ? 1 : 0);
  if (input.digestHour !== undefined) set("digest_hour", input.digestHour);
  if (input.tracking !== undefined) set("tracking", input.tracking ? 1 : 0);
  set("updated_at", nowSec());
  values.push(id);
  const res = await db.prepare(`UPDATE sites SET ${sets.join(", ")} WHERE id = ?${values.length}`).bind(...values).run();
  resetSiteCaches();
  return res.meta.changes ? getSite(db, id) : null;
}

/** Deletes the site and everything recorded for it. */
export async function deleteSite(db: D1Database, id: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare("DELETE FROM sites WHERE id = ?").bind(id),
    db.prepare("DELETE FROM web_sessions WHERE site_id = ?").bind(id),
    db.prepare("DELETE FROM web_visitors WHERE site_id = ?").bind(id),
    db.prepare("DELETE FROM payments WHERE site_id = ?").bind(id),
    db.prepare("DELETE FROM payment_claims WHERE site_id = ?").bind(id),
    db.prepare("DELETE FROM subscriptions WHERE site_id = ?").bind(id),
    db.prepare("DELETE FROM payment_events WHERE connection_id IN (SELECT id FROM payment_connections WHERE site_id = ?)").bind(id),
    db.prepare("DELETE FROM payment_connections WHERE site_id = ?").bind(id),
    db.prepare("DELETE FROM funnels WHERE site_id = ?").bind(id),
  ]);
  resetSiteCaches();
  return Boolean(results[0]?.meta.changes);
}

// ---- Caches ----------------------------------------------------------------------------

const SITE_TTL_MS = 60_000;
const siteCache = new Map<string, { site: SiteDTO | null; at: number }>();

/** A site for the collector: cached per isolate for a minute (also misses, so unknown IDs can't hammer D1). */
export async function cachedSite(db: D1Database, id: string): Promise<SiteDTO | null> {
  const hit = siteCache.get(id);
  if (hit && Date.now() - hit.at < SITE_TTL_MS) return hit.site;
  const site = await getSite(db, id);
  if (siteCache.size > 500) {
    // Unknown IDs go first, so a stream of made-up ones can't push out the real sites.
    for (const [k, v] of siteCache) if (!v.site) siteCache.delete(k);
    if (siteCache.size > 500) siteCache.clear();
  }
  siteCache.set(id, { site, at: Date.now() });
  return site;
}

interface TrackedHost {
  siteId: string;
  domains: string[];
}
let tracked: { list: TrackedHost[]; at: number } | null = null;

/**
 * The site a short link's destination belongs to, if that site tags short-link
 * clicks. Read on the redirect path: cached a minute per isolate, and a slow or
 * failing D1 just means no tag.
 */
export async function trackedSiteFor(db: D1Database, host: string): Promise<string | null> {
  if (!tracked || Date.now() - tracked.at >= SITE_TTL_MS) {
    try {
      const { results } = await withTimeout(db.prepare("SELECT id, domains FROM sites WHERE tag_links = 1 AND tracking = 1").all<{ id: string; domains: string }>(), 500, "tracked sites read");
      tracked = { list: results.map((r) => ({ siteId: r.id, domains: parseList(r.domains) })), at: Date.now() };
    } catch (err) {
      console.error(JSON.stringify({ message: "tracked sites read failed", error: String(err) }));
      tracked = { list: tracked?.list ?? [], at: Date.now() };
    }
  }
  return tracked.list.find((t) => hostBelongs(host, t.domains))?.siteId ?? null;
}

export function resetSiteCaches(): void {
  siteCache.clear();
  tracked = null;
}

export function isIdMode(v: string): v is IdMode {
  return (ID_MODES as readonly string[]).includes(v);
}

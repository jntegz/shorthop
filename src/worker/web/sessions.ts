// Sessions: one D1 row per visit, updated by every event of it. A visit ends
// after 30 minutes without events; a pageview arriving with a different
// campaign or short-link click starts a new one, so each visit has one source.
// A visit isn't cut in two when the visitor's id changes in the middle of it
// (consent given, or the daily hash turning over at midnight UTC).

import type { Attribution } from "./source";

export const SESSION_GAP_SEC = 30 * 60;
/** Engaged time one event may add: a tab left open doesn't count for hours. */
export const MAX_ENGAGED_MS = 30 * 60 * 1000;

export type TouchKind = "pageview" | "goal" | "outbound" | "checkout" | "engage" | "vitals";

export interface SessionContext {
  siteId: string;
  visitorId: string;
  now: number;
  kind: TouchKind;
  path: string;
  hostname: string;
  engagedMs: number;
  /** Where this event's page came from; used when it starts a session. */
  attribution: Attribution;
  referrerHost: string;
  geo: { country: string; region: string; city: string; continent: string; timezone: string; org: string };
  client: { device: string; os: string; browser: string; language: string; screen: string };
  /**
   * Ids the same person may have had a moment ago (asked only when nothing is
   * open under visitorId): their open session is continued under visitorId.
   */
  earlierVisitors?: () => Promise<string[]>;
  /**
   * Whether what identify() said under the earlier id comes along too. Only
   * from one daily hash to the next: a hash can be shared by two people behind
   * one address with the same browser, and a first-party id is kept for good.
   */
  adoptIdentity?: boolean;
}

export interface SessionInfo {
  id: string;
  isNew: boolean;
  source: string;
  channel: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  linkSlug: string;
  /** D1 rows this event wrote, indexes included, as D1 reports them (0 when it doesn't). */
  rowsWritten: number;
}

interface OpenRow {
  id: string;
  source: string;
  channel: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  link_domain: string;
  link_slug: string;
}

/** A visit id: random, 16 URL-safe characters. Also the reference a checkout carries back (sh_ref). */
export const newSessionId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = btoa(String.fromCharCode(...bytes));
  s = s.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return s;
};

/** Did this landing come from somewhere other than the open session's source? */
function isNewCampaign(open: OpenRow, a: Attribution): boolean {
  if (a.link) return a.link.slug !== open.link_slug || a.link.domain !== open.link_domain;
  if (a.utm.source || a.utm.campaign) return a.utm.source !== open.utm_source || a.utm.campaign !== open.utm_campaign;
  if (a.channel === "Paid") return open.channel !== "Paid";
  return false;
}

const OPEN_COLS = "id, source, channel, utm_source, utm_medium, utm_campaign, link_domain, link_slug";
// The latest of the visitor's open sessions; the one started last when two were seen in the same second.
const OPEN_ORDER = "ORDER BY last_seen_at DESC, started_at DESC LIMIT 1";
/** SQL: the id of the visitor's open session ('' for none); site ?2, visitor ?3, and the given parameter for the cutoff. */
const openId = (cutoff: number) => `COALESCE((SELECT id FROM web_sessions WHERE site_id = ?2 AND visitor_id = ?3 AND last_seen_at > ?${cutoff} ${OPEN_ORDER}), '')`;

/**
 * The same person under an id they had a moment ago (the daily hash before
 * consent, or yesterday's hash just after midnight): their open session moves
 * to the id they have now, and what identify() said about them comes along
 * when c.adoptIdentity allows it. Null when there's none, or another request
 * moved it first.
 */
async function adoptSession(db: D1Database, c: SessionContext, earlier: string[], wrote: (rows: number | undefined) => void): Promise<OpenRow | null> {
  if (!earlier.length) return null;
  const marks = earlier.map((_, i) => `?${i + 4}`).join(", ");
  const found = await db
    .prepare(
      // Only for an id with no visits yet: a returning visitor never takes over someone else's session.
      `SELECT ${OPEN_COLS}, visitor_id FROM web_sessions
       WHERE site_id = ?1 AND visitor_id IN (${marks}) AND last_seen_at > ?2
         AND NOT EXISTS (SELECT 1 FROM web_sessions WHERE site_id = ?1 AND visitor_id = ?3)
       ${OPEN_ORDER}`,
    )
    .bind(c.siteId, c.now - SESSION_GAP_SEC, c.visitorId, ...earlier)
    .first<OpenRow & { visitor_id: string }>();
  if (!found) return null;
  const results = await db.batch([
    db.prepare("UPDATE web_sessions SET visitor_id = ?2 WHERE id = ?1 AND visitor_id = ?3").bind(found.id, c.visitorId, found.visitor_id),
    ...(c.adoptIdentity
      ? [
          db
            .prepare(
              `INSERT INTO web_visitors (site_id, id, first_seen, email, name, user_id, trust)
               SELECT site_id, ?3, first_seen, email, name, user_id, trust FROM web_visitors WHERE site_id = ?1 AND id = ?2
               ON CONFLICT (site_id, id) DO NOTHING`,
            )
            .bind(c.siteId, found.visitor_id, c.visitorId),
        ]
      : []),
  ]);
  for (const r of results) wrote(r.meta.rows_written);
  return results[0]?.meta.changes ? found : null;
}

/** Tries before a session is started regardless: each one lost a race to another event of the same visitor. */
const START_TRIES = 3;

/**
 * Records one event against the visitor's open session, or starts one.
 * Returns null for events that can't start a session (engaged time with
 * nothing open).
 *
 * The tracker sends a page's first events together (the pageview, then goals
 * queued before it loaded), so two requests can both find nothing open. A
 * session is therefore started only if the open session is still the one this
 * request read (or still none): the request that lost reads again and joins
 * the session the other one started.
 */
export async function touchSession(db: D1Database, c: SessionContext): Promise<SessionInfo | null> {
  const pv = c.kind === "pageview" ? 1 : 0;
  const cutoff = c.now - SESSION_GAP_SEC;
  let earlier: string[] | null = null;
  let rowsWritten = 0;
  const wrote = (rows: number | undefined) => {
    rowsWritten += rows ?? 0;
  };
  for (let attempt = 1; ; attempt++) {
    let open = await db
      .prepare(`SELECT ${OPEN_COLS} FROM web_sessions WHERE site_id = ?1 AND visitor_id = ?2 AND last_seen_at > ?3 ${OPEN_ORDER}`)
      .bind(c.siteId, c.visitorId, cutoff)
      .first<OpenRow>();
    if (!open && c.earlierVisitors) {
      earlier ??= await c.earlierVisitors();
      open = await adoptSession(db, c, earlier, wrote);
    }

    if (open && !(pv && isNewCampaign(open, c.attribution))) {
      const touched = await db
        .prepare(
          `UPDATE web_sessions SET
             last_seen_at = MAX(last_seen_at, ?2),
             pageviews = pageviews + ?3,
             goals = goals + ?4,
             engaged_ms = engaged_ms + ?5,
             entry_path = CASE WHEN ?3 = 1 AND entry_path = '' THEN ?6 ELSE entry_path END,
             exit_path = CASE WHEN ?3 = 1 THEN ?6 ELSE exit_path END,
             hostname = CASE WHEN hostname = '' THEN ?7 ELSE hostname END,
             checkout_at = CASE WHEN ?8 = 1 THEN ?2 ELSE checkout_at END
           WHERE id = ?1`,
        )
        .bind(open.id, c.now, pv, c.kind === "goal" ? 1 : 0, Math.min(c.engagedMs, MAX_ENGAGED_MS), c.path, c.hostname, c.kind === "checkout" ? 1 : 0)
        .run();
      wrote(touched.meta.rows_written);
      return {
        id: open.id,
        isNew: false,
        source: open.source,
        channel: open.channel,
        utmSource: open.utm_source,
        utmMedium: open.utm_medium,
        utmCampaign: open.utm_campaign,
        linkSlug: open.link_slug,
        rowsWritten,
      };
    }
    // Reading time and page speed belong to a visit already open.
    if (c.kind === "engage" || c.kind === "vitals") return null;

    const a = c.attribution;
    const id = newSessionId();
    const started = await db
      .prepare(
        `INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews, goals, engaged_ms, hostname, entry_path, exit_path,
           referrer_host, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, link_domain, link_slug,
           country, region, city, device, os, browser, language, checkout_at, org, continent, timezone, screen, return_visit)
         SELECT ?1, ?2, ?3, ?4, ?4, ?5, ?6, 0, ?7, ?8, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
           ?27, ?28, ?29, ?30, EXISTS (SELECT 1 FROM web_sessions WHERE site_id = ?2 AND visitor_id = ?3)
         WHERE ?33 = 1 OR ${openId(31)} = ?32`,
      )
      .bind(
        id,
        c.siteId,
        c.visitorId,
        c.now,
        pv,
        c.kind === "goal" ? 1 : 0,
        c.hostname,
        pv ? c.path : "",
        c.referrerHost,
        a.source,
        a.channel,
        a.utm.source,
        a.utm.medium,
        a.utm.campaign,
        a.utm.term,
        a.utm.content,
        a.link?.domain ?? "",
        a.link?.slug ?? "",
        c.geo.country,
        c.geo.region,
        c.geo.city,
        c.client.device,
        c.client.os,
        c.client.browser,
        c.client.language,
        c.kind === "checkout" ? c.now : null,
        c.geo.org,
        c.geo.continent,
        c.geo.timezone,
        c.client.screen,
        cutoff,
        open?.id ?? "",
        attempt >= START_TRIES ? 1 : 0,
      )
      .run();
    // Nothing inserted: another event of this visitor started (or moved) a session meanwhile. Read again.
    if (!started.meta.changes) continue;
    wrote(started.meta.rows_written);
    return {
      id,
      isNew: true,
      source: a.source,
      channel: a.channel,
      utmSource: a.utm.source,
      utmMedium: a.utm.medium,
      utmCampaign: a.utm.campaign,
      linkSlug: a.link?.slug ?? "",
      rowsWritten,
    };
  }
}

/**
 * identify(): who the visitor is. From the browser it only fills fields that
 * are still empty, so a page can't take over someone else's identity; the API
 * (trust "server") may overwrite.
 */
export async function identifyVisitor(
  db: D1Database,
  siteId: string,
  visitorId: string,
  who: { email?: string; name?: string; userId?: string },
  trust: "client" | "server",
  now: number,
): Promise<number> {
  const email = who.email?.trim().toLowerCase().slice(0, 254) || null;
  const name = who.name?.trim().slice(0, 200) || null;
  const userId = who.userId?.trim().slice(0, 200) || null;
  if (!email && !name && !userId) return 0;
  const pick = (col: string) =>
    trust === "server"
      ? `${col} = COALESCE(excluded.${col}, ${col})`
      : `${col} = CASE WHEN web_visitors.trust = 'server' THEN ${col} ELSE COALESCE(${col}, excluded.${col}) END`;
  const res = await db
    .prepare(
      `INSERT INTO web_visitors (site_id, id, first_seen, email, name, user_id, trust) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (site_id, id) DO UPDATE SET ${pick("email")}, ${pick("name")}, ${pick("user_id")},
         trust = CASE WHEN excluded.trust = 'server' THEN 'server' ELSE web_visitors.trust END`,
    )
    .bind(siteId, visitorId, now, email, name, userId, trust)
    .run();
  return res.meta.rows_written ?? 0;
}

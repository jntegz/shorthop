// Which visit gets the credit for a matched payment, by the site's model,
// among the customer's visits within the lookback window before it:
//
//   last_non_direct  the latest visit that came from somewhere (a direct one only if there's nothing else)
//   last_touch       the latest visit
//   first_touch      the earliest visit
//
// Each payment is credited to exactly one visit, so revenue by source, page
// or link adds up to the total. (Cookieless sites only see the visits of the
// payment's day: their visitor id changes daily.)

import type { SiteDTO } from "../../shared/sites";

export async function creditedSession(db: D1Database, site: SiteDTO, visitorId: string, matchedSessionId: string, occurredAt: number): Promise<string> {
  const from = occurredAt - site.lookbackDays * 86400;
  const order = site.attributionModel === "first_touch" ? "started_at ASC" : site.attributionModel === "last_touch" ? "started_at DESC" : "(channel != 'Direct') DESC, started_at DESC";
  const row = await db
    .prepare(
      `SELECT id FROM web_sessions WHERE site_id = ?1 AND visitor_id = ?2 AND started_at BETWEEN ?3 AND ?4
       ORDER BY ${order} LIMIT 1`,
    )
    .bind(site.id, visitorId, from, occurredAt + 60)
    .first<{ id: string }>();
  return row?.id ?? matchedSessionId;
}

/** After the model or the lookback changes: every matched payment is credited again. */
export async function recreditSite(db: D1Database, site: SiteDTO, limit = 5000): Promise<number> {
  const { results } = await db
    .prepare("SELECT id, visitor_id, session_id, occurred_at FROM payments WHERE site_id = ?1 AND kind = 'charge' AND session_id IS NOT NULL ORDER BY occurred_at DESC LIMIT ?2")
    .bind(site.id, limit)
    .all<{ id: string; visitor_id: string; session_id: string; occurred_at: number }>();
  const updates: D1PreparedStatement[] = [];
  for (const p of results) {
    const credited = await creditedSession(db, site, p.visitor_id, p.session_id, p.occurred_at);
    updates.push(db.prepare("UPDATE payments SET credited_session_id = ?2 WHERE id = ?1 OR parent_id = ?1").bind(p.id, credited));
  }
  for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));
  return updates.length;
}

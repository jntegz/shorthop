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

/** What tells whether a payment follows an earlier one (PaymentRow has them all). */
interface Followable {
  id: string;
  site_id: string;
  provider: string;
  occurred_at: number;
  subscription_id: string | null;
  customer_id: string | null;
}

/**
 * The earlier payment a later one takes its credit from: the first payment of
 * the same subscription, or (for a payment matched only through its customer)
 * the customer's first matched one. Null for a payment that stands on its own.
 */
async function creditSource(db: D1Database, p: Followable, matchedBy: string | null): Promise<{ id: string; credited_session_id: string } | null> {
  const byCustomer = matchedBy === "customer";
  if (!p.subscription_id && !(byCustomer && p.customer_id)) return null;
  return db
    .prepare(
      `SELECT id, credited_session_id FROM payments
       WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND credited_session_id IS NOT NULL AND (occurred_at < ?4 OR (occurred_at = ?4 AND id < ?3))
         AND ((?5 IS NOT NULL AND subscription_id = ?5) OR (?6 IS NOT NULL AND customer_id = ?6))
       ORDER BY (subscription_id IS ?5) DESC, occurred_at ASC, id LIMIT 1`,
    )
    .bind(p.site_id, p.provider, p.id, p.occurred_at, p.subscription_id, byCustomer ? p.customer_id : null)
    .first<{ id: string; credited_session_id: string }>();
}

/**
 * The visit a renewal or a customer-matched payment is credited to: the one
 * its original payment was credited to, however long ago. Without this the
 * lookback would run from the renewal's own date and land on a recent visit
 * (often a direct one) instead of the one that won the customer.
 */
export async function inheritedCredit(db: D1Database, p: Followable, matchedBy: string | null): Promise<string | null> {
  return (await creditSource(db, p, matchedBy))?.credited_session_id ?? null;
}

/**
 * After the model or the lookback changes: every matched payment is credited
 * again, oldest first, so payments that follow an earlier one (renewals) take
 * its new credit. Erased ones keep theirs: their visitor is gone.
 */
export async function recreditSite(db: D1Database, site: SiteDTO, limit = 5000): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, site_id, provider, visitor_id, session_id, occurred_at, subscription_id, customer_id, matched_by FROM payments
       WHERE site_id = ?1 AND kind = 'charge' AND session_id IS NOT NULL AND personal_cleared_at IS NULL ORDER BY occurred_at DESC LIMIT ?2`,
    )
    .bind(site.id, limit)
    .all<Followable & { visitor_id: string; session_id: string; matched_by: string | null }>();
  const sourceOf = await creditSources(db, site.id, results);
  const updates: D1PreparedStatement[] = [];
  const fresh = new Map<string, string>();
  for (const p of results.reverse()) {
    const source = sourceOf(p, p.matched_by);
    // The source was credited again earlier in this run; one outside it (older than the limit) keeps what it has.
    const credited = source ? (fresh.get(source.id) ?? source.credited_session_id) : await creditedSession(db, site, p.visitor_id, p.session_id, p.occurred_at);
    fresh.set(p.id, credited);
    updates.push(db.prepare("UPDATE payments SET credited_session_id = ?2 WHERE id = ?1 OR parent_id = ?1").bind(p.id, credited));
  }
  for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));
  return updates.length;
}

type Source = { id: string; provider: string; occurred_at: number; subscription_id: string | null; customer_id: string | null; credited_session_id: string };

/**
 * creditSource for many payments with one query: the site's payments these
 * can take their credit from (the same subscription, or the same customer for
 * one matched by customer), read once, then picked in memory in creditSource's
 * order. Keeps a site's recrediting within D1's queries per request, and its
 * memory to what the payments being credited can use.
 */
async function creditSources(
  db: D1Database,
  siteId: string,
  payments: readonly (Followable & { matched_by: string | null })[],
): Promise<(p: Followable, matchedBy: string | null) => Source | null> {
  const subscriptions = [...new Set(payments.flatMap((p) => (p.subscription_id ? [p.subscription_id] : [])))];
  const customers = [...new Set(payments.flatMap((p) => (p.matched_by === "customer" && p.customer_id ? [p.customer_id] : [])))];
  if (!subscriptions.length && !customers.length) return () => null;
  const { results } = await db
    .prepare(
      `SELECT id, provider, occurred_at, subscription_id, customer_id, credited_session_id FROM payments
       WHERE site_id = ?1 AND kind = 'charge' AND credited_session_id IS NOT NULL
         AND (subscription_id IN (SELECT value FROM json_each(?2)) OR customer_id IN (SELECT value FROM json_each(?3)))
       ORDER BY occurred_at ASC, id`,
    )
    .bind(siteId, JSON.stringify(subscriptions), JSON.stringify(customers))
    .all<Source>();
  const bySubscription = new Map<string, Source[]>();
  const byCustomer = new Map<string, Source[]>();
  const add = (map: Map<string, Source[]>, key: string, s: Source) => {
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  };
  for (const s of results) {
    if (s.subscription_id) add(bySubscription, `${s.provider}|${s.subscription_id}`, s);
    if (s.customer_id) add(byCustomer, `${s.provider}|${s.customer_id}`, s);
  }
  return (p, matchedBy) => {
    // Strictly earlier, ids breaking a tie in the order the query sorts them: two payments of the same
    // second can't each take the other's credit, and the first of them stands on its own.
    const fits = (s: Source) => s.occurred_at < p.occurred_at || (s.occurred_at === p.occurred_at && s.id < p.id);
    const sameSubscription = p.subscription_id ? bySubscription.get(`${p.provider}|${p.subscription_id}`)?.find(fits) : undefined;
    if (sameSubscription) return sameSubscription;
    if (matchedBy !== "customer" || !p.customer_id) return null;
    const customers = byCustomer.get(`${p.provider}|${p.customer_id}`) ?? [];
    // As creditSource orders them: for a payment without a subscription, the customer's payments without one first.
    return (p.subscription_id ? undefined : customers.find((s) => fits(s) && !s.subscription_id)) ?? customers.find(fits) ?? null;
  };
}

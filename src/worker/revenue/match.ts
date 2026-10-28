// Which visit led to a payment. Tried in order, the first that answers wins:
//
//   ref       the visit reference (sh_ref) passed through checkout        high
//   customer  an earlier matched payment of the same subscription/customer high
//   claim     a return page reported this payment's ids during a visit     high
//   email     a visitor identified with the payment's email               medium (server) / low (browser)
//   timing    the only visit that clicked a checkout link in the 3 hours
//             before, and no other payment claims it                      low
//
// Then the site's attribution model picks the visit that gets the credit
// (src/worker/revenue/attribute.ts). Refunds and disputes follow their charge.

import type { SiteDTO } from "../../shared/sites";
import { nowSec } from "../db";
import { creditedSession } from "./attribute";

const TIMING_WINDOW_SEC = 3 * 3600;
// An email the browser reported (anyone can send one) only counts for a visit
// in the day before the payment, so it can't pull in older payments.
const BROWSER_EMAIL_WINDOW_SEC = 86400;

/** A LIKE pattern for one whole space-separated token: ref's own _ and % match only themselves. */
export const tokenLike = (ref: string) => `% ${ref.replace(/[!%_]/g, "!$&")} %`;
/** Use with tokenLike. */
export const LIKE_ESCAPE = "ESCAPE '!'";

export interface PaymentRow {
  id: string;
  site_id: string;
  provider: string;
  kind: string;
  occurred_at: number;
  customer_id: string | null;
  email: string | null;
  subscription_id: string | null;
  order_ref: string | null;
  ref: string | null;
  session_id: string | null;
  /** Set once its personal details were removed (src/worker/web/privacy.ts): never matched again. */
  personal_cleared_at?: number | null;
}

interface Match {
  sessionId: string;
  visitorId: string;
  by: "ref" | "customer" | "claim" | "email" | "timing";
  confidence: "high" | "medium" | "low";
}

const refsOf = (p: PaymentRow) => [...(p.order_ref ?? "").split(" "), p.subscription_id, p.customer_id].filter((x): x is string => Boolean(x));

/** Visitor ids of visits kept, anonymized, after their visitor was erased (src/worker/web/privacy.ts). */
export const ERASED_VISITOR_PREFIX = "erased_";
/** SQL: the visit (alias `a`) still belongs to a visitor, so it may be matched or identified. */
export const liveSession = (a: string) => `substr(${a}.visitor_id, 1, ${ERASED_VISITOR_PREFIX.length}) != '${ERASED_VISITOR_PREFIX}'`;

async function sessionById(db: D1Database, siteId: string, id: string): Promise<{ id: string; visitor_id: string } | null> {
  return db.prepare(`SELECT id, visitor_id FROM web_sessions s WHERE id = ?1 AND site_id = ?2 AND ${liveSession("s")}`).bind(id, siteId).first();
}

/** Runs the cascade for one charge; returns why it failed when nothing matched. */
export async function findMatch(db: D1Database, p: PaymentRow, opts: { serverEmailsOnly?: boolean } = {}): Promise<Match | { reason: string }> {
  if (p.ref) {
    const s = await sessionById(db, p.site_id, p.ref);
    if (s) return { sessionId: s.id, visitorId: s.visitor_id, by: "ref", confidence: "high" };
  }

  if (p.subscription_id || p.customer_id) {
    const prior = await db
      .prepare(
        // An erased payment has no visitor left to give. The match is only as sure as the one it copies.
        `SELECT session_id, visitor_id, confidence FROM payments
         WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND session_id IS NOT NULL AND visitor_id IS NOT NULL AND personal_cleared_at IS NULL AND id != ?3
           AND ((?4 IS NOT NULL AND subscription_id = ?4) OR (?5 IS NOT NULL AND customer_id = ?5))
         ORDER BY (subscription_id = ?4) DESC, occurred_at ASC LIMIT 1`,
      )
      .bind(p.site_id, p.provider, p.id, p.subscription_id, p.customer_id)
      .first<{ session_id: string; visitor_id: string; confidence: Match["confidence"] | null }>();
    if (prior) return { sessionId: prior.session_id, visitorId: prior.visitor_id, by: "customer", confidence: prior.confidence ?? "high" };
  }

  const refs = refsOf(p);
  if (refs.length) {
    const claim = await db
      .prepare(`SELECT c.session_id, s.visitor_id FROM payment_claims c JOIN web_sessions s ON s.id = c.session_id
                WHERE c.site_id = ?1 AND c.ref IN (${refs.map((_, i) => `?${i + 2}`).join(", ")}) AND ${liveSession("s")} ORDER BY c.claimed_at LIMIT 1`)
      .bind(p.site_id, ...refs)
      .first<{ session_id: string; visitor_id: string }>();
    if (claim) return { sessionId: claim.session_id, visitorId: claim.visitor_id, by: "claim", confidence: "high" };
  }

  if (p.email) {
    const who = await db
      .prepare(
        `SELECT s.id, s.visitor_id, v.trust FROM web_visitors v JOIN web_sessions s ON s.site_id = v.site_id AND s.visitor_id = v.id
         WHERE v.site_id = ?1 AND v.email = ?2 AND s.started_at <= ?3 + 60
           AND (v.trust = 'server' OR (?4 = 0 AND s.started_at >= ?3 - ${BROWSER_EMAIL_WINDOW_SEC}))
         ORDER BY (v.trust = 'server') DESC, s.started_at DESC LIMIT 1`,
      )
      .bind(p.site_id, p.email, p.occurred_at, opts.serverEmailsOnly ? 1 : 0)
      .first<{ id: string; visitor_id: string; trust: string }>();
    if (who) return { sessionId: who.id, visitorId: who.visitor_id, by: "email", confidence: who.trust === "server" ? "medium" : "low" };
  }

  // Timing: a visit that went to checkout shortly before, with no other payment around it.
  const { results: candidates } = await db
    .prepare(
      `SELECT s.id, s.visitor_id FROM web_sessions s
       WHERE s.site_id = ?1 AND s.checkout_at BETWEEN ?2 AND ?3
         AND NOT EXISTS (SELECT 1 FROM payments o WHERE o.session_id = s.id AND o.kind = 'charge' AND o.id != ?4
                         AND o.occurred_at BETWEEN ?2 AND ?3 + ${TIMING_WINDOW_SEC})
       LIMIT 3`,
    )
    .bind(p.site_id, p.occurred_at - TIMING_WINDOW_SEC, p.occurred_at + 120, p.id)
    .all<{ id: string; visitor_id: string }>();
  if (candidates.length === 1) return { sessionId: candidates[0]!.id, visitorId: candidates[0]!.visitor_id, by: "timing", confidence: "low" };
  if (candidates.length > 1) return { reason: "Several visits went to checkout around that time; pass sh_ref through checkout to tell them apart." };
  if (!p.ref && !p.email) return { reason: "No visit reference, email or recent checkout click to match on." };
  if (p.ref) return { reason: "The visit reference in the payment isn't a known visit of this site." };
  return { reason: "No visitor with this email, and no visit went to checkout shortly before." };
}

/** Matches one charge and stores the result, then credits it to a visit. Returns true when matched. */
export async function matchPayment(db: D1Database, site: SiteDTO, p: PaymentRow): Promise<boolean> {
  if (p.personal_cleared_at) return false;
  const m = await findMatch(db, p, { serverEmailsOnly: site.serverEmailsOnly });
  if ("reason" in m) {
    await db.prepare("UPDATE payments SET unmatched_reason = ?2, last_match_at = ?3 WHERE id = ?1 AND session_id IS NULL").bind(p.id, m.reason, nowSec()).run();
    return false;
  }
  const credited = await creditedSession(db, site, m.visitorId, m.sessionId, p.occurred_at);
  await db.batch([
    db
      .prepare("UPDATE payments SET session_id = ?2, visitor_id = ?3, credited_session_id = ?4, matched_by = ?5, confidence = ?6, unmatched_reason = NULL WHERE id = ?1")
      .bind(p.id, m.sessionId, m.visitorId, credited, m.by, m.confidence),
    // Refunds and disputes of this charge follow it.
    db
      .prepare("UPDATE payments SET session_id = ?2, visitor_id = ?3, credited_session_id = ?4, matched_by = ?5, confidence = ?6, unmatched_reason = NULL WHERE parent_id = ?1 AND personal_cleared_at IS NULL")
      .bind(p.id, m.sessionId, m.visitorId, credited, m.by, m.confidence),
    // A surely matched payment tells who the visitor is, when nothing else did. A guess (timing, a
    // browser-claimed email) doesn't: it would name someone else. Never an erased visitor.
    ...(p.email && m.confidence !== "low" && m.visitorId && !m.visitorId.startsWith(ERASED_VISITOR_PREFIX)
      ? [
          db
            .prepare(
              `INSERT INTO web_visitors (site_id, id, first_seen, email, trust) VALUES (?1, ?2, ?3, ?4, 'client')
               ON CONFLICT (site_id, id) DO UPDATE SET email = COALESCE(web_visitors.email, excluded.email)`,
            )
            .bind(p.site_id, m.visitorId, p.occurred_at, p.email),
        ]
      : []),
  ]);
  return true;
}

/**
 * matchPayment for the retries: a payment that fails is logged and moved to
 * the back of the queue, so it can't stop the others, here or on other sites.
 */
async function tryMatch(db: D1Database, site: SiteDTO, p: PaymentRow): Promise<boolean> {
  try {
    return await matchPayment(db, site, p);
  } catch (err) {
    console.error(JSON.stringify({ message: "payment match failed", payment: p.id, error: String(err) }));
    await db.prepare("UPDATE payments SET last_match_at = ?2 WHERE id = ?1").bind(p.id, nowSec()).run().catch(() => undefined);
    return false;
  }
}

const PAYMENT_COLS = "id, site_id, provider, kind, occurred_at, customer_id, email, subscription_id, order_ref, ref, session_id, personal_cleared_at";

/** Unmatched charges are tried again for this long after they happened. */
const REMATCH_MAX_AGE_SEC = 90 * 86400;
// Never tried first, then the longest since the last try, so every payment gets
// its turn however many never match. Newest first among equals.
const RETRY_ORDER = "ORDER BY last_match_at IS NOT NULL, last_match_at, occurred_at DESC";

/** Tries again for a site's unmatched charges. */
export async function rematchSite(db: D1Database, site: SiteDTO, limit: number): Promise<{ tried: number; matched: number }> {
  const { results } = await db
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE site_id = ?1 AND kind = 'charge' AND session_id IS NULL AND personal_cleared_at IS NULL AND occurred_at >= ?3 ${RETRY_ORDER} LIMIT ?2`)
    .bind(site.id, limit, nowSec() - REMATCH_MAX_AGE_SEC)
    .all<PaymentRow>();
  let matched = 0;
  for (const p of results) if (await tryMatch(db, site, p)) matched++;
  return { tried: results.length, matched };
}

/** The daily retry across every site, within one budget. */
export async function rematchAll(db: D1Database, sites: SiteDTO[], limit: number): Promise<{ tried: number; matched: number }> {
  if (!sites.length || limit <= 0) return { tried: 0, matched: 0 };
  const byId = new Map(sites.map((s) => [s.id, s]));
  const { results } = await db
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE kind = 'charge' AND session_id IS NULL AND personal_cleared_at IS NULL AND occurred_at >= ?2 ${RETRY_ORDER} LIMIT ?1`)
    .bind(limit, nowSec() - REMATCH_MAX_AGE_SEC)
    .all<PaymentRow>();
  let tried = 0;
  let matched = 0;
  for (const p of results) {
    const site = byId.get(p.site_id);
    if (!site) continue;
    tried++;
    if (await tryMatch(db, site, p)) matched++;
  }
  return { tried, matched };
}

/**
 * A visit reported provider ids (a return page's ?session_id=…, or a
 * subscription checkout naming its visit): remember them, and match any
 * payment already waiting for them.
 */
export async function claimRefs(env: Env, site: SiteDTO, sessionId: string, _visitorId: string, refs: string[], now: number): Promise<void> {
  const db = env.DB;
  if (!refs.length) return;
  await db.batch(refs.map((r) => db.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING").bind(site.id, r, sessionId, now)));
  const likes = refs.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 2} ${LIKE_ESCAPE} OR subscription_id = ?${i + 2 + refs.length} OR customer_id = ?${i + 2 + refs.length}`);
  const { results } = await db
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE site_id = ?1 AND kind = 'charge' AND session_id IS NULL AND personal_cleared_at IS NULL AND (${likes.join(" OR ")}) LIMIT 20`)
    .bind(site.id, ...refs.map(tokenLike), ...refs)
    .all<PaymentRow>();
  for (const p of results) await tryMatch(db, site, p);
}

export { PAYMENT_COLS };

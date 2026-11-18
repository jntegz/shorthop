// Which visit led to a payment. Tried in order, the first that answers wins:
//
//   ref       the visit reference (sh_ref) passed through checkout        high
//             (or a short link's click straight to a checkout: link_clicks)
//   customer  an earlier matched payment of the same subscription/customer as sure as that one
//   claim     a signed webhook named this payment's ids for a visit        high
//             or a return page reported them close to the payment, or to
//             when the provider says it was begun                          low
//             or a claim from before 2.0.3 names its subscription          low
//   email     a visitor identified with the payment's email               medium (server) / low (browser)
//   timing    the only visit that clicked a checkout link in the 3 hours
//             before, and no other payment claims it                      low
//
// Confidence says how sure the credit is. Who the buyer is is a separate
// question (payments.proves_identity), and only two things answer it: an email
// the site's server reported for the visitor (`email`, medium), and a visitor the
// site's server named for this payment (confirmPaymentVisitor), plus `customer`
// matches that follow one of those. A reference is not proof: anyone can put a
// sh_ref on a checkout address, and a provider's webhook (`ref`, or `claim` from
// its checkout event) only repeats what was on it. Those credit the visit and
// nothing more: no email copied, no widening of a privacy request.
//
// Then the site's attribution model picks the visit that gets the credit
// (src/worker/revenue/attribute.ts). A renewal, or any payment matched only
// through its customer, gets the credit of the payment it follows: the visit
// that won the customer, not whichever one happened before the renewal.
// Refunds and disputes follow their charge.

import type { SiteDTO } from "../../shared/sites";
import { planLimits } from "../plan";
import { erasedReferences } from "../web/erasure";
import { shortLinkSource } from "../web/source";
import { nowSec } from "../db";
import { creditedSession, inheritedCredit } from "./attribute";

const TIMING_WINDOW_SEC = 3 * 3600;
// An email the browser reported (anyone can send one) only counts for a visit
// in the day before the payment, so it can't pull in older payments.
const BROWSER_EMAIL_WINDOW_SEC = 86400;
/** A reference from a browser counts only for a payment made (or, by the provider's word, begun) in the day before it was sent… */
export const CLAIM_WINDOW_SEC = 86400;
/** …or just after: a return page can load before the provider dates the payment, and clocks differ. */
const CLAIM_EARLY_SEC = 3600;
/** References one visit may report: a return page has a handful. */
const MAX_CLAIMS_PER_SESSION = 10;

/**
 * Who reported a payment's ids for a visit. A row from before 2.0.3 has no source
 * and counts as a browser's, except for the subscription it names: findMatch.
 */
export type ClaimSource = "browser" | "provider";

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
  /** When the provider says it was begun, if it gave that. */
  started_at?: number | null;
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
  /** The match says who the buyer is, not only which visit to credit (top of this file). */
  provesIdentity: boolean;
}

const refsOf = (p: PaymentRow) => [...(p.order_ref ?? "").split(" "), p.subscription_id, p.customer_id].filter((x): x is string => Boolean(x));

/** Visitor ids of visits kept, anonymized, after their visitor was erased (src/worker/web/privacy.ts). */
export const ERASED_VISITOR_PREFIX = "erased_";
/** SQL: the visit (alias `a`) still belongs to a visitor, so it may be matched or identified. */
export const liveSession = (a: string) => `substr(${a}.visitor_id, 1, ${ERASED_VISITOR_PREFIX.length}) != '${ERASED_VISITOR_PREFIX}'`;

async function sessionById(db: D1Database, siteId: string, id: string): Promise<{ id: string; visitor_id: string } | null> {
  return db.prepare(`SELECT id, visitor_id FROM web_sessions s WHERE id = ?1 AND site_id = ?2 AND ${liveSession("s")}`).bind(id, siteId).first();
}

/**
 * A short link straight to a checkout recorded its click under the reference
 * the payment brought back (link_clicks, written by the redirect). The click
 * becomes a visit of the site that received the payment, credited to the link,
 * so every revenue report counts it like any visit. via = 'checkout' keeps it
 * out of traffic counts: it never reached the site.
 */
export async function sessionFromLinkClick(db: D1Database, siteId: string, ref: string, provider: string): Promise<{ id: string; visitor_id: string } | null> {
  // The reference was made for that provider's checkout (a server reporting through the API may relay any).
  const click = await db.prepare("SELECT * FROM link_clicks WHERE ref = ?1 AND (?2 = 'api' OR provider = ?2)").bind(ref, provider).first<{
    domain: string;
    slug: string;
    source: string;
    country: string;
    region: string;
    city: string;
    device: string;
    os: string;
    browser: string;
    clicked_at: number;
  }>();
  if (!click) return null;
  const visitor = `lc_${ref}`;
  await db
    .prepare(
      `INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at, pageviews, source, channel, link_domain, link_slug,
         country, region, city, device, os, browser, checkout_at, via)
       VALUES (?1, ?2, ?3, ?4, ?4, 0, ?5, 'Short link', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?4, 'checkout')
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(ref, siteId, visitor, click.clicked_at, shortLinkSource(click.source, click.domain, click.slug), click.domain, click.slug, click.country, click.region, click.city, click.device, click.os, click.browser)
    .run();
  // Another site's payment may have claimed this click first; only ours counts.
  return sessionById(db, siteId, ref);
}

/** Runs the cascade for one charge; returns why it failed when nothing matched. */
export async function findMatch(db: D1Database, p: PaymentRow, opts: { serverEmailsOnly?: boolean } = {}): Promise<Match | { reason: string }> {
  if (p.ref) {
    const s = (await sessionById(db, p.site_id, p.ref)) ?? (await sessionFromLinkClick(db, p.site_id, p.ref, p.provider));
    if (s) return { sessionId: s.id, visitorId: s.visitor_id, by: "ref", confidence: "high", provesIdentity: false };
  }

  if (p.subscription_id || p.customer_id) {
    const prior = await db
      .prepare(
        // An erased payment has no visitor left to give. The match is only as sure as the one it copies.
        `SELECT session_id, visitor_id, confidence, proves_identity FROM payments
         WHERE site_id = ?1 AND provider = ?2 AND kind = 'charge' AND session_id IS NOT NULL AND visitor_id IS NOT NULL AND personal_cleared_at IS NULL AND id != ?3
           AND ((?4 IS NOT NULL AND subscription_id = ?4) OR (?5 IS NOT NULL AND customer_id = ?5))
         ORDER BY (subscription_id = ?4) DESC, occurred_at ASC LIMIT 1`,
      )
      .bind(p.site_id, p.provider, p.id, p.subscription_id, p.customer_id)
      .first<{ session_id: string; visitor_id: string; confidence: Match["confidence"] | null; proves_identity: number }>();
    if (prior) return { sessionId: prior.session_id, visitorId: prior.visitor_id, by: "customer", confidence: prior.confidence ?? "high", provesIdentity: prior.proves_identity === 1 };
  }

  const refs = refsOf(p);
  if (refs.length) {
    // A signed webhook's claim always counts; a browser's only close to the payment or to when the provider says
    // it was begun, on every path that gets here (the sweep below, a later payment event, a rematch). A claim from
    // before sources were kept may be either. Naming this payment's subscription it is most likely a webhook's, from
    // a checkout whose first payment comes after a trial, so it still counts, at low confidence; claims expire after
    // 90 days. The provider's own word goes first.
    const claim = await db
      .prepare(`SELECT c.session_id, c.source, s.visitor_id FROM payment_claims c JOIN web_sessions s ON s.id = c.session_id
                WHERE c.site_id = ?1 AND c.ref IN (${refs.map((_, i) => `?${i + 5}`).join(", ")}) AND ${liveSession("s")}
                  AND (c.source IS 'provider'
                    OR c.claimed_at BETWEEN ?2 - ${CLAIM_EARLY_SEC} AND ?2 + ${CLAIM_WINDOW_SEC}
                    OR c.claimed_at BETWEEN ?3 - ${CLAIM_EARLY_SEC} AND ?3 + ${CLAIM_WINDOW_SEC}
                    OR (c.source IS NULL AND c.ref = ?4))
                ORDER BY c.source IS 'provider' DESC, c.claimed_at LIMIT 1`)
      .bind(p.site_id, p.occurred_at, p.started_at ?? null, p.subscription_id, ...refs)
      .first<{ session_id: string; source: string | null; visitor_id: string }>();
    if (claim) return { sessionId: claim.session_id, visitorId: claim.visitor_id, by: "claim", confidence: claim.source === "provider" ? "high" : "low", provesIdentity: false };
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
    if (who) return { sessionId: who.id, visitorId: who.visitor_id, by: "email", confidence: who.trust === "server" ? "medium" : "low", provesIdentity: who.trust === "server" };
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
  if (candidates.length === 1) return { sessionId: candidates[0]!.id, visitorId: candidates[0]!.visitor_id, by: "timing", confidence: "low", provesIdentity: false };
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
  const credited = (await inheritedCredit(db, p, m.by)) ?? (await creditedSession(db, site, m.visitorId, m.sessionId, p.occurred_at));
  await db.batch([
    db
      .prepare("UPDATE payments SET session_id = ?2, visitor_id = ?3, credited_session_id = ?4, matched_by = ?5, confidence = ?6, proves_identity = ?7, unmatched_reason = NULL WHERE id = ?1")
      .bind(p.id, m.sessionId, m.visitorId, credited, m.by, m.confidence, m.provesIdentity ? 1 : 0),
    // Refunds and disputes of this charge follow it.
    db
      .prepare("UPDATE payments SET session_id = ?2, visitor_id = ?3, credited_session_id = ?4, matched_by = ?5, confidence = ?6, proves_identity = ?7, unmatched_reason = NULL WHERE parent_id = ?1 AND personal_cleared_at IS NULL")
      .bind(p.id, m.sessionId, m.visitorId, credited, m.by, m.confidence, m.provesIdentity ? 1 : 0),
    // A proven match tells who the visitor is, when nothing else did. Anything else (a reference anyone can
    // put on a checkout address, a guess) would name someone else.
    ...(p.email && m.provesIdentity ? [copyEmailStmt(db, p.site_id, m.visitorId, p.occurred_at, p.email)] : []),
  ]);
  return true;
}

/** Records a proven buyer's email on their visitor, if it has none. Never on an erased visitor. */
function copyEmailStmt(db: D1Database, siteId: string, visitorId: string, at: number, email: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO web_visitors (site_id, id, first_seen, email, trust) SELECT ?1, ?2, ?3, ?4, 'client' WHERE substr(?2, 1, ${ERASED_VISITOR_PREFIX.length}) != '${ERASED_VISITOR_PREFIX}'
       ON CONFLICT (site_id, id) DO UPDATE SET email = COALESCE(web_visitors.email, excluded.email)`,
    )
    .bind(siteId, visitorId, at, email);
}

/**
 * The site's server named this visitor for this payment (POST /sites/:id/payments
 * with visitorId), which says who paid in a way a reference on a checkout address
 * can't. Applies only when the match landed on that visitor.
 */
export async function confirmPaymentVisitor(db: D1Database, siteId: string, paymentId: string, visitorId: string): Promise<void> {
  const row = await db
    .prepare("SELECT email, occurred_at FROM payments WHERE id = ?1 AND site_id = ?2 AND visitor_id = ?3 AND personal_cleared_at IS NULL")
    .bind(paymentId, siteId, visitorId)
    .first<{ email: string | null; occurred_at: number }>();
  if (!row) return;
  await db.batch([
    db.prepare("UPDATE payments SET proves_identity = 1 WHERE (id = ?1 OR parent_id = ?1) AND site_id = ?2 AND personal_cleared_at IS NULL").bind(paymentId, siteId),
    ...(row.email ? [copyEmailStmt(db, siteId, visitorId, row.occurred_at, row.email)] : []),
  ]);
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

const PAYMENT_COLS = "id, site_id, provider, kind, occurred_at, started_at, customer_id, email, subscription_id, order_ref, ref, session_id, personal_cleared_at";

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

let claimDay = { day: "", perSite: new Map<string, number>() };

/** Tests only. */
export function resetClaimLimits(): void {
  claimDay = { day: "", perSite: new Map() };
}

/** The references a browser may still add: a few per visit (read from D1), and a daily number per site (per isolate). */
async function claimsWithinLimits(env: Env, siteId: string, sessionId: string, refs: string[], now: number): Promise<string[]> {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  if (claimDay.day !== day) claimDay = { day, perSite: new Map() };
  const today = claimDay.perSite.get(siteId) ?? 0;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM payment_claims WHERE session_id = ?1").bind(sessionId).first<{ n: number }>();
  const room = Math.min(MAX_CLAIMS_PER_SESSION - (row?.n ?? 0), planLimits(env).claimsPerDay - today);
  const allowed = room > 0 ? refs.slice(0, room) : [];
  claimDay.perSite.set(siteId, today + allowed.length);
  return allowed;
}

/**
 * A visit reported provider ids: a signed webhook's checkout naming its visit,
 * or a return page's ?session_id=… from a browser, which anyone can send.
 * Remembers them, and matches any payment already waiting for them. Returns the
 * rows written, for the collector's budget.
 *
 * A reference holds one claim: the provider's stands, and among browsers the
 * latest counts, so one planted before the checkout can't keep out the buyer's
 * own return page. What a browser claims can only ever match a payment made or
 * begun close to the claim (findMatch).
 */
export async function claimRefs(env: Env, site: SiteDTO, sessionId: string, refs: string[], now: number, source: ClaimSource): Promise<number> {
  const db = env.DB;
  const browser = source === "browser";
  // An erased payment keeps its provider ids: a claim on one would tie it to a visit again.
  const erased = await erasedReferences(env, site.id, refs, now);
  const open = refs.filter((r) => !erased.has(r));
  const wanted = browser ? await claimsWithinLimits(env, site.id, sessionId, open, now) : open;
  if (!wanted.length) return 0;
  const stored = await db.batch(
    wanted.map((r) =>
      db
        .prepare(
          `INSERT INTO payment_claims (site_id, ref, session_id, claimed_at, source) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (site_id, ref) DO UPDATE SET session_id = excluded.session_id, claimed_at = excluded.claimed_at, source = excluded.source
           WHERE excluded.source = 'provider' OR (payment_claims.source IS NOT 'provider' AND payment_claims.session_id != excluded.session_id)`,
        )
        .bind(site.id, r, sessionId, now, source),
    ),
  );
  const likes = wanted.map((_, i) => `(' ' || order_ref || ' ') LIKE ?${i + 2} ${LIKE_ESCAPE} OR subscription_id = ?${i + 2 + wanted.length} OR customer_id = ?${i + 2 + wanted.length}`);
  const from = 2 + 2 * wanted.length;
  const recent = browser ? ` AND (occurred_at BETWEEN ?${from} AND ?${from + 1} OR started_at BETWEEN ?${from} AND ?${from + 1})` : "";
  const { results } = await db
    .prepare(`SELECT ${PAYMENT_COLS} FROM payments WHERE site_id = ?1 AND kind = 'charge' AND session_id IS NULL AND personal_cleared_at IS NULL AND (${likes.join(" OR ")})${recent} LIMIT 20`)
    .bind(site.id, ...wanted.map(tokenLike), ...wanted, ...(browser ? [now - CLAIM_WINDOW_SEC, now + CLAIM_EARLY_SEC] : []))
    .all<PaymentRow>();
  for (const p of results) await tryMatch(db, site, p);
  return stored.reduce((sum, r) => sum + (r.meta.rows_written ?? 0), 0);
}

export { PAYMENT_COLS };

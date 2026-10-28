// Requests from a site's visitors and customers (GDPR articles 15, 17 and 20):
// find one person's records, export them, or erase them; and the daily
// retention that removes customer details from old payments.
//
// A person is found from one email, visitor id or payment id:
//   - the identified visitors with that email; a visitor's email counts only
//     when the site's server sent it, since a browser can claim any email
//   - the payments with that email, the charge a payment refunds and its
//     refunds, and the payments matched to the person's visitors with high or
//     medium confidence; such a payment's visitor is theirs too (a few rounds)
//   - the same provider customer's other payments, and their subscriptions.
// A visitor reached only through a browser-claimed email brings its identity
// and visits, but nothing further. A payment matched to a visitor by a guess
// (checkout timing, a browser-claimed email) never brings that visitor in, and
// someone else's payment guessed onto the person's visitor isn't theirs: an
// erasure unlinks it so it can be matched again, without touching it otherwise.
//
// Erasing keeps the money: payments lose their personal details
// (personal_cleared_at) but keep amount, date and credited visit, so revenue
// reports still add up. The visits a kept payment is credited to stay as
// anonymous visits (a fresh random visitor each, "erased_…", which matching
// and identify ignore; the finer location and device details and campaign
// terms cleared); the person's other visits are deleted.
//
// The request log keeps who asked, when and how many records: never whom
// a request was about.

import type { PrivacyCountsDTO, PrivacyEraseDTO, PrivacyPersonInput, PrivacyRequestDTO, SiteDTO } from "../../shared/sites";
import { nowSec } from "../db";
import { ERASED_VISITOR_PREFIX } from "../revenue/match";
import { newId, resetSiteCaches } from "./sites";

export interface Person {
  /** Their visitors: identities and visits. */
  visitorIds: string[];
  paymentIds: string[];
  /** subscriptions.id ("<provider>:<subscription id>"). */
  subscriptionIds: string[];
}

/** Match confidences that say a payment's visitor is its customer (not timing, not a browser-claimed email). */
const SURE = "('high', 'medium')";
const isSure = (confidence: string | null) => confidence === "high" || confidence === "medium";
/** A provider and its customer id as one value; SQL builds the same with provider || char(31) || customer_id. */
const customerKey = (provider: string, customerId: string) => `${provider}\u001f${customerId}`;
/** Rounds of "a payment's visitor is theirs, and so are that visitor's payments". */
const MAX_ROUNDS = 3;

const list = (ids: Iterable<string>) => JSON.stringify([...new Set(ids)]);
const IN = (n: number) => `IN (SELECT value FROM json_each(?${n}))`;

interface PaymentHit {
  id: string;
  provider: string;
  customer_id: string | null;
  subscription_id: string | null;
  visitor_id: string | null;
  confidence: string | null;
}

/** The records of one person on one site (see the top of this file). */
export async function resolvePerson(db: D1Database, site: SiteDTO, who: PrivacyPersonInput): Promise<Person> {
  const visitors = new Set<string>();
  /** Visitors whose sure-matched payments are theirs too: all but those reached by a browser-claimed email. */
  const expanding = new Set<string>();
  const emails = new Set<string>();
  const seeds = new Set<string>();

  if (who.email) emails.add(who.email.toLowerCase());
  if (who.visitorId) {
    visitors.add(who.visitorId);
    expanding.add(who.visitorId);
    const row = await db.prepare("SELECT email, trust FROM web_visitors WHERE site_id = ?1 AND id = ?2").bind(site.id, who.visitorId).first<{ email: string | null; trust: string }>();
    if (row?.email && row.trust === "server") emails.add(row.email.toLowerCase());
  }
  if (who.paymentId) {
    const p = await db
      .prepare("SELECT id, parent_id, email, visitor_id, confidence FROM payments WHERE site_id = ?1 AND id = ?2")
      .bind(site.id, who.paymentId)
      .first<{ id: string; parent_id: string | null; email: string | null; visitor_id: string | null; confidence: string | null }>();
    if (p) {
      seeds.add(p.id);
      if (p.parent_id) seeds.add(p.parent_id);
      if (p.email) emails.add(p.email.toLowerCase());
      if (p.visitor_id && isSure(p.confidence)) {
        visitors.add(p.visitor_id);
        expanding.add(p.visitor_id);
      }
    }
  }
  if (emails.size) {
    const { results } = await db.prepare(`SELECT id, trust FROM web_visitors WHERE site_id = ?1 AND lower(email) ${IN(2)}`).bind(site.id, list(emails)).all<{ id: string; trust: string }>();
    for (const r of results) {
      visitors.add(r.id);
      if (r.trust === "server") expanding.add(r.id);
    }
  }

  const hits = new Map<string, PaymentHit>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { results } = await db
      .prepare(
        `SELECT id, provider, customer_id, subscription_id, visitor_id, confidence FROM payments
         WHERE site_id = ?1 AND (id ${IN(2)} OR parent_id ${IN(2)} OR lower(email) ${IN(3)} OR (visitor_id ${IN(4)} AND confidence IN ${SURE}))`,
      )
      .bind(site.id, list(seeds), list(emails), list(expanding))
      .all<PaymentHit>();
    let grew = false;
    for (const p of results) {
      hits.set(p.id, p);
      if (p.visitor_id && isSure(p.confidence) && !expanding.has(p.visitor_id)) {
        visitors.add(p.visitor_id);
        expanding.add(p.visitor_id);
        grew = true;
      }
    }
    if (!grew) break;
  }

  // The same provider customer's other payments, every refund of them, and the subscriptions.
  const customers = [...new Set([...hits.values()].filter((p) => p.customer_id).map((p) => customerKey(p.provider, p.customer_id!)))];
  const subs = new Set([...hits.values()].filter((p) => p.subscription_id).map((p) => `${p.provider}:${p.subscription_id}`));
  const paymentIds = new Set(hits.keys());
  const { results: sameCustomer } = await db
    .prepare(`SELECT id FROM payments WHERE site_id = ?1 AND (provider || char(31) || customer_id) ${IN(2)}`)
    .bind(site.id, list(customers))
    .all<{ id: string }>();
  for (const r of sameCustomer) paymentIds.add(r.id);
  const { results: withRefunds } = await db
    .prepare(`SELECT id, provider, subscription_id FROM payments WHERE site_id = ?1 AND (id ${IN(2)} OR parent_id ${IN(2)})`)
    .bind(site.id, list(paymentIds))
    .all<{ id: string; provider: string; subscription_id: string | null }>();
  for (const r of withRefunds) {
    paymentIds.add(r.id);
    if (r.subscription_id) subs.add(`${r.provider}:${r.subscription_id}`);
  }
  const { results: subRows } = await db
    .prepare(`SELECT id FROM subscriptions WHERE site_id = ?1 AND (id ${IN(2)} OR (provider || char(31) || customer_id) ${IN(3)})`)
    .bind(site.id, list(subs), list(customers))
    .all<{ id: string }>();

  return { visitorIds: [...visitors], paymentIds: [...paymentIds], subscriptionIds: subRows.map((r) => r.id) };
}

export async function personCounts(db: D1Database, site: SiteDTO, person: Person): Promise<PrivacyCountsDTO> {
  const [identities, visits, subs] = await db.batch<{ n: number; active?: number }>([
    db.prepare(`SELECT COUNT(*) AS n FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, list(person.visitorIds)),
    db.prepare(`SELECT COUNT(*) AS n FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)}`).bind(site.id, list(person.visitorIds)),
    db
      .prepare(`SELECT COUNT(*) AS n, SUM(status IN ('active', 'trialing', 'past_due')) AS active FROM subscriptions WHERE site_id = ?1 AND id ${IN(2)}`)
      .bind(site.id, list(person.subscriptionIds)),
  ]);
  return {
    identities: identities?.results[0]?.n ?? 0,
    visits: visits?.results[0]?.n ?? 0,
    payments: person.paymentIds.length,
    subscriptions: subs?.results[0]?.n ?? 0,
    activeSubscriptions: subs?.results[0]?.active ?? 0,
  };
}

const EXPORT_MAX_VISITS = 5000;

/** Everything stored about the person, as it's stored (articles 15 and 20). */
export async function exportPerson(db: D1Database, site: SiteDTO, person: Person, now = nowSec()): Promise<Record<string, unknown>> {
  const [identities, visits, pays, subs] = await db.batch([
    db.prepare(`SELECT * FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, list(person.visitorIds)),
    db.prepare(`SELECT * FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)} ORDER BY started_at DESC LIMIT ${EXPORT_MAX_VISITS}`).bind(site.id, list(person.visitorIds)),
    db.prepare(`SELECT * FROM payments WHERE site_id = ?1 AND id ${IN(2)} ORDER BY occurred_at DESC`).bind(site.id, list(person.paymentIds)),
    db.prepare(`SELECT * FROM subscriptions WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, list(person.subscriptionIds)),
  ]);
  const visitRows = visits?.results ?? [];
  return {
    site: { id: site.id, name: site.name },
    exportedAt: new Date(now * 1000).toISOString(),
    identities: identities?.results ?? [],
    visits: visitRows,
    payments: pays?.results ?? [],
    subscriptions: subs?.results ?? [],
    notes: [
      ...(visitRows.length >= EXPORT_MAX_VISITS ? [`Only the latest ${EXPORT_MAX_VISITS} visits are included.`] : []),
      "Times are Unix seconds (UTC). Amounts are in minor units (cents) of their currency.",
      "Single page views and events are kept by Cloudflare Analytics Engine for about 90 days, without a name or email, and can't be read per person; they are not included.",
      "The payment provider keeps its own records of each payment.",
    ],
  };
}

/** Removes the person (article 17); payments stay as anonymous amounts. */
export async function erasePerson(db: D1Database, site: SiteDTO, person: Person, by: string, now = nowSec()): Promise<PrivacyEraseDTO> {
  const before = await personCounts(db, site, person);
  const visitors = list(person.visitorIds);
  const payments = list(person.paymentIds);
  // Path without its #fragment: single-page apps can put ids there.
  const noFragment = (col: string) => `CASE WHEN instr(${col}, '#') > 0 THEN substr(${col}, 1, instr(${col}, '#') - 1) ELSE ${col} END`;
  const results = await db.batch([
    // Checkout references proving which visit a payment came from.
    db.prepare(`DELETE FROM payment_claims WHERE site_id = ?1 AND session_id IN (SELECT id FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)})`).bind(site.id, visitors),
    // Someone else's payment matched to their visitor by a guess: unlinked, to be matched again; nothing of its own removed.
    db
      .prepare(
        `UPDATE payments SET session_id = NULL, visitor_id = NULL, credited_session_id = NULL, matched_by = NULL, confidence = NULL, unmatched_reason = NULL, last_match_at = NULL
         WHERE site_id = ?1 AND visitor_id ${IN(2)} AND id NOT ${IN(3)}`,
      )
      .bind(site.id, visitors, payments),
    // Visits a kept payment is credited to stay, so revenue by source still adds up, but belong to nobody.
    db
      .prepare(
        `UPDATE web_sessions SET visitor_id = '${ERASED_VISITOR_PREFIX}' || lower(hex(randomblob(9))), region = '', city = '', org = '', timezone = '', language = '', screen = '',
           hostname = '', utm_term = '', utm_content = '', entry_path = ${noFragment("entry_path")}, exit_path = ${noFragment("exit_path")}, return_visit = 0, checkout_at = NULL
         WHERE site_id = ?1 AND visitor_id ${IN(2)} AND id IN (SELECT credited_session_id FROM payments WHERE site_id = ?1 AND credited_session_id IS NOT NULL)`,
      )
      .bind(site.id, visitors),
    db.prepare(`DELETE FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)}`).bind(site.id, visitors),
    db.prepare(`DELETE FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, visitors),
    clearPaymentsStmt(db, `site_id = ?2 AND id ${IN(3)}`).bind(now, site.id, payments),
    db.prepare(`UPDATE subscriptions SET customer_id = NULL, personal_cleared_at = COALESCE(personal_cleared_at, ?3) WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, list(person.subscriptionIds), now),
    // Queued and logged site.payment webhooks carry the email.
    db
      .prepare(
        `DELETE FROM webhook_deliveries WHERE event_type = 'site.payment' AND json_extract(payload, '$.data.site.id') = ?1
           AND json_extract(payload, '$.data.payment.id') ${IN(2)}`,
      )
      .bind(site.id, payments),
    logStmt(db, site.id, "erase", by, now, before),
  ]);
  resetSiteCaches();
  const warnings = [
    ...(before.activeSubscriptions
      ? [`${before.activeSubscriptions === 1 ? "A subscription is" : `${before.activeSubscriptions} subscriptions are`} still active: its next renewal arrives from the provider with the customer's details again. Erase them at the provider too.`]
      : []),
    "Single page views and events stay in Cloudflare Analytics Engine, without a name or email, until they expire after about 90 days.",
    "Emails already sent (payment alerts, digests), site.payment webhooks already delivered to your endpoints, and data at the payment provider are outside Shorthop.",
    "This erased them on this site only: erase them on your other sites too, if they visited those.",
  ];
  return {
    counts: { ...before, anonymizedVisits: results[2]?.meta.changes ?? 0, webhookDeliveries: results[7]?.meta.changes ?? 0 },
    warnings,
  };
}

/** Clears a payment's personal details: ?1 is now; `where` binds from ?2. */
function clearPaymentsStmt(db: D1Database, where: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE payments SET email = NULL, customer_id = NULL, ref = NULL, visitor_id = NULL, unmatched_reason = NULL, personal_cleared_at = ?1
     WHERE personal_cleared_at IS NULL AND ${where}`,
  );
}

function logStmt(db: D1Database, siteId: string, kind: "export" | "erase", by: string, now: number, counts: PrivacyCountsDTO): D1PreparedStatement {
  return db
    .prepare("INSERT INTO privacy_requests (id, site_id, kind, by_identity, created_at, counts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(newId("pr_"), siteId, kind, by, now, JSON.stringify(counts));
}

export async function logExport(db: D1Database, site: SiteDTO, by: string, counts: PrivacyCountsDTO, now = nowSec()): Promise<void> {
  await logStmt(db, site.id, "export", by, now, counts).run();
}

export async function listPrivacyRequests(db: D1Database, site: SiteDTO, limit = 50): Promise<PrivacyRequestDTO[]> {
  const { results } = await db
    .prepare("SELECT id, kind, by_identity, created_at, counts FROM privacy_requests WHERE site_id = ?1 ORDER BY created_at DESC LIMIT ?2")
    .bind(site.id, limit)
    .all<{ id: string; kind: "export" | "erase"; by_identity: string; created_at: number; counts: string }>();
  return results.map((r) => {
    let counts: Partial<PrivacyCountsDTO> = {};
    try {
      counts = JSON.parse(r.counts) as Partial<PrivacyCountsDTO>;
    } catch {
      // Shown without counts.
    }
    return { id: r.id, kind: r.kind, by: r.by_identity, createdAt: r.created_at, counts };
  });
}

// ---- Retention ----------------------------------------------------------------------

const MONTH_SEC = 30 * 86400;

/**
 * Daily: on sites with a customer retention period, payments older than it
 * lose their personal details, ended subscriptions their customer id, and
 * identified visitors with nothing newer are forgotten. One query, and one
 * batch when a site has a period.
 */
export async function pruneCustomerData(db: D1Database, now = nowSec()): Promise<number> {
  const { results: sites } = await db
    .prepare("SELECT id, customer_retention_months AS months FROM sites WHERE customer_retention_months IS NOT NULL")
    .all<{ id: string; months: number }>();
  if (!sites.length) return 0;
  const stmts = sites.flatMap(({ id, months }) => {
    const cutoff = now - months * MONTH_SEC;
    return [
      clearPaymentsStmt(db, "site_id = ?2 AND occurred_at < ?3").bind(now, id, cutoff),
      db
        .prepare(
          `UPDATE subscriptions SET customer_id = NULL, personal_cleared_at = ?3
           WHERE site_id = ?1 AND customer_id IS NOT NULL AND status IN ('canceled', 'ended') AND COALESCE(ended_at, canceled_at) < ?2`,
        )
        .bind(id, cutoff, now),
      // Matching copies payment emails here, so old identities go too, unless the visitor came back since.
      db
        .prepare(
          `DELETE FROM web_visitors AS v WHERE v.site_id = ?1 AND v.first_seen < ?2
             AND NOT EXISTS (SELECT 1 FROM web_sessions s WHERE s.site_id = ?1 AND s.visitor_id = v.id AND s.last_seen_at >= ?2)
             AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.site_id = ?1 AND p.visitor_id = v.id AND p.occurred_at >= ?2)`,
        )
        .bind(id, cutoff),
    ];
  });
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

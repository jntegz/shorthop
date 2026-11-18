// Requests from a site's visitors and customers (GDPR articles 15, 17 and 20):
// find one person's records, export them, or erase them; and the daily
// retention that removes customer details from old payments and old visits.
//
// A person is found from one email, visitor id or payment id:
//   - the visitors the site's server identified with that email (a visitor's email
//     counts only then, since a browser can claim any email)
//   - the payments with that email, the charge a payment refunds and its refunds,
//     and the payments whose match proves who paid (payments.proves_identity: an
//     email the site's server reported, or a visitor it named for that payment);
//     such a payment's visitor is theirs too (a few rounds)
//   - the same provider customer's other payments, and their subscriptions.
//
// Anything a browser could have sent proves nothing about a person: an email it
// claimed, a checkout reference (anyone can put one on a checkout address, and a
// provider's webhook only repeats it), a reference on a return page. Visitors
// linked to the person only that way are counted apart (unproven), and join the
// request only when the operator includes them, for their own identity and visits
// and nothing further. A guess (checkout timing) doesn't link anybody. Someone
// else's payment matched to the person's visitor isn't theirs: an erasure unlinks
// it, without touching it otherwise.
//
// Erasing keeps the money: payments lose their personal details
// (personal_cleared_at) but keep amount, date and credited visit, so revenue
// reports still add up. The visits a kept payment is credited to stay as
// anonymous visits under a new id, so neither the visit nor the payment can be
// joined to what Analytics Engine still holds: a fresh random visitor each
// ("erased_…", which matching and identify ignore), the finer location and device
// details and campaign terms cleared. The person's other visits are deleted. Keyed
// hashes go on the erasure ledger (./erasure.ts), which keeps their browser id from
// being collected again and lets a restored backup be erased again.
//
// An erased payment can be credited to a visit that isn't erased: a checkout
// reference proves nothing, so that visit may be someone else's and stays as it is.
// The payment moves to an anonymous copy of it instead (new ids, the day only, not
// counted as traffic), so revenue by source is unchanged and nothing on the payment
// leads to that visit or its browser id. A short-link click made into a visit only
// for this payment goes, with its click row.
//
// The request log keeps who asked, when and how many records: never whom
// a request was about.

import { PRIVACY_LINK_KINDS, type PrivacyCountsDTO, type PrivacyEraseDTO, type PrivacyLinkKind, type PrivacyPersonInput, type PrivacyReapplyDTO, type PrivacyRequestDTO, type PrivacyUnprovenDTO, type SiteDTO } from "../../shared/sites";
import { nowSec } from "../db";
import { FREE, planLimits } from "../plan";
import { ERASED_VISITOR_PREFIX } from "../revenue/match";
import { ledgerWrite, mergeLedgerCopy, pruneLedgerStmt, readLedger, type LedgerEntry } from "./erasure";
import { newSessionId } from "./sessions";
import { newId, resetSiteCaches } from "./sites";

export interface Person {
  /** Their visitors: identities and visits, with any unproven links the request included. */
  visitorIds: string[];
  paymentIds: string[];
  /** subscriptions.id ("<provider>:<subscription id>"). */
  subscriptionIds: string[];
  /** Visitors linked only by something a browser could have sent, by how. */
  unproven: Record<PrivacyLinkKind, string[]>;
  included: PrivacyLinkKind[];
  /** Other people's payments, or unproven ones, matched to these visitors. */
  otherPayments: number;
}

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
  matched_by: string | null;
  confidence: string | null;
  proves_identity: number;
}

/** The match ties the payment to a visit through a reference a browser could have supplied: a lead, not proof. A guess isn't even that. */
const byReference = (p: Pick<PaymentHit, "matched_by" | "confidence">) => p.matched_by === "ref" || p.matched_by === "claim" || (p.matched_by === "customer" && p.confidence !== "low");

/** The records of one person on one site (see the top of this file). */
export async function resolvePerson(db: D1Database, site: SiteDTO, who: PrivacyPersonInput): Promise<Person> {
  const visitors = new Set<string>();
  /** Visitors whose proven payments are theirs too: all but those the request didn't establish. */
  const expanding = new Set<string>();
  const emails = new Set<string>();
  const seeds = new Set<string>();
  const claimed = new Set<string>();
  const referenced = new Set<string>();

  if (who.email) emails.add(who.email.toLowerCase());
  if (who.visitorId) {
    visitors.add(who.visitorId);
    expanding.add(who.visitorId);
    const row = await db.prepare("SELECT email, trust FROM web_visitors WHERE site_id = ?1 AND id = ?2").bind(site.id, who.visitorId).first<{ email: string | null; trust: string }>();
    if (row?.email && row.trust === "server") emails.add(row.email.toLowerCase());
  }
  if (who.paymentId) {
    const p = await db
      .prepare("SELECT id, parent_id, email, visitor_id, matched_by, confidence, proves_identity FROM payments WHERE site_id = ?1 AND id = ?2")
      .bind(site.id, who.paymentId)
      .first<{ id: string; parent_id: string | null; email: string | null; visitor_id: string | null; matched_by: string | null; confidence: string | null; proves_identity: number }>();
    if (p) {
      seeds.add(p.id);
      if (p.parent_id) seeds.add(p.parent_id);
      if (p.email) emails.add(p.email.toLowerCase());
      if (p.visitor_id && p.proves_identity) {
        visitors.add(p.visitor_id);
        expanding.add(p.visitor_id);
      } else if (p.visitor_id && byReference(p)) referenced.add(p.visitor_id);
    }
  }
  if (emails.size) {
    const { results } = await db.prepare(`SELECT id, trust FROM web_visitors WHERE site_id = ?1 AND lower(email) ${IN(2)}`).bind(site.id, list(emails)).all<{ id: string; trust: string }>();
    for (const r of results) {
      if (r.trust === "server") {
        visitors.add(r.id);
        expanding.add(r.id);
      } else claimed.add(r.id);
    }
  }

  const hits = new Map<string, PaymentHit>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { results } = await db
      .prepare(
        `SELECT id, provider, customer_id, subscription_id, visitor_id, matched_by, confidence, proves_identity FROM payments
         WHERE site_id = ?1 AND (id ${IN(2)} OR parent_id ${IN(2)} OR lower(email) ${IN(3)} OR (visitor_id ${IN(4)} AND proves_identity = 1))`,
      )
      .bind(site.id, list(seeds), list(emails), list(expanding))
      .all<PaymentHit>();
    let grew = false;
    for (const p of results) {
      hits.set(p.id, p);
      if (!p.visitor_id) continue;
      if (p.proves_identity && !expanding.has(p.visitor_id)) {
        visitors.add(p.visitor_id);
        expanding.add(p.visitor_id);
        grew = true;
      } else if (!p.proves_identity && byReference(p)) referenced.add(p.visitor_id);
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

  const unproven: Person["unproven"] = {
    claimed_email: [...claimed].filter((v) => !visitors.has(v)),
    payment_reference: [...referenced].filter((v) => !visitors.has(v) && !claimed.has(v)),
  };
  const included = PRIVACY_LINK_KINDS.filter((k) => who.include?.includes(k));
  const visitorIds = new Set([...visitors, ...included.flatMap((k) => unproven[k])]);
  const other = await db
    .prepare(`SELECT COUNT(*) AS n FROM payments WHERE site_id = ?1 AND visitor_id ${IN(2)} AND id NOT ${IN(3)}`)
    .bind(site.id, list(visitorIds), list(paymentIds))
    .first<{ n: number }>();

  return { visitorIds: [...visitorIds], paymentIds: [...paymentIds], subscriptionIds: subRows.map((r) => r.id), unproven, included, otherPayments: other?.n ?? 0 };
}

export async function personCounts(db: D1Database, site: SiteDTO, person: Person): Promise<PrivacyCountsDTO> {
  const groups = PRIVACY_LINK_KINDS.filter((k) => person.unproven[k].length);
  const [identities, visits, subs, ...unproven] = await db.batch<{ n: number; active?: number; visits?: number }>([
    db.prepare(`SELECT COUNT(*) AS n FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, list(person.visitorIds)),
    db.prepare(`SELECT COUNT(*) AS n FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)}`).bind(site.id, list(person.visitorIds)),
    db
      .prepare(`SELECT COUNT(*) AS n, SUM(status IN ('active', 'trialing', 'past_due')) AS active FROM subscriptions WHERE site_id = ?1 AND id ${IN(2)}`)
      .bind(site.id, list(person.subscriptionIds)),
    ...groups.map((k) =>
      db
        .prepare(`SELECT (SELECT COUNT(*) FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)}) AS n, (SELECT COUNT(*) FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)}) AS visits`)
        .bind(site.id, list(person.unproven[k])),
    ),
  ]);
  const links: PrivacyUnprovenDTO[] = groups.map((kind, i) => ({
    kind,
    identities: unproven[i]?.results[0]?.n ?? 0,
    visits: unproven[i]?.results[0]?.visits ?? 0,
    included: person.included.includes(kind),
  }));
  return {
    identities: identities?.results[0]?.n ?? 0,
    visits: visits?.results[0]?.n ?? 0,
    payments: person.paymentIds.length,
    subscriptions: subs?.results[0]?.n ?? 0,
    activeSubscriptions: subs?.results[0]?.active ?? 0,
    ...(links.length ? { unproven: links } : {}),
    ...(person.otherPayments ? { otherPayments: person.otherPayments } : {}),
  };
}

/** Rows read per query, and the most visits one export holds. */
const EXPORT_PAGE = 5000;
const EXPORT_MAX_VISITS = 50_000;

const NOT_EXPORTED = [
  { what: "Single page views and events", why: "Kept by Cloudflare Analytics Engine for about 90 days under the visitor and visit IDs, with no name or email. They can't be listed from here and expire on their own." },
  { what: "Daily totals", why: "Counts per link, page or source that hold nothing about one person." },
  { what: "Other tracked sites", why: "Each site is a separate request." },
  { what: "Emails and webhooks already sent", why: "Payment alerts, digests and delivered webhooks are with their recipients." },
  { what: "The payment provider's records", why: "The provider keeps its own." },
  { what: "Backups", why: "Downloaded archives and copies in R2 hold the data as it was when they were made." },
];

/**
 * What is stored about the person, as it's stored (articles 15 and 20), and a
 * list of what isn't in it. Every added table is reached only through the person's
 * own visits and payments, so it can't bring in someone else's.
 */
export async function exportPerson(db: D1Database, site: SiteDTO, person: Person, now = nowSec()): Promise<Record<string, unknown>> {
  const visitors = list(person.visitorIds);
  const sessionsOf = `SELECT id FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)}`;
  const [identities, pays, subs, claims, clicks, deliveries] = await db.batch([
    db.prepare(`SELECT * FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, visitors),
    db.prepare(`SELECT * FROM payments WHERE site_id = ?1 AND id ${IN(2)} ORDER BY occurred_at DESC`).bind(site.id, list(person.paymentIds)),
    db.prepare(`SELECT * FROM subscriptions WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, list(person.subscriptionIds)),
    // A provider's claim names the buyer's order, and whoever's visit it points at may not be that buyer: the id stays out.
    db.prepare(`SELECT session_id, claimed_at, source, CASE WHEN source IS 'provider' THEN NULL ELSE ref END AS ref FROM payment_claims WHERE site_id = ?1 AND session_id IN (${sessionsOf})`).bind(site.id, visitors),
    db.prepare(`SELECT * FROM link_clicks WHERE ref IN (${sessionsOf})`).bind(site.id, visitors),
    db
      .prepare(
        `SELECT id, event_type, status, created_at, last_at, payload FROM webhook_deliveries
         WHERE event_type = 'site.payment' AND json_extract(payload, '$.data.site.id') = ?1 AND json_extract(payload, '$.data.payment.id') ${IN(2)} ORDER BY created_at DESC`,
      )
      .bind(site.id, list(person.paymentIds)),
  ]);

  const visitRows: unknown[] = [];
  while (visitRows.length < EXPORT_MAX_VISITS) {
    const { results } = await db
      .prepare(`SELECT * FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)} ORDER BY started_at DESC, id LIMIT ${EXPORT_PAGE} OFFSET ?3`)
      .bind(site.id, visitors, visitRows.length)
      .all();
    visitRows.push(...results);
    if (results.length < EXPORT_PAGE) break;
  }

  // A payment may be matched to a visit that isn't shown as theirs: that visit stays out of it.
  const ours = new Set(person.visitorIds);
  const payments = (pays?.results ?? []).map((row) => {
    const p = row as Record<string, unknown>;
    return p.visitor_id && !ours.has(String(p.visitor_id)) ? { ...p, visitor_id: null, session_id: null, credited_session_id: null, ref: null } : p;
  });
  const hashed = person.visitorIds.some((v) => /^[0-9a-f]{16}$/.test(v));
  return {
    site: { id: site.id, name: site.name },
    exportedAt: new Date(now * 1000).toISOString(),
    identities: identities?.results ?? [],
    visits: visitRows,
    payments,
    subscriptions: subs?.results ?? [],
    checkoutReferences: claims?.results ?? [],
    checkoutClicks: clicks?.results ?? [],
    webhookDeliveries: deliveries?.results ?? [],
    coverage: {
      included: ["identities", "visits", "payments", "subscriptions", "checkoutReferences", "checkoutClicks", "webhookDeliveries"],
      unprovenLinks: PRIVACY_LINK_KINDS.filter((k) => person.unproven[k].length).map((kind) => ({ kind, visitors: person.unproven[kind].length, included: person.included.includes(kind) })),
      notIncluded: NOT_EXPORTED,
    },
    notes: [
      ...(visitRows.length >= EXPORT_MAX_VISITS ? [`Only the latest ${EXPORT_MAX_VISITS} visits are included.`] : []),
      ...(hashed ? ["On a cookieless site a visitor ID is a daily hash, which people on the same network with the same browser can share: some of these visits may be someone else's."] : []),
      ...(person.otherPayments ? ["Payments matched to these visitors without proof of who paid are not included."] : []),
      "Times are Unix seconds (UTC). Amounts are in minor units (cents) of their currency.",
      "Single page views and events are kept by Cloudflare Analytics Engine for about 90 days, without a name or email; they are not included.",
      "The payment provider keeps its own records of each payment.",
    ],
  };
}

interface EraseOptions {
  /** Write the erasure to the ledger: off when re-applying what is already on it. */
  record?: boolean;
}

/** Removes the person (article 17); payments stay as anonymous amounts. */
export async function erasePerson(env: Env, site: SiteDTO, person: Person, by: string, now = nowSec(), opts: EraseOptions = {}): Promise<PrivacyEraseDTO> {
  const db = env.DB;
  const before = await personCounts(db, site, person);
  const visitors = list(person.visitorIds);
  const payments = list(person.paymentIds);
  const sessionsOf = `SELECT id FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)}`;

  const [keptRows, paid, subscribed, named, linked] = await db.batch<{
    id?: string;
    provider?: string;
    customer_id?: string | null;
    email?: string | null;
    order_ref?: string | null;
    subscription_id?: string | null;
    visitor_id?: string;
    credited?: number;
  }>([
    db.prepare(`SELECT id FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)} AND id IN (SELECT credited_session_id FROM payments WHERE site_id = ?1 AND credited_session_id IS NOT NULL)`).bind(site.id, visitors),
    db.prepare(`SELECT provider, customer_id, lower(email) AS email, order_ref, subscription_id FROM payments WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, payments),
    db.prepare(`SELECT provider, customer_id FROM subscriptions WHERE site_id = ?1 AND id ${IN(2)} AND customer_id IS NOT NULL`).bind(site.id, list(person.subscriptionIds)),
    db.prepare(`SELECT lower(email) AS email FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)} AND trust = 'server' AND email IS NOT NULL`).bind(site.id, visitors),
    // Visits their payments point at that aren't being erased and still belong to a visitor.
    db
      .prepare(
        `SELECT s.id, s.visitor_id, MAX(s.id = p.credited_session_id) AS credited
         FROM payments p JOIN web_sessions s ON s.site_id = p.site_id AND s.id IN (p.session_id, p.credited_session_id)
         WHERE p.site_id = ?1 AND p.id ${IN(2)} AND s.visitor_id NOT ${IN(3)} AND substr(s.visitor_id, 1, ${ERASED_VISITOR_PREFIX.length}) != '${ERASED_VISITOR_PREFIX}'
         GROUP BY s.id`,
      )
      .bind(site.id, payments, visitors),
  ]);
  // Kept visits get a new id: the old one is what Analytics Engine's events carry.
  const newIds = JSON.stringify((keptRows?.results ?? []).map((r) => [r.id, newSessionId()]));
  const outside = linked?.results ?? [];
  const copyIds = JSON.stringify(outside.filter((r) => r.credited).map((r) => [r.id, newSessionId()]));
  // A short-link click turned into a visit for a payment: its visitor is made from the reference.
  const clickVisits = list(outside.filter((r) => r.visitor_id === `lc_${r.id}`).map((r) => r.id!));
  const renamed = (col: string, n: number) => `(SELECT json_extract(value, '$[1]') FROM json_each(?${n}) WHERE json_extract(value, '$[0]') = ${col})`;
  const inRenamed = (col: string, n: number) => `${col} IN (SELECT json_extract(value, '$[0]') FROM json_each(?${n}))`;

  const emails = [...(paid?.results ?? []), ...(named?.results ?? [])].flatMap((r) => (r.email ? [r.email] : []));
  const customers = [...(paid?.results ?? []), ...(subscribed?.results ?? [])].flatMap((r) => (r.provider && r.customer_id ? [customerKey(r.provider, r.customer_id)] : []));
  // Provider ids that stay on the payment, and a claim could tie to a visit.
  const references = new Set([
    ...(paid?.results ?? []).flatMap((r) => [...(r.order_ref ?? "").split(" "), r.subscription_id ?? ""]),
    ...person.subscriptionIds.map((id) => id.slice(id.indexOf(":") + 1)),
  ]);
  references.delete("");
  const claimedRefs = list([...references, ...(paid?.results ?? []).flatMap((r) => (r.customer_id ? [r.customer_id] : []))]);
  const entries: LedgerEntry[] = [
    ...person.visitorIds.map((value) => ({ kind: "visitor" as const, value })),
    ...person.paymentIds.map((value) => ({ kind: "payment" as const, value })),
    ...[...new Set(emails)].map((value) => ({ kind: "email" as const, value })),
    ...[...new Set(customers)].map((value) => ({ kind: "customer" as const, value })),
    ...[...references].map((value) => ({ kind: "reference" as const, value })),
  ];
  const ledger = opts.record === false ? null : await ledgerWrite(env, site.id, entries, now);

  // Path without its #fragment: single-page apps can put ids there.
  const noFragment = (col: string) => `CASE WHEN instr(${col}, '#') > 0 THEN substr(${col}, 1, instr(${col}, '#') - 1) ELSE ${col} END`;
  const stmts = {
    // Checkout references proving which visit a payment came from, and the short-link clicks these visits were made from.
    claims: db.prepare(`DELETE FROM payment_claims WHERE site_id = ?1 AND session_id IN (${sessionsOf})`).bind(site.id, visitors),
    clicks: db.prepare(`DELETE FROM link_clicks WHERE ref IN (${sessionsOf})`).bind(site.id, visitors),
    // The same for their payments, whichever visit those were tied to: the provider's ids stay on the payment.
    paymentClaims: db.prepare(`DELETE FROM payment_claims WHERE site_id = ?1 AND (ref ${IN(2)} OR session_id ${IN(3)})`).bind(site.id, claimedRefs, clickVisits),
    paymentClicks: db.prepare(`DELETE FROM link_clicks WHERE ref ${IN(1)}`).bind(clickVisits),
    // Someone else's payment matched to their visitor: unlinked, to be matched again; nothing of its own removed.
    others: db
      .prepare(
        `UPDATE payments SET session_id = NULL, visitor_id = NULL, credited_session_id = NULL, matched_by = NULL, confidence = NULL, proves_identity = 0, unmatched_reason = NULL, last_match_at = NULL
         WHERE site_id = ?1 AND visitor_id ${IN(2)} AND id NOT ${IN(3)}`,
      )
      .bind(site.id, visitors, payments),
    // Visits a kept payment is credited to stay, so revenue by source still adds up, but belong to nobody.
    anonymize: db
      .prepare(
        `UPDATE web_sessions SET id = ${renamed("web_sessions.id", 2)}, visitor_id = '${ERASED_VISITOR_PREFIX}' || lower(hex(randomblob(9))), region = '', city = '', org = '', timezone = '', language = '', screen = '',
           hostname = '', utm_term = '', utm_content = '', entry_path = ${noFragment("entry_path")}, exit_path = ${noFragment("exit_path")}, return_visit = 0, checkout_at = NULL
         WHERE site_id = ?1 AND ${inRenamed("web_sessions.id", 2)}`,
      )
      .bind(site.id, newIds),
    credit: db
      .prepare(
        `UPDATE payments SET credited_session_id = COALESCE(${renamed("credited_session_id", 2)}, credited_session_id), session_id = COALESCE(${renamed("session_id", 2)}, session_id)
         WHERE site_id = ?1 AND (${inRenamed("credited_session_id", 2)} OR ${inRenamed("session_id", 2)})`,
      )
      .bind(site.id, newIds),
    // Credited to a visit that stays: an anonymous copy takes the credit. It carries what revenue reports group by and
    // only the day, isn't traffic (via), and has no id in common with the visit or with Analytics Engine.
    copies: db
      .prepare(
        `INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at, entry_path, exit_path, referrer_host, source, channel, utm_source, utm_medium, utm_campaign,
           link_domain, link_slug, country, continent, device, os, browser, via)
         SELECT ${renamed("web_sessions.id", 2)}, site_id, '${ERASED_VISITOR_PREFIX}' || lower(hex(randomblob(9))), started_at - started_at % 86400, started_at - started_at % 86400,
           ${noFragment("entry_path")}, ${noFragment("exit_path")}, referrer_host, source, channel, utm_source, utm_medium, utm_campaign,
           link_domain, link_slug, country, continent, device, os, browser, 'erased'
         FROM web_sessions WHERE site_id = ?1 AND ${inRenamed("web_sessions.id", 2)}`,
      )
      .bind(site.id, copyIds),
    recredit: db
      .prepare(`UPDATE payments SET credited_session_id = ${renamed("credited_session_id", 2)} WHERE site_id = ?1 AND id ${IN(3)} AND ${inRenamed("credited_session_id", 2)}`)
      .bind(site.id, copyIds, payments),
    visits: db.prepare(`DELETE FROM web_sessions WHERE site_id = ?1 AND visitor_id ${IN(2)}`).bind(site.id, visitors),
    // Their payments keep pointing only at the visit they are credited to, which is anonymous by now.
    matched: db.prepare(`UPDATE payments SET session_id = credited_session_id WHERE site_id = ?1 AND id ${IN(2)} AND session_id IS NOT credited_session_id`).bind(site.id, payments),
    // A click made into a visit for their payment, unless another payment still counts on it.
    clickVisits: db
      .prepare(
        `DELETE FROM web_sessions WHERE site_id = ?1 AND id ${IN(2)}
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.site_id = ?1 AND (p.session_id = web_sessions.id OR p.credited_session_id = web_sessions.id))`,
      )
      .bind(site.id, clickVisits),
    identities: db.prepare(`DELETE FROM web_visitors WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, visitors),
    payments: clearPaymentsStmt(db, `site_id = ?2 AND id ${IN(3)}`).bind(now, site.id, payments),
    subscriptions: db.prepare(`UPDATE subscriptions SET customer_id = NULL, personal_cleared_at = COALESCE(personal_cleared_at, ?3) WHERE site_id = ?1 AND id ${IN(2)}`).bind(site.id, list(person.subscriptionIds), now),
    // Queued and logged site.payment webhooks carry the email.
    deliveries: db
      .prepare(
        `DELETE FROM webhook_deliveries WHERE event_type = 'site.payment' AND json_extract(payload, '$.data.site.id') = ?1
           AND json_extract(payload, '$.data.payment.id') ${IN(2)}`,
      )
      .bind(site.id, payments),
    log: logStmt(db, site.id, "erase", by, now, before),
  };
  const names = Object.keys(stmts) as (keyof typeof stmts)[];
  const results = await db.batch([...names.map((n) => stmts[n]), ...(ledger?.stmt ? [ledger.stmt] : [])]);
  const changes = (n: keyof typeof stmts) => results[names.indexOf(n)]?.meta.changes ?? 0;
  await ledger?.copy();
  resetSiteCaches();
  const notYours = before.unproven?.filter((u) => !u.included) ?? [];
  const warnings = [
    ...(before.activeSubscriptions
      ? [`${before.activeSubscriptions === 1 ? "A subscription is" : `${before.activeSubscriptions} subscriptions are`} still active: its next renewal arrives from the provider with the customer's details again. Erase them at the provider too.`]
      : []),
    ...(notYours.length ? [`${notYours.reduce((n, u) => n + u.visits, 0)} visits linked only by something a browser could have sent were left alone, and the erased payments no longer point at them. Include them in the request if they are this person's.`] : []),
    ...(person.otherPayments ? [`${person.otherPayments} payments matched to these visitors without proof of who paid keep their details and were unlinked. If they are this person's, erase them by email or payment ID.`] : []),
    "Single page views and events stay in Cloudflare Analytics Engine, under the old visitor and visit IDs but without a name or email, until they expire after about 90 days. The payments and visits kept for this person have new IDs, so they don't join to those events.",
    "Backups made before now still hold this data. After restoring one, use Re-apply erasures in this section.",
    "Emails already sent (payment alerts, digests), site.payment webhooks already delivered to your endpoints, and data at the payment provider are outside Shorthop.",
    "This erased them on this site only: erase them on your other sites too, if they visited those.",
  ];
  return {
    counts: { ...before, anonymizedVisits: changes("anonymize") + changes("copies"), webhookDeliveries: changes("deliveries") },
    warnings,
  };
}

/** Clears a payment's personal details: ?1 is now; `where` binds from ?2. */
function clearPaymentsStmt(db: D1Database, where: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE payments SET email = NULL, customer_id = NULL, ref = NULL, visitor_id = NULL, proves_identity = 0, unmatched_reason = NULL, personal_cleared_at = ?1
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

// ---- After a restore ----------------------------------------------------------------

/** The steps of re-applying erasures: the KV copy, then each table holding people. */
const REAPPLY_STEPS = ["copy", "visitors", "visits", "payments", "subscriptions"] as const;
const KV_PAGE = 20;

function parseCursor(raw: string | null | undefined): { step: number; after: string } {
  try {
    const c = JSON.parse(raw ?? "") as { step?: unknown; after?: unknown };
    if (typeof c.step === "number" && Number.isInteger(c.step) && c.step >= 0 && c.step < REAPPLY_STEPS.length && typeof c.after === "string") return { step: c.step, after: c.after };
  } catch {
    // Starts from the beginning.
  }
  return { step: 0, after: "" };
}

/**
 * Erases again whatever a restore brought back: one page of one table per call, so
 * it fits a Worker's limits on any plan however large the site is. The caller
 * repeats with the returned cursor until done. Rows are compared with the ledger
 * by their keyed hashes; nothing else tells who was erased. A row first stored
 * after the erasure stays: that person came back and gave their details again.
 */
export async function reapplyErasures(env: Env, site: SiteDTO, rawCursor: string | null | undefined, by: string, now = nowSec()): Promise<PrivacyReapplyDTO> {
  const db = env.DB;
  const limit = planLimits(env).reapplyRows;
  const { step, after } = parseCursor(rawCursor);
  const name = REAPPLY_STEPS[step]!;
  const result = (last: string | null, unreadable: number, counts?: PrivacyCountsDTO): PrivacyReapplyDTO => {
    const next = last === null ? step + 1 : step;
    const done = next >= REAPPLY_STEPS.length;
    return {
      done,
      cursor: done ? null : JSON.stringify({ step: next, after: last ?? "" }),
      erased: { identities: counts?.identities ?? 0, visits: counts?.visits ?? 0, payments: counts?.payments ?? 0, subscriptions: counts?.subscriptions ?? 0 },
      unreadable,
    };
  };
  if (name === "copy") return result(await mergeLedgerCopy(env, site.id, after || null, KV_PAGE, now), 0);

  const ledger = await readLedger(env, site.id, now);
  const has = ledger.has;
  const person: Person = { visitorIds: [], paymentIds: [], subscriptionIds: [], unproven: { claimed_email: [], payment_reference: [] }, included: [], otherPayments: 0 };
  /** One page of a table, ordered by id, and the rows on the ledger added to `into`. */
  const scan = async <T extends { id: string }>(sql: string, into: string[], matches: (row: T) => Promise<boolean>): Promise<string | null> => {
    const { results } = await db.prepare(sql).bind(site.id, after, limit).all<T>();
    for (const r of results) if (await matches(r)) into.push(r.id);
    return results.length === limit ? results.at(-1)!.id : null;
  };
  const email = async (v: string | null, since: number) => (v ? has({ kind: "email", value: v.toLowerCase() }, since) : false);
  const customer = async (provider: string, id: string | null, since: number) => (id ? has({ kind: "customer", value: customerKey(provider, id) }, since) : false);
  let last: string | null;
  if (name === "visitors") {
    last = await scan<{ id: string; email: string | null; trust: string; first_seen: number }>(
      "SELECT id, email, trust, first_seen FROM web_visitors WHERE site_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3",
      person.visitorIds,
      async (r) => (await has({ kind: "visitor", value: r.id })) || (r.trust === "server" && (await email(r.email, r.first_seen))),
    );
  } else if (name === "visits") {
    last = await scan<{ id: string }>(
      `SELECT DISTINCT visitor_id AS id FROM web_sessions WHERE site_id = ?1 AND visitor_id > ?2 AND substr(visitor_id, 1, ${ERASED_VISITOR_PREFIX.length}) != '${ERASED_VISITOR_PREFIX}' ORDER BY visitor_id LIMIT ?3`,
      person.visitorIds,
      (r) => has({ kind: "visitor", value: r.id }),
    );
  } else if (name === "payments") {
    last = await scan<{ id: string; provider: string; email: string | null; customer_id: string | null; visitor_id: string | null; proves_identity: number; created_at: number }>(
      "SELECT id, provider, email, customer_id, visitor_id, proves_identity, created_at FROM payments WHERE site_id = ?1 AND id > ?2 AND personal_cleared_at IS NULL ORDER BY id LIMIT ?3",
      person.paymentIds,
      async (r) =>
        (await has({ kind: "payment", value: r.id })) ||
        (await email(r.email, r.created_at)) ||
        (await customer(r.provider, r.customer_id, r.created_at)) ||
        Boolean(r.visitor_id && r.proves_identity && (await has({ kind: "visitor", value: r.visitor_id }, r.created_at))),
    );
  } else {
    last = await scan<{ id: string; provider: string; customer_id: string; started_at: number }>(
      "SELECT id, provider, customer_id, started_at FROM subscriptions WHERE site_id = ?1 AND id > ?2 AND customer_id IS NOT NULL ORDER BY id LIMIT ?3",
      person.subscriptionIds,
      (r) => customer(r.provider, r.customer_id, r.started_at),
    );
  }
  if (!person.visitorIds.length && !person.paymentIds.length && !person.subscriptionIds.length) return result(last, ledger.unreadable);
  const { counts } = await erasePerson(env, site, person, `${by} · re-applied after a restore`, now, { record: false });
  return result(last, ledger.unreadable, counts);
}

// ---- Retention ----------------------------------------------------------------------

const MONTH_SEC = 30 * 86400;
/** The fewest old visits a site is given in a run it takes part in. */
const MIN_VISITS_PER_SITE = 50;
/** A visit retention has already cut down to what revenue by source needs. An erased person's kept visit isn't one yet. */
const REDUCED_VISIT = "via = 'erased' AND entry_path = '' AND exit_path = '' AND country = '' AND started_at % 86400 = 0 AND last_seen_at % 86400 = 0";

/**
 * Daily: on sites with a retention period, payments older than it lose their
 * personal details, ended subscriptions their customer id, identified visitors with
 * nothing newer are forgotten, and visits last seen before it go.
 *
 * A visit a payment is credited to stays, so revenue by source keeps adding up, but
 * only as that: its source, channel, referring host, campaign tags and short link,
 * and the UTC day it began. It belongs to nobody, has no pages or other details and
 * isn't counted as traffic. The others are deleted. Visits are taken a bounded number
 * at a time (`visitLimit` a day across all sites, about seven rows written each), so a
 * long history is worked through over several days. Reading and writing them is one
 * batch each, whatever the number of sites.
 */
export async function pruneCustomerData(db: D1Database, now = nowSec(), visitLimit = FREE.prunedVisits): Promise<number> {
  const prune = pruneLedgerStmt(db, now);
  const { results: all } = await db
    .prepare("SELECT id, customer_retention_months AS months FROM sites WHERE customer_retention_months IS NOT NULL ORDER BY id")
    .all<{ id: string; months: number }>();
  if (!all.length) {
    await prune.run();
    return 0;
  }
  const stmts = all.flatMap(({ id, months }) => {
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
  const results = await db.batch([...stmts, prune]);
  const changed = results.slice(0, stmts.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return changed + (await pruneVisits(db, all, now, visitLimit));
}

/** One day's share of old visits. Sites take turns by day when there are more of them than the limit has room for. */
async function pruneVisits(db: D1Database, sites: { id: string; months: number }[], now: number, limit: number): Promise<number> {
  const perSite = Math.max(MIN_VISITS_PER_SITE, Math.floor(limit / sites.length));
  const turns = Math.max(1, Math.floor(limit / perSite));
  const start = Math.floor(now / 86400) % sites.length;
  const chosen = Array.from({ length: Math.min(turns, sites.length) }, (_, i) => sites[(start + i) % sites.length]!);
  const found = await db.batch<{ id: string }>(
    chosen.map(({ id, months }) =>
      db
        .prepare(`SELECT id FROM web_sessions WHERE site_id = ?1 AND last_seen_at < ?2 AND NOT (${REDUCED_VISIT}) LIMIT ?3`)
        .bind(id, now - months * MONTH_SEC, perSite),
    ),
  );
  const writes = chosen.flatMap(({ id }, i) => {
    const ids = found[i]?.results.map((r) => r.id) ?? [];
    if (!ids.length) return [];
    const batch = list(ids);
    const credited = `id IN (SELECT credited_session_id FROM payments WHERE site_id = ?1 AND credited_session_id IS NOT NULL)`;
    return [
      db.prepare(`DELETE FROM payment_claims WHERE site_id = ?1 AND session_id ${IN(2)}`).bind(id, batch),
      // Credited visits stay as a line in revenue by source, nobody's; old enough that Analytics Engine has dropped their events.
      db
        .prepare(
          `UPDATE web_sessions SET visitor_id = '${ERASED_VISITOR_PREFIX}' || lower(hex(randomblob(9))), via = 'erased',
             started_at = started_at - started_at % 86400, last_seen_at = started_at - started_at % 86400,
             pageviews = 0, goals = 0, engaged_ms = 0, return_visit = 0, checkout_at = NULL,
             entry_path = '', exit_path = '', hostname = '', utm_term = '', utm_content = '',
             country = '', continent = '', region = '', city = '', org = '', timezone = '', language = '', screen = '', device = '', os = '', browser = ''
           WHERE site_id = ?1 AND id ${IN(2)} AND ${credited}`,
        )
        .bind(id, batch),
      db.prepare(`UPDATE payments SET session_id = credited_session_id WHERE site_id = ?1 AND session_id ${IN(2)} AND session_id NOT IN (SELECT credited_session_id FROM payments WHERE site_id = ?1 AND credited_session_id IS NOT NULL)`).bind(id, batch),
      db.prepare(`DELETE FROM web_sessions WHERE site_id = ?1 AND id ${IN(2)} AND NOT (${credited})`).bind(id, batch),
    ];
  });
  if (!writes.length) return 0;
  const results = await db.batch(writes);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

// What the payment checks found: counted per site and kind for System status,
// and logged. Revenue is analytics, so nothing here stops a payment from being
// stored or a webhook from being answered: a failure to count is only logged.

export type AnomalyKind =
  /** A payment or subscription id that already belongs to another site: the write was refused. */
  | "id_conflict"
  /** More refunded than the charge, in its currency: the stored amount was capped. */
  | "refund_capped"
  /** A refund or dispute in another currency than its charge. */
  | "refund_currency"
  /** A partial refund whose size the provider didn't state: stored as 0, so net revenue may be too high. */
  | "refund_unknown"
  /** A refund or dispute with no charge found for it (often one from before the site was connected). */
  | "no_charge"
  /** An exchange rate far from the previous one (stored all the same). */
  | "fx_rate";

/** The kind stored on a payment row (payments.anomaly). */
export type PaymentAnomaly = Extract<AnomalyKind, "refund_capped" | "refund_currency" | "refund_unknown" | "no_charge">;

/** `detail` is a payment id or a currency: never anything about a customer. */
export async function noteAnomaly(db: D1Database, siteId: string, kind: AnomalyKind, detail: string): Promise<void> {
  console.warn(JSON.stringify({ message: "payment anomaly", site: siteId, kind, detail }));
  try {
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `INSERT INTO payment_anomalies (site_id, kind, count, first_at, last_at, detail) VALUES (?1, ?2, 1, ?3, ?3, ?4)
         ON CONFLICT (site_id, kind) DO UPDATE SET count = count + 1, last_at = excluded.last_at, detail = excluded.detail`,
      )
      .bind(siteId, kind, now, detail.slice(0, 200))
      .run();
  } catch (err) {
    console.error(JSON.stringify({ message: "payment anomaly not counted", kind, error: String(err) }));
  }
}

/** A period's payments, refunds and disputes that rest only on an unconfirmed webhook. */
export async function unverifiedCount(db: D1Database, siteId: string, start: number, end: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE site_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND unverified = 1 AND test_mode = 0")
    .bind(siteId, start, end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** How many of each kind, across sites, among those last seen since a time. */
export async function anomalyCounts(db: D1Database, since: number): Promise<Partial<Record<AnomalyKind, number>>> {
  const { results } = await db.prepare("SELECT kind, SUM(count) AS n FROM payment_anomalies WHERE last_at >= ?1 GROUP BY kind").bind(since).all<{ kind: AnomalyKind; n: number }>();
  return Object.fromEntries(results.map((r) => [r.kind, r.n]));
}

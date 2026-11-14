// Currency conversion. Each payment keeps its own amount and currency, plus
// the amount in the site's currency at the reference rate of the payment's
// day (ECB rates through frankfurter.dev, kept in fx_rates). A payment whose
// rate isn't known yet is converted by the daily job once it is. A payment in
// the site's own currency needs no rate. One in a currency the ECB publishes
// no rate for (not in FX_CURRENCIES) can't be converted: it keeps its own
// amount, counts as 0 in the site's totals, and the overview says how many.

import { FX_CURRENCIES, minorFactor } from "../../shared/sites";

const FX_API = "https://api.frankfurter.dev/v1";
/** Weekends and holidays have no rates: the latest earlier day counts. */
const LOOKBACK_DAYS = 7;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

/** Units per 1 EUR on a day (or the latest day before it), null when unknown. */
async function eurRate(db: D1Database, currency: string, date: string, cache?: RateCache): Promise<number | null> {
  if (currency === "EUR") return 1;
  const key = `${currency}|${date}`;
  if (cache?.has(key)) return cache.get(key)!;
  const row = await db
    .prepare("SELECT rate FROM fx_rates WHERE currency = ?1 AND date <= ?2 AND date >= ?3 ORDER BY date DESC LIMIT 1")
    .bind(currency, date, addDays(date, -LOOKBACK_DAYS))
    .first<{ rate: number }>();
  cache?.set(key, row?.rate ?? null);
  return row?.rate ?? null;
}

/** A subscription's price per month, in its own minor units. */
export function monthlyMinor(amountMinor: number, unit: "day" | "week" | "month" | "year", count: number): number {
  const perMonth = { day: 30.44, week: 4.345, month: 1, year: 1 / 12 }[unit] / Math.max(1, count || 1);
  return Math.round(amountMinor * perMonth);
}

/** Rates already looked up during one job, so converting many payments doesn't repeat queries. */
export type RateCache = Map<string, number | null>;

/** An amount in another currency's minor units, or null when a rate is missing. */
export async function convert(db: D1Database, amountMinor: number, from: string, to: string, date: string, cache?: RateCache): Promise<number | null> {
  if (from === to) return amountMinor;
  const [rf, rt] = await Promise.all([eurRate(db, from, date, cache), eurRate(db, to, date, cache)]);
  if (!rf || !rt) return null;
  const major = amountMinor / minorFactor(from);
  return Math.round((major / rf) * rt * minorFactor(to));
}

/**
 * Converts, fetching the day's rates first when they aren't stored yet (a new
 * install, or a currency seen for the first time). A failed fetch leaves the
 * amount for the daily job.
 */
export async function convertNow(db: D1Database, amountMinor: number, from: string, to: string, date: string): Promise<number | null> {
  const first = await convert(db, amountMinor, from, to, date);
  if (first !== null) return first;
  try {
    const today = new Date().toISOString().slice(0, 10);
    await fetchRates(db, date >= today ? "latest" : date);
  } catch (err) {
    console.error(JSON.stringify({ message: "fx rates fetch failed", date, error: String(err) }));
    return null;
  }
  return convert(db, amountMinor, from, to, date);
}

/** Stores the rates of one day ("latest" for today's), returns the day they're for. */
export async function fetchRates(db: D1Database, day: string | "latest"): Promise<string | null> {
  const res = await fetch(`${FX_API}/${day}?base=EUR`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`FX rates ${day}: HTTP ${res.status}`);
  const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
  if (!body.date || !body.rates) return null;
  const stmts = Object.entries(body.rates)
    .filter(([c, r]) => /^[A-Z]{3}$/.test(c) && Number.isFinite(r) && r > 0)
    .map(([c, r]) => db.prepare("INSERT INTO fx_rates (date, currency, rate) VALUES (?1, ?2, ?3) ON CONFLICT (date, currency) DO UPDATE SET rate = excluded.rate").bind(body.date, c, r));
  if (stmts.length) await db.batch(stmts);
  return body.date;
}

/** SQL: the payment (alias `p`, or `a`) of a site (alias `s`) can be converted once rates are in; ?N is FX_CURRENCIES as JSON. */
const convertible = (n: number, a = "p") => `(${a}.currency = s.currency OR (${a}.currency IN (SELECT value FROM json_each(?${n})) AND s.currency IN (SELECT value FROM json_each(?${n}))))`;
const FX_JSON = JSON.stringify(FX_CURRENCIES);

/** Does every one of these currencies have a rate on the day, or in the days before it that count for it? */
async function ratesKnown(db: D1Database, currencies: string[], day: string): Promise<boolean> {
  const needed = currencies.filter((c) => c !== "EUR");
  if (!needed.length) return true;
  const row = await db
    .prepare("SELECT COUNT(DISTINCT currency) AS n FROM fx_rates WHERE date <= ?1 AND date >= ?2 AND currency IN (SELECT value FROM json_each(?3))")
    .bind(day, addDays(day, -LOOKBACK_DAYS), JSON.stringify(needed))
    .first<{ n: number }>();
  return (row?.n ?? 0) >= needed.length;
}

/**
 * The daily job: today's rates, the rates of days that unconverted payments
 * need (a few days per run), then converts what it can. Payments wait in
 * turns (the longest since its last try first), so ones whose rate isn't
 * published yet can't keep the others out of a run; ones that can never be
 * converted aren't tried at all.
 */
export async function refreshFx(db: D1Database, maxDays = 10, siteId?: string, maxPending = 500): Promise<{ converted: number }> {
  try {
    await fetchRates(db, "latest");
  } catch (err) {
    // Payments in the site's own currency, and days whose rates are stored, don't need it.
    console.error(JSON.stringify({ message: "fx rates fetch failed", day: "latest", error: String(err) }));
  }
  const { results: pending } = await db
    .prepare(
      `SELECT p.id, p.amount_minor, p.currency, s.currency AS site_currency, date(p.occurred_at, 'unixepoch') AS day
       FROM payments p JOIN sites s ON s.id = p.site_id
       WHERE p.amount_site_minor IS NULL AND (?1 IS NULL OR p.site_id = ?1) AND ${convertible(3)}
       ORDER BY p.fx_tried_at IS NOT NULL, p.fx_tried_at, p.occurred_at DESC LIMIT ?2`,
    )
    .bind(siteId ?? null, maxPending, FX_JSON)
    .all<{ id: string; amount_minor: number; currency: string; site_currency: string; day: string }>();
  // Each day with the currencies its payments need: a day is fetched when any of them is missing.
  const needs = new Map<string, Set<string>>();
  for (const p of pending) {
    if (p.currency === p.site_currency) continue;
    const set = needs.get(p.day) ?? new Set<string>();
    set.add(p.currency).add(p.site_currency);
    needs.set(p.day, set);
  }
  let fetched = 0;
  for (const [day, currencies] of needs) {
    if (fetched >= maxDays) break;
    if (await ratesKnown(db, [...currencies], day)) continue;
    try {
      await fetchRates(db, day);
    } catch (err) {
      console.error(JSON.stringify({ message: "fx rates fetch failed", day, error: String(err) }));
    }
    fetched++;
  }
  const now = Math.floor(Date.now() / 1000);
  const updates: D1PreparedStatement[] = [];
  const cache: RateCache = new Map();
  let converted = 0;
  for (const p of pending) {
    const amount = await convert(db, p.amount_minor, p.currency, p.site_currency, p.day, cache);
    if (amount !== null) converted++;
    // Still waiting: to the back of the queue.
    updates.push(amount !== null ? db.prepare("UPDATE payments SET amount_site_minor = ?1, fx_tried_at = NULL WHERE id = ?2").bind(amount, p.id) : db.prepare("UPDATE payments SET fx_tried_at = ?1 WHERE id = ?2").bind(now, p.id));
  }
  for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));
  await convertSubscriptions(db, siteId);
  return { converted };
}

/** Monthly values still waiting for a rate (a subscription stored, or a site's currency changed, before it was known). */
async function convertSubscriptions(db: D1Database, siteId?: string, limit = 200): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.amount_minor, b.currency, b.interval_unit, b.interval_count, s.currency AS site_currency
       FROM subscriptions b JOIN sites s ON s.id = b.site_id
       WHERE b.mrr_site_minor IS NULL AND b.amount_minor IS NOT NULL AND b.currency IS NOT NULL AND b.interval_unit IS NOT NULL AND (?1 IS NULL OR b.site_id = ?1)
         -- Ones that can never be converted would keep the rest out of every run.
         AND ${convertible(3, "b")}
       ORDER BY b.updated_at DESC LIMIT ?2`,
    )
    .bind(siteId ?? null, limit, FX_JSON)
    .all<SubscriptionPrice & { site_currency: string }>();
  const updates = await subscriptionUpdates(db, results, (b) => b.site_currency, true);
  for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));
}

interface SubscriptionPrice {
  id: string;
  amount_minor: number;
  currency: string;
  interval_unit: "day" | "week" | "month" | "year";
  interval_count: number;
}

/** Statements that set each subscription's monthly value in a site currency, at today's rate (as when it is stored). */
async function subscriptionUpdates<T extends SubscriptionPrice>(db: D1Database, subs: T[], currencyOf: (s: T) => string, knownOnly: boolean): Promise<D1PreparedStatement[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cache: RateCache = new Map();
  const updates: D1PreparedStatement[] = [];
  for (const b of subs) {
    const mrr = await convert(db, monthlyMinor(b.amount_minor, b.interval_unit, b.interval_count), b.currency, currencyOf(b), today, cache);
    if (mrr === null && knownOnly) continue;
    updates.push(db.prepare("UPDATE subscriptions SET mrr_site_minor = ?1 WHERE id = ?2").bind(mrr, b.id));
  }
  return updates;
}

/**
 * After a site's currency changes: every payment is converted again, and so is
 * each subscription's monthly value (MRR). What has no rate yet is left empty
 * for the daily job, never in the old currency.
 */
export async function reconvertSite(db: D1Database, siteId: string, siteCurrency: string): Promise<void> {
  const { results } = await db
    .prepare("SELECT id, amount_minor, currency, date(occurred_at, 'unixepoch') AS day FROM payments WHERE site_id = ?1")
    .bind(siteId)
    .all<{ id: string; amount_minor: number; currency: string; day: string }>();
  const updates: D1PreparedStatement[] = [];
  const cache: RateCache = new Map();
  for (const p of results) {
    const amount = await convert(db, p.amount_minor, p.currency, siteCurrency, p.day, cache);
    updates.push(db.prepare("UPDATE payments SET amount_site_minor = ?1, fx_tried_at = NULL WHERE id = ?2").bind(amount, p.id));
  }
  const { results: subs } = await db
    .prepare("SELECT id, amount_minor, currency, interval_unit, interval_count FROM subscriptions WHERE site_id = ?1 AND amount_minor IS NOT NULL AND currency IS NOT NULL AND interval_unit IS NOT NULL")
    .bind(siteId)
    .all<SubscriptionPrice>();
  updates.push(...(await subscriptionUpdates(db, subs, () => siteCurrency, false)));
  for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));
}

/** Payments of a period that count as 0 in the site's currency: no exchange rate yet, or none exists for their currency. */
export async function unconvertedCount(db: D1Database, siteId: string, start: number, end: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE site_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND amount_site_minor IS NULL AND kind = 'charge' AND test_mode = 0")
    .bind(siteId, start, end)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

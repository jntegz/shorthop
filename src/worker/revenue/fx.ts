// Currency conversion. Each payment keeps its own amount and currency, plus
// the amount in the site's currency at the reference rate of the payment's
// day (ECB rates through frankfurter.dev, kept in fx_rates). A payment whose
// rate isn't known yet is converted by the daily job once it is.

import { minorFactor } from "../../shared/sites";

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

/**
 * The daily job: today's rates, the rates of days that unconverted payments
 * need (a few days per run), then converts what it can.
 */
export async function refreshFx(db: D1Database, maxDays = 10, siteId?: string, maxPending = 500): Promise<{ converted: number }> {
  await fetchRates(db, "latest");
  const { results: pending } = await db
    .prepare(
      `SELECT p.id, p.amount_minor, p.currency, s.currency AS site_currency, date(p.occurred_at, 'unixepoch') AS day
       FROM payments p JOIN sites s ON s.id = p.site_id
       WHERE p.amount_site_minor IS NULL AND (?1 IS NULL OR p.site_id = ?1) ORDER BY p.occurred_at DESC LIMIT ?2`,
    )
    .bind(siteId ?? null, maxPending)
    .all<{ id: string; amount_minor: number; currency: string; site_currency: string; day: string }>();
  const days = [...new Set(pending.map((p) => p.day))];
  let fetched = 0;
  for (const day of days) {
    if (fetched >= maxDays) break;
    const known = await db.prepare("SELECT 1 FROM fx_rates WHERE date <= ?1 AND date >= ?2 LIMIT 1").bind(day, addDays(day, -LOOKBACK_DAYS)).first();
    if (known) continue;
    try {
      await fetchRates(db, day);
    } catch (err) {
      console.error(JSON.stringify({ message: "fx rates fetch failed", day, error: String(err) }));
    }
    fetched++;
  }
  const updates: D1PreparedStatement[] = [];
  const cache: RateCache = new Map();
  for (const p of pending) {
    const amount = await convert(db, p.amount_minor, p.currency, p.site_currency, p.day, cache);
    if (amount !== null) updates.push(db.prepare("UPDATE payments SET amount_site_minor = ?1 WHERE id = ?2").bind(amount, p.id));
  }
  if (updates.length) await db.batch(updates);
  return { converted: updates.length };
}

/** After a site's currency changes: every payment is converted again. */
export async function reconvertSite(db: D1Database, siteId: string, siteCurrency: string): Promise<void> {
  const { results } = await db
    .prepare("SELECT id, amount_minor, currency, date(occurred_at, 'unixepoch') AS day FROM payments WHERE site_id = ?1")
    .bind(siteId)
    .all<{ id: string; amount_minor: number; currency: string; day: string }>();
  const updates: D1PreparedStatement[] = [];
  const cache: RateCache = new Map();
  for (const p of results) {
    const amount = await convert(db, p.amount_minor, p.currency, siteCurrency, p.day, cache);
    updates.push(db.prepare("UPDATE payments SET amount_site_minor = ?1 WHERE id = ?2").bind(amount, p.id));
  }
  for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));
}

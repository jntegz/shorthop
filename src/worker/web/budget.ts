// The collector's daily D1 budget. Every website event writes D1 rows (a visit,
// its indexes, a visitor, references from a return page), and the collector is
// public: on Workers Free, whose D1 allowance is 100,000 rows written a day for
// the whole account, enough events (real or made up) would use it up, and every
// write after that fails until 00:00 UTC, logins and link edits included. So a
// Free install stops storing events for the rest of the day once they have
// written planLimits().collectRows rows, and keeps the rest of the allowance
// for everything else. Paid has no budget.
//
// What is counted is what D1 reports writing for each event. Counting costs one
// D1 write per FLUSH_ROWS rows: each isolate counts in memory and adds its count
// to one settings row, which tells it the day's total. Isolates that haven't
// flushed yet can go over by a few events each.
//
// The counter must never be the reason a visit is lost: a D1 error lets events
// through, and no single event can be charged more than MAX_EVENT_ROWS, so a
// wrong figure can't spend the day's budget.

import { planLimits } from "../plan";

/** Settings key prefix of each UTC day's count (rows written; the name is from when it counted events). */
export const BUDGET_PREFIX = "collect_events:";
export const FLUSH_ROWS = 60;
/** Charged when D1 reports no figure for an event: what a new visit writes. */
export const DEFAULT_EVENT_ROWS = 5;
/** The most one charge can be. The worst event measured writes 15 rows, its return-page references a few more each. */
export const MAX_EVENT_ROWS = 40;

interface Local {
  day: string;
  /** Rows counted here and not yet added to the day's row. */
  pending: number;
  /** The day's budget is spent: nothing more is stored today. */
  spent: boolean;
  /** The day's row was read once, so a new isolate knows a spent budget at once. */
  read: boolean;
}

let local: Local = { day: "", pending: 0, spent: false, read: false };

/** Tests only. */
export function resetCollectBudget(): void {
  local = { day: "", pending: 0, spent: false, read: false };
}

const dayOf = (now: number) => new Date(now * 1000).toISOString().slice(0, 10);

function today(day: string): void {
  if (local.day !== day) local = { day, pending: 0, spent: false, read: false };
}

/** Whether this event may be stored. D1 errors let it through. */
export async function collectBudgetAllows(env: Env, now: number): Promise<boolean> {
  const budget = planLimits(env).collectRows;
  if (!Number.isFinite(budget)) return true;
  const day = dayOf(now);
  today(day);
  if (local.spent) return false;
  if (local.read) return true;
  local.read = true;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(budgetKey(day)).first<{ value: string }>();
    if (Number(row?.value ?? 0) >= budget) {
      local.spent = true;
      return false;
    }
  } catch (err) {
    console.error(JSON.stringify({ message: "collect budget unavailable", error: String(err) }));
  }
  return true;
}

/** Counts the rows an event wrote. Never throws, and never stops the event it counts. */
export async function chargeCollectBudget(env: Env, now: number, rows: number): Promise<void> {
  const budget = planLimits(env).collectRows;
  if (!Number.isFinite(budget)) return;
  const day = dayOf(now);
  today(day);
  local.pending += Number.isFinite(rows) && rows > 0 ? Math.min(Math.ceil(rows), MAX_EVENT_ROWS) : DEFAULT_EVENT_ROWS;
  if (local.pending < FLUSH_ROWS) return;
  const add = local.pending;
  local.pending = 0;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?1, CAST(?2 AS INTEGER)) ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(?2 AS INTEGER) RETURNING value",
    )
      .bind(budgetKey(day), add)
      .first<{ value: string | number }>();
    if (Number(row?.value ?? 0) >= budget) local.spent = true;
  } catch (err) {
    if (local.day === day) local.pending += add;
    console.error(JSON.stringify({ message: "collect budget unavailable", error: String(err) }));
  }
}

/** The settings key of a day's count ("2026-11-01"); System status reads it with its other settings. */
export const budgetKey = (day: string) => `${BUDGET_PREFIX}${day}`;

/** Daily cleanup: the counts of earlier days, as one statement for a batch. */
export function collectBudgetPruneStmt(db: D1Database, today: string): D1PreparedStatement {
  return db.prepare("DELETE FROM settings WHERE key > ?1 AND key < ?2").bind(BUDGET_PREFIX, budgetKey(today));
}

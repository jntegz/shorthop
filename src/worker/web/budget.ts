// The collector's daily D1 budget. Every website event writes D1 rows (a visit,
// its indexes, a visitor), and the collector is public: on Workers Free, whose
// D1 allowance is 100,000 rows written a day for the whole account, enough
// events (real or made up) would use it up, and every write after that fails
// until 00:00 UTC, logins and link edits included. So a Free install stops
// storing events for the rest of the day at planLimits().collectEvents, and
// keeps the rest of the allowance for everything else. Paid has no budget.
//
// Counting costs one D1 row per FLUSH_EVERY events: each isolate counts in
// memory and adds its count to one settings row, which tells it the day's
// total. Isolates that haven't flushed yet can go over by a few events each.

import { planLimits } from "../plan";

/** Settings key prefix of each UTC day's count. */
export const BUDGET_PREFIX = "collect_events:";
const FLUSH_EVERY = 20;

interface Local {
  day: string;
  /** Events counted here and not yet added to the day's row. */
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

/**
 * Whether this event may be stored, counting it if so. D1 errors let it
 * through: the counter must never be the reason a visit is lost.
 */
export async function collectBudgetAllows(env: Env, now: number): Promise<boolean> {
  const budget = planLimits(env).collectEvents;
  if (!Number.isFinite(budget)) return true;
  const day = dayOf(now);
  if (local.day !== day) local = { day, pending: 0, spent: false, read: false };
  if (local.spent) return false;
  const key = budgetKey(day);
  try {
    if (!local.read) {
      local.read = true;
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
      if (Number(row?.value ?? 0) >= budget) {
        local.spent = true;
        return false;
      }
    }
    local.pending++;
    if (local.pending >= FLUSH_EVERY) {
      const add = local.pending;
      local.pending = 0;
      const row = await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES (?1, CAST(?2 AS INTEGER)) ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + CAST(?2 AS INTEGER) RETURNING value",
      )
        .bind(key, add)
        .first<{ value: string | number }>();
      if (Number(row?.value ?? 0) >= budget) local.spent = true;
    }
  } catch (err) {
    console.error(JSON.stringify({ message: "collect budget unavailable", error: String(err) }));
  }
  return true;
}

/** The settings key of a day's count ("2026-11-01"); System status reads it with its other settings. */
export const budgetKey = (day: string) => `${BUDGET_PREFIX}${day}`;

/** Daily cleanup: the counts of earlier days, as one statement for a batch. */
export function collectBudgetPruneStmt(db: D1Database, today: string): D1PreparedStatement {
  return db.prepare("DELETE FROM settings WHERE key > ?1 AND key < ?2").bind(BUDGET_PREFIX, budgetKey(today));
}

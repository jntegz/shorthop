// Daily totals of website pages, goals and outbound links: Analytics Engine
// (90 days) → D1 (web_daily_events, kept as long as the site), so the
// dashboard's lists still cover periods older than Analytics Engine keeps.
// Like the click rollup, each completed UTC day is replaced atomically, so a
// rerun is always safe; web_last_rolled says how far it got.

import { addDays, dayStartSec, utcDate } from "../../shared/dates";
import { aeAvailable, aeQuery, webDataset } from "../ae";
import { getSetting, jsonChunks, setSettingStmt } from "../db";
import { planLimits } from "../plan";

const LAST_KEY = "web_last_rolled";
/** Analytics Engine keeps about 90 days: older days can't be read any more. */
const AE_RETENTION_DAYS = 89;
const ROWS = 20_000;

const INSERT = `INSERT INTO web_daily_events (site_id, day, kind, name, events, visitors, engaged_ms)
SELECT json_extract(value, '$[0]'), ?1, json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
       json_extract(value, '$[4]'), json_extract(value, '$[5]')
FROM json_each(?2)`;

type Row = [site: string, kind: string, name: string, events: number, visitors: number, engagedMs: number];

/** One day's rows: pageviews by path (with engaged time), then goals, outbound and checkout links by name. */
async function readDay(env: Env, day: string): Promise<Row[]> {
  const from = dayStartSec(day);
  const to = dayStartSec(addDays(day, 1));
  const when = `timestamp >= toDateTime(${from}) AND timestamp < toDateTime(${to})`;
  const [pages, engaged, named] = await Promise.all([
    aeQuery<{ site: string; name: string; events: number | string; visitors: number | string }>(
      env,
      `SELECT index1 AS site, blob2 AS name, sum(_sample_interval) AS events, count(DISTINCT blob17) AS visitors FROM ${webDataset(env)}
       WHERE blob1 = 'pageview' AND ${when} GROUP BY site, name ORDER BY events DESC LIMIT ${ROWS}`,
    ),
    aeQuery<{ site: string; name: string; ms: number | string }>(
      env,
      `SELECT index1 AS site, blob2 AS name, sum(double2 * _sample_interval) AS ms FROM ${webDataset(env)}
       WHERE blob1 = 'engage' AND ${when} GROUP BY site, name ORDER BY ms DESC LIMIT ${ROWS}`,
    ),
    aeQuery<{ site: string; kind: string; name: string; events: number | string; visitors: number | string }>(
      env,
      `SELECT index1 AS site, blob1 AS kind, blob18 AS name, sum(_sample_interval) AS events, count(DISTINCT blob17) AS visitors FROM ${webDataset(env)}
       WHERE blob1 IN ('goal', 'outbound', 'checkout') AND ${when} GROUP BY site, kind, name ORDER BY events DESC LIMIT ${ROWS}`,
    ),
  ]);
  const ms = new Map(engaged.map((r) => [`${r.site}\n${r.name}`, Math.round(Number(r.ms) || 0)]));
  const rows: Row[] = pages.map((r) => [String(r.site), "pageview", String(r.name ?? ""), Number(r.events) || 0, Number(r.visitors) || 0, ms.get(`${r.site}\n${r.name}`) ?? 0]);
  for (const r of named) rows.push([String(r.site), String(r.kind), String(r.name ?? ""), Number(r.events) || 0, Number(r.visitors) || 0, 0]);
  return rows;
}

/** Rolls up the completed days not done yet, as many as the plan allows in one run. Returns the days written. */
export async function rollupWebEvents(env: Env, now = new Date()): Promise<string[]> {
  if (!aeAvailable(env)) return [];
  const today = utcDate(now);
  const yesterday = addDays(today, -1);
  const oldest = addDays(today, -AE_RETENTION_DAYS);
  const last = await getSetting(env.DB, LAST_KEY);
  // Paid goes back as far as Analytics Engine still has; Free starts from yesterday (planLimits).
  const limit = planLimits(env).webRollupDays;
  let day = last ? addDays(last, 1) : limit > 1 ? oldest : yesterday;
  if (day < oldest) day = oldest;
  const done: string[] = [];
  for (let n = 0; day <= yesterday && n < limit; n++, day = addDays(day, 1)) {
    const rows = await readDay(env, day);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM web_daily_events WHERE day = ?").bind(day),
      ...jsonChunks(rows).map((chunk) => env.DB.prepare(INSERT).bind(day, chunk)),
      setSettingStmt(env.DB, LAST_KEY, day),
    ]);
    done.push(day);
  }
  return done;
}

/** The first UTC day Analytics Engine still has; days before it come from web_daily_events. */
export function aeFirstDay(now = new Date()): string {
  return addDays(utcDate(now), -(AE_RETENTION_DAYS - 1));
}

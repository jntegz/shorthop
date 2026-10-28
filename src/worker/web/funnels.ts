// Funnels: how many visitors reach each step, in order, within the funnel's
// window of the first step, and how many of those who finish then pay.
//
// Steps are pages or goals, so they come from Analytics Engine: one query
// returns each visitor's first time on every matching page or goal in the
// period, and the ordering is worked out here. Visitors are counted per
// visitor id (per day on cookieless sites, whose id changes daily).

import { pathMatches, SITE_ID_RE, type FunnelDTO, type FunnelReportDTO, type FunnelStep, type SiteDTO } from "../../shared/sites";
import { aeAvailable, aeQuery, ROW_LIMIT, webDataset } from "../ae";
import { type Window } from "./queries";

export interface FunnelRow {
  id: string;
  site_id: string;
  name: string;
  steps: string;
  window_hours: number;
  created_at: number;
}

export function funnelDTO(r: FunnelRow): FunnelDTO {
  let steps: FunnelStep[] = [];
  try {
    steps = JSON.parse(r.steps) as FunnelStep[];
  } catch {
    // Written by us; stays empty if it somehow isn't JSON.
  }
  return { id: r.id, siteId: r.site_id, name: r.name, steps, windowHours: r.window_hours, createdAt: r.created_at };
}

interface Touch {
  visitor: string;
  /** "p" + path or "g" + goal name. */
  key: string;
  at: number;
}

function matchesStep(t: Touch, step: FunnelStep): boolean {
  return step.type === "goal" ? t.key === `g${step.value}` : t.key.startsWith("p") && pathMatches(t.key.slice(1), step.value);
}

/**
 * Walks each visitor's touches in time order: step 1 at its first match, each
 * later step at its first match after the previous step and within the window.
 * Returns when each visitor reached each step.
 */
export function walkFunnel(touches: Touch[], steps: FunnelStep[], windowSec: number): Map<string, number[]> {
  const byVisitor = new Map<string, Touch[]>();
  for (const t of touches) {
    let list = byVisitor.get(t.visitor);
    if (!list) byVisitor.set(t.visitor, (list = []));
    list.push(t);
  }
  const reached = new Map<string, number[]>();
  for (const [visitor, list] of byVisitor) {
    list.sort((a, b) => a.at - b.at);
    // Try each start, so a visitor who began twice gets the run that goes furthest.
    let best: number[] = [];
    for (const start of list.filter((t) => matchesStep(t, steps[0]!))) {
      const times = [start.at];
      for (let i = 1; i < steps.length; i++) {
        const next = list.find((t) => t.at >= times[i - 1]! && t.at - start.at <= windowSec && matchesStep(t, steps[i]!));
        if (!next) break;
        times.push(next.at);
      }
      if (times.length > best.length) best = times;
      if (best.length === steps.length) break;
    }
    if (best.length) reached.set(visitor, best);
  }
  return reached;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

export async function funnelReport(env: Env, site: SiteDTO, funnel: FunnelDTO, w: Window): Promise<FunnelReportDTO> {
  const empty: FunnelReportDTO = {
    funnel,
    steps: funnel.steps.map((step) => ({ step, visitors: 0, medianSecFromPrevious: null })),
    paid: { visitors: 0, revenue: 0 },
    truncated: false,
    available: aeAvailable(env),
  };
  if (!empty.available) return empty;
  if (!SITE_ID_RE.test(site.id)) throw new Error("Refusing to query an invalid site id");
  const rows = await aeQuery<{ visitor: string; kind: string; path: string; name: string; at: number | string }>(
    env,
    `SELECT blob17 AS visitor, blob1 AS kind, blob2 AS path, blob18 AS name, min(toUnixTimestamp(timestamp)) AS at FROM ${webDataset(env)}
     WHERE index1 = '${site.id}' AND blob1 IN ('pageview', 'goal') AND timestamp >= toDateTime(${Math.floor(w.start)}) AND timestamp < toDateTime(${Math.floor(w.end)})
     GROUP BY visitor, kind, path, name LIMIT ${ROW_LIMIT}`,
  );
  const touches: Touch[] = rows.map((r) => ({ visitor: String(r.visitor), key: r.kind === "goal" ? `g${r.name}` : `p${r.path}`, at: Number(r.at) }));
  const reached = walkFunnel(touches, funnel.steps, funnel.windowHours * 3600);

  const steps = funnel.steps.map((step, i) => {
    const at = [...reached.values()].filter((t) => t.length > i);
    return { step, visitors: at.length, medianSecFromPrevious: i === 0 ? null : median(at.map((t) => t[i]! - t[i - 1]!)) };
  });

  // Finishers who paid afterwards (matched payments of their visitor id).
  const finishers = [...reached.entries()].filter(([, t]) => t.length === funnel.steps.length);
  let paid = { visitors: 0, revenue: 0 };
  if (finishers.length) {
    const { results } = await env.DB.prepare(
      `SELECT p.visitor_id AS visitor, p.occurred_at AS at, COALESCE(p.amount_site_minor, 0) AS amount FROM payments p
       WHERE p.site_id = ?1 AND p.kind = 'charge' AND p.test_mode = 0 AND p.occurred_at >= ?2 AND p.visitor_id IN (SELECT value FROM json_each(?3))`,
    )
      .bind(site.id, w.start, JSON.stringify(finishers.map(([v]) => v)))
      .all<{ visitor: string; at: number; amount: number }>();
    const finishedAt = new Map(finishers.map(([v, t]) => [v, t[t.length - 1]!]));
    const payers = new Set<string>();
    let revenue = 0;
    for (const r of results) {
      if (r.at >= (finishedAt.get(r.visitor) ?? Infinity) - 60) {
        payers.add(r.visitor);
        revenue += r.amount;
      }
    }
    paid = { visitors: payers.size, revenue };
  }
  return { funnel, steps, paid, truncated: rows.length >= ROW_LIMIT, available: true };
}

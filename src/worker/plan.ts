// What one invocation may spend on bulk work, by Workers plan.
//
// Every fetch, KV, D1 or Durable Object call a Worker makes is a subrequest,
// and one invocation (a request, or a cron run with everything its waitUntil
// started) gets 50 of them on Workers Free and 10,000 on Paid. Anything over
// fails with "Too many subrequests" partway through. Bulk paths size their
// pages from here so a Free install never hits that, while Paid installs keep
// the larger pages. WORKERS_PLAN comes from the Wrangler config; anything but
// "paid" is treated as Free, the safe direction.

export interface PlanLimits {
  /** Links one /resync or domain-purge page republishes or deletes: one KV call each. */
  bulkPage: number;
  /** Rows one import request may carry: one KV write each, plus the import's own queries. */
  importRows: number;
  /** Webhook deliveries one request attempts right away after an action; the cron sends the rest. */
  deliveriesNow: number;
  /** Outbound requests one destination-check run may spend (a redirect hop is one). */
  checkBudget: number;
  /** Most destinations one check run looks at. */
  checkLimit: number;
  /** Webhook deliveries one cron run sends before its other work. */
  cronDeliveries: number;
  /** Analytics Engine query sets (about 14 fetches each) one rollup run may make; the rest waits for the next run. */
  rollupCollects: number;
  /** Days of website page and goal totals one 02:30 run copies to D1 (three Analytics Engine queries and a D1 batch each). */
  webRollupDays: number;
  /** Unused uploads removed per cleanup run: one KV delete and one D1 delete each. */
  prunedUploads: number;
  /** KV operations the purge's final sweep of leftover keys may spend. */
  purgeSweep: number;
  /** Days of exchange rates one revenue run may fetch. */
  fxDays: number;
  /** Payments one revenue run converts (up to two rate lookups each). */
  fxPending: number;
  /** Unmatched payments one revenue run tries again (up to about eight D1 calls each). */
  rematchPayments: number;
}

export const PAID: PlanLimits = {
  bulkPage: 200,
  importRows: 100,
  deliveriesNow: 10,
  checkBudget: 40,
  checkLimit: 25,
  cronDeliveries: 6,
  rollupCollects: Number.POSITIVE_INFINITY,
  webRollupDays: 30,
  prunedUploads: 200,
  purgeSweep: 900,
  fxDays: 10,
  fxPending: 500,
  rematchPayments: 300,
};

// Each figure leaves room for the D1 reads and writes around it, so a run
// stays under 50 even with webhooks subscribed and an email to send.
export const FREE: PlanLimits = {
  bulkPage: 40,
  importRows: 20,
  deliveriesNow: 2,
  checkBudget: 20,
  checkLimit: 10,
  cronDeliveries: 2,
  rollupCollects: 2,
  // The run has its invocation to itself: a week of days, so it catches up after a missed run.
  webRollupDays: 7,
  prunedUploads: 15,
  purgeSweep: 40,
  fxDays: 1,
  fxPending: 5,
  rematchPayments: 2,
};

export function isPaidPlan(env: Pick<Env, "WORKERS_PLAN">): boolean {
  return env.WORKERS_PLAN === "paid";
}

export function planLimits(env: Pick<Env, "WORKERS_PLAN">): PlanLimits {
  return isPaidPlan(env) ? PAID : FREE;
}

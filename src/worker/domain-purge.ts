// Removing a short domain's data: its links (KV and D1), rollups and misses.
// SHORT_DOMAINS lives in the Worker config, so taking the domain off the
// Worker is still a config change and a deploy (the admin says so).
//
// Analytics Engine rows can't be deleted, so the purge day is remembered and
// collectFromAE leaves out the domain's AE rows up to it; otherwise the next
// rollup, or the live "today" stats, would bring them back.

import { addDays, utcDate } from "../shared/dates";
import { linkKey } from "../shared/domains";
import { getSetting, jsonChunks, setSettingStmt } from "./db";
import { forgetDomainClears } from "./misses";

const PURGED = "domains_purged";
/** Links removed per call, like /resync: keeps each call well inside per-invocation limits. */
const PAGE = 200;
/** AE keeps ~90 days, so older purges can't be resurrected and are dropped. */
const PURGED_KEEP_DAYS = 92;

/** Domain → the last day whose AE rows are hidden. */
export async function purgedDomains(db: D1Database): Promise<Record<string, string>> {
  try {
    const v = JSON.parse((await getSetting(db, PURGED)) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export interface PurgeResult {
  /** Links removed by this call. */
  deleted: number;
  /** False while links are left: call again. */
  done: boolean;
}

/** Deletes a page of the domain's links; the last call also deletes its stats and misses. */
export async function purgeDomain(env: Env, domain: string, now = new Date()): Promise<PurgeResult> {
  const { results } = await env.DB.prepare("SELECT slug FROM links WHERE domain = ? ORDER BY slug LIMIT ?")
    .bind(domain, PAGE)
    .all<{ slug: string }>();
  const deleted = await deleteLinks(env, results.map((r) => ({ domain, slug: r.slug })));
  if (results.length === PAGE) return { deleted, done: false };

  // KV records without a D1 row (a failed write) would keep redirecting: sweep the prefix too.
  const listed = await env.LINKS.list({ prefix: `${domain}/`, limit: 1000 });
  await Promise.all(listed.keys.map((k) => env.LINKS.delete(k.name)));
  if (!listed.list_complete) return { deleted, done: false };

  const today = utcDate(now);
  const keep = addDays(today, -PURGED_KEEP_DAYS);
  const purged = Object.fromEntries(Object.entries(await purgedDomains(env.DB)).filter(([, day]) => day >= keep));
  purged[domain] = today;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM daily_stats WHERE domain = ?").bind(domain),
    env.DB.prepare("DELETE FROM daily_dims WHERE domain = ?").bind(domain),
    await forgetDomainClears(env.DB, domain),
    setSettingStmt(env.DB, PURGED, JSON.stringify(purged)),
  ]);
  return { deleted, done: true };
}

/** KV first, like the single delete: a leftover KV record would keep redirecting. */
export async function deleteLinks(env: Env, links: { domain: string; slug: string }[]): Promise<number> {
  if (!links.length) return 0;
  await Promise.all(links.map((l) => env.LINKS.delete(linkKey(l.domain, l.slug))));
  await env.DB.batch(
    jsonChunks(links.map((l) => [l.domain, l.slug])).map((chunk) =>
      env.DB.prepare(
        `DELETE FROM links WHERE (domain, slug) IN
         (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1))`,
      ).bind(chunk),
    ),
  );
  return links.length;
}

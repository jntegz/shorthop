// Hourly site alerts, run by the hourly cron (except its 01:00 UTC slot,
// which does the daily maintenance instead):
//
//   spikes  a source that sent at least SPIKE_FACTOR times its usual hourly
//           visits in the last hour (and at least SPIKE_MIN_VISITS): an email
//           to the digest recipient and a site.traffic_spike webhook. The same
//           source isn't reported again for SPIKE_QUIET_SEC.
//   digest  sites with the daily digest on get yesterday's numbers once their
//           local clock reaches the chosen hour (or within the next hours, as
//           long as it takes the hourly slices to come round to the site).

import { escapeHtml } from "../../shared/html";
import { formatMoney, type SiteDTO } from "../../shared/sites";
import { localDate, localMidnight, tzOffsetSec } from "../../shared/tz";
import { adminOrigin } from "../domains";
import { mailerStatus, sendMail, withMailSettings } from "../mailer";
import { isPaidPlan } from "../plan";
import { emitAll } from "../webhooks";
import { breakdown, totals, type Filters } from "./queries";
import { siteDTO, type SiteRow } from "./sites";

export const SPIKE_FACTOR = 4;
export const SPIKE_MIN_VISITS = 20;
const SPIKE_QUIET_SEC = 6 * 3600;
const BASELINE_DAYS = 7;
/** Sites one run looks at. A site with a spike and its digest due costs about 15 subrequests (D1, webhooks, two emails). */
const SITES_PER_RUN = { free: 2, paid: 100 } as const;

const NO_FILTERS: Filters = { sql: "", binds: [], active: false };

export interface Spike {
  source: string;
  channel: string;
  visits: number;
  /** Usual visits per hour over the week before. */
  baseline: number;
}

/** Sources over the threshold in the hour before `now`, not reported in the last few hours. */
export async function findSpikes(db: D1Database, siteId: string, now: number): Promise<Spike[]> {
  const hourAgo = now - 3600;
  const [recent, usual, reported] = await db.batch<Record<string, unknown>>([
    db
      .prepare("SELECT source, MAX(channel) AS channel, COUNT(*) AS n FROM web_sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3 GROUP BY source HAVING n >= ?4")
      .bind(siteId, hourAgo, now, SPIKE_MIN_VISITS),
    db
      .prepare("SELECT source, COUNT(*) AS n FROM web_sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3 GROUP BY source")
      .bind(siteId, hourAgo - BASELINE_DAYS * 86400, hourAgo),
    db.prepare("SELECT DISTINCT source FROM site_spikes WHERE site_id = ?1 AND detected_at > ?2").bind(siteId, now - SPIKE_QUIET_SEC),
  ]);
  const baseline = new Map(((usual?.results ?? []) as { source: string; n: number }[]).map((r) => [r.source, r.n / (BASELINE_DAYS * 24)]));
  const quiet = new Set(((reported?.results ?? []) as { source: string }[]).map((r) => r.source));
  return ((recent?.results ?? []) as { source: string; channel: string; n: number }[])
    .map((r) => ({ source: r.source, channel: r.channel, visits: r.n, baseline: Math.round((baseline.get(r.source) ?? 0) * 10) / 10 }))
    .filter((s) => !quiet.has(s.source) && s.visits >= SPIKE_FACTOR * s.baseline)
    .sort((a, b) => b.visits - a.visits);
}

/** `env` comes with the mail settings applied (once per run). */
async function mail(env: Env, subject: string, text: string, html: string): Promise<void> {
  const { provider, problem } = mailerStatus(env);
  if (provider === "off" || problem) return;
  await sendMail(env, { from: { email: env.DIGEST_FROM, name: "Shorthop" }, to: env.DIGEST_TO, subject, text, html });
}

const siteUrl = (env: Env, site: SiteDTO) => `${adminOrigin(env)}/_admin/sites/${site.id}`;

async function reportSpikes(env: Env, site: SiteDTO, spikes: Spike[], now: number): Promise<void> {
  await env.DB.batch(
    spikes.map((s) => env.DB.prepare("INSERT OR IGNORE INTO site_spikes (site_id, source, detected_at, visits, baseline) VALUES (?1, ?2, ?3, ?4, ?5)").bind(site.id, s.source, now, s.visits, s.baseline)),
  );
  await emitAll(
    env,
    spikes.map((s) => ({
      type: "site.traffic_spike" as const,
      data: { site: { id: site.id, name: site.name }, source: s.source, channel: s.channel, visits_last_hour: s.visits, usual_per_hour: s.baseline, detected_at: new Date(now * 1000).toISOString() },
    })),
  );
  const lines = spikes.map((s) => `${s.source || "Unknown"} (${s.channel}): ${s.visits} visits in the last hour, usually ${s.baseline} an hour.`);
  const top = spikes[0]!;
  await mail(
    env,
    `Traffic spike on ${site.name}: ${top.source || "Unknown"}`,
    `${lines.join("\n")}\n\n${siteUrl(env, site)}`,
    `<p>${lines.map(escapeHtml).join("<br>")}</p><p><a href="${escapeHtml(siteUrl(env, site))}">Open ${escapeHtml(site.name)}</a></p>`,
  );
}

/** Yesterday in the site's time zone: visitors, revenue and the top sources. */
async function sendDailyDigest(env: Env, site: SiteDTO, today: string): Promise<void> {
  const end = localMidnight(today, site.timezone);
  const start = localMidnight(new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10), site.timezone);
  const from = localDate(start, site.timezone);
  const [t, prev, sources] = await Promise.all([
    totals(env.DB, site, start, end, NO_FILTERS),
    totals(env.DB, site, start - 7 * 86400, end - 7 * 86400, NO_FILTERS),
    breakdown(env.DB, site, "source", { from, to: from, start, end, granularity: "hour" }, NO_FILTERS, 5),
  ]);
  const { results: spikes } = await env.DB.prepare("SELECT source, visits FROM site_spikes WHERE site_id = ?1 AND detected_at >= ?2 AND detected_at < ?3 ORDER BY visits DESC")
    .bind(site.id, start, end + 3600)
    .all<{ source: string; visits: number }>();
  const m = (minor: number) => formatMoney(minor, site.currency, { locale: "en-US" });
  const vs = (a: number, b: number) => (b ? ` (${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}% on the same day last week)` : "");
  const lines = [
    `Visitors: ${t.visitors}${vs(t.visitors, prev.visitors)}`,
    `Revenue: ${m(t.revenue)} from ${t.payments} payment${t.payments === 1 ? "" : "s"}${vs(t.revenue, prev.revenue)}`,
    `Conversion: ${(t.conversion * 100).toFixed(1)}%`,
  ];
  const top = sources.filter((r) => r.visitors > 0 || r.revenue > 0).slice(0, 5).map((r) => `${r.value || "Unknown"}: ${r.visitors} visitors${r.revenue ? `, ${m(r.revenue)}` : ""}`);
  const spikeLines = spikes.map((s) => `Spike from ${s.source || "Unknown"}: ${s.visits} visits in an hour`);
  const sections: [string, string[]][] = [["", lines], ["Top sources", top], ["Alerts", spikeLines]];
  const text = sections.filter(([, l]) => l.length).map(([h, l]) => (h ? `${h}\n${l.join("\n")}` : l.join("\n"))).join("\n\n");
  const html = sections
    .filter(([, l]) => l.length)
    .map(([h, l]) => `${h ? `<p><strong>${escapeHtml(h)}</strong></p>` : ""}<p>${l.map(escapeHtml).join("<br>")}</p>`)
    .join("");
  await mail(env, `${site.name} on ${from}: ${t.visitors} visitors, ${m(t.revenue)}`, `${text}\n\n${siteUrl(env, site)}`, `${html}<p><a href="${escapeHtml(siteUrl(env, site))}">Open ${escapeHtml(site.name)}</a></p>`);
}

/** The site's local date and hour at `now`. */
function localClock(site: SiteDTO, now: number): { date: string; hour: number } {
  return { date: localDate(now, site.timezone), hour: new Date((now + tzOffsetSec(site.timezone, now)) * 1000).getUTCHours() };
}

export async function runSiteAlerts(env: Env, now = Math.floor(Date.now() / 1000)): Promise<{ spikes: number; digests: number }> {
  // More sites than one run may look at: each hour takes the next slice.
  const perRun = isPaidPlan(env) ? SITES_PER_RUN.paid : SITES_PER_RUN.free;
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE tracking = 1 AND (spike_alerts = 1 OR daily_digest = 1)").first<{ n: number }>())?.n ?? 0;
  if (!count) return { spikes: 0, digests: 0 };
  const slices = Math.ceil(count / perRun);
  const offset = (Math.floor(now / 3600) % slices) * perRun;
  const lateHours = Math.max(2, slices + 1);
  const { results } = await env.DB.prepare(`SELECT * FROM sites WHERE tracking = 1 AND (spike_alerts = 1 OR daily_digest = 1) ORDER BY id LIMIT ${perRun} OFFSET ${offset}`).all<SiteRow>();
  let spikes = 0;
  let digests = 0;
  let mailEnv: Env | null = null;
  const withMail = async () => (mailEnv ??= await withMailSettings(env));
  for (const row of results) {
    const site = siteDTO(row);
    try {
      if (site.spikeAlerts) {
        const found = await findSpikes(env.DB, site.id, now);
        if (found.length) {
          await reportSpikes(await withMail(), site, found, now);
          spikes += found.length;
        }
      }
      if (site.dailyDigest) {
        const clock = localClock(site, now);
        const due = clock.hour >= site.digestHour && clock.hour < site.digestHour + lateHours;
        if (due && row.digest_sent_on !== clock.date) {
          // Marked first: a send that fails isn't retried every hour.
          await env.DB.prepare("UPDATE sites SET digest_sent_on = ?2 WHERE id = ?1").bind(site.id, clock.date).run();
          await sendDailyDigest(await withMail(), site, clock.date);
          digests++;
        }
      }
    } catch (err) {
      console.error(JSON.stringify({ message: "site alerts failed", site: site.id, error: String(err) }));
    }
  }
  return { spikes, digests };
}

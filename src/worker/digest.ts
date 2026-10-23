// Weekly digest: built from D1 rollups only (after a rollup catch-up), sent
// to the one address in DIGEST_TO through the provider in mailer.ts.

import { APP_NAME } from "../shared/brand";
import { addDays, isoWeek, utcDate } from "../shared/dates";
import { linkLabel } from "../shared/domains";
import { escapeHtml } from "../shared/html";
import { isCheckProblem, problemText } from "../shared/link-check";
import { isProbePath } from "../shared/slug";
import { getSetting, setSettingStmt } from "./db";
import { domainsOf } from "./domains";
import { MailerError, mailerStatus, sendMail, withMailSettings } from "./mailer";
import { runRollup } from "./rollup";
import { missesCleared } from "./misses";

export interface DigestData {
  week: string;
  from: string;
  to: string;
  totals: { clicks: number; uniques: number; bots: number };
  previous: { clicks: number; uniques: number; bots: number };
  topLinks: { domain: string; slug: string; target: string | null; clicks: number; previous: number }[];
  countries: { value: string; clicks: number }[];
  sources: { value: string; clicks: number }[];
  newLinks: { domain: string; slug: string; target: string }[];
  misses: { domain: string; slug: string; hits: number }[];
  /** Live links whose destination failed its checks (Link health). */
  notWorking: { domain: string; slug: string; target: string; problem: string }[];
}

type Num = number | null;

/** The digest covers the 7 complete UTC days before `now`. */
export async function digestData(env: Env, now: Date = new Date()): Promise<DigestData> {
  const to = addDays(utcDate(now), -1);
  const from = addDays(to, -6);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -6);
  const db = env.DB;
  const cleared = await missesCleared(db);
  const missFrom = cleared.all !== null && cleared.all >= from ? addDays(cleared.all, 1) : from;
  const sumTotals = `SELECT SUM(clicks) AS clicks, SUM(uniques) AS uniques, SUM(bots) AS bots FROM daily_dims
                     WHERE dim = 'total' AND date BETWEEN ?1 AND ?2`;
  const [cur, prev, top, countries, sources, newLinks, misses, notWorking] = await db.batch<Record<string, string | Num>>([
    db.prepare(sumTotals).bind(from, to),
    db.prepare(sumTotals).bind(prevFrom, prevTo),
    db
      .prepare(
        `SELECT d.domain, d.slug, l.target, SUM(CASE WHEN d.date >= ?1 THEN d.clicks ELSE 0 END) AS clicks,
                SUM(CASE WHEN d.date < ?1 THEN d.clicks ELSE 0 END) AS previous
         FROM daily_dims d LEFT JOIN links l ON l.domain = d.domain AND l.slug = d.slug
         WHERE d.dim = 'total' AND d.date BETWEEN ?3 AND ?2
         GROUP BY d.domain, d.slug HAVING clicks > 0 ORDER BY clicks DESC LIMIT 10`,
      )
      .bind(from, to, prevFrom),
    db
      .prepare(
        `SELECT country AS value, SUM(clicks) AS clicks FROM daily_stats WHERE date BETWEEN ?1 AND ?2
         GROUP BY country HAVING clicks > 0 ORDER BY clicks DESC LIMIT 5`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT source AS value, SUM(clicks) AS clicks FROM daily_stats WHERE date BETWEEN ?1 AND ?2
         GROUP BY source HAVING clicks > 0 ORDER BY clicks DESC LIMIT 5`,
      )
      .bind(from, to),
    db
      .prepare("SELECT domain, slug, target FROM links WHERE created_at >= ?1 AND created_at < ?2 ORDER BY created_at DESC LIMIT 20")
      .bind(Date.parse(`${from}T00:00:00Z`) / 1000, Date.parse(`${addDays(to, 1)}T00:00:00Z`) / 1000),
    db
      .prepare(
        `SELECT d.domain, d.slug, SUM(d.clicks) AS hits FROM daily_dims d
         LEFT JOIN json_each(?3) c ON c.key = d.domain || '/' || d.slug
         WHERE d.dim = 'miss' AND d.date BETWEEN ?1 AND ?2 AND (c.value IS NULL OR d.date > c.value)
         GROUP BY d.domain, d.slug HAVING hits > 0 ORDER BY hits DESC LIMIT 50`,
      )
      .bind(missFrom, to, JSON.stringify(cleared.links)),
    db.prepare(
      `SELECT l.domain, l.slug, l.target, c.problem, c.http_status FROM target_checks c JOIN links l ON l.target = c.target
       WHERE c.status = 'down' AND l.active = 1 AND l.broken = 0 AND l.monitor = 1 ORDER BY c.since, l.domain, l.slug LIMIT 10`,
    ),
  ]);
  const t = (r: Record<string, string | Num> | undefined) => ({
    clicks: Number(r?.clicks ?? 0),
    uniques: Number(r?.uniques ?? 0),
    bots: Number(r?.bots ?? 0),
  });
  return {
    week: isoWeek(to),
    from,
    to,
    totals: t(cur?.results[0]),
    previous: t(prev?.results[0]),
    topLinks: (top?.results ?? []).map((r) => ({
      domain: String(r.domain),
      slug: String(r.slug),
      target: r.target === null ? null : String(r.target),
      clicks: Number(r.clicks),
      previous: Number(r.previous),
    })),
    countries: (countries?.results ?? []).map((r) => ({ value: String(r.value ?? ""), clicks: Number(r.clicks) })),
    sources: (sources?.results ?? []).map((r) => ({ value: String(r.value ?? ""), clicks: Number(r.clicks) })),
    newLinks: (newLinks?.results ?? []).map((r) => ({ domain: String(r.domain), slug: String(r.slug), target: String(r.target) })),
    misses: (misses?.results ?? [])
      .map((r) => ({ domain: String(r.domain), slug: String(r.slug), hits: Number(r.hits) }))
      .filter((m) => !isProbePath(m.slug))
      .slice(0, 5),
    notWorking: (notWorking?.results ?? []).map((r) => ({
      domain: String(r.domain),
      slug: String(r.slug),
      target: String(r.target),
      problem: problemText(isCheckProblem(r.problem) ? r.problem : null, r.http_status === null ? null : Number(r.http_status)),
    })),
  };
}

function delta(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "±0" : "new";
  const pct = Math.round(((cur - prev) / prev) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** `origin` is where the admin lives (the admin host); links on `primary` are shown as "/slug", others as "domain/slug". */
export function renderDigest(
  d: DigestData,
  origin: string,
  primary: string,
): { subject: string; html: string; text: string } {
  const subject = `${primary} weekly: ${fmt(d.totals.clicks)} clicks (${delta(d.totals.clicks, d.previous.clicks)})`;
  const adminUrl = `${origin}/_admin/`;
  const label = (l: { domain: string; slug: string }) => linkLabel(l.domain, l.slug, primary);

  const text = [
    `${APP_NAME} · ${primary} — week ${d.week} (${d.from} to ${d.to}, UTC)`,
    "",
    `Clicks: ${fmt(d.totals.clicks)} (${delta(d.totals.clicks, d.previous.clicks)} vs previous week)`,
    `Daily uniques (sum): ${fmt(d.totals.uniques)}`,
    `Bots and previews: ${fmt(d.totals.bots)}`,
    "",
    "Top links:",
    ...(d.topLinks.length
      ? d.topLinks.map((l, i) => `${i + 1}. ${label(l)} — ${fmt(l.clicks)} (${delta(l.clicks, l.previous)})`)
      : ["(no clicks)"]),
    "",
    `Top countries: ${d.countries.map((c) => `${c.value || "Unknown"} ${fmt(c.clicks)}`).join(", ") || "—"}`,
    `Top sources: ${d.sources.map((s) => `${s.value || "direct"} ${fmt(s.clicks)}`).join(", ") || "—"}`,
    "",
    `New links: ${d.newLinks.length ? d.newLinks.map(label).join(", ") : "none"}`,
    d.misses.length ? `Most-hit missing slugs: ${d.misses.map((m) => `${label(m)} (${fmt(m.hits)})`).join(", ")}` : "",
    d.notWorking.length ? `Destinations not working: ${d.notWorking.map((n) => `${label(n)} (${n.problem})`).join(", ")}` : "",
    "",
    `Dashboard: ${adminUrl}`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");

  const row = (cells: string[], bold = false) =>
    `<tr>${cells.map((c, i) => `<td style="padding:6px 8px;border-bottom:1px solid #e7e5e4;${i > 0 ? "text-align:right;" : ""}${bold ? "font-weight:600;" : ""}">${c}</td>`).join("")}</tr>`;

  const stat = (label: string, value: string, note = "") =>
    `<td style="padding:12px;border:1px solid #e7e5e4;border-radius:8px;width:33%;vertical-align:top;">
       <div style="font-size:12px;color:#57534e;">${label}</div>
       <div style="font-size:22px;font-weight:700;margin-top:4px;">${value}</div>
       ${note ? `<div style="font-size:12px;color:#57534e;">${note}</div>` : ""}
     </td>`;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#fafaf9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1917;">
<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:24px;">
  <div style="color:#6554c0;font-weight:700;font-size:14px;">${APP_NAME} · ${escapeHtml(primary)}</div>
  <h1 style="font-size:20px;margin:8px 0 4px;">Week ${escapeHtml(d.week)}</h1>
  <div style="color:#57534e;font-size:13px;margin-bottom:16px;">${escapeHtml(d.from)} to ${escapeHtml(d.to)} (UTC)</div>
  <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin:0 -8px 20px;"><tr>
    ${stat("Clicks", fmt(d.totals.clicks), `${delta(d.totals.clicks, d.previous.clicks)} vs last week`)}
    ${stat("Daily uniques", fmt(d.totals.uniques))}
    ${stat("Bots &amp; previews", fmt(d.totals.bots))}
  </tr></table>
  <h2 style="font-size:15px;margin:0 0 8px;">Top links</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
    ${row(["Link", "Clicks", "Change"], true)}
    ${
      d.topLinks.length
        ? d.topLinks
            .map((l) =>
              row([
                `<a href="${escapeHtml(adminUrl)}links/${encodeURIComponent(l.domain)}/${encodeURIComponent(l.slug)}" style="color:#6554c0;text-decoration:none;">${escapeHtml(label(l))}</a>`,
                fmt(l.clicks),
                delta(l.clicks, l.previous),
              ]),
            )
            .join("")
        : row(["No clicks this week", "", ""])
    }
  </table>
  <table role="presentation" style="width:100%;font-size:14px;margin-bottom:20px;"><tr>
    <td style="vertical-align:top;width:50%;padding-right:8px;"><strong>Countries</strong><br>${
      d.countries.map((c) => `${escapeHtml(c.value || "Unknown")} · ${fmt(c.clicks)}`).join("<br>") || "—"
    }</td>
    <td style="vertical-align:top;width:50%;"><strong>Sources</strong><br>${
      d.sources.map((s) => `${escapeHtml(s.value || "direct")} · ${fmt(s.clicks)}`).join("<br>") || "—"
    }</td>
  </tr></table>
  <p style="font-size:14px;margin:0 0 8px;"><strong>New links:</strong> ${
    d.newLinks.length ? d.newLinks.map((l) => escapeHtml(label(l))).join(", ") : "none"
  }</p>
  ${
    d.misses.length
      ? `<p style="font-size:14px;margin:0 0 8px;"><strong>Most-hit missing slugs:</strong> ${d.misses
          .map((m) => `${escapeHtml(label(m))} (${fmt(m.hits)})`)
          .join(", ")}</p>`
      : ""
  }
  ${
    d.notWorking.length
      ? `<p style="font-size:14px;margin:0 0 8px;"><strong>Destinations not working:</strong> ${d.notWorking
          .map((n) => `<a href="${escapeHtml(adminUrl)}health" style="color:#6554c0;text-decoration:none;">${escapeHtml(label(n))}</a> (${escapeHtml(n.problem)})`)
          .join(", ")}</p>`
      : ""
  }
  <p style="margin:20px 0 0;"><a href="${escapeHtml(adminUrl)}" style="display:inline-block;background:#6554c0;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;">Open dashboard</a></p>
</div></body></html>`;

  return { subject, html, text };
}

export interface DigestResult {
  status: "sent" | "skipped" | "failed";
  week: string;
  messageId?: string;
  reason?: string;
}

/** Sends the digest. Scheduled runs send once per ISO week; `force` is for test sends. */
export async function runDigest(baseEnv: Env, now: Date = new Date(), force = false): Promise<DigestResult> {
  const env = await withMailSettings(baseEnv);
  const week = isoWeek(addDays(utcDate(now), -1));
  const { provider, problem } = mailerStatus(env);
  if (provider === "off") return { status: "skipped", week, reason: problem ?? "Digest is turned off" };
  if (problem) {
    console.error(JSON.stringify({ message: "digest not configured", week, provider, problem }));
    return { status: "failed", week, reason: problem };
  }
  if (!force && (await getSetting(env.DB, "last_digest_week")) === week) {
    return { status: "skipped", week, reason: "Already sent this week" };
  }
  try {
    await runRollup(env, now);
  } catch (err) {
    console.error(JSON.stringify({ message: "rollup before digest failed", error: String(err) }));
  }
  const { subject, html, text } = renderDigest(await digestData(env, now), `https://${domainsOf(env).admin}`, domainsOf(env).primary);
  try {
    const result = await sendMail(env, {
      from: { email: env.DIGEST_FROM, name: APP_NAME },
      to: env.DIGEST_TO,
      subject,
      html,
      text,
    });
    console.log(JSON.stringify({ message: "digest sent", week, provider, messageId: result.messageId }));
    if (!force) {
      // The email went out: a failed marker write must not report it as failed.
      await setSettingStmt(env.DB, "last_digest_week", week)
        .run()
        .catch((err: unknown) => console.error(JSON.stringify({ message: "digest week not saved", week, error: String(err) })));
    }
    return { status: "sent", week, messageId: result.messageId };
  } catch (err) {
    const code = err instanceof MailerError ? err.code : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(JSON.stringify({ message: "digest send failed", week, provider, error: code }));
    return { status: "failed", week, reason: code };
  }
}

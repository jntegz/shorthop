// New payments, announced: a site.payment webhook for every endpoint
// subscribed to it, and (with "Email me about each payment") a short note to
// the digest recipient with the amount and where the customer came from.
// Sent after the provider's webhook has been answered; a mail or webhook
// problem never fails it.

import { escapeHtml } from "../../shared/html";
import { formatMoney, minorFactor, type SiteDTO } from "../../shared/sites";
import { adminOrigin } from "../domains";
import { mailerStatus, sendMail, withMailSettings } from "../mailer";
import { emitAll, type Background } from "../webhooks";

interface Row {
  id: string;
  provider: string;
  kind: string;
  billing: string;
  occurred_at: number;
  amount_minor: number;
  currency: string;
  amount_site_minor: number | null;
  email: string | null;
  test_mode: number;
  matched_by: string | null;
  confidence: string | null;
  channel: string | null;
  source: string | null;
  campaign: string | null;
  link: string | null;
  landing: string | null;
  country: string | null;
  device: string | null;
  visits: number | null;
  first_seen: number | null;
  first_source: string | null;
}

const KIND_LABEL: Record<string, string> = { refund: "Refund", dispute: "Dispute", dispute_won: "Dispute won" };

function kindLabel(r: Row): string {
  return KIND_LABEL[r.kind] ?? (r.billing === "sub_renewal" ? "Renewal" : r.billing === "sub_new" ? "New subscription" : "Payment");
}

const major = (minor: number, currency: string) => minor / minorFactor(currency);

/** The webhook body of one payment. */
function paymentPayload(site: SiteDTO, r: Row): Record<string, unknown> {
  return {
    site: { id: site.id, name: site.name },
    payment: {
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      billing: r.billing,
      amount: major(r.amount_minor, r.currency),
      currency: r.currency,
      amount_site: r.amount_site_minor === null ? null : major(r.amount_site_minor, site.currency),
      site_currency: site.currency,
      email: r.email,
      occurred_at: new Date(r.occurred_at * 1000).toISOString(),
      test: r.test_mode === 1,
    },
    credited: r.channel
      ? { channel: r.channel, source: r.source, campaign: r.campaign || null, short_link: r.link, landing_page: r.landing, country: r.country || null, device: r.device || null }
      : null,
    match: r.matched_by ? { by: r.matched_by, confidence: r.confidence } : null,
    journey: r.visits ? { visits: r.visits, first_seen_at: r.first_seen ? new Date(r.first_seen * 1000).toISOString() : null, first_source: r.first_source } : null,
  };
}

export async function announcePayments(baseEnv: Env, site: SiteDTO, ids: string[], ctx?: Background): Promise<void> {
  if (!ids.length) return;
  try {
    const { results } = await baseEnv.DB.prepare(
      `SELECT p.id, p.provider, p.kind, p.billing, p.occurred_at, p.amount_minor, p.currency, p.amount_site_minor, p.email, p.test_mode,
         p.matched_by, p.confidence, s.channel, s.source, s.utm_campaign AS campaign,
         CASE WHEN s.link_slug = '' THEN NULL ELSE s.link_domain || '/' || s.link_slug END AS link, s.entry_path AS landing, s.country, s.device,
         (SELECT COUNT(*) FROM web_sessions v WHERE v.site_id = p.site_id AND v.visitor_id = p.visitor_id AND v.started_at <= p.occurred_at) AS visits,
         (SELECT MIN(v.started_at) FROM web_sessions v WHERE v.site_id = p.site_id AND v.visitor_id = p.visitor_id) AS first_seen,
         (SELECT v.source FROM web_sessions v WHERE v.site_id = p.site_id AND v.visitor_id = p.visitor_id ORDER BY v.started_at LIMIT 1) AS first_source
       FROM payments p LEFT JOIN web_sessions s ON s.id = p.credited_session_id
       WHERE p.id IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})`,
    )
      .bind(...ids)
      .all<Row>();
    await emitAll(baseEnv, results.map((r) => ({ type: "site.payment" as const, data: paymentPayload(site, r) })), { ctx });
    if (site.notifyPayments) await emailPayments(baseEnv, site, results.filter((r) => r.kind === "charge" && r.test_mode === 0));
  } catch (err) {
    console.error(JSON.stringify({ message: "payment notification failed", site: site.id, error: String(err) }));
  }
}

async function emailPayments(baseEnv: Env, site: SiteDTO, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const env = await withMailSettings(baseEnv);
  const { provider, problem } = mailerStatus(env);
  if (provider === "off" || problem) return;
  for (const r of rows) {
    const amount = formatMoney(r.amount_minor, r.currency, { locale: "en-US" });
    const from = r.link ? `short link ${r.link}` : r.source ? `${r.source} (${r.channel})` : "an unmatched visit";
    const kind = kindLabel(r);
    const subject = `${kind}: ${amount} on ${site.name}`;
    const url = `${adminOrigin(env)}/_admin/sites/${site.id}`;
    const lines = [`${kind} of ${amount} via ${r.provider}${r.email ? ` from ${r.email}` : ""}.`, `Credited to: ${from}${r.campaign ? `, campaign ${r.campaign}` : ""}.`];
    if (r.visits && r.first_source && r.first_source !== r.source) lines.push(`First found you through ${r.first_source}, ${r.visits} visit${r.visits === 1 ? "" : "s"} before paying.`);
    else if (r.visits) lines.push(`${r.visits} visit${r.visits === 1 ? "" : "s"} before paying.`);
    await sendMail(env, {
      from: { email: env.DIGEST_FROM, name: "Shorthop" },
      to: env.DIGEST_TO,
      subject,
      text: `${lines.join("\n")}\n\n${url}`,
      html: `<p>${lines.map(escapeHtml).join("<br>")}</p><p><a href="${escapeHtml(url)}">Open ${escapeHtml(site.name)}</a></p>`,
    });
  }
}

// Shared statistics pages: a read-only view of one link's stats at
// /_share/<id>.<secret>, for people without an admin account. Server-rendered
// with no script and a strict CSP; nothing about the destination is shown.
// Only a SHA-256 of the secret is checked against, an optional password is a
// link-style PBKDF2 hash with the same limits as protected links, and every
// share can expire or be revoked.

import { escapeHtml } from "../shared/html";
import { sourceLabel } from "../shared/labels";
import { LINK_ACCESS_HOURS } from "../shared/protection";
import { SHARE_RANGES, type BreakdownRow, type LinkStatsDTO, type RecentHit, type SeriesPoint, type ShareDTO, type ShareRange } from "../shared/types";
import { aeAvailable, queryRecent } from "./ae";
import { getLink, nowSec } from "./db";
import { domainsOf, isDevHost } from "./domains";
import { checkPasswordForm, equal, hmac } from "./link-password";
import { HSTS } from "./pages";
import { publicLimit } from "./redirect";
import { linkStats } from "./stats-data";
import { randomToken, sha256Hex } from "./users";
import { decryptSecret } from "./webhooks";

export const SHARE_PREFIX = "/_share/";
/** Active shares one link may have at once. */
export const MAX_SHARES_PER_LINK = 20;
/** How long a share's numbers are reused before Analytics Engine is asked again. */
const CACHE_SEC = 300;
const COOKIE = "sh_share";

export interface ShareRow {
  id: string;
  domain: string;
  slug: string;
  secret_hash: string;
  secret_enc: string;
  password_hash: string | null;
  expires_at: number | null;
  range_limit: ShareRange | null;
  show_recent: number;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  views: number;
  last_viewed_at: number | null;
}

export function shareStatus(row: ShareRow, now = nowSec()): ShareDTO["status"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  return "active";
}

/** Where shares live: the admin host (Access covers only /_admin there), or the dev origin. */
export function shareOrigin(env: Env, req: Request): string {
  const url = new URL(req.url);
  return isDevHost(url.hostname) ? url.origin : `https://${domainsOf(env).admin}`;
}

export function newShareSecret(): string {
  return randomToken(24);
}

export async function shareToDTO(env: Env, row: ShareRow, origin: string): Promise<ShareDTO> {
  const secret = await decryptSecret(env, row.secret_enc).catch(() => null);
  return {
    id: row.id,
    url: secret ? `${origin}${SHARE_PREFIX}${row.id}.${secret}` : null,
    status: shareStatus(row),
    expiresAt: row.expires_at,
    protected: row.password_hash !== null,
    rangeLimit: row.range_limit,
    showRecent: row.show_recent === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    views: row.views,
    lastViewedAt: row.last_viewed_at,
  };
}

// ---- The public page ------------------------------------------------------

const BASE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  // The secret is in the address: never pass it on.
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": HSTS,
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...BASE_HEADERS, ...extra } });
}

/** "abc12345.secret" → its parts; null when the path can't be a share. */
export function parseSharePath(path: string): { id: string; secret: string } | null {
  const m = /^\/_share\/([a-z0-9]{8})\.([A-Za-z0-9_-]{16,64})\/?$/.exec(path);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

function cookieSig(env: Env, row: ShareRow, exp: number): Promise<string> {
  // Covers the password hash, so a new password ends every remembered access.
  return hmac(env.SESSION_SECRET, `share-access|${row.id}|${row.password_hash}|${exp}`);
}

async function accessCookie(env: Env, row: ShareRow, path: string): Promise<string> {
  const now = nowSec();
  let maxAge = LINK_ACCESS_HOURS * 3600;
  if (row.expires_at !== null) maxAge = Math.max(1, Math.min(maxAge, row.expires_at - now));
  const exp = now + maxAge;
  return `${COOKIE}=${exp}.${await cookieSig(env, row, exp)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

async function hasAccess(request: Request, env: Env, row: ShareRow): Promise<boolean> {
  for (const part of (request.headers.get("Cookie") ?? "").split(/;\s*/)) {
    if (!part.startsWith(`${COOKIE}=`)) continue;
    const [expText, sig] = part.slice(COOKIE.length + 1).split(".");
    const exp = Number(expText);
    if (!sig || !Number.isInteger(exp) || exp * 1000 < Date.now()) continue;
    const expected = await cookieSig(env, row, exp);
    if (equal(new TextEncoder().encode(sig), new TextEncoder().encode(expected))) return true;
  }
  return false;
}

const notFound = () => html(card("Not found", "This page doesn't exist", "Check the address you were given."), 404);
const ended = () => html(card("Share ended", "This statistics page is no longer shared", "Ask the person who sent it for a new link."), 410);

/** /_share/<id>.<secret> on the admin host: GET shows the page, POST takes the password. */
export async function serveShare(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  }
  const limited = await publicLimit(request, env);
  if (limited) return limited;
  const parts = parseSharePath(url.pathname);
  if (!parts) return notFound();

  const row = await env.DB.prepare("SELECT * FROM stat_shares WHERE id = ?").bind(parts.id).first<ShareRow>();
  // Same answer for an unknown id and a wrong secret.
  if (!row || !equal(new TextEncoder().encode(await sha256Hex(parts.secret)), new TextEncoder().encode(row.secret_hash))) return notFound();
  if (shareStatus(row) !== "active") return ended();
  const link = await getLink(env.DB, row.domain, row.slug);
  if (!link) return ended();

  if (row.password_hash) {
    if (!env.SESSION_SECRET) return html(card("Try again", "This page is unavailable", "Please try again later."), 503);
    if (request.method === "POST") {
      const attempt = await checkPasswordForm(request, env, { limitKey: `share:${row.id}`, lockKey: `share:${row.id}`, hash: row.password_hash });
      if (attempt.ok) {
        const path = url.pathname;
        // A meta refresh rather than a 303, for the same reason as protected links (protection-pages.ts).
        return html(card("Unlocked", "Unlocked", "Opening the statistics.", { refresh: path }), 200, { "Set-Cookie": await accessCookie(env, row, path) });
      }
      if (attempt.reason === "limited") return html(passwordCard("Too many tries. Wait a minute, then try again."), 429, { "Retry-After": "60" });
      return html(passwordCard(attempt.reason === "wrong" ? "That password isn't right. Check it and try again." : "Something went wrong. Try again."), 401);
    }
    if (!(await hasAccess(request, env, row))) return html(passwordCard(null), 200);
  } else if (request.method === "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const allowed = allowedRanges(row.range_limit);
  const asked = url.searchParams.get("range") as ShareRange | null;
  const range: ShareRange = asked && allowed.includes(asked) ? asked : allowed.includes("30d") ? "30d" : allowed[allowed.length - 1]!;

  const [stats, recent] = await Promise.all([cachedStats(env, ctx, row, range), row.show_recent ? recentHits(env, row) : Promise.resolve(null)]);
  ctx.waitUntil(
    env.DB.prepare("UPDATE stat_shares SET views = views + 1, last_viewed_at = ? WHERE id = ?")
      .bind(nowSec(), row.id)
      .run()
      .catch((err: unknown) => console.error(JSON.stringify({ message: "share view count failed", error: String(err) }))),
  );
  const label = `${row.domain}/${row.slug}`;
  const askedTheme = url.searchParams.get("theme") as ShareTheme | null;
  const theme: ShareTheme = askedTheme && SHARE_THEMES.includes(askedTheme) ? askedTheme : "auto";
  return html(renderStats({ label, title: link.title, stats, recent, range, allowed, expiresAt: row.expires_at, theme }), 200);
}

export function allowedRanges(limit: ShareRange | null): ShareRange[] {
  if (!limit) return [...SHARE_RANGES];
  return SHARE_RANGES.slice(0, SHARE_RANGES.indexOf(limit) + 1);
}

/** Viewers can't make every refresh an Analytics Engine query: the numbers are reused for a few minutes. */
async function cachedStats(env: Env, ctx: ExecutionContext, row: ShareRow, range: ShareRange): Promise<LinkStatsDTO> {
  const key = new Request(`https://share-cache.invalid/${row.id}/${range}`);
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) return (await hit.json()) as LinkStatsDTO;
  }
  const stats = await linkStats(env, row.domain, row.slug, { range });
  if (cache) {
    const res = new Response(JSON.stringify(stats), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SEC}` } });
    ctx.waitUntil(cache.put(key, res).catch(() => undefined));
  }
  return stats;
}

async function recentHits(env: Env, row: ShareRow): Promise<RecentHit[]> {
  if (!aeAvailable(env)) return [];
  try {
    const rows = await queryRecent(env, Date.now() / 1000 - 7 * 86400, { domain: row.domain, slug: row.slug, event: "click" }, 20);
    // No visitor ids, and no bots: people only.
    return rows.map(({ visitor: _visitor, ...r }) => ({ ...r, scanner: false }) as RecentHit);
  } catch (err) {
    console.error(JSON.stringify({ message: "share recent hits failed", error: String(err) }));
    return [];
  }
}

// ---- Rendering --------------------------------------------------------------

const RANGE_LABEL: Record<ShareRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "365d": "12 months", all: "All time" };

const DARK = "--bg:#14151c; --fg:#e9eaf2; --muted:#9a9fb3; --accent:#9d8ff0; --soft:#2a2740; --card:#1c1d27; --line:#2c2e3b; --good:#5cc79c; --bad:#f08591; color-scheme: dark;";

const STYLE = `
  :root { --bg:#f8f9fc; --fg:#222438; --muted:#656b80; --accent:#6554c0; --soft:#efedfb; --card:#fff; --line:#e6e8ef; --good:#23765a; --bad:#b93845; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK} } }
  :root[data-theme="dark"] { ${DARK} }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width:1040px; margin:0 auto; padding:24px 16px 48px; }
  .mark { font-weight:700; color:var(--accent); font-size:13px; }
  h1 { font-size:22px; margin:6px 0 2px; letter-spacing:-0.01em; word-break:break-all; }
  h2 { font-size:14px; margin:0 0 10px; }
  .sub { color:var(--muted); margin:0 0 16px; font-size:14px; }
  .ranges { display:flex; flex-wrap:wrap; gap:4px; margin:0 0 16px; padding:4px; background:var(--card); border:1px solid var(--line); border-radius:10px; width:max-content; max-width:100%; }
  .ranges a { padding:6px 12px; border-radius:7px; color:var(--muted); text-decoration:none; font-size:13px; font-weight:600; }
  .ranges a[aria-current] { background:var(--soft); color:var(--accent); }
  .toolbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:8px; margin:0 0 16px; }
  .toolbar .ranges { margin:0; }
  .themes { font-size:12px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; min-width:0; }
  .tile .k { font-size:13px; color:var(--muted); }
  .tile .v { font-size:26px; font-weight:700; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; }
  .chg { font-size:12px; font-weight:600; }
  .up { color:var(--good); } .down { color:var(--bad); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px; margin-top:12px; }
  .row { position:relative; display:flex; justify-content:space-between; gap:8px; padding:5px 8px; font-size:13px; border-radius:6px; overflow:hidden; }
  .row .bar { position:absolute; inset:0 auto 0 0; background:var(--soft); z-index:0; }
  .row span { position:relative; z-index:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .n { font-variant-numeric:tabular-nums; color:var(--muted); flex-shrink:0; }
  .empty { color:var(--muted); font-size:13px; }
  svg { display:block; width:100%; height:auto; }
  .legend { display:flex; gap:16px; font-size:12px; color:var(--muted); margin-top:6px; }
  .sw { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:var(--muted); font-weight:500; padding:6px 4px; }
  td { border-top:1px solid var(--line); padding:6px 4px; }
  .scroll { overflow-x:auto; }
  .foot { color:var(--muted); font-size:12px; margin-top:20px; }
  .solo { min-height:100vh; display:grid; place-items:center; padding:24px 16px; }
  .solo .card { max-width:420px; width:100%; padding:32px; }
  form { display:grid; gap:10px; }
  label { font-size:14px; font-weight:600; }
  input { font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--bg); color:var(--fg); }
  button { font:inherit; font-weight:600; border:0; border-radius:10px; padding:11px 16px; background:var(--accent); color:#fff; cursor:pointer; }
  .err { color:var(--bad); background:color-mix(in srgb, var(--bad) 12%, transparent); border-radius:10px; padding:10px 12px; margin:0 0 12px; }
`;

export const SHARE_THEMES = ["auto", "light", "dark"] as const;
export type ShareTheme = (typeof SHARE_THEMES)[number];

function doc(title: string, body: string, head = "", theme: ShareTheme = "auto"): string {
  return `<!doctype html>
<html lang="en"${theme === "auto" ? "" : ` data-theme="${theme}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>${head}
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

function card(title: string, heading: string, message: string, opts: { refresh?: string } = {}): string {
  const head = opts.refresh ? `\n<meta http-equiv="refresh" content="0; url=${escapeHtml(opts.refresh)}">` : "";
  return doc(title, `<div class="solo"><div class="card"><div class="mark">Shared statistics</div><h1>${escapeHtml(heading)}</h1><p class="sub">${escapeHtml(message)}</p></div></div>`, head);
}

function passwordCard(error: string | null): string {
  return doc(
    "Password required",
    `<div class="solo"><div class="card"><div class="mark">Shared statistics</div><h1>Password required</h1>
<p class="sub">Enter the password you were given to see these statistics.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">View statistics</button></form>
</div></div>`,
  );
}

const fmt = (n: number) => n.toLocaleString("en");

function change(now: number, before: number): string {
  if (before <= 0) return "";
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return `<span class="chg">no change</span>`;
  return `<span class="chg ${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%</span>`;
}

let regionNames: Intl.DisplayNames | null = null;
let languageNames: Intl.DisplayNames | null = null;
try {
  regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  languageNames = new Intl.DisplayNames(["en"], { type: "language" });
} catch {
  // Codes are shown as they are.
}

function country(code: string): string {
  if (!code || code === "XX") return "🌐 Unknown";
  if (code === "T1") return "🌐 Tor network";
  const flag = /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🌐";
  let name = code;
  try {
    name = regionNames?.of(code) ?? code;
  } catch {
    // keep the code
  }
  return `${flag} ${name}`;
}

function language(tag: string): string {
  if (!tag) return "Not sent";
  try {
    return languageNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

type Kind = "country" | "source" | "referrer" | "device" | "language" | "plain";

function labelOf(kind: Kind, value: string): string {
  if (kind === "country") return country(value);
  if (kind === "source") return sourceLabel(value || "direct");
  if (kind === "referrer") return value || "No referrer";
  if (kind === "device") return value ? value[0]!.toUpperCase() + value.slice(1) : "Unknown";
  if (kind === "language") return language(value);
  return value || "Unknown";
}

function breakdown(title: string, rows: BreakdownRow[], kind: Kind): string {
  const people = rows.filter((r) => r.clicks > 0).slice(0, 10);
  const max = Math.max(1, ...people.map((r) => r.clicks));
  const body = people.length
    ? people
        .map(
          (r) =>
            `<div class="row"><i class="bar" style="width:${((r.clicks / max) * 100).toFixed(1)}%"></i><span>${escapeHtml(labelOf(kind, r.value))}</span><span class="n">${fmt(r.clicks)}</span></div>`,
        )
        .join("")
    : `<p class="empty">No clicks in this period.</p>`;
  return `<section class="card"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** Clicks and daily visitors per day as an inline SVG area chart, with the previous period dashed. */
function chart(series: SeriesPoint[], previous: SeriesPoint[] | undefined): string {
  if (!series.length) return `<p class="empty">No data in this period.</p>`;
  const W = 960;
  const H = 220;
  const pad = { l: 36, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...series.map((p) => p.clicks), ...(previous ?? []).map((p) => p.clicks));
  const step = series.length > 1 ? (W - pad.l - pad.r) / (series.length - 1) : 0;
  const x = (i: number) => pad.l + i * step;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const line = (pts: SeriesPoint[], key: "clicks" | "uniques") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const clicks = line(series, "clicks");
  const area = `${clicks} L${x(series.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const ticks = [0, Math.round(max / 2), max]
    .map((v) => `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(v)}</text><line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`)
    .join("");
  const labelEvery = Math.max(1, Math.ceil(series.length / 8));
  const dates = series
    .map((p, i) => (i % labelEvery === 0 || i === series.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--muted)">${escapeHtml(p.date.slice(5))}</text>` : ""))
    .join("");
  const prev = previous?.length ? `<path d="${line(previous.slice(-series.length), "clicks")}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 4"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Clicks per day">${ticks}${prev}<path d="${area}" fill="var(--soft)"/><path d="${clicks}" fill="none" stroke="var(--accent)" stroke-width="2"/><path d="${line(series, "uniques")}" fill="none" stroke="var(--good)" stroke-width="1.5"/>${dates}</svg>
<div class="legend"><span><i class="sw" style="background:var(--accent)"></i>Clicks</span><span><i class="sw" style="background:var(--good)"></i>Daily visitors</span>${prev ? `<span><i class="sw" style="background:var(--muted)"></i>Previous period</span>` : ""}</div>`;
}

function renderStats(p: {
  label: string;
  title: string | null;
  stats: LinkStatsDTO;
  recent: RecentHit[] | null;
  range: ShareRange;
  allowed: ShareRange[];
  expiresAt: number | null;
  theme: ShareTheme;
}): string {
  const { stats: s } = p;
  const cmp = s.comparison;
  const tiles = [
    { k: "Clicks", v: s.totals.clicks, prev: cmp?.previous.clicks, cur: cmp?.current.clicks },
    { k: "Daily visitors", v: s.totals.uniques, prev: cmp?.previous.uniques, cur: cmp?.current.uniques },
  ]
    .map((t) => `<div class="card tile"><div class="k">${t.k}</div><div class="v">${fmt(t.v)}</div>${t.prev !== undefined && t.cur !== undefined ? change(t.cur, t.prev) : ""}</div>`)
    .join("");
  const href = (range: ShareRange, theme: ShareTheme) => `?range=${range}${theme === "auto" ? "" : `&amp;theme=${theme}`}`;
  const ranges = p.allowed.map((r) => `<a href="${href(r, p.theme)}"${r === p.range ? ' aria-current="page"' : ""}>${RANGE_LABEL[r]}</a>`).join("");
  const themes = SHARE_THEMES.map((t) => `<a href="${href(p.range, t)}"${t === p.theme ? ' aria-current="page"' : ""}>${t === "auto" ? "Automatic" : t === "light" ? "Light" : "Dark"}</a>`).join("");
  const recent = p.recent
    ? `<section class="card" style="margin-top:12px"><h2>Recent clicks</h2>${
        p.recent.length
          ? `<div class="scroll"><table><thead><tr><th>Time (UTC)</th><th>Location</th><th>Device</th><th>Source</th></tr></thead><tbody>${p.recent
              .map(
                (h) =>
                  `<tr><td>${escapeHtml(h.time.replace("T", " ").slice(0, 16))}</td><td>${escapeHtml(`${h.city ? `${h.city}, ` : ""}${country(h.country)}`)}</td><td>${escapeHtml(`${h.device} · ${h.os} · ${h.browser}`)}</td><td>${escapeHtml(sourceLabel(h.source || "direct"))}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : `<p class="empty">No clicks in the last 7 days.</p>`
      }</section>`
    : "";
  const until = p.expiresAt ? ` · shared until ${new Date(p.expiresAt * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC` : "";
  return doc(
    `${p.label} · Statistics`,
    `<div class="wrap">
<div class="mark">Shared statistics</div>
<h1>${escapeHtml(p.label)}</h1>
<p class="sub">${p.title ? `${escapeHtml(p.title)} · ` : ""}${escapeHtml(s.from)} to ${escapeHtml(s.to)} (UTC)${escapeHtml(until)}</p>
<div class="toolbar"><nav class="ranges" aria-label="Period">${ranges}</nav><nav class="ranges themes" aria-label="Theme">${themes}</nav></div>
<div class="tiles">${tiles}</div>
<section class="card">${chart(s.series, cmp?.series)}</section>
<div class="grid">
${breakdown("Countries", s.dims.country, "country")}
${breakdown("Cities", s.dims.city, "plain")}
${breakdown("Sources", s.dims.source, "source")}
${breakdown("Referrers", s.dims.referrer, "referrer")}
${breakdown("Devices", s.dims.device, "device")}
${breakdown("Operating systems", s.dims.os, "plain")}
${breakdown("Browsers", s.dims.browser, "plain")}
${breakdown("Languages", s.dims.language, "language")}
</div>
${recent}
<p class="foot">People only: bots and link previews aren't counted. Daily visitors are counted per day without cookies. Numbers update every few minutes.</p>
</div>`,
    "",
    p.theme,
  );
}

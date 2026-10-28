// Small HTML pages rendered by the Worker (never served as static files, so
// they can't shadow a slug).

import { APP_NAME } from "../shared/brand";
import { escapeHtml } from "../shared/html";
import { TURNSTILE_ORIGIN } from "./turnstile";

/** `body` is inserted as HTML: callers escape anything that isn't markup. */
function page(title: string, heading: string, body: string, link: { href: string; label: string }): string {
  return shell(
    title,
    `<h1>${escapeHtml(heading)}</h1>
  <p>${body}</p>
  <a class="btn" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`,
  );
}

function shell(title: string, main: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>${head}
<style>
  :root { --bg:#f8f9fc; --fg:#222438; --muted:#656b80; --accent:#6554c0; --card:#fff; --line:#e6e8ef; color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--fg);
         font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 440px; width:100%; background:var(--card); border:1px solid var(--line); border-radius:24px; padding:40px; box-shadow:0 12px 40px #22243808; }
  .mark { font-weight:700; letter-spacing:-0.01em; color:var(--accent); font-size:14px; }
  h1 { font-size:22px; margin:12px 0 8px; letter-spacing:-0.01em; }
  p { margin:0 0 20px; color:var(--muted); }
  a.btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; padding:10px 16px; border-radius:10px; font-weight:600; }
  a.btn:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  form { display:grid; gap:12px; margin:0; }
  label { font-size:14px; font-weight:600; }
  input { font:inherit; width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:#fff; color:var(--fg); }
  input[readonly] { background:var(--bg); color:var(--muted); }
  input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  button { font:inherit; font-weight:600; border:0; border-radius:10px; padding:11px 16px; background:var(--accent); color:#fff; cursor:pointer; margin-top:4px; }
  button:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
  .err { color:#b93845; background:#fff0f1; border-radius:10px; padding:10px 12px; margin:0 0 16px; }
  .alt { margin:16px 0 0; font-size:14px; }
  .alt a { color:var(--accent); }
  .ok { color:#23765a; background:#edf8f2; border-radius:10px; padding:10px 12px; margin:0 0 16px; }
  .cf-turnstile { min-height:65px; }
</style>
</head>
<body>
<main>
  <div class="mark">${APP_NAME}</div>
  ${main}
</main>
</body>
</html>`;
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, max-age=0",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function forbiddenPage(reason: string): Response {
  const html = page(
    `Access denied · ${APP_NAME}`,
    "Access denied",
    `This area is private. ${escapeHtml(reason)}`,
    { href: "/", label: "Back" },
  );
  return new Response(html, { status: 403, headers: PAGE_HEADERS });
}

// The login form posts to itself; same-origin Referer/Origin keep the CSRF
// check working in browsers without Sec-Fetch-Site.
const LOGIN_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** The site key when the optional Turnstile bot check is on. */
export type TurnstileWidget = { siteKey: string } | null | undefined;

/** Turnstile needs its script and frame from Cloudflare; every other page keeps no scripts at all. */
function loginHeaders(turnstile: TurnstileWidget, extra: Record<string, string> = {}): Record<string, string> {
  if (!turnstile) return { ...LOGIN_HEADERS, ...extra };
  return {
    ...LOGIN_HEADERS,
    "Content-Security-Policy": `default-src 'none'; script-src ${TURNSTILE_ORIGIN}; frame-src ${TURNSTILE_ORIGIN}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    ...extra,
  };
}

function widget(turnstile: TurnstileWidget): string {
  return turnstile ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstile.siteKey)}" data-theme="light"></div>` : "";
}

function widgetScript(turnstile: TurnstileWidget): string {
  return turnstile ? `\n<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>` : "";
}

export function loginPage(opts: {
  next: string;
  email: string;
  /** ADMIN_AUTH is "password": no Access account to show, and no self-service reset (the owner's password is a secret). */
  passwordOnly?: boolean;
  error?: string;
  status: number;
  retryAfter?: number;
  turnstile?: TurnstileWidget;
}): Response {
  const intro = opts.passwordOnly ? "Enter the admin password to continue." : "Signed in with Cloudflare Access. This password is the second lock.";
  const account = opts.passwordOnly
    ? ""
    : `<label for="username">Access account</label>
    <input id="username" name="username" type="email" value="${escapeHtml(opts.email)}" autocomplete="username" readonly>
    `;
  const html = shell(
    `Log in · ${APP_NAME}`,
    `<h1>${opts.passwordOnly ? "Enter your admin password" : "Enter your password"}</h1>
  <p>${intro}</p>
  ${opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : ""}
  <form method="post" action="/_admin/login">
    <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
    ${account}<label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required autofocus>
    ${widget(opts.turnstile)}
    <button type="submit">Log in</button>
  </form>${opts.passwordOnly ? "" : `\n  <p class="alt"><a href="/_admin/forgot">Forgot your password?</a></p>`}`,
    widgetScript(opts.turnstile),
  );
  const retry: Record<string, string> = opts.retryAfter ? { "Retry-After": String(Math.max(1, Math.ceil(opts.retryAfter))) } : {};
  return new Response(html, { status: opts.status, headers: loginHeaders(opts.turnstile, retry) });
}

/**
 * Choosing a password from a one-time link (the path holds the token): an
 * invite for someone new, or a reset after "Forgot your password?".
 */
export function choosePasswordPage(opts: {
  kind: "invite" | "reset";
  action: string;
  email: string;
  minLength: number;
  error?: string;
  status: number;
  turnstile?: TurnstileWidget;
}): Response {
  const [heading, intro, button] =
    opts.kind === "invite"
      ? ["Choose your password", `You were invited to ${APP_NAME}. Signed in with Cloudflare Access; this password is the second lock.`, "Save and continue"]
      : ["Choose a new password", "Your old password stops working once you save this one, and your other sessions end.", "Save and log in"];
  const html = shell(
    `${heading} · ${APP_NAME}`,
    `<h1>${heading}</h1>
  <p>${intro} Use at least ${opts.minLength} characters.</p>
  ${opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : ""}
  <form method="post" action="${escapeHtml(opts.action)}">
    <label for="username">Access account</label>
    <input id="username" name="username" type="email" value="${escapeHtml(opts.email)}" autocomplete="username" readonly>
    <label for="password">New password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="${opts.minLength}" maxlength="1024" required autofocus>
    <label for="confirm">Repeat it</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${opts.minLength}" maxlength="1024" required>
    ${widget(opts.turnstile)}
    <button type="submit">${button}</button>
  </form>`,
    widgetScript(opts.turnstile),
  );
  return new Response(html, { status: opts.status, headers: loginHeaders(opts.turnstile) });
}

/**
 * "Forgot your password?". email: a reset link is emailed to their Access
 * address; admin: email can't reach them, so an admin is told; none: no email
 * works, so it only says who to ask.
 */
export function forgotPage(opts: {
  mode: "email" | "admin" | "none";
  email: string;
  error?: string;
  done?: string;
  status: number;
  retryAfter?: number;
  turnstile?: TurnstileWidget;
}): Response {
  const back = `<p class="alt"><a href="/_admin/login">Back to log in</a></p>`;
  const form = (intro: string, button: string) => `<p>${intro}</p>
  ${opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : ""}
  <form method="post" action="/_admin/forgot">
    <label for="username">Access account</label>
    <input id="username" name="username" type="email" value="${escapeHtml(opts.email)}" autocomplete="username" readonly>
    ${widget(opts.turnstile)}
    <button type="submit">${button}</button>
  </form>`;
  const body = opts.done
    ? `<p class="ok" role="status">${escapeHtml(opts.done)}</p>`
    : opts.mode === "email"
      ? form("We'll email a link to choose a new password to the address below. It works once, for 1 hour. Your current password keeps working until you use it.", "Email me a reset link")
      : opts.mode === "admin"
        ? form("Email can't reach you from here, so an admin or manager resets it for you. We'll let them know; they send you a new link.", "Ask an admin to reset it")
        : `<p>Ask an admin or manager to reset it: in Settings → Access &amp; security → People, your ⋯ menu → Reset password. They send you a new link where you choose a new password.</p>`;
  const html = shell(`Forgot password · ${APP_NAME}`, `<h1>Forgot your password?</h1>\n  ${body}\n  ${back}`, opts.done ? "" : widgetScript(opts.turnstile));
  const retry: Record<string, string> = opts.retryAfter ? { "Retry-After": String(Math.max(1, Math.ceil(opts.retryAfter))) } : {};
  return new Response(html, { status: opts.status, headers: loginHeaders(opts.done ? null : opts.turnstile, retry) });
}

/** Turning the bot check on: it must pass here first, with the saved site key and the secret. */
export function botCheckPage(opts: { siteKey: string; error?: string; status: number }): Response {
  const turnstile = { siteKey: opts.siteKey };
  const html = shell(
    `Test the bot check · ${APP_NAME}`,
    `<h1>Test the bot check</h1>
  <p>Complete the check below. If Cloudflare confirms it with your secret, the bot check turns on for the password pages. If it doesn't, nothing changes.</p>
  ${opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : ""}
  <form method="post" action="/_admin/bot-check">
    ${widget(turnstile)}
    <button type="submit">Test and turn on</button>
  </form>
  <p class="alt"><a href="/_admin/settings#bot-check">Back to Settings</a></p>`,
    widgetScript(turnstile),
  );
  return new Response(html, { status: opts.status, headers: loginHeaders(turnstile) });
}

/** A short message on the login pages' headers (no form). */
export function noticePage(title: string, heading: string, body: string, status: number): Response {
  const html = page(`${title} · ${APP_NAME}`, heading, escapeHtml(body), { href: "/cdn-cgi/access/logout", label: "Sign out" });
  return new Response(html, { status, headers: LOGIN_HEADERS });
}

/**
 * Reloads `href` from this origin. A SameSite=Strict cookie isn't sent on a
 * navigation that started on another site (the Access login, an email link);
 * the reload is same-site, so an existing session is picked up.
 */
export function bouncePage(href: string): Response {
  const html = shell(
    `Continue · ${APP_NAME}`,
    `<h1>One moment…</h1>
  <p><a class="btn" href="${escapeHtml(href)}">Continue</a></p>`,
    `\n<meta http-equiv="refresh" content="0;url=${escapeHtml(href)}">`,
  );
  return new Response(html, { status: 200, headers: LOGIN_HEADERS });
}

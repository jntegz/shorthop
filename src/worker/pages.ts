// Small HTML pages rendered by the Worker (never served as static files, so
// they can't shadow a slug).

import { APP_NAME } from "../shared/brand";
import { escapeHtml } from "../shared/html";

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
  "Strict-Transport-Security": "max-age=31536000",
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
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export function loginPage(opts: {
  next: string;
  email: string;
  /** ADMIN_AUTH is "password": no Access account to show. */
  passwordOnly?: boolean;
  error?: string;
  status: number;
  retryAfter?: number;
}): Response {
  const intro = opts.passwordOnly ? "Enter the admin password to continue." : "Signed in with Cloudflare Access. This password is the second lock.";
  const account = opts.passwordOnly
    ? ""
    : `<label for="username">Access account</label>
    <input id="username" name="username" type="email" value="${escapeHtml(opts.email)}" autocomplete="username" readonly>
    `;
  const html = shell(
    `Log in · ${APP_NAME}`,
    `<h1>Enter your admin password</h1>
  <p>${intro}</p>
  ${opts.error ? `<p class="err" role="alert">${escapeHtml(opts.error)}</p>` : ""}
  <form method="post" action="/_admin/login">
    <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
    ${account}<label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required autofocus>
    <button type="submit">Log in</button>
  </form>`,
  );
  const headers: Record<string, string> = { ...LOGIN_HEADERS };
  if (opts.retryAfter) headers["Retry-After"] = String(Math.max(1, Math.ceil(opts.retryAfter)));
  return new Response(html, { status: opts.status, headers });
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

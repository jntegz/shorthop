// Serves the admin SPA shell for /_admin and every client-side route under it,
// after the same Access check the API uses.

import { verifyAdmin } from "./auth";
import { forbiddenPage, noticePage } from "./pages";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Recharts and Radix set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  // https: for social-preview images that live on the destination's site.
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export async function serveAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  // Real bundles are served by the asset store; a miss here is a stale or bad URL.
  if (url.pathname.startsWith("/_admin/assets/")) return new Response("Not found", { status: 404 });

  const auth = await verifyAdmin(request, env);
  if (!auth.ok) {
    if (auth.code === "login_required") {
      const next = encodeURIComponent(`${url.pathname}${url.search}`);
      return new Response(null, { status: 303, headers: { Location: `/_admin/login?next=${next}`, "Cache-Control": "no-store" } });
    }
    if (auth.code === "paused") return noticePage("Access paused", "Your access is paused", auth.reason, 403);
    return forbiddenPage(auth.reason);
  }

  const asset = await env.ASSETS.fetch(new URL("/_admin/index.html", url));
  const res = new Response(asset.body, asset);
  const h = res.headers;
  // Vite's dev server injects inline scripts, so CSP applies to production builds only.
  if (!import.meta.env.DEV) h.set("Content-Security-Policy", CSP);
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  // same-origin (not no-referrer) so form posts such as Log out carry a real Origin.
  h.set("Referrer-Policy", "same-origin");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  h.set("X-Robots-Tag", "noindex");
  return res;
}

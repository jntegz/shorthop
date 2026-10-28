// GET /_t/script.js: the tracker (src/tracker/tracker.js), from any short
// domain or the admin host. Public, cached for an hour, readable cross-origin.

import tracker from "../../tracker/tracker.js?raw";

export const SCRIPT_PATH = "/_t/script.js";

let etag: Promise<string> | null = null;

function tagOf(text: string): Promise<string> {
  etag ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then((d) => {
    const bytes = new Uint8Array(d).slice(0, 8);
    return `"${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  });
  return etag;
}

export async function serveScript(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const tag = await tagOf(tracker);
  const headers = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    ETag: tag,
  };
  if (request.headers.get("If-None-Match") === tag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : tracker, { headers });
}

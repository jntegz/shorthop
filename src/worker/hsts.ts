// Strict-Transport-Security, set once on every response (src/worker/index.ts).
// After one HTTPS visit, browsers never ask over plain HTTP, where a redirect
// could be altered.
//
// HSTS (a Wrangler var) chooses its reach:
//   "host" (default)  this host only: always safe.
//   "subdomains"      its subdomains too. Only for a domain whose every
//                     subdomain serves HTTPS: browsers remember it for a year,
//                     so turning it off again takes that long to reach them.
// Preloading is left to the owner (hstspreload.org): leaving the list takes months.

const MAX_AGE = 31_536_000;

export function hstsValue(env: Pick<Env, "HSTS">): string {
  return env.HSTS === "subdomains" ? `max-age=${MAX_AGE}; includeSubDomains` : `max-age=${MAX_AGE}`;
}

export function withHsts(res: Response, env: Pick<Env, "HSTS">): Response {
  const value = hstsValue(env);
  try {
    res.headers.set("Strict-Transport-Security", value);
    return res;
  } catch {
    // Immutable headers (Response.redirect, a fetched response): copy it.
    const copy = new Response(res.body, res);
    copy.headers.set("Strict-Transport-Security", value);
    return copy;
  }
}

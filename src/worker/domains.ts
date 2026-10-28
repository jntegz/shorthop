// Which short domain a request belongs to, and the URLs built for each domain.

import { parseDomainList } from "../shared/domains";

export interface Domains {
  /** All short domains, primary first. */
  list: string[];
  /** Default domain for new links; dev hosts map to it. */
  primary: string;
  /** Hosts the admin and the API: ADMIN_HOST if set, else the primary domain. */
  admin: string;
}

/** Used only while SHORT_DOMAINS is empty; ".invalid" can never resolve. */
const FALLBACK_DOMAIN = "shorthop.invalid";
const parsed = new Map<string, Domains>();

export function domainsOf(env: Env): Domains {
  const raw = env.SHORT_DOMAINS ?? "";
  const rawAdmin = env.ADMIN_HOST ?? "";
  const cacheKey = `${raw}|${rawAdmin}`;
  let d = parsed.get(cacheKey);
  if (!d) {
    const list = parseDomainList(raw);
    if (list.length === 0) list.push(FALLBACK_DOMAIN);
    d = { list, primary: list[0]!, admin: parseDomainList(rawAdmin)[0] ?? list[0]! };
    parsed.set(cacheKey, d);
  }
  return d;
}

/** The short domains actually configured: empty while SHORT_DOMAINS is (the fallback placeholder isn't one). */
export function configuredDomains(env: Env): string[] {
  return domainsOf(env).list.filter((d) => d !== FALLBACK_DOMAIN);
}

/** The admin host, or "" while no short domain is configured. */
export function configuredAdminHost(env: Env): string {
  const { admin } = domainsOf(env);
  return admin === FALLBACK_DOMAIN ? "" : admin;
}

/**
 * Why links can't be created yet. A Deploy to Cloudflare install starts on
 * workers.dev with no short domain, and links saved under the placeholder
 * would be stranded once a real one is added.
 */
export const NO_DOMAIN_ERROR = "Add a short domain first: set SHORT_DOMAINS and a route for it in your Wrangler config, then deploy. Settings → Short domains has the steps.";

/** Where the admin lives, as an origin: the admin host (ADMIN_HOST, or the primary domain). */
export function adminOrigin(env: Env): string {
  return `https://${domainsOf(env).admin}`;
}

export function isConfiguredDomain(env: Env, domain: string): boolean {
  return domainsOf(env).list.includes(domain);
}

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** localhost and the workers.dev preview, where there's no real short domain. */
export function isDevHost(hostname: string): boolean {
  return isLocalHost(hostname) || hostname.endsWith(".workers.dev");
}

export interface Site {
  /** The short domain whose links this request reads. */
  domain: string;
  /** The admin and the API are served here (the admin host or a dev host). */
  admin: boolean;
  /** A separate ADMIN_HOST: it serves no short links of its own. */
  adminOnly: boolean;
}

/**
 * Maps a request to its short domain, or null for a host this Worker doesn't
 * serve. Dev hosts read the primary domain's links unless an X-Shorthop-Domain
 * header names another configured domain (used by check-slugs before a move).
 */
export function resolveSite(request: Request, env: Env, url: URL): Site | null {
  const { list, primary, admin } = domainsOf(env);
  const host = url.hostname.toLowerCase();
  if (list.includes(host)) return { domain: host, admin: host === admin, adminOnly: false };
  if (host === admin) return { domain: primary, admin: true, adminOnly: true };
  if (!isDevHost(host)) return null;
  const wanted = request.headers.get("X-Shorthop-Domain")?.trim().toLowerCase();
  return { domain: wanted && list.includes(wanted) ? wanted : primary, admin: true, adminOnly: false };
}

/** Base URL of a domain's short links. In dev, primary-domain links use the dev origin. */
export function shortOrigin(env: Env, req: Request, domain: string): string {
  const reqUrl = new URL(req.url);
  if (isDevHost(reqUrl.hostname) && domain === domainsOf(env).primary) return reqUrl.origin;
  return `https://${domain}`;
}

/** Hostnames a target must never point to: every short domain, the admin host and the current host. */
export function selfHosts(env: Env, req: Request): string[] {
  const { list, admin } = domainsOf(env);
  return [...new Set([...list, admin, new URL(req.url).hostname.toLowerCase()])];
}

// Short domains. Every link lives on exactly one of them, and each domain has
// its own slugs: sh.example/guide and alt.example/guide are separate links.

/** A lowercase DNS hostname: no port, no trailing dot, at least one dot. */
export const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** "sh.example, Alt.example" → ["sh.example", "alt.example"]. Invalid entries are dropped. */
export function parseDomainList(value: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const d = raw.trim().toLowerCase();
    if (HOSTNAME_RE.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** One key per link, also used as its KV key. Slugs never contain "/". */
export function linkKey(domain: string, slug: string): string {
  return `${domain}/${slug}`;
}

/** "/guide" on the primary domain, "alt.example/guide" on any other. */
export function linkLabel(domain: string, slug: string, primary: string): string {
  return domain === primary ? `/${slug}` : `${domain}/${slug}`;
}

/** Reserved names (and example.com) that can never be a real deployment's domain. */
export function isPlaceholderHost(host: string): boolean {
  return /(^|\.)(example|invalid|test|localhost)$|^example\.(com|net|org)$/.test(host);
}

/** "domain/slug" → its parts, or null for none or anything malformed. */
export function splitKey(key: string | null | undefined): { domain: string; slug: string } | null {
  if (!key) return null;
  const cut = key.indexOf("/");
  if (cut <= 0 || cut === key.length - 1) return null;
  return { domain: key.slice(0, cut), slug: key.slice(cut + 1) };
}

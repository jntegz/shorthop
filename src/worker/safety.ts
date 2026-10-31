// Is a destination known to be malware or phishing? Asks Cloudflare's security
// resolver (1.1.1.2) over DNS-over-HTTPS: it answers 0.0.0.0, with extended
// error 16 ("Censored"), for hosts it blocks. Fails open: a slow or failing
// lookup never stops a link from being saved or opened.

const SECURITY_DOH = "https://security.cloudflare-dns.com/dns-query";

/** Hosts already looked up in this isolate, for a few minutes. */
const cache = new Map<string, { flagged: boolean; at: number }>();
const CACHE_MS = 10 * 60_000;

export async function isFlaggedHost(host: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name.includes(".") || /^[\d.]+$/.test(name) || name.includes(":")) return false;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.flagged;
  try {
    const res = await fetcher(`${SECURITY_DOH}?name=${encodeURIComponent(name)}&type=A`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { Answer?: { type: number; data: string }[]; Comment?: string[] };
    const flagged = (body.Answer ?? []).some((a) => a.type === 1 && a.data === "0.0.0.0") || (body.Comment ?? []).some((c) => /EDE\(16\)/.test(c));
    if (cache.size > 2000) cache.clear();
    cache.set(name, { flagged, at: Date.now() });
    return flagged;
  } catch {
    return false;
  }
}

/** Whether any of these URLs' hosts is flagged (each host looked up once). SAFETY_DNS = "off" turns lookups off (tests, air-gapped setups). */
export async function anyFlagged(env: Env, urls: readonly string[], fetcher?: typeof fetch): Promise<boolean> {
  if ((env as { SAFETY_DNS?: string }).SAFETY_DNS === "off") return false;
  const hosts = [...new Set(urls.map((u) => { try { return new URL(u).hostname; } catch { return ""; } }).filter(Boolean))];
  const results = await Promise.all(hosts.map((h) => isFlaggedHost(h, fetcher)));
  return results.some(Boolean);
}

export const UNSAFE_NONE = 0;
export const UNSAFE_FLAGGED = 1;
export const UNSAFE_TRUSTED = 2;

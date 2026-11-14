// Is a destination known to be malware or phishing? Asks Cloudflare's security
// resolver (1.1.1.2) over DNS-over-HTTPS: it answers 0.0.0.0, with extended
// error 16 ("Censored"), for hosts it blocks. Fails open: a slow or failing
// lookup never stops a link from being saved or opened. It is not an answer
// either: the destination counts as "unknown" and is looked up again later
// (checkUnsafeBacklog in src/worker/health.ts).

import { parseRouting } from "../shared/routing";

const SECURITY_DOH = "https://security.cloudflare-dns.com/dns-query";

/** Hosts already looked up in this isolate, for a few minutes. */
const cache = new Map<string, { flagged: boolean; at: number }>();
const CACHE_MS = 10 * 60_000;

/** "unknown": the lookup failed or timed out, so nothing was learned. */
export type Safety = "clean" | "flagged" | "unknown";

/** False when there is nothing to look up: a bare name or an IP address. */
function isPublicName(name: string): boolean {
  return name.includes(".") && !/^[\d.]+$/.test(name) && !name.includes(":");
}

export async function hostSafety(host: string, fetcher: typeof fetch = fetch): Promise<Safety> {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!isPublicName(name)) return "clean";
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.flagged ? "flagged" : "clean";
  try {
    const res = await fetcher(`${SECURITY_DOH}?name=${encodeURIComponent(name)}&type=A`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { Answer?: { type: number; data: string }[]; Comment?: string[] };
    const flagged = (body.Answer ?? []).some((a) => a.type === 1 && a.data === "0.0.0.0") || (body.Comment ?? []).some((c) => /EDE\(16\)/.test(c));
    if (cache.size > 2000) cache.clear();
    cache.set(name, { flagged, at: Date.now() });
    return flagged ? "flagged" : "clean";
  } catch {
    return "unknown";
  }
}

/** A link's destinations: its target and every enabled routing variant, each a URL a visitor can be sent to. */
export function destinationsOf(target: string, routing: string | null | undefined): string[] {
  const rules = parseRouting(routing)?.rules.filter((r) => r.enabled) ?? [];
  return [target, ...rules.flatMap((r) => r.variants.map((v) => v.url))];
}

/** The hosts of these URLs, each once, spelled as hostSafety looks them up. */
export function hostsOf(urls: readonly string[]): string[] {
  const hosts = urls.map((u) => { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return ""; } });
  return [...new Set(hosts.filter(Boolean))];
}

/** An answer that costs no lookup: not a public host name, or looked up in this isolate a moment ago. */
function knownSafety(name: string): Safety | null {
  if (!isPublicName(name)) return "clean";
  const hit = cache.get(name);
  return hit && Date.now() - hit.at < CACHE_MS ? (hit.flagged ? "flagged" : "clean") : null;
}

/** "pending": some host was left for a later run, because this one's lookups were used up. */
export type Verdict = Safety | "pending";

/**
 * Several links' destinations at once, with at most `max` lookups between
 * them: each host is looked up once however many links use it, and links are
 * served in the order given. A link is flagged when any of its hosts is,
 * otherwise unknown when a lookup failed, otherwise pending when a host was
 * not reached. `looked` has the answer of each host looked up now; `clean`
 * names hosts an earlier run found clean. SAFETY_DNS = "off" turns lookups
 * off (tests, air-gapped setups): everything counts as clean.
 */
export async function safetyOfEach(
  env: Env,
  links: readonly (readonly string[])[],
  max: number,
  clean?: ReadonlySet<string>,
): Promise<{ verdicts: Verdict[]; looked: Map<string, Safety> }> {
  if ((env as { SAFETY_DNS?: string }).SAFETY_DNS === "off") return { verdicts: links.map(() => "clean"), looked: new Map() };
  const hosts = links.map(hostsOf);
  const answers = new Map<string, Safety>();
  const wanted: string[] = [];
  for (const host of new Set(hosts.flat())) {
    const known = clean?.has(host) ? "clean" : knownSafety(host);
    if (known) answers.set(host, known);
    else if (wanted.length < max) wanted.push(host);
  }
  const looked = new Map<string, Safety>();
  await Promise.all(wanted.map(async (h) => void looked.set(h, await hostSafety(h))));
  for (const [h, s] of looked) answers.set(h, s);
  const verdicts = hosts.map((list): Verdict => {
    const found = list.map((h) => answers.get(h));
    return found.includes("flagged") ? "flagged" : found.includes("unknown") ? "unknown" : found.includes(undefined) ? "pending" : "clean";
  });
  return { verdicts, looked };
}

/**
 * One link's destinations together (see safetyOfEach). With more hosts than
 * `max` lookups, the answer is unknown unless one looked up is flagged: the
 * cron's backlog finishes the rest.
 */
export async function safetyOf(env: Env, urls: readonly string[], max = Number.POSITIVE_INFINITY): Promise<Safety> {
  const verdict = (await safetyOfEach(env, [urls], max)).verdicts[0] ?? "clean";
  return verdict === "pending" ? "unknown" : verdict;
}

export const UNSAFE_NONE = 0;
export const UNSAFE_FLAGGED = 1;
export const UNSAFE_TRUSTED = 2;

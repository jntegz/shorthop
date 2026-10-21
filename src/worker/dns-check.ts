// Live setup check for a short domain, used by the onboarding in Settings:
// where its nameservers point, which address records it has, and whether it
// already reaches this Worker over HTTPS. Lookups go through Cloudflare's
// DNS-over-HTTPS resolver; nothing is stored.

import type { DomainCheckDTO, DomainRecord } from "../shared/types";
import { isConfiguredDomain } from "./domains";

const DOH = "https://cloudflare-dns.com/dns-query";
const TYPES = { A: 1, NS: 2, CNAME: 5, AAAA: 28 } as const;
const NXDOMAIN = 3;

/** Marks responses that come from this Worker, so the check can recognize it. */
export const SERVED_BY_HEADER = "X-Shorthop";

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

async function lookup(name: string, type: keyof typeof TYPES): Promise<{ status: number; answers: DohAnswer[] }> {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`DNS lookup failed (HTTP ${res.status})`);
  const body = await res.json<{ Status: number; Answer?: DohAnswer[] }>();
  return { status: body.Status, answers: body.Answer ?? [] };
}

const bare = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

/** NS records of the domain, or of the closest parent that has them (for subdomains). */
async function nameservers(domain: string): Promise<{ zone: string | null; nameservers: string[]; exists: boolean }> {
  const labels = domain.split(".");
  let exists = true;
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join(".");
    const { status, answers } = await lookup(name, "NS");
    if (i === 0 && status === NXDOMAIN) exists = false;
    const ns = answers.filter((a) => a.type === TYPES.NS && bare(a.name) === name).map((a) => bare(a.data));
    if (ns.length) return { zone: name, nameservers: ns.sort(), exists };
  }
  return { zone: null, nameservers: [], exists };
}

async function addressRecords(domain: string): Promise<DomainRecord[]> {
  const results = await Promise.all((["A", "AAAA", "CNAME"] as const).map((t) => lookup(domain, t)));
  const seen = new Set<string>();
  const records: DomainRecord[] = [];
  for (const { answers } of results) {
    for (const a of answers) {
      if (bare(a.name) !== domain) continue;
      const type = a.type === TYPES.A ? "A" : a.type === TYPES.AAAA ? "AAAA" : a.type === TYPES.CNAME ? "CNAME" : null;
      if (!type) continue;
      const value = bare(a.data);
      if (seen.has(`${type} ${value}`)) continue;
      seen.add(`${type} ${value}`);
      records.push({ type, value });
    }
  }
  return records;
}

async function serving(domain: string): Promise<Pick<DomainCheckDTO, "serving" | "servingDetail"> & { reached: boolean }> {
  try {
    const res = await fetch(`https://${domain}/health`, {
      redirect: "manual",
      headers: { "User-Agent": "shorthop-check/1 (+setup check)" },
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
    const marker = res.headers.get(SERVED_BY_HEADER);
    if (marker === "ok" && res.status === 200) return { serving: "yes", servingDetail: `https://${domain} is answered by this Worker.`, reached: true };
    if (marker === "unconfigured") {
      return { serving: "no", servingDetail: "The domain reaches this Worker, but it isn't in SHORT_DOMAINS yet. Add it (step 4) and deploy.", reached: true };
    }
    return { serving: "no", servingDetail: `https://${domain} is answered by another server (HTTP ${res.status}).`, reached: true };
  } catch {
    return { serving: "no", servingDetail: `No HTTPS answer from ${domain} yet. DNS or the certificate may still be on its way.`, reached: false };
  }
}

export async function checkDomain(env: Env, domain: string): Promise<DomainCheckDTO> {
  const checkedAt = Math.floor(Date.now() / 1000);
  try {
    const [ns, records, { reached, ...live }] = await Promise.all([nameservers(domain), addressRecords(domain), serving(domain)]);
    if (live.serving === "no" && records.length > 0 && !reached) {
      live.servingDetail = `No HTTPS answer from ${domain}: it still points elsewhere (${records.map((r) => `${r.type} ${r.value}`).join(", ")}).`;
    }
    return {
      domain,
      configured: isConfiguredDomain(env, domain),
      exists: ns.exists,
      zone: ns.zone,
      nameservers: ns.nameservers,
      onCloudflare: ns.nameservers.length > 0 && ns.nameservers.every((n) => n.endsWith(".ns.cloudflare.com")),
      records,
      ...live,
      error: null,
      checkedAt,
    };
  } catch (err) {
    return {
      domain,
      configured: isConfiguredDomain(env, domain),
      exists: true,
      zone: null,
      nameservers: [],
      onCloudflare: false,
      records: [],
      serving: "no",
      servingDetail: "",
      error: `The check couldn't finish: ${String(err instanceof Error ? err.message : err)}`,
      checkedAt,
    };
  }
}

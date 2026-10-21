// Input checks for the setup wizard. Pure functions, tested in test/node.

import { HOSTNAME_RE } from "../../src/shared/domains";
import { MAX_PASSWORD_LENGTH } from "../../src/shared/password";

export const MIN_PASSWORD_LENGTH = 9;

/** Worker names: lowercase letters, digits and dashes, up to 63 characters. */
export function workerNameProblem(name: string): string | null {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? null : "Use 1-63 lowercase letters, digits or dashes (not at the start or end).";
}

/** "https://Go.Example.com/x" → "go.example.com"; null when it isn't a hostname. */
export function normalizeHost(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return HOSTNAME_RE.test(host) ? host : null;
}

/** "a.com, B.com" → ["a.com", "b.com"], or the first entry that isn't a hostname. */
export function parseHosts(input: string): { hosts: string[] } | { bad: string } {
  const hosts: string[] = [];
  for (const raw of input.split(/[\s,]+/).filter(Boolean)) {
    const h = normalizeHost(raw);
    if (!h) return { bad: raw };
    if (!hosts.includes(h)) hosts.push(h);
  }
  return { hosts };
}

export function isEmail(s: string): boolean {
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s.trim());
}

export function httpsUrlProblem(s: string): string | null {
  try {
    const u = new URL(s.trim());
    if (u.protocol !== "https:") return "Use an https:// address.";
    if (!u.hostname.includes(".")) return "That host doesn't look right.";
    return null;
  } catch {
    return "That isn't a URL.";
  }
}

export function datasetProblem(s: string): string | null {
  return /^\w{1,64}$/.test(s) ? null : "Use 1-64 letters, digits or underscores.";
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

/** "myteam" or "https://myteam.cloudflareaccess.com/" → "myteam.cloudflareaccess.com". */
export function normalizeTeamDomain(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9-]+$/.test(s)) s = `${s}.cloudflareaccess.com`;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(s) ? s : null;
}

/** Access application AUD tags are 64 hex characters. */
export function isAud(s: string): boolean {
  return /^[a-f0-9]{64}$/.test(s.trim());
}

/** The longest zone name that `host` is in, or null. */
export function zoneFor(host: string, zones: readonly string[]): string | null {
  let best: string | null = null;
  for (const z of zones) {
    if ((host === z || host.endsWith(`.${z}`)) && (!best || z.length > best.length)) best = z;
  }
  return best;
}

/** A sender address on one of the short domains' zones is the usual choice for Cloudflare Email Service. */
export function defaultSender(primary: string, zones: readonly string[]): string {
  return `digest@${zoneFor(primary, zones) ?? primary}`;
}

// Destination checks: the status model, shared by the Worker (which checks)
// and the admin (which explains). Pure functions only.

/** "unchecked" is never stored: it's a target without a row yet. */
export type CheckStatus = "ok" | "warning" | "down" | "blocked";
export type CheckState = CheckStatus | "unchecked";

export const CHECK_PROBLEMS = [
  "not_found",
  "gone",
  "server_error",
  "client_error",
  "timeout",
  "dns",
  "tls",
  "network",
  "too_many_redirects",
  "unsafe_redirect",
  "refused",
] as const;
export type CheckProblem = (typeof CHECK_PROBLEMS)[number];

/** What one check found. "blocked": the site answered but won't serve automated checks. */
export interface CheckOutcome {
  kind: "ok" | "fail" | "blocked";
  httpStatus: number | null;
  problem: CheckProblem | null;
  /** The URL the redirects ended at, when it isn't the target itself. */
  finalUrl: string | null;
  hops: number;
  ms: number;
}

/** A stored check row, as the state machine needs it. */
export interface CheckRecord {
  status: CheckStatus;
  fails: number;
  since: number;
  lastOkAt: number | null;
  notified: boolean;
}

/** Failed checks in a row before a destination counts as not working. */
export const DOWN_AFTER_FAILS = 3;
const HOUR = 3600;
/** How often a working destination is checked unless someone chooses otherwise, in hours. */
export const DEFAULT_EVERY_HOURS = 24;
/** The range a custom frequency may take: 1 hour to 30 days. */
export const MIN_EVERY_HOURS = 1;
export const MAX_EVERY_HOURS = 720;
/** The frequencies offered besides a custom one. */
export const CHECK_EVERY_PRESETS = [
  { hours: 24, label: "Once a day" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Once a week" },
] as const;
/** A working destination is checked again after this long, by default. */
export const OK_INTERVAL = DEFAULT_EVERY_HOURS * HOUR;
/** Sites that refuse automated checks are retried less often. */
export const BLOCKED_INTERVAL = 24 * HOUR;
/** After the 1st and 2nd failure: confirm soon, but not within one short outage. */
const RETRY_AFTER = [HOUR, 4 * HOUR];
/** Redirects followed before giving up. */
export const MAX_HOPS = 5;
/** Time budget for one destination, all redirects included. */
export const CHECK_TIMEOUT_MS = 10_000;

/** Checks of one site per scheduled run, so many links to one site don't look like an attack to it. */
export const MAX_PER_HOST_PER_RUN = 2;

/**
 * How often a working destination is checked, in seconds. Normally the chosen
 * `base`; with more destinations than the schedule can cover that often, it
 * stretches so the schedule never falls behind (a quarter of the capacity is
 * kept for retries).
 */
export function okIntervalFor(destinations: number, capacityPerDay: number, base = OK_INTERVAL): number {
  const needed = Math.ceil(((destinations / (capacityPerDay * 0.75)) * 86400) / HOUR) * HOUR;
  return Math.max(base, needed);
}

/** 24 → "once a day", 72 → "every 3 days", 168 → "once a week", 12 → "every 12 hours". */
export function everyText(hours: number): string {
  if (hours === 168) return "once a week";
  if (hours % 24 === 0) return hours === 24 ? "once a day" : `every ${hours / 24} days`;
  return hours === 1 ? "every hour" : `every ${hours} hours`;
}

/** Picks up to `limit` items in order, at most `perHost` per site. */
export function spreadByHost<T extends { target: string }>(items: readonly T[], limit: number, perHost: number): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const item of items) {
    if (out.length >= limit) break;
    let host = "";
    try {
      host = new URL(item.target).hostname.replace(/^www\./, "");
    } catch {
      host = item.target;
    }
    const n = counts.get(host) ?? 0;
    if (n >= perHost) continue;
    counts.set(host, n + 1);
    out.push(item);
  }
  return out;
}

/** The next stored state after a check. `okInterval` is how long a working destination waits (see okIntervalFor). */
export function nextRecord(prev: CheckRecord | null, outcome: CheckOutcome, now: number, okInterval = OK_INTERVAL): CheckRecord & { nextAt: number } {
  let status: CheckStatus;
  let fails = 0;
  let nextAt: number;
  if (outcome.kind === "ok") {
    status = "ok";
    nextAt = now + okInterval;
  } else if (outcome.kind === "blocked") {
    status = "blocked";
    nextAt = now + Math.max(BLOCKED_INTERVAL, okInterval);
  } else {
    fails = (prev?.fails ?? 0) + 1;
    status = fails >= DOWN_AFTER_FAILS ? "down" : "warning";
    nextAt = now + (RETRY_AFTER[fails - 1] ?? okInterval);
  }
  return {
    status,
    fails,
    since: prev && prev.status === status ? prev.since : now,
    lastOkAt: outcome.kind === "ok" ? now : (prev?.lastOkAt ?? null),
    // Only a destination that stays down keeps its "already emailed" mark.
    notified: status === "down" ? (prev?.notified ?? false) : false,
    nextAt,
  };
}

/** Classifies a final HTTP status. Redirects are handled before this. */
export function classifyStatus(status: number, challenged: boolean): Pick<CheckOutcome, "kind" | "problem"> {
  if (challenged) return { kind: "blocked", problem: "refused" };
  if (status >= 200 && status < 300) return { kind: "ok", problem: null };
  // Logins, bot walls and rate limits: the page may well work for people. 999 is LinkedIn's.
  if (status === 401 || status === 403 || status === 407 || status === 429 || status === 999) return { kind: "blocked", problem: "refused" };
  if (status === 404) return { kind: "fail", problem: "not_found" };
  if (status === 410) return { kind: "fail", problem: "gone" };
  if (status >= 500) return { kind: "fail", problem: "server_error" };
  return { kind: "fail", problem: "client_error" };
}

/** Plain-language status names, used in the admin and in emails. */
export const STATE_LABEL: Record<CheckState, string> = {
  ok: "Working",
  warning: "Problem, confirming",
  down: "Not working",
  blocked: "Can't check",
  unchecked: "Not checked yet",
};

export const PROBLEM_LABEL: Record<CheckProblem, string> = {
  not_found: "Page not found",
  gone: "Page removed",
  server_error: "Server error",
  client_error: "Request rejected",
  timeout: "No answer in 10 seconds",
  dns: "Domain doesn't resolve",
  tls: "Certificate or HTTPS problem",
  network: "Couldn't connect",
  too_many_redirects: "Too many redirects",
  unsafe_redirect: "Redirects to a private address",
  refused: "Site blocks automated checks",
};

/** One line for a check: "Page not found (HTTP 404)". */
export function problemText(problem: CheckProblem | null, httpStatus: number | null): string {
  if (!problem) return httpStatus ? `HTTP ${httpStatus}` : "";
  const label = PROBLEM_LABEL[problem];
  return httpStatus ? `${label} (HTTP ${httpStatus})` : label;
}

export function isCheckProblem(v: unknown): v is CheckProblem {
  return typeof v === "string" && (CHECK_PROBLEMS as readonly string[]).includes(v);
}

// ---- Outbound-request safety -------------------------------------------------

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".private"];
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

function ipv4Private(host: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Private(host: string): boolean | null {
  if (!host.startsWith("[")) return null;
  const ip = host.slice(1, -1).toLowerCase();
  if (ip === "::" || ip === "::1") return true;
  // IPv4-mapped (::ffff:7f00:1 after URL normalization): judge the embedded IPv4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) ?? true;
  }
  const first = parseInt(ip.split(":")[0] || "0", 16);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/**
 * Whether a URL may be fetched by a check: http(s), no credentials, a public
 * host name or address, and a common web port. The URL class has already
 * normalized hosts, so "http://2130706433" arrives here as 127.0.0.1.
 */
export function isFetchableUrl(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  if (!ALLOWED_PORTS.has(url.port)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost") return false;
  const v4 = ipv4Private(host);
  if (v4 !== null) return !v4;
  const v6 = ipv6Private(host);
  if (v6 !== null) return !v6;
  if (!host.includes(".")) return false;
  return !BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}

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

/** Which links are checked: only those switched on, or every link not set to "never check". */
export const CHECK_SCOPES = ["selected", "all"] as const;
export type CheckScope = (typeof CHECK_SCOPES)[number];
export const DEFAULT_CHECK_SCOPE: CheckScope = "selected";

/** A link's own choice, as stored in links.monitor. */
export const MONITOR_DEFAULT = 0;
export const MONITOR_ON = 1;
/** Never checked, even when every link is. */
export const MONITOR_NEVER = 2;

/** Whether a link's destination is checked, from its own choice and the Link health scope. */
export const isChecked = (monitor: number, scope: CheckScope): boolean => monitor === MONITOR_ON || (scope === "all" && monitor === MONITOR_DEFAULT);

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

/** The eight 16-bit groups of an IPv6 address as the URL class prints it, or null. */
function ipv6Groups(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function ipv6Private(host: string): boolean | null {
  if (!host.startsWith("[")) return null;
  const g = ipv6Groups(host.slice(1, -1).toLowerCase());
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // ::, ::1, IPv4-compatible (::7f00:1) and IPv4-mapped (::ffff:7f00:1): judge the embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    if (g5 === 0 && g6 === 0) return true;
    return ipv4Private(v4Of(g6, g7)) ?? true;
  }
  // NAT64 (64:ff9b::/96, and the local-use 64:ff9b:1::/48) reaches the embedded IPv4.
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 ? (ipv4Private(v4Of(g6, g7)) ?? true) : true;
  // 6to4 (2002::/16) carries an IPv4 in the next 32 bits; Teredo (2001::/32) hides one, so refuse it.
  if (g0 === 0x2002) return ipv4Private(v4Of(g1, g2)) ?? true;
  if (g0 === 0x2001 && g1 === 0) return true;
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00;
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

// Wrangler and the Cloudflare API, as the setup wizard uses them. The API
// token comes from `wrangler auth token` and stays in memory. With --dry-run,
// commands that change anything are printed instead of run.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRANGLER_BIN } from "../lib";
import { color } from "./prompt";

let dryRun = false;
/** A dry run without a Wrangler login: account reads are skipped, not failed. */
let offline = false;
let accountId = "";

export function setDryRun(on: boolean): void {
  dryRun = on;
}
export function isDryRun(): boolean {
  return dryRun;
}
export function goOffline(): void {
  offline = true;
}

/** Every later Wrangler and API call acts on this account. */
export function useAccount(id: string): void {
  accountId = id;
  process.env.CLOUDFLARE_ACCOUNT_ID = id;
}

export class CommandError extends Error {
  constructor(
    message: string,
    /** Wrangler's stderr and stdout, for callers that recognize specific errors. */
    readonly output = "",
  ) {
    super(message);
  }
}

/**
 * Account commands (lists, secrets, email) run in an empty directory, so a
 * wrangler.jsonc from an earlier run can't redirect them to its account_id.
 */
let neutralDir: string | null = null;
const neutralCwd = () => (neutralDir ??= mkdtempSync(join(tmpdir(), "shorthop-wrangler-")));

interface RunOptions {
  /** Written to stdin (never logged): how secrets reach Wrangler. */
  input?: string;
  /** Hand the terminal to Wrangler, for its own prompts (DNS overrides, migrations). */
  inherit?: boolean;
  /** Changes something: printed instead of run in a dry run. */
  mutates?: boolean;
  /** Read wrangler.jsonc (deploy, migrations); otherwise runs outside the project. */
  project?: boolean;
  /** How to show the command; defaults to the command line. */
  shown?: string;
}

/** Runs `wrangler <args>`, returning its stdout. Throws on a non-zero exit. */
export function wrangler(args: string[], opts: RunOptions = {}): string {
  return run(process.execPath, [WRANGLER_BIN, ...args], { shown: `wrangler ${args.join(" ")}`, ...opts });
}

/** Runs `npm run <script>` in the project, through the npm that started the setup when known. */
export function npmRun(script: string, opts: RunOptions = {}): string {
  const npmCli = process.env.npm_execpath;
  const shown = `npm run ${script}`;
  if (npmCli) return run(process.execPath, [npmCli, "run", script], { shown, project: true, ...opts });
  return run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { shown, project: true, ...opts });
}

function run(cmd: string, args: string[], opts: RunOptions = {}): string {
  const shown = opts.shown ?? [cmd, ...args].join(" ");
  if (dryRun && opts.mutates) {
    console.log(color.dim(`  [dry run] ${shown}${opts.input !== undefined ? " < (secrets on stdin)" : ""}`));
    return "";
  }
  const res = spawnSync(cmd, args, {
    cwd: opts.project ? process.cwd() : neutralCwd(),
    encoding: "utf8",
    input: opts.input,
    stdio: opts.inherit ? "inherit" : [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", FORCE_COLOR: opts.inherit ? process.env.FORCE_COLOR : "0" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw new CommandError(`${shown}: ${res.error.message}`);
  if (res.status !== 0) {
    const output = `${res.stderr ?? ""}\n${res.stdout ?? ""}`.trim();
    const excerpt = output.split("\n").slice(-12).join("\n");
    throw new CommandError(`\`${shown}\` failed${excerpt ? `:\n${excerpt}` : ""}`, output);
  }
  return res.stdout ?? "";
}

/** The first JSON value in Wrangler's output (it may print banners or warnings around it). `secret` keeps it out of errors. */
function jsonFrom<T>(out: string, secret = false): T {
  const sample = () => (secret ? "(output hidden: it may hold a credential)" : out.slice(0, 200));
  const start = out.search(/[[{]/);
  if (start === -1) throw new CommandError(`Expected JSON from Wrangler, got: ${sample()}`);
  for (let end = out.length; end > start; end = out.lastIndexOf(out[start] === "[" ? "]" : "}", end - 1)) {
    try {
      return JSON.parse(out.slice(start, end + 1)) as T;
    } catch {
      // Trailing text after the JSON: try a shorter slice.
    }
  }
  throw new CommandError(`Couldn't read Wrangler's JSON output: ${sample()}`);
}

// --- Account -------------------------------------------------------------------

export interface Account {
  id: string;
  name: string;
}

/** The login and its accounts; null when Wrangler isn't logged in. Other failures throw. */
export function whoami(): { email: string | null; accounts: Account[] } | null {
  let out: string;
  try {
    out = wrangler(["whoami", "--json"]);
  } catch (err) {
    // Not logged in: `whoami --json` exits non-zero with {"loggedIn": false}.
    if (err instanceof CommandError && /"loggedIn":\s*false/.test(err.output)) return null;
    throw err;
  }
  const r = jsonFrom<{ loggedIn?: boolean; email?: string; accounts?: Account[] }>(out);
  if (!r.loggedIn) return null;
  return { email: r.email ?? null, accounts: (r.accounts ?? []).map((a) => ({ id: a.id, name: a.name })) };
}

type Auth = { type: "oauth" | "api_token"; token: string } | { type: "api_key"; key: string; email: string };
let auth: Auth | null = null;

function authHeaders(): Record<string, string> {
  auth ??= jsonFrom<Auth>(wrangler(["auth", "token", "--json"]), true);
  return auth.type === "api_key" ? { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email } : { Authorization: `Bearer ${auth.token}` };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One Cloudflare API call with Wrangler's credentials. Returns `result`. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; mutates?: boolean } = {}, retried = false): Promise<T> {
  if (dryRun && init.mutates) {
    console.log(color.dim(`  [dry run] ${init.method ?? "GET"} /client/v4${path}`));
    return undefined as T;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init.method ?? "GET",
    headers: { ...authHeaders(), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
  if (res.status === 401 && !retried) {
    // An OAuth token can expire during a long run: ask Wrangler for a fresh one, once.
    auth = null;
    return api(path, init, true);
  }
  if (!res.ok || !json?.success) {
    throw new ApiError(json?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`, res.status);
  }
  return json.result as T;
}

async function paged<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await api<T[]>(`${path}${sep}per_page=50&page=${page}`);
    out.push(...batch);
    if (batch.length < 50) break;
  }
  return out;
}

// --- Zones, DNS and Worker custom domains ---------------------------------------

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export async function zones(): Promise<Zone[]> {
  if (offline) return [];
  return paged<Zone>(`/zones?account.id=${accountId}`);
}

export interface DnsRecord {
  type: string;
  name: string;
  content: string;
}

export function dnsRecords(zoneId: string, name: string): Promise<DnsRecord[]> {
  return api<DnsRecord[]>(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
}

export interface WorkerDomain {
  hostname: string;
  service: string;
}

/** Custom domains already attached to a Worker in this account. */
export async function workerDomains(): Promise<WorkerDomain[]> {
  if (offline) return [];
  return api<WorkerDomain[]>(`/accounts/${accountId}/workers/domains`);
}

// --- KV and D1 -----------------------------------------------------------------

function findKv(title: string): string | null {
  if (offline) return null;
  const list = jsonFrom<{ id: string; title: string }[]>(wrangler(["kv", "namespace", "list"]));
  return list.find((n) => n.title === title)?.id ?? null;
}

/** The namespace's id, creating it when it doesn't exist. Ids are read back from the list. */
export function ensureKv(title: string): string | null {
  const existing = findKv(title);
  if (existing) return existing;
  wrangler(["kv", "namespace", "create", title], { mutates: true });
  return dryRun ? null : findKv(title);
}

function findD1(name: string): string | null {
  if (offline) return null;
  const list = jsonFrom<{ uuid: string; name: string }[]>(wrangler(["d1", "list", "--json"]));
  return list.find((d) => d.name === name)?.uuid ?? null;
}

export function ensureD1(name: string): string | null {
  const existing = findD1(name);
  if (existing) return existing;
  wrangler(["d1", "create", name], { mutates: true });
  return dryRun ? null : findD1(name);
}

// --- Secrets -------------------------------------------------------------------

/**
 * Names of the Worker's secrets; empty only when the Worker doesn't exist yet.
 * Any other failure throws: guessing "none" would make the setup replace them all.
 */
export function secretNames(worker: string): Set<string> {
  if (offline) return new Set();
  try {
    return new Set(jsonFrom<{ name: string }[]>(wrangler(["secret", "list", "--name", worker, "--format", "json"])).map((s) => s.name));
  } catch (err) {
    if (err instanceof CommandError && /Worker "[^"]*" not found|\b10007\b/.test(err.output)) return new Set();
    throw err;
  }
}

/** Uploads secrets in one request, through stdin. Null deletes one. Nothing touches the disk. */
export function putSecrets(worker: string, values: Record<string, string | null>): void {
  if (!Object.keys(values).length) return;
  wrangler(["secret", "bulk", "--name", worker], { input: JSON.stringify(values), mutates: true });
}

// --- Email ---------------------------------------------------------------------

export interface RoutingAddress {
  id: string;
  email: string;
  verified: string | null;
}

export async function routingAddresses(): Promise<RoutingAddress[]> {
  if (offline) return [];
  return paged<RoutingAddress>(`/accounts/${accountId}/email/routing/addresses`);
}

export function addRoutingAddress(email: string): Promise<RoutingAddress> {
  return api<RoutingAddress>(`/accounts/${accountId}/email/routing/addresses`, { method: "POST", body: { email }, mutates: true });
}

// --- Checks against other services ------------------------------------------------

/** True when the token can query Analytics Engine in the chosen account. */
export async function analyticsTokenWorks(token: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: "SELECT 1 AS ok FORMAT JSON",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, detail: "The token can query Analytics Engine." };
    return { ok: false, detail: `Analytics Engine answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

/** True when the Access team serves signing keys (so the team domain is real). */
export async function accessTeamWorks(teamDomain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { keys?: unknown[] } | null;
    return res.ok && Array.isArray(body?.keys) && body.keys.length > 0;
  } catch {
    return false;
  }
}

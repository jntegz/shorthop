// Pulls links from another shortener's API (Bitly, Rebrandly, Short.io, Dub),
// a page at a time, for the import page. The API key comes with each request
// and is never stored or logged. Each call stays inside the plan's subrequest
// budget (src/worker/plan.ts) and returns a cursor for the next page; the
// admin feeds the rows through the same preview, dry run and import as a file.

import type { ImportVendor } from "../../shared/types";

/** One link as the import takes it (the domain may be the vendor's own, which the admin moves). */
export interface PulledRow {
  domain: string;
  slug: string;
  target: string;
  title: string | null;
  tags: string[];
  clicks: number | null;
  createdAt: number | null;
}

export interface PullPage {
  rows: PulledRow[];
  /** Pass back for the next page; null when every link is in. */
  cursor: string | null;
  /** Something the person should know (click totals skipped, and so on). */
  note?: string;
}

/** The vendor said no: a bad key, a rate limit or an outage. Its message is shown as it is. */
export class VendorError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 429 | 502,
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const seconds = (v: unknown): number | null => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

const LABEL: Record<ImportVendor, string> = { bitly: "Bitly", rebrandly: "Rebrandly", shortio: "Short.io", dub: "Dub" };

async function fetchJson(vendor: ImportVendor, url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", ...headers }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new VendorError(`${LABEL[vendor]} didn't answer. Try again in a minute.`, 502);
  }
  if (res.status === 401 || res.status === 403) throw new VendorError(`${LABEL[vendor]} refused the API key. Check it and its permissions.`, 401);
  if (res.status === 429) throw new VendorError(`${LABEL[vendor]} asks to slow down (rate limit). Wait a minute, then continue: the import picks up where it stopped.`, 429);
  if (!res.ok) throw new VendorError(`${LABEL[vendor]} answered ${res.status}. Try again later.`, 502);
  return res.json();
}

/** "https://brand.co/abc" or "brand.co/abc" → its host and path. */
function splitShort(url: string): { domain: string; slug: string } | null {
  const m = /^(?:https?:\/\/)?([^/?#]+)\/([^?#]*)/.exec(url.trim());
  if (!m || !m[2]) return null;
  return { domain: m[1]!.toLowerCase(), slug: decodeURIComponent(m[2]!) };
}

const encode = (v: unknown) => btoa(JSON.stringify(v)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
function decode<T>(cursor: string | null): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as T;
  } catch {
    return null;
  }
}

// ---- Bitly ------------------------------------------------------------------------------------------

/**
 * Bitly v4: the group's bitlinks, 100 a page. Branded back-halves are in
 * custom_bitlinks and are what moves to your domain; plain bit.ly links come
 * with the bit.ly domain. Click totals cost one call per link, so a page with
 * them is as big as the budget allows.
 */
async function bitly(key: string, cursor: string | null, budget: number, withClicks: boolean): Promise<PullPage> {
  const auth = { Authorization: `Bearer ${key}` };
  const state = decode<{ g: string; a: string | null }>(cursor) ?? { g: "", a: null };
  let calls = 0;
  if (!state.g) {
    state.g = str(obj(await fetchJson("bitly", "https://api-ssl.bitly.com/v4/user", auth)).default_group_guid);
    calls++;
    if (!state.g) throw new VendorError("Bitly didn't say which group the links are in.", 502);
  }
  const size = withClicks ? Math.max(1, Math.min(100, budget - calls - 1)) : 100;
  const body = obj(
    await fetchJson("bitly", `https://api-ssl.bitly.com/v4/groups/${encodeURIComponent(state.g)}/bitlinks?size=${size}${state.a ? `&search_after=${encodeURIComponent(state.a)}` : ""}`, auth),
  );
  calls++;
  const links = arr(body.links).map(obj);
  const clicks = new Map<string, number>();
  if (withClicks) {
    for (const l of links) {
      if (calls >= budget) break;
      const id = str(l.id);
      const summary = obj(await fetchJson("bitly", `https://api-ssl.bitly.com/v4/bitlinks/${encodeURIComponent(id)}/clicks/summary?unit=day&units=-1`, auth));
      calls++;
      const n = num(summary.total_clicks);
      if (n !== null) clicks.set(id, n);
    }
  }
  const rows: PulledRow[] = [];
  for (const l of links) {
    const shared = { target: str(l.long_url), title: str(l.title) || null, tags: arr(l.tags).map(str).filter(Boolean), clicks: clicks.get(str(l.id)) ?? null, createdAt: seconds(l.created_at) };
    const custom = arr(l.custom_bitlinks).map(str).map(splitShort).filter((x): x is { domain: string; slug: string } => x !== null);
    const own = splitShort(str(l.link) || str(l.id));
    for (const where of custom.length ? custom : own ? [own] : []) rows.push({ ...where, ...shared });
  }
  const next = str(obj(body.pagination).search_after);
  return { rows, cursor: links.length && next ? encode({ g: state.g, a: next }) : null };
}

// ---- Rebrandly --------------------------------------------------------------------------------------

/** Rebrandly v1: 25 links a page, oldest first, with their lifetime clicks. Several pages per call. */
async function rebrandly(key: string, cursor: string | null, budget: number): Promise<PullPage> {
  let last = decode<{ l: string }>(cursor)?.l ?? null;
  const rows: PulledRow[] = [];
  for (let calls = 0; calls < budget; calls++) {
    const list = arr(
      await fetchJson("rebrandly", `https://api.rebrandly.com/v1/links?orderBy=createdAt&orderDir=asc&limit=25${last ? `&last=${encodeURIComponent(last)}` : ""}`, { apikey: key }),
    ).map(obj);
    for (const l of list) {
      rows.push({
        domain: str(obj(l.domain).fullName).toLowerCase() || "rebrand.ly",
        slug: str(l.slashtag),
        target: str(l.destination),
        title: str(l.title) || null,
        tags: [],
        clicks: num(l.clicks),
        createdAt: seconds(l.createdAt),
      });
    }
    if (list.length < 25) return { rows, cursor: null, note: "Rebrandly's tags aren't brought over (they need a call per link)." };
    last = str(list.at(-1)!.id);
  }
  return { rows, cursor: encode({ l: last }) };
}

// ---- Short.io ---------------------------------------------------------------------------------------

/** Short.io: every domain's links, 150 a page, with click totals from one statistics call per page. */
async function shortio(key: string, cursor: string | null, budget: number): Promise<PullPage> {
  const auth = { Authorization: key };
  type State = { d: { id: number; host: string }[]; i: number; t: string | null };
  const state = decode<State>(cursor) ?? { d: [], i: 0, t: null };
  let calls = 0;
  if (!cursor) {
    state.d = arr(await fetchJson("shortio", "https://api.short.io/api/domains", auth))
      .map(obj)
      .map((d) => ({ id: num(d.id) ?? 0, host: str(d.hostname).toLowerCase() }))
      .filter((d) => d.id && d.host);
    calls++;
  }
  const rows: PulledRow[] = [];
  let note: string | undefined;
  while (state.i < state.d.length && calls + 2 <= budget) {
    const domain = state.d[state.i]!;
    // The cursor comes back from the browser: only a numeric domain id goes into Short.io's URLs.
    const domainId = Number(domain.id);
    if (!Number.isSafeInteger(domainId) || domainId <= 0) throw new Error("Bad cursor");
    const body = obj(
      await fetchJson("shortio", `https://api.short.io/api/links?domain_id=${domainId}&limit=150${state.t ? `&pageToken=${encodeURIComponent(state.t)}` : ""}`, auth),
    );
    calls++;
    const links = arr(body.links).map(obj);
    let clicks: Obj = {};
    if (links.length) {
      try {
        clicks = obj(await fetchJson("shortio", `https://api-v2.short.io/statistics/domain/${domainId}/link_clicks?ids=${links.map((l) => num(l.id)).filter(Boolean).join(",")}`, auth));
      } catch (err) {
        // Statistics are limited separately (60 a minute); the links matter more.
        if (!(err instanceof VendorError)) throw err;
        note = "Some click totals couldn't be read from Short.io's statistics; those links come without them.";
      }
      calls++;
    }
    for (const l of links) {
      rows.push({
        domain: domain.host,
        slug: str(l.path),
        target: str(l.originalURL),
        title: str(l.title) || null,
        tags: arr(l.tags).map(str).filter(Boolean),
        clicks: num(clicks[str(l.id)]),
        createdAt: seconds(l.createdAt),
      });
    }
    const next = str(body.nextPageToken);
    if (next && links.length) state.t = next;
    else {
      state.i++;
      state.t = null;
    }
  }
  return { rows, cursor: state.i < state.d.length ? encode(state) : null, note };
}

// ---- Dub --------------------------------------------------------------------------------------------

/** Dub: 100 links a page with clicks and tags. Several pages per call. */
async function dub(key: string, cursor: string | null, budget: number): Promise<PullPage> {
  let after = decode<{ a: string }>(cursor)?.a ?? null;
  const rows: PulledRow[] = [];
  for (let calls = 0; calls < budget; calls++) {
    const list = arr(await fetchJson("dub", `https://api.dub.co/links?pageSize=100${after ? `&startingAfter=${encodeURIComponent(after)}` : ""}`, { Authorization: `Bearer ${key}` })).map(obj);
    for (const l of list) {
      rows.push({
        domain: str(l.domain).toLowerCase(),
        slug: str(l.key),
        target: str(l.url),
        title: str(l.title) || null,
        tags: arr(l.tags).map((t) => str(obj(t).name)).filter(Boolean),
        clicks: num(l.clicks),
        createdAt: seconds(l.createdAt),
      });
    }
    if (list.length < 100) return { rows, cursor: null };
    after = str(list.at(-1)!.id);
  }
  return { rows, cursor: encode({ a: after }) };
}

/** One page of a vendor's links. `budget` is the outbound calls this request may make. */
export function pullLinks(vendor: ImportVendor, key: string, cursor: string | null, budget: number, opts: { clicks: boolean }): Promise<PullPage> {
  if (vendor === "bitly") return bitly(key, cursor, budget, opts.clicks);
  if (vendor === "rebrandly") return rebrandly(key, cursor, budget);
  if (vendor === "shortio") return shortio(key, cursor, budget);
  return dub(key, cursor, budget);
}

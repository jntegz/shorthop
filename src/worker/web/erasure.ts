// The erasure ledger: what was erased, as keyed hashes only. One table does two
// jobs. The collector refuses a browser id on it, so an erased visitor isn't
// collected again under the same id; and after a restore (a backup, or D1 going
// back in time) the site's "Re-apply erasures" finds rows matching it and erases
// them again (src/worker/web/privacy.ts).
//
// Entries are HMACs under ENCRYPTION_KEY or SESSION_SECRET, so the table can't be
// read or searched without the secret, and they expire. A copy of each erasure
// also goes to KV: restoring D1 can't take that one back in time.
//
// The collector asks about one browser id at a time, by its hash, so what a check
// costs doesn't depend on how long the ledger is. Visitors can add only `withdrawn`
// entries: one per id the site has really seen, a limited number per site and day,
// counted in the collector's budget, and kept for a shorter time.

import { planLimits } from "../plan";
import { hmac } from "../link-password";
import { budgetKey } from "./budget";

/** How long an entry lasts: longer than any backup the Worker keeps itself (eight weeks in R2). */
export const LEDGER_KEEP_SEC = 400 * 86400;
/** A withdrawal: the browser has already dropped the id, so this only catches a copy of it turning up again. */
export const WITHDRAWN_KEEP_SEC = 90 * 86400;
const COPY_PREFIX = "cfg:erasure:";
const CACHE_MS = 60_000;
/** Answers one isolate remembers: enough for the visitors active in a minute, without growing. */
const MAX_ANSWERS = 5000;

/**
 * visitor, email, customer, payment: erased. reference: a provider's order or
 * subscription id on an erased payment, which stays there and must not be tied to
 * a visit again. withdrawn: a browser id whose consent was taken back; nothing to erase.
 */
export type LedgerKind = "visitor" | "email" | "customer" | "payment" | "reference" | "withdrawn";
export interface LedgerEntry {
  kind: LedgerKind;
  value: string;
}

type Secrets = Pick<Env, "SESSION_SECRET" | "ENCRYPTION_KEY">;

/** Secrets a hash may have been made with, the one new entries use first. */
const secretsOf = (env: Secrets) => [env.ENCRYPTION_KEY, env.SESSION_SECRET].filter((s): s is string => Boolean(s));

const keyIdOf = async (secret: string) => (await hmac(secret, "erasure-ledger-key")).slice(0, 8);

/** A withdrawn browser id hashes like an erased one, so one lookup finds both. */
const hashOf = async (secret: string, siteId: string, e: LedgerEntry) =>
  (await hmac(secret, `erasure|${siteId}|${e.kind === "withdrawn" ? "visitor" : e.kind}|${e.value}`)).slice(0, 27);

function insertStmt(db: D1Database, siteId: string, rows: readonly (readonly [string, string])[], keyId: string, now: number, expires: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO erasure_ledger (site_id, kind, hash, key_id, created_at, expires_at)
       SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?2, ?3, ?4 FROM json_each(?5) WHERE true
       ON CONFLICT (site_id, kind, hash) DO UPDATE SET created_at = MAX(created_at, excluded.created_at), expires_at = MAX(expires_at, excluded.expires_at)`,
    )
    .bind(siteId, keyId, now, expires, JSON.stringify(rows));
}

interface Written {
  /** The insert, for the caller's batch; null with nothing to write or no secret to hash under. */
  stmt: D1PreparedStatement | null;
  /** The KV copy, once the batch went through. */
  copy: () => Promise<void>;
}

export async function ledgerWrite(env: Env, siteId: string, entries: LedgerEntry[], now: number): Promise<Written> {
  const secret = secretsOf(env)[0];
  if (!secret || !entries.length) return { stmt: null, copy: async () => undefined };
  const rows = await Promise.all(entries.map(async (e) => [e.kind, await hashOf(secret, siteId, e)] as const));
  const keyId = await keyIdOf(secret);
  const expires = now + LEDGER_KEEP_SEC;
  return {
    stmt: insertStmt(env.DB, siteId, rows, keyId, now, expires),
    copy: async () => {
      try {
        await env.LINKS.put(`${COPY_PREFIX}${siteId}:${crypto.randomUUID()}`, JSON.stringify({ k: keyId, at: now, e: expires, r: rows }), { expirationTtl: LEDGER_KEEP_SEC });
      } catch (err) {
        console.error(JSON.stringify({ message: "erasure ledger copy failed", site: siteId, error: String(err) }));
      }
    },
  };
}

/** Brings erasures from the KV copy back into the table, a page at a time. Returns the next KV cursor, or null at the end. */
export async function mergeLedgerCopy(env: Env, siteId: string, cursor: string | null, limit: number, now: number): Promise<string | null> {
  const page = await env.LINKS.list({ prefix: `${COPY_PREFIX}${siteId}:`, limit, ...(cursor ? { cursor } : {}) });
  const stored = await Promise.all(page.keys.map((k) => env.LINKS.get<{ k: string; at: number; e: number; r: [string, string][] }>(k.name, "json")));
  const writes = stored.flatMap((s) => (s && s.e > now && Array.isArray(s.r) ? [insertStmt(env.DB, siteId, s.r, s.k, s.at, s.e)] : []));
  if (writes.length) await env.DB.batch(writes);
  resetErasureCache();
  return page.list_complete ? null : page.cursor;
}

export interface Ledger {
  /**
   * Whether this value was erased, under any secret this install has. With `since`
   * (when the row was first stored), only if that was at or before the erasure:
   * someone who came back afterwards and gave their details again isn't erased.
   */
  has(e: LedgerEntry, since?: number): Promise<boolean>;
  /** Entries made with a secret this install no longer has: they can't be matched. */
  unreadable: number;
}

export async function readLedger(env: Env, siteId: string, now: number): Promise<Ledger> {
  const { results } = await env.DB.prepare("SELECT kind, hash, key_id, created_at FROM erasure_ledger WHERE site_id = ?1 AND expires_at > ?2 AND kind != 'withdrawn'")
    .bind(siteId, now)
    .all<{ kind: string; hash: string; key_id: string; created_at: number }>();
  const secrets = secretsOf(env);
  const known = new Set(await Promise.all(secrets.map(keyIdOf)));
  const hashes = new Map(results.map((r) => [`${r.kind}|${r.hash}`, r.created_at]));
  return {
    unreadable: results.filter((r) => !known.has(r.key_id)).length,
    has: async (e, since) => {
      if (!hashes.size) return false;
      for (const secret of secrets) {
        const erasedAt = hashes.get(`${e.kind}|${await hashOf(secret, siteId, e)}`);
        if (erasedAt !== undefined && (since === undefined || since <= erasedAt)) return true;
      }
      return false;
    },
  };
}

// ---- The collector's check -----------------------------------------------------------

/** This isolate's answers, each good for a minute: per browser id, and whether a site has any refused id at all. */
let answers = new Map<string, { refused: boolean; at: number }>();
let sitesWithEntries = new Map<string, { any: boolean; at: number }>();

export function resetErasureCache(): void {
  answers = new Map();
  sitesWithEntries = new Map();
}

const fresh = (hit: { at: number } | undefined): boolean => hit !== undefined && Date.now() - hit.at < CACHE_MS;
const answerKey = (siteId: string, visitorId: string) => `${siteId}|${visitorId}`;

function remember(key: string, refused: boolean): void {
  answers.delete(key);
  // A Map iterates oldest first.
  if (answers.size >= MAX_ANSWERS) answers.delete(answers.keys().next().value!);
  answers.set(key, { refused, at: Date.now() });
}

/** Most sites have nothing on the ledger: one row a minute per isolate spares their events a lookup each. */
async function siteHasEntries(env: Env, siteId: string, now: number): Promise<boolean> {
  const hit = sitesWithEntries.get(siteId);
  if (hit && fresh(hit)) return hit.any;
  const row = await env.DB.prepare("SELECT 1 AS y FROM erasure_ledger WHERE site_id = ?1 AND kind IN ('visitor', 'withdrawn') AND expires_at > ?2 LIMIT 1").bind(siteId, now).first();
  if (sitesWithEntries.size >= MAX_ANSWERS) sitesWithEntries.clear();
  sitesWithEntries.set(siteId, { any: row !== null, at: Date.now() });
  return row !== null;
}

/**
 * Whether a browser id may not be used: one lookup of its hash under each secret
 * this install has, on the table's primary key, remembered for a minute. A change
 * made through another isolate reaches this one within that minute.
 */
export async function visitorRefused(env: Env, siteId: string, visitorId: string, now: number): Promise<boolean> {
  const key = answerKey(siteId, visitorId);
  const hit = answers.get(key);
  if (hit && fresh(hit)) return hit.refused;
  try {
    const secrets = secretsOf(env);
    if (!secrets.length || !(await siteHasEntries(env, siteId, now))) return false;
    const hashes = await Promise.all(secrets.map((s) => hashOf(s, siteId, { kind: "visitor", value: visitorId })));
    const row = await env.DB.prepare(
      `SELECT 1 AS y FROM erasure_ledger WHERE site_id = ?1 AND kind IN ('visitor', 'withdrawn') AND hash IN (${hashes.map((_, i) => `?${i + 3}`).join(", ")}) AND expires_at > ?2 LIMIT 1`,
    )
      .bind(siteId, now, ...hashes)
      .first();
    remember(key, row !== null);
    return row !== null;
  } catch (err) {
    console.error(JSON.stringify({ message: "erasure ledger read failed", site: siteId, error: String(err) }));
    return false;
  }
}

/** The ids among `refs` that belong to an erased payment. A read failure leaves them all usable. */
export async function erasedReferences(env: Env, siteId: string, refs: string[], now: number): Promise<Set<string>> {
  const found = new Set<string>();
  const secrets = secretsOf(env);
  if (!refs.length || !secrets.length) return found;
  try {
    const owners = new Map<string, string>();
    for (const value of refs) for (const secret of secrets) owners.set(await hashOf(secret, siteId, { kind: "reference", value }), value);
    const { results } = await env.DB.prepare("SELECT hash FROM erasure_ledger WHERE site_id = ?1 AND kind = 'reference' AND hash IN (SELECT value FROM json_each(?2)) AND expires_at > ?3")
      .bind(siteId, JSON.stringify([...owners.keys()]), now)
      .all<{ hash: string }>();
    for (const r of results) found.add(owners.get(r.hash)!);
  } catch (err) {
    console.error(JSON.stringify({ message: "erasure ledger read failed", site: siteId, error: String(err) }));
  }
  return found;
}

/** Sorts inside its day's budget key, so the daily cleanup of old counts removes it too (src/worker/web/budget.ts). */
const withdrawalsKey = (siteId: string, now: number) => `${budgetKey(new Date(now * 1000).toISOString().slice(0, 10))}:withdrawn:${siteId}`;

/**
 * A browser took back its consent: its id isn't accepted again. Written once per
 * id, for ids the site has seen, up to the site's limit for the day. Returns the
 * rows written. Never throws: the browser has dropped the id whatever happens here.
 */
export async function withdrawVisitor(env: Env, siteId: string, visitorId: string, now: number): Promise<number> {
  const secret = secretsOf(env)[0];
  if (!secret) return 0;
  try {
    // Asked again (a repeat, or an id already erased): nothing to write.
    if (await visitorRefused(env, siteId, visitorId, now)) return 0;
    // Only an id the site has seen, so made-up ones can't fill the table.
    const seen = await env.DB.prepare("SELECT 1 AS y FROM web_sessions WHERE site_id = ?1 AND visitor_id = ?2 LIMIT 1").bind(siteId, visitorId).first();
    if (!seen) return 0;
    const counted = await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?1, 1) ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 WHERE CAST(value AS INTEGER) < ?2 RETURNING value`,
    )
      .bind(withdrawalsKey(siteId, now), planLimits(env).withdrawalsPerDay)
      .all();
    if (!counted.results.length) return 0;
    const res = await env.DB.prepare(
      `INSERT INTO erasure_ledger (site_id, kind, hash, key_id, created_at, expires_at) VALUES (?1, 'withdrawn', ?2, ?3, ?4, ?5)
       ON CONFLICT (site_id, kind, hash) DO UPDATE SET key_id = excluded.key_id, created_at = excluded.created_at, expires_at = excluded.expires_at
       WHERE erasure_ledger.expires_at <= excluded.created_at`,
    )
      .bind(siteId, await hashOf(secret, siteId, { kind: "withdrawn", value: visitorId }), await keyIdOf(secret), now, now + WITHDRAWN_KEEP_SEC)
      .run();
    remember(answerKey(siteId, visitorId), true);
    sitesWithEntries.set(siteId, { any: true, at: Date.now() });
    return (counted.meta.rows_written ?? 1) + (res.meta.rows_written ?? 0);
  } catch (err) {
    console.error(JSON.stringify({ message: "consent withdrawal not recorded", site: siteId, error: String(err) }));
    return 0;
  }
}

export const pruneLedgerStmt = (db: D1Database, now: number) => db.prepare("DELETE FROM erasure_ledger WHERE expires_at <= ?1").bind(now);

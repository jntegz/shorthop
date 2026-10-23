// D1 link records and their KV read copies.

import { linkKey, splitKey } from "../shared/domains";
import { parsePreview, PREVIEW_IMAGE_PATH } from "../shared/preview";
import { parseQrStyle } from "../shared/qr";
import { parseRouting, type RouteDevice } from "../shared/routing";
import type { KvPreview } from "./preview";
import type { LinkDTO, LinkSource } from "../shared/types";

export interface LinkRow {
  domain: string;
  slug: string;
  target: string;
  active: number;
  expires_at: number | null;
  utm: number;
  utm_template: string | null;
  pass_query: number;
  title: string | null;
  tags: string;
  notes: string;
  source: LinkSource;
  imported_clicks: number | null;
  /** 1 when marked "no longer working". */
  broken: number;
  /** "domain/slug" of the link shown instead, when broken. */
  replacement: string | null;
  /** 0 when its destination is never checked. */
  monitor: number;
  /** Smart routing JSON (src/shared/routing.ts), or null. */
  routing: string | null;
  /** Custom social preview JSON (src/shared/preview.ts), or null. */
  preview: string | null;
  /** QR code design JSON (src/shared/qr.ts), or null for the default. */
  qr: string | null;
  /** PBKDF2 hash of the link's password, or null. Never sent to the admin. */
  password_hash: string | null;
  /** Most human clicks allowed, or null for no limit. */
  max_clicks: number | null;
  created_at: number;
  updated_at: number;
}

/** The KV value read by the redirect path. Short keys keep reads small. */
export interface KvLink {
  /** target */
  u: string;
  /** active */
  a: 0 | 1;
  /** expiry, unix seconds */
  e: number | null;
  /** append UTM */
  utm: 0 | 1;
  /** pass query params through */
  qp: 0 | 1;
  /** effective UTM template, present when utm is 1 */
  t?: string;
  /** marked "no longer working" */
  b?: 1;
  /** replacement link, "domain/slug", present when b is 1 */
  r?: string;
  /** enabled routing rules, in order; absent without routing */
  ro?: KvRule[];
  /** custom social preview, for link-preview crawlers */
  og?: KvPreview;
  /** password hash: visitors must enter the password first */
  pw?: string;
  /** click limit, counted by the ClickCap Durable Object */
  mc?: number;
}

/** A routing rule as the redirect needs it: no names, enabled rules only. */
export interface KvRule {
  id: string;
  devices: RouteDevice[];
  countries: string[];
  countryMode: "in" | "not_in";
  /** l: label, for the {variant} UTM placeholder. */
  variants: { id: string; url: string; weight: number; l: string }[];
  /** The rule's name, for {variant} when it has one destination. */
  n?: string;
}

const DEFAULT_UTM_FALLBACK = "utm_source={domain}&utm_medium=shortlink&utm_campaign={slug}";

export function isKvLink(v: unknown): v is KvLink {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.u === "string" &&
    (r.a === 0 || r.a === 1) &&
    (r.e === null || typeof r.e === "number") &&
    (r.utm === 0 || r.utm === 1) &&
    (r.qp === 0 || r.qp === 1) &&
    (r.t === undefined || typeof r.t === "string") &&
    (r.b === undefined || r.b === 1) &&
    (r.r === undefined || typeof r.r === "string") &&
    (r.ro === undefined || Array.isArray(r.ro)) &&
    (r.og === undefined || (typeof r.og === "object" && r.og !== null)) &&
    (r.pw === undefined || typeof r.pw === "string") &&
    (r.mc === undefined || typeof r.mc === "number")
  );
}

function toKv(row: LinkRow, defaultUtm: string): KvLink {
  const kv: KvLink = {
    u: row.target,
    a: row.active ? 1 : 0,
    e: row.expires_at,
    utm: row.utm ? 1 : 0,
    qp: row.pass_query ? 1 : 0,
  };
  if (row.utm) kv.t = row.utm_template ?? defaultUtm;
  if (row.broken) {
    kv.b = 1;
    if (row.replacement) kv.r = row.replacement;
  }
  const rules = parseRouting(row.routing)?.rules.filter((r) => r.enabled) ?? [];
  if (rules.length) {
    kv.ro = rules.map((r) => ({
      id: r.id,
      devices: r.devices,
      countries: r.countries,
      countryMode: r.countryMode,
      variants: r.variants.map((v) => ({ id: v.id, url: v.url, weight: v.weight, l: v.label })),
      ...(r.name ? { n: r.name } : {}),
    }));
  }
  if (row.password_hash) kv.pw = row.password_hash;
  if (row.max_clicks) kv.mc = row.max_clicks;
  const preview = parsePreview(row.preview);
  if (preview) {
    const img = preview.image;
    kv.og = {
      t: preview.title,
      d: preview.description,
      i: img ? (img.kind === "upload" ? `${PREVIEW_IMAGE_PATH}${img.key}` : img.url) : null,
      ...(img?.kind === "upload" && img.width && img.height ? { w: img.width, h: img.height } : {}),
    };
  }
  return kv;
}

/** KV key of a link: "domain/slug". */
export const kvKey = linkKey;

export { splitKey };

/** `origin` is the base URL of the link's domain (see shortOrigin). */
export function toDTO(row: LinkRow, origin: string): LinkDTO {
  return {
    domain: row.domain,
    slug: row.slug,
    shortUrl: `${origin}/${encodeURIComponent(row.slug)}`,
    target: row.target,
    active: row.active === 1,
    expiresAt: row.expires_at,
    utm: row.utm === 1,
    utmTemplate: row.utm_template,
    passQuery: row.pass_query === 1,
    title: row.title,
    tags: row.tags ? row.tags.split(",") : [],
    notes: row.notes,
    source: row.source,
    importedClicks: row.imported_clicks,
    broken: row.broken === 1,
    replacement: splitKey(row.replacement),
    monitor: row.monitor !== 0,
    routing: parseRouting(row.routing),
    preview: parsePreview(row.preview),
    qr: parseQrStyle(row.qr),
    protected: Boolean(row.password_hash),
    maxClicks: row.max_clicks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setSettingStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value);
}

export async function getDefaultUtm(db: D1Database): Promise<string> {
  return (await getSetting(db, "default_utm")) ?? DEFAULT_UTM_FALLBACK;
}

/** The first UTC day with stats or links: the earliest a custom period can start. */
export async function statsSince(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT MIN(d) AS d FROM (SELECT MIN(date) AS d FROM daily_dims UNION ALL SELECT date(MIN(created_at), 'unixepoch') FROM links)")
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

export async function getLink(db: D1Database, domain: string, slug: string): Promise<LinkRow | null> {
  return db.prepare("SELECT * FROM links WHERE domain = ? AND slug = ?").bind(domain, slug).first<LinkRow>();
}

export async function publish(env: Env, row: LinkRow, defaultUtm: string): Promise<void> {
  await env.LINKS.put(kvKey(row.domain, row.slug), JSON.stringify(toKv(row, defaultUtm)));
}

/** Seconds since the epoch. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const JSON_CHUNK_BYTES = 500_000;

/** Splits rows into JSON arrays small enough for one bound parameter. */
export function jsonChunks(rows: unknown[][]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 2;
  for (const row of rows) {
    const s = JSON.stringify(row);
    if (current.length > 0 && size + s.length + 1 > JSON_CHUNK_BYTES) {
      chunks.push(`[${current.join(",")}]`);
      current = [];
      size = 2;
    }
    current.push(s);
    size += s.length + 1;
  }
  if (current.length > 0) chunks.push(`[${current.join(",")}]`);
  return chunks;
}

/** Budget for a KV read a visitor is waiting on (a redirect, a 404 page). */
export const KV_TIMEOUT_MS = 1000;

/** Rejects when `work` takes longer than `ms`; the timer never outlives it. */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

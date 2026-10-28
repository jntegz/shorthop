// Defensive readers for provider payloads: a field that's missing or has the
// wrong type reads as null instead of throwing.

export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** A number, also from a numeric string ("65215"). */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/** Unix seconds from unix seconds, unix milliseconds or an ISO string. */
export function sec(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v > 1e12 ? v / 1000 : v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  return null;
}

export function currency(v: unknown): string | null {
  const s = str(v)?.toUpperCase() ?? null;
  return s && /^[A-Z]{3}$/.test(s) ? s : null;
}

export function email(v: unknown): string | null {
  const s = str(v)?.toLowerCase() ?? null;
  return s && /^[^\s@]+@[^\s@]+$/.test(s) ? s.slice(0, 254) : null;
}

/** The visit reference from metadata, in any of the shapes providers return. */
export function visitRef(...sources: unknown[]): string | null {
  for (const s of sources) {
    const raw = typeof s === "string" ? s : str(obj(s).sh_ref);
    if (!raw) continue;
    const v = raw.startsWith("sh_") ? raw.slice(3) : raw;
    if (/^[A-Za-z0-9_-]{12,32}$/.test(v)) return v;
  }
  return null;
}

export const compact = (list: (string | null | undefined)[]): string[] => [...new Set(list.filter((x): x is string => Boolean(x)))];

export function parseJson(body: string): Obj {
  try {
    return obj(JSON.parse(body));
  } catch {
    throw new Error("Body is not JSON");
  }
}

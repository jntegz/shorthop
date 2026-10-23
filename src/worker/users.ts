// People besides the owners, and personal API keys: D1 records and the Actor
// each request runs as.

import { toBase64Url } from "../shared/password";
import { effectivePermissions, formatPermissions, parsePermissions, PERMISSIONS, type Actor, type Permission, type Role } from "../shared/permissions";

export interface UserRow {
  email: string;
  name: string;
  role: Role;
  permissions: string;
  password_hash: string | null;
  session_epoch: string;
  invite_hash: string | null;
  invite_expires: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  paused_at: number | null;
  /** NULL while paused: until someone resumes them. */
  paused_until: number | null;
  paused_by: string | null;
  reset_hash: string | null;
  reset_expires: number | null;
}

/** The per-person part of an owner's session cookie (owners have no users row). */
export const OWNER_EPOCH = "owner";
/** Invite links work this long. */
export const INVITE_TTL_SEC = 24 * 60 * 60;
export const MAX_KEYS_PER_PERSON = 20;
/** Shortest password someone can choose for themselves. */
export const MIN_USER_PASSWORD = 12;

export const KEY_RE = /^shp_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The identity of password-only sessions (ADMIN_AUTH "password"). Not an email, so it never matches an Access login. */
export const PASSWORD_IDENTITY = "admin";

/** The owners: ADMIN_EMAIL, lowercased. */
export function ownerEmails(env: Env): string[] {
  return (env.ADMIN_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** An owner's email, or the password-only identity while Access is off (whose keys stop working once it's on). */
export function isOwner(env: Env, email: string): boolean {
  return ownerEmails(env).includes(email) || (env.ADMIN_AUTH === "password" && email === PASSWORD_IDENTITY);
}

/** Whether their access is paused right now. A pause with an end time lifts by itself. */
export function isPaused(row: Pick<UserRow, "paused_at" | "paused_until">, now: number): boolean {
  return row.paused_at !== null && (row.paused_until === null || row.paused_until > now);
}

/** 1793750400 → "3 November 2026, 07:00 UTC". */
export function utcText(sec: number): string {
  return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(sec * 1000)} UTC`;
}

/** What a paused person is told. */
export function pausedReason(row: Pick<UserRow, "paused_until">): string {
  return `Your access is paused${row.paused_until ? ` until ${utcText(row.paused_until)}` : ""}. Ask an admin or manager if you need it sooner.`;
}

export function ownerActor(email: string): Actor {
  return { email, name: "", role: "admin", owner: true, permissions: [...PERMISSIONS], via: "session" };
}

export function userActor(row: UserRow, via: Actor["via"] = "session"): Actor {
  return {
    email: row.email,
    name: row.name,
    role: row.role,
    owner: false,
    permissions: effectivePermissions(row.role, parsePermissions(row.permissions)),
    via,
  };
}

export async function getUser(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

/** Random URL-safe text: 32 bytes give 43 characters. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 8 characters [a-z0-9]: the visible part of a key. */
export function newKeyId(): string {
  let id = "";
  for (const b of crypto.getRandomValues(new Uint8Array(8))) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

export function newApiKey(): { id: string; key: string } {
  const id = newKeyId();
  return { id, key: `shp_${id}_${randomToken()}` };
}

/** The audit label for history: who did it, and through which key. */
export function actorLabel(actor: Actor): string {
  if (actor.via === "token") return "api-token";
  return actor.key ? `${actor.email} · API key ${actor.key.name}` : actor.email;
}

interface KeyLookup {
  id: string;
  owner: string;
  name: string;
  permissions: string;
  expires_at: number | null;
  last_used_at: number | null;
  user_email: string | null;
  user_name: string | null;
  user_role: Role | null;
  user_permissions: string | null;
  user_paused_at: number | null;
  user_paused_until: number | null;
}

/**
 * The Actor for a personal key, or null when it's unknown, expired, or its
 * owner is gone, paused or may no longer use the API. The key's permissions are
 * limited to what its owner can do right now.
 */
export async function findApiKey(env: Env, presented: string, now: number): Promise<{ actor: Actor; lastUsedAt: number | null } | null> {
  if (!KEY_RE.test(presented)) return null;
  const row = await env.DB.prepare(
    `SELECT k.id, k.owner, k.name, k.permissions, k.expires_at, k.last_used_at,
            u.email AS user_email, u.name AS user_name, u.role AS user_role, u.permissions AS user_permissions,
            u.paused_at AS user_paused_at, u.paused_until AS user_paused_until
     FROM api_keys k LEFT JOIN users u ON u.email = k.owner WHERE k.hash = ?`,
  )
    .bind(await sha256Hex(presented))
    .first<KeyLookup>();
  if (!row || (row.expires_at !== null && row.expires_at <= now)) return null;

  let person: Actor;
  if (isOwner(env, row.owner)) person = ownerActor(row.owner);
  else if (row.user_email && row.user_role) {
    if (isPaused({ paused_at: row.user_paused_at, paused_until: row.user_paused_until }, now)) return null;
    person = userActor({ email: row.user_email, name: row.user_name ?? "", role: row.user_role, permissions: row.user_permissions ?? "" } as UserRow);
  } else return null;
  if (!person.permissions.includes("api.use")) return null;

  const allowed = new Set(person.permissions);
  const permissions = parsePermissions(row.permissions).filter((p) => allowed.has(p));
  return {
    actor: { ...person, permissions, via: "key", key: { id: row.id, name: row.name } },
    lastUsedAt: row.last_used_at,
  };
}

/** Records use at most once an hour per key. */
export function touchApiKeyStmt(db: D1Database, id: string, now: number): D1PreparedStatement {
  return db.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - 3600)").bind(now, id);
}

/** Daily cleanup: keys that expired more than 30 days ago. */
export async function pruneApiKeys(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM api_keys WHERE expires_at IS NOT NULL AND expires_at < ?").bind(now - 30 * 86400).run();
}

/** Keeps a manager's changes to what they hold themselves: the rest of the target's permissions stay as they were. */
export function mergeManagedPermissions(submitted: readonly Permission[], own: readonly Permission[], current: readonly Permission[]): string {
  const mine = new Set(own);
  return formatPermissions([...submitted.filter((p) => mine.has(p)), ...current.filter((p) => !mine.has(p))]);
}

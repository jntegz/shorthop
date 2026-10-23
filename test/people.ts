// Test helpers for people, sessions and API keys.

import { env } from "cloudflare:test";
import { formatPermissions, type Permission, type Role } from "../src/shared/permissions";
import { hashPassword } from "../src/shared/password";
import { nowSec } from "../src/worker/db";
import { newApiKey, sha256Hex } from "../src/worker/users";
import { call } from "./helpers";

/** The dev bypass works on localhost only; DEV_AUTH_EMAIL picks who you are. */
export const LOCAL = "http://localhost:5173";

/** Env for acting as someone through the dev bypass (no password configured, so no session needed). */
export const as = (email = "", extra: Partial<Env> = {}): Partial<Env> => ({ DEV_AUTH_BYPASS: "1", DEV_AUTH_EMAIL: email, ...extra });

/** Calls the admin API on localhost as `email` (empty: an owner). */
export function adminCall(email: string, path: string, init: { method?: string; body?: unknown } = {}, extra: Partial<Env> = {}): Promise<Response> {
  return call(
    new Request(`${LOCAL}/_admin/api${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { Origin: LOCAL, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    undefined,
    as(email, extra),
  );
}

export async function addUser(
  email: string,
  role: Role = "user",
  permissions: Permission[] = [],
  opts: { password?: string; inviteToken?: string; inviteExpires?: number } = {},
): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO users (email, name, role, permissions, password_hash, session_epoch, invite_hash, invite_expires, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
  )
    .bind(
      email,
      email.split("@")[0],
      role,
      formatPermissions(permissions),
      opts.password ? await hashPassword(opts.password, 10_000) : null,
      crypto.randomUUID(),
      opts.inviteToken ? await sha256Hex(opts.inviteToken) : null,
      opts.inviteToken ? (opts.inviteExpires ?? now + 3600) : null,
      now,
      now,
    )
    .run();
}

/** Stores a key for `owner` and returns it with its Authorization header. */
export async function addKey(owner: string, permissions: Permission[], opts: { expiresAt?: number; name?: string } = {}) {
  const { id, key } = newApiKey();
  await env.DB.prepare("INSERT INTO api_keys (id, hash, owner, name, permissions, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(key), owner, opts.name ?? "Test key", formatPermissions(permissions), nowSec(), opts.expiresAt ?? null)
    .run();
  return { id, key, auth: { Authorization: `Bearer ${key}` } };
}

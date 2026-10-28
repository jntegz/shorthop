// Settings → API keys: personal keys for scripts and tools. A key is shown
// once; only its SHA-256 is stored. It can do what it was given, and never more
// than its owner can do at the time it's used (src/worker/users.ts).

import { Hono } from "hono";
import { parsePermissions } from "../../shared/permissions";
import { apiKeyListSchema, apiKeyParamSchema, apiKeySchema } from "../../shared/schemas";
import type { ApiKeyDTO, NewApiKeyDTO } from "../../shared/types";
import { nowSec } from "../db";
import { validate, type AppEnv } from "../hono";
import { MAX_KEYS_PER_PERSON, newApiKey, ownerEmails, PASSWORD_IDENTITY, sha256Hex } from "../users";

interface KeyRow {
  id: string;
  owner: string;
  name: string;
  permissions: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

function keyOf(r: KeyRow, now: number): ApiKeyDTO {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    permissions: parsePermissions(r.permissions),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    expired: r.expires_at !== null && r.expires_at <= now,
  };
}

export const keysApi = new Hono<AppEnv>()
  // Your keys; admins can ask for everyone's with ?all=1.
  .get("/", validate("query", apiKeyListSchema), async (c) => {
    const actor = c.get("actor");
    const all = c.req.valid("query").all === "1" && actor.role === "admin";
    const stmt = all
      ? c.env.DB.prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
      : c.env.DB.prepare("SELECT * FROM api_keys WHERE owner = ? ORDER BY created_at DESC").bind(actor.email);
    const { results } = await stmt.all<KeyRow>();
    const now = nowSec();
    return c.json({ keys: results.map((r) => keyOf(r, now)) });
  })

  .post("/", validate("json", apiKeySchema), async (c) => {
    const actor = c.get("actor");
    const body = c.req.valid("json");
    // Keys can't manage keys, so api.use would mean nothing on one.
    const permissions = body.permissions.filter((p) => p !== "api.use");
    if (permissions.some((p) => !actor.permissions.includes(p))) return c.json({ error: "A key can only do what you can do yourself." }, 403);

    const now = nowSec();
    const { id, key } = newApiKey();
    const expires = body.expiresInDays === null ? null : now + body.expiresInDays * 86400;
    const res = await c.env.DB.prepare(
      `INSERT INTO api_keys (id, hash, owner, name, permissions, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE (SELECT COUNT(*) FROM api_keys WHERE owner = ?3) < ?8`,
    )
      .bind(id, await sha256Hex(key), actor.email, body.name, permissions.join(","), now, expires, MAX_KEYS_PER_PERSON)
      .run();
    if (!res.meta.changes) return c.json({ error: `You already have ${MAX_KEYS_PER_PERSON} API keys. Revoke one you no longer use.` }, 409);
    console.log(JSON.stringify({ message: "api key created", id, owner: actor.email, permissions }));
    const created: NewApiKeyDTO = {
      key: keyOf({ id, owner: actor.email, name: body.name, permissions: permissions.join(","), created_at: now, last_used_at: null, expires_at: expires }, now),
      secret: key,
    };
    return c.json(created, 201);
  })

  // Your own keys; admins can revoke anyone's but an owner's, which only owners can.
  .delete("/:id", validate("param", apiKeyParamSchema), async (c) => {
    const actor = c.get("actor");
    const { id } = c.req.valid("param");
    const owners = [...ownerEmails(c.env), PASSWORD_IDENTITY];
    const res =
      actor.role === "admin" && actor.owner
        ? await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run()
        : actor.role === "admin"
          ? await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?1 AND (owner = ?2 OR owner NOT IN (SELECT value FROM json_each(?3)))")
              .bind(id, actor.email, JSON.stringify(owners))
              .run()
          : await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND owner = ?").bind(id, actor.email).run();
    if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
    console.log(JSON.stringify({ message: "api key revoked", id, by: actor.email }));
    return c.json({ revoked: true });
  });

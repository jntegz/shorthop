// Settings → People. Admins manage everyone except the owners (ADMIN_EMAIL);
// managers manage users only and hand out only permissions they hold. Nobody
// changes their own access. The route rules (session only, admin or manager)
// apply first; the checks here depend on who the target is.

import { Hono, type Context } from "hono";
import { assignableRoles, canManage, formatPermissions, parsePermissions, type Actor, type Permission, type Role } from "../../shared/permissions";
import { pauseSchema, personParamSchema, personSchema, personUpdateSchema } from "../../shared/schemas";
import type { InviteDTO, PeopleDTO, PersonDTO } from "../../shared/types";
import { adminAuthMode } from "../auth";
import { nowSec } from "../db";
import { validate, type AppEnv } from "../hono";
import { getUser, INVITE_TTL_SEC, isPaused, mergeManagedPermissions, ownerEmails, randomToken, sha256Hex, userActor, type UserRow } from "../users";

const PASSWORD_ONLY = "Turn on Cloudflare Access to add people with their own permissions: without it, everyone who signs in is the owner.";

function personOf(row: UserRow, actor: Actor, now: number, keys: number): PersonDTO {
  const paused = isPaused(row, now);
  const status = paused ? "paused" : row.password_hash ? "active" : row.invite_expires !== null && row.invite_expires > now ? "invited" : "expired";
  return {
    email: row.email,
    name: row.name,
    role: row.role,
    owner: false,
    permissions: userActor(row).permissions,
    status,
    inviteExpiresAt: row.password_hash ? null : row.invite_expires,
    pausedUntil: paused ? row.paused_until : null,
    pausedBy: paused ? row.paused_by : null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    keys,
    manageable: canManage(actor, row),
  };
}

function ownerOf(email: string, lastLoginAt: number | null, keys: number): PersonDTO {
  return {
    email,
    name: "",
    role: "admin",
    owner: true,
    permissions: userActor({ role: "admin", permissions: "" } as UserRow).permissions,
    status: "owner",
    inviteExpiresAt: null,
    pausedUntil: null,
    pausedBy: null,
    lastLoginAt,
    createdAt: null,
    createdBy: null,
    keys,
    manageable: false,
  };
}

async function keyCount(db: D1Database, email: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE owner = ?").bind(email).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A new one-time invite: the token goes in the link, only its hash is stored. */
async function newInvite(c: Context<AppEnv>, now: number): Promise<{ url: string; hash: string; expires: number }> {
  const token = randomToken();
  return { url: `${new URL(c.req.url).origin}/_admin/invite/${token}`, hash: await sha256Hex(token), expires: now + INVITE_TTL_SEC };
}

/** Managers may only give what they hold themselves. */
function beyondOwn(actor: Actor, wanted: readonly Permission[]): boolean {
  return actor.role !== "admin" && wanted.some((p) => !actor.permissions.includes(p));
}

const roleLabel = (r: Role) => (r === "admin" ? "an admin" : r === "manager" ? "a manager" : "a user");

const CHANGED = "Someone else changed this person. Reload and try again.";

/** The person `verb` would act on, or why the caller can't. */
async function managedTarget(c: Context<AppEnv>, email: string, verb: string): Promise<UserRow | { error: string; status: 403 | 404 }> {
  const actor = c.get("actor");
  const target = ownerEmails(c.env).includes(email) ? null : await getUser(c.env.DB, email);
  if (!target) return { error: "Not found", status: 404 };
  if (!canManage(actor, target)) return { error: target.email === actor.email ? `You can't ${verb} yourself. Ask an admin.` : `You can't ${verb} this person.`, status: 403 };
  return target;
}

export const usersApi = new Hono<AppEnv>()
  .get("/", async (c) => {
    const actor = c.get("actor");
    const now = nowSec();
    const [users, keys, logins] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare("SELECT * FROM users ORDER BY created_at, email"),
      c.env.DB.prepare("SELECT owner, COUNT(*) AS n FROM api_keys GROUP BY owner"),
      c.env.DB.prepare("SELECT email, MAX(ts) AS at FROM login_events WHERE ok = 1 AND email IS NOT NULL GROUP BY email"),
    ]);
    const keysBy = new Map((keys?.results ?? []).map((r) => [String(r.owner), Number(r.n)]));
    const loginBy = new Map((logins?.results ?? []).map((r) => [String(r.email), Number(r.at)]));
    const owners = ownerEmails(c.env);
    const result: PeopleDTO = {
      people: [
        ...owners.map((e) => ownerOf(e, loginBy.get(e) ?? null, keysBy.get(e) ?? 0)),
        ...((users?.results ?? []) as unknown as UserRow[])
          .filter((u) => !owners.includes(u.email))
          .map((u) => personOf(u, actor, now, keysBy.get(u.email) ?? 0)),
      ],
      assignableRoles: assignableRoles(actor),
    };
    return c.json(result);
  })

  .post("/", validate("json", personSchema), async (c) => {
    const actor = c.get("actor");
    const body = c.req.valid("json");
    // People are told apart by their Access email; without Access everyone signed in is the owner.
    if (adminAuthMode(c.env) === "password") return c.json({ error: PASSWORD_ONLY }, 409);
    if (ownerEmails(c.env).includes(body.email)) return c.json({ error: `${body.email} is an owner (ADMIN_EMAIL) and already has full access.` }, 409);
    if (!assignableRoles(actor).includes(body.role)) return c.json({ error: `You can't add ${roleLabel(body.role)}.` }, 403);
    if (body.role !== "admin" && beyondOwn(actor, body.permissions)) return c.json({ error: "You can only give permissions you have yourself." }, 403);

    const now = nowSec();
    const invite = await newInvite(c, now);
    try {
      await c.env.DB.prepare(
        `INSERT INTO users (email, name, role, permissions, password_hash, session_epoch, invite_hash, invite_expires, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?9)`,
      )
        .bind(body.email, body.name, body.role, body.role === "admin" ? "" : formatPermissions(body.permissions), crypto.randomUUID(), invite.hash, invite.expires, actor.email, now)
        .run();
    } catch (err) {
      if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(err))) return c.json({ error: `${body.email} is already in the list.` }, 409);
      throw err;
    }
    const row = (await getUser(c.env.DB, body.email))!;
    console.log(JSON.stringify({ message: "person added", email: row.email, role: row.role, by: actor.email }));
    const result: InviteDTO = { person: personOf(row, actor, now, 0), inviteUrl: invite.url, inviteExpiresAt: invite.expires };
    return c.json(result, 201);
  })

  .patch("/:email", validate("param", personParamSchema), validate("json", personUpdateSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const body = c.req.valid("json");
    const target = ownerEmails(c.env).includes(email) ? null : await getUser(c.env.DB, email);
    if (!target) return c.json({ error: "Not found" }, 404);
    if (!canManage(actor, target)) return c.json({ error: target.email === actor.email ? "You can't change your own access. Ask an admin." : "You can't change this person." }, 403);

    const role = body.role ?? target.role;
    if (!assignableRoles(actor).includes(role)) return c.json({ error: `You can't make someone ${roleLabel(role)}.` }, 403);
    const current = parsePermissions(target.permissions);
    let permissions: string;
    if (role === "admin") permissions = "";
    else if (actor.role === "admin") {
      // An admin's stored list is stale: demoting one needs an explicit choice.
      if (target.role === "admin" && !body.permissions) return c.json({ error: `Choose what they may do as ${roleLabel(role)}.` }, 400);
      permissions = formatPermissions(body.permissions ?? current);
    } else {
      if (body.permissions && beyondOwn(actor, body.permissions)) return c.json({ error: "You can only give permissions you have yourself." }, 403);
      permissions = mergeManagedPermissions(body.permissions ?? current, actor.permissions, current);
    }

    const now = nowSec();
    // A manager's change only lands while the target is still a user.
    const res = await c.env.DB.prepare(
      `UPDATE users SET name = ?1, role = ?2, permissions = ?3, updated_at = ?4 WHERE email = ?5${actor.role === "admin" ? "" : " AND role = 'user'"}`,
    )
      .bind(body.name ?? target.name, role, permissions, now, email)
      .run();
    if (!res.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "person changed", email, role, permissions, by: actor.email }));
    return c.json({ person: personOf(row, actor, now, await keyCount(c.env.DB, email)) });
  })

  .delete("/:email", validate("param", personParamSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const target = ownerEmails(c.env).includes(email) ? null : await getUser(c.env.DB, email);
    if (!target) return c.json({ error: "Not found" }, 404);
    if (!canManage(actor, target)) return c.json({ error: target.email === actor.email ? "You can't remove yourself. Ask an admin." : "You can't remove this person." }, 403);

    // Their keys go in the same batch, only if the row really went.
    const [removed, keys] = await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM users WHERE email = ?1${actor.role === "admin" ? "" : " AND role = 'user'"}`).bind(email),
      c.env.DB.prepare("DELETE FROM api_keys WHERE owner = ?1 AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?1)").bind(email),
    ]);
    if (!removed?.meta.changes) return c.json({ error: CHANGED }, 409);
    console.log(JSON.stringify({ message: "person removed", email, by: actor.email }));
    return c.json({ removed: true, keysRevoked: keys?.meta.changes ?? 0 });
  })

  // A new invite link: clears their password and ends their sessions, so it
  // doubles as "reset password". Older links stop working.
  .post("/:email/invite", validate("param", personParamSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    if (adminAuthMode(c.env) === "password") return c.json({ error: PASSWORD_ONLY }, 409);
    const target = ownerEmails(c.env).includes(email) ? null : await getUser(c.env.DB, email);
    if (!target) return c.json({ error: "Not found" }, 404);
    if (!canManage(actor, target)) return c.json({ error: "You can't reset this person's password." }, 403);

    const now = nowSec();
    const invite = await newInvite(c, now);
    const res = await c.env.DB.prepare(
      `UPDATE users SET password_hash = NULL, invite_hash = ?1, invite_expires = ?2, session_epoch = ?3, updated_at = ?4
       WHERE email = ?5${actor.role === "admin" ? "" : " AND role = 'user'"}`,
    )
      .bind(invite.hash, invite.expires, crypto.randomUUID(), now, email)
      .run();
    if (!res.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "invite created", email, by: actor.email }));
    const result: InviteDTO = { person: personOf(row, actor, now, await keyCount(c.env.DB, email)), inviteUrl: invite.url, inviteExpiresAt: invite.expires };
    return c.json(result);
  })

  // Pause: they can't sign in, their sessions end and their API keys stop
  // working, until the time given or until someone resumes them. Nothing is
  // deleted. The new session epoch keeps old sessions dead after a resume.
  .post("/:email/pause", validate("param", personParamSchema), validate("json", pauseSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const { until } = c.req.valid("json");
    const target = await managedTarget(c, email, "pause");
    if ("error" in target) return c.json({ error: target.error }, target.status);
    const now = nowSec();
    if (until !== null && until <= now) return c.json({ error: "Choose a time in the future." }, 400);

    const res = await c.env.DB.prepare(
      `UPDATE users SET paused_at = ?1, paused_until = ?2, paused_by = ?3, session_epoch = ?4, updated_at = ?1
       WHERE email = ?5${actor.role === "admin" ? "" : " AND role = 'user'"}`,
    )
      .bind(now, until, actor.email, crypto.randomUUID(), email)
      .run();
    if (!res.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "person paused", email, until, by: actor.email }));
    return c.json({ person: personOf(row, actor, now, await keyCount(c.env.DB, email)) });
  })

  .post("/:email/resume", validate("param", personParamSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const target = await managedTarget(c, email, "resume");
    if ("error" in target) return c.json({ error: target.error }, target.status);

    const now = nowSec();
    const res = await c.env.DB.prepare(
      `UPDATE users SET paused_at = NULL, paused_until = NULL, paused_by = NULL, updated_at = ?1
       WHERE email = ?2${actor.role === "admin" ? "" : " AND role = 'user'"}`,
    )
      .bind(now, email)
      .run();
    if (!res.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "person resumed", email, by: actor.email }));
    return c.json({ person: personOf(row, actor, now, await keyCount(c.env.DB, email)) });
  })

  // Ends every session they have; their password and API keys stay.
  .post("/:email/sign-out", validate("param", personParamSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const target = await managedTarget(c, email, "sign out");
    if ("error" in target) return c.json({ error: target.error }, target.status);

    const now = nowSec();
    const res = await c.env.DB.prepare(
      `UPDATE users SET session_epoch = ?1, updated_at = ?2 WHERE email = ?3${actor.role === "admin" ? "" : " AND role = 'user'"}`,
    )
      .bind(crypto.randomUUID(), now, email)
      .run();
    if (!res.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "person signed out", email, by: actor.email }));
    return c.json({ person: personOf(row, actor, now, await keyCount(c.env.DB, email)) });
  });

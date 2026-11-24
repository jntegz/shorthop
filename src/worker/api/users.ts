// Settings → People. Admins manage everyone except the owners (ADMIN_EMAIL);
// managers manage users only and hand out only permissions they hold. Nobody
// changes their own access. The route rules (session only, admin or manager)
// apply first; the checks here depend on who the target is.

import { Hono, type Context } from "hono";
import { assignableRoles, canManage, formatPermissions, parsePermissions, type Actor, type Permission, type Role } from "../../shared/permissions";
import { escapeHtml } from "../../shared/html";
import { pauseSchema, personParamSchema, personSchema, personUpdateSchema, reinviteSchema } from "../../shared/schemas";
import type { InviteDTO, PeopleDTO, PersonDTO } from "../../shared/types";
import { adminAuthMode } from "../auth";
import { nowSec } from "../db";
import { validate, type AppEnv } from "../hono";
import { peopleMailStatus, sendPersonMail, withMailSettings } from "../mailer";
import { clearFailuresStmt } from "../session";
import { sendTwoFactorNotice } from "../two-factor";
import { getUser, INVITE_TTL_SEC, isPaused, mergeManagedPermissions, ownerEmails, randomToken, sha256Hex, userActor, utcText, type UserRow } from "../users";

const PASSWORD_ONLY = "Turn on Cloudflare Access to add people with their own permissions: without it, everyone who signs in is the owner.";

/** What the people list shows beside the row: API keys, and whether they have two-factor sign-in. */
interface Extras {
  keys: number;
  twoFactor: boolean;
}

function personOf(row: UserRow, actor: Actor, now: number, { keys, twoFactor }: Extras): PersonDTO {
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
    twoFactor,
    manageable: canManage(actor, row),
  };
}

function ownerOf(email: string, lastLoginAt: number | null, { keys, twoFactor }: Extras): PersonDTO {
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
    twoFactor,
    manageable: false,
  };
}

async function extrasOf(db: D1Database, email: string): Promise<Extras> {
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM api_keys WHERE owner = ?1) AS keys, EXISTS (SELECT 1 FROM auth_factors WHERE email = ?1) AS two_factor")
    .bind(email)
    .first<{ keys: number; two_factor: number }>();
  return { keys: row?.keys ?? 0, twoFactor: Boolean(row?.two_factor) };
}

/** A new one-time invite: the token goes in the link, only its hash is stored. */
async function newInvite(c: Context<AppEnv>, now: number): Promise<{ url: string; hash: string; expires: number }> {
  const token = randomToken();
  return { url: `${new URL(c.req.url).origin}/_admin/invite/${token}`, hash: await sha256Hex(token), expires: now + INVITE_TTL_SEC };
}

/**
 * Emails a new invite link to the person's own address, when asked and when
 * email can reach people. The link is still shown to whoever made it.
 */
async function emailInvite(env: Env, row: UserRow, actor: Actor, invite: { url: string; expires: number }, asked: boolean): Promise<Pick<InviteDTO, "emailed" | "emailProblem">> {
  if (!asked) return { emailed: false, emailProblem: null };
  const mailEnv = await withMailSettings(env);
  const { problem } = peopleMailStatus(mailEnv);
  if (problem) return { emailed: false, emailProblem: problem };
  const by = actor.name ? `${actor.name} (${actor.email})` : actor.email;
  const until = utcText(invite.expires);
  // `row` is as it was before the link: someone who had a password is getting a reset.
  const reset = row.password_hash !== null || row.last_login_at !== null;
  const lead = reset ? `${by} sent you a link to choose a new Shorthop password.` : `${by} invited you to Shorthop.`;
  const text = `${lead}\n\nSign in with Cloudflare Access as ${row.email}, then choose your password here. The link works once, until ${until}:\n${invite.url}`;
  try {
    await sendPersonMail(mailEnv, row, {
      from: { email: mailEnv.DIGEST_FROM, name: "Shorthop" },
      subject: reset ? "Your new Shorthop password link" : "You're invited to Shorthop",
      text,
      html: `<p>${escapeHtml(lead)}</p>
<p>Sign in with Cloudflare Access as <strong>${escapeHtml(row.email)}</strong>, then <a href="${escapeHtml(invite.url)}">choose your password</a>. The link works once, until ${escapeHtml(until)}.</p>`,
    });
    return { emailed: true, emailProblem: null };
  } catch (err) {
    console.error(JSON.stringify({ message: "invite email failed", email: row.email, error: String(err) }));
    return { emailed: false, emailProblem: `The email couldn't be sent: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Managers may only give what they hold themselves. */
function beyondOwn(actor: Actor, wanted: readonly Permission[]): boolean {
  return actor.role !== "admin" && wanted.some((p) => !actor.permissions.includes(p));
}

const roleLabel = (r: Role) => (r === "admin" ? "an admin" : r === "manager" ? "a manager" : "a user");

const CHANGED = "Someone else changed this person. Reload and try again.";

/**
 * Takes away someone's API keys, and flags the webhooks those keys set up, in
 * the same batch as `first` (ending a person's access) when there is one. Run
 * the flagging before the delete: it reads the keys the delete removes.
 */
function revokeKeysStmts(db: D1Database, email: string, now: number, onlyIfGone: boolean): D1PreparedStatement[] {
  const gone = onlyIfGone ? " AND NOT EXISTS (SELECT 1 FROM users WHERE email = ?1)" : "";
  return [
    db.prepare(`UPDATE webhooks SET key_revoked_at = ?2 WHERE key_revoked_at IS NULL AND key_id IN (SELECT id FROM api_keys WHERE owner = ?1)${gone}`).bind(email, now),
    db.prepare(`DELETE FROM api_keys WHERE owner = ?1${gone}`).bind(email),
  ];
}

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
    const [users, keys, logins, factors] = await c.env.DB.batch<Record<string, unknown>>([
      c.env.DB.prepare("SELECT * FROM users ORDER BY created_at, email"),
      c.env.DB.prepare("SELECT owner, COUNT(*) AS n FROM api_keys GROUP BY owner"),
      c.env.DB.prepare("SELECT email, MAX(ts) AS at FROM login_events WHERE ok = 1 AND email IS NOT NULL GROUP BY email"),
      c.env.DB.prepare("SELECT DISTINCT email FROM auth_factors"),
    ]);
    const keysBy = new Map((keys?.results ?? []).map((r) => [String(r.owner), Number(r.n)]));
    const withFactor = new Set((factors?.results ?? []).map((r) => String(r.email)));
    const extras = (email: string): Extras => ({ keys: keysBy.get(email) ?? 0, twoFactor: withFactor.has(email) });
    const loginBy = new Map((logins?.results ?? []).map((r) => [String(r.email), Number(r.at)]));
    const owners = ownerEmails(c.env);
    const result: PeopleDTO = {
      people: [
        ...owners.map((e) => ownerOf(e, loginBy.get(e) ?? null, extras(e))),
        ...((users?.results ?? []) as unknown as UserRow[])
          .filter((u) => !owners.includes(u.email))
          .map((u) => personOf(u, actor, now, extras(u.email))),
      ],
      assignableRoles: assignableRoles(actor),
      emailProblem: peopleMailStatus(await withMailSettings(c.env)).problem,
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
    const result: InviteDTO = {
      person: personOf(row, actor, now, { keys: 0, twoFactor: false }),
      inviteUrl: invite.url,
      inviteExpiresAt: invite.expires,
      ...(await emailInvite(c.env, row, actor, invite, body.sendEmail)),
    };
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
    return c.json({ person: personOf(row, actor, now, await extrasOf(c.env.DB, email)) });
  })

  .delete("/:email", validate("param", personParamSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const target = ownerEmails(c.env).includes(email) ? null : await getUser(c.env.DB, email);
    if (!target) return c.json({ error: "Not found" }, 404);
    if (!canManage(actor, target)) return c.json({ error: target.email === actor.email ? "You can't remove yourself. Ask an admin." : "You can't remove this person." }, 403);

    // Their keys and two-factor sign-in go in the same batch, only if the row really went.
    const gone = "NOT EXISTS (SELECT 1 FROM users WHERE email = ?1)";
    const [removed, , keys] = await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM users WHERE email = ?1${actor.role === "admin" ? "" : " AND role = 'user'"}`).bind(email),
      ...revokeKeysStmts(c.env.DB, email, nowSec(), true),
      c.env.DB.prepare(`DELETE FROM auth_factors WHERE email = ?1 AND ${gone}`).bind(email),
      c.env.DB.prepare(`DELETE FROM recovery_codes WHERE email = ?1 AND ${gone}`).bind(email),
      c.env.DB.prepare(`DELETE FROM auth_challenges WHERE email = ?1 AND ${gone}`).bind(email),
    ]);
    if (!removed?.meta.changes) return c.json({ error: CHANGED }, 409);
    console.log(JSON.stringify({ message: "person removed", email, by: actor.email }));
    return c.json({ removed: true, keysRevoked: keys?.meta.changes ?? 0 });
  })

  // Every API key they have stops working now; webhooks those keys set up are flagged for review.
  .post("/:email/revoke-keys", validate("param", personParamSchema), async (c) => {
    const { email } = c.req.valid("param");
    const target = await managedTarget(c, email, "revoke the keys of");
    if ("error" in target) return c.json({ error: target.error }, target.status);
    const [, keys] = await c.env.DB.batch(revokeKeysStmts(c.env.DB, email, nowSec(), false));
    const revoked = keys?.meta.changes ?? 0;
    console.log(JSON.stringify({ message: "api keys revoked", email, revoked, by: c.get("actor").email }));
    return c.json({ revoked });
  })

  // A new invite link: clears their password and ends their sessions, so it
  // doubles as "reset password". Their API keys stop working until they choose
  // a new one. Older links stop working, reset links too. Their passkeys go as
  // well: each signs in without the password, so one added by someone who had
  // their session would outlive the reset. An authenticator app stays (it needs
  // the new password too).
  .post("/:email/invite", validate("param", personParamSchema), validate("json", reinviteSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    if (adminAuthMode(c.env) === "password") return c.json({ error: PASSWORD_ONLY }, 409);
    const { sendEmail } = c.req.valid("json");
    const target = ownerEmails(c.env).includes(email) ? null : await getUser(c.env.DB, email);
    if (!target) return c.json({ error: "Not found" }, 404);
    if (!canManage(actor, target)) return c.json({ error: "You can't reset this person's password." }, 403);

    const now = nowSec();
    const invite = await newInvite(c, now);
    // The passkeys go only with this very reset (its invite hash), never after a refused one.
    const reset = "EXISTS (SELECT 1 FROM users WHERE email = ?1 AND password_hash IS NULL AND invite_hash = ?2)";
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE users SET password_hash = NULL, invite_hash = ?1, invite_expires = ?2, reset_hash = NULL, reset_expires = NULL, session_epoch = ?3, updated_at = ?4
         WHERE email = ?5${actor.role === "admin" ? "" : " AND role = 'user'"}`,
      ).bind(invite.hash, invite.expires, crypto.randomUUID(), now, email),
      c.env.DB.prepare(`DELETE FROM auth_factors WHERE email = ?1 AND kind = 'passkey' AND ${reset}`).bind(email, invite.hash),
      c.env.DB.prepare(`DELETE FROM auth_challenges WHERE email = ?1 AND purpose LIKE 'passkey-%' AND ${reset}`).bind(email, invite.hash),
      // Recovery codes recover a method: without one left, they have nothing to recover.
      c.env.DB.prepare(`DELETE FROM recovery_codes WHERE email = ?1 AND NOT EXISTS (SELECT 1 FROM auth_factors WHERE email = ?1) AND ${reset}`).bind(email, invite.hash),
    ]);
    if (!res?.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "invite created", email, by: actor.email }));
    const result: InviteDTO = {
      person: personOf(row, actor, now, await extrasOf(c.env.DB, email)),
      inviteUrl: invite.url,
      inviteExpiresAt: invite.expires,
      ...(await emailInvite(c.env, target, actor, invite, sendEmail)),
    };
    return c.json(result);
  })

  // Pause: they can't sign in, their sessions end and their API keys stop
  // working, until the time given or until someone resumes them. Nothing is
  // deleted. The new session epoch keeps old sessions dead after a resume, and
  // a reset link they'd asked for stops working.
  .post("/:email/pause", validate("param", personParamSchema), validate("json", pauseSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const { until } = c.req.valid("json");
    const target = await managedTarget(c, email, "pause");
    if ("error" in target) return c.json({ error: target.error }, target.status);
    const now = nowSec();
    if (until !== null && until <= now) return c.json({ error: "Choose a time in the future." }, 400);

    const res = await c.env.DB.prepare(
      `UPDATE users SET paused_at = ?1, paused_until = ?2, paused_by = ?3, session_epoch = ?4, reset_hash = NULL, reset_expires = NULL, updated_at = ?1
       WHERE email = ?5${actor.role === "admin" ? "" : " AND role = 'user'"}`,
    )
      .bind(now, until, actor.email, crypto.randomUUID(), email)
      .run();
    if (!res.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "person paused", email, until, by: actor.email }));
    return c.json({ person: personOf(row, actor, now, await extrasOf(c.env.DB, email)) });
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
    return c.json({ person: personOf(row, actor, now, await extrasOf(c.env.DB, email)) });
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
    return c.json({ person: personOf(row, actor, now, await extrasOf(c.env.DB, email)) });
  })

  // For a lost phone: removes their authenticator, passkeys and recovery codes
  // and ends their sessions. Their password stays; at their next login they
  // set two-factor sign-in up again if it's required. Owners can't be reset
  // here (managedTarget): they use a recovery code, or docs/SETUP.md.
  .post("/:email/two-factor/reset", validate("param", personParamSchema), async (c) => {
    const actor = c.get("actor");
    const { email } = c.req.valid("param");
    const target = await managedTarget(c, email, "reset two-factor sign-in for");
    if ("error" in target) return c.json({ error: target.error }, target.status);

    const now = nowSec();
    const epoch = crypto.randomUUID();
    // The deletes only with this very update (its new epoch): if someone promoted them meanwhile,
    // a manager's update matches nothing and their methods stay.
    const didReset = "EXISTS (SELECT 1 FROM users WHERE email = ?1 AND session_epoch = ?2)";
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET session_epoch = ?1, updated_at = ?2 WHERE email = ?3${actor.role === "admin" ? "" : " AND role = 'user'"}`).bind(epoch, now, email),
      c.env.DB.prepare(`DELETE FROM auth_factors WHERE email = ?1 AND ${didReset}`).bind(email, epoch),
      c.env.DB.prepare(`DELETE FROM recovery_codes WHERE email = ?1 AND ${didReset}`).bind(email, epoch),
      c.env.DB.prepare(`DELETE FROM auth_challenges WHERE email = ?1 AND ${didReset}`).bind(email, epoch),
      clearFailuresStmt(c.env.DB, `mfa:${email}`),
    ]);
    if (!res?.meta.changes) return c.json({ error: CHANGED }, 409);
    const row = (await getUser(c.env.DB, email))!;
    console.log(JSON.stringify({ message: "two-factor sign-in reset", email, by: actor.email }));
    const by = actor.name ? `${actor.name} (${actor.email})` : actor.email;
    try {
      c.executionCtx.waitUntil(sendTwoFactorNotice(c.env, email, { kind: "reset", by }));
    } catch {
      await sendTwoFactorNotice(c.env, email, { kind: "reset", by });
    }
    return c.json({ person: personOf(row, actor, now, await extrasOf(c.env.DB, email)) });
  });

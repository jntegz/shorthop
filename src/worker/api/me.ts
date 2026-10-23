import { Hono } from "hono";
import { MAX_FAILS } from "../../shared/login-policy";
import { hashPassword, parsePasswordHash } from "../../shared/password";
import { passwordChangeSchema } from "../../shared/schemas";
import type { MeDTO } from "../../shared/types";
import { adminAuthMode, fullTokenScope, legacyApiToken } from "../auth";
import { getDefaultUtm, nowSec, statsSince } from "../db";
import { demoStatus } from "../demo";
import { configuredAdminHost, configuredDomains, domainsOf, shortOrigin } from "../domains";
import { validate, type AppEnv } from "../hono";
import { chargeAttempt, clearFailuresStmt, getEpoch, issueSessionCookie, lock, loginConfig, verifyPasswordHash } from "../session";
import { getUser } from "../users";

export const meApi = new Hono<AppEnv>()
  .get("/", async (c) => {
    const actor = c.get("actor");
    const [defaultUtm, since, demo] = await Promise.all([getDefaultUtm(c.env.DB), statsSince(c.env.DB), demoStatus(c.env.DB)]);
    const { primary } = domainsOf(c.env);
    const list = configuredDomains(c.env);
    const me: MeDTO = {
      email: actor.email,
      name: actor.name,
      role: actor.role,
      owner: actor.owner,
      permissions: actor.permissions,
      via: actor.via,
      passwordConfigured: loginConfig(c.env) !== null,
      sessionExpiresAt: c.get("sessionExp") ?? null,
      apiTokenSet: actor.role === "admin" ? legacyApiToken(c.env).length >= 16 : null,
      apiTokenScope: actor.role === "admin" ? (fullTokenScope(c.env) ? "full" : "create") : null,
      authMode: adminAuthMode(c.env) ?? "access+password",
      workspace: {
        defaultUtm,
        statsSince: since,
        publicOrigin: shortOrigin(c.env, c.req.raw, primary),
        domains: list,
        primaryDomain: list[0] ?? "",
        adminHost: configuredAdminHost(c.env),
        demo,
      },
    };
    return c.json(me);
  })

  // Changes your own password (owners change ADMIN_PASSWORD_HASH instead). Ends
  // your other sessions; this one gets a new cookie.
  .post("/password", validate("json", passwordChangeSchema), async (c) => {
    const { current, next } = c.req.valid("json");
    const actor = c.get("actor");
    const cfg = loginConfig(c.env);
    const user = await getUser(c.env.DB, actor.email);
    if (!cfg || !user) return c.json({ error: "Passwords can't be changed here." }, 400);

    // Wrong current passwords count like wrong logins, per person.
    const now = nowSec();
    const key = `pw:${user.email}`;
    const state = await chargeAttempt(c.env.DB, key, now);
    if (state.lockedUntil > now) return c.json({ error: "Too many wrong passwords. Try again later." }, 429);
    const stored = user.password_hash ? parsePasswordHash(user.password_hash) : null;
    if (!stored || !(await verifyPasswordHash(current, stored))) {
      if (state.fails >= MAX_FAILS) await lock(c.env.DB, key, now, state.lockouts);
      return c.json({ error: "Your current password is wrong." }, 400);
    }

    const epoch = crypto.randomUUID();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash = ?1, session_epoch = ?2, updated_at = ?3 WHERE email = ?4").bind(
        await hashPassword(next),
        epoch,
        now,
        user.email,
      ),
      clearFailuresStmt(c.env.DB, key),
    ]);
    const { cookie } = await issueSessionCookie(cfg, user.email, { global: await getEpoch(c.env.DB), user: epoch }, now);
    c.header("Set-Cookie", cookie);
    console.log(JSON.stringify({ message: "password changed", email: user.email }));
    return c.json({ changed: true });
  });

import { Hono, type Context } from "hono";
import { aiAvailable } from "../ai";
import { MAX_FAILS, REAUTH_WINDOW_SEC } from "../../shared/login-policy";
import { hashPassword, parsePasswordHash } from "../../shared/password";
import { factorNameSchema, factorParamSchema, passkeyRegisterSchema, passwordChangeSchema, totpConfirmSchema } from "../../shared/schemas";
import type { MeDTO, TwoFactorDTO } from "../../shared/types";
import { adminAuthMode, fullTokenScope, legacyApiToken } from "../auth";
import { getDefaultUtm, nowSec, statsSince } from "../db";
import { demoStatus } from "../demo";
import { configuredAdminHost, configuredDomains } from "../domains";
import { validate, type AppEnv } from "../hono";
import { registrationOptions, relyingParty, verifyRegistration } from "../passkeys";
import { planLimits } from "../plan";
import { chargeAttempt, clearFailuresStmt, getEpoch, issueSessionCookie, lock, loginConfig, verifyPasswordHash, type LoginConfig } from "../session";
import {
  confirmTotpSetup,
  factorDTO,
  newEpochStmt,
  newRecoveryCodes,
  recentSignIn,
  reissueSession,
  sendTwoFactorNotice,
  signedInAt,
  startTotpSetup,
  twoFactorStatus,
  type FactorRow,
  type TwoFactorNotice,
} from "../two-factor";
import { getUser, personIterations } from "../users";
import { getCheckSettings } from "../link-check";

const REAUTH = { error: "For your safety, sign in again before changing two-factor sign-in.", code: "reauth_required" } as const;
const NO_PASSWORD = { error: "Two-factor sign-in needs the admin password login (ADMIN_PASSWORD_HASH and SESSION_SECRET)." } as const;

/** Your own two-factor sign-in, as Settings → Access & security shows it. */
async function twoFactorOf(c: Context<AppEnv>): Promise<TwoFactorDTO> {
  const status = await twoFactorStatus(c.env.DB, c.get("actor").email);
  const exp = c.get("sessionExp");
  return {
    factors: status.factors.map(factorDTO),
    recoveryLeft: status.recoveryLeft,
    required: status.required,
    signedInAt: exp ? signedInAt(exp) : null,
    reauthWindowSec: REAUTH_WINDOW_SEC,
  };
}

/** The login settings, when this session signed in recently enough to change two-factor sign-in. */
function stepUp(c: Context<AppEnv>, now: number): { cfg: LoginConfig } | { refusal: typeof NO_PASSWORD; status: 400 } | { refusal: typeof REAUTH; status: 403 } {
  const cfg = loginConfig(c.env);
  if (!cfg) return { refusal: NO_PASSWORD, status: 400 };
  if (!recentSignIn(c.get("sessionExp"), now)) return { refusal: REAUTH, status: 403 };
  return { cfg };
}

/** Runs after the response when the runtime allows it. */
function later(c: Context<AppEnv>, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work;
  }
}

const factorLabel = (f: Pick<FactorRow, "kind" | "name">) => (f.kind === "totp" ? "An authenticator app" : `The passkey “${f.name}”`);

/**
 * Commits a two-factor change with a new personal epoch, so every other
 * session of this person ends; this one gets a cookie for the new epoch with
 * its sign-in time unchanged.
 */
async function commitChange(c: Context<AppEnv>, cfg: LoginConfig, now: number, stmts: D1PreparedStatement[], notice: TwoFactorNotice): Promise<void> {
  const actor = c.get("actor");
  const epoch = newEpochStmt(c.env.DB, actor.email, actor.owner, now);
  await c.env.DB.batch([...stmts, epoch.stmt]);
  c.header("Set-Cookie", await reissueSession(c.env.DB, cfg, actor.email, epoch.own, c.get("sessionExp"), now));
  later(c, sendTwoFactorNotice(c.env, actor.email, notice));
}

export const meApi = new Hono<AppEnv>()
  .get("/", async (c) => {
    const actor = c.get("actor");
    const [defaultUtm, since, demo, checks] = await Promise.all([getDefaultUtm(c.env.DB), statsSince(c.env.DB), demoStatus(c.env.DB), getCheckSettings(c.env.DB)]);
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
        domains: list,
        primaryDomain: list[0] ?? "",
        adminHost: configuredAdminHost(c.env),
        demo,
        importRows: planLimits(c.env).importRows,
        bulkRows: planLimits(c.env).bulkRows,
        aiAvailable: aiAvailable(c.env),
        codeMode: Boolean(c.env.LOADER),
        checkScope: checks.scope,
        fallbackUrl: c.env.FALLBACK_URL,
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
      // An emailed reset link (or an invitation) still waiting must not outlive the new password.
      c.env.DB.prepare(
        "UPDATE users SET password_hash = ?1, session_epoch = ?2, reset_hash = NULL, reset_expires = NULL, invite_hash = NULL, invite_expires = NULL, updated_at = ?3 WHERE email = ?4",
      ).bind(
        await hashPassword(next, personIterations(c.env)),
        epoch,
        now,
        user.email,
      ),
      // Passkeys sign in without the password, so changing the password revokes them too.
      c.env.DB.prepare("DELETE FROM auth_factors WHERE email = ?1 AND kind = 'passkey'").bind(user.email),
      c.env.DB.prepare("DELETE FROM auth_challenges WHERE email = ?1 AND purpose LIKE 'passkey-%'").bind(user.email),
      c.env.DB.prepare("DELETE FROM recovery_codes WHERE email = ?1 AND NOT EXISTS (SELECT 1 FROM auth_factors WHERE email = ?1)").bind(user.email),
      clearFailuresStmt(c.env.DB, key),
    ]);
    // Same end, so a password change doesn't count as a fresh sign-in (two-factor changes need one).
    const { cookie } = await issueSessionCookie(cfg, user.email, { global: await getEpoch(c.env.DB), user: epoch }, now, c.get("sessionExp"));
    c.header("Set-Cookie", cookie);
    console.log(JSON.stringify({ message: "password changed", email: user.email }));
    return c.json({ changed: true });
  })

  // --- Two-factor sign-in (each person their own, owners included) ---

  .get("/security", async (c) => c.json(await twoFactorOf(c)))

  // A new authenticator secret, shown as a QR code. It becomes a sign-in
  // method only once a code from it is confirmed.
  .post("/totp/setup", async (c) => {
    const now = nowSec();
    const ok = stepUp(c, now);
    if ("refusal" in ok) return c.json(ok.refusal, ok.status);
    const email = c.get("actor").email;
    const status = await twoFactorStatus(c.env.DB, email);
    if (status.factors.some((f) => f.kind === "totp")) return c.json({ error: "You already have an authenticator app. Remove it first to use another." }, 409);
    return c.json(await startTotpSetup(c.env, email, new URL(c.req.url).hostname, now));
  })

  .post("/totp/confirm", validate("json", totpConfirmSchema), async (c) => {
    const now = nowSec();
    const ok = stepUp(c, now);
    if ("refusal" in ok) return c.json(ok.refusal, ok.status);
    const { code, name } = c.req.valid("json");
    const email = c.get("actor").email;
    // Wrong codes count like wrong passwords, per person.
    const key = `mfa:setup:${email}`;
    const state = await chargeAttempt(c.env.DB, key, now);
    if (state.lockedUntil > now) return c.json({ error: "Too many wrong codes. Try again later." }, 429);
    // Only reachable by parallel requests that were all counted before a lock was written.
    if (state.fails > MAX_FAILS) {
      await lock(c.env.DB, key, now, state.lockouts);
      return c.json({ error: "Too many wrong codes. Try again later." }, 429);
    }
    const before = await twoFactorStatus(c.env.DB, email);
    const result = await confirmTotpSetup(c.env, email, code, name ?? "", now);
    if (!result.ok) {
      if (result.reason === "wrong" && state.fails >= MAX_FAILS) await lock(c.env.DB, key, now, state.lockouts);
      const error =
        result.reason === "wrong"
          ? "That code didn't work. Check the time on your phone, and enter the code the app shows now."
          : result.reason === "expired"
            ? "That setup expired. Start again."
            : "You already have an authenticator app.";
      return c.json({ error }, result.reason === "exists" ? 409 : 400);
    }
    // The first method comes with recovery codes, for a lost phone.
    const codes = before.factors.length === 0 ? await newRecoveryCodes(c.env.DB, email, now) : null;
    await commitChange(c, ok.cfg, now, [clearFailuresStmt(c.env.DB, key), ...(codes?.stmts ?? [])], { kind: "added", factor: factorLabel(result.factor) });
    console.log(JSON.stringify({ message: "two-factor sign-in set up", email, kind: "totp" }));
    return c.json({ twoFactor: await twoFactorOf(c), recoveryCodes: codes?.codes ?? null });
  })

  // A passkey: the browser makes it from these options, then it's checked and saved.
  .post("/passkeys/options", async (c) => {
    const now = nowSec();
    const ok = stepUp(c, now);
    if ("refusal" in ok) return c.json(ok.refusal, ok.status);
    const options = await registrationOptions(c.env.DB, c.get("actor").email, relyingParty(c.req.url), now);
    if (!options) return c.json({ error: "You have the most passkeys allowed. Remove one first." }, 409);
    return c.json({ options });
  })

  .post("/passkeys", validate("json", passkeyRegisterSchema), async (c) => {
    const now = nowSec();
    const ok = stepUp(c, now);
    if ("refusal" in ok) return c.json(ok.refusal, ok.status);
    const { response, name } = c.req.valid("json");
    const email = c.get("actor").email;
    const before = await twoFactorStatus(c.env.DB, email);
    const result = await verifyRegistration(c.env.DB, email, response as never, name ?? "", relyingParty(c.req.url), now);
    if (!result.ok) {
      const error = {
        expired: "That took too long. Try again.",
        invalid: "The passkey couldn't be checked. Try again, or with another device.",
        exists: "That passkey is already added.",
        "too-many": "You have the most passkeys allowed. Remove one first.",
      }[result.reason];
      return c.json({ error }, result.reason === "exists" || result.reason === "too-many" ? 409 : 400);
    }
    const codes = before.factors.length === 0 ? await newRecoveryCodes(c.env.DB, email, now) : null;
    await commitChange(c, ok.cfg, now, codes?.stmts ?? [], { kind: "added", factor: factorLabel(result.factor) });
    console.log(JSON.stringify({ message: "two-factor sign-in set up", email, kind: "passkey" }));
    return c.json({ twoFactor: await twoFactorOf(c), recoveryCodes: codes?.codes ?? null });
  })

  // Renaming is harmless: no recent sign-in needed.
  .patch("/factors/:id", validate("param", factorParamSchema), validate("json", factorNameSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const res = await c.env.DB.prepare("UPDATE auth_factors SET name = ? WHERE id = ? AND email = ?").bind(name, id, c.get("actor").email).run();
    if (!res.meta.changes) return c.json({ error: "Not found" }, 404);
    return c.json(await twoFactorOf(c));
  })

  .delete("/factors/:id", validate("param", factorParamSchema), async (c) => {
    const now = nowSec();
    const ok = stepUp(c, now);
    if ("refusal" in ok) return c.json(ok.refusal, ok.status);
    const { id } = c.req.valid("param");
    const email = c.get("actor").email;
    const status = await twoFactorStatus(c.env.DB, email);
    const factor = status.factors.find((f) => f.id === id);
    if (!factor) return c.json({ error: "Not found" }, 404);
    const last = status.factors.length === 1;
    if (last && status.required) return c.json({ error: "An admin requires two-factor sign-in, so you can't remove your last method. Add another one first." }, 409);
    await commitChange(
      c,
      ok.cfg,
      now,
      [
        c.env.DB.prepare("DELETE FROM auth_factors WHERE id = ? AND email = ?").bind(id, email),
        // Without any method, recovery codes have nothing to recover.
        ...(last ? [c.env.DB.prepare("DELETE FROM recovery_codes WHERE email = ?").bind(email)] : []),
      ],
      { kind: "removed", factor: factorLabel(factor) },
    );
    console.log(JSON.stringify({ message: "two-factor method removed", email, kind: factor.kind, last }));
    return c.json(await twoFactorOf(c));
  })

  // A new set of recovery codes; the old ones stop working.
  .post("/recovery-codes", async (c) => {
    const now = nowSec();
    const ok = stepUp(c, now);
    if ("refusal" in ok) return c.json(ok.refusal, ok.status);
    const email = c.get("actor").email;
    const status = await twoFactorStatus(c.env.DB, email);
    if (!status.factors.length) return c.json({ error: "Set up two-factor sign-in first." }, 409);
    const { codes, stmts } = await newRecoveryCodes(c.env.DB, email, now);
    await c.env.DB.batch(stmts);
    later(c, sendTwoFactorNotice(c.env, email, { kind: "codes" }));
    console.log(JSON.stringify({ message: "recovery codes replaced", email }));
    return c.json({ twoFactor: await twoFactorOf(c), recoveryCodes: codes });
  });

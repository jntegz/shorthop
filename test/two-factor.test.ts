import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MFA_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from "../src/shared/login-policy";
import { nowSec } from "../src/worker/db";
import { getEpoch, issueSessionCookie, loginConfig } from "../src/worker/session";
import { OWNER_EPOCH } from "../src/worker/users";
import { base32Decode, newTotpSecret, totpCode, totpStep } from "../src/worker/totp";
import { newRecoveryCodes, pendingTotpSecret } from "../src/worker/two-factor";
import { sha256Hex } from "../src/worker/users";
import { decryptSecret, encryptSecret } from "../src/worker/webhooks";
import { api, cookies, form, jwtFor, LOGIN_ENV, OWNER, page, PASSWORD, PERSON, run, useAccess } from "./access";
import { call, ORIGIN } from "./helpers";
import { addUser, adminCall } from "./people";

useAccess();

/** An authenticator for `email`, with the secret to make codes from. */
async function addTotp(email: string): Promise<string> {
  const secret = newTotpSecret();
  await env.DB.prepare("INSERT INTO auth_factors (id, email, kind, name, secret_enc, created_at) VALUES (?, ?, 'totp', 'Phone', ?, ?)")
    .bind(`f_${crypto.randomUUID().slice(0, 12)}`, email, await encryptSecret(env as unknown as Env, "totp", secret), nowSec())
    .run();
  return secret;
}

const codeFor = (secret: string, offset = 0) => totpCode(base32Decode(secret)!, totpStep(nowSec()) + offset);

/** The password step; returns its response and the second step's cookie. */
async function passwordStep(jwt: string, next = "/_admin/links") {
  const res = await run(form("/_admin/login", jwt, { password: PASSWORD, next }));
  return { res, mfa: cookies(res)[MFA_COOKIE] ?? "" };
}

/** A fresh owner session (signed in just now). */
async function ownerSession(): Promise<string> {
  const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
  const { cookie } = await issueSessionCookie(cfg, OWNER, { global: await getEpoch(env.DB), user: OWNER_EPOCH }, nowSec());
  return cookie.split(";")[0]!;
}

async function fullLogin(jwt: string): Promise<string> {
  const res = await run(form("/_admin/login", jwt, { password: PASSWORD }));
  const session = cookies(res)[SESSION_COOKIE];
  expect(session).toBeTruthy();
  return session!;
}

describe("the second step at login", () => {
  it("asks for a code after the right password instead of starting a session", async () => {
    await addTotp(OWNER);
    const jwt = await jwtFor(OWNER);
    const { res, mfa } = await passwordStep(jwt);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/_admin/login/2fa?next=%2F_admin%2Flinks");
    expect(mfa).toMatch(new RegExp(`^${MFA_COOKIE}=m1\\.`));
    expect(res.headers.getSetCookie().join("\n")).not.toContain(`${SESSION_COOKIE}=`);
    expect(res.headers.getSetCookie()[0]).toContain("HttpOnly; Secure; SameSite=Strict");
    // The second step's cookie is no session.
    expect((await run(api("/links", jwt, mfa))).status).toBe(401);
    const shown = await run(page("/_admin/login/2fa?next=%2F_admin%2Flinks", jwt, mfa));
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain('autocomplete="one-time-code"');
  });

  it("signs in with the code, once, and records how", async () => {
    const secret = await addTotp(OWNER);
    const jwt = await jwtFor(OWNER);
    const { mfa } = await passwordStep(jwt);
    const code = await codeFor(secret);
    const res = await run(form("/_admin/login/2fa", jwt, { code, next: "/_admin/links" }, mfa));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/_admin/links");
    const set = cookies(res);
    expect(set[MFA_COOKIE]).toBe(`${MFA_COOKIE}=`);
    expect((await run(api("/links", jwt, set[SESSION_COOKIE]!))).status).toBe(200);
    const event = await env.DB.prepare("SELECT ok, method FROM login_events ORDER BY ts DESC LIMIT 1").first();
    expect(event).toEqual({ ok: 1, method: "password+totp" });

    // The same code doesn't work twice.
    const again = await passwordStep(jwt);
    const replay = await run(form("/_admin/login/2fa", jwt, { code }, again.mfa));
    expect(replay.status).toBe(401);
    expect(await replay.text()).toContain("That code didn&#39;t work");
  });

  it("locks the person out after 5 wrong codes, from any network", async () => {
    await addTotp(OWNER);
    const jwt = await jwtFor(OWNER);
    const { mfa } = await passwordStep(jwt);
    for (let i = 0; i < 4; i++) expect((await run(form("/_admin/login/2fa", jwt, { code: "000000" }, mfa))).status).toBe(401);
    const fifth = await run(form("/_admin/login/2fa", jwt, { code: "000000" }, mfa));
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("Retry-After")).toBe("60");
    const row = await env.DB.prepare("SELECT locked_until FROM auth_failures WHERE key = ?").bind(`mfa:${OWNER}`).first<{ locked_until: number }>();
    expect(row!.locked_until).toBeGreaterThan(nowSec());
  });

  it("starts again at the password without the step's cookie, or after the password changes", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    await addTotp(PERSON);
    const jwt = await jwtFor(PERSON);
    const none = await run(page("/_admin/login/2fa", jwt));
    expect(none.status).toBe(303);
    expect(none.headers.get("Location")).toBe("/_admin/login?next=%2F_admin%2F");

    const { mfa } = await passwordStep(jwt);
    await env.DB.prepare("UPDATE users SET session_epoch = 'changed' WHERE email = ?").bind(PERSON).run();
    const stale = await run(page("/_admin/login/2fa", jwt, mfa));
    expect(stale.status).toBe(303);
    expect(stale.headers.get("Location"), String(stale.headers.get("Location"))).toContain("/_admin/login?");
    // Bound to the Access identity it was made for.
    expect((await run(page("/_admin/login/2fa", await jwtFor(OWNER), mfa))).status).toBe(303);
  });

  it("takes a recovery code once, and says how many are left", async () => {
    await addTotp(OWNER);
    const { codes, stmts } = await newRecoveryCodes(env.DB, OWNER, nowSec());
    await env.DB.batch(stmts);
    const jwt = await jwtFor(OWNER);
    const first = await passwordStep(jwt);
    const ok = await run(form("/_admin/login/2fa", jwt, { code: codes[0]!.toUpperCase() }, first.mfa));
    expect(ok.status).toBe(303);
    expect(cookies(ok)[SESSION_COOKIE]).toBeTruthy();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL").first<{ n: number }>();
    expect(left!.n).toBe(9);

    const second = await passwordStep(jwt);
    expect((await run(form("/_admin/login/2fa", jwt, { code: codes[0]! }, second.mfa))).status).toBe(401);
  });

  it("still asks for the code after a password reset link", async () => {
    const token = "r".repeat(43);
    await addUser(PERSON, "user", [], { password: "old-password-123456" });
    await env.DB.prepare("UPDATE users SET reset_hash = ?, reset_expires = ? WHERE email = ?").bind(await sha256Hex(token), nowSec() + 3600, PERSON).run();
    await addTotp(PERSON);
    const jwt = await jwtFor(PERSON);
    const res = await run(form(`/_admin/reset/${token}`, jwt, { password: PASSWORD, confirm: PASSWORD }));
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/_admin/login/2fa?next=%2F_admin%2F");
    expect(cookies(res)[SESSION_COOKIE]).toBeUndefined();
    expect(cookies(res)[MFA_COOKIE]).toBeTruthy();
  });
});

describe("requiring two-factor sign-in", () => {
  it("sends people without it to set it up before their first session", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('require_2fa', '1')").run();
    const jwt = await jwtFor(PERSON);
    const { res, mfa } = await passwordStep(jwt);
    expect(res.headers.get("Location")).toBe("/_admin/login/2fa-setup?next=%2F_admin%2Flinks");

    const setup = await run(page("/_admin/login/2fa-setup?next=%2F_admin%2Flinks", jwt, mfa));
    expect(setup.status).toBe(200);
    const html = await setup.text();
    expect(html).toContain('<svg class="qr"');
    const secret = (await pendingTotpSecret(env as unknown as Env, PERSON, nowSec(), "totp-setup-login"))!;
    // Settings' own setup (another flow) never shows it.
    expect(await pendingTotpSecret(env as unknown as Env, PERSON, nowSec())).toBeNull();
    expect(html).toContain(secret.slice(0, 4));

    expect((await run(form("/_admin/login/2fa-setup", jwt, { code: "000000", next: "/_admin/links" }, mfa))).status).toBe(401);
    const done = await run(form("/_admin/login/2fa-setup", jwt, { code: await codeFor(secret), next: "/_admin/links" }, mfa));
    expect(done.status).toBe(200);
    const body = await done.text();
    expect(body.match(/<li>[a-z0-9]{5}-[a-z0-9]{5}<\/li>/g)).toHaveLength(10);
    expect(body).toContain('href="/_admin/links"');
    const session = cookies(done)[SESSION_COOKIE]!;
    expect((await run(api("/me/security", jwt, session))).status).toBe(200);
    expect((await env.DB.prepare("SELECT kind FROM auth_factors WHERE email = ?").bind(PERSON).first())?.kind).toBe("totp");
  });

  it("shows admins who still has to set it up", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    await addTotp(OWNER);
    const jwt = await jwtFor(OWNER);
    const session = await ownerSession();
    // The owner (with an authenticator) and the person (without one).
    const res = await run(api("/settings/two-factor", jwt, session, { method: "PUT", body: { required: true } }));
    expect(await res.json()).toMatchObject({ require2fa: true, peopleWithout2fa: 1 });
    expect((await run(api("/settings/two-factor", jwt, session, { method: "PUT", body: { required: "yes" } }))).status).toBe(400);
    // Not with an API key, even an admin's.
    const key = await call(new Request(`${ORIGIN}/api/settings/two-factor`, { method: "PUT", headers: { Authorization: "Bearer test-api-token-0123456789abcdef", "Content-Type": "application/json" }, body: JSON.stringify({ required: false }) }));
    expect(key.status).toBe(403);
  });
});

describe("requiring it, after the security review", () => {
  it("can't be turned on by an admin who doesn't have it, who would be signed out by it", async () => {
    const res = await run(api("/settings/two-factor", await jwtFor(OWNER), await ownerSession(), { method: "PUT", body: { required: true } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "own_2fa_missing" });
    expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'require_2fa'").first()).toBeNull();
  });

  it("ends sessions from before the rule of people who don't have it", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    const jwt = await jwtFor(PERSON);
    const session = await fullLogin(jwt);
    expect((await run(api("/me", jwt, session))).status).toBe(200);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('require_2fa', '1')").run();
    expect((await run(api("/me", jwt, session))).status).toBe(401);
    // Someone who has it keeps theirs.
    await addTotp(OWNER);
    expect((await run(api("/links", await jwtFor(OWNER), await ownerSession()))).status).toBe(200);
  });

  it("ends other sessions when it's set up at the login", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    const jwt = await jwtFor(PERSON);
    const before = await fullLogin(jwt);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('require_2fa', '1')").run();
    const { mfa } = await passwordStep(jwt);
    await run(page("/_admin/login/2fa-setup", jwt, mfa));
    const secret = (await pendingTotpSecret(env as unknown as Env, PERSON, nowSec(), "totp-setup-login"))!;
    const done = await run(form("/_admin/login/2fa-setup", jwt, { code: await codeFor(secret), next: "/_admin/links" }, mfa));
    expect(done.status).toBe(200);
    expect((await run(api("/me", jwt, cookies(done)[SESSION_COOKIE]!))).status).toBe(200);
    // The old cookie has the old epoch: gone even though they have a method now.
    expect((await run(api("/me", jwt, before))).status).toBe(401);
  });
});

describe("managing your own two-factor sign-in", () => {
  it("sets up an authenticator, with recovery codes, and ends other sessions", async () => {
    const jwt = await jwtFor(OWNER);
    const session = await fullLogin(jwt);
    const other = await fullLogin(jwt);

    const setup = await run(api("/me/totp/setup", jwt, session, { method: "POST" }));
    expect(setup.status).toBe(200);
    const { secret, uri } = (await setup.json()) as { secret: string; uri: string };
    expect(uri).toContain(`secret=${secret}`);

    const bad = await run(api("/me/totp/confirm", jwt, session, { body: { code: "000000" } }));
    expect(bad.status).toBe(400);
    const ok = await run(api("/me/totp/confirm", jwt, session, { body: { code: await codeFor(secret), name: "My phone" } }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { recoveryCodes: string[]; twoFactor: { factors: { name: string; kind: string }[]; recoveryLeft: number } };
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.twoFactor.factors).toEqual([expect.objectContaining({ kind: "totp", name: "My phone" })]);
    expect(body.twoFactor.recoveryLeft).toBe(10);

    // This session goes on with its new cookie; the other one ended.
    const renewed = cookies(ok)[SESSION_COOKIE]!;
    expect((await run(api("/me/security", jwt, renewed))).status).toBe(200);
    expect((await run(api("/me/security", jwt, other))).status).toBe(401);
    // The second authenticator is refused.
    expect((await run(api("/me/totp/setup", jwt, renewed, { method: "POST" }))).status).toBe(409);
  });

  it("keeps owner sessions made before any change valid", async () => {
    const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
    const now = nowSec();
    const { cookie } = await issueSessionCookie(cfg, OWNER, { global: await getEpoch(env.DB), user: OWNER_EPOCH }, now);
    expect((await run(api("/me/security", await jwtFor(OWNER), cookie.split(";")[0]!))).status).toBe(200);
  });

  it("needs a recent sign-in to change anything", async () => {
    const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
    const now = nowSec();
    // Signed in 20 minutes ago.
    const { cookie } = await issueSessionCookie(cfg, OWNER, { global: await getEpoch(env.DB), user: OWNER_EPOCH }, now - 20 * 60);
    const jwt = await jwtFor(OWNER);
    const res = await run(api("/me/totp/setup", jwt, cookie.split(";")[0]!, { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "reauth_required" });
    const security = (await (await run(api("/me/security", jwt, cookie.split(";")[0]!))).json()) as { signedInAt: number };
    expect(security.signedInAt).toBe(now - 20 * 60);
    expect(SESSION_TTL_SEC).toBeGreaterThan(20 * 60);

    // Signing in again on purpose shows the password form even with a session.
    const reauth = await run(page("/_admin/login?reauth=1&next=%2F_admin%2Fsettings", jwt, cookie.split(";")[0]!));
    expect(reauth.status).toBe(200);
    expect(await reauth.text()).toContain("Enter your password");
  });

  it("doesn't count a password change as a fresh sign-in", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
    const user = await env.DB.prepare("SELECT session_epoch FROM users WHERE email = ?").bind(PERSON).first<{ session_epoch: string }>();
    const old = await issueSessionCookie(cfg, PERSON, { global: await getEpoch(env.DB), user: user!.session_epoch }, nowSec() - 20 * 60);
    const jwt = await jwtFor(PERSON);
    const changed = await run(api("/me/password", jwt, old.cookie.split(";")[0]!, { body: { current: PASSWORD, next: `${PASSWORD}-new` } }));
    expect(changed.status).toBe(200);
    const renewed = cookies(changed)[SESSION_COOKIE]!;
    const res = await run(api("/me/totp/setup", jwt, renewed, { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "reauth_required" });
  });

  it("won't remove the last method while it's required, and removes codes with it otherwise", async () => {
    await addTotp(OWNER);
    const { stmts } = await newRecoveryCodes(env.DB, OWNER, nowSec());
    await env.DB.batch(stmts);
    const jwt = await jwtFor(OWNER);
    const { mfa } = await passwordStep(jwt);
    const row = await env.DB.prepare("SELECT secret_enc FROM auth_factors WHERE email = ?").bind(OWNER).first<{ secret_enc: string }>();
    const secret = (await decryptSecret(env as unknown as Env, "totp", row!.secret_enc))!;
    const login = await run(form("/_admin/login/2fa", jwt, { code: await codeFor(secret) }, mfa));
    let session = cookies(login)[SESSION_COOKIE]!;
    const { factors } = (await (await run(api("/me/security", jwt, session))).json()) as { factors: { id: string }[] };

    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('require_2fa', '1')").run();
    expect((await run(api(`/me/factors/${factors[0]!.id}`, jwt, session, { method: "DELETE" }))).status).toBe(409);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'require_2fa'").run();

    const removed = await run(api(`/me/factors/${factors[0]!.id}`, jwt, session, { method: "DELETE" }));
    expect(removed.status).toBe(200);
    session = cookies(removed)[SESSION_COOKIE]!;
    expect(await removed.json()).toMatchObject({ factors: [], recoveryLeft: 0 });
    // Without a method, the password alone signs in again.
    expect(cookies(await run(form("/_admin/login", jwt, { password: PASSWORD })))[SESSION_COOKIE]).toBeTruthy();
  });

  it("isn't available with an API key", async () => {
    const res = await call(new Request(`${ORIGIN}/api/me/security`, { headers: { Authorization: "Bearer test-api-token-0123456789abcdef" } }));
    expect(res.status).toBe(403);
  });
});

describe("an admin resetting someone's two-factor sign-in", () => {
  it("removes their methods and codes and ends their sessions; owners can't be reset here", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    await addTotp(PERSON);
    const { stmts } = await newRecoveryCodes(env.DB, PERSON, nowSec());
    await env.DB.batch(stmts);
    const before = await env.DB.prepare("SELECT session_epoch FROM users WHERE email = ?").bind(PERSON).first<{ session_epoch: string }>();

    const list = (await (await adminCall("", "/users")).json()) as { people: { email: string; twoFactor: boolean }[] };
    expect(list.people.find((p) => p.email === PERSON)?.twoFactor).toBe(true);

    const res = await adminCall("", `/users/${PERSON}/two-factor/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ person: { email: PERSON, twoFactor: false } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes").first<{ n: number }>())!.n).toBe(0);
    const after = await env.DB.prepare("SELECT session_epoch FROM users WHERE email = ?").bind(PERSON).first<{ session_epoch: string }>();
    expect(after!.session_epoch).not.toBe(before!.session_epoch);

    await addTotp(OWNER);
    expect((await adminCall("", `/users/${OWNER}/two-factor/reset`, { method: "POST" }, { ADMIN_EMAIL: OWNER })).status).toBe(404);
  });

  it("removes them along with the person", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    await addTotp(PERSON);
    expect((await adminCall("", `/users/${PERSON}`, { method: "DELETE" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_factors").first<{ n: number }>())!.n).toBe(0);
  });
});

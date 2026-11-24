import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MFA_COOKIE, SESSION_COOKIE } from "../src/shared/login-policy";
import { nowSec } from "../src/worker/db";
import { loginOptions, registrationOptions, relyingParty, verifyLogin, verifyRegistration } from "../src/worker/passkeys";
import { passkeyKey } from "../src/worker/login";
import { getEpoch, ipHash, issueSessionCookie, loginConfig } from "../src/worker/session";
import { OWNER_EPOCH } from "../src/worker/users";
import { api, cookies, form, jwtFor, LOGIN_ENV, loginJson, OWNER, page, PASSWORD, PERSON, run, useAccess } from "./access";
import { ORIGIN } from "./helpers";
import { addUser } from "./people";
import { softPasskey, type SoftPasskey } from "./webauthn";

useAccess();

const RP = relyingParty(`${ORIGIN}/_admin/login`);

/** A fresh owner session (signed in just now). */
async function ownerSession(): Promise<string> {
  const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
  const { cookie } = await issueSessionCookie(cfg, OWNER, { global: await getEpoch(env.DB), user: OWNER_EPOCH }, nowSec());
  return cookie.split(";")[0]!;
}

/** Adds a passkey for `email` straight through the module (no session needed). */
async function addPasskey(email: string): Promise<SoftPasskey> {
  const key = await softPasskey();
  const options = (await registrationOptions(env.DB, email, RP, nowSec()))!;
  const res = await verifyRegistration(env.DB, email, (await key.register(options, ORIGIN)) as never, "Test key", RP, nowSec());
  expect(res.ok).toBe(true);
  return key;
}

/** Signs in with the passkey over HTTP, as the login page's script does. */
async function passkeyLogin(jwt: string, key: SoftPasskey, opts: { counter?: number; userVerified?: boolean; next?: string } = {}) {
  const start = await run(loginJson("/_admin/login/passkey/options", jwt, {}));
  expect(start.status).toBe(200);
  const { options } = (await start.json()) as { options: { challenge: string; rpId: string } };
  const response = await key.signIn(options, ORIGIN, opts);
  return { response, res: await run(loginJson("/_admin/login/passkey", jwt, { response, next: opts.next ?? "/_admin/links" })) };
}

describe("adding a passkey in Settings", () => {
  it("registers one with recovery codes when it's the first method", async () => {
    const jwt = await jwtFor(OWNER);
    const session = await ownerSession();
    const start = await run(api("/me/passkeys/options", jwt, session, { method: "POST" }));
    expect(start.status).toBe(200);
    const { options } = (await start.json()) as { options: { challenge: string; rp: { id: string }; authenticatorSelection: unknown } };
    expect(options.rp.id).toBe(new URL(ORIGIN).hostname);
    expect(options.authenticatorSelection).toMatchObject({ userVerification: "required" });

    const key = await softPasskey();
    const saved = await run(api("/me/passkeys", jwt, session, { body: { response: await key.register(options, ORIGIN), name: "MacBook" } }));
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { recoveryCodes: string[]; twoFactor: { factors: { kind: string; name: string }[] } };
    expect(body.twoFactor.factors).toEqual([expect.objectContaining({ kind: "passkey", name: "MacBook" })]);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(cookies(saved)[SESSION_COOKIE]).toBeTruthy();

    // The same answer can't be used again: the challenge is gone.
    const again = await run(api("/me/passkeys", jwt, cookies(saved)[SESSION_COOKIE]!, { body: { response: await key.register(options, ORIGIN) } }));
    expect(again.status).toBe(400);
  });

  it("refuses an answer made for another site", async () => {
    const jwt = await jwtFor(OWNER);
    const session = await ownerSession();
    const { options } = (await (await run(api("/me/passkeys/options", jwt, session, { method: "POST" }))).json()) as { options: { challenge: string; rp: { id: string } } };
    const key = await softPasskey();
    const phished = await key.register({ ...options, rp: { id: "evil.example" } }, "https://evil.example");
    expect((await run(api("/me/passkeys", jwt, session, { body: { response: phished } }))).status).toBe(400);
  });
});

describe("signing in with a passkey", () => {
  it("offers it on the login page with one same-origin script", async () => {
    await addPasskey(OWNER);
    const jwt = await jwtFor(OWNER);
    const res = await run(page("/_admin/login", jwt));
    const html = await res.text();
    expect(html).toContain("Sign in with a passkey");
    expect(html).toContain('<script src="/_admin/login/passkey.js" defer></script>');
    // Exactly that one script may run, not any file on the host.
    expect(res.headers.get("Content-Security-Policy")).toContain(`script-src ${ORIGIN}/_admin/login/passkey.js; connect-src 'self';`);
    expect(res.headers.get("Content-Security-Policy")).not.toContain("script-src 'self'");
    const script = await run(page("/_admin/login/passkey.js", jwt));
    expect(script.headers.get("Content-Type")).toContain("text/javascript");
    expect(await script.text()).toContain("navigator.credentials.get");

    // Without a passkey, the page keeps no scripts at all.
    const other = await run(page("/_admin/login", await jwtFor("someone@example.com")));
    expect(other.headers.get("Content-Security-Policy")).not.toContain("script-src");
  });

  it("signs in with the passkey alone (no password, no code) and records it", async () => {
    const key = await addPasskey(OWNER);
    const jwt = await jwtFor(OWNER);
    const { res } = await passkeyLogin(jwt, key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/_admin/links" });
    const set = cookies(res);
    expect(set[MFA_COOKIE]).toBe(`${MFA_COOKIE}=`);
    expect((await run(api("/links", jwt, set[SESSION_COOKIE]!))).status).toBe(200);
    expect(await env.DB.prepare("SELECT ok, method FROM login_events ORDER BY ts DESC LIMIT 1").first()).toEqual({ ok: 1, method: "passkey" });
  });

  it("also finishes the second step after a password", async () => {
    const key = await addPasskey(OWNER);
    const jwt = await jwtFor(OWNER);
    const pw = await run(form("/_admin/login", jwt, { password: PASSWORD }));
    expect(pw.headers.get("Location")).toContain("/_admin/login/2fa");
    const step = await run(page("/_admin/login/2fa", jwt, cookies(pw)[MFA_COOKIE]!));
    expect(await step.text()).toContain("Use a passkey");
    const { res } = await passkeyLogin(jwt, key);
    expect(res.status).toBe(200);
  });

  it("refuses another person's passkey", async () => {
    const owners = await addPasskey(OWNER);
    await addUser(PERSON, "user", [], { password: PASSWORD });
    await addPasskey(PERSON);
    const jwt = await jwtFor(PERSON);
    const { res } = await passkeyLogin(jwt, owners);
    expect(res.status).toBe(401);
    expect(cookies(res)[SESSION_COOKIE]).toBeUndefined();
  });

  it("refuses a counter that goes backwards, an unverified user and a reused answer", async () => {
    const key = await addPasskey(OWNER);
    const jwt = await jwtFor(OWNER);
    expect((await passkeyLogin(jwt, key, { counter: 5 })).res.status).toBe(200);
    expect((await passkeyLogin(jwt, key, { counter: 3 })).res.status).toBe(401);
    expect((await passkeyLogin(jwt, key, { counter: 9, userVerified: false })).res.status).toBe(401);

    const { response, res } = await passkeyLogin(jwt, key, { counter: 10 });
    expect(res.status).toBe(200);
    expect((await run(loginJson("/_admin/login/passkey", jwt, { response }))).status).toBe(401);
  });

  it("locks the network after 5 failures, counting each try before it's checked", async () => {
    const key = await addPasskey(OWNER);
    const jwt = await jwtFor(OWNER);
    for (let i = 0; i < 5; i++) await passkeyLogin(jwt, key, { userVerified: false });
    const locked = await run(loginJson("/_admin/login/passkey/options", jwt, {}));
    expect(locked.status).toBe(429);
    // Even a right answer waits for the lock to lift.
    const netKey = passkeyKey(await ipHash(loginConfig({ ...env, ...LOGIN_ENV } as Env)!, "203.0.113.50"));
    await env.DB.prepare("UPDATE auth_failures SET locked_until = 0 WHERE key = ?").bind(netKey).run();
    const { response } = await (async () => {
      const opts = (await (await run(loginJson("/_admin/login/passkey/options", jwt, {}))).json()) as { options: { challenge: string; rpId: string } };
      return { response: await key.signIn(opts.options, ORIGIN) };
    })();
    await env.DB.prepare("UPDATE auth_failures SET locked_until = ? WHERE key = ?").bind(nowSec() + 60, netKey).run();
    expect((await run(loginJson("/_admin/login/passkey", jwt, { response }))).status).toBe(429);
  });

  it("never locks the person's second step: the passkey pages need no password, so anyone can post to them", async () => {
    const key = await addPasskey(OWNER);
    const jwt = await jwtFor(OWNER);
    for (let i = 0; i < 6; i++) await run(loginJson("/_admin/login/passkey", jwt, { response: { id: "x", rawId: "x", type: "public-key", response: {}, clientExtensionResults: {} } }));
    // Codes and recovery codes stay open: nothing was charged to the person.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE key = ?").bind(`mfa:${OWNER}`).first<{ n: number }>()).toEqual({ n: 0 });
    // Another network still signs in with the passkey.
    const elsewhere = (r: Request) => {
      const h = new Headers(r.headers);
      h.set("CF-Connecting-IP", "198.51.100.7");
      return new Request(r, { headers: h });
    };
    const start = await run(elsewhere(loginJson("/_admin/login/passkey/options", jwt, {})));
    expect(start.status).toBe(200);
    const { options } = (await start.json()) as { options: { challenge: string; rpId: string } };
    const res = await run(elsewhere(loginJson("/_admin/login/passkey", jwt, { response: await key.signIn(options, ORIGIN), next: "/_admin/links" })));
    expect(res.status).toBe(200);
  });

  it("stops working when an admin resets the password", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    const key = await addPasskey(PERSON);
    const pjwt = await jwtFor(PERSON);
    expect((await passkeyLogin(pjwt, key)).res.status).toBe(200);

    const reset = await run(api(`/users/${encodeURIComponent(PERSON)}/invite`, await jwtFor(OWNER), await ownerSession(), { body: {} }));
    expect(reset.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_factors WHERE email = ?").bind(PERSON).first<{ n: number }>()).toEqual({ n: 0 });
    // Nothing left to offer, and no passkey sign-in before the new password is chosen.
    expect((await run(loginJson("/_admin/login/passkey/options", pjwt, {}))).status).toBe(403);
  });

  it("isn't offered to someone who hasn't chosen a password yet", async () => {
    await addUser(PERSON, "user", [], { inviteToken: "t".repeat(43), inviteExpires: nowSec() + 3600 });
    await addPasskey(PERSON);
    const res = await run(loginJson("/_admin/login/passkey/options", await jwtFor(PERSON), {}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Choose your password from the invite link first." });
  });

  it("only takes same-origin JSON, and only for people who may sign in", async () => {
    await addPasskey(OWNER);
    const jwt = await jwtFor(OWNER);
    const foreign = new Request(`${ORIGIN}/_admin/login/passkey/options`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": jwt, Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await run(foreign)).status).toBe(400);
    expect((await run(loginJson("/_admin/login/passkey/options", await jwtFor("stranger@example.com"), {}))).status).toBe(403);
    // Someone without a passkey is told to use the password.
    await addUser(PERSON, "user", [], { password: PASSWORD });
    expect((await run(loginJson("/_admin/login/passkey/options", await jwtFor(PERSON), {}))).status).toBe(404);
  });
});

describe("the passkey module", () => {
  it("excludes passkeys already added, and refuses a second copy", async () => {
    const key = await addPasskey(OWNER);
    const options = (await registrationOptions(env.DB, OWNER, RP, nowSec()))!;
    expect(options.excludeCredentials).toEqual([expect.objectContaining({ id: key.id })]);
    const dup = await verifyRegistration(env.DB, OWNER, (await key.register(options, ORIGIN)) as never, "Again", RP, nowSec());
    expect(dup).toEqual({ ok: false, reason: "exists" });
    expect(await loginOptions(env.DB, PERSON, RP, nowSec())).toBeNull();
    const get = (await loginOptions(env.DB, OWNER, RP, nowSec()))!;
    // An expired challenge doesn't work.
    expect(await verifyLogin(env.DB, OWNER, (await key.signIn(get, ORIGIN)) as never, RP, nowSec() + 3600)).toEqual({ ok: false, reason: "expired" });
  });
});

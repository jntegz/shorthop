// Two-factor sign-in where Shorthop differs from where it was first built:
// password-only mode (everyone signs in as "admin"), the known-network rule of
// the login brake, logging out, self-service password changes and the API
// reference.

import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MFA_COOKIE, SESSION_COOKIE } from "../src/shared/login-policy";
import { hashPassword } from "../src/shared/password";
import { nowSec } from "../src/worker/db";
import { registrationOptions, relyingParty, verifyRegistration } from "../src/worker/passkeys";
import { getEpoch, ipHash, issueSessionCookie, knownNetwork, loginConfig } from "../src/worker/session";
import { base32Decode, newTotpSecret, totpCode, totpStep } from "../src/worker/totp";
import { PASSWORD_IDENTITY, sha256Hex } from "../src/worker/users";
import { encryptSecret } from "../src/worker/webhooks";
import { api, cookies, form, jwtFor, LOGIN_ENV, loginJson, PASSWORD, PERSON, run, useAccess } from "./access";
import { API, bearer, call, ORIGIN, resetData } from "./helpers";
import { addUser } from "./people";
import { softPasskey, type SoftPasskey } from "./webauthn";

const ALLOW_ALL = { limit: async () => ({ success: true }) } as RateLimit;
const OWNER_PASSWORD = "owner-password-0123";

async function addTotp(identity: string): Promise<string> {
  const secret = newTotpSecret();
  await env.DB.prepare("INSERT INTO auth_factors (id, email, kind, name, secret_enc, created_at) VALUES (?, ?, 'totp', 'Phone', ?, ?)")
    .bind(`f_${crypto.randomUUID().slice(0, 12)}`, identity, await encryptSecret(env as unknown as Env, "totp", secret), nowSec())
    .run();
  return secret;
}

const codeFor = (secret: string) => totpCode(base32Decode(secret)!, totpStep(nowSec()));
const RP = relyingParty(`${ORIGIN}/_admin/login`);

async function addPasskey(identity: string): Promise<SoftPasskey> {
  const key = await softPasskey();
  const options = (await registrationOptions(env.DB, identity, RP, nowSec()))!;
  expect((await verifyRegistration(env.DB, identity, (await key.register(options, ORIGIN)) as never, "Key", RP, nowSec())).ok).toBe(true);
  return key;
}

const passkeyCount = async (identity: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_factors WHERE email = ? AND kind = 'passkey'").bind(identity).first<{ n: number }>())?.n;

describe("without Cloudflare Access (ADMIN_AUTH = password)", () => {
  let PW_ENV: Partial<Env>;
  beforeAll(async () => {
    PW_ENV = { ADMIN_AUTH: "password", LOGIN_LIMITER: ALLOW_ALL, ADMIN_PASSWORD_HASH: await hashPassword(OWNER_PASSWORD, 10_000) };
  });
  beforeEach(resetData);
  afterEach(() => vi.restoreAllMocks());

  const post = (path: string, fields: Record<string, string>, cookie = "", extra: Partial<Env> = {}) =>
    call(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": "203.0.113.60", ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams(fields).toString(),
      }),
      undefined,
      { ...PW_ENV, ...extra },
    );
  const me = (cookie: string) => call(new Request(`${ORIGIN}/_admin/api/me`, { headers: { Cookie: cookie, Origin: ORIGIN } }), undefined, PW_ENV);

  it("asks the admin for a code after the password, then signs in", async () => {
    const secret = await addTotp(PASSWORD_IDENTITY);
    const pw = await post("/_admin/login", { password: OWNER_PASSWORD });
    expect(pw.status).toBe(303);
    expect(pw.headers.get("Location")).toContain("/_admin/login/2fa");
    const mfa = cookies(pw)[MFA_COOKIE]!;
    expect(cookies(pw)[SESSION_COOKIE]).toBeUndefined();
    expect((await me(mfa)).status).toBe(401);

    const done = await post("/_admin/login/2fa", { code: await codeFor(secret) }, mfa);
    expect(done.status).toBe(303);
    expect((await me(cookies(done)[SESSION_COOKIE]!)).status).toBe(200);
  });

  it("signs the admin in with a passkey alone", async () => {
    const key = await addPasskey(PASSWORD_IDENTITY);
    const json = (path: string, body: unknown) =>
      call(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.60" }, body: JSON.stringify(body) }), undefined, PW_ENV);
    const start = await json("/_admin/login/passkey/options", {});
    expect(start.status).toBe(200);
    const { options } = (await start.json()) as { options: { challenge: string; rpId: string } };
    const res = await json("/_admin/login/passkey", { response: await key.signIn(options, ORIGIN) });
    expect(res.status).toBe(200);
    expect((await me(cookies(res)[SESSION_COOKIE]!)).status).toBe(200);
  });

  it("locks after wrong codes and tells DIGEST_TO, since the admin has no address of its own", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await addTotp(PASSWORD_IDENTITY);
    const sent: { to: string; subject: string }[] = [];
    const DIGEST = { send: async (m: { to: string; subject: string }) => (sent.push(m), { messageId: "m" }) } as unknown as SendEmail;
    const mfa = cookies(await post("/_admin/login", { password: OWNER_PASSWORD }))[MFA_COOKIE]!;
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) last = await post("/_admin/login/2fa", { code: "000000" }, mfa, { DIGEST } as Partial<Env>);
    expect(last!.status).toBe(429);
    expect(sent.map((m) => m.to)).toEqual([env.DIGEST_TO]);
    expect(sent[0]!.subject).toContain("tried to sign in");
  });
});

describe("the second step and the rest of the login", () => {
  useAccess();

  it("doesn't make a network known that passed the password but failed the code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await addUser(PERSON, "user", [], { password: PASSWORD });
    await addTotp(PERSON);
    const jwt = await jwtFor(PERSON);
    const pw = await run(form("/_admin/login", jwt, { password: PASSWORD }));
    expect(pw.status).toBe(303);
    expect((await run(form("/_admin/login/2fa", jwt, { code: "000000" }, cookies(pw)[MFA_COOKIE]!))).status).toBe(401);
    const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
    // form() sends 203.0.113.50.
    expect(await knownNetwork(env.DB, await ipHash(cfg, "203.0.113.50"), PERSON, nowSec())).toBe(false);
  });

  it("logging out ends the session on the server and clears the second step's cookie", async () => {
    await addUser(PERSON, "user", [], { password: PASSWORD });
    const jwt = await jwtFor(PERSON);
    const session = cookies(await run(form("/_admin/login", jwt, { password: PASSWORD })))[SESSION_COOKIE]!;
    expect((await run(api("/me", jwt, session))).status).toBe(200);
    const out = await run(form("/_admin/logout", jwt, {}, session));
    expect(out.status).toBe(303);
    const set = cookies(out);
    expect(set[SESSION_COOKIE]).toBe(`${SESSION_COOKIE}=`);
    expect(set[MFA_COOKIE]).toBe(`${MFA_COOKIE}=`);
    expect((await run(api("/me", jwt, session))).status).toBe(401);
  });

  it("removes passkeys with a password reset by email, and with a password change", async () => {
    // A reset link.
    const token = "r".repeat(43);
    await addUser(PERSON, "user", [], { password: "old-password-123456" });
    await env.DB.prepare("UPDATE users SET reset_hash = ?, reset_expires = ? WHERE email = ?").bind(await sha256Hex(token), nowSec() + 3600, PERSON).run();
    await addPasskey(PERSON);
    const jwt = await jwtFor(PERSON);
    const reset = await run(form(`/_admin/reset/${token}`, jwt, { password: PASSWORD, confirm: PASSWORD }));
    expect(reset.status).toBe(303);
    expect(await passkeyCount(PERSON)).toBe(0);

    // A change in Settings, from a session that keeps its sign-in time.
    await addPasskey(PERSON);
    const cfg = loginConfig({ ...env, ...LOGIN_ENV } as Env)!;
    const user = await env.DB.prepare("SELECT session_epoch FROM users WHERE email = ?").bind(PERSON).first<{ session_epoch: string }>();
    const { cookie } = await issueSessionCookie(cfg, PERSON, { global: await getEpoch(env.DB), user: user!.session_epoch }, nowSec());
    const changed = await run(api("/me/password", jwt, cookie.split(";")[0]!, { body: { current: PASSWORD, next: `${PASSWORD}-new` } }));
    expect(changed.status).toBe(200);
    expect(await passkeyCount(PERSON)).toBe(0);
    // Its options answer that there's nothing left.
    expect((await run(loginJson("/_admin/login/passkey/options", jwt, {}))).status).toBe(404);
  });
});

describe("the API reference", () => {
  beforeEach(resetData);

  it("lists none of the two-factor routes", async () => {
    const doc = await (await call(`${API}/openapi.json`, { headers: bearer })).json<{ paths: Record<string, unknown> }>();
    const paths = Object.keys(doc.paths);
    expect(paths.filter((p) => p.startsWith("/me/") || p.includes("two-factor"))).toEqual([]);
  });
});

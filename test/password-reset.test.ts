import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESET_MAX_PER_DAY } from "../src/shared/login-policy";
import { hashPassword } from "../src/shared/password";
import type { InviteDTO, PeopleDTO, TurnstileDTO } from "../src/shared/types";
import { nowSec } from "../src/worker/db";
import { call, resetData } from "./helpers";
import { addUser, adminCall, as, LOCAL } from "./people";

const PASSWORD = "a-long-enough-password";
const NEW_PASSWORD = "a-brand-new-password-1";
const ANNA = "anna@example.com";

let HASH: string;
beforeAll(async () => {
  HASH = await hashPassword("owner-password-0123", 10_000);
});
beforeEach(resetData);
afterEach(() => vi.restoreAllMocks());

type Sent = { to: string; subject: string; text: string };

/** A send_email binding that records what it would send. */
function mailbox() {
  const sent: Sent[] = [];
  const binding = {
    send: async (m: Sent) => {
      sent.push(m);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, binding };
}

const limiter = { limit: async () => ({ success: true }) } as RateLimit;
/** As `email` on localhost, with the password login on. */
const withLogin = (email: string, extra: Partial<Env> = {}) => as(email, { ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: limiter, ...extra });
const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
  body: new URLSearchParams(fields).toString(),
});
/** GET `path`, or POST `fields` to it, as `email`. */
const open = (path: string, email: string, extra: Partial<Env> = {}, fields?: Record<string, string>) =>
  call(new Request(`${LOCAL}${path}`, fields ? form(fields) : {}), undefined, withLogin(email, extra));
const login = (email: string, password: string, extra: Partial<Env> = {}) => open("/_admin/login", email, extra, { password });
const resetToken = (text: string) => /\/_admin\/reset\/([A-Za-z0-9_-]{43})/.exec(text)?.[1];
const failures = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE key NOT LIKE 'reset%'").first<{ n: number }>())?.n;
/** As if the window of a reset counter began long ago. */
const age = (key: string, by: number) => env.DB.prepare("UPDATE auth_failures SET window_start = window_start - ? WHERE key = ?").bind(by, key).run();

describe("forgot password, by email", () => {
  it("emails a one-time link to the Access address; the old password works until it's used", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    const mail = mailbox();
    const extra = { PEOPLE_MAIL: mail.binding } as Partial<Env>;

    const form = await open("/_admin/forgot", ANNA, extra);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain("Email me a reset link");

    const asked = await open("/_admin/forgot", ANNA, extra, {});
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("Check your inbox");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(ANNA);
    const token = resetToken(mail.sent[0]!.text)!;
    expect(token).toBeTruthy();
    expect((await login(ANNA, PASSWORD)).status).toBe(303);

    expect((await open(`/_admin/reset/${token}`, ANNA)).status).toBe(200);
    expect((await open(`/_admin/reset/${token}`, ANNA, extra, { password: NEW_PASSWORD, confirm: "different-password-x" })).status).toBe(400);
    const saved = await open(`/_admin/reset/${token}`, ANNA, extra, { password: NEW_PASSWORD, confirm: NEW_PASSWORD });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("Set-Cookie")).toContain("__Host-sh_admin=");
    expect(mail.sent.at(-1)!.subject).toBe("Your Shorthop password was changed");

    expect((await open(`/_admin/reset/${token}`, ANNA, extra, { password: NEW_PASSWORD, confirm: NEW_PASSWORD })).status).toBe(410);
    expect((await login(ANNA, PASSWORD)).status).toBe(401);
    expect((await login(ANNA, NEW_PASSWORD)).status).toBe(303);
  });

  it("sends at most one email per person every 15 minutes and three a day", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    const mail = mailbox();
    const ask = () => open("/_admin/forgot", ANNA, { PEOPLE_MAIL: mail.binding } as Partial<Env>, {});

    expect((await ask()).status).toBe(200);
    const again = await ask();
    expect(again.status).toBe(429);
    expect(await again.text()).toContain("You asked less than 15 minutes ago");
    expect(again.headers.get("Retry-After")).toBeTruthy();
    for (let i = 1; i < RESET_MAX_PER_DAY; i++) {
      await age(`reset:${ANNA}`, 3600);
      expect((await ask()).status).toBe(200);
    }
    await age(`reset:${ANNA}`, 3600);
    const daily = await ask();
    expect(daily.status).toBe(429);
    expect(await daily.text()).toContain("reset requests today");
    expect(mail.sent).toHaveLength(RESET_MAX_PER_DAY);
  });

  it("stops everyone for a while after many resets in an hour", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    await env.DB.prepare("INSERT INTO auth_failures (key, fails, window_start, locked_until, lockouts, updated_at) VALUES ('reset:*', 20, ?1, 0, 0, ?1)")
      .bind(nowSec())
      .run();
    const res = await open("/_admin/forgot", ANNA, { PEOPLE_MAIL: mailbox().binding } as Partial<Env>, {});
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Too many password resets right now");
  });
});

describe("forgot password, without email to people", () => {
  it("tells an admin when email only reaches DIGEST_TO", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    const mail = mailbox();
    const extra = { DIGEST: mail.binding } as Partial<Env>;
    expect(await (await open("/_admin/forgot", ANNA, extra)).text()).toContain("Ask an admin to reset it");
    const asked = await open("/_admin/forgot", ANNA, extra, {});
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("An admin has been told");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(env.DIGEST_TO);
    expect(mail.sent[0]!.subject).toContain("anna");
    expect(mail.sent[0]!.text).not.toMatch(/\/_admin\/reset\//);
  });

  it("only says who to ask when email is off", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    const res = await open("/_admin/forgot", ANNA, { DIGEST_PROVIDER: "off" });
    const text = await res.text();
    expect(text).toContain("Ask an admin or manager to reset it");
    expect(text).not.toContain("<form");
  });

  it("explains the owner's way, and refuses paused people and other accounts' links", async () => {
    const owner = await (await open("/_admin/forgot", "")).text();
    expect(owner).toContain("npm run setup -- password");
    expect(owner).toContain("ADMIN_PASSWORD");
    await addUser(ANNA, "user", [], { password: PASSWORD });
    await addUser("ben@example.com", "user", [], { password: PASSWORD });
    await env.DB.prepare("UPDATE users SET paused_at = ? WHERE email = 'ben@example.com'").bind(nowSec()).run();
    expect((await open("/_admin/forgot", "ben@example.com")).status).toBe(403);

    const mail = mailbox();
    await open("/_admin/forgot", ANNA, { PEOPLE_MAIL: mail.binding } as Partial<Env>, {});
    const token = resetToken(mail.sent[0]!.text)!;
    await env.DB.prepare("UPDATE users SET paused_at = NULL WHERE email = 'ben@example.com'").run();
    expect((await open(`/_admin/reset/${token}`, "ben@example.com")).status).toBe(410);
  });
});

describe("reset links and other changes", () => {
  it("stops a reset link once an admin sends a new invite", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    const mail = mailbox();
    const extra = { PEOPLE_MAIL: mail.binding } as Partial<Env>;
    await open("/_admin/forgot", ANNA, extra, {});
    const token = resetToken(mail.sent[0]!.text)!;
    expect((await adminCall("", `/users/${encodeURIComponent(ANNA)}/invite`, { body: { sendEmail: false } })).status).toBe(200);
    expect((await open(`/_admin/reset/${token}`, ANNA)).status).toBe(410);
    expect((await open(`/_admin/reset/${token}`, ANNA, extra, { password: NEW_PASSWORD, confirm: NEW_PASSWORD })).status).toBe(410);
  });

  it("doesn't clear the network's wrong-password count when a reset link is used", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    expect((await login(ANNA, "not-the-password-at-all")).status).toBe(401);
    const counted = await env.DB.prepare("SELECT key, fails FROM auth_failures WHERE key NOT LIKE 'reset%' AND key NOT LIKE 'token:%' AND key NOT LIKE '*%'").all<{ key: string; fails: number }>();
    expect(counted.results).toHaveLength(1);

    const mail = mailbox();
    const extra = { PEOPLE_MAIL: mail.binding } as Partial<Env>;
    await open("/_admin/forgot", ANNA, extra, {});
    const token = resetToken(mail.sent[0]!.text)!;
    expect((await open(`/_admin/reset/${token}`, ANNA, extra, { password: NEW_PASSWORD, confirm: NEW_PASSWORD })).status).toBe(303);
    const after = await env.DB.prepare("SELECT fails FROM auth_failures WHERE key = ?").bind(counted.results[0]!.key).first<{ fails: number }>();
    expect(after?.fails).toBe(counted.results[0]!.fails);
  });

  it("lets them ask again straight away when the email couldn't be sent", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    const broken = { send: async () => Promise.reject(new Error("mail down")) } as unknown as SendEmail;
    expect((await open("/_admin/forgot", ANNA, { PEOPLE_MAIL: broken } as Partial<Env>, {})).status).toBe(502);
    expect((await env.DB.prepare("SELECT reset_hash FROM users WHERE email = ?").bind(ANNA).first<{ reset_hash: string | null }>())?.reset_hash).toBeNull();
    const mail = mailbox();
    expect((await open("/_admin/forgot", ANNA, { PEOPLE_MAIL: mail.binding } as Partial<Env>, {})).status).toBe(200);
    expect(mail.sent).toHaveLength(1);
  });
});

describe("wrong links", () => {
  it("locks a network out of invite and reset pages after five links that don't work", async () => {
    await addUser(ANNA, "user", [], { inviteToken: "i".repeat(43) });
    for (let i = 0; i < 5; i++) expect((await open(`/_admin/reset/${String(i).repeat(43)}`, ANNA)).status).toBe(410);
    const locked = await open(`/_admin/invite/${"i".repeat(43)}`, ANNA);
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many links");
  });
});

describe("emailing invite links", () => {
  it("emails the link to the person's own address when asked and possible", async () => {
    const mail = mailbox();
    const extra = { PEOPLE_MAIL: mail.binding } as Partial<Env>;
    expect((await (await adminCall("", "/users", {}, extra)).json<PeopleDTO>()).emailProblem).toBeNull();
    const res = await adminCall("", "/users", { body: { email: ANNA, role: "user", sendEmail: true } }, extra);
    const invite = await res.json<InviteDTO>();
    expect(invite).toMatchObject({ emailed: true, emailProblem: null });
    expect(mail.sent).toEqual([expect.objectContaining({ to: ANNA, subject: "You're invited to Shorthop" })]);
    expect(mail.sent[0]!.text).toContain(invite.inviteUrl);

    const reset = await adminCall("", `/users/${encodeURIComponent(ANNA)}/invite`, { body: { sendEmail: false } }, extra);
    expect(await reset.json<InviteDTO>()).toMatchObject({ emailed: false, emailProblem: null });
    expect(mail.sent).toHaveLength(1);
  });

  it("still gives the link when email can't reach people", async () => {
    expect((await (await adminCall("", "/users")).json<PeopleDTO>()).emailProblem).toContain("PEOPLE_MAIL");
    const res = await adminCall("", "/users", { body: { email: ANNA, role: "user", sendEmail: true } });
    const invite = await res.json<InviteDTO>();
    expect(invite.emailed).toBe(false);
    expect(invite.emailProblem).toContain("PEOPLE_MAIL");
    expect(invite.inviteUrl).toMatch(/\/_admin\/invite\//);
  });
});

describe("bot check (Turnstile)", () => {
  const SITE_KEY = "0x4AAAAAAAtestkey";
  const secret = { TURNSTILE_SECRET: "turnstile-secret" } as Partial<Env>;
  const siteverify = (success: boolean) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ success, "error-codes": success ? [] : ["invalid-input-response"] })));
  const turnOn = () => env.DB.prepare("INSERT INTO settings (key, value) VALUES ('turnstile', ?)").bind(JSON.stringify({ enabled: true, siteKey: SITE_KEY })).run();
  const settings = async () => (await adminCall("", "/settings/turnstile", {}, secret)).json<TurnstileDTO>();

  it("is off until a test passes, and only admins can set it up", async () => {
    expect(await settings()).toMatchObject({ enabled: false, siteKey: "", secretSet: true });
    expect((await adminCall("", "/settings/turnstile", { method: "PUT", body: { siteKey: "no spaces allowed" } })).status).toBe(400);
    expect(await (await adminCall("", "/settings/turnstile", { method: "PUT", body: { siteKey: SITE_KEY } }, secret)).json()).toMatchObject({ enabled: false, siteKey: SITE_KEY });
    await addUser("mia@example.com", "manager", ["settings.manage"]);
    expect((await adminCall("mia@example.com", "/settings/turnstile")).status).toBe(403);

    const bypass = as("", secret);
    expect(await (await call(new Request(`${LOCAL}/_admin/bot-check`), undefined, bypass)).text()).toContain(`data-sitekey="${SITE_KEY}"`);
    siteverify(false);
    const failed = await call(new Request(`${LOCAL}/_admin/bot-check`, form({ "cf-turnstile-response": "bad" })), undefined, bypass);
    expect(failed.status).toBe(400);
    expect((await settings()).enabled).toBe(false);

    siteverify(true);
    const passed = await call(new Request(`${LOCAL}/_admin/bot-check`, form({ "cf-turnstile-response": "good" })), undefined, bypass);
    expect(passed.status).toBe(303);
    expect((await settings()).enabled).toBe(true);
    expect((await (await adminCall("", "/settings/turnstile", { method: "DELETE" }, secret)).json<TurnstileDTO>()).enabled).toBe(false);
  });

  it("asks for the check on the login page and refuses a post without it, uncounted", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    await turnOn();
    const page = await open("/_admin/login", ANNA, secret);
    expect(await page.text()).toContain(`data-sitekey="${SITE_KEY}"`);
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src https://challenges.cloudflare.com");

    const missing = await open("/_admin/login", ANNA, secret, { password: PASSWORD });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("Complete the bot check");
    expect(await failures()).toBe(0);

    siteverify(true);
    expect((await open("/_admin/login", ANNA, secret, { password: PASSWORD, "cf-turnstile-response": "good" })).status).toBe(303);
  });

  it("lets logins through when Cloudflare can't be reached, and stays off without the secret", async () => {
    await addUser(ANNA, "user", [], { password: PASSWORD });
    await turnOn();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect((await open("/_admin/login", ANNA, secret, { password: PASSWORD, "cf-turnstile-response": "any" })).status).toBe(303);
    // Without TURNSTILE_SECRET the saved switch does nothing.
    expect(await (await open("/_admin/login", ANNA)).text()).not.toContain("data-sitekey");
  });
});

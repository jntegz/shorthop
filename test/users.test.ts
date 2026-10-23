import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/shared/password";
import type { InviteDTO, MeDTO, PeopleDTO } from "../src/shared/types";
import { nowSec } from "../src/worker/db";
import { API, bearer, call, resetData } from "./helpers";
import { addUser, adminCall, as, LOCAL } from "./people";

beforeEach(resetData);

const OWNER = "owner@example.com"; // ADMIN_EMAIL in wrangler.jsonc
const TOKEN = "t".repeat(43);
const PASSWORD = "a-long-enough-password";

describe("people", () => {
  it("lets an admin add someone and returns a one-time invite link", async () => {
    const res = await adminCall("", "/users", { body: { email: " Anna@Example.com ", name: "Anna", role: "user", permissions: ["links.create"] } });
    expect(res.status).toBe(201);
    const invite = await res.json<InviteDTO>();
    expect(invite.inviteUrl).toMatch(new RegExp(`^${LOCAL}/_admin/invite/[A-Za-z0-9_-]{43}$`));
    expect(invite.person).toMatchObject({ email: "anna@example.com", role: "user", permissions: ["links.create"], status: "invited" });

    const list = await (await adminCall("", "/users")).json<PeopleDTO>();
    expect(list.people.map((p) => [p.email, p.status])).toEqual([
      [OWNER, "owner"],
      ["anna@example.com", "invited"],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/hash|invite_/);
    expect(list.assignableRoles).toEqual(["admin", "manager", "user"]);
  });

  it("refuses owners, duplicates and bad emails", async () => {
    expect((await adminCall("", "/users", { body: { email: OWNER, role: "user" } })).status).toBe(409);
    await addUser("anna@example.com");
    expect((await adminCall("", "/users", { body: { email: "ANNA@example.com", role: "user" } })).status).toBe(409);
    expect((await adminCall("", "/users", { body: { email: "not-an-email", role: "user" } })).status).toBe(400);
  });

  it("keeps managers to users and to permissions they hold", async () => {
    await addUser("mia@example.com", "manager", ["links.create", "links.edit"]);
    await addUser("ben@example.com", "user", ["links.create", "stats.view"]);
    await addUser("ada@example.com", "admin");
    const mia = (path: string, init: { method?: string; body?: unknown } = {}) => adminCall("mia@example.com", path, init);

    expect((await mia("/users", { body: { email: "new@example.com", role: "user", permissions: ["links.edit"] } })).status).toBe(201);
    expect((await mia("/users", { body: { email: "x@example.com", role: "manager" } })).status).toBe(403);
    expect((await mia("/users", { body: { email: "y@example.com", role: "user", permissions: ["links.delete"] } })).status).toBe(403);

    // Ben's stats.view isn't Mia's to take away; links.create is.
    const changed = await mia("/users/ben%40example.com", { method: "PATCH", body: { permissions: ["links.edit"] } });
    expect(changed.status).toBe(200);
    expect((await changed.json<{ person: { permissions: string[] } }>()).person.permissions).toEqual(["links.edit", "stats.view"]);
    expect((await mia("/users/ben%40example.com", { method: "PATCH", body: { role: "manager" } })).status).toBe(403);

    for (const target of ["ada%40example.com", "mia%40example.com"]) {
      expect((await mia(`/users/${target}`, { method: "PATCH", body: { name: "x" } })).status).toBe(403);
      expect((await mia(`/users/${target}`, { method: "DELETE" })).status).toBe(403);
      expect((await mia(`/users/${target}/invite`, { method: "POST" })).status).toBe(403);
    }
    expect((await mia(`/users/${encodeURIComponent(OWNER)}`, { method: "DELETE" })).status).toBe(404);
    expect((await mia("/users/ben%40example.com", { method: "DELETE" })).status).toBe(200);
  });

  it("lets admins promote and demote, but not themselves", async () => {
    await addUser("ada@example.com", "admin");
    await addUser("ben@example.com", "user", ["links.create"]);
    const promoted = await adminCall("ada@example.com", "/users/ben%40example.com", { method: "PATCH", body: { role: "admin" } });
    expect((await promoted.json<{ person: { permissions: string[] } }>()).person.permissions).toContain("settings.manage");
    // An admin's old list would come back: demoting needs a choice.
    expect((await adminCall("ada@example.com", "/users/ben%40example.com", { method: "PATCH", body: { role: "user" } })).status).toBe(400);
    expect((await adminCall("ada@example.com", "/users/ben%40example.com", { method: "PATCH", body: { role: "user", permissions: [] } })).status).toBe(200);
    expect((await adminCall("ada@example.com", "/users/ada%40example.com", { method: "PATCH", body: { role: "user", permissions: [] } })).status).toBe(403);
  });

  it("keeps people management to signed-in admins and managers", async () => {
    await addUser("ben@example.com", "user", ["links.create", "links.edit", "links.delete", "settings.manage"]);
    expect((await adminCall("ben@example.com", "/users")).status).toBe(403);
    // The all-access API token can't manage people either.
    expect((await call(`${API}/users`, { headers: bearer })).status).toBe(403);
  });

  it("locks someone out as soon as they're removed, with their keys", async () => {
    await addUser("ben@example.com", "user", ["api.use"]);
    expect((await adminCall("ben@example.com", "/me")).status).toBe(200);
    const created = await adminCall("ben@example.com", "/keys", { body: { name: "Script" } });
    const { secret } = await created.json<{ secret: string }>();
    expect((await call(`${API}/links`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(200);

    const removed = await adminCall("", "/users/ben%40example.com", { method: "DELETE" });
    expect(await removed.json()).toEqual({ removed: true, keysRevoked: 1 });
    const after = await adminCall("ben@example.com", "/me");
    expect(after.status).toBe(403);
    expect(await after.json()).toMatchObject({ code: "not_allowed" });
    expect((await call(`${API}/links`, { headers: { Authorization: `Bearer ${secret}` } })).status).toBe(401);
  });

  it("tells each person who they are and what they may do", async () => {
    await addUser("ben@example.com", "user", ["stats.view"]);
    const me = await (await adminCall("ben@example.com", "/me")).json<MeDTO>();
    expect(me).toMatchObject({ email: "ben@example.com", role: "user", owner: false, permissions: ["stats.view"], apiTokenSet: null });
    expect(me.workspace.primaryDomain).toBe("sh.example");
    const owner = await (await adminCall("", "/me")).json<MeDTO>();
    expect(owner).toMatchObject({ owner: true, role: "admin", apiTokenSet: true });
  });
});

describe("invite links and passwords", () => {
  let HASH: string;
  beforeAll(async () => {
    HASH = await hashPassword("owner-password-0123", 10_000);
  });
  /** As `email` on localhost, with the password login turned on. */
  const withLogin = (email: string) => as(email, { ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: { limit: async () => ({ success: true }) } as RateLimit });
  const form = (fields: Record<string, string>, cookie?: string) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  const invite = (email: string, fields?: Record<string, string>, token = TOKEN) =>
    call(new Request(`${LOCAL}/_admin/invite/${token}`, fields ? form(fields) : {}), undefined, withLogin(email));
  const me = (email: string, cookie: string) => call(new Request(`${LOCAL}/_admin/api/me`, { headers: { Cookie: cookie } }), undefined, withLogin(email));
  const cookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;

  it("lets the invited person choose a password once, then sign in with it", async () => {
    await addUser("anna@example.com", "user", [], { inviteToken: TOKEN });
    const page = await invite("anna@example.com");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('autocomplete="new-password"');

    expect((await invite("anna@example.com", { password: "short", confirm: "short" })).status).toBe(400);
    expect((await invite("anna@example.com", { password: PASSWORD, confirm: `${PASSWORD}x` })).status).toBe(400);
    const done = await invite("anna@example.com", { password: PASSWORD, confirm: PASSWORD });
    expect(done.status).toBe(303);
    expect(done.headers.get("Location")).toBe("/_admin/");
    const cookie = cookieOf(done);
    expect((await me("anna@example.com", cookie)).status).toBe(200);

    expect((await invite("anna@example.com", { password: PASSWORD, confirm: PASSWORD })).status).toBe(410);
    const login = await call(new Request(`${LOCAL}/_admin/login`, form({ password: PASSWORD })), undefined, withLogin("anna@example.com"));
    expect(login.status).toBe(303);
    const events = await env.DB.prepare("SELECT email FROM login_events WHERE ok = 1").all<{ email: string }>();
    expect(events.results.map((e) => e.email)).toEqual(["anna@example.com", "anna@example.com"]);
  });

  it("refuses other accounts, owners, expired links and a second post at the same time", async () => {
    await addUser("anna@example.com", "user", [], { inviteToken: TOKEN });
    await addUser("ben@example.com");
    expect((await invite("ben@example.com")).status).toBe(410);
    expect((await invite("")).status).toBe(403);
    expect((await invite("anna@example.com", undefined, "x".repeat(43))).status).toBe(410);

    const both = await Promise.all([1, 2].map(() => invite("anna@example.com", { password: PASSWORD, confirm: PASSWORD })));
    expect(both.map((r) => r.status).sort()).toEqual([303, 410]);

    await addUser("late@example.com", "user", [], { inviteToken: TOKEN, inviteExpires: nowSec() - 1 });
    expect((await invite("late@example.com")).status).toBe(410);
  });

  it("sends people without a password to their invite, without counting it as a failure", async () => {
    await addUser("anna@example.com", "user", [], { inviteToken: TOKEN });
    const get = await call(new Request(`${LOCAL}/_admin/login`), undefined, withLogin("anna@example.com"));
    expect(await get.text()).toContain("Choose your password first");
    const post = await call(new Request(`${LOCAL}/_admin/login`, form({ password: "guess" })), undefined, withLogin("anna@example.com"));
    expect(post.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures").first<{ n: number }>())?.n).toBe(0);
  });

  it("ends someone's sessions when they get a new invite", async () => {
    await addUser("anna@example.com", "user", [], { password: PASSWORD });
    const login = await call(new Request(`${LOCAL}/_admin/login`, form({ password: PASSWORD })), undefined, withLogin("anna@example.com"));
    const cookie = cookieOf(login);
    expect((await me("anna@example.com", cookie)).status).toBe(200);

    const reset = await adminCall("", "/users/anna%40example.com/invite", { method: "POST" });
    expect(reset.status).toBe(200);
    expect((await reset.json<InviteDTO>()).person.status).toBe("invited");
    expect((await me("anna@example.com", cookie)).status).toBe(401);
  });

  it("changes your own password and keeps only this session", async () => {
    await addUser("anna@example.com", "user", [], { password: PASSWORD });
    const login = () => call(new Request(`${LOCAL}/_admin/login`, form({ password: PASSWORD })), undefined, withLogin("anna@example.com"));
    const [a, b] = [cookieOf(await login()), cookieOf(await login())];
    const change = (current: string, next: string) =>
      call(
        new Request(`${LOCAL}/_admin/api/me/password`, {
          method: "POST",
          headers: { Cookie: a, "Content-Type": "application/json", Origin: LOCAL },
          body: JSON.stringify({ current, next }),
        }),
        undefined,
        withLogin("anna@example.com"),
      );
    expect((await change("wrong-password", "another-long-password")).status).toBe(400);
    const ok = await change(PASSWORD, "another-long-password");
    expect(ok.status).toBe(200);
    expect((await me("anna@example.com", cookieOf(ok))).status).toBe(200);
    expect((await me("anna@example.com", b)).status).toBe(401);
  });
});

describe("pausing and signing out", () => {
  const pause = (email: string, until: number | null, by = "") => adminCall(by, `/users/${encodeURIComponent(email)}/pause`, { body: { until } });
  const status = async (email: string) => (await (await adminCall("", "/users")).json<PeopleDTO>()).people.find((p) => p.email === email);

  it("invite links last 24 hours", async () => {
    const res = await adminCall("", "/users", { body: { email: "anna@example.com", role: "user" } });
    const invite = await res.json<InviteDTO>();
    expect(invite.inviteExpiresAt - nowSec()).toBeGreaterThan(24 * 3600 - 60);
    expect(invite.inviteExpiresAt - nowSec()).toBeLessThanOrEqual(24 * 3600);
  });

  it("blocks sign-in and API keys until resumed, without removing anything", async () => {
    await addUser("ben@example.com", "user", ["api.use"], { password: PASSWORD });
    const { secret } = await (await adminCall("ben@example.com", "/keys", { body: { name: "Script" } })).json<{ secret: string }>();
    const key = { headers: { Authorization: `Bearer ${secret}` } };

    const paused = await pause("ben@example.com", null);
    expect(paused.status).toBe(200);
    expect(await status("ben@example.com")).toMatchObject({ status: "paused", pausedUntil: null, pausedBy: "dev@localhost", keys: 1 });
    const blocked = await adminCall("ben@example.com", "/me");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "paused" });
    expect((await call(`${API}/links`, key)).status).toBe(401);

    expect((await adminCall("", "/users/ben%40example.com/resume", { method: "POST" })).status).toBe(200);
    expect((await adminCall("ben@example.com", "/me")).status).toBe(200);
    expect((await call(`${API}/links`, key)).status).toBe(200);
    expect((await status("ben@example.com"))?.status).toBe("active");
  });

  it("lifts a pause with an end time by itself", async () => {
    await addUser("ben@example.com", "user", [], { password: PASSWORD });
    expect((await pause("ben@example.com", nowSec() - 10)).status).toBe(400);
    const until = nowSec() + 3600;
    expect((await pause("ben@example.com", until)).status).toBe(200);
    expect(await status("ben@example.com")).toMatchObject({ status: "paused", pausedUntil: until });
    const blocked = await adminCall("ben@example.com", "/me");
    expect((await blocked.json<{ error: string }>()).error).toContain("until");

    await env.DB.prepare("UPDATE users SET paused_until = ? WHERE email = ?").bind(nowSec() - 1, "ben@example.com").run();
    expect((await adminCall("ben@example.com", "/me")).status).toBe(200);
    expect((await status("ben@example.com"))?.status).toBe("active");
  });

  it("follows the same rules as other changes to people", async () => {
    await addUser("mia@example.com", "manager", ["links.create"]);
    await addUser("ada@example.com", "admin");
    await addUser("ben@example.com");
    expect((await pause("ada@example.com", null, "mia@example.com")).status).toBe(403);
    expect((await pause("mia@example.com", null, "mia@example.com")).status).toBe(403);
    expect((await pause(OWNER, null, "ada@example.com")).status).toBe(404);
    expect((await pause("ben@example.com", null, "mia@example.com")).status).toBe(200);
    expect((await adminCall("mia@example.com", "/users/ben%40example.com/sign-out", { method: "POST" })).status).toBe(200);
    expect((await adminCall("mia@example.com", "/users/ada%40example.com/sign-out", { method: "POST" })).status).toBe(403);
  });
});

describe("paused people at the login", () => {
  let HASH: string;
  beforeAll(async () => {
    HASH = await hashPassword("owner-password-0123", 10_000);
  });
  const withLogin = (email: string) => as(email, { ADMIN_PASSWORD_HASH: HASH, LOGIN_LIMITER: { limit: async () => ({ success: true }) } as RateLimit });
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams(fields).toString(),
  });
  const login = (email: string) => call(new Request(`${LOCAL}/_admin/login`, form({ password: PASSWORD })), undefined, withLogin(email));
  const me = (email: string, cookie: string) => call(new Request(`${LOCAL}/_admin/api/me`, { headers: { Cookie: cookie } }), undefined, withLogin(email));
  const cookieOf = (res: Response) => (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;

  it("signs someone out everywhere but keeps their password", async () => {
    await addUser("anna@example.com", "user", [], { password: PASSWORD });
    const cookie = cookieOf(await login("anna@example.com"));
    expect((await me("anna@example.com", cookie)).status).toBe(200);
    expect((await adminCall("", "/users/anna%40example.com/sign-out", { method: "POST" })).status).toBe(200);
    expect((await me("anna@example.com", cookie)).status).toBe(401);
    expect((await login("anna@example.com")).status).toBe(303);
  });

  it("tells a paused person so, without counting a failed attempt, and keeps old sessions dead after a resume", async () => {
    await addUser("anna@example.com", "user", [], { password: PASSWORD });
    const cookie = cookieOf(await login("anna@example.com"));
    await adminCall("", "/users/anna%40example.com/pause", { body: { until: null } });

    const page = await call(new Request(`${LOCAL}/_admin/login`), undefined, withLogin("anna@example.com"));
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("Your access is paused");
    const post = await login("anna@example.com");
    expect(post.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_failures").first<{ n: number }>())?.n).toBe(0);

    await adminCall("", "/users/anna%40example.com/resume", { method: "POST" });
    expect((await me("anna@example.com", cookie)).status).toBe(401);
    expect((await login("anna@example.com")).status).toBe(303);
  });

  it("refuses a paused person's invite link", async () => {
    await addUser("anna@example.com", "user", [], { inviteToken: TOKEN });
    await env.DB.prepare("UPDATE users SET paused_at = ? WHERE email = ?").bind(nowSec(), "anna@example.com").run();
    const res = await call(new Request(`${LOCAL}/_admin/invite/${TOKEN}`), undefined, withLogin("anna@example.com"));
    expect(res.status).toBe(403);
  });
});

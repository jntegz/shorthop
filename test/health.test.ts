import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, utcDate } from "../src/shared/dates";
import { formatPasswordHash } from "../src/shared/password";
import { checkAndAlert, recordJob, systemHealth } from "../src/worker/health";
import { API, bearer, call, resetData } from "./helpers";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await resetData();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
});

afterEach(() => vi.restoreAllMocks());

const NOON = new Date(`${utcDate()}T12:00:00Z`);
const healthy = {
  ...env,
  SHORT_DOMAINS: "go.example.net",
  FALLBACK_URL: "https://www.example.net",
  WORKERS_PLAN: "paid",
  API_TOKEN: "api-token-for-health-tests-0123456789abcdef",
  VISITOR_SALT: "visitor-salt-0123456789",
  CF_ACCOUNT_ID: "acc",
  CF_ANALYTICS_TOKEN: "tok",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "aud",
  ADMIN_EMAIL: "owner@example.com",
  ADMIN_PASSWORD_HASH: formatPasswordHash({ iterations: 100_000, salt: new Uint8Array(32), hash: new Uint8Array(32) }),
  DIGEST_PROVIDER: "resend",
  DIGEST_API_KEY: "re_key",
} as unknown as Env;
const statusOf = async (e: Env, id: string) => (await systemHealth(e, NOON)).checks.find((c) => c.id === id)?.status;

describe("system status", () => {
  it("flags a rollup that's behind or failing, and clears once it catches up", async () => {
    expect(await statusOf(healthy, "rollup")).toBe("warn"); // never ran
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_rolled', ?)").bind(addDays(utcDate(NOON), -10)).run();
    expect(await statusOf(healthy, "rollup")).toBe("error");
    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'last_rolled'").bind(addDays(utcDate(NOON), -1)).run();
    expect(await statusOf(healthy, "rollup")).toBe("ok");

    await recordJob(env.DB, "rollup", false, "Analytics Engine SQL failed (401)");
    const ae = (await systemHealth(healthy, NOON)).checks.find((c) => c.id === "ae");
    expect(ae).toMatchObject({ status: "error", detail: expect.stringContaining("401") });
  });

  it("reports missing configuration", async () => {
    const h = await systemHealth({ ...healthy, CF_ANALYTICS_TOKEN: "", ACCESS_AUD: "" } as Env, NOON);
    expect(h.status).toBe("error");
    expect(h.checks.find((c) => c.id === "ae")).toMatchObject({ status: "warn", advisory: true, fix: "npm run setup -- analytics" });
    expect(h.checks.find((c) => c.id === "security")).toMatchObject({ status: "error", fix: "npm run setup -- access" });
    expect(h.checks.find((c) => c.id === "security")?.detail).toContain("Cloudflare Access");
  });

  it("checks what the setup wrote, with a fix and a docs link for each problem", async () => {
    expect((await systemHealth(healthy, NOON)).checks.filter((c) => c.id !== "rollup" && c.status !== "ok")).toEqual([]);
    const placeholder = await systemHealth({ ...healthy, SHORT_DOMAINS: "sh.example", FALLBACK_URL: "http://www.example.net" } as Env, NOON);
    expect(placeholder.checks.find((c) => c.id === "domains")).toMatchObject({ status: "error", fix: "npm run setup -- domains", docs: "docs/SETUP.md#domains" });
    expect(placeholder.checks.find((c) => c.id === "fallback")?.status).toBe("warn");

    const freePlan = await systemHealth({ ...healthy, WORKERS_PLAN: "free" } as Env, NOON);
    expect(freePlan.checks.find((c) => c.id === "password")).toMatchObject({ status: "warn", fix: "npm run setup -- password" });
    const weak = await systemHealth({ ...healthy, API_TOKEN: "short-token-0123", VISITOR_SALT: "s" } as Env, NOON);
    expect(weak.checks.find((c) => c.id === "secrets")?.detail).toMatch(/API_TOKEN .*VISITOR_SALT/);
    expect((await statusOf({ ...healthy, ADMIN_AUTH: "pasword" } as Env, "security"))).toBe("error");
  });

  it("warns about password-only sign-in without emailing it, unless Access settings are left behind", async () => {
    const pwOnly = { ...healthy, ADMIN_AUTH: "password", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" } as Env;
    expect((await systemHealth(pwOnly, NOON)).checks.find((c) => c.id === "security")).toMatchObject({ status: "warn", advisory: true });
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_rolled', ?)").bind(addDays(utcDate(NOON), -1)).run();
    expect(await checkAndAlert(pwOnly, NOON)).toMatchObject({ sent: false });
    const leftover = (await systemHealth({ ...pwOnly, ACCESS_AUD: "aud" } as Env, NOON)).checks.find((c) => c.id === "security");
    expect(leftover).toMatchObject({ status: "warn", advisory: false });
    expect(leftover?.detail).toContain("ignored");
  });

  it("never includes a secret's value", async () => {
    const secrets = {
      API_TOKEN: "secret-api-token-value-AAAAAAAAAAAAAAAA",
      VISITOR_SALT: "secret-salt-value-BBBBBBBB",
      SESSION_SECRET: "secret-session-value-CCCCCCCCCCCCCCCCCC",
      CF_ANALYTICS_TOKEN: "secret-analytics-value-DDDD",
      DIGEST_API_KEY: "secret-digest-key-EEEE",
    };
    const e = { ...healthy, ...secrets } as Env;
    const short = { ...e, API_TOKEN: "secret-short-FFFF", VISITOR_SALT: "sGGG" } as Env;
    const body = JSON.stringify([await systemHealth(e, NOON), await systemHealth(short, NOON)]);
    for (const v of [...Object.values(secrets), "secret-short-FFFF", "sGGG", healthy.ADMIN_PASSWORD_HASH]) expect(body).not.toContain(v);
  });

  it("emails a new problem once, then the all-clear", async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_rolled', ?)").bind(addDays(utcDate(NOON), -10)).run();
    expect(await checkAndAlert(healthy, NOON)).toEqual({ sent: true });
    const body = JSON.parse((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body as string) as { subject: string; to: string[] };
    expect(body.subject).toContain("problem");
    expect(body.to).toEqual([env.DIGEST_TO]);
    expect(await checkAndAlert(healthy, NOON)).toMatchObject({ sent: false }); // nothing new

    await env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'last_rolled'").bind(addDays(utcDate(NOON), -1)).run();
    expect(await checkAndAlert(healthy, NOON)).toEqual({ sent: true });
    expect((JSON.parse((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body as string) as { subject: string }).subject).toContain("OK again");
  });

  it("is served to the admin", async () => {
    const res = await call(`${API}/settings/health`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { checks: unknown[] }).checks.length).toBeGreaterThan(3);
  });
});

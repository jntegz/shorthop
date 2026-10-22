import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDigest } from "../src/worker/digest";
import { applyMailSettings, mailerStatus, mailProviders, webhookSignature } from "../src/worker/mailer";
import { API, bearer, call, resetData } from "./helpers";

const admin = { "Content-Type": "application/json", ...bearer };
const MAIL = `${API}/settings/mail`;
/** Reading the mail setup is admin-only: the local dev bypass stands in for an admin session. */
const ADMIN_MAIL = "http://localhost:5173/_admin/api/settings/mail";
const readSetup = async (e: Partial<Env>) => (await call(ADMIN_MAIL, undefined, { ...e, DEV_AUTH_BYPASS: "1" })).json();

const SECRET = "whsec-0123456789abcdef0123456789abcdef"; // gitleaks:allow (test fixture)

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await resetData();
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
});

afterEach(() => vi.restoreAllMocks());

const withEnv = (extra: Record<string, string>) => ({ ...env, ...extra }) as unknown as Env;
const lastRequest = () => fetchMock.mock.calls.at(-1) as [string, RequestInit];

describe("digest providers", () => {
  it("defaults to the Cloudflare binding", () => {
    expect(mailerStatus(env)).toEqual({ provider: "cloudflare", problem: null });
  });

  it("sends through Resend with the key as a bearer token, to the configured recipient only", async () => {
    const result = await runDigest(withEnv({ DIGEST_PROVIDER: "resend", DIGEST_API_KEY: "re_key" }), new Date(), true);
    expect(result).toMatchObject({ status: "sent", messageId: "msg-1" });
    const [url, init] = lastRequest();
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    const body = JSON.parse(init.body as string) as { to: string[]; from: string };
    expect(body.to).toEqual([env.DIGEST_TO]);
    expect(body.from).toBe(`Shorthop <${env.DIGEST_FROM}>`);
  });

  it("signs webhook deliveries so the receiver can verify them", async () => {
    const result = await runDigest(withEnv({ DIGEST_PROVIDER: "webhook", DIGEST_WEBHOOK_URL: "https://hooks.example.com/digest", DIGEST_WEBHOOK_SECRET: SECRET }), new Date(), true);
    expect(result.status).toBe("sent");
    const [url, init] = lastRequest();
    expect(url).toBe("https://hooks.example.com/digest");
    const body = init.body as string;
    const sig = (init.headers as Record<string, string>)["X-Shorthop-Signature"]!;
    const t = Number(/t=(\d+)/.exec(sig)?.[1]);
    expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5);
    expect(sig).toBe(await webhookSignature(SECRET, body, t));
    expect(JSON.parse(body)).toMatchObject({ type: "shorthop.digest", to: env.DIGEST_TO });
  });

  it("refuses redirects and reports provider errors briefly", async () => {
    const e = withEnv({ DIGEST_PROVIDER: "postmark", DIGEST_API_KEY: "pm" });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }));
    expect(await runDigest(e, new Date(), true)).toMatchObject({ status: "failed", reason: expect.stringContaining("redirects are not followed") });
    fetchMock.mockResolvedValueOnce(new Response(`{"Message":"Sender not verified"}${"x".repeat(500)}`, { status: 422 }));
    const failed = await runDigest(e, new Date(), true);
    expect(failed.reason).toContain("HTTP 422");
    expect(failed.reason!.length).toBeLessThan(220);
  });

  it("does not send when misconfigured, and never calls out", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ DIGEST_PROVIDER: "resend" }, "RESEND_API_KEY"],
      [{ DIGEST_PROVIDER: "custom", DIGEST_CUSTOM_URL: "https://api.example.com/send" }, "DIGEST_CUSTOM_API_KEY"],
      [{ DIGEST_PROVIDER: "custom", DIGEST_CUSTOM_URL: "https://api.example.com/send", DIGEST_CUSTOM_API_KEY: "k", DIGEST_CUSTOM_BODY: "nope" }, "JSON object"],
      [{ DIGEST_PROVIDER: "custom", DIGEST_CUSTOM_URL: "https://api.example.com/send", DIGEST_CUSTOM_API_KEY: "k", DIGEST_CUSTOM_AUTH: "Host: {key}" }, "DIGEST_CUSTOM_AUTH"],
      [{ DIGEST_PROVIDER: "webhook", DIGEST_WEBHOOK_URL: "http://hooks.example.com/", DIGEST_WEBHOOK_SECRET: SECRET }, "https://"],
      [{ DIGEST_PROVIDER: "webhook", DIGEST_WEBHOOK_URL: "https://hooks.example.com/", DIGEST_WEBHOOK_SECRET: "short" }, "32+"],
      [{ DIGEST_PROVIDER: "mailgun", DIGEST_API_KEY: "k", DIGEST_MAILGUN_DOMAIN: "not a domain" }, "DIGEST_MAILGUN_DOMAIN"],
      [{ DIGEST_PROVIDER: "carrier-pigeon" }, "isn't one of"],
    ];
    for (const [extra, problem] of cases) {
      expect(await runDigest(withEnv(extra), new Date(), true)).toMatchObject({ status: "failed", reason: expect.stringContaining(problem) });
    }
    expect(await runDigest(withEnv({ DIGEST_PROVIDER: "off" }), new Date())).toMatchObject({ status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends through Emailit v2 with its own key", async () => {
    const result = await runDigest(withEnv({ DIGEST_PROVIDER: "emailit", EMAILIT_API_KEY: "secret_abc" }), new Date(), true);
    expect(result.status).toBe("sent");
    const [url, init] = lastRequest();
    expect(url).toBe("https://api.emailit.com/v2/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret_abc");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: env.DIGEST_TO, from: `Shorthop <${env.DIGEST_FROM}>` });
  });

  it("fills a custom API's body template without letting the content change its shape", async () => {
    const e = withEnv({
      DIGEST_PROVIDER: "custom",
      DIGEST_CUSTOM_URL: "https://api.brevo.example/v3/smtp/email",
      DIGEST_CUSTOM_API_KEY: "xkey",
      DIGEST_CUSTOM_AUTH: "api-key: {key}",
      DIGEST_CUSTOM_BODY: '{"sender":{"email":"{from_email}","name":"{from_name}"},"to":[{"email":"{to}"}],"subject":"{subject}","htmlContent":"{html}"}',
    });
    expect(await runDigest(e, new Date(), true)).toMatchObject({ status: "sent" });
    const [url, init] = lastRequest();
    expect(url).toBe("https://api.brevo.example/v3/smtp/email");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("xkey");
    const body = JSON.parse(init.body as string) as { sender: { email: string }; to: { email: string }[]; subject: string; htmlContent: string };
    expect(body.sender.email).toBe(env.DIGEST_FROM);
    expect(body.to).toEqual([{ email: env.DIGEST_TO }]);
    expect(body.subject).toMatch(/^sh\.example weekly/);
    expect(body.htmlContent).toContain("<!doctype html>");
  });

  it("only sends DIGEST_API_KEY to the provider wrangler.jsonc names", () => {
    const e = withEnv({ DIGEST_PROVIDER: "resend", DIGEST_API_KEY: "re_old" });
    const byId = Object.fromEntries(mailProviders(e).map((p) => [p.id, p]));
    expect(byId.resend).toMatchObject({ problem: null, secrets: [{ name: "RESEND_API_KEY", set: true }] });
    expect(byId.emailit!.problem).toContain("EMAILIT_API_KEY");
  });

  it("lets the admin switch provider and sender, but not the recipient", async () => {
    const e = { DIGEST_PROVIDER: "cloudflare", EMAILIT_API_KEY: "secret_abc" } as Partial<Env>;
    const put = await call(MAIL, { method: "PUT", headers: admin, body: JSON.stringify({ provider: "emailit", from: "hello@sh.example", to: "evil@example.com" }) }, e);
    expect(put.status).toBe(200);
    expect((await call(MAIL, { headers: bearer }, e)).status).toBe(403);
    const setup = (await readSetup(e)) as { provider: string; from: string; customized: boolean };
    expect(setup).toMatchObject({ provider: "emailit", from: "hello@sh.example", customized: true });

    expect(await runDigest(withEnv(e as Record<string, string>), new Date(), true)).toMatchObject({ status: "sent" });
    const [url, init] = lastRequest();
    expect(url).toBe("https://api.emailit.com/v2/emails");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: env.DIGEST_TO, from: "Shorthop <hello@sh.example>" });

    await call(MAIL, { method: "DELETE", headers: bearer }, e);
    expect(((await readSetup(e)) as { provider: string }).provider).toBe("cloudflare");
  });

  it("lets the admin turn email off without a sender, keeping DIGEST_FROM", async () => {
    const put = await call(MAIL, { method: "PUT", headers: admin, body: JSON.stringify({ provider: "off", from: "" }) });
    expect(put.status).toBe(200);
    expect(await call(MAIL, { method: "PUT", headers: admin, body: JSON.stringify({ provider: "resend", from: "" }) })).toHaveProperty("status", 400);
    expect(await readSetup({})).toMatchObject({ provider: "off", from: env.DIGEST_FROM });
  });

  it("reports a timeout as a readable reason and records it", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const result = await runDigest(withEnv({ DIGEST_PROVIDER: "resend", RESEND_API_KEY: "re_key_12345678" }), new Date(), true);
    expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/^TimeoutError/) });
  });

  it("keeps secrets out of error reasons", async () => {
    fetchMock.mockResolvedValue(new Response("bad key re_secret_abcdef123 rejected", { status: 401 }));
    const result = await runDigest(withEnv({ DIGEST_PROVIDER: "resend", RESEND_API_KEY: "re_secret_abcdef123" }), new Date(), true);
    expect(result.reason).toContain("***");
    expect(result.reason).not.toContain("re_secret_abcdef123");
  });

  it("sends nothing when the mail settings can't be read", () => {
    const e = applyMailSettings(withEnv({ DIGEST_PROVIDER: "resend", RESEND_API_KEY: "k" }), "unreadable");
    expect(mailerStatus(e).problem).toMatch(/couldn't be read/);
  });

  it("only fills the template's own placeholders", async () => {
    const result = await runDigest(
      withEnv({ DIGEST_PROVIDER: "custom", DIGEST_CUSTOM_URL: "https://api.example.com/send", DIGEST_CUSTOM_API_KEY: "k", DIGEST_CUSTOM_BODY: '{"a":"{constructor}","to":"{to}"}' }),
      new Date(),
      true,
    );
    expect(result.status).toBe("sent");
    const [, init] = lastRequest();
    expect(JSON.parse(init.body as string)).toEqual({ a: "{constructor}", to: env.DIGEST_TO });
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDigest } from "../src/worker/digest";
import { mailerStatus, webhookSignature } from "../src/worker/mailer";
import { resetData } from "./helpers";

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
      [{ DIGEST_PROVIDER: "resend" }, "DIGEST_API_KEY"],
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
});

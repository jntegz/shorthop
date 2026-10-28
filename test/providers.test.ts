import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionCheckDTO, ConnectionDTO, SitePaymentDTO, SiteDTO } from "../src/shared/sites";
import { bytesToBase64, bytesToHex, sign } from "../src/worker/revenue/crypto";
import { resetPaypalTokens } from "../src/worker/revenue/providers/paypal";
import { API, call, json, ORIGIN, resetData } from "./helpers";

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

beforeEach(async () => {
  vi.restoreAllMocks();
  resetPaypalTokens();
  await resetData();
});

async function createSite(): Promise<SiteDTO> {
  return (await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }))).json<SiteDTO>();
}

async function connect(site: SiteDTO, body: Record<string, unknown>): Promise<ConnectionDTO> {
  const res = await call(`${API}/sites/${site.id}/connections`, json(body));
  expect(res.status).toBe(201);
  return res.json<ConnectionDTO>();
}

async function visit(site: SiteDTO): Promise<string> {
  const res = await call(`${ORIGIN}/_t/e`, { method: "POST", headers: { Origin: SITE_ORIGIN, "User-Agent": UA }, body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/` }) });
  return (await res.json<{ s: string }>()).s;
}

async function payments(site: SiteDTO): Promise<SitePaymentDTO[]> {
  return (await (await call(`${API}/sites/${site.id}/payments?range=7d`, { headers: json({}).headers })).json<{ payments: SitePaymentDTO[] }>()).payments;
}

const check = async (site: SiteDTO, conn: ConnectionDTO, extra: Partial<Env> = {}) =>
  (await call(`${API}/sites/${site.id}/connections/${conn.id}/check`, json({}), extra)).json<ConnectionCheckDTO>();

describe("Gumroad", () => {
  it("authenticates by the token in the address and reads url_params", async () => {
    const site = await createSite();
    const ref = await visit(site);
    const conn = await connect(site, { provider: "gumroad" });
    expect(conn.webhookUrl).toMatch(/\/_pay\/gumroad\/pc_[\w-]+\?token=[\w-]{20,}$/);
    const ping = new URLSearchParams({ sale_id: "s1", sale_timestamp: new Date().toISOString(), price: "2900", currency: "eur", email: "G@x.co", product_id: "p1", "url_params[sh_ref]": ref, test: "false" });
    const post = (url: string) => call(url.replace("https://sh.example", ORIGIN), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: ping.toString() });

    expect((await post(conn.webhookUrl.replace(/token=.*/, "token=wrong"))).status).toBe(401);
    expect((await post(conn.webhookUrl)).status).toBe(200);
    // Amounts are USD cents whatever the product's currency.
    expect((await payments(site))[0]).toMatchObject({ amountMinor: 2900, currency: "USD", email: "g@x.co", matchedBy: "ref" });
  });

  it("keeps the latest refund total when a sale is refunded twice", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad" });
    const post = (fields: Record<string, string>) =>
      call(conn.webhookUrl.replace("https://sh.example", ORIGIN), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    expect((await post({ sale_id: "s2", sale_timestamp: new Date().toISOString(), price: "5000" })).status).toBe(200);
    expect(await (await post({ resource_name: "refund", sale_id: "s2", price: "1000" })).json()).toMatchObject({ ok: true });
    expect(await (await post({ resource_name: "refund", sale_id: "s2", price: "3000" })).json()).not.toMatchObject({ duplicate: true });
    expect(await (await post({ resource_name: "refund", sale_id: "s2", price: "3000" })).json()).toMatchObject({ duplicate: true });
    expect((await payments(site)).find((p) => p.kind === "refund")).toMatchObject({ amountMinor: -3000 });
  });

  it("confirms the sale with Gumroad when an access token is set", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "gumroad", apiKey: "tok" });
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.gumroad.com/v2/sales/known")) return Response.json({ success: true, sale: {} });
      if (url.startsWith("https://api.gumroad.com/")) return Response.json({ success: false }, { status: 404 });
      return real(input, init);
    });
    const post = (sale: string) => call(conn.webhookUrl.replace("https://sh.example", ORIGIN), { method: "POST", body: new URLSearchParams({ sale_id: sale, price: "100" }).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect((await post("forged")).status).toBe(401);
    expect((await post("known")).status).toBe(200);
  });
});

describe("FastSpring", () => {
  it("verifies the base64 HMAC and stores decimal amounts in minor units", async () => {
    const site = await createSite();
    const ref = await visit(site);
    const conn = await connect(site, { provider: "fastspring", webhookSecret: "fs-secret" });
    const body = JSON.stringify({
      events: [
        { id: "ev1", type: "order.completed", live: true, created: Date.now(), data: { id: "ord1", reference: "REF-1", currency: "EUR", total: 49.5, customer: { email: "f@s.co" }, account: "acc1", tags: { sh_ref: ref }, items: [{ product: "pro" }] } },
        { id: "ev2", type: "return.created", live: true, created: Date.now(), data: { return: "ret1", totalReturn: 10, currency: "EUR", original: { id: "ord1" } } },
      ],
    });
    const sig = bytesToBase64(await sign("fs-secret", body));
    const send = (s: string) => call(`${ORIGIN}/_pay/fastspring/${conn.id}`, { method: "POST", headers: { "X-FS-Signature": s }, body });
    expect((await send("AAAA")).status).toBe(401);
    expect((await send(sig)).status).toBe(200);
    const list = await payments(site);
    expect(list.map((p) => [p.kind, p.amountMinor, p.currency, p.matchedBy]).sort()).toEqual([
      ["charge", 4950, "EUR", "ref"],
      ["refund", -1000, "EUR", "ref"],
    ]);
  });

  it("tells apart batches whose events have no ids", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "fastspring", webhookSecret: "fs-secret" });
    const send = async (order: string) => {
      const body = JSON.stringify({
        events: [
          { type: "order.completed", live: true, data: { id: order, currency: "EUR", total: 10 } },
          { type: "order.completed", live: true, data: { id: `${order}-b`, currency: "EUR", total: 10 } },
        ],
      });
      const res = await call(`${ORIGIN}/_pay/fastspring/${conn.id}`, { method: "POST", headers: { "X-FS-Signature": bytesToBase64(await sign("fs-secret", body)) }, body });
      return res.json();
    };
    expect(await send("ord-a")).not.toMatchObject({ duplicate: true });
    expect(await send("ord-c")).not.toMatchObject({ duplicate: true });
    expect(await payments(site)).toHaveLength(4);
  });
});

describe("PayPal", () => {
  it("asks PayPal to verify each webhook", async () => {
    const site = await createSite();
    const ref = await visit(site);
    const conn = await connect(site, { provider: "paypal", apiKey: "client-secret", settings: { clientId: "cid", webhookId: "WH-1", sandbox: "1" } });
    const verified: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://api-m.sandbox.paypal.com/v1/oauth2/token") {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${btoa("cid:client-secret")}`);
        return Response.json({ access_token: "A21", expires_in: 3600 });
      }
      if (url === "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature") {
        const req = JSON.parse(String(init?.body)) as { webhook_id: string; transmission_sig: string };
        verified.push(req.transmission_sig);
        return Response.json({ verification_status: req.webhook_id === "WH-1" && req.transmission_sig === "good" ? "SUCCESS" : "FAILURE" });
      }
      return real(input, init);
    });
    const body = JSON.stringify({
      id: "WH-EVT-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP1", amount: { value: "19.99", currency_code: "USD" }, custom_id: ref, create_time: new Date().toISOString() },
    });
    const send = (sig: string) => call(`${ORIGIN}/_pay/paypal/${conn.id}`, { method: "POST", headers: { "PAYPAL-TRANSMISSION-SIG": sig, "PAYPAL-TRANSMISSION-ID": "t1", "PAYPAL-AUTH-ALGO": "SHA256withRSA" }, body });
    expect((await send("bad")).status).toBe(401);
    expect((await send("good")).status).toBe(200);
    expect(verified).toEqual(["bad", "good"]);
    expect((await payments(site))[0]).toMatchObject({ amountMinor: 1999, currency: "USD", matchedBy: "ref", testMode: true });
  });
});

describe("Cloudflare secrets, pausing and the checker", () => {
  it("reads a secret by name from the Worker's environment, and refuses the Worker's own", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "lemonsqueezy", webhookSecretRef: "LS_SECRET_SHOP" });
    expect(conn).toMatchObject({ webhookSecretMode: "cloudflare", webhookSecretRef: "LS_SECRET_SHOP", hasSecret: true });
    const bad = await call(`${API}/sites/${site.id}/connections/${conn.id}`, { ...json({ webhookSecretRef: "SESSION_SECRET" }), method: "PATCH" });
    expect(bad.status).toBe(400);

    const body = JSON.stringify({ meta: { event_name: "order_created" }, data: { id: "9", attributes: { status: "paid", total: 500, currency: "USD" } } });
    const sig = bytesToHex(await sign("from-cloudflare", body));
    const send = (extra: Partial<Env>) => call(`${ORIGIN}/_pay/lemonsqueezy/${conn.id}`, { method: "POST", headers: { "X-Signature": sig }, body }, extra);
    // Not set yet: refused, and the connection says how to set it.
    expect((await send({})).status).toBe(503);
    const before = await check(site, conn);
    expect(before.checks.find((c) => c.id === "secret")).toMatchObject({ status: "error", detail: expect.stringContaining("wrangler secret put LS_SECRET_SHOP") });
    // Set: works, and the checker signs a test event with it.
    const withSecret = { LS_SECRET_SHOP: "from-cloudflare" } as unknown as Partial<Env>;
    expect((await send(withSecret)).status).toBe(200);
    const after = await check(site, conn, withSecret);
    expect(after.checks.find((c) => c.id === "secret")).toMatchObject({ status: "ok", detail: expect.stringContaining("verifies") });
    expect(after.checks.find((c) => c.id === "events")?.status).toBe("ok");
    expect(after.ok).toBe(true);
  });

  it("switching a pasted secret to a name forgets the pasted copy", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_pasted" });
    expect(conn.webhookSecretMode).toBe("stored");
    const res = await call(`${API}/sites/${site.id}/connections/${conn.id}`, { ...json({ webhookSecretRef: "STRIPE_WEBHOOK_SECRET_SHOP" }), method: "PATCH" });
    expect(await res.json()).toMatchObject({ webhookSecretMode: "cloudflare" });
    expect(await env.DB.prepare("SELECT webhook_secret FROM payment_connections").first("webhook_secret")).toBeNull();
  });

  it("answers but records nothing while a connection is paused", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "lemonsqueezy", webhookSecret: "s3cret", enabled: false });
    const body = JSON.stringify({ meta: { event_name: "order_created" }, data: { id: "1", attributes: { status: "paid", total: 500, currency: "USD" } } });
    const res = await call(`${ORIGIN}/_pay/lemonsqueezy/${conn.id}`, { method: "POST", headers: { "X-Signature": bytesToHex(await sign("s3cret", body)) }, body });
    expect(await res.json()).toMatchObject({ ignored: expect.any(String) });
    expect(await payments(site)).toEqual([]);
    expect((await check(site, conn)).checks[0]).toMatchObject({ id: "enabled", status: "warn" });
  });

  it("tests the API key with the provider", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_x", apiKey: "rk_bad" });
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.stripe.com/")) return Response.json({ error: { message: "Invalid API Key" } }, { status: 401 });
      return real(input, init);
    });
    const result = await check(site, conn);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "apiKey")).toMatchObject({ status: "error", detail: expect.stringContaining("401") });
    expect(result.checks.find((c) => c.id === "secret")).toMatchObject({ status: "ok" });
  });
});

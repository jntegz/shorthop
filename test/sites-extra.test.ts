import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDTO, FunnelDTO, FunnelReportDTO, SiteDTO } from "../src/shared/sites";
import { digestData, renderDigest } from "../src/worker/digest";
import { walkFunnel } from "../src/worker/web/funnels";
import { aePoint, mockAeSql, type StoredPoint } from "./ae-mock";
import { API, call, captureClicks, json, ORIGIN, resetData } from "./helpers";

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetData();
});

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const AE_ENV = { CF_ACCOUNT_ID: "acc", CF_ANALYTICS_TOKEN: "token" };

async function createSite(): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }));
  return res.json<SiteDTO>();
}

describe("funnels", () => {
  it("counts visitors through the steps in order, within the window", () => {
    const t = (visitor: string, key: string, at: number) => ({ visitor, key, at });
    const steps = [
      { type: "page" as const, value: "/" },
      { type: "page" as const, value: "/pricing" },
      { type: "goal" as const, value: "signup" },
    ];
    const reached = walkFunnel(
      [
        t("a", "p/", 0), t("a", "p/pricing", 10), t("a", "gsignup", 20),
        t("b", "p/", 0), t("b", "p/pricing", 5),
        t("c", "gsignup", 0), t("c", "p/", 5),
        // Too late for the window.
        t("d", "p/", 0), t("d", "p/pricing", 100_000),
      ],
      steps,
      3600,
    );
    expect(Object.fromEntries([...reached].map(([v, times]) => [v, times.length]))).toEqual({ a: 3, b: 2, c: 1, d: 1 });
  });

  it("reports a saved funnel from Analytics Engine, with who paid afterwards", async () => {
    const site = await createSite();
    const { points, CLICKS: WEB } = captureClicks();
    const send = async (ip: string, body: Record<string, unknown>) => {
      const res = await call(
        `${ORIGIN}/_t/e`,
        { method: "POST", headers: { Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": ip }, body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/`, ...body }) },
        { WEB },
      );
      return res.status === 200 ? (await res.json<{ s: string }>()).s : null;
    };
    const refA = await send("203.0.113.1", {});
    await send("203.0.113.1", { u: `${SITE_ORIGIN}/pricing` });
    await send("203.0.113.1", { t: "goal", n: "signup" });
    await send("203.0.113.2", {});
    await send("203.0.113.2", { u: `${SITE_ORIGIN}/pricing` });
    await send("203.0.113.3", { u: `${SITE_ORIGIN}/pricing` });

    const base = Math.floor(Date.now() / 1000) - 3600;
    const stored: StoredPoint[] = points.map((p, i) => aePoint(p, base + i * 60));
    mockAeSql(stored);

    const created = await call(`${API}/sites/${site.id}/funnels`, json({ name: "Signup", steps: [{ type: "page", value: "/" }, { type: "page", value: "/pricing" }, { type: "goal", value: "signup" }] }));
    expect(created.status).toBe(201);
    const funnel = await created.json<FunnelDTO>();
    await call(`${API}/sites/${site.id}/payments`, json({ id: "o-1", amount: 20, currency: "USD", ref: refA }));

    const res = await call(`${API}/sites/${site.id}/funnels/${funnel.id}/report?range=7d`, { headers: json({}).headers }, AE_ENV);
    const report = await res.json<FunnelReportDTO>();
    expect(report.steps.map((s) => s.visitors)).toEqual([2, 2, 1]);
    expect(report.steps[1]!.medianSecFromPrevious).toBe(60);
    expect(report.paid).toEqual({ visitors: 1, revenue: 2000 });

    const del = await call(`${API}/sites/${site.id}/funnels/${funnel.id}`, { method: "DELETE", headers: json({}).headers });
    expect(del.status).toBe(200);
  });

  it("needs two steps", async () => {
    const site = await createSite();
    const res = await call(`${API}/sites/${site.id}/funnels`, json({ name: "One", steps: [{ type: "page", value: "/" }] }));
    expect(res.status).toBe(400);
  });
});

describe("importing past payments", () => {
  it("imports Stripe checkouts once, through the same adapter as webhooks", async () => {
    const site = await createSite();
    const conn = await (await call(`${API}/sites/${site.id}/connections`, json({ provider: "stripe", webhookSecret: "whsec_x", apiKey: "rk_test_123" }))).json<ConnectionDTO>(); // gitleaks:allow (test fixture)
    const now = Math.floor(Date.now() / 1000);
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.stripe.com/")) return realFetch(input, init);
      asked.push(url);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer rk_test_123");
      if (url.includes("/checkout/sessions")) {
        return Response.json({
          has_more: false,
          data: [{ id: "cs_old", mode: "payment", payment_status: "paid", payment_intent: "pi_old", amount_total: 3000, currency: "usd", livemode: true, created: now - 86400, customer_details: { email: "old@example.com" } }],
        });
      }
      if (url.includes("/charges")) return Response.json({ has_more: false, data: [{ id: "ch_old", payment_intent: "pi_old", amount_refunded: 500, currency: "usd", livemode: true, created: now - 3600 }] });
      return Response.json({ has_more: false, data: [] });
    });

    const run = async () => (await call(`${API}/sites/${site.id}/connections/${conn.id}/import`, json({ days: 30 }))).json<{ imported: number; next: string | null }>();
    expect(await run()).toMatchObject({ imported: 1, next: null });
    expect(asked.map((u) => new URL(u).pathname)).toEqual(["/v1/checkout/sessions", "/v1/invoices", "/v1/charges"]);
    expect(await run()).toMatchObject({ imported: 0 });

    const rows = await env.DB.prepare("SELECT kind, amount_minor, email FROM payments ORDER BY kind").all();
    expect(rows.results).toEqual([
      { kind: "charge", amount_minor: 3000, email: "old@example.com" },
      { kind: "refund", amount_minor: -500, email: null },
    ]);
  });

  it("needs an API key, and isn't offered for PayPal", async () => {
    const site = await createSite();
    const stripe = await (await call(`${API}/sites/${site.id}/connections`, json({ provider: "stripe" }))).json<ConnectionDTO>();
    expect((await call(`${API}/sites/${site.id}/connections/${stripe.id}/import`, json({}))).status).toBe(400);
    const paypal = await (await call(`${API}/sites/${site.id}/connections`, json({ provider: "paypal", apiKey: "k" }))).json<ConnectionDTO>();
    expect((await call(`${API}/sites/${site.id}/connections/${paypal.id}/import`, json({}))).status).toBe(400);
  });
});

describe("weekly digest", () => {
  it("lists each website's visitors and revenue", async () => {
    const site = await createSite();
    const yesterday = Math.floor(Date.now() / 1000) - 86400;
    await env.DB.prepare(
      `INSERT INTO payments (id, site_id, provider, kind, billing, occurred_at, amount_minor, currency, amount_site_minor, test_mode, created_at)
       VALUES ('api:charge:1', ?1, 'api', 'charge', 'one_time', ?2, 4900, 'USD', 4900, 0, ?2)`,
    )
      .bind(site.id, yesterday)
      .run();
    const d = await digestData(env);
    expect(d.websites).toEqual([{ id: site.id, name: "Shop", currency: "USD", visitors: 0, revenue: 4900, previousRevenue: 0, payments: 1, topSource: null }]);
    const { text, html } = renderDigest(d, "https://sh.example", "sh.example");
    expect(text).toContain("Shop: 0 visitors, $49.00");
    expect(html).toContain("Websites");
  });
});

describe("payment emails", () => {
  it("emails each new payment when the site asks for it, not tests or retries", async () => {
    const site = await createSite();
    await call(`${API}/sites/${site.id}`, { ...json({ notifyPayments: true }), method: "PATCH" });
    const conn = await (await call(`${API}/sites/${site.id}/connections`, json({ provider: "lemonsqueezy", webhookSecret: "s3cret" }))).json<ConnectionDTO>();
    const sent: { subject: string }[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://api.resend.com/")) {
        sent.push(JSON.parse(String(init?.body)) as { subject: string });
        return Response.json({ id: "msg" });
      }
      return realFetch(input, init);
    });
    const mail = { DIGEST_PROVIDER: "resend", DIGEST_API_KEY: "re_key" } as Partial<Env>;
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(text)))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return call(`${ORIGIN}/_pay/lemonsqueezy/${conn.id}`, { method: "POST", headers: { "X-Signature": sig }, body: text }, mail);
    };
    const order = { meta: { event_name: "order_created" }, data: { id: "1", attributes: { status: "paid", total: 1500, currency: "USD", user_email: "a@b.co" } } };
    await send(order);
    await send({ ...order, data: { ...order.data, attributes: { ...order.data.attributes, total: 1500.0, user_email: "a@b.co " } } });
    await send({ meta: { event_name: "order_created" }, data: { id: "2", attributes: { status: "paid", total: 900, currency: "USD", test_mode: true } } });
    expect(sent.map((m) => m.subject)).toEqual(["Payment: $15.00 on Shop"]);
  });
});

describe("payments list", () => {
  it("pages and searches on the server", async () => {
    const site = await createSite();
    for (let i = 0; i < 30; i++) await call(`${API}/sites/${site.id}/payments`, json({ id: `o-${i}`, amount: 10, currency: "USD", email: i === 7 ? "needle@example.com" : `buyer${i}@example.com` }));
    const get = async (qs: string) => (await call(`${API}/sites/${site.id}/payments?range=7d&${qs}`, { headers: json({}).headers })).json<{ payments: { id: string }[]; total: number; net: number }>();
    const first = await get("limit=25");
    expect(first.payments).toHaveLength(25);
    expect(first).toMatchObject({ total: 30, net: 30_000 });
    const second = await get("limit=25&offset=25");
    expect(second.payments).toHaveLength(5);
    expect(new Set([...first.payments, ...second.payments].map((p) => p.id)).size).toBe(30);
    const found = await get("q=NEEDLE");
    expect(found).toMatchObject({ total: 1, payments: [{ id: "api:charge:o-7" }] });
    expect((await get("q=50%25")).total).toBe(0);
  });
});

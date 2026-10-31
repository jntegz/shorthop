// Short links straight to a hosted checkout: the redirect adds a reference,
// the payment webhook brings it back, and the sale is credited to the link.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutProvider, withCheckoutRef } from "../src/shared/checkout";
import type { ConnectionDTO, LinkRevenueDTO, SiteDTO, SiteOverviewDTO, SitePaymentDTO } from "../src/shared/sites";
import { bytesToBase64, bytesToHex, sign } from "../src/worker/revenue/crypto";
import { resetSiteCaches } from "../src/worker/web/sites";
import { API, call, json, ORIGIN, putLink, resetData } from "./helpers";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const now = () => Math.floor(Date.now() / 1000);
const headers = json({}).headers;

beforeEach(async () => {
  await resetData();
  await env.DB.exec("DELETE FROM link_clicks");
  resetSiteCaches();
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input instanceof Request ? input.url : input).includes("frankfurter") ? Promise.resolve(new Response("offline", { status: 503 })) : realFetch(input, init),
  );
});

async function createSite(): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"] }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

async function connect(site: SiteDTO, body: Record<string, unknown>): Promise<ConnectionDTO> {
  const res = await call(`${API}/sites/${site.id}/connections`, json(body));
  expect(res.status).toBe(201);
  resetSiteCaches();
  return res.json<ConnectionDTO>();
}

const hook = (conn: ConnectionDTO, body: string, h: Record<string, string>) =>
  call(`${ORIGIN}/_pay/${conn.provider}/${conn.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body });

/** Follows the short link as a person; returns where it sent them. */
async function click(slug: string, ua = UA): Promise<URL> {
  const res = await call(`${ORIGIN}/${slug}`, { headers: { "User-Agent": ua }, redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("Location")!);
}

/** The recorded click is written in the background; wait for it. */
async function recorded(ref: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await env.DB.prepare("SELECT 1 FROM link_clicks WHERE ref = ?").bind(ref).first()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`click ${ref} wasn't recorded`);
}

const linkRevenue = async (slug: string) => (await call(`${API}/sites/by-link/sh.example/${slug}`, { headers })).json<LinkRevenueDTO>();
const payments = async (site: SiteDTO) => (await (await call(`${API}/sites/${site.id}/payments?range=7d`, { headers })).json<{ payments: SitePaymentDTO[] }>()).payments;

describe("checkout URLs", () => {
  it("knows each provider's hosted checkout and where the reference goes", () => {
    expect(checkoutProvider(new URL("https://buy.stripe.com/test_abc"))).toBe("stripe");
    expect(checkoutProvider(new URL("https://shop.lemonsqueezy.com/checkout/buy/uuid"))).toBe("lemonsqueezy");
    expect(checkoutProvider(new URL("https://shop.lemonsqueezy.com/"))).toBeNull();
    expect(checkoutProvider(new URL("https://test.checkout.dodopayments.com/buy/pdt_1"))).toBe("dodo");
    expect(checkoutProvider(new URL("https://www.creem.io/test/payment/prod_1"))).toBe("creem");
    expect(checkoutProvider(new URL("https://jan.gumroad.com/l/book"))).toBe("gumroad");
    expect(checkoutProvider(new URL("https://example.com/buy"))).toBeNull();

    expect(withCheckoutRef("https://buy.stripe.com/x", "R")).toBe("https://buy.stripe.com/x?client_reference_id=sh_R");
    expect(new URL(withCheckoutRef("https://s.lemonsqueezy.com/checkout/buy/u", "R")).searchParams.get("checkout[custom][sh_ref]")).toBe("R");
    expect(withCheckoutRef("https://checkout.dodopayments.com/buy/p", "R")).toContain("metadata_sh_ref=R");
    expect(new URL(withCheckoutRef("https://creem.io/payment/p", "R")).searchParams.get("metadata[sh_ref]")).toBe("R");
    expect(withCheckoutRef("https://gumroad.com/l/b?wanted=true", "R")).toBe("https://gumroad.com/l/b?wanted=true&sh_ref=R");
    // The owner's own reference stays.
    expect(withCheckoutRef("https://buy.stripe.com/x?client_reference_id=mine", "R")).toBe("https://buy.stripe.com/x?client_reference_id=mine");
  });
});

describe("short links straight to a checkout", () => {
  it("Stripe: credits the sale to the link, and its refund too", async () => {
    const site = await createSite();
    const conn = await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
    await putLink("buy", { u: "https://buy.stripe.com/test_abc" });
    const to = await click("buy");
    const reference = to.searchParams.get("client_reference_id")!;
    expect(reference).toMatch(/^sh_[\w-]{16}$/);
    await recorded(reference.slice(3));

    const paid = JSON.stringify({
      id: "evt_paid",
      type: "checkout.session.completed",
      livemode: true,
      created: now(),
      data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 4900, currency: "usd", client_reference_id: reference } },
    });
    const stripe = async (body: string) => {
      const t = now();
      return { "Stripe-Signature": `t=${t},v1=${bytesToHex(await sign("whsec_test", `${t}.${body}`))}` };
    };
    expect((await hook(conn, paid, await stripe(paid))).status).toBe(200);
    const refund = JSON.stringify({ id: "evt_r", type: "charge.refunded", livemode: true, created: now(), data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: 900, currency: "usd" } } });
    expect((await hook(conn, refund, await stripe(refund))).status).toBe(200);

    const list = await payments(site);
    expect(list.find((p) => p.kind === "charge")).toMatchObject({ matchedBy: "ref", confidence: "high" });
    expect(list.find((p) => p.kind === "refund")).toMatchObject({ matchedBy: "ref" });
    expect(await linkRevenue("buy")).toMatchObject({ revenue: 4000, payments: 1, customers: 1 });

    // The click never reached the site: no visit, no visitor, nothing live.
    const o = await (await call(`${API}/sites/${site.id}/overview?range=7d`, { headers })).json<SiteOverviewDTO>();
    expect(o.totals).toMatchObject({ visitors: 0, sessions: 0, revenue: 4000, payments: 1 });
    const live = await (await call(`${API}/sites/${site.id}/live`, { headers })).json<{ online: number; sessions: unknown[] }>();
    expect(live).toMatchObject({ online: 0, sessions: [] });
  });

  it("Lemon Squeezy, Dodo and Gumroad read the reference back too", async () => {
    const site = await createSite();
    const ls = await connect(site, { provider: "lemonsqueezy", webhookSecret: "ls-secret" });
    const key = crypto.getRandomValues(new Uint8Array(24));
    const dodo = await connect(site, { provider: "dodo", webhookSecret: `whsec_${bytesToBase64(key)}` });
    const gum = await connect(site, { provider: "gumroad" });
    await putLink("ls", { u: "https://shop.lemonsqueezy.com/checkout/buy/uuid" });
    await putLink("dodo", { u: "https://checkout.dodopayments.com/buy/pdt_1" });
    await putLink("gum", { u: "https://jan.gumroad.com/l/book" });

    const lsRef = (await click("ls")).searchParams.get("checkout[custom][sh_ref]")!;
    const dodoRef = (await click("dodo")).searchParams.get("metadata_sh_ref")!;
    const gumRef = (await click("gum")).searchParams.get("sh_ref")!;
    for (const r of [lsRef, dodoRef, gumRef]) await recorded(r);

    const lsBody = JSON.stringify({ meta: { event_name: "order_created", custom_data: { sh_ref: lsRef } }, data: { id: "77", attributes: { status: "paid", total: 1200, currency: "USD", customer_id: 5, first_order_item: { product_id: 9 } } } });
    expect((await hook(ls, lsBody, { "X-Signature": bytesToHex(await sign("ls-secret", lsBody)) })).status).toBe(200);

    const dodoBody = JSON.stringify({ type: "payment.succeeded", timestamp: new Date().toISOString(), data: { payment_id: "pay_1", total_amount: 5000, currency: "USD", customer: { customer_id: "c1" }, metadata: { sh_ref: dodoRef }, product_cart: [{ product_id: "pdt_1" }] } });
    const ts = String(now());
    const dodoSig = bytesToBase64(await sign(key, `msg_1.${ts}.${dodoBody}`));
    expect((await hook(dodo, dodoBody, { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,${dodoSig}` })).status).toBe(200);

    const ping = new URLSearchParams({ sale_id: "s1", sale_timestamp: new Date().toISOString(), price: "2900", product_id: "p1", "url_params[sh_ref]": gumRef });
    const gumRes = await call(gum.webhookUrl.replace(/^https:\/\/[^/]+/, ORIGIN), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: ping.toString() });
    expect(gumRes.status).toBe(200);

    expect(await linkRevenue("ls")).toMatchObject({ revenue: 1200, payments: 1 });
    expect(await linkRevenue("dodo")).toMatchObject({ revenue: 5000, payments: 1 });
    expect(await linkRevenue("gum")).toMatchObject({ revenue: 2900, payments: 1 });
  });

  it("leaves bots, other checkouts and links without a connected provider alone", async () => {
    const site = await createSite();
    await putLink("buy", { u: "https://buy.stripe.com/test_abc" });
    await putLink("own", { u: "https://buy.stripe.com/test_abc?client_reference_id=mine" });
    await putLink("ls", { u: "https://shop.lemonsqueezy.com/checkout/buy/uuid" });

    // No Stripe connection yet.
    expect((await click("buy")).searchParams.has("client_reference_id")).toBe(false);

    await connect(site, { provider: "stripe", webhookSecret: "whsec_test" });
    expect((await click("buy", "Googlebot/2.1 (+http://www.google.com/bot.html)")).searchParams.has("client_reference_id")).toBe(false);
    expect((await click("own")).searchParams.get("client_reference_id")).toBe("mine");
    // Lemon Squeezy isn't connected.
    expect((await click("ls")).searchParams.has("checkout[custom][sh_ref]")).toBe(false);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM link_clicks").first<{ n: number }>())?.n).toBe(0);
  });

  it("a payment with an unknown reference stays unmatched", async () => {
    const site = await createSite();
    await call(`${API}/sites/${site.id}/payments`, json({ id: "o-1", amount: 10, currency: "USD", ref: "AAAAAAAAAAAAAAAA" }));
    expect((await payments(site))[0]).toMatchObject({ matchedBy: null });
  });
});

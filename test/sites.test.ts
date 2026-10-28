import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteDTO, SiteOverviewDTO, SiteBreakdownRow, SitePaymentDTO, ConnectionDTO, LinkRevenueDTO } from "../src/shared/sites";
import { hostBelongs, pathMatches } from "../src/shared/sites";
import { bucketEdges, localDate, localMidnight } from "../src/shared/tz";
import { bytesToBase64, bytesToHex, sign } from "../src/worker/revenue/crypto";
import { convert } from "../src/worker/revenue/fx";
import { signClickToken, verifyClickToken } from "../src/worker/web/token";
import { attributionOf } from "../src/worker/web/source";
import { API, call, json, ORIGIN, putLink, resetData } from "./helpers";
import { addUser, adminCall } from "./people";

beforeEach(async () => {
  await resetData();
  // No network in tests: exchange rates are seeded where a test needs them.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input instanceof Request ? input.url : input).includes("frankfurter") ? Promise.resolve(new Response("offline", { status: 503 })) : realFetch(input, init),
  );
});

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

async function createSite(body: Record<string, unknown> = {}): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"], ...body }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

async function collect(site: SiteDTO, payload: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return call(`${ORIGIN}/_t/e`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/`, r: "", w: 1440, ...payload }),
  });
}

async function pageview(site: SiteDTO, url = `${SITE_ORIGIN}/`, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<string> {
  const res = await collect(site, { u: url, ...extra }, headers);
  expect(res.status).toBe(200);
  return (await res.json<{ s: string }>()).s;
}

async function addConnection(site: SiteDTO, provider: string, webhookSecret: string, extra: Record<string, unknown> = {}): Promise<ConnectionDTO> {
  const res = await call(`${API}/sites/${site.id}/connections`, json({ provider, webhookSecret, ...extra }));
  expect(res.status).toBe(201);
  return res.json<ConnectionDTO>();
}

function hook(conn: ConnectionDTO, body: string, headers: Record<string, string>): Promise<Response> {
  return call(`${ORIGIN}/_pay/${conn.provider}/${conn.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

const now = () => Math.floor(Date.now() / 1000);

async function stripeHeaders(secret: string, body: string, t = now()): Promise<Record<string, string>> {
  return { "Stripe-Signature": `t=${t},v1=${bytesToHex(await sign(secret, `${t}.${body}`))}` };
}

async function overview(site: SiteDTO, query = "range=7d"): Promise<SiteOverviewDTO> {
  const res = await call(`${API}/sites/${site.id}/overview?${query}`, { headers: json({}).headers });
  expect(res.status).toBe(200);
  return res.json<SiteOverviewDTO>();
}

async function sitePayments(site: SiteDTO): Promise<SitePaymentDTO[]> {
  const res = await call(`${API}/sites/${site.id}/payments?range=7d`, { headers: json({}).headers });
  return (await res.json<{ payments: SitePaymentDTO[] }>()).payments;
}

describe("shared helpers", () => {
  it("matches hosts and path globs", () => {
    expect(hostBelongs("www.shop.example.com", ["shop.example.com"])).toBe(true);
    expect(hostBelongs("app.shop.example.com", ["shop.example.com"])).toBe(true);
    expect(hostBelongs("evilshop.example.com", ["shop.example.com"])).toBe(false);
    expect(pathMatches("/admin/users", "/admin/*")).toBe(true);
    expect(pathMatches("/admin/users/1", "/admin/*")).toBe(false);
    expect(pathMatches("/admin/users/1", "/admin/**")).toBe(true);
  });

  it("buckets days in the site's zone across a DST change", () => {
    // Europe/Prague moves to summer time on 2026-03-29: that day has 23 hours.
    const edges = bucketEdges("2026-03-28", "2026-03-30", "Europe/Prague", "day");
    expect(edges.length).toBe(4);
    expect(edges[1]! - edges[0]!).toBe(86400);
    expect(edges[2]! - edges[1]!).toBe(23 * 3600);
    expect(localDate(edges[2]!, "Europe/Prague")).toBe("2026-03-30");
    expect(localMidnight("2026-01-15", "America/New_York")).toBe(Date.UTC(2026, 0, 15, 5) / 1000);
    expect(bucketEdges("2026-03-29", "2026-03-29", "Europe/Prague", "hour").length).toBe(24);
  });

  it("classifies sources and channels", () => {
    expect(attributionOf(new URL("https://x.com/?utm_source=google&utm_medium=cpc"), "", null)).toMatchObject({ source: "Google", channel: "Paid" });
    expect(attributionOf(new URL("https://x.com/?utm_source=newsletter&utm_medium=email&utm_campaign=oct"), "", null)).toMatchObject({ channel: "Email", utm: { campaign: "oct" } });
    expect(attributionOf(new URL("https://x.com/"), "chatgpt.com", null)).toMatchObject({ source: "ChatGPT", channel: "AI" });
    expect(attributionOf(new URL("https://x.com/"), "news.ycombinator.com", null)).toMatchObject({ source: "Hacker News", channel: "Organic Social" });
    expect(attributionOf(new URL("https://x.com/"), "someblog.dev", null)).toMatchObject({ source: "someblog.dev", channel: "Referral" });
    expect(attributionOf(new URL("https://x.com/?gclid=abc"), "google.com", null)).toMatchObject({ source: "Google Ads", channel: "Paid" });
    expect(attributionOf(new URL("https://x.com/"), "", null)).toMatchObject({ source: "Typed / bookmark", channel: "Direct" });
    expect(attributionOf(new URL("https://x.com/"), "", { domain: "sh.example", slug: "launch", source: "li", at: 0 })).toMatchObject({ source: "LinkedIn", channel: "Short link", link: { slug: "launch" } });
  });

  it("signs click tokens that can't be forged or reused for long", async () => {
    const t = await signClickToken("secret", { domain: "sh.example", slug: "a", source: "x", at: 1000 });
    expect(await verifyClickToken("secret", t, 1010)).toMatchObject({ slug: "a", source: "x" });
    expect(await verifyClickToken("other", t, 1010)).toBeNull();
    expect(await verifyClickToken("secret", t, 1000 + 8 * 86400)).toBeNull();
    expect(await verifyClickToken("secret", t.replace(/^./, "A"), 1010)).toBeNull();
  });

  it("converts through EUR at the day's rate", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO fx_rates (date, currency, rate) VALUES ('2026-10-23', 'USD', 1.1), ('2026-10-23', 'JPY', 160)"),
    ]);
    // A Sunday uses Friday's rates.
    expect(await convert(env.DB, 1100, "USD", "EUR", "2026-10-25")).toBe(1000);
    expect(await convert(env.DB, 1000, "EUR", "JPY", "2026-10-23")).toBe(1600);
    expect(await convert(env.DB, 1000, "EUR", "GBP", "2026-10-23")).toBeNull();
    expect(await convert(env.DB, 1000, "CZK", "CZK", "2000-01-01")).toBe(1000);
  });
});

describe("sites API", () => {
  it("creates, lists, updates and deletes a site", async () => {
    const site = await createSite({ domains: ["https://www.Shop.Example.com/pricing"] });
    expect(site.id).toMatch(/^st_/);
    expect(site.domains).toEqual(["shop.example.com"]);
    expect(site.idMode).toBe("cookieless");
    expect(site.tracking).toBe(true);

    const list = await (await call(`${API}/sites`, { headers: json({}).headers })).json<{ sites: SiteDTO[] }>();
    expect(list.sites.map((s) => s.id)).toEqual([site.id]);

    const patched = await call(`${API}/sites/${site.id}`, { ...json({ idMode: "persistent", timezone: "Europe/Prague" }), method: "PATCH" });
    expect(await patched.json()).toMatchObject({ idMode: "persistent", timezone: "Europe/Prague" });

    const paused = await call(`${API}/sites/${site.id}`, { ...json({ tracking: false }), method: "PATCH" });
    expect(await paused.json()).toMatchObject({ tracking: false, idMode: "persistent" });
    expect((await call(`${API}/sites/${site.id}`, { ...json({ timezone: "Mars/Olympus" }), method: "PATCH" })).status).toBe(400);
    expect((await call(`${API}/sites/${site.id}`, { method: "DELETE", headers: json({}).headers })).status).toBe(200);
    expect((await call(`${API}/sites/${site.id}`, { headers: json({}).headers })).status).toBe(404);
  });

  it("serves the tracker script cross-origin", async () => {
    const res = await call(`${ORIGIN}/_t/script.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toContain("shorthop");
    const again = await call(`${ORIGIN}/_t/script.js`, { headers: { "If-None-Match": res.headers.get("ETag")! } });
    expect(again.status).toBe(304);
  });
});

describe("collector", () => {
  it("records a visit and returns its reference", async () => {
    const site = await createSite();
    const s1 = await pageview(site, `${SITE_ORIGIN}/?utm_source=newsletter&utm_medium=email&utm_campaign=oct`, { r: "https://mail.google.com/" });
    const s2 = await pageview(site, `${SITE_ORIGIN}/pricing/`);
    expect(s2).toBe(s1);
    const row = await env.DB.prepare("SELECT * FROM web_sessions WHERE id = ?").bind(s1).first<Record<string, unknown>>();
    expect(row).toMatchObject({ pageviews: 2, entry_path: "/", exit_path: "/pricing", channel: "Email", utm_campaign: "oct", browser: "Safari", device: "desktop" });

    await collect(site, { t: "engage", d: 12_000 });
    await collect(site, { t: "goal", n: "signup" });
    const after = await env.DB.prepare("SELECT engaged_ms, goals FROM web_sessions WHERE id = ?").bind(s1).first();
    expect(after).toEqual({ engaged_ms: 12_000, goals: 1 });
  });

  it("starts a new visit for a new campaign", async () => {
    const site = await createSite();
    const a = await pageview(site, `${SITE_ORIGIN}/?utm_source=x&utm_campaign=one`);
    const b = await pageview(site, `${SITE_ORIGIN}/?utm_source=x&utm_campaign=two`);
    expect(b).not.toBe(a);
  });

  it("refuses other origins, unknown sites, bots and junk", async () => {
    const site = await createSite();
    expect((await collect(site, {}, { Origin: "https://evil.example.org" })).status).toBe(403);
    expect((await collect(site, { u: "https://evil.example.org/" })).status).toBe(403);
    expect((await collect({ ...site, id: "st_doesnotexist" }, {})).status).toBe(404);
    expect((await collect(site, {}, { "User-Agent": "curl/8.0" })).status).toBe(202);
    expect((await collect(site, { t: "nope" })).status).toBe(400);
    const big = await call(`${ORIGIN}/_t/e`, { method: "POST", headers: { Origin: SITE_ORIGIN }, body: "x".repeat(9000) });
    expect(big.status).toBe(413);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("drops a paused site's visits, and records them again once resumed", async () => {
    const site = await createSite();
    await call(`${API}/sites/${site.id}`, { ...json({ tracking: false }), method: "PATCH" });
    expect((await collect(site, {})).status).toBe(202);
    expect((await collect(site, { t: "goal", n: "signup" })).status).toBe(202);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions").first("n")).toBe(0);

    await call(`${API}/sites/${site.id}`, { ...json({ tracking: true }), method: "PATCH" });
    await pageview(site);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions").first("n")).toBe(1);
  });

  it("skips excluded paths", async () => {
    const site = await createSite({ excludePaths: ["/admin/**"] });
    expect((await collect(site, { u: `${SITE_ORIGIN}/admin/users/1` })).status).toBe(202);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM web_sessions").first("n")).toBe(0);
  });

  it("uses the first-party id only on persistent sites, and not with GPC", async () => {
    const persistent = await createSite({ idMode: "persistent" });
    await pageview(persistent, undefined, { v: "visitor_abcdefghijklmnop" });
    expect(await env.DB.prepare("SELECT visitor_id FROM web_sessions").first("visitor_id")).toBe("visitor_abcdefghijklmnop");

    await resetData();
    const gpc = await createSite({ idMode: "persistent" });
    const res = await collect(gpc, { v: "visitor_abcdefghijklmnop" }, { "Sec-GPC": "1" });
    expect(await res.json()).toMatchObject({ m: "c" });
    expect(await env.DB.prepare("SELECT visitor_id FROM web_sessions").first("visitor_id")).not.toBe("visitor_abcdefghijklmnop");

    await resetData();
    const cookieless = await createSite();
    await pageview(cookieless, undefined, { v: "visitor_abcdefghijklmnop" });
    expect(await env.DB.prepare("SELECT visitor_id FROM web_sessions").first("visitor_id")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("lets the browser fill identity once, and the API overwrite it", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    await collect(site, { t: "identify", e: { email: "Anna@Example.com" } });
    await collect(site, { t: "identify", e: { email: "mallory@example.com" } });
    expect(await env.DB.prepare("SELECT email FROM web_visitors").first("email")).toBe("anna@example.com");
    const res = await call(`${API}/sites/${site.id}/identify`, json({ ref, email: "anna.new@example.com" }));
    expect(res.status).toBe(200);
    expect(await env.DB.prepare("SELECT email, trust FROM web_visitors").first()).toEqual({ email: "anna.new@example.com", trust: "server" });
  });
});

describe("short link → site", () => {
  it("tags clicks to a tracked site and credits the visit to the link", async () => {
    const site = await createSite();
    await putLink("launch", { u: `${SITE_ORIGIN}/pricing` });
    await putLink("other", { u: "https://elsewhere.example.org/" });

    const res = await call(`${ORIGIN}/launch?s=li`, { headers: { "User-Agent": UA }, redirect: "manual" });
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(`${SITE_ORIGIN}/pricing`);
    const token = location.searchParams.get("sh_c");
    expect(token).toBeTruthy();

    const untagged = await call(`${ORIGIN}/other`, { headers: { "User-Agent": UA }, redirect: "manual" });
    expect(untagged.headers.get("Location")).not.toContain("sh_c");

    const ref = await pageview(site, `${SITE_ORIGIN}/pricing`, { c: token });
    const row = await env.DB.prepare("SELECT channel, source, link_domain, link_slug FROM web_sessions WHERE id = ?").bind(ref).first();
    expect(row).toEqual({ channel: "Short link", source: "LinkedIn", link_domain: "sh.example", link_slug: "launch" });

    // A forged token is ignored.
    await resetData();
    const site2 = await createSite();
    const forged = await pageview(site2, `${SITE_ORIGIN}/`, { c: `${token!.split(".")[0]}.AAAAAAAAAAA` });
    expect(await env.DB.prepare("SELECT channel FROM web_sessions WHERE id = ?").bind(forged).first("channel")).toBe("Direct");
  });

  it("doesn't tag clicks while the site's tracking is paused", async () => {
    await createSite({ tracking: false });
    await putLink("launch", { u: `${SITE_ORIGIN}/` });
    const res = await call(`${ORIGIN}/launch`, { headers: { "User-Agent": UA }, redirect: "manual" });
    expect(res.headers.get("Location")).toBe(`${SITE_ORIGIN}/`);
  });

  it("doesn't tag when the site turned link tagging off", async () => {
    await createSite({ tagLinks: false });
    await putLink("launch", { u: `${SITE_ORIGIN}/` });
    const res = await call(`${ORIGIN}/launch`, { headers: { "User-Agent": UA }, redirect: "manual" });
    expect(res.headers.get("Location")).toBe(`${SITE_ORIGIN}/`);
  });
});

describe("payment webhooks", () => {
  it("refuses bad signatures and unknown addresses", async () => {
    const site = await createSite();
    const conn = await addConnection(site, "stripe", "whsec_test");
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
    expect((await hook(conn, body, await stripeHeaders("whsec_wrong", body))).status).toBe(401);
    expect((await hook(conn, body, await stripeHeaders("whsec_test", body, now() - 3600))).status).toBe(401);
    expect((await call(`${ORIGIN}/_pay/stripe/pc_doesnotexist`, { method: "POST", body })).status).toBe(404);
    expect((await call(`${ORIGIN}/_pay/paddle/${conn.id}`, { method: "POST", body })).status).toBe(404);
    const conns = await (await call(`${API}/sites/${site.id}/connections`, { headers: json({}).headers })).json<{ connections: ConnectionDTO[] }>();
    expect(conns.connections[0]!.lastError).toMatch(/too old|match/);
  });

  it("Stripe: matches by sh_ref, counts refunds as running totals, ignores retries", async () => {
    const site = await createSite();
    const ref = await pageview(site, `${SITE_ORIGIN}/?utm_source=google&utm_medium=cpc`);
    const conn = await addConnection(site, "stripe", "whsec_test");

    const paid = JSON.stringify({
      id: "evt_paid",
      type: "checkout.session.completed",
      livemode: true,
      created: now(),
      data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 4900, currency: "usd", client_reference_id: `sh_${ref}`, customer_details: { email: "Buyer@Example.com" } } },
    });
    expect((await hook(conn, paid, await stripeHeaders("whsec_test", paid))).status).toBe(200);
    const retry = await hook(conn, paid, await stripeHeaders("whsec_test", paid));
    expect(await retry.json()).toMatchObject({ duplicate: true });

    // The last one is an older total arriving late: it can't shrink the refund.
    for (const [id, refunded] of [["evt_r1", 1000], ["evt_r2", 1500], ["evt_r0", 500]] as const) {
      const body = JSON.stringify({ id, type: "charge.refunded", livemode: true, created: now(), data: { object: { id: "ch_1", payment_intent: "pi_1", amount_refunded: refunded, currency: "usd" } } });
      expect((await hook(conn, body, await stripeHeaders("whsec_test", body))).status).toBe(200);
    }

    const list = await sitePayments(site);
    const charge = list.find((p) => p.kind === "charge")!;
    expect(charge).toMatchObject({ amountMinor: 4900, amountSiteMinor: 4900, matchedBy: "ref", confidence: "high", email: "buyer@example.com" });
    expect(charge.credited).toMatchObject({ id: ref, channel: "Paid", source: "Google" });
    const refund = list.find((p) => p.kind === "refund")!;
    expect(refund).toMatchObject({ amountMinor: -1500, matchedBy: "ref" });

    const o = await overview(site);
    expect(o.totals).toMatchObject({ visitors: 1, revenue: 3400, grossRevenue: 4900, refunds: 1500, payments: 1, customers: 1, conversion: 1 });

    const rows = (await (await call(`${API}/sites/${site.id}/breakdown?range=7d&dim=channel`, { headers: json({}).headers })).json<{ rows: SiteBreakdownRow[] }>()).rows;
    expect(rows).toEqual([{ value: "Paid", visitors: 1, sessions: 1, pageviews: 1, revenue: 3400, customers: 1 }]);
  });

  it("Stripe subscriptions: the checkout's reference carries over to invoices", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    const conn = await addConnection(site, "stripe", "whsec_test");
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      expect((await hook(conn, text, await stripeHeaders("whsec_test", text))).status).toBe(200);
    };
    // The invoice can arrive before the checkout event.
    await send({ id: "evt_inv1", type: "invoice.paid", livemode: true, created: now(), data: { object: { id: "in_1", amount_paid: 1500, currency: "eur", customer: "cus_1", subscription: "sub_1", billing_reason: "subscription_create" } } });
    expect((await sitePayments(site))[0]!.matchedBy).toBeNull();
    await send({ id: "evt_cs", type: "checkout.session.completed", livemode: true, created: now(), data: { object: { id: "cs_9", mode: "subscription", subscription: "sub_1", customer: "cus_1", client_reference_id: `sh_${ref}` } } });
    await send({ id: "evt_inv2", type: "invoice.paid", livemode: true, created: now() + 10, data: { object: { id: "in_2", amount_paid: 1500, currency: "eur", customer: "cus_1", subscription: "sub_1", billing_reason: "subscription_cycle" } } });
    await send({ id: "evt_sub", type: "customer.subscription.updated", livemode: true, created: now(), data: { object: { id: "sub_1", status: "active", customer: "cus_1", items: { data: [{ quantity: 1, price: { unit_amount: 1500, currency: "eur", recurring: { interval: "month", interval_count: 1 } } }] } } } });

    const list = await sitePayments(site);
    expect(list.map((p) => [p.billing, p.matchedBy, p.session?.id])).toEqual([
      ["sub_renewal", "customer", ref],
      ["sub_new", "claim", ref],
    ]);
    await call(`${API}/sites/${site.id}`, { ...json({ currency: "EUR" }), method: "PATCH" });
    const subs = await (await call(`${API}/sites/${site.id}/subscriptions?range=7d`, { headers: json({}).headers })).json();
    expect(subs).toMatchObject({ active: 1, renewalRevenue: 1500, newRevenue: 1500 });
  });

  it("Paddle: verifies ts:body, counts approved refunds only", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    const conn = await addConnection(site, "paddle", "pdl_ntfset_secret");
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      const ts = now();
      return hook(conn, text, { "Paddle-Signature": `ts=${ts};h1=${bytesToHex(await sign("pdl_ntfset_secret", `${ts}:${text}`))}` });
    };
    expect(
      (await send({ event_id: "evt_1", event_type: "transaction.completed", occurred_at: new Date().toISOString(), data: { id: "txn_1", origin: "web", currency_code: "USD", custom_data: { sh_ref: ref }, details: { totals: { grand_total: "2900" } }, items: [] } })).status,
    ).toBe(200);
    await send({ event_id: "evt_2", event_type: "adjustment.created", data: { id: "adj_1", action: "refund", status: "pending_approval", transaction_id: "txn_1", currency_code: "USD", totals: { total: "900" } } });
    await send({ event_id: "evt_3", event_type: "adjustment.updated", data: { id: "adj_1", action: "refund", status: "approved", transaction_id: "txn_1", currency_code: "USD", totals: { total: "900" } } });
    const list = await sitePayments(site);
    expect(list.map((p) => [p.kind, p.amountMinor, p.matchedBy])).toEqual([
      ["refund", -900, "ref"],
      ["charge", 2900, "ref"],
    ]);
  });

  it("Lemon Squeezy: custom data from the checkout URL, renewals follow the subscription", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    const conn = await addConnection(site, "lemonsqueezy", "my-ls-secret");
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      return hook(conn, text, { "X-Signature": bytesToHex(await sign("my-ls-secret", text)) });
    };
    expect((await send({ meta: { event_name: "order_created", custom_data: { sh_ref: ref } }, data: { id: "77", attributes: { status: "paid", total: 1200, currency: "USD", user_email: "a@b.co", customer_id: 5, first_order_item: { product_id: 9 } } } })).status).toBe(200);
    await send({ meta: { event_name: "subscription_created", custom_data: { sh_ref: ref } }, data: { id: "300", attributes: { status: "active", customer_id: 5, order_id: 77 } } });
    await send({ meta: { event_name: "subscription_payment_success" }, data: { id: "501", attributes: { billing_reason: "renewal", total: 1200, currency: "USD", customer_id: 5, subscription_id: 300 } } });
    expect((await hook(conn, "{}", { "X-Signature": "00" })).status).toBe(401);
    const list = await sitePayments(site);
    expect(list.map((p) => [p.billing, p.matchedBy])).toEqual([
      ["sub_renewal", "customer"],
      ["sub_new", "ref"],
    ]);
  });

  it("Dodo: Standard Webhooks signature and metadata", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    const key = crypto.getRandomValues(new Uint8Array(24));
    const secret = `whsec_${bytesToBase64(key)}`;
    const conn = await addConnection(site, "dodo", secret);
    const body = JSON.stringify({ type: "payment.succeeded", timestamp: new Date().toISOString(), data: { payment_id: "pay_1", total_amount: 5000, currency: "USD", customer: { customer_id: "cus_1", email: "x@y.co" }, metadata: { sh_ref: ref }, product_cart: [{ product_id: "pdt_1" }] } });
    const ts = String(now());
    const sig = bytesToBase64(await sign(key, `msg_1.${ts}.${body}`));
    const res = await hook(conn, body, { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,AAAA v1,${sig}` });
    expect(res.status).toBe(200);
    expect((await sitePayments(site))[0]).toMatchObject({ amountMinor: 5000, matchedBy: "ref" });
  });

  it("Dodo: a product filter keeps other products' payments out", async () => {
    const site = await createSite();
    const key = crypto.getRandomValues(new Uint8Array(24));
    const conn = await addConnection(site, "dodo", `whsec_${bytesToBase64(key)}`, { productFilter: ["pdt_mine"] });
    const body = JSON.stringify({ type: "payment.succeeded", data: { payment_id: "pay_2", total_amount: 5000, currency: "USD", customer: {}, product_cart: [{ product_id: "pdt_other" }] } });
    const ts = String(now());
    await hook(conn, body, { "webhook-id": "msg_2", "webhook-timestamp": ts, "webhook-signature": `v1,${bytesToBase64(await sign(key, `msg_2.${ts}.${body}`))}` });
    expect(await sitePayments(site)).toEqual([]);
  });

  it("Creem: checkout and the first subscription.paid are one payment", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    const conn = await addConnection(site, "creem", "creem_secret");
    const send = async (body: object) => {
      const text = JSON.stringify(body);
      return hook(conn, text, { "creem-signature": bytesToHex(await sign("creem_secret", text)) });
    };
    expect(
      (await send({ id: "evt_1", eventType: "checkout.completed", object: { id: "ch_1", metadata: { sh_ref: ref }, customer: { id: "cust_1", email: "c@d.co" }, subscription: { id: "sub_1" }, order: { id: "ord_1", transaction: "tran_1", amount: 1900, currency: "EUR" } } })).status,
    ).toBe(200);
    await send({ id: "evt_2", eventType: "subscription.paid", object: { id: "sub_1", last_transaction_id: "tran_1", customer: { id: "cust_1" }, product: { price: 1900, currency: "EUR" } } });
    await send({ id: "evt_3", eventType: "subscription.paid", object: { id: "sub_1", last_transaction_id: "tran_2", customer: { id: "cust_1" }, product: { price: 1900, currency: "EUR" } } });
    const list = await sitePayments(site);
    expect(list.filter((p) => p.kind === "charge").map((p) => [p.billing, p.matchedBy])).toEqual([
      ["sub_renewal", "customer"],
      ["sub_new", "ref"],
    ]);
  });
});

describe("matching without a reference", () => {
  it("matches a return page's ids, whichever comes first", async () => {
    const site = await createSite();
    const conn = await addConnection(site, "stripe", "whsec_test");
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", livemode: true, created: now(), data: { object: { id: "cs_live_123", mode: "payment", payment_status: "paid", payment_intent: "pi_9", amount_total: 1000, currency: "usd" } } });
    await hook(conn, body, await stripeHeaders("whsec_test", body));
    expect((await sitePayments(site))[0]!.unmatchedReason).toBeTruthy();
    const ref = await pageview(site, `${SITE_ORIGIN}/thanks?session_id=cs_live_123`, { k: ["cs_live_123"] });
    expect((await sitePayments(site))[0]).toMatchObject({ matchedBy: "claim", session: { id: ref } });
  });

  it("matches by a server-identified email, and by checkout timing", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    await call(`${API}/sites/${site.id}/identify`, json({ ref, email: "pat@example.com" }));
    const api = (body: object) => call(`${API}/sites/${site.id}/payments`, json(body));
    const byEmail = await (await api({ id: "inv-1", amount: 10, currency: "USD", email: "pat@example.com" })).json<{ payment: { matched_by: string } }>();
    expect(byEmail.payment.matched_by).toBe("email");

    const other = await pageview(site, `${SITE_ORIGIN}/`, {}, { "CF-Connecting-IP": "198.51.100.9" });
    await collect(site, { t: "checkout", n: "https://buy.stripe.com/abc" }, { "CF-Connecting-IP": "198.51.100.9" });
    const byTiming = await (await api({ id: "inv-2", amount: 5, currency: "USD" })).json<{ payment: { matched_by: string; session_id: string } }>();
    expect(byTiming.payment).toMatchObject({ matched_by: "timing", session_id: other });
  });

  it("reports revenue per short link", async () => {
    const site = await createSite();
    await putLink("launch", { u: `${SITE_ORIGIN}/` });
    const res = await call(`${ORIGIN}/launch`, { headers: { "User-Agent": UA }, redirect: "manual" });
    const token = new URL(res.headers.get("Location")!).searchParams.get("sh_c");
    const ref = await pageview(site, `${SITE_ORIGIN}/`, { c: token });
    await call(`${API}/sites/${site.id}/payments`, json({ id: "o-1", amount: 99, currency: "USD", ref }));
    const rev = await (await call(`${API}/sites/by-link/sh.example/launch`, { headers: json({}).headers })).json<LinkRevenueDTO>();
    expect(rev).toMatchObject({ revenue: 9900, payments: 1, sessions: 1 });
  });
});

describe("revenue permission", () => {
  it("shows traffic without money to people who can't see revenue", async () => {
    const site = await createSite();
    const ref = await pageview(site);
    await call(`${API}/sites/${site.id}/payments`, json({ id: "o-1", amount: 99, currency: "USD", ref }));
    await addUser("viewer@example.com", "user", ["stats.view"]);
    const o = await (await adminCall("viewer@example.com", `/sites/${site.id}/overview?range=7d`)).json<SiteOverviewDTO>();
    expect(o.totals).toMatchObject({ visitors: 1, revenue: 0, customers: 0 });
    const rows = (await (await adminCall("viewer@example.com", `/sites/${site.id}/breakdown?range=7d&dim=channel`)).json<{ rows: SiteBreakdownRow[] }>()).rows;
    expect(rows.every((r) => r.revenue === 0)).toBe(true);
    expect((await adminCall("viewer@example.com", `/sites/${site.id}/payments?range=7d`)).status).toBe(403);
  });
});

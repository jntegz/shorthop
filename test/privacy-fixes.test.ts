// Package C of the 2.0.3 security fixes: who a privacy request reaches, what an
// erasure leaves behind, what privacy signals do, how long visits stay, what an
// export holds, what free-form fields keep, and what leaves through webhooks.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashRoute, scrubText, shortText } from "../src/shared/scrub";
import type { PrivacyCountsDTO, PrivacyEraseDTO, PrivacyReapplyDTO, SiteDTO } from "../src/shared/sites";
import { logHit } from "../src/worker/analytics";
import { FREE } from "../src/worker/plan";
import { claimRefs } from "../src/worker/revenue/match";
import { budgetKey, collectBudgetPruneStmt, FLUSH_ROWS, resetCollectBudget } from "../src/worker/web/budget";
import { resetErasureCache, visitorRefused, withdrawVisitor, WITHDRAWN_KEEP_SEC } from "../src/worker/web/erasure";
import { pruneCustomerData } from "../src/worker/web/privacy";
import { resetSiteCaches } from "../src/worker/web/sites";
import { resetClickHooks } from "../src/worker/webhooks";
import { API, call, captureClicks, json, ORIGIN, putLink, resetData } from "./helpers";

const SITE_ORIGIN = "https://shop.example.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const BUYER = "buyer-visitor-00001";
const PLANTER = "planter-visitor-001";
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const GPC = { "Sec-GPC": "1" };

let hooked: { url: string; body: string }[] = [];
let mails: { text: string; html: string; subject: string }[] = [];

beforeEach(async () => {
  await resetData();
  await env.DB.exec("DELETE FROM link_clicks");
  await env.DB.exec("DELETE FROM erasure_ledger");
  resetClickHooks();
  hooked = [];
  mails = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("frankfurter")) return new Response("offline", { status: 503 });
    if (url.startsWith("https://hooks.example.com/")) {
      hooked.push({ url, body: String(init?.body) });
      return new Response("ok");
    }
    if (url.startsWith("https://api.resend.com/")) {
      mails.push(JSON.parse(String(init?.body)) as { text: string; html: string; subject: string });
      return Response.json({ id: "msg" });
    }
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

async function createSite(body: Record<string, unknown> = {}): Promise<SiteDTO> {
  const res = await call(`${API}/sites`, json({ name: "Shop", domains: ["shop.example.com"], idMode: "persistent", ...body }));
  expect(res.status).toBe(201);
  return res.json<SiteDTO>();
}

const collect = (site: SiteDTO, body: Record<string, unknown>, headers: Record<string, string> = {}, over: Partial<Env> = {}) =>
  call(
    `${ORIGIN}/_t/e`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: SITE_ORIGIN, "User-Agent": UA, "CF-Connecting-IP": "203.0.113.7", ...headers },
      body: JSON.stringify({ s: site.id, t: "pageview", u: `${SITE_ORIGIN}/`, r: "", w: 1440, ...body }),
    },
    over,
  );

/** A pageview by a browser id; returns the visit id. */
async function visit(site: SiteDTO, visitorId: string, url = `${SITE_ORIGIN}/`): Promise<string> {
  const res = await collect(site, { v: visitorId, u: url });
  expect(res.status).toBe(200);
  return (await res.json<{ s: string }>()).s;
}

async function pay(site: SiteDTO, body: Record<string, unknown>): Promise<void> {
  expect((await call(`${API}/sites/${site.id}/payments`, json({ amount: 50, currency: "USD", ...body }))).status).toBe(201);
}

const identify = (site: SiteDTO, body: Record<string, unknown>) => call(`${API}/sites/${site.id}/identify`, json(body));
const privacy = (site: SiteDTO, what: string, body: Record<string, unknown>) => call(`${API}/sites/${site.id}/privacy/${what}`, json(body));
const lookup = async (site: SiteDTO, body: Record<string, unknown>) => (await privacy(site, "lookup", body)).json<PrivacyCountsDTO>();
const row = <T>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<T>();
const rows = async <T>(sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<T>()).results;

/** Revenue per source, the way reports add it up. */
const bySource = (site: SiteDTO) =>
  rows<{ source: string; total: number }>("SELECT s.source, SUM(p.amount_minor) AS total FROM payments p JOIN web_sessions s ON s.id = p.credited_session_id WHERE p.site_id = ?1 GROUP BY s.source ORDER BY s.source", site.id);

/** Someone puts their own visit's reference on a checkout link; the victim buys through it. */
async function plantedSale(site: SiteDTO): Promise<string> {
  const planted = await visit(site, PLANTER);
  await pay(site, { id: "sale", ref: planted, email: "victim@example.com", customerId: "cus_V" });
  return planted;
}

describe("a checkout reference doesn't say who paid", () => {
  it("credits the visit but copies no email and proves nothing", async () => {
    const site = await createSite();
    const planted = await plantedSale(site);
    expect(await row("SELECT session_id, matched_by, confidence, proves_identity FROM payments WHERE id = 'api:charge:sale'")).toEqual({ session_id: planted, matched_by: "ref", confidence: "high", proves_identity: 0 });
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", PLANTER)).toBeNull();
  });

  it("treats a signed webhook's claim the same way: it only repeats the reference", async () => {
    const site = await createSite();
    const planted = await visit(site, PLANTER);
    await claimRefs(env, site, planted, ["sub_1"], now(), "provider");
    await pay(site, { id: "inv", subscriptionId: "sub_1", email: "victim@example.com" });
    expect(await row("SELECT matched_by, confidence, proves_identity FROM payments WHERE id = 'api:charge:inv'")).toEqual({ matched_by: "claim", confidence: "high", proves_identity: 0 });
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", PLANTER)).toBeNull();
  });

  it("carries no proof through a later payment of the same customer", async () => {
    const site = await createSite();
    await plantedSale(site);
    await pay(site, { id: "sale2", customerId: "cus_V", email: "victim@example.com" });
    expect(await row("SELECT matched_by, proves_identity FROM payments WHERE id = 'api:charge:sale2'")).toEqual({ matched_by: "customer", proves_identity: 0 });
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", PLANTER)).toBeNull();
  });

  it("counts what the site's server says: its identify, and a visitor it names for the payment", async () => {
    const site = await createSite();
    await visit(site, BUYER);
    await identify(site, { visitorId: BUYER, email: "buyer@example.com" });
    await pay(site, { id: "by-email", email: "buyer@example.com" });
    expect(await row("SELECT matched_by, confidence, proves_identity FROM payments WHERE id = 'api:charge:by-email'")).toEqual({ matched_by: "email", confidence: "medium", proves_identity: 1 });

    const other = "named-visitor-0001";
    await visit(site, other);
    await pay(site, { id: "named", visitorId: other, email: "named@example.com" });
    expect(await row("SELECT proves_identity FROM payments WHERE id = 'api:charge:named'")).toEqual({ proves_identity: 1 });
    expect(await row("SELECT email FROM web_visitors WHERE id = ?1", other)).toEqual({ email: "named@example.com" });
  });

  it("shows whether a match proves who paid, in the payments list and webhooks", async () => {
    const site = await createSite();
    expect((await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/p", events: ["site.payment"] }))).status).toBe(201);
    await plantedSale(site);
    const list = await (await call(`${API}/sites/${site.id}/payments?range=7d`, { headers: json({}).headers })).json<{ payments: { provesIdentity: boolean }[] }>();
    expect(list.payments[0]!.provesIdentity).toBe(false);
    const delivery = await row<{ payload: string }>("SELECT payload FROM webhook_deliveries WHERE event_type = 'site.payment'");
    expect((JSON.parse(delivery!.payload) as { data: { match: unknown } }).data.match).toEqual({ by: "ref", confidence: "high", proves_identity: false });
  });
});

describe("who a privacy request reaches", () => {
  it("doesn't reach the victim's payment from the visitor that planted the reference", async () => {
    const site = await createSite();
    await plantedSale(site);
    expect(await lookup(site, { visitorId: PLANTER })).toMatchObject({ identities: 0, visits: 1, payments: 0, otherPayments: 1 });
    const exported = await (await privacy(site, "export", { visitorId: PLANTER })).json<{ payments: unknown[] }>();
    expect(exported.payments).toEqual([]);
    const res = await (await privacy(site, "erase", { visitorId: PLANTER, confirm: true })).json<PrivacyEraseDTO>();
    expect(res.warnings.join(" ")).toContain("without proof of who paid");
    expect(await row("SELECT email, customer_id, personal_cleared_at FROM payments WHERE id = 'api:charge:sale'")).toEqual({ email: "victim@example.com", customer_id: "cus_V", personal_cleared_at: null });
  });

  it("shows a visitor linked by a reference apart, and includes it only when asked", async () => {
    const site = await createSite();
    await plantedSale(site);
    const plain = await lookup(site, { email: "victim@example.com" });
    expect(plain).toMatchObject({ identities: 0, visits: 0, payments: 1, unproven: [{ kind: "payment_reference", identities: 0, visits: 1, included: false }] });
    const exported = await (await privacy(site, "export", { email: "victim@example.com" })).json<{ visits: unknown[]; payments: Record<string, unknown>[] }>();
    expect(exported.visits).toEqual([]);
    // The payment's own record doesn't point at a visitor that isn't shown as theirs.
    expect(exported.payments[0]).toMatchObject({ email: "victim@example.com", visitor_id: null, session_id: null, credited_session_id: null, ref: null });

    expect(await lookup(site, { email: "victim@example.com", include: ["payment_reference"] })).toMatchObject({ visits: 1, payments: 1, unproven: [{ included: true }] });
    const included = await (await privacy(site, "export", { email: "victim@example.com", include: ["payment_reference"] })).json<{ visits: { visitor_id: string }[] }>();
    expect(included.visits.map((v) => v.visitor_id)).toEqual([PLANTER]);
  });

  it("keeps a browser-claimed email's visitor out unless included, and never follows it further", async () => {
    const site = await createSite();
    const victimVisit = await visit(site, BUYER);
    await identify(site, { visitorId: BUYER, email: "victim@example.com" });
    await pay(site, { id: "v1", ref: victimVisit, email: "victim@example.com", customerId: "cus_V" });
    const claimer = "claimer-visitor-001";
    const claimerVisit = await visit(site, claimer);
    await collect(site, { t: "identify", v: claimer, e: { email: "victim@example.com" } });
    await pay(site, { id: "c1", ref: claimerVisit, email: "claimer@example.com" });

    expect(await lookup(site, { email: "victim@example.com" })).toMatchObject({ identities: 1, visits: 1, payments: 1, unproven: [{ kind: "claimed_email", identities: 1, visits: 1, included: false }] });
    await privacy(site, "erase", { email: "victim@example.com", confirm: true });
    expect(await row("SELECT email FROM web_visitors WHERE id = ?1", claimer)).toEqual({ email: "victim@example.com" });
    expect(await row("SELECT 1 FROM web_sessions WHERE id = ?1", claimerVisit)).not.toBeNull();

    // Included: its identity and visits go, its own payment stays with its own customer.
    await privacy(site, "erase", { email: "victim@example.com", include: ["claimed_email"], confirm: true });
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", claimer)).toBeNull();
    expect(await row("SELECT email FROM payments WHERE id = 'api:charge:c1'")).toEqual({ email: "claimer@example.com" });
  });

  it("refuses a kind of link it doesn't know", async () => {
    const site = await createSite();
    expect((await privacy(site, "lookup", { email: "a@example.com", include: ["everything"] })).status).toBe(400);
  });
});

describe("an erasure that lasts", () => {
  async function customer(site: SiteDTO) {
    const first = await visit(site, BUYER);
    const second = await visit(site, BUYER, `${SITE_ORIGIN}/pricing?utm_source=newsletter&utm_medium=email`);
    await identify(site, { visitorId: BUYER, email: "buyer@example.com" });
    await pay(site, { id: "p1", ref: first, email: "buyer@example.com", customerId: "cus_B" });
    return { first, second };
  }

  it("leaves nothing kept that joins to what Analytics Engine still holds", async () => {
    const site = await createSite();
    const { first, second } = await customer(site);
    const before = await bySource(site);
    expect(before.length).toBeGreaterThan(0);
    expect((await privacy(site, "erase", { email: "buyer@example.com", confirm: true })).status).toBe(200);

    expect(await row("SELECT 1 FROM web_sessions WHERE id IN (?1, ?2)", first, second)).toBeNull();
    const p = await row<{ session_id: string; credited_session_id: string; visitor_id: string | null; ref: string | null }>("SELECT session_id, credited_session_id, visitor_id, ref FROM payments WHERE id = 'api:charge:p1'");
    expect(p).toMatchObject({ visitor_id: null, ref: null });
    for (const id of [p!.session_id, p!.credited_session_id]) expect([first, second]).not.toContain(id);
    expect(await row<{ visitor_id: string }>("SELECT visitor_id FROM web_sessions WHERE id = ?1", p!.credited_session_id)).toMatchObject({ visitor_id: expect.stringMatching(/^erased_/) });
    expect(await bySource(site)).toEqual(before);
  });

  it("removes the visit's short-link click and return-page references", async () => {
    const site = await createSite();
    const { first } = await customer(site);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO link_clicks (ref, domain, slug, provider, clicked_at) VALUES (?1, 'sh.example', 'go', 'stripe', ?2)").bind(first, now()),
      env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at, source) VALUES (?1, 'cs_x', ?2, ?3, 'browser')").bind(site.id, first, now()),
    ]);
    await privacy(site, "erase", { email: "buyer@example.com", confirm: true });
    expect(await row("SELECT 1 FROM link_clicks WHERE ref = ?1", first)).toBeNull();
    expect(await row("SELECT 1 FROM payment_claims WHERE ref = 'cs_x'")).toBeNull();
  });

  it("refuses the browser id afterwards: visits go under the daily hash, and the browser is told to drop it", async () => {
    const site = await createSite();
    await customer(site);
    await privacy(site, "erase", { email: "buyer@example.com", confirm: true });

    const res = await collect(site, { v: BUYER });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ m: "c" });
    expect(await row("SELECT 1 FROM web_sessions WHERE visitor_id = ?1", BUYER)).toBeNull();
    // Neither its browser nor a server can name it again.
    await collect(site, { t: "identify", v: BUYER, e: { email: "buyer@example.com" } });
    expect(await (await identify(site, { visitorId: BUYER, email: "buyer@example.com" })).json()).toEqual({ ok: true, ignored: "erased" });
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", BUYER)).toBeNull();
    // A new id is an ordinary new visitor.
    expect(await (await collect(site, { v: "a-brand-new-browser" })).json()).toMatchObject({ m: "p" });
  });

  it("keeps keyed hashes only, with an expiry, in D1 and in the KV copy", async () => {
    const site = await createSite();
    await customer(site);
    await privacy(site, "erase", { email: "buyer@example.com", confirm: true });
    const ledger = await rows<{ kind: string; hash: string; expires_at: number }>("SELECT kind, hash, expires_at FROM erasure_ledger WHERE site_id = ?1", site.id);
    expect(new Set(ledger.map((r) => r.kind))).toEqual(new Set(["visitor", "payment", "email", "customer", "reference"]));
    expect(ledger.every((r) => r.expires_at > now() + 300 * DAY)).toBe(true);
    const copy = (await env.LINKS.list({ prefix: `cfg:erasure:${site.id}:` })).keys;
    expect(copy).toHaveLength(1);
    const text = JSON.stringify(ledger) + (await env.LINKS.get(copy[0]!.name));
    for (const plain of [BUYER, "buyer@example.com", "cus_B", "api:charge:p1"]) expect(text).not.toContain(plain);
  });

  describe("a customer who bought through a checkout reference", () => {
    /** The ordinary flow: the reference credits the visit, proves nothing, and the visitor stays outside the erasure. */
    async function referenceSale(site: SiteDTO) {
      const s = await visit(site, BUYER, `${SITE_ORIGIN}/pricing?utm_source=newsletter&utm_campaign=spring`);
      await pay(site, { id: "r1", ref: s, email: "buyer@example.com", customerId: "cus_R" });
      return s;
    }
    const payment = (id = "r1") =>
      row<{ session_id: string; credited_session_id: string; visitor_id: string | null; ref: string | null; email: string | null; order_ref: string | null }>(
        "SELECT session_id, credited_session_id, visitor_id, ref, email, order_ref FROM payments WHERE id = ?1",
        `api:charge:${id}`,
      );

    it("leaves the payment no way back to the visit or the browser id, and revenue by source as it was", async () => {
      const site = await createSite();
      const s = await referenceSale(site);
      const before = await bySource(site);
      const res = await (await privacy(site, "erase", { email: "buyer@example.com", confirm: true })).json<PrivacyEraseDTO>();

      const p = (await payment())!;
      expect(p).toMatchObject({ visitor_id: null, ref: null, email: null });
      expect(p.session_id).toBe(p.credited_session_id);
      expect(p.credited_session_id).not.toBe(s);
      const copy = await row<Record<string, unknown>>("SELECT * FROM web_sessions WHERE id = ?1", p.credited_session_id);
      expect(copy).toMatchObject({ visitor_id: expect.stringMatching(/^erased_/), utm_campaign: "spring", via: "erased", pageviews: 0, city: "", checkout_at: null });
      expect(Number(copy!.started_at) % DAY).toBe(0);
      expect(JSON.stringify(copy)).not.toContain(BUYER);
      expect(await bySource(site)).toEqual(before);
      expect(res.counts.anonymizedVisits).toBe(1);
      expect(res.warnings.join(" ")).toContain("no longer point at them");
      expect(res.warnings.join(" ")).not.toContain("Nothing kept here");
      // The visit itself may be someone else's: it isn't touched, or counted twice.
      expect(await row("SELECT visitor_id FROM web_sessions WHERE id = ?1", s)).toEqual({ visitor_id: BUYER });
      expect(await row<{ n: number }>("SELECT COUNT(*) AS n FROM web_sessions WHERE site_id = ?1 AND via = ''", site.id)).toEqual({ n: 1 });
    });

    it("moves only the erased person's payment off a visit others are credited to", async () => {
      const site = await createSite();
      const s = await referenceSale(site);
      await pay(site, { id: "r2", ref: s, email: "someone@example.com" });
      await privacy(site, "erase", { email: "buyer@example.com", confirm: true });
      expect((await payment())!.credited_session_id).not.toBe(s);
      expect(await payment("r2")).toMatchObject({ session_id: s, credited_session_id: s, visitor_id: BUYER, email: "someone@example.com" });
    });

    it("gives the same result when erased twice, without another copy", async () => {
      const site = await createSite();
      await referenceSale(site);
      await privacy(site, "erase", { email: "buyer@example.com", confirm: true });
      const first = await payment();
      const n = await row("SELECT COUNT(*) AS n FROM web_sessions");
      await privacy(site, "erase", { paymentId: "api:charge:r1", confirm: true });
      expect(await payment()).toEqual(first);
      expect(await row("SELECT COUNT(*) AS n FROM web_sessions")).toEqual(n);
    });

    it("removes a short-link checkout click and the visit made from it", async () => {
      const site = await createSite();
      const ref = "AbCdEfGhIjKlMnOp";
      await env.DB.prepare("INSERT INTO link_clicks (ref, domain, slug, provider, source, city, device, clicked_at) VALUES (?1, 'sh.example', 'go', 'api', 'mail', 'Berlin', 'mobile', ?2)").bind(ref, now()).run();
      await pay(site, { id: "lc", ref, email: "buyer@example.com" });
      expect(await row("SELECT visitor_id FROM web_sessions WHERE id = ?1", ref)).toEqual({ visitor_id: `lc_${ref}` });
      const before = await bySource(site);
      await privacy(site, "erase", { email: "buyer@example.com", confirm: true });

      expect(await row("SELECT 1 FROM link_clicks WHERE ref = ?1", ref)).toBeNull();
      expect(await row("SELECT 1 FROM web_sessions WHERE id = ?1 OR visitor_id = ?2", ref, `lc_${ref}`)).toBeNull();
      const p = (await payment("lc"))!;
      expect(p.session_id).not.toBe(ref);
      expect(await row("SELECT link_slug, city, device FROM web_sessions WHERE id = ?1", p.credited_session_id)).toEqual({ link_slug: "go", city: "", device: "mobile" });
      expect(await bySource(site)).toEqual(before);
    });

    it("drops claims of the payment's provider ids, and doesn't take new ones", async () => {
      const site = await createSite();
      const s = await referenceSale(site);
      await env.DB.prepare("UPDATE payments SET order_ref = 'cs_order_1' WHERE id = 'api:charge:r1'").run();
      await claimRefs(env, site, s, ["cs_order_1"], now(), "provider");
      await privacy(site, "erase", { email: "buyer@example.com", confirm: true });
      expect(await row("SELECT 1 FROM payment_claims WHERE ref = 'cs_order_1'")).toBeNull();
      expect(await row("SELECT 1 FROM erasure_ledger WHERE kind = 'reference'")).not.toBeNull();

      // The buyer reloads the return page, or the provider repeats its event.
      await collect(site, { v: "a-brand-new-browser", u: `${SITE_ORIGIN}/thanks`, k: ["cs_order_1", "cs_someone_else"] });
      await vi.waitFor(async () => expect(await row("SELECT 1 FROM payment_claims WHERE ref = 'cs_someone_else'")).not.toBeNull());
      await claimRefs(env, site, s, ["cs_order_1"], now(), "provider");
      expect(await row("SELECT 1 FROM payment_claims WHERE ref = 'cs_order_1'")).toBeNull();
    });
  });

  describe("what the collector's check costs", () => {
    /** The database, adding up the rows each statement reads. */
    function counting() {
      const seen = { reads: 0, statements: [] as string[] };
      const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
        ({
          bind: (...v: unknown[]) => wrap(stmt.bind(...v), sql),
          first: async () => {
            const r = await stmt.all();
            seen.reads += r.meta.rows_read ?? 0;
            seen.statements.push(sql);
            return r.results[0] ?? null;
          },
          all: async () => {
            const r = await stmt.all();
            seen.reads += r.meta.rows_read ?? 0;
            seen.statements.push(sql);
            return r;
          },
          run: async () => {
            const r = await stmt.run();
            seen.reads += r.meta.rows_read ?? 0;
            seen.statements.push(sql);
            return r;
          },
        }) as unknown as D1PreparedStatement;
      const DB = { prepare: (sql: string) => wrap(env.DB.prepare(sql), sql) } as unknown as D1Database;
      return { seen, testEnv: { ...env, DB } as Env };
    }

    async function fill(site: SiteDTO, n: number) {
      const stmt = env.DB.prepare("INSERT INTO erasure_ledger (site_id, kind, hash, key_id, created_at, expires_at) SELECT ?1, 'withdrawn', 'filler' || value, 'k', 1, ?2 FROM json_each(?3)");
      const ids = Array.from({ length: n }, (_, i) => i);
      for (let i = 0; i < n; i += 1000) await stmt.bind(site.id, now() + DAY, JSON.stringify(ids.slice(i, i + 1000))).run();
    }

    it("reads a few rows however long the ledger is", async () => {
      const site = await createSite();
      await fill(site, 3000);
      resetErasureCache();
      const { seen, testEnv } = counting();
      expect(await visitorRefused(testEnv, site.id, "not-on-the-ledger-01", now())).toBe(false);
      expect(seen.reads).toBeLessThan(10);
    });

    it("finds an id at any position, and remembers answers for a minute", async () => {
      const site = await createSite();
      await visit(site, BUYER);
      await fill(site, 50);
      await withdrawVisitor(env, site.id, BUYER, now());
      resetErasureCache();
      const { seen, testEnv } = counting();
      expect(await visitorRefused(testEnv, site.id, BUYER, now())).toBe(true);
      const after = seen.statements.length;
      expect(await visitorRefused(testEnv, site.id, BUYER, now())).toBe(true);
      expect(seen.statements).toHaveLength(after);
    });

    it("asks nothing per visitor on a site with an empty ledger", async () => {
      const site = await createSite();
      resetErasureCache();
      const { seen, testEnv } = counting();
      for (const id of ["visitor-number-0001", "visitor-number-0002", "visitor-number-0003"]) await visitorRefused(testEnv, site.id, id, now());
      expect(seen.statements).toHaveLength(1);
    });

    it("doesn't read the ledger again after a withdrawal", async () => {
      const site = await createSite({ idMode: "consent" });
      await fill(site, 2000);
      await collect(site, { v: BUYER, cs: 1 });
      resetErasureCache();
      const { seen, testEnv } = counting();
      await withdrawVisitor(testEnv, site.id, BUYER, now());
      seen.reads = 0;
      expect(await visitorRefused(testEnv, site.id, BUYER, now())).toBe(true);
      expect(await visitorRefused(testEnv, site.id, "another-visitor-001", now())).toBe(false);
      expect(seen.reads).toBeLessThan(10);
    });
  });

  it("drops expired entries in the daily job, and a deleted site's", async () => {
    const site = await createSite();
    await customer(site);
    await privacy(site, "erase", { email: "buyer@example.com", confirm: true });
    await env.DB.prepare("UPDATE erasure_ledger SET expires_at = 1 WHERE kind = 'payment'").run();
    await pruneCustomerData(env.DB);
    expect(await row("SELECT 1 FROM erasure_ledger WHERE kind = 'payment'")).toBeNull();
    expect(await row("SELECT 1 FROM erasure_ledger WHERE kind = 'visitor'")).not.toBeNull();
    await call(`${API}/sites/${site.id}`, { method: "DELETE", headers: json({}).headers });
    expect(await row("SELECT 1 FROM erasure_ledger WHERE site_id = ?1", site.id)).toBeNull();
  });
});

describe("re-applying erasures after a restore", () => {
  async function runAll(site: SiteDTO) {
    let cursor: string | null = null;
    const total = { identities: 0, visits: 0, payments: 0, subscriptions: 0 };
    let unreadable = 0;
    for (let i = 0; i < 40; i++) {
      const res = await privacy(site, "reapply", { cursor });
      expect(res.status).toBe(200);
      const step = await res.json<PrivacyReapplyDTO>();
      for (const k of ["identities", "visits", "payments", "subscriptions"] as const) total[k] += step.erased[k];
      unreadable = step.unreadable;
      if (step.done) return { total, unreadable };
      cursor = step.cursor;
    }
    throw new Error("re-apply didn't finish");
  }

  /** What a restored backup from before the erasure brings back. */
  async function restoreOld(site: SiteDTO) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO web_visitors (site_id, id, first_seen, email, trust) VALUES (?1, ?2, 1, 'buyer@example.com', 'server')").bind(site.id, BUYER),
      env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) VALUES ('restoredvisit0001', ?1, ?2, 1, 1)").bind(site.id, BUYER),
      env.DB.prepare("DELETE FROM payments WHERE id = 'api:charge:p1'"),
      env.DB.prepare(
        `INSERT INTO payments (id, site_id, provider, kind, occurred_at, amount_minor, currency, email, customer_id, visitor_id, session_id, credited_session_id, matched_by, confidence, proves_identity, created_at)
         VALUES ('api:charge:p1', ?1, 'api', 'charge', 1, 5000, 'USD', 'buyer@example.com', 'cus_B', ?2, 'restoredvisit0001', 'restoredvisit0001', 'email', 'medium', 1, 1)`,
      ).bind(site.id, BUYER),
    ]);
  }

  async function erased(site: SiteDTO) {
    await visit(site, BUYER);
    await identify(site, { visitorId: BUYER, email: "buyer@example.com" });
    await pay(site, { id: "p1", email: "buyer@example.com", customerId: "cus_B" });
    await privacy(site, "erase", { email: "buyer@example.com", confirm: true });
  }

  it("erases what the restore brought back, keeping the money and leaving others alone", async () => {
    const site = await createSite();
    await erased(site);
    await visit(site, "someone-else-00001");
    await pay(site, { id: "other", email: "other@example.com" });
    await restoreOld(site);
    const { total } = await runAll(site);
    expect(total).toMatchObject({ identities: 1 });
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", BUYER)).toBeNull();
    expect(await row("SELECT 1 FROM web_sessions WHERE visitor_id = ?1", BUYER)).toBeNull();
    expect(await row("SELECT email, customer_id, personal_cleared_at FROM payments WHERE id = 'api:charge:p1'")).toMatchObject({ email: null, customer_id: null, personal_cleared_at: expect.any(Number) });
    expect(await row("SELECT amount_minor FROM payments WHERE id = 'api:charge:p1'")).toEqual({ amount_minor: 5000 });
    expect(await row("SELECT email FROM payments WHERE id = 'api:charge:other'")).toEqual({ email: "other@example.com" });
  });

  it("leaves someone who came back afterwards and gave their details again", async () => {
    const site = await createSite();
    await erased(site);
    await pay(site, { id: "later", email: "buyer@example.com", customerId: "cus_B" });
    // Stored after the erasure (the ledger and its KV copy both say when that was).
    await env.DB.prepare("UPDATE payments SET created_at = created_at + 100 WHERE id = 'api:charge:later'").run();
    await restoreOld(site);
    await runAll(site);
    expect(await row("SELECT email, customer_id, personal_cleared_at FROM payments WHERE id = 'api:charge:later'")).toEqual({ email: "buyer@example.com", customer_id: "cus_B", personal_cleared_at: null });
    expect(await row("SELECT email FROM payments WHERE id = 'api:charge:p1'")).toEqual({ email: null });
  });

  it("still knows the erasure when the restore took the ledger back too: the KV copy brings it", async () => {
    const site = await createSite();
    await erased(site);
    await restoreOld(site);
    await env.DB.exec("DELETE FROM erasure_ledger");
    resetSiteCaches();
    await runAll(site);
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", BUYER)).toBeNull();
    expect(await row("SELECT 1 FROM erasure_ledger WHERE kind = 'visitor'")).not.toBeNull();
  });

  it("says when entries were made with a secret this install no longer has", async () => {
    const site = await createSite();
    await erased(site);
    await env.DB.prepare("UPDATE erasure_ledger SET key_id = 'gone'").run();
    expect((await runAll(site)).unreadable).toBeGreaterThan(0);
  });

  it("needs the same permissions as an erasure, and doesn't re-record anything", async () => {
    const site = await createSite();
    await erased(site);
    const before = await row<{ n: number }>("SELECT COUNT(*) AS n FROM erasure_ledger");
    await restoreOld(site);
    await runAll(site);
    expect(await row<{ n: number }>("SELECT COUNT(*) AS n FROM erasure_ledger")).toEqual(before);
    expect((await env.LINKS.list({ prefix: "cfg:erasure:" })).keys).toHaveLength(1);
  });
});

describe("privacy signals", () => {
  for (const headers of [GPC, { DNT: "1" }]) {
    const name = Object.keys(headers)[0]!;
    it(`with ${name}, ignores identify, stores no references and hands none out`, async () => {
      const site = await createSite();
      const res = await collect(site, { v: BUYER, k: ["cs_test_12345"] }, headers);
      expect(res.status).toBe(200);
      const reply = await res.json<{ s?: string; m: string }>();
      expect(reply.s).toBeUndefined();
      expect(reply.m).toBe("c");
      expect(await row("SELECT 1 FROM payment_claims WHERE site_id = ?1", site.id)).toBeNull();

      await collect(site, { t: "identify", v: BUYER, e: { email: "a@example.com", name: "A" } }, headers);
      expect(await row("SELECT 1 FROM web_visitors WHERE site_id = ?1", site.id)).toBeNull();

      await collect(site, { t: "checkout", v: BUYER, n: "https://buy.stripe.com/x" }, headers);
      expect(await row<{ checkout_at: number | null }>("SELECT checkout_at FROM web_sessions WHERE site_id = ?1", site.id)).toEqual({ checkout_at: null });
    });
  }

  it("applies even where the site doesn't use the signal for its visitor ids", async () => {
    const site = await createSite({ respectGpc: false });
    const res = await collect(site, { v: BUYER }, GPC);
    expect(await res.json()).toMatchObject({ m: "p" });
    expect(await row("SELECT 1 FROM web_sessions WHERE visitor_id = ?1", BUYER)).not.toBeNull();
    await collect(site, { t: "identify", v: BUYER, e: { email: "a@example.com" } }, GPC);
    expect(await row("SELECT 1 FROM web_visitors WHERE id = ?1", BUYER)).toBeNull();
  });

  it("leaves other browsers as they were", async () => {
    const site = await createSite();
    expect(await (await collect(site, { v: BUYER })).json()).toMatchObject({ s: expect.any(String), m: "p" });
    await collect(site, { t: "identify", v: BUYER, e: { email: "a@example.com" } });
    expect(await row("SELECT email, trust FROM web_visitors WHERE id = ?1", BUYER)).toEqual({ email: "a@example.com", trust: "client" });
  });

  it("gives a checkout link clicked with the signal no reference, and records no click", async () => {
    const site = await createSite();
    expect((await call(`${API}/sites/${site.id}/connections`, json({ provider: "stripe", webhookSecret: "whsec_x" }))).status).toBe(201);
    resetSiteCaches();
    await putLink("buy", { u: "https://buy.stripe.com/test_abc" });
    const res = await call(`${ORIGIN}/buy`, { headers: { "User-Agent": UA, ...GPC }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://buy.stripe.com/test_abc");
    expect(await row("SELECT 1 FROM link_clicks")).toBeNull();
    const plain = await call(`${ORIGIN}/buy`, { headers: { "User-Agent": UA }, redirect: "manual" });
    expect(plain.headers.get("Location")).toContain("client_reference_id=");
    expect(await row("SELECT 1 FROM link_clicks")).not.toBeNull();
  });

  describe("taking back consent", () => {
    const consent = () => createSite({ idMode: "consent" });

    it("stops the id being used, and the browser is told so", async () => {
      const site = await consent();
      await collect(site, { v: BUYER, cs: 1 });
      expect(await (await collect(site, { t: "withdraw", v: BUYER })).json()).toEqual({ m: "c" });
      expect(await row("SELECT kind FROM erasure_ledger WHERE site_id = ?1", site.id)).toEqual({ kind: "withdrawn" });
      expect(await (await collect(site, { v: BUYER, cs: 1 })).json()).toMatchObject({ m: "c" });
    });

    it("erases nothing, and a restore's re-apply leaves that visitor alone", async () => {
      const site = await consent();
      const s = await visit(site, BUYER);
      await collect(site, { v: BUYER, cs: 1 });
      await collect(site, { t: "withdraw", v: BUYER });
      expect(await row("SELECT 1 FROM web_sessions WHERE id = ?1", s)).not.toBeNull();
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const step: PrivacyReapplyDTO = await (await privacy(site, "reapply", { cursor })).json();
        if (step.done) break;
        cursor = step.cursor;
      }
      expect(await row("SELECT 1 FROM web_sessions WHERE id = ?1", s)).not.toBeNull();
    });

    it("ignores ids it has never seen, so the table can't be filled from outside", async () => {
      const site = await consent();
      expect((await collect(site, { t: "withdraw", v: "never-seen-before-1" })).status).toBe(200);
      expect(await row("SELECT 1 FROM erasure_ledger")).toBeNull();
    });

    it("does nothing on a cookieless site", async () => {
      const site = await createSite({ idMode: "cookieless" });
      await collect(site, { t: "withdraw", v: BUYER });
      expect(await row("SELECT 1 FROM erasure_ledger")).toBeNull();
    });

    const today = () => new Date().toISOString().slice(0, 10);
    const ledgerRows = async () => (await row<{ n: number }>("SELECT COUNT(*) AS n FROM erasure_ledger"))!.n;
    const spendBudget = () => env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)").bind(budgetKey(today()), String(FREE.collectRows)).run();
    const ON_FREE = { WORKERS_PLAN: "free" } as Partial<Env>;

    it("writes once per id, however often it is sent, and keeps the entry shorter than an erasure's", async () => {
      const site = await consent();
      await collect(site, { v: BUYER, cs: 1 });
      await collect(site, { t: "withdraw", v: BUYER });
      const first = await row<{ created_at: number; expires_at: number }>("SELECT created_at, expires_at FROM erasure_ledger");
      expect(first!.expires_at - first!.created_at).toBe(WITHDRAWN_KEEP_SEC);
      const counter = `${budgetKey(today())}:withdrawn:${site.id}`;
      for (let i = 0; i < 5; i++) {
        resetErasureCache();
        await collect(site, { t: "withdraw", v: BUYER });
      }
      expect(await ledgerRows()).toBe(1);
      expect(await row("SELECT value FROM settings WHERE key = ?1", counter)).toEqual({ value: "1" });
    });

    it("once the budget is spent writes nothing, answers the same, and still works the next day", async () => {
      const site = await consent();
      await collect(site, { v: BUYER, cs: 1 });
      await spendBudget();
      resetCollectBudget();
      const res = await collect(site, { t: "withdraw", v: BUYER }, {}, ON_FREE);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ m: "c" });
      expect(await ledgerRows()).toBe(0);
      expect(await row("SELECT 1 FROM settings WHERE key LIKE '%:withdrawn:%'")).toBeNull();

      await env.DB.prepare("DELETE FROM settings WHERE key = ?1").bind(budgetKey(today())).run();
      resetCollectBudget();
      await collect(site, { t: "withdraw", v: BUYER }, {}, ON_FREE);
      expect(await ledgerRows()).toBe(1);
      resetCollectBudget();
    });

    it("stops at the site's limit for the day, without touching another site's", async () => {
      const site = await consent();
      const other = await createSite({ name: "Other", domains: ["other.example.com"], idMode: "consent" });
      const ids = ["limit-visitor-00001", "limit-visitor-00002"];
      for (const v of ids) await collect(site, { v, cs: 1 });
      await collect(other, { v: ids[0], cs: 1, u: "https://other.example.com/" }, { Origin: "https://other.example.com" });
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)").bind(`${budgetKey(today())}:withdrawn:${site.id}`, String(FREE.withdrawalsPerDay - 1)).run();
      resetCollectBudget();
      await collect(site, { t: "withdraw", v: ids[0] }, {}, ON_FREE);
      await collect(site, { t: "withdraw", v: ids[1] }, {}, ON_FREE);
      expect(await ledgerRows()).toBe(1);
      await collect(other, { t: "withdraw", v: ids[0], u: "https://other.example.com/" }, { Origin: "https://other.example.com" }, ON_FREE);
      expect(await ledgerRows()).toBe(2);
      resetCollectBudget();
    });

    it("charges what it writes to the collector's budget", async () => {
      const site = await consent();
      const ids = Array.from({ length: FLUSH_ROWS }, (_, i) => `budget-visitor-${String(i).padStart(4, "0")}`);
      await env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) SELECT 'bv-' || value, ?1, value, 1, 1 FROM json_each(?2)").bind(site.id, JSON.stringify(ids)).run();
      resetCollectBudget();
      for (const v of ids) await collect(site, { t: "withdraw", v }, {}, ON_FREE);
      expect(await ledgerRows()).toBe(ids.length);
      expect(Number((await row<{ value: string }>("SELECT value FROM settings WHERE key = ?1", budgetKey(today())))?.value)).toBeGreaterThanOrEqual(FLUSH_ROWS);
      resetCollectBudget();
    });

    it("lets the daily cleanup remove its count", async () => {
      const site = await consent();
      await collect(site, { v: BUYER, cs: 1 });
      await collect(site, { t: "withdraw", v: BUYER });
      const yesterday = new Date(Date.now() - DAY * 1000).toISOString().slice(0, 10);
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, '5')").bind(`${budgetKey(yesterday)}:withdrawn:${site.id}`).run();
      await collectBudgetPruneStmt(env.DB, today()).run();
      expect(await row("SELECT 1 FROM settings WHERE key = ?1", `${budgetKey(yesterday)}:withdrawn:${site.id}`)).toBeNull();
      expect(await row("SELECT 1 FROM settings WHERE key = ?1", `${budgetKey(today())}:withdrawn:${site.id}`)).not.toBeNull();
    });
  });

  describe("the server API with a browser that has no reference", () => {
    it("stores a payment sent with ref and visitorId null, unmatched to any visit by reference", async () => {
      const site = await createSite();
      expect((await call(`${API}/sites/${site.id}/payments`, json({ id: "gpc", amount: 5, currency: "USD", ref: null, visitorId: null, email: "a@example.com" }))).status).toBe(201);
      expect(await row("SELECT ref, session_id FROM payments WHERE id = 'api:charge:gpc'")).toEqual({ ref: null, session_id: null });
    });

    it("still refuses a malformed reference, and an identify naming nobody", async () => {
      const site = await createSite();
      expect((await call(`${API}/sites/${site.id}/payments`, json({ id: "bad", amount: 5, currency: "USD", ref: "no spaces allowed" }))).status).toBe(400);
      expect((await identify(site, { ref: null, visitorId: null, email: "a@example.com" })).status).toBe(400);
    });

    it("identifies through the other field when one is null", async () => {
      const site = await createSite();
      await visit(site, BUYER);
      expect((await identify(site, { ref: null, visitorId: BUYER, email: "a@example.com" })).status).toBe(200);
    });
  });
});

describe("visit retention", () => {
  const YEAR_AGO = () => now() - 400 * DAY;
  const age = (id: string) => env.DB.prepare("UPDATE web_sessions SET started_at = ?2, last_seen_at = ?2 WHERE id = ?1").bind(id, YEAR_AGO()).run();
  const keep12 = (site: SiteDTO) => call(`${API}/sites/${site.id}`, { ...json({ customerRetentionMonths: 12 }), method: "PATCH" });

  it("deletes old visits, keeps credited ones as nobody's, and revenue by source stays right", async () => {
    const site = await createSite();
    await keep12(site);
    const credited = await visit(site, BUYER, `${SITE_ORIGIN}/?utm_source=newsletter`);
    await pay(site, { id: "old", ref: credited, email: "old@example.com", occurredAt: YEAR_AGO() + 60 });
    const plain = await visit(site, "other-visitor-0001", `${SITE_ORIGIN}/about?utm_source=ads`);
    const recent = await visit(site, "recent-visitor-001");
    await env.DB.prepare("UPDATE web_sessions SET city = 'Prague' WHERE id = ?1").bind(credited).run();
    await age(credited);
    await age(plain);
    await env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at) VALUES (?1, 'cs_old', ?2, 1)").bind(site.id, plain).run();
    const before = await bySource(site);

    await pruneCustomerData(env.DB);
    expect(await row("SELECT 1 FROM web_sessions WHERE id = ?1", plain)).toBeNull();
    expect(await row("SELECT 1 FROM payment_claims WHERE ref = 'cs_old'")).toBeNull();
    expect(await row("SELECT visitor_id, city FROM web_sessions WHERE id = ?1", credited)).toEqual({ visitor_id: expect.stringMatching(/^erased_/), city: "" });
    expect(await row("SELECT 1 FROM web_sessions WHERE id = ?1", recent)).not.toBeNull();
    expect(await bySource(site)).toEqual(before);
  });

  it("keeps of a credited visit only what revenue by source needs, and only its day", async () => {
    const site = await createSite();
    await keep12(site);
    const credited = await visit(site, BUYER, `${SITE_ORIGIN}/secret-page?utm_source=newsletter&utm_medium=mail&utm_campaign=spring`);
    await pay(site, { id: "old", ref: credited, email: "old@example.com", occurredAt: YEAR_AGO() + 60 });
    await env.DB.prepare("UPDATE web_sessions SET exit_path = '/thanks', referrer_host = 'news.example', link_domain = 'sh.example', link_slug = 'promo', country = 'CZ', continent = 'EU', device = 'desktop', os = 'Linux', browser = 'Firefox', pageviews = 4, goals = 1, engaged_ms = 9000 WHERE id = ?1").bind(credited).run();
    await age(credited);
    const before = await bySource(site);

    await pruneCustomerData(env.DB);
    const kept = await row<Record<string, unknown> & { started_at: number; last_seen_at: number; visitor_id: string }>("SELECT * FROM web_sessions WHERE id = ?1", credited);
    expect(kept).toMatchObject({
      entry_path: "", exit_path: "", hostname: "", country: "", continent: "", region: "", city: "", device: "", os: "", browser: "", language: "", screen: "", org: "", timezone: "",
      pageviews: 0, goals: 0, engaged_ms: 0, return_visit: 0, checkout_at: null, via: "erased",
      source: "Newsletter", utm_source: "newsletter", utm_medium: "mail", utm_campaign: "spring", referrer_host: "news.example", link_domain: "sh.example", link_slug: "promo",
    });
    expect(kept!.started_at % DAY).toBe(0);
    expect(kept!.last_seen_at).toBe(kept!.started_at);
    expect(await bySource(site)).toEqual(before);

    // Done once: a later run leaves it as it is.
    await pruneCustomerData(env.DB);
    expect(await row("SELECT visitor_id FROM web_sessions WHERE id = ?1", credited)).toEqual({ visitor_id: kept!.visitor_id });
  });

  it("reaches a kept visit of someone erased once it is past the period", async () => {
    const site = await createSite();
    await keep12(site);
    const credited = await visit(site, BUYER, `${SITE_ORIGIN}/secret-page?utm_source=newsletter`);
    await pay(site, { id: "old", ref: credited, occurredAt: YEAR_AGO() + 60 });
    await age(credited);
    await env.DB.prepare("UPDATE web_sessions SET visitor_id = 'erased_abc' WHERE id = ?1").bind(credited).run();
    await pruneCustomerData(env.DB);
    expect(await row("SELECT entry_path, via, source FROM web_sessions WHERE id = ?1", credited)).toEqual({ entry_path: "", via: "erased", source: "Newsletter" });
  });

  it("repoints a payment whose matched visit goes, and leaves it credited", async () => {
    const site = await createSite();
    await keep12(site);
    const matched = await visit(site, BUYER);
    const credit = await visit(site, BUYER, `${SITE_ORIGIN}/?utm_source=x`);
    await pay(site, { id: "m", ref: matched });
    await env.DB.prepare("UPDATE payments SET session_id = ?1, credited_session_id = ?2 WHERE id = 'api:charge:m'").bind(matched, credit).run();
    await age(matched);
    await pruneCustomerData(env.DB);
    expect(await row("SELECT session_id, credited_session_id FROM payments WHERE id = 'api:charge:m'")).toEqual({ session_id: credit, credited_session_id: credit });
  });

  it("works through a long history in bounded batches", async () => {
    const site = await createSite();
    await keep12(site);
    const old = YEAR_AGO();
    await env.DB.batch(Array.from({ length: 12 }, (_, i) => env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(`old-visit-${i}`, site.id, `old-visitor-${i}`, old)));
    const left = async () => (await row<{ n: number }>("SELECT COUNT(*) AS n FROM web_sessions WHERE site_id = ?1", site.id))!.n;
    // A site's smallest batch covers this history in one run.
    await pruneCustomerData(env.DB, now(), 5);
    expect(await left()).toBe(0);
  });

  it("keeps to the limit across many sites and takes turns", async () => {
    const sites: SiteDTO[] = [];
    for (let i = 0; i < 3; i++) sites.push(await createSite({ name: `S${i}`, domains: [`s${i}.example.com`], customerRetentionMonths: 12 }));
    const old = YEAR_AGO();
    await env.DB.batch(sites.flatMap((s, i) => Array.from({ length: 60 }, (_, j) => env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(`v-${i}-${j}`, s.id, `old-${i}-${j}`, old))));
    const total = async () => (await row<{ n: number }>("SELECT COUNT(*) AS n FROM web_sessions"))!.n;
    await pruneCustomerData(env.DB, now(), 60);
    expect(await total()).toBe(180 - 50);
    await pruneCustomerData(env.DB, now() + DAY, 60);
    await pruneCustomerData(env.DB, now() + 2 * DAY, 60);
    expect(await total()).toBe(180 - 150);
  });

  it("never touches a site without a period, the default after an upgrade", async () => {
    const site = await createSite();
    const s = await visit(site, BUYER);
    await age(s);
    await pruneCustomerData(env.DB);
    expect(await row("SELECT visitor_id FROM web_sessions WHERE id = ?1", s)).toEqual({ visitor_id: BUYER });
  });
});

describe("what an export holds", () => {
  it("adds the person's checkout references, clicks and payment webhooks, and says what's left out", async () => {
    const site = await createSite();
    expect((await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/p", events: ["site.payment"] }))).status).toBe(201);
    const s = await visit(site, BUYER);
    await identify(site, { visitorId: BUYER, email: "buyer@example.com" });
    await pay(site, { id: "p1", email: "buyer@example.com" });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO payment_claims (site_id, ref, session_id, claimed_at, source) VALUES (?1, 'cs_browser', ?2, 5, 'browser'), (?1, 'cs_provider', ?2, 6, 'provider')").bind(site.id, s),
      env.DB.prepare("INSERT INTO link_clicks (ref, domain, slug, provider, clicked_at) VALUES (?1, 'sh.example', 'go', 'stripe', 7), ('someone-elses', 'sh.example', 'go', 'stripe', 8)").bind(s),
    ]);
    const data = await (await privacy(site, "export", { email: "buyer@example.com" })).json<{
      checkoutReferences: { ref: string | null; source: string }[];
      checkoutClicks: { ref: string }[];
      webhookDeliveries: { payload: string }[];
      coverage: { notIncluded: { what: string }[] };
    }>();
    expect(data.checkoutReferences.map((c) => c.ref).sort()).toEqual(["cs_browser", null].sort());
    expect(data.checkoutClicks.map((c) => c.ref)).toEqual([s]);
    expect(data.webhookDeliveries).toHaveLength(1);
    expect(data.coverage.notIncluded.map((n) => n.what).join(" ")).toContain("Single page views");
  });

  it("brings in nothing of someone else's through a planted reference", async () => {
    const site = await createSite();
    expect((await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/p", events: ["site.payment"] }))).status).toBe(201);
    const planted = await plantedSale(site);
    await claimRefs(env, site, planted, ["cs_victim_order"], now(), "provider");
    const text = await (await privacy(site, "export", { visitorId: PLANTER })).text();
    expect(text).not.toContain("victim@example.com");
    expect(text).not.toContain("cs_victim_order");
    expect(JSON.parse(text)).toMatchObject({ payments: [], webhookDeliveries: [] });
  });

  it("goes past 5,000 visits, and warns that cookieless ids can be shared", async () => {
    const site = await createSite();
    const hash = "0123456789abcdef";
    const stmt = env.DB.prepare("INSERT INTO web_sessions (id, site_id, visitor_id, started_at, last_seen_at) SELECT 'bulk-' || value, ?1, ?2, value, value FROM json_each(?3)");
    const ids = Array.from({ length: 5100 }, (_, i) => i + 1);
    for (let i = 0; i < ids.length; i += 1000) await stmt.bind(site.id, hash, JSON.stringify(ids.slice(i, i + 1000))).run();
    const data = await (await privacy(site, "export", { visitorId: hash })).json<{ visits: unknown[]; notes: string[] }>();
    expect(data.visits).toHaveLength(5100);
    expect(data.notes.join(" ")).toContain("share");
  });
});

describe("free-form fields", () => {
  it("screens emails and tokens by shape, and leaves ordinary values alone", () => {
    expect(scrubText("/users/jane.doe@example.com/settings")).toBe("/users/[email]/settings");
    expect(scrubText("jane%40example.com")).toBe("[email]");
    expect(scrubText("/r/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBe("/r/[redacted]");
    expect(scrubText("/k/0123456789abcdef0123456789abcdef")).toBe("/k/[redacted]");
    expect(scrubText("/k/aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF")).toBe("/k/[redacted]");
    expect(scrubText("#/cb?access_token=abc123")).toBe("#/cb?access_token=[redacted]");
    for (const fine of ["/pricing", "/blog/how-to-set-up-your-first-long-article-title-here", "/orders/12345", "spring_sale_2026", "/p/550e8400-e29b-41d4-a716-446655440000"]) expect(scrubText(fine)).toBe(fine);
  });

  it("leaves long slugs, campaigns and goal names as they are", () => {
    for (const fine of [
      "Black-Friday-2026-Email-Campaign-Final",
      "2024_United_States_presidential_election",
      "/wiki/2024_United_States_presidential_election",
      "/blog/How-To-Deploy-Cloudflare-Workers-In-10-Steps",
      "BlackFriday2026EmailCampaignFinalVersion",
      "ThisIsAVeryLongCamelCaseGoalNameForSignup2026",
      "Spring_Sale_2026_EU_DE_Retargeting_V2_Final",
      "Q1-Q2-Q3-Q4-2026-Report-EU-UK-US-DE-FR-IT",
      // No words in it at all: only its short pieces say it isn't a key.
      "Q1-Q2-Q3-Q4-H1-H2-FY25-FY26-Eu-Uk-Us-De",
      "/products/iPhone15ProMaxCaseReviewAndBuyingGuide2026",
      "SKU-AB12CD-2026-Blue-XL-Medium-Cotton-Shirt",
      "/img/logo@2x.png",
      "/@jane/posts",
    ])
      expect(scrubText(fine)).toBe(fine);
  });

  it("keeps different campaigns and pages apart", () => {
    const a = scrubText("Black-Friday-2026-Email-Campaign-Final");
    const b = scrubText("Cyber-Monday-2026-Email-Campaign-Final");
    expect(a).not.toBe(b);
  });

  it("still screens real-looking keys, with or without separators", () => {
    for (const key of [
      "sk_" + "live_51H8xKqLm2NpQ7rStUvWxYz0123AbCdEf", // Made up, and split so secret scanners don't flag it.
      "cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
      "Zx8Kq2Lm9Np4Rt7Vw1Yb5Cd3Fg6Hj0Ks",
      "pT3-xV9qL2mZ8kR5wN1yB7cD4fG6hJ0sA_e2U",
      "VGhpcyBpcyBhIHRlc3Qgc3RyaW5nIGZvciBiYXNlNjQ",
    ]) {
      expect(scrubText(`/reset/${key}`)).toBe("/reset/[redacted]");
      expect(scrubText(key)).toBe("[redacted]");
    }
    expect(scrubText("/reset?token=short1")).toBe("/reset?token=[redacted]");
    expect(scrubText("mail jane.doe+shop@example.co.uk now")).toBe("mail [email] now");
  });

  it("applies a site's excluded paths to the real address, and to what reports show", async () => {
    const token = "Zx8Kq2Lm9Np4Rt7Vw1Yb5Cd3Fg6Hj0Ks"; // gitleaks:allow
    for (const rule of [`/reset/${token}`, "/reset/*", "/reset/[redacted]"]) {
      await env.DB.exec("DELETE FROM web_sessions");
      const site = await createSite({ name: rule, domains: ["shop.example.com"], excludePaths: [rule] });
      expect((await collect(site, { v: BUYER, u: `${SITE_ORIGIN}/reset/${token}` })).status).toBe(202);
      expect(await row("SELECT 1 FROM web_sessions WHERE site_id = ?1", site.id)).toBeNull();
      await call(`${API}/sites/${site.id}`, { method: "DELETE", headers: json({}).headers });
      resetSiteCaches();
    }
  });

  it("stores a long campaign and page as sent, so they stay separate rows", async () => {
    const site = await createSite();
    await collect(site, { v: BUYER, u: `${SITE_ORIGIN}/wiki/2024_United_States_presidential_election?utm_source=news&utm_campaign=Black-Friday-2026-Email-Campaign-Final` });
    expect(await row("SELECT entry_path, utm_campaign FROM web_sessions WHERE visitor_id = ?1", BUYER)).toEqual({
      entry_path: "/wiki/2024_United_States_presidential_election",
      utm_campaign: "Black-Friday-2026-Email-Campaign-Final",
    });
  });

  it("keeps only routes from a fragment", () => {
    expect(hashRoute("#/orders/42?token=x")).toBe("#/orders/42");
    expect(hashRoute("#!/a")).toBe("#!/a");
    expect(hashRoute("#access_token=abc")).toBe("");
    expect(hashRoute("#pricing")).toBe("");
  });

  it("stores none of it from a page view, a goal or a campaign tag", async () => {
    const site = await createSite();
    const { points, CLICKS: WEB } = captureClicks();
    const url = `${SITE_ORIGIN}/account/jane@example.com?utm_source=jane@example.com&utm_campaign=0123456789abcdef0123456789abcdef&ref=joe@example.com#access_token=secretvalue`;
    await collect(site, { v: BUYER, u: url }, {}, { WEB });
    await collect(site, { t: "goal", v: BUYER, n: "signup jane@example.com", p: { mail: "jane@example.com", plan: "pro" } }, {}, { WEB });
    const session = await row<Record<string, string>>("SELECT entry_path, exit_path, source, utm_source, utm_campaign FROM web_sessions WHERE visitor_id = ?1", BUYER);
    const stored = JSON.stringify([session, points.map((p) => p.blobs)]);
    expect(stored).not.toContain("jane@example.com");
    expect(stored).not.toContain("joe@example.com");
    expect(stored).not.toContain("secretvalue");
    expect(stored).not.toContain("0123456789abcdef0123456789abcdef");
    expect(session!.entry_path).toBe("/account/[email]");
    expect(stored).toContain("plan=pro");
  });

  it("keeps a route from a hash-mode page, without what follows it", async () => {
    const site = await createSite();
    await collect(site, { v: BUYER, u: `${SITE_ORIGIN}/app#/orders/42?token=abc` });
    expect(await row("SELECT entry_path FROM web_sessions WHERE visitor_id = ?1", BUYER)).toEqual({ entry_path: "/app#/orders/42" });
  });

  it("keeps emails out of the missed-links report", async () => {
    const { points, CLICKS } = captureClicks();
    const url = new URL(`${ORIGIN}/reset-jane@example.com`);
    await logHit(new Request(url, { headers: { "User-Agent": UA } }), { ...env, CLICKS }, url, { domain: "sh.example", slug: "reset-jane@example.com", kind: "miss", sourceTag: null, qr: false });
    expect(points).toHaveLength(1);
    expect(JSON.stringify(points)).not.toContain("jane@example.com");
  });
});

describe("what leaves through webhooks and emails", () => {
  const addHook = async (body: Record<string, unknown>) => {
    const res = await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/w", events: ["site.payment", "link.clicked"], ...body }));
    expect(res.status).toBe(201);
    return res.json<{ id: number; webhooks: { id: number; fields: string }[] }>();
  };
  const deliveryBody = async (id: number) => JSON.parse((await row<{ payload: string }>("SELECT payload FROM webhook_deliveries WHERE webhook_id = ?1", id))!.payload) as { data: Record<string, any> };

  it("keeps sending existing and API-created endpoints everything", async () => {
    const created = await addHook({});
    expect(created.webhooks[0]!.fields).toBe("full");
    const site = await createSite();
    const s = await visit(site, BUYER);
    await pay(site, { id: "p1", ref: s, email: "buyer@example.com" });
    const { data } = await deliveryBody(created.id);
    expect(data.payment.email).toBe("buyer@example.com");
    expect(data.credited).toMatchObject({ source: expect.any(String), landing_page: "/", device: expect.any(String) });
    expect(data.journey).toMatchObject({ visits: 1 });
    expect(data.visitor_supplied).toContain("credited.source");
  });

  it("sends a minimal endpoint the money and the channel, in one event with the full copy", async () => {
    const full = await addHook({});
    const small = await addHook({ fields: "minimal", url: "https://hooks.example.com/small" });
    const site = await createSite();
    const s = await visit(site, BUYER);
    await pay(site, { id: "p1", ref: s, email: "buyer@example.com" });
    const { data } = await deliveryBody(small.id);
    expect(data.payment).toMatchObject({ id: "api:charge:p1", amount: 50 });
    expect(data.payment.email).toBeUndefined();
    expect(data.credited).toEqual({ channel: expect.any(String) });
    expect(data.journey).toBeUndefined();
    const ids = await rows<{ event_id: string }>("SELECT event_id FROM webhook_deliveries WHERE webhook_id IN (?1, ?2)", full.id, small.id);
    expect(new Set(ids.map((r) => r.event_id)).size).toBe(1);
    // An erasure reaches the minimal copy too.
    await privacy(site, "erase", { paymentId: "api:charge:p1", confirm: true });
    expect(await row("SELECT 1 FROM webhook_deliveries")).toBeNull();
  });

  it("keeps an endpoint's choice when a script saves it without saying", async () => {
    const created = await addHook({ fields: "minimal" });
    const res = await call(`${API}/webhooks/${created.id}`, { ...json({ url: "https://hooks.example.com/w", events: ["site.payment"] }), method: "PUT" });
    expect((await res.json<{ webhooks: { fields: string }[] }>()).webhooks[0]!.fields).toBe("minimal");
    expect((await call(`${API}/webhooks`, json({ url: "https://hooks.example.com/x", events: ["site.payment"], fields: "everything" }))).status).toBe(400);
  });

  it("sends link.clicked to a minimal endpoint without city, device or referrer", async () => {
    await addHook({ fields: "minimal", events: ["link.clicked"] });
    await putLink("go", { u: "https://example.com/" });
    await call(`${ORIGIN}/go`, { headers: { "User-Agent": UA, Referer: "https://news.example.org/a" }, redirect: "manual" });
    await vi.waitFor(() => expect(hooked).toHaveLength(1));
    const { data } = JSON.parse(hooked[0]!.body) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ slug: "go", link: { domain: "sh.example", slug: "go" }, at: expect.any(String) });
    for (const gone of ["city", "device", "os", "browser", "source", "referrer"]) expect(data[gone]).toBeUndefined();
  });

  it("shortens and labels what a visitor chose, in payment emails", async () => {
    const site = await createSite({ notifyPayments: true });
    const long = `IGNORE-PREVIOUS-INSTRUCTIONS-${"x".repeat(150)}`;
    const s = await visit(site, BUYER, `${SITE_ORIGIN}/?utm_source=${long}&utm_campaign=${long}`);
    await call(`${API}/sites/${site.id}/payments`, json({ id: "m1", amount: 5, currency: "USD", ref: s }), { DIGEST_PROVIDER: "resend", DIGEST_API_KEY: "re_key" } as Partial<Env>);
    await vi.waitFor(() => expect(mails).toHaveLength(1));
    expect(mails[0]!.text).toContain("as the visit reported it");
    expect(mails[0]!.text).not.toContain("x".repeat(100));
    expect(shortText("a\u0007b\nc", 80)).toBe("a b c");
    expect(shortText("x".repeat(200), 10)).toHaveLength(10);
  });
});

describe("shared statistics", () => {
  it("doesn't show recent clicks on a new share unless asked", async () => {
    await call(`${API}/links`, json({ slug: "shared", target: "https://example.com/" }));
    const link = await (await call(`${API}/links/sh.example/shared/shares`, json({}))).json<{ share: { showRecent: boolean } }>();
    expect(link.share.showRecent).toBe(false);
    const report = await (await call(`${API}/shares`, json({ scope: "set", title: "R", links: [{ domain: "sh.example", slug: "shared" }] }))).json<{ share: { showRecent: boolean } }>();
    expect(report.share.showRecent).toBe(false);
  });
});

// Importing past payments through a provider's API, for revenue from before
// the webhook was connected. Each listed object is wrapped in the shape its
// webhook would have had and goes through the same adapter, so ids, amounts
// and de-duplication match what webhooks store; payments already recorded
// are not counted twice. Old payments seldom carry a visit reference, so most
// count in the totals as "not matched".
//
// One call imports a few pages and returns a cursor to continue from.
// Not available for PayPal (its transaction search needs a separate
// permission and 31-day windows).

import type { Provider } from "../../shared/sites";
import { ADAPTERS } from "./providers";
import { FASTSPRING_API, orderCharge } from "./providers/fastspring";
import { arr, compact, currency, num, obj, sec, str, type Obj } from "./read";
import { emptyEvent, type AdapterContext, type NormalizedEvent } from "./types";

export interface ImportPage {
  events: NormalizedEvent[];
  /** Where to continue, or null when everything since the start date is in. */
  next: string | null;
}

interface ImportContext extends AdapterContext {
  apiKey: string;
}

type PageFn = (c: ImportContext, since: number, cursor: string | null) => Promise<ImportPage>;

async function getJson(url: string, headers: Record<string, string>): Promise<Obj> {
  const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return obj(await res.json());
}

const parse = (provider: Provider, body: unknown, c: ImportContext, headers: Record<string, string> = {}) =>
  ADAPTERS[provider].parse(typeof body === "string" ? body : JSON.stringify(body), new Headers(headers), c);

const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

// Stripe: one-time checkouts, then paid invoices, then refunds (as running totals per charge).
const STRIPE_STAGES = [
  { path: "checkout/sessions", extra: "&status=complete", type: "checkout.session.completed" },
  { path: "invoices", extra: "&status=paid", type: "invoice.paid" },
  { path: "charges", extra: "", type: "charge.refunded" },
] as const;

const stripePage: PageFn = async (c, since, cursor) => {
  const [stageText, after] = (cursor ?? "0:").split(":");
  const stage = Number(stageText) || 0;
  const s = STRIPE_STAGES[stage]!;
  const body = await getJson(
    `https://api.stripe.com/v1/${s.path}?limit=100&created[gte]=${since}${s.extra}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    { Authorization: `Bearer ${c.apiKey}` },
  );
  const items = arr(body.data).map(obj);
  const events: NormalizedEvent[] = [];
  for (const o of items) {
    if (s.type === "charge.refunded" && !(num(o.amount_refunded) ?? 0)) continue;
    events.push(await parse("stripe", { id: `import_${str(o.id)}`, type: s.type, livemode: o.livemode, created: o.created, data: { object: o } }, c));
  }
  const last = str(items[items.length - 1]?.id);
  const next = body.has_more === true && last ? `${stage}:${last}` : stage + 1 < STRIPE_STAGES.length ? `${stage + 1}:` : null;
  return { events, next };
};

const paddlePage: PageFn = async (c, since, cursor) => {
  const base = c.apiKey.includes("_sdbx_") ? "https://sandbox-api.paddle.com" : "https://api.paddle.com";
  const first = `${base}/transactions?status=completed&per_page=30&created_at[GTE]=${encodeURIComponent(new Date(since * 1000).toISOString())}`;
  // The cursor is Paddle's own next-page URL, sent back by the browser: the API key may only ever go to Paddle.
  let url: URL;
  try {
    url = new URL(cursor ?? first);
  } catch {
    throw new Error("Bad cursor");
  }
  if (url.origin !== base || url.username || url.password) throw new Error("Bad cursor");
  const body = await getJson(url.toString(), { Authorization: `Bearer ${c.apiKey}` });
  const events: NormalizedEvent[] = [];
  for (const t of arr(body.data).map(obj)) {
    events.push(await parse("paddle", { event_id: `import_${str(t.id)}`, event_type: "transaction.completed", occurred_at: t.billed_at ?? t.created_at, data: t }, c));
  }
  const pagination = obj(obj(body.meta).pagination);
  return { events, next: pagination.has_more === true ? str(pagination.next) : null };
};

const lemonPage: PageFn = async (c, since, cursor) => {
  const page = Number(cursor ?? "1") || 1;
  const body = await getJson(`https://api.lemonsqueezy.com/v1/orders?page[number]=${page}&page[size]=100&sort=-created_at`, {
    Authorization: `Bearer ${c.apiKey}`,
    Accept: "application/vnd.api+json",
  });
  const events: NormalizedEvent[] = [];
  let older = false;
  for (const o of arr(body.data).map(obj)) {
    const created = sec(obj(o.attributes).created_at) ?? 0;
    if (created < since) {
      older = true;
      continue;
    }
    events.push(await parse("lemonsqueezy", { meta: { event_name: "order_created" }, data: o }, c));
    if (num(obj(o.attributes).refunded_amount)) events.push(await parse("lemonsqueezy", { meta: { event_name: "order_refunded" }, data: o }, c));
  }
  const lastPage = num(obj(obj(body.meta).page).lastPage) ?? page;
  return { events, next: !older && page < lastPage ? String(page + 1) : null };
};

const dodoPage: PageFn = async (c, since, cursor) => {
  const page = Number(cursor ?? "0") || 0;
  const iso = encodeURIComponent(new Date(since * 1000).toISOString());
  const body = await getJson(`https://live.dodopayments.com/payments?status=succeeded&page_size=100&page_number=${page}&created_at_gte=${iso}`, {
    Authorization: `Bearer ${c.apiKey}`,
  });
  const items = arr(body.items).map(obj);
  const events: NormalizedEvent[] = [];
  for (const p of items) {
    const id = str(p.payment_id) ?? "";
    events.push(await parse("dodo", { type: "payment.succeeded", timestamp: p.created_at, data: p }, c, { "webhook-id": `import_${id}` }));
    for (const r of arr(p.refunds).map(obj)) {
      if (str(r.status) && str(r.status) !== "succeeded") continue;
      events.push(await parse("dodo", { type: "refund.succeeded", data: { ...r, payment_id: id } }, c, { "webhook-id": `import_${str(r.refund_id)}` }));
    }
  }
  return { events, next: items.length === 100 ? String(page + 1) : null };
};

// Creem: transactions have no date filter, so pages are read until they get older than the start.
const creemPage: PageFn = async (c, since, cursor) => {
  const page = Number(cursor ?? "1") || 1;
  const base = c.settings.test ? "https://test-api.creem.io" : "https://api.creem.io";
  const body = await getJson(`${base}/v1/transactions/search?page_number=${page}&page_size=100`, { "x-api-key": c.apiKey });
  const event = emptyEvent(`import:creem:${page}`, "import");
  let older = false;
  for (const t of arr(body.items).map(obj)) {
    const at = sec(t.created_at) ?? 0;
    if (at < since) {
      older = true;
      continue;
    }
    const status = str(t.status) ?? "";
    const id = str(t.id);
    const cur = currency(t.currency) ?? "USD";
    if (!id || !["paid", "refunded", "partialRefund", "chargedBack"].includes(status)) continue;
    event.payments.push({
      kind: "charge",
      providerId: id,
      occurredAt: at,
      amountMinor: num(t.amount_paid) ?? num(t.amount) ?? 0,
      currency: cur,
      billing: str(t.subscription) ? null : "one_time",
      customerId: str(t.customer),
      subscriptionId: str(t.subscription),
      refs: compact([id, str(t.order)]),
      productIds: [],
      testMode: t.mode === "test",
    });
    const refunded = num(t.refunded_amount) ?? 0;
    if (refunded > 0) {
      event.payments.push({ kind: "refund", providerId: id, occurredAt: at, amountMinor: refunded, currency: cur, billing: null, refs: [], parentRef: id, productIds: [], testMode: t.mode === "test", cumulative: true });
    }
  }
  const pagination = obj(body.pagination);
  const more = num(pagination.next_page) !== null || (num(pagination.total_pages) ?? page) > page;
  return { events: [event], next: !older && more ? String(page + 1) : null };
};

// Gumroad: sales after a date, page by page.
const gumroadPage: PageFn = async (c, since, cursor) => {
  const url = `https://api.gumroad.com/v2/sales?access_token=${encodeURIComponent(c.apiKey)}&after=${isoDay(since)}${cursor ? `&page_key=${encodeURIComponent(cursor)}` : ""}`;
  const body = await getJson(url, {});
  const events: NormalizedEvent[] = [];
  for (const sale of arr(body.sales).map(obj)) {
    // The shape of a ping, so the adapter reads it.
    const ping = new URLSearchParams();
    const set = (k: string, v: unknown) => {
      if (v !== null && v !== undefined && v !== "") ping.set(k, String(v));
    };
    set("resource_name", "sale");
    set("sale_id", sale.id);
    set("sale_timestamp", sale.created_at);
    set("price", sale.price);
    set("email", sale.email);
    set("purchaser_id", sale.purchaser_id);
    set("subscription_id", sale.subscription_id);
    set("is_recurring_charge", sale.is_recurring_billing);
    set("product_id", sale.product_id);
    set("product_permalink", sale.product_permalink);
    set("order_number", sale.order_id);
    events.push(await parse("gumroad", ping.toString(), c));
    if (sale.chargedback === true) {
      ping.set("resource_name", "dispute");
      events.push(await parse("gumroad", ping.toString(), c));
    }
  }
  return { events, next: str(body.next_page_key) };
};

// FastSpring: the orders list gives ids; each order is read for its details.
const fastspringPage: PageFn = async (c, since, cursor) => {
  if (!c.settings.username) throw new Error("Add the API username first");
  const auth = { Authorization: `Basic ${btoa(`${c.settings.username}:${c.apiKey}`)}`, "User-Agent": "shorthop" };
  const page = Number(cursor ?? "1") || 1;
  const end = isoDay(Math.floor(Date.now() / 1000) + 86400);
  const list = await getJson(`${FASTSPRING_API}/orders?begin=${isoDay(since)}&end=${end}&page=${page}&limit=50`, auth);
  const event = emptyEvent(`import:fastspring:${page}`, "import");
  for (const ref of arr(list.orders)) {
    const id = typeof ref === "string" ? ref : str(obj(ref).id);
    if (!id) continue;
    const order = typeof ref === "object" && obj(ref).total !== undefined ? obj(ref) : await getJson(`${FASTSPRING_API}/orders/${encodeURIComponent(id)}`, auth);
    const charge = orderCharge(order, order.live);
    if (charge && order.completed !== false) event.payments.push(charge);
  }
  return { events: [event], next: list.nextPage ? String(page + 1) : null };
};

const PAGES: Partial<Record<Provider, PageFn>> = {
  stripe: stripePage,
  paddle: paddlePage,
  lemonsqueezy: lemonPage,
  dodo: dodoPage,
  creem: creemPage,
  gumroad: gumroadPage,
  fastspring: fastspringPage,
};

export function importPage(provider: Provider, c: ImportContext, since: number, cursor: string | null): Promise<ImportPage> {
  const fn = PAGES[provider];
  if (!fn) throw new Error(`Importing past payments isn't available for ${provider}`);
  return fn(c, since, cursor);
}

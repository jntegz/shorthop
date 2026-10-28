// Website analytics and revenue: the owner's own sites, shared by the Worker
// and the admin. A site is tracked by /_t/script.js; payments reach it through
// provider webhooks and are credited to the visit that led to them.

import { z } from "zod";
import { HOSTNAME_RE } from "./domains";
import { RANGES } from "./types";

/** cookieless: a daily hash · persistent: a first-party id · consent: cookieless until shorthop("consent", true). */
export const ID_MODES = ["cookieless", "persistent", "consent"] as const;
export type IdMode = (typeof ID_MODES)[number];

export const ATTRIBUTION_MODELS = ["last_non_direct", "last_touch", "first_touch"] as const;
export type AttributionModel = (typeof ATTRIBUTION_MODELS)[number];

export const ATTRIBUTION_INFO: Record<AttributionModel, { label: string; description: string }> = {
  last_non_direct: { label: "Last non-direct visit", description: "The latest visit that came from somewhere; a direct visit only when there's nothing else." },
  last_touch: { label: "Last visit", description: "The visit just before the payment, wherever it came from." },
  first_touch: { label: "First visit", description: "The visit that first brought the customer, within the lookback window." },
};

export const LOOKBACK_DAYS = [7, 30, 60, 90] as const;

/** Months after which payments lose their personal details (null: kept until the site is deleted). */
export const CUSTOMER_RETENTION_MONTHS = [12, 24, 36, 60, 84] as const;

/** How a visit arrived. "Short link" is a click on one of this workspace's links. */
export const CHANNELS = ["Direct", "Short link", "Organic Search", "Paid", "Organic Social", "AI", "Email", "Referral"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PROVIDERS = ["stripe", "paddle", "lemonsqueezy", "dodo", "creem", "gumroad", "fastspring", "paypal"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ProviderSetting {
  key: string;
  label: string;
  hint: string;
  required: boolean;
  placeholder?: string;
  /** Yes/no settings are shown as a switch and stored as "1" or "". */
  toggle?: boolean;
}

export interface ProviderInfo {
  label: string;
  /** How a payment says which visit it came from, for the setup guide. */
  checkout: string;
  /** Where the webhook is created in the provider's dashboard. */
  where: string;
  /** Events to subscribe the webhook to. */
  events: string[];
  /** The value that signs webhooks. null: the provider authenticates them another way. */
  webhookSecret: { label: string; hint: string; prefix?: string; suggestedName: string } | null;
  /** The webhook address carries a random token instead of a signature (Gumroad). */
  urlToken?: true;
  apiKey: { label: string; hint: string; use: string; required: boolean; suggestedName: string } | null;
  /** Non-secret settings. */
  settings: ProviderSetting[];
  /** Past payments can be imported through the API. */
  importable: boolean;
  docs: string;
}

export const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  stripe: {
    label: "Stripe",
    checkout: "Payment Links get client_reference_id=sh_<ref> from the script. Checkout Sessions you create: client_reference_id: \"sh_\" + shorthop.ref().",
    where: "Developers → Webhooks → Add endpoint",
    events: ["checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid", "charge.refunded", "charge.dispute.created", "charge.dispute.closed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"],
    webhookSecret: { label: "Signing secret", hint: "Developers → Webhooks → your endpoint → Signing secret (Reveal).", prefix: "whsec_", suggestedName: "STRIPE_WEBHOOK_SECRET" },
    apiKey: { label: "Restricted API key", hint: "Developers → API keys → Create restricted key: Read for Checkout Sessions, Invoices and Charges.", use: "Only needed to import past payments.", required: false, suggestedName: "STRIPE_API_KEY" },
    settings: [],
    importable: true,
    docs: "https://docs.stripe.com/webhooks",
  },
  paddle: {
    label: "Paddle",
    checkout: "Paddle.js checkouts get customData.sh_ref from the script. Transactions you create: custom_data: { sh_ref }.",
    where: "Developer tools → Notifications → New destination",
    events: ["transaction.completed", "adjustment.created", "adjustment.updated", "subscription.created", "subscription.updated", "subscription.canceled"],
    webhookSecret: { label: "Secret key", hint: "Developer tools → Notifications → your destination → Secret key.", prefix: "pdl_ntfset_", suggestedName: "PADDLE_WEBHOOK_SECRET" },
    apiKey: { label: "API key", hint: "Developer tools → Authentication → API keys, with customer.read and transaction.read.", use: "Paddle webhooks don't carry the buyer's email; with a key it's looked up, and past payments can be imported.", required: false, suggestedName: "PADDLE_API_KEY" },
    settings: [],
    importable: true,
    docs: "https://developer.paddle.com/webhooks/overview",
  },
  lemonsqueezy: {
    label: "Lemon Squeezy",
    checkout: "Checkout links get checkout[custom][sh_ref] from the script. API checkouts: checkout_data.custom.sh_ref.",
    where: "Settings → Webhooks → +",
    events: ["order_created", "order_refunded", "subscription_created", "subscription_updated", "subscription_cancelled", "subscription_expired", "subscription_payment_success", "subscription_payment_refunded"],
    webhookSecret: { label: "Signing secret", hint: "The secret you type when creating the webhook (6–40 characters). Make up a long random one.", suggestedName: "LEMONSQUEEZY_WEBHOOK_SECRET" },
    apiKey: { label: "API key", hint: "Settings → API → +.", use: "Only needed to import past orders.", required: false, suggestedName: "LEMONSQUEEZY_API_KEY" },
    settings: [],
    importable: true,
    docs: "https://docs.lemonsqueezy.com/help/webhooks",
  },
  dodo: {
    label: "Dodo Payments",
    checkout: "Checkout links get metadata_sh_ref from the script. API checkouts: metadata: { sh_ref }.",
    where: "Developer → Webhooks → Add endpoint",
    events: ["payment.succeeded", "refund.succeeded", "dispute.opened", "dispute.won", "subscription.active", "subscription.renewed", "subscription.cancelled", "subscription.expired", "subscription.on_hold"],
    webhookSecret: { label: "Signing key", hint: "Developer → Webhooks → your endpoint → Signing Key.", prefix: "whsec_", suggestedName: "DODO_WEBHOOK_SECRET" },
    apiKey: { label: "API key", hint: "Developer → API Keys (live mode).", use: "Only needed to import past payments.", required: false, suggestedName: "DODO_API_KEY" },
    settings: [],
    importable: true,
    docs: "https://docs.dodopayments.com/developer-resources/webhooks",
  },
  creem: {
    label: "Creem",
    checkout: "Payment links get metadata[sh_ref] from the script. API checkouts: metadata: { sh_ref }.",
    where: "Developers → Webhooks → Create webhook",
    events: ["checkout.completed", "subscription.paid", "subscription.active", "subscription.canceled", "subscription.expired", "refund.created", "dispute.created"],
    webhookSecret: { label: "Webhook secret", hint: "Developers → Webhooks → your webhook → Signing secret.", suggestedName: "CREEM_WEBHOOK_SECRET" },
    apiKey: { label: "API key", hint: "Developers → API keys.", use: "Gives exact amounts for renewals and imports past payments.", required: false, suggestedName: "CREEM_API_KEY" },
    settings: [{ key: "test", label: "Test mode", hint: "Use Creem's test API (test-api.creem.io) with a test key.", required: false, toggle: true }],
    importable: true,
    docs: "https://docs.creem.io/code/webhooks",
  },
  gumroad: {
    label: "Gumroad",
    checkout: "Product links (gumroad.com/l/…) get ?sh_ref= from the script; Gumroad sends it back in url_params.",
    where: "Settings → Advanced → Ping (paste the address there)",
    events: ["sale", "refund", "dispute", "dispute_won", "cancellation", "subscription_ended"],
    webhookSecret: null,
    urlToken: true,
    apiKey: { label: "Access token", hint: "Settings → Advanced → Applications → create an application → Generate access token.", use: "Confirms each ping with Gumroad (Gumroad doesn't sign pings) and imports past sales.", required: false, suggestedName: "GUMROAD_ACCESS_TOKEN" },
    settings: [],
    importable: true,
    docs: "https://gumroad.com/ping",
  },
  fastspring: {
    label: "FastSpring",
    checkout: "Store Builder checkouts get the tag sh_ref from the script (fastspring.builder.tag). Sessions you create: tags: { sh_ref }.",
    where: "Developer Tools → Webhooks → Configuration → Add webhook, with an HMAC SHA256 secret",
    events: ["order.completed", "subscription.charge.completed", "return.created", "subscription.activated", "subscription.canceled", "subscription.deactivated"],
    webhookSecret: { label: "HMAC secret", hint: "Developer Tools → Webhooks → your webhook → HMAC SHA256 Secret (you choose it).", suggestedName: "FASTSPRING_WEBHOOK_SECRET" },
    apiKey: { label: "API password", hint: "Developer Tools → APIs → API Credentials → Create (gives a username and a password).", use: "With the API username, imports past orders.", required: false, suggestedName: "FASTSPRING_API_PASSWORD" },
    settings: [{ key: "username", label: "API username", hint: "The username shown with the API credentials.", required: false }],
    importable: true,
    docs: "https://developer.fastspring.com/reference/webhooks",
  },
  paypal: {
    label: "PayPal",
    checkout: "Orders: purchase_units[0].custom_id = shorthop.ref(). Subscriptions: custom_id = shorthop.ref().",
    where: "developer.paypal.com → Apps & Credentials → your app → Webhooks → Add webhook",
    events: ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.SALE.COMPLETED", "PAYMENT.SALE.REFUNDED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.EXPIRED", "CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.RESOLVED"],
    webhookSecret: null,
    apiKey: { label: "Client secret", hint: "Apps & Credentials → your app → Secret. PayPal checks each webhook's signature through its API, so this is needed.", use: "Verifies every webhook with PayPal.", required: true, suggestedName: "PAYPAL_CLIENT_SECRET" },
    settings: [
      { key: "clientId", label: "Client ID", hint: "Apps & Credentials → your app → Client ID.", required: true },
      { key: "webhookId", label: "Webhook ID", hint: "Shown next to the webhook after you add it.", required: true, placeholder: "1AB23456CD789012E" },
      { key: "sandbox", label: "Sandbox", hint: "Use PayPal's sandbox (api-m.sandbox.paypal.com) with sandbox credentials.", required: false, toggle: true },
    ],
    importable: false,
    docs: "https://developer.paypal.com/api/rest/webhooks/",
  },
};

/** Session columns the dashboard can break down and filter by. */
export const SITE_DIMS = [
  "channel",
  "source",
  "referrer",
  "campaign",
  "utm_source",
  "utm_medium",
  "utm_term",
  "utm_content",
  "link",
  "entry",
  "exit",
  "hostname",
  "country",
  "region",
  "city",
  "device",
  "os",
  "browser",
  "language",
  "org",
  "continent",
  "timezone",
  "screen",
  "visitor_type",
] as const;
export type SiteDim = (typeof SITE_DIMS)[number];

/** Event-level lists, read from Analytics Engine (the last 90 days). */
export const EVENT_LISTS = ["pages", "goals", "outbound"] as const;
export type EventList = (typeof EVENT_LISTS)[number];

export const GRANULARITIES = ["hour", "day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

// ---- DTOs -------------------------------------------------------------------------

export interface SiteDTO {
  id: string;
  name: string;
  domains: string[];
  timezone: string;
  currency: string;
  idMode: IdMode;
  respectGpc: boolean;
  attributionModel: AttributionModel;
  lookbackDays: number;
  excludePaths: string[];
  tagLinks: boolean;
  /** Email the digest recipient about each new payment. */
  notifyPayments: boolean;
  /** Match payments by email only to identities the site's server sent, never to ones the browser reported. */
  serverEmailsOnly: boolean;
  /** Email (and webhook) when a source sends at least 4x its usual hourly visits. */
  spikeAlerts: boolean;
  /** Email a summary of the day before, at digestHour in the site's time zone. */
  dailyDigest: boolean;
  digestHour: number;
  /** Off: visits aren't recorded and short links aren't tagged; payments still are. */
  tracking: boolean;
  /** Months after which customer details are removed from payments; null keeps them until the site is deleted. */
  customerRetentionMonths: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SiteListItem extends SiteDTO {
  visitors24h: number;
  online: number;
  /** Distinct visitors of the last 7 days, and of the 7 before. */
  visitors7d: number;
  visitorsPrev7d: number;
  visitors30d: number;
  /** Visits per day of the last 14 days in the site's time zone, oldest first (today last). */
  visitsDaily: { day: string; visits: number }[];
  /** Where most visits of the last 7 days came from. */
  topSource: { name: string; share: number } | null;
  /** The last event from the site, any time; null when nothing has arrived yet. */
  lastSeenAt: number | null;
  /** Net revenue of the last 30 days, and the 30 before, minor units of the site currency. */
  revenue30d: number;
  revenuePrev30d: number;
  /** Distinct new customers of the last 30 days. */
  customers30d: number;
}

export type SiteSummary = Omit<SiteListItem, keyof SiteDTO>;

export interface SiteTotals {
  visitors: number;
  sessions: number;
  pageviews: number;
  /** Share of sessions with one pageview and no goal, 0..1. */
  bounceRate: number;
  /** Average engaged seconds per session. */
  avgEngagedSec: number;
  /** Net revenue (charges minus refunds and disputes), minor units of the site currency. */
  revenue: number;
  /** Charges only, before refunds. */
  grossRevenue: number;
  refunds: number;
  payments: number;
  /** Distinct customers with a new (non-renewal) charge credited in the period. */
  customers: number;
  /** customers / visitors, 0..1. */
  conversion: number;
  /** revenue / visitors, minor units. */
  revenuePerVisitor: number;
  /** Visitors who completed at least one goal. */
  goalVisitors: number;
  /** Visitors who clicked through to a checkout. */
  checkoutVisitors: number;
  /** Visitors who arrived through a short link. */
  linkVisitors: number;
}

export interface SitePoint {
  /** Bucket start, unix seconds. */
  t: number;
  visitors: number;
  sessions: number;
  pageviews: number;
  revenue: number;
  payments: number;
  /** Engaged time of the visits that started in the bucket. */
  engagedMs: number;
  /** Visits that completed at least one goal. */
  goalSessions: number;
}

/** An unusual burst of visits from one source (Settings → alerts), shown on the chart. */
export interface SiteSpikeDTO {
  t: number;
  source: string;
  visits: number;
  baseline: number;
}

export interface SiteOverviewDTO {
  site: SiteDTO;
  from: string;
  to: string;
  granularity: Granularity;
  totals: SiteTotals;
  previous: SiteTotals | null;
  series: SitePoint[];
  /** The period before, bucket by bucket (same length); null for all time. */
  previousSeries: SitePoint[] | null;
  spikes: SiteSpikeDTO[];
  online: number;
  /** Payments in the period not linked to any visit. */
  unmatched: number;
  aeAvailable: boolean;
}

export interface SiteBreakdownRow {
  value: string;
  visitors: number;
  sessions: number;
  pageviews: number;
  revenue: number;
  customers: number;
}

export interface EventListRow {
  value: string;
  visitors: number;
  count: number;
  /** Pages: revenue of the sessions that started there (exclusive). Goals: revenue of sessions that completed it (assisted). */
  revenue?: number;
}

/** Goal names the goal-properties query accepts (it's matched as a literal in Analytics Engine SQL). */
export const GOAL_NAME_RE = /^[\p{L}\p{N} _.:/-]{1,64}$/u;

/** One property value sent with a goal (data-sh-goal-<prop>, or shorthop("goal", name, props)). */
export interface GoalPropRow {
  key: string;
  value: string;
  visitors: number;
  count: number;
}

export interface SitePaymentDTO {
  id: string;
  provider: string;
  kind: string;
  billing: string;
  occurredAt: number;
  amountMinor: number;
  currency: string;
  amountSiteMinor: number | null;
  email: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  matchedBy: string | null;
  confidence: string | null;
  unmatchedReason: string | null;
  testMode: boolean;
  /** The matched visitor, for their journey. */
  visitorId: string | null;
  session: { id: string; startedAt: number; channel: string; source: string; campaign: string; link: string; entry: string; country: string } | null;
  credited: { id: string; startedAt: number; channel: string; source: string; campaign: string; link: string; entry: string; country: string } | null;
}

export interface SessionDTO {
  id: string;
  visitorId: string;
  startedAt: number;
  lastSeenAt: number;
  pageviews: number;
  goals: number;
  engagedSec: number;
  channel: string;
  source: string;
  campaign: string;
  link: string;
  entry: string;
  exit: string;
  country: string;
  city: string;
  device: string;
  browser: string;
  os: string;
}

export interface VisitorProfileDTO {
  siteId: string;
  visitorId: string;
  email: string | null;
  name: string | null;
  sessions: SessionDTO[];
  payments: SitePaymentDTO[];
}

export type SecretMode = "stored" | "cloudflare";

export interface ConnectionDTO {
  id: string;
  siteId: string;
  provider: Provider;
  label: string;
  /** Off: webhooks are answered but nothing is recorded. */
  enabled: boolean;
  hasSecret: boolean;
  hasApiKey: boolean;
  /** Where each secret lives: pasted (encrypted in D1) or a named Cloudflare Worker secret. */
  webhookSecretMode: SecretMode | null;
  webhookSecretRef: string | null;
  apiKeyMode: SecretMode | null;
  apiKeyRef: string | null;
  /** Non-secret provider settings (PayPal client id, webhook id…). */
  settings: Record<string, string>;
  productFilter: string[];
  webhookUrl: string;
  createdAt: number;
  lastEventAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastCheck: ConnectionCheckDTO | null;
}

export interface ConnectionCheckDTO {
  at: number;
  ok: boolean;
  checks: { id: string; label: string; status: "ok" | "warn" | "error"; detail: string }[];
}

export interface SubscriptionStatsDTO {
  /** Monthly recurring revenue now, minor units of the site currency. */
  mrr: number;
  active: number;
  /** New subscriptions and cancellations in the period. */
  started: number;
  canceled: number;
  /** canceled / (active at start of the period), 0..1. */
  churnRate: number;
  newRevenue: number;
  renewalRevenue: number;
}

export interface LinkRevenueDTO {
  revenue: number;
  payments: number;
  customers: number;
  sessions: number;
  /** Per site, since a link can lead to more than one. */
  bySite: { siteId: string; name: string; currency: string; revenue: number; payments: number; sessions: number }[];
}

// ---- Insights -----------------------------------------------------------------------

export const PEAK_METRICS = ["visits", "sales", "revenue"] as const;
export type PeakMetric = (typeof PEAK_METRICS)[number];

export interface PeakHoursDTO {
  metric: PeakMetric;
  /** 7 rows (Monday first) of 24 hours, in the site's time zone. */
  cells: number[][];
  /** The busiest cells, highest first (at most 3, only non-zero). */
  top: { day: number; hour: number; value: number }[];
  total: number;
}

export interface EngagementRow {
  path: string;
  /** Visits with reading data on the page. */
  visits: number;
  medianSec: number;
  avgSec: number;
  /** Average deepest scroll, 0–100 (visits that reported one). */
  avgScroll: number;
  /** Share of visits that scrolled 75% or more, 0–1. */
  deepShare: number;
}

export interface EngagementDTO {
  available: boolean;
  error?: string;
  all: EngagementRow[];
  /** Visits of people who paid at some point. */
  buyers: EngagementRow[];
  others: EngagementRow[];
}

/** p75 page speed (Core Web Vitals), like Google reports it; null where nothing was measured. */
export interface VitalsRow {
  path: string;
  /** Page loads measured. */
  loads: number;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
}

export interface PageSpeedDTO {
  available: boolean;
  error?: string;
  /** The whole site; path "". */
  overall: VitalsRow | null;
  pages: VitalsRow[];
}

/** Google's thresholds: good up to the first number, poor from the second. */
export const VITALS_THRESHOLDS = { lcpMs: [2500, 4000], inpMs: [200, 500], cls: [0.1, 0.25] } as const;

export interface PurchasePathsDTO {
  /** First purchases in the period that were matched to a visitor. */
  customers: number;
  medianHoursToBuy: number | null;
  medianVisits: number | null;
  /** Share bought during their first visit, 0–1. */
  firstVisitShare: number;
  /** Where the customer first came from, against the visit credited with the sale. */
  pairs: { found: string; credited: string; customers: number; revenue: number }[];
  /** Landing pages of the visits before each first purchase. */
  pages: { path: string; customers: number }[];
}

export interface CustomerValueRow {
  /** The source of the customer's first visit. */
  source: string;
  channel: string;
  customers: number;
  /** Everything they paid so far, net of refunds, site currency. */
  lifetimeRevenue: number;
  avgValue: number;
  /** Share who paid more than once, 0–1. */
  repeatShare: number;
}

export interface CustomerValueDTO {
  rows: CustomerValueRow[];
  customers: number;
  lifetimeRevenue: number;
}

export interface InstallStatusDTO {
  /** Unix seconds of the latest visit, or null before the first. */
  lastSeenAt: number | null;
  hostname: string | null;
  visits24h: number;
}

// ---- Validation ---------------------------------------------------------------------

/** Currencies with a daily ECB reference rate (frankfurter.dev): payments in any of them convert into any other. */
export const FX_CURRENCIES = ["AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"] as const;

export const SITE_ID_RE = /^st_[A-Za-z0-9_-]{8,24}$/;
export const CONNECTION_ID_RE = /^pc_[A-Za-z0-9_-]{8,24}$/;
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{12,32}$/;
export const CURRENCY_RE = /^[A-Z]{3}$/;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "https://www.Example.com/x" or "example.com" → "example.com". */
export function normalizeSiteDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
  return s;
}

/** Hostnames a site accepts: localhost for testing, or real hostnames. */
export function isSiteDomain(s: string): boolean {
  return s === "localhost" || HOSTNAME_RE.test(s);
}

/** Does a hostname belong to the site (its domains, www. and any subdomain)? */
export function hostBelongs(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** A path glob: "*" matches anything within a segment, "**" anything at all. */
export function pathMatches(path: string, glob: string): boolean {
  const re = glob
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`).test(path);
}

const domainsField = z
  .array(z.string().max(253))
  .min(1, "Add the site's domain")
  .max(10)
  .transform((list) => [...new Set(list.map(normalizeSiteDomain).filter(Boolean))])
  .refine((list) => list.length > 0 && list.every(isSiteDomain), "Use domain names like example.com");

const siteFields = {
  name: z.string().trim().min(1, "Name the site").max(80),
  domains: domainsField,
  timezone: z.string().max(64).refine(isTimeZone, "Unknown time zone"),
  currency: z.string().trim().toUpperCase().regex(CURRENCY_RE, "Use a 3-letter currency code like USD"),
  idMode: z.enum(ID_MODES),
  respectGpc: z.boolean(),
  attributionModel: z.enum(ATTRIBUTION_MODELS),
  lookbackDays: z.number().int().min(1).max(365),
  excludePaths: z.array(z.string().trim().min(1).max(200).regex(/^\//, "Paths start with /")).max(50),
  tagLinks: z.boolean(),
  notifyPayments: z.boolean(),
  serverEmailsOnly: z.boolean(),
  spikeAlerts: z.boolean(),
  dailyDigest: z.boolean(),
  digestHour: z.number().int().min(0).max(23),
  tracking: z.boolean(),
  customerRetentionMonths: z
    .number()
    .int()
    .refine((m) => (CUSTOMER_RETENTION_MONTHS as readonly number[]).includes(m), "Choose 1, 2, 3, 5 or 7 years")
    .nullable(),
};

export const createSiteSchema = z.object({
  ...siteFields,
  timezone: siteFields.timezone.default("UTC"),
  currency: siteFields.currency.default("USD"),
  idMode: siteFields.idMode.default("cookieless"),
  respectGpc: siteFields.respectGpc.default(true),
  attributionModel: siteFields.attributionModel.default("last_non_direct"),
  lookbackDays: siteFields.lookbackDays.default(30),
  excludePaths: siteFields.excludePaths.default([]),
  tagLinks: siteFields.tagLinks.default(true),
  notifyPayments: siteFields.notifyPayments.default(false),
  serverEmailsOnly: siteFields.serverEmailsOnly.default(false),
  spikeAlerts: siteFields.spikeAlerts.default(true),
  dailyDigest: siteFields.dailyDigest.default(false),
  digestHour: siteFields.digestHour.default(8),
  tracking: siteFields.tracking.default(true),
  customerRetentionMonths: siteFields.customerRetentionMonths.default(null),
});
export const updateSiteSchema = z.object(siteFields).partial();
export type CreateSiteInput = z.input<typeof createSiteSchema>;
export type UpdateSiteInput = z.input<typeof updateSiteSchema>;

export const siteParamSchema = z.object({ id: z.string().regex(SITE_ID_RE) });
export const siteConnParamSchema = z.object({ id: z.string().regex(SITE_ID_RE), conn: z.string().regex(CONNECTION_ID_RE) });

const filterValue = z.string().max(300);

/** The dashboard's period, granularity and filters (one equality filter per dimension). */
export const siteQuerySchema = z
  .object({
    range: z.enum(RANGES).default("30d"),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    granularity: z.enum(GRANULARITIES).optional(),
    ...Object.fromEntries(SITE_DIMS.map((d) => [`f_${d}`, filterValue.optional()])),
  })
  .refine((q) => q.range !== "custom" || (q.from && q.to), { message: "A custom period needs from and to dates" });
export type SiteQuery = z.infer<typeof siteQuerySchema>;

export const breakdownQuerySchema = siteQuerySchema.and(z.object({ dim: z.enum(SITE_DIMS), limit: z.coerce.number().int().min(1).max(500).default(100) }));
export const eventListQuerySchema = siteQuerySchema.and(z.object({ list: z.enum(EVENT_LISTS) }));
export const goalPropsQuerySchema = siteQuerySchema.and(z.object({ name: z.string().regex(GOAL_NAME_RE) }));
export const peakQuerySchema = siteQuerySchema.and(z.object({ metric: z.enum(["visits", "sales", "revenue"]).default("visits") }));

export const paymentsQuerySchema = siteQuerySchema.and(
  z.object({
    status: z.enum(["all", "matched", "unmatched"]).default("all"),
    limit: z.coerce.number().int().min(1).max(500).default(25),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    q: z.string().max(100).optional(),
  }),
);

/** A Cloudflare Worker secret's name, as `wrangler secret put` takes it. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** The Worker's own secrets and settings: a connection may not read them. */
export function isReservedSecretName(name: string): boolean {
  return /^(SESSION_SECRET|ENCRYPTION_KEY|ADMIN_PASSWORD|ADMIN_PASSWORD_HASH|ADMIN_EMAIL|ADMIN_HOST|VISITOR_SALT|CF_ANALYTICS_TOKEN|CF_ACCOUNT_ID|API_TOKEN|TURNSTILE_SECRET|RESEND_API_KEY|EMAILIT_API_KEY|POSTMARK_API_KEY|SENDGRID_API_KEY|MAILGUN_API_KEY|ACCESS_.*|DIGEST_.*|DEV_.*|PRIVACY_.*|SHORT_DOMAINS|FALLBACK_URL|KV_CACHE_TTL|WORKERS_PLAN)$/.test(name);
}

const secretName = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SECRET_NAME_RE, "Use capital letters, digits and _ (like STRIPE_WEBHOOK_SECRET)")
  .refine((n) => !isReservedSecretName(n), "That's one of the Worker's own secrets; choose another name");

export const connectionSchema = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().trim().max(60).default(""),
  enabled: z.boolean().default(true),
  /** Omitted: keep the stored one. Empty string: remove it. Pasting a value clears a secret name, and the other way round. */
  webhookSecret: z.string().trim().max(500).optional(),
  apiKey: z.string().trim().max(500).optional(),
  /** The name of a Cloudflare Worker secret instead of a pasted value; null removes it. */
  webhookSecretRef: secretName.nullable().optional(),
  apiKeyRef: secretName.nullable().optional(),
  settings: z.record(z.string().regex(/^[a-zA-Z]{1,40}$/), z.string().trim().max(500)).optional(),
  productFilter: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});
export const connectionUpdateSchema = connectionSchema.omit({ provider: true }).partial();

/** The generic payments API: providers without an adapter, or your own billing. */
export const apiPaymentSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["charge", "refund"]).default("charge"),
  /** Major units, as a decimal: 19.99. */
  amount: z.number().nonnegative().max(1e9),
  currency: z.string().trim().toUpperCase().regex(CURRENCY_RE),
  occurredAt: z.union([z.number().int().positive(), z.iso.datetime({ offset: true })]).optional(),
  /** The sh_ref from shorthop.ref() in the browser, if you passed it through checkout. */
  ref: z.string().regex(SESSION_ID_RE).optional(),
  visitorId: z.string().max(64).optional(),
  customerId: z.string().max(200).optional(),
  email: z.email().max(254).optional(),
  subscriptionId: z.string().max(200).optional(),
  renewal: z.boolean().default(false),
  /** Refunds: the id of the charge they refund. */
  parentId: z.string().max(200).optional(),
});

export const apiIdentifySchema = z.object({
  /** sh_ref from shorthop.ref(), or the visitor id from shorthop.visitor(). */
  ref: z.string().regex(SESSION_ID_RE).optional(),
  visitorId: z.string().max(64).optional(),
  email: z.email().max(254).optional(),
  name: z.string().max(200).optional(),
  userId: z.string().max(200).optional(),
}).refine((v) => v.ref || v.visitorId, { message: "Send ref or visitorId" });

// ---- Privacy requests ----------------------------------------------------------------

/** One person, by exactly one of what a request can name. */
export const privacyPersonSchema = z
  .object({
    email: z.email().max(254).toLowerCase().optional(),
    visitorId: z.string().trim().min(1).max(64).optional(),
    paymentId: z.string().trim().min(1).max(300).optional(),
  })
  .refine((v) => [v.email, v.visitorId, v.paymentId].filter(Boolean).length === 1, { message: "Send exactly one of email, visitorId or paymentId" });
export const privacyEraseSchema = privacyPersonSchema.and(z.object({ confirm: z.literal(true, { message: "Send confirm: true to erase" }) }));
export type PrivacyPersonInput = z.infer<typeof privacyPersonSchema>;

/** What was found for one person (lookup), or removed (erase). */
export interface PrivacyCountsDTO {
  identities: number;
  visits: number;
  payments: number;
  subscriptions: number;
  /** Of the subscriptions, the ones still active or past due. */
  activeSubscriptions: number;
}

export interface PrivacyEraseDTO {
  /** What was removed or anonymized. */
  counts: PrivacyCountsDTO & { anonymizedVisits: number; webhookDeliveries: number };
  warnings: string[];
}

export interface PrivacyRequestDTO {
  id: string;
  kind: "export" | "erase";
  by: string;
  createdAt: number;
  counts: Partial<PrivacyCountsDTO>;
}

// ---- Money ----------------------------------------------------------------------------

/** Minor units per major unit for a currency (JPY 1, USD 100, KWD 1000). */
export function minorFactor(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return 10 ** digits;
  } catch {
    return 100;
  }
}

/** `locale` undefined: the viewer's own; emails pass "en-US" so they read the same everywhere. */
export function formatMoney(minor: number, currency: string, opts: { compact?: boolean; locale?: string } = {}): string {
  const major = minor / minorFactor(currency);
  try {
    return new Intl.NumberFormat(opts.locale, {
      style: "currency",
      currency,
      notation: opts.compact && Math.abs(major) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: opts.compact && Math.abs(major) >= 100 ? 0 : undefined,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}

// ---- Funnels ------------------------------------------------------------------------------

export const FUNNEL_ID_RE = /^fn_[A-Za-z0-9_-]{8,24}$/;
export const FUNNEL_WINDOWS = [1, 24, 72, 168, 720] as const;

export interface FunnelStep {
  type: "page" | "goal";
  /** A path glob for pages ("/pricing", "/blog/**"), a goal's name. */
  value: string;
}

export interface FunnelDTO {
  id: string;
  siteId: string;
  name: string;
  steps: FunnelStep[];
  windowHours: number;
  createdAt: number;
}

export interface FunnelReportDTO {
  funnel: FunnelDTO;
  steps: { step: FunnelStep; visitors: number; medianSecFromPrevious: number | null }[];
  /** Of the visitors who finished every step, how many paid (a charge after reaching the last step). */
  paid: { visitors: number; revenue: number };
  /** True when Analytics Engine returned its row limit, so counts may be low. */
  truncated: boolean;
  available: boolean;
}

export const funnelSchema = z.object({
  name: z.string().trim().min(1, "Name the funnel").max(80),
  steps: z
    .array(
      z.object({
        type: z.enum(["page", "goal"]),
        value: z.string().trim().min(1, "Every step needs a page or a goal").max(200),
      }),
    )
    .min(2, "A funnel has at least two steps")
    .max(10),
  windowHours: z.number().int().min(1).max(24 * 90).default(24),
});
export const siteFunnelParamSchema = z.object({ id: z.string().regex(SITE_ID_RE), funnel: z.string().regex(FUNNEL_ID_RE) });

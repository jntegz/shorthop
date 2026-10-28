// What every payment provider adapter turns a webhook into.

import type { Provider } from "../../shared/sites";

export type PaymentKind = "charge" | "refund" | "dispute" | "dispute_won";
export type Billing = "one_time" | "sub_new" | "sub_renewal";

export interface NormalizedPayment {
  kind: PaymentKind;
  /** The provider's id of this money movement (charge, refund, dispute…). */
  providerId: string;
  occurredAt: number;
  /** Magnitude in minor units; the sign comes from the kind. */
  amountMinor: number;
  currency: string;
  /** null: worked out from the subscription's earlier charges. */
  billing: Billing | null;
  customerId?: string | null;
  email?: string | null;
  subscriptionId?: string | null;
  /** Other ids of the same payment (checkout session, order, transaction…), for matching and de-duplication. */
  refs: string[];
  /** Refunds and disputes: an id of the charge they belong to (its providerId or one of its refs). */
  parentRef?: string | null;
  /** The visit reference (sh_ref) passed through checkout. */
  ref?: string | null;
  productIds: string[];
  testMode: boolean;
  /**
   * Refunds reported as a running total for their parent (Stripe, Lemon Squeezy):
   * the row is replaced, not added to, on the next event.
   */
  cumulative?: boolean;
}

export interface NormalizedSubscription {
  providerId: string;
  status: "active" | "trialing" | "past_due" | "canceled" | "ended";
  customerId?: string | null;
  intervalUnit?: "day" | "week" | "month" | "year" | null;
  intervalCount?: number;
  amountMinor?: number | null;
  currency?: string | null;
  startedAt?: number | null;
  canceledAt?: number | null;
  endedAt?: number | null;
  /** Lemon Squeezy: the order that created it (its charge becomes "sub_new"). */
  firstOrderRef?: string | null;
}

/** A checkout that names the visit but isn't a payment itself (Stripe subscription checkouts). */
export interface NormalizedClaim {
  ref: string;
  /** Provider ids the coming payments will carry (subscription, invoice, customer). */
  ids: string[];
}

export interface NormalizedEvent {
  /** Unique per delivery source, for de-duplication. */
  id: string;
  type: string;
  payments: NormalizedPayment[];
  subscriptions: NormalizedSubscription[];
  claims: NormalizedClaim[];
}

export interface AdapterContext {
  /** The connection's API key, when one is set (pasted or a Cloudflare secret). */
  apiKey: string | null;
  /** Non-secret provider settings (PayPal client id and webhook id…). */
  settings: Record<string, string>;
}

export interface VerifyContext extends AdapterContext {
  /** The webhook's own URL (Gumroad's token is in it). */
  url: URL;
}

export interface ProviderAdapter {
  provider: Provider;
  /**
   * null when the webhook is authentic; otherwise why it was refused. `secret`
   * is the signing secret, or the URL token for providers that use one.
   */
  verify(headers: Headers, body: string, secret: string | null, now: number, ctx: VerifyContext): Promise<string | null>;
  parse(body: string, headers: Headers, ctx: AdapterContext): Promise<NormalizedEvent>;
  /** For "Check connection": signs a sample with the secret and verifies it; null when that works. */
  testSignature?(secret: string, settings: Record<string, string>): Promise<string | null>;
  /** For "Check connection": a cheap read-only call; null when the provider accepts the key. */
  testApiKey?(apiKey: string, settings: Record<string, string>): Promise<string | null>;
}

export const emptyEvent = (id: string, type: string): NormalizedEvent => ({ id, type, payments: [], subscriptions: [], claims: [] });

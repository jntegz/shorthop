// What every payment provider adapter turns a webhook into.

import type { Provider } from "../../shared/sites";

export type PaymentKind = "charge" | "refund" | "dispute" | "dispute_won";
export type Billing = "one_time" | "sub_new" | "sub_renewal";

export interface NormalizedPayment {
  kind: PaymentKind;
  /** The provider's id of this money movement (charge, refund, dispute…). */
  providerId: string;
  occurredAt: number;
  /**
   * When the provider says this payment was begun, if that can be long before it
   * completed (a bank debit settles days after its checkout). A return page
   * belongs to that moment, so browser claims are compared with it too.
   */
  startedAt?: number | null;
  /** Magnitude in minor units; the sign comes from the kind. */
  amountMinor: number;
  /** A partial refund nothing states the size of: stored as 0 and flagged, not as the whole charge. */
  amountUnknown?: boolean;
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
  /** Other ids the charge may be stored under, tried with parentRef. */
  parentRefs?: string[];
  /** How to find the charge when it carries none of those ids. */
  parentHint?: ParentHint | null;
  /**
   * A refund total of the whole stored charge: once the charge is found the row
   * is keyed by it, so the same refund reported under different ids (Creem's
   * webhook and import, Lemon Squeezy's order and its first invoice) is one row.
   */
  ofParent?: boolean;
  /** The visit reference (sh_ref) passed through checkout. */
  ref?: string | null;
  productIds: string[];
  testMode: boolean;
  /** Nothing but the webhook's own word backs this (a Gumroad ping with no access token, or one Gumroad couldn't confirm). */
  unverified?: boolean;
  /**
   * Refunds reported as a running total for their parent (Stripe, Lemon Squeezy):
   * the row is replaced, not added to, on the next event.
   */
  cumulative?: boolean;
  /** With ofParent: when the running total was read, if not at occurredAt (an import reads it now). */
  totalAt?: number;
  /**
   * One refund of a charge whose running total may also be stored (Creem, when
   * an event carries no total): skipped when a stored total was read at or after
   * this refund, and removed by a later total that covers it.
   */
  partOfTotal?: boolean;
}

export type ParentHint =
  /** The first payment of a subscription (Lemon Squeezy: its order). */
  | { firstOf: string }
  /**
   * The customer's payment of this amount closest to a time, within a day
   * (Stripe: an invoice stored without its PaymentIntent). `lacking`: id
   * prefixes the charge must not have yet, or it is another payment. Used only
   * when exactly one charge fits; with several, the refund stays without a charge.
   */
  | { customerId: string; amountMinor: number; currency: string; at: number; lacking: string[] };

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
  /**
   * When the provider says this event happened: an event older than the state
   * stored is ignored. null when it gives no time: such an event can't bring a
   * canceled or ended subscription back.
   */
  eventAt?: number | null;
  /** Gumroad: ids of sales the event names, to confirm it with (ProviderAdapter.confirmEnded). */
  saleRefs?: string[];
}

/** A checkout that names the visit but isn't a payment itself (Stripe subscription checkouts). */
export interface NormalizedClaim {
  ref: string;
  /** Provider ids the coming payments will carry (subscription, invoice, customer). */
  ids: string[];
}

/** More ids of a charge, reported apart from it (Stripe: invoice_payment.paid). The charge may not be stored yet. */
export interface NormalizedLink {
  /** An id the charge is, or will be, stored under. */
  chargeRef: string;
  refs: string[];
}

export interface NormalizedEvent {
  /** Unique per delivery source, for de-duplication. */
  id: string;
  type: string;
  payments: NormalizedPayment[];
  subscriptions: NormalizedSubscription[];
  claims: NormalizedClaim[];
  links: NormalizedLink[];
  /**
   * The provider couldn't confirm this event. It is stored all the same, marked
   * unverified, and `problem` shows on the connection. With `retry` the provider
   * is asked to send it again, which can confirm it. Either way the event isn't
   * marked finished, so a later delivery of it counts: a forged event mustn't make
   * the real one a "duplicate".
   */
  unconfirmed?: { problem: string; retry: boolean };
}

export interface AdapterContext {
  /** The connection's API key, when one is set (pasted or a Cloudflare secret). */
  apiKey: string | null;
  /** Non-secret provider settings (PayPal client id and webhook id…). */
  settings: Record<string, string>;
  /** One delivery's answers from the provider, so verify and parse don't ask twice. */
  memo?: Map<string, unknown>;
  /** The event was built from the provider's own API (an import): there is nothing to confirm. */
  fromApi?: boolean;
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
  /**
   * Asks the provider which charge a refund or dispute belongs to, when none
   * stored carries its ids: more ids to look the charge up by. Needs ctx.apiKey.
   */
  parentRefs?(p: NormalizedPayment, ctx: AdapterContext): Promise<string[]>;
  /**
   * Asks the provider whether a subscription really was canceled or ended, by
   * the sales named here. true only when it says so; otherwise why not, and
   * whether asking again may help. Needs ctx.apiKey.
   */
  confirmEnded?(s: NormalizedSubscription, saleIds: string[], ctx: AdapterContext): Promise<true | { problem: string; retry: boolean }>;
}

export const emptyEvent = (id: string, type: string): NormalizedEvent => ({ id, type, payments: [], subscriptions: [], claims: [], links: [] });

/** The token a refund of a subscription's first payment carries until the order that payment was stored as is known (Lemon Squeezy). */
export const firstOfRef = (subscriptionId: string) => `first_of:${subscriptionId}`;
/** A token on a refund stored before its charge was known: an id of that charge (the cleanup in storePayment finds it by this). */
export const partOfRef = (chargeRef: string) => `part_of:${chargeRef}`;
/** A token on a refund or dispute stored before its charge: an id that charge will carry, so the two can be joined when it arrives. */
export const awaitsRef = (chargeRef: string) => `awaits:${chargeRef}`;

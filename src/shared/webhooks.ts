// Outbound webhooks: the events, and the rules for an endpoint.

import { isFetchableUrl } from "./link-check";

export const WEBHOOK_EVENTS = [
  { type: "link.created", label: "Link created", description: "A new link, including imports and restored deletions." },
  { type: "link.updated", label: "Link updated", description: "Any saved change, with the names of the fields that changed." },
  { type: "link.deleted", label: "Link deleted", description: "The link as it was when it was deleted." },
  { type: "link.health_changed", label: "Destination down or back", description: "A destination failed its checks, or works again." },
  { type: "link.milestone", label: "Click milestone", description: "A link passed 100, 1,000, 10,000… human clicks (checked daily)." },
  {
    type: "link.clicked",
    label: "Link clicked",
    description: "Each human click, sent right away. Best effort: never retried and not in the delivery log, so a busy link costs nothing to store. For exact counts, use milestones or the statistics API.",
  },
  {
    type: "link.tracked_click",
    label: "Tracked click",
    description: "Each person's click on a link with Advanced tracking: location, network (Tor, VPN hints), device, referrer and visit number. The IP address only masked.",
  },
  { type: "site.payment", label: "Website payment", description: "A payment, renewal, refund or dispute on a tracked website, with the visit it's credited to." },
  { type: "site.traffic_spike", label: "Website traffic spike", description: "A source sent at least 4x its usual hourly visits to a tracked website (checked hourly). At most three per site and run; the first says how many other sources spiked." },
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]["type"] | "webhook.test";
export const EVENT_TYPES = WEBHOOK_EVENTS.map((e) => e.type) as readonly string[];

/**
 * How much an endpoint is sent about people. "full" is everything an event has,
 * as webhooks always were; "minimal" leaves out the customer's email and the
 * click's city, device and referrer.
 */
export const WEBHOOK_FIELD_SETS = ["full", "minimal"] as const;
export type WebhookFieldSet = (typeof WEBHOOK_FIELD_SETS)[number];

/** Human clicks a link passes to trigger link.milestone. */
export const MILESTONES = [100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000] as const;

export const MAX_WEBHOOKS = 10;
/** Waits after each failed attempt; after the last, the delivery is marked failed. */
export const RETRY_DELAYS_SEC = [30 * 60, 2 * 3600, 6 * 3600, 12 * 3600, 24 * 3600] as const;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_RETENTION_DAYS = 30;

/** The highest milestone a count has reached, or 0. */
export function milestoneFor(clicks: number): number {
  let m = 0;
  for (const x of MILESTONES) if (clicks >= x) m = x;
  return m;
}

export function webhookUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "Enter a full address starting with https://.";
  }
  if (u.protocol !== "https:") return "Use an https:// address: payloads and signatures shouldn't travel in the clear.";
  if (u.username || u.password) return "Put credentials in your endpoint's own checks, not in the address.";
  if (u.href.length > 2048) return "The address is longer than 2,048 characters.";
  if (!isFetchableUrl(u)) return "Use a public address: private networks, localhost and unusual ports aren't allowed.";
  return null;
}

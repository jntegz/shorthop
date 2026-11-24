// Advanced tracking: an opt-in, per-link click log with every detail
// Cloudflare knows about a request, and optionally the visitor's IP address.
// Off for every link until someone switches it on. Everything here comes from
// the request itself (request.cf and headers) and, with browser details on, a
// short page that reads a few values from the visitor's own browser. No
// third-party service is asked about anyone.
//
// What it deliberately never does: WebRTC tricks to find an IP behind a VPN,
// GPS through a misleading page, or canvas / WebGL / audio fingerprinting.

import { z } from "zod";

/** "details": every detail but the IP address; "ip": the IP address too (stored encrypted). */
export const TRACKING_MODES = ["details", "ip"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

/** How long a tracked click is kept, in days. */
export const TRACKING_RETENTION_DAYS = [7, 30, 90, 365] as const;
export type TrackingRetention = (typeof TRACKING_RETENTION_DAYS)[number];
export const DEFAULT_TRACKING_RETENTION: TrackingRetention = 30;

/** Email the owner (DIGEST_TO) on the first person's click only, or on every one (at most one email per link per NOTIFY_EVERY_MIN_SEC). */
export const TRACKING_NOTIFY = ["off", "first", "every"] as const;
export type TrackingNotify = (typeof TRACKING_NOTIFY)[number];
export const NOTIFY_EVERY_MIN_SEC = 600;

/** The beacon endpoint of the browser-details page, on every short domain. */
export const TRACKING_BEACON_PATH = "/_k";

/** The email-open pixel of a tracked link: /_p/<slug> (or /_p/<slug>.gif), on the link's own short domain. */
export const PIXEL_PREFIX = "/_p/";

/** The <img> tag to paste into an email for a tracked link. */
export function pixelTag(shortOrigin: string, slug: string): string {
  return `<img src="${shortOrigin}${PIXEL_PREFIX}${encodeURIComponent(slug)}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
}

export interface TrackingConfig {
  mode: TrackingMode;
  retentionDays: TrackingRetention;
  /** Show a short page that reads screen, time zone and a few other values from the browser before redirecting. */
  browser: boolean;
  notify: TrackingNotify;
  /** When, and by whom, the GDPR warning was accepted (IP mode only). */
  ackAt: number | null;
  ackBy: string | null;
  /** When tracking was switched on (or last changed). */
  since: number;
  /** The email-open pixel (/_p/<slug>) records opens: off unless switched on. */
  pixel: boolean;
  /** Why this link is tracked, in the words of whoever switched it on (GDPR accountability). */
  purpose: string;
}

/** The most characters a purpose may have, and the fewest when the workspace requires one. */
export const PURPOSE_MAX = 300;
export const PURPOSE_MIN = 10;

/**
 * The workspace's rules for Advanced tracking (Settings → Access & security,
 * admins only). The defaults are the cautious ones: IP addresses must be
 * allowed by an admin before anyone can record them. Tightening a rule also
 * changes the links that break it, and every click is checked against the
 * rules again when it is recorded.
 */
export interface TrackingPolicy {
  /** Advanced tracking can be switched on at all. */
  enabled: boolean;
  /** IP mode may be chosen. */
  allowIp: boolean;
  /** The browser-details page may be used. */
  allowBrowser: boolean;
  /** The email-open pixel may be used. */
  allowPixel: boolean;
  /** The longest retention a link may choose. */
  maxRetentionDays: TrackingRetention;
  /** Switching tracking on needs a written purpose. */
  requirePurpose: boolean;
}

export const DEFAULT_TRACKING_POLICY: TrackingPolicy = {
  enabled: true,
  allowIp: false,
  allowBrowser: true,
  allowPixel: true,
  maxRetentionDays: 90,
  requirePurpose: true,
};

export function parseTrackingPolicy(stored: string | null | undefined): TrackingPolicy {
  if (!stored) return { ...DEFAULT_TRACKING_POLICY };
  try {
    const v = JSON.parse(stored) as Partial<TrackingPolicy>;
    const d = DEFAULT_TRACKING_POLICY;
    const bool = (x: unknown, fallback: boolean) => (typeof x === "boolean" ? x : fallback);
    return {
      enabled: bool(v.enabled, d.enabled),
      allowIp: bool(v.allowIp, d.allowIp),
      allowBrowser: bool(v.allowBrowser, d.allowBrowser),
      allowPixel: bool(v.allowPixel, d.allowPixel),
      maxRetentionDays: isOneOf(TRACKING_RETENTION_DAYS, v.maxRetentionDays) ? v.maxRetentionDays : d.maxRetentionDays,
      requirePurpose: bool(v.requirePurpose, d.requirePurpose),
    };
  } catch {
    return { ...DEFAULT_TRACKING_POLICY };
  }
}

/**
 * A link's settings brought within the policy. With tracking turned off for
 * the workspace the link keeps its settings (nothing is recorded: every click
 * checks the rules), so its click log stays readable and turning tracking back
 * on doesn't need every link set up again.
 */
export function withinPolicy(t: TrackingConfig, p: TrackingPolicy): TrackingConfig | null {
  return {
    ...t,
    mode: t.mode === "ip" && !p.allowIp ? "details" : t.mode,
    ackAt: t.mode === "ip" && !p.allowIp ? null : t.ackAt,
    ackBy: t.mode === "ip" && !p.allowIp ? null : t.ackBy,
    browser: t.browser && p.allowBrowser,
    pixel: t.pixel && p.allowPixel,
    retentionDays: Math.min(t.retentionDays, p.maxRetentionDays) as TrackingRetention,
  };
}

/** What the API takes to switch tracking on or change it; null switches it off. */
export interface TrackingInput {
  mode: TrackingMode;
  retentionDays?: TrackingRetention;
  browser?: boolean;
  notify?: TrackingNotify;
  pixel?: boolean;
  purpose?: string;
  /** Required for "ip": the person accepted the GDPR warning. */
  acknowledged?: boolean;
}

function isOneOf<T extends string | number>(list: readonly T[], v: unknown): v is T {
  return (list as readonly unknown[]).includes(v);
}

/** The stored JSON (links.tracking), or null when tracking is off or the value is malformed. */
export function parseTracking(stored: string | null | undefined): TrackingConfig | null {
  if (!stored) return null;
  try {
    const v = JSON.parse(stored) as Partial<TrackingConfig>;
    if (!v || typeof v !== "object" || !isOneOf(TRACKING_MODES, v.mode)) return null;
    return {
      mode: v.mode,
      retentionDays: isOneOf(TRACKING_RETENTION_DAYS, v.retentionDays) ? v.retentionDays : DEFAULT_TRACKING_RETENTION,
      browser: v.browser === true,
      notify: isOneOf(TRACKING_NOTIFY, v.notify) ? v.notify : "off",
      ackAt: typeof v.ackAt === "number" ? v.ackAt : null,
      ackBy: typeof v.ackBy === "string" ? v.ackBy : null,
      since: typeof v.since === "number" ? v.since : 0,
      pixel: v.pixel === true,
      purpose: typeof v.purpose === "string" ? v.purpose.slice(0, PURPOSE_MAX) : "",
    };
  } catch {
    return null;
  }
}

/** The warning shown before IP addresses are recorded; the admin shows the same text. */
export const IP_TRACKING_WARNING = [
  "An IP address is personal data under the GDPR (and similar laws). Recording it is your responsibility as the controller.",
  "You need a legal basis (for example legitimate interest, documented, or consent), must tell the people who open the link (in your privacy notice), keep it no longer than needed and answer access and erasure requests.",
  "Used to watch specific people without their knowledge, it can break the GDPR and local law. If in doubt, choose tracking without IP addresses.",
] as const;

/** The extra note for browser details: reading values from someone's device may need their consent (ePrivacy Art. 5(3)). */
export const BROWSER_DETAILS_WARNING =
  "Browser details read values such as screen size and time zone from the visitor's device. In the EU that can need the visitor's consent (ePrivacy Directive Art. 5(3)). Adds about 100 to 300 ms before the redirect.";

/** Network signals for one click. "Suspected" means a hint, never proof. */
export interface NetworkFlags {
  tor: boolean;
  datacenter: boolean;
  privateRelay: boolean;
  /** A network on the public list of VPN providers: the provider's name, or "". */
  knownVpn: string;
  /** A known VPN, a datacenter network, or the browser's time zone differs from the IP's. */
  vpnSuspected: boolean;
}

/** Values the browser-details page sends back. */
export interface BrowserDetails {
  screen: string;
  viewport: string;
  dpr: number | null;
  timezone: string;
  /** Minutes east of UTC, as the browser reports it. */
  tzOffset: number | null;
  languages: string;
  platform: string;
  cores: number | null;
  memory: number | null;
  touch: number | null;
  connection: string;
  colorScheme: string;
  dnt: boolean;
  gpc: boolean;
  /** From the browser's User-Agent Client Hints, where it offers them (Chromium): device model, OS version, full browser version. */
  model: string;
  platformVersion: string;
  fullVersion: string;
  at: number;
}

/** One tracked click as the admin sees it. */
export interface TrackedClickDTO {
  id: string;
  at: number;
  domain: string;
  slug: string;
  /** "open": the email pixel was loaded (an email was opened), not a click. */
  event: "click" | "open" | "bot";
  botName: string;
  /** Present only in IP mode and for people with the See IP addresses permission; null otherwise. */
  ip: string | null;
  /** Whether an IP address was recorded (shown masked to people without the permission). */
  hasIp: boolean;
  /** "V1", "V2"…: the same browser on the same network, numbered by first visit to this link. */
  visitor: string;
  visitorVisits: number;
  country: string;
  region: string;
  city: string;
  postalCode: string;
  metroCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  continent: string;
  isEU: boolean;
  asn: number;
  asOrganization: string;
  /** The IP's reverse DNS name (with IP addresses), or only its domain (without). "" when there is none. */
  hostname: string;
  colo: string;
  tlsVersion: string;
  httpProtocol: string;
  rttMs: number | null;
  userAgent: string;
  device: string;
  os: string;
  osVersion: string;
  browser: string;
  browserVersion: string;
  deviceModel: string;
  languages: string;
  referrer: string;
  source: string;
  qr: boolean;
  flags: NetworkFlags;
  details: BrowserDetails | null;
  /** The browser's time zone differs from the one Cloudflare gives for the IP (a VPN or proxy hint). */
  tzMismatch: boolean;
}

export interface TrackedClicksDTO {
  tracking: TrackingConfig | null;
  clicks: TrackedClickDTO[];
  total: number;
  people: number;
  bots: number;
  /** Email opens (the pixel). */
  opens: number;
  visitors: number;
  /** Older clicks exist: pass `offset` with the number already shown. */
  more: boolean;
  canSeeIp: boolean;
}

/** Most clicks one page of the click log returns. */
export const MAX_CLICKS_PAGE = 500;

/** PUT /links/:domain/:slug/tracking: the settings, or null to switch tracking off. */
export const trackingSchema = z
  .object({
    mode: z.enum(TRACKING_MODES),
    retentionDays: z
      .number()
      .int()
      .refine((v) => (TRACKING_RETENTION_DAYS as readonly number[]).includes(v), { message: `retentionDays must be one of ${TRACKING_RETENTION_DAYS.join(", ")}` })
      .optional(),
    browser: z.boolean().optional(),
    notify: z.enum(TRACKING_NOTIFY).optional(),
    pixel: z.boolean().optional(),
    purpose: z.string().trim().max(PURPOSE_MAX).optional(),
    acknowledged: z.boolean().optional(),
  })
  .strict()
  .nullable();

/** PUT /tracking/policy. */
export const trackingPolicySchema = z
  .object({
    enabled: z.boolean(),
    allowIp: z.boolean(),
    allowBrowser: z.boolean(),
    allowPixel: z.boolean(),
    maxRetentionDays: z
      .number()
      .int()
      .refine((v) => (TRACKING_RETENTION_DAYS as readonly number[]).includes(v), { message: `maxRetentionDays must be one of ${TRACKING_RETENTION_DAYS.join(", ")}` }),
    requirePurpose: z.boolean(),
  })
  .strict();

export const clicksQuerySchema = z.object({
  /** Clicks to skip: the next page starts after those already shown. */
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CLICKS_PAGE).optional(),
  event: z.enum(["all", "click", "open", "bot"]).optional(),
  /** Only one visitor's clicks (the full key, as `visitorKey` in the export). */
  visitor: z.string().regex(/^[0-9a-f]{16}$/).optional(),
});

export const ipSchema = z.object({
  ip: z
    .string()
    .trim()
    .max(64)
    .regex(/^[0-9a-fA-F:.]{2,64}$/, "Enter an IPv4 or IPv6 address."),
});


import { z } from "zod";
import { isDay } from "./dates";
import { DEAD_LINK_MAX_DELAY, DEAD_LINK_MIN_DELAY } from "./dead-link";
import { HOSTNAME_RE } from "./domains";
import { CHECK_SCOPES, MAX_EVERY_HOURS, MIN_EVERY_HOURS } from "./link-check";
import { HEX_COLOR_RE } from "./not-found";
import { PERMISSIONS, ROLES } from "./permissions";
import { LINK_PASSWORD_MAX, LINK_PASSWORD_MIN, MAX_CLICK_LIMIT } from "./protection";
import { ROUTE_DEVICES } from "./routing";
import { IMPORT_SLUG_RE } from "./slug";
import { DIGEST_PROVIDERS, LIST_PERIODS, MISS_RETENTION_DAYS, NOISE_LIMITS, RANGES, REAL_MISS_LIMITS, SHARE_RANGES } from "./types";

/** A short domain as typed: trimmed and lowercased; membership is checked by the API. */
const domain = z.string().trim().toLowerCase().max(253);

const tags = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => normalizeTags(Array.isArray(v) ? v : v.split(",")));

/** The end of year 9999 in Unix seconds: later values (milliseconds sent by mistake) break date formatting. */
const MAX_UNIX_SEC = 253402300799;
const unixSec = z.number().int().positive().max(MAX_UNIX_SEC, "Use Unix seconds, not milliseconds.");
/** Smart routing as the editor sends it; validateRouting does the real checks. null turns it off. */
export const routingSchema = z
  .object({
    rules: z
      .array(
        z.object({
          id: z.string().max(8),
          name: z.string().max(60).default(""),
          enabled: z.boolean().default(true),
          devices: z.array(z.enum(ROUTE_DEVICES)).max(ROUTE_DEVICES.length).default([]),
          countries: z.array(z.string().max(2)).max(250).default([]),
          countryMode: z.enum(["in", "not_in"]).default("in"),
          variants: z
            .array(z.object({ id: z.string().max(8), label: z.string().max(40).default(""), url: z.string().max(4096), weight: z.number().int().default(100) }))
            .max(10),
        }),
      )
      .max(10),
  })
  .nullable();

/** A custom social preview; validatePreview does the real checks. null turns it off. */
export const previewSchema = z
  .object({
    title: z.string().max(500),
    description: z.string().max(2000).default(""),
    image: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("upload"), key: z.string().max(40), width: z.number().int().nullable().default(null), height: z.number().int().nullable().default(null) }),
        z.object({ kind: z.literal("url"), url: z.string().max(4096) }),
      ])
      .nullable()
      .default(null),
  })
  .nullable();

export const fetchPreviewSchema = z.object({ url: z.string().max(4096) });

/** Unix seconds, an ISO date string, or null. */
const expiry = z
  .union([unixSec, z.iso.datetime({ offset: true }), z.iso.date(), z.null()])
  .transform((v) => (typeof v === "string" ? Math.floor(Date.parse(v) / 1000) : v))
  .refine((v) => v === null || v <= MAX_UNIX_SEC, "Use a date before the year 10000.");

export const createLinkSchema = z
  .object({
    /** Defaults to the primary short domain. */
    domain: domain.optional(),
    slug: z.string().trim().max(96).optional(),
    target: z.string().max(4096).optional(),
    /** Alias for target, for iOS Shortcuts and scripts. */
    url: z.string().max(4096).optional(),
    title: z.string().trim().max(300).nullish(),
    tags: tags.optional(),
    notes: z.string().max(5000).optional(),
    expiresAt: expiry.optional(),
    active: z.boolean().optional(),
    utm: z.boolean().optional(),
    utmTemplate: z.string().trim().max(512).nullish(),
    passQuery: z.boolean().optional(),
    /** Check the destination on a schedule (default false: off until switched on). */
    monitor: z.boolean().optional(),
    /** Never check it, even when Link health checks every link (default false). Wins over monitor. */
    neverCheck: z.boolean().optional(),
    routing: routingSchema.optional(),
    preview: previewSchema.optional(),
    /** Visitors must enter it first. */
    password: z.string().min(LINK_PASSWORD_MIN).max(LINK_PASSWORD_MAX).nullish(),
    /** Most human clicks allowed. */
    maxClicks: z.number().int().min(1).max(MAX_CLICK_LIMIT).nullish(),
  })
  .refine((v) => v.target || v.url, { message: "target is required", path: ["target"] });

export const updateLinkSchema = z.object({
  target: z.string().max(4096).optional(),
  title: z.string().trim().max(300).nullish(),
  tags: tags.optional(),
  notes: z.string().max(5000).optional(),
  expiresAt: expiry.optional(),
  active: z.boolean().optional(),
  utm: z.boolean().optional(),
  utmTemplate: z.string().trim().max(512).nullish(),
  passQuery: z.boolean().optional(),
  /** true also clears neverCheck. */
  monitor: z.boolean().optional(),
  /** true also switches monitor off. */
  neverCheck: z.boolean().optional(),
  routing: routingSchema.optional(),
  preview: previewSchema.optional(),
  /** A new password; null removes protection. */
  password: z.string().min(LINK_PASSWORD_MIN).max(LINK_PASSWORD_MAX).nullable().optional(),
  /** null removes the limit. Setting one on a link without starts counting from 0. */
  maxClicks: z.number().int().min(1).max(MAX_CLICK_LIMIT).nullable().optional(),
  /** A QR code design (validateQrStyle checks it); null goes back to the default. */
  qr: z.record(z.string(), z.unknown()).nullable().optional(),
  broken: z.boolean().optional(),
  /** The link visitors are pointed to while this one is marked broken; null for none. */
  replacement: z.object({ domain: z.string().regex(HOSTNAME_RE), slug: z.string().regex(IMPORT_SLUG_RE) }).nullish(),
  /** Where visitors go while the link is off: "home" (the main site), another link, or null for the not-found page. */
  offRedirect: z.union([z.literal("home"), z.object({ domain: z.string().regex(HOSTNAME_RE), slug: z.string().regex(IMPORT_SLUG_RE) })]).nullish(),
});

const importRowSchema = z.object({
  /** Falls back to the batch's defaultDomain, then the primary domain. */
  domain: domain.nullish(),
  slug: z.string().trim().min(1).max(96),
  target: z.string().trim().min(1).max(4096),
  title: z.string().trim().max(300).nullish(),
  tags: tags.optional(),
  clicks: z.number().int().nonnegative().nullish(),
  createdAt: unixSec.nullish(),
});

export const importSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(100),
  mode: z.enum(["skip", "overwrite"]).default("skip"),
  dryRun: z.boolean().default(false),
  defaultDomain: domain.optional(),
});

export const listQuerySchema = z.object({
  domain: domain.optional(),
  q: z.string().max(200).optional(),
  tag: z.string().max(100).optional(),
  status: z.enum(["all", "active", "disabled", "expired", "broken", "failing", "shared"]).default("all"),
  sort: z.enum(["created", "updated", "slug", "clicks"]).default("created"),
  period: z.enum(LIST_PERIODS).default("7d"),
});

/** :domain/:slug route params. Format only: links on a retired domain stay manageable. */
export const linkParamSchema = z.object({
  domain: z.string().regex(HOSTNAME_RE),
  slug: z.string().regex(IMPORT_SLUG_RE),
});

export const versionParamSchema = linkParamSchema.extend({
  id: z.coerce.number().int().positive(),
});

export const resyncQuerySchema = z.object({
  /** Cursor from the previous page: "domain/slug". */
  after: z.string().max(400).optional(),
  /** "default-utm" republishes only links that follow the default UTM template. */
  scope: z.enum(["all", "default-utm"]).default("all"),
});

export const clearMissesSchema = z
  .object({
    /** The misses to clear; all of them when neither this nor `probes` is given. */
    links: z
      .array(z.object({ domain: z.string().regex(HOSTNAME_RE), slug: z.string().min(1).max(512) }))
      .min(1)
      .max(500)
      .optional(),
    /** Every stored scanner probe, including those past the report's noise limit. */
    probes: z.literal(true).optional(),
  })
  .refine((v) => !(v.links && v.probes), { message: "Send links or probes, not both" });

export const ignoreMissesSchema = z.object({
  links: z
    .array(
      z.object({
        domain: z.string().regex(HOSTNAME_RE),
        slug: z.string().min(1).max(512),
        /** When it was first ignored (a CSV import keeps the original date); today if left out. */
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const missPolicySchema = z.object({
  trackHumans: z.boolean(),
  trackProbes: z.boolean(),
  trackBots: z.boolean(),
  probeLimit: z.literal(NOISE_LIMITS),
  botLimit: z.literal(NOISE_LIMITS),
  retentionDays: z.literal(MISS_RETENTION_DAYS),
  realLimit: z.literal(REAL_MISS_LIMITS),
});

/** A named range, or range=custom with from and to (inclusive UTC days). */
const period = {
  range: z.enum(RANGES).default("30d"),
  from: z.string().refine(isDay, "Use a date such as 2026-01-31").optional(),
  to: z.string().refine(isDay, "Use a date such as 2026-01-31").optional(),
};
const customHasDates = (v: { range: string; from?: string; to?: string }) => v.range !== "custom" || (!!v.from && !!v.to && v.from <= v.to);
const customDatesError = { message: "A custom period needs from and to dates, from first", path: ["from"] };

export const missExportQuerySchema = z.object({
  ...period,
  /** Include scanner probes / bot-only misses (when tracked). */
  probes: z.enum(["0", "1"]).default("0"),
  bots: z.enum(["0", "1"]).default("0"),
}).refine(customHasDates, customDatesError);

export const rangeQuerySchema = z.object(period).refine(customHasDates, customDatesError);

/** Partial: what's left out keeps its saved value (older callers send only enabled and notify). */
export const checkSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  notify: z.boolean().optional(),
  everyHours: z.number().int().min(MIN_EVERY_HOURS, "Check at most every hour").max(MAX_EVERY_HOURS, "Check at least every 30 days").optional(),
  scope: z.enum(CHECK_SCOPES).optional(),
});

export const utmPresetSchema = z.object({
  name: z.string().trim().min(1, "Name the preset").max(40),
  template: z.string().trim().min(1).max(512),
});

export const settingsSchema = z.object({
  defaultUtm: z.string().trim().min(1).max(512),
});

const hexColor = z.string().regex(HEX_COLOR_RE, "Use a color such as #6554c0");

/** The not-found page (its image is uploaded separately). */
export const purgeDomainSchema = z
  .object({
    domain: z.string().trim().toLowerCase().regex(HOSTNAME_RE, "Enter a domain such as links.example.com"),
    /** The domain typed again: deleting a domain's data can't be undone. */
    confirm: z.string().trim().toLowerCase(),
  })
  .refine((v) => v.confirm === v.domain, { message: "Type the domain name to confirm", path: ["confirm"] });

export const notFoundSchema = z.object({
  heading: z.string().trim().min(1, "Add a heading").max(120),
  message: z.string().trim().max(600),
  buttonLabel: z.string().trim().max(60),
  buttonUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "Use a full https:// address" }).max(2048)]),
  background: hexColor,
  card: hexColor,
  text: hexColor,
  accent: hexColor,
});

/** The "no longer working" page's wording and where it sends visitors without a replacement. */
export const deadLinkSchema = z.object({
  replacedHeading: z.string().trim().min(1, "Add a heading").max(120),
  replacedMessage: z.string().trim().max(600),
  replacedButton: z.string().trim().min(1, "Add a button label").max(60),
  goneHeading: z.string().trim().min(1, "Add a heading").max(120),
  goneMessage: z.string().trim().max(600),
  goneButton: z.string().trim().max(60),
  redirectUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "Use a full https:// address" }).max(2048)]),
  delaySeconds: z.number().int().min(DEAD_LINK_MIN_DELAY).max(DEAD_LINK_MAX_DELAY),
});

export function normalizeTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of input) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
    if (tag && !tag.includes(",")) seen.add(tag);
  }
  return [...seen].slice(0, 20);
}

export type ImportRowInput = z.input<typeof importRowSchema>;

/** Off and webhook send nothing from an address, so only they may leave the sender empty. */
export const SENDERLESS_PROVIDERS: readonly string[] = ["off", "webhook"];

export const mailSettingsSchema = z
  .object({
    provider: z.enum(DIGEST_PROVIDERS),
    from: z.union([z.literal(""), z.email("Enter the sender address, such as digest@example.com").max(254)]),
    mailgunDomain: z.union([z.literal(""), z.string().trim().toLowerCase().regex(HOSTNAME_RE, "Enter your Mailgun sending domain")]).optional(),
    mailgunRegion: z.enum(["us", "eu"]).optional(),
  })
  .refine((s) => s.from !== "" || SENDERLESS_PROVIDERS.includes(s.provider), { path: ["from"], message: "Enter the sender address, such as digest@example.com" });
export type MailSettings = z.infer<typeof mailSettingsSchema>;

/** An email as Access reports it: trimmed and lowercased. */
const email = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter an email address"));
const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

export const personSchema = z.object({
  email,
  name: z.string().trim().max(80).default(""),
  role: z.enum(ROLES),
  permissions: permissionList.default([]),
  /** Also email the invite link to them (when email can reach people). */
  sendEmail: z.boolean().default(false),
});

export const reinviteSchema = z.object({ sendEmail: z.boolean().default(false) });

export const personUpdateSchema = z.object({
  name: z.string().trim().max(80).optional(),
  role: z.enum(ROLES).optional(),
  permissions: permissionList.optional(),
});

export const personParamSchema = z.object({ email });

/** Pause someone's access: until a time, or (null) until someone resumes them. */
export const pauseSchema = z.object({ until: z.number().int().positive().nullable() });

/** A Turnstile site key, as the Cloudflare dashboard shows it (0x4AAAA…). */
export const turnstileSchema = z.object({
  siteKey: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z_-]{10,100}$/, "Paste the site key from your Turnstile widget"),
});

export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

export const apiKeySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the key a name, such as the tool that uses it")
    .max(40)
    .regex(/^[^\p{Cc}]+$/u, "Use letters, numbers and punctuation only"),
  permissions: permissionList.default([]),
  /** Days until it stops working; null = never. */
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).default(null),
});

export const apiKeyParamSchema = z.object({ id: z.string().regex(/^[a-z0-9]{8}$/) });
export const apiKeyListSchema = z.object({ all: z.enum(["1"]).optional() });

export const passwordChangeSchema = z.object({
  current: z.string().min(1, "Enter your current password").max(1024),
  next: z.string().min(12, "Use at least 12 characters").max(1024),
});

/** Link page → Share: a new read-only statistics page. */
export const createShareSchema = z.object({
  /** Unix seconds; null or absent keeps it until revoked. */
  expiresAt: z.number().int().positive().nullish(),
  password: z.string().min(LINK_PASSWORD_MIN).max(LINK_PASSWORD_MAX).nullish(),
  rangeLimit: z.enum(SHARE_RANGES).nullish(),
  showRecent: z.boolean().optional(),
});

export const updateShareSchema = z.object({
  expiresAt: z.number().int().positive().nullable().optional(),
  /** A new password; null removes it. Either way, everyone who opened it must enter the new one. */
  password: z.string().min(LINK_PASSWORD_MIN).max(LINK_PASSWORD_MAX).nullable().optional(),
  rangeLimit: z.enum(SHARE_RANGES).nullable().optional(),
  showRecent: z.boolean().optional(),
  /** Ends the share for good. */
  revoke: z.literal(true).optional(),
});

export const shareParamSchema = z.object({ id: z.string().regex(/^[a-z0-9]{8}$/) });

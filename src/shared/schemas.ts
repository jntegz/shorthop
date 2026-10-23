import { z } from "zod";
import { isDay } from "./dates";
import { DEAD_LINK_MAX_DELAY, DEAD_LINK_MIN_DELAY } from "./dead-link";
import { HOSTNAME_RE } from "./domains";
import { HEX_COLOR_RE } from "./not-found";
import { ROUTE_DEVICES } from "./routing";
import { IMPORT_SLUG_RE } from "./slug";
import { DIGEST_PROVIDERS, LIST_PERIODS, MISS_RETENTION_DAYS, NOISE_LIMITS, RANGES, REAL_MISS_LIMITS } from "./types";

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
    /** Check the destination on a schedule (default true). */
    monitor: z.boolean().optional(),
    routing: routingSchema.optional(),
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
  monitor: z.boolean().optional(),
  routing: routingSchema.optional(),
  broken: z.boolean().optional(),
  /** The link visitors are pointed to while this one is marked broken; null for none. */
  replacement: z.object({ domain: z.string().regex(HOSTNAME_RE), slug: z.string().regex(IMPORT_SLUG_RE) }).nullish(),
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
  status: z.enum(["all", "active", "disabled", "expired", "broken", "failing"]).default("all"),
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

export const checkSettingsSchema = z.object({
  enabled: z.boolean(),
  notify: z.boolean(),
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

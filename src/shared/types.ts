// Response shapes of the admin API, shared by the Worker and the SPA.

import type { HistoryAction, StoredSnapshot } from "./history";
import type { CheckProblem, CheckState } from "./link-check";
import type { LinkPreview } from "./preview";
import type { QrStyle } from "./qr";
import type { Routing } from "./routing";

export type LinkSource = "native" | "import";

export interface LinkDTO {
  /** The short domain the link lives on; slugs are unique per domain. */
  domain: string;
  slug: string;
  shortUrl: string;
  target: string;
  active: boolean;
  /** Unix seconds, or null for never. */
  expiresAt: number | null;
  utm: boolean;
  /** Per-link template; null means the default template applies. */
  utmTemplate: string | null;
  passQuery: boolean;
  title: string | null;
  tags: string[];
  notes: string;
  source: LinkSource;
  importedClicks: number | null;
  /** Marked "no longer working": visitors see a notice instead of the target. */
  broken: boolean;
  /** The link that notice points to; null sends visitors to the site set in Settings. */
  replacement: { domain: string; slug: string } | null;
  /** Whether the destination is checked on a schedule (Link health). */
  monitor: boolean;
  /** Smart routing; null sends everyone to the target. */
  routing: Routing | null;
  /** What link-preview crawlers see; null lets them follow the redirect. */
  preview: LinkPreview | null;
  /** This link's QR code design; null uses the default. */
  qr: QrStyle | null;
  /** Visitors must enter a password (never returned itself). */
  protected: boolean;
  /** Most human clicks allowed; null for no limit. */
  maxClicks: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Periods the links list can count recent clicks over. */
export const LIST_PERIODS = ["7d", "14d", "30d", "90d", "180d", "365d", "all"] as const;
export type ListPeriod = (typeof LIST_PERIODS)[number];

export interface LinkListItem extends LinkDTO {
  /** Human clicks in the requested period (rollups plus today). */
  clicksPeriod: number;
  /** All-time human clicks tracked here (the previous shortener's are in importedClicks). */
  clicksTotal: number;
  /** The destination's last check; null when it was never checked. */
  check: { state: CheckState; problem: CheckProblem | null; httpStatus: number | null; checkedAt: number } | null;
}

/** Link health → destination checks. */
export interface CheckSettings {
  /** Check destinations on a schedule. */
  enabled: boolean;
  /** Email when a destination stops (or starts) working. */
  notify: boolean;
}

/** One destination and the live links that point to it. */
export interface TargetCheckDTO {
  target: string;
  state: CheckState;
  httpStatus: number | null;
  problem: CheckProblem | null;
  /** Where redirects ended, when not at the target itself. */
  finalUrl: string | null;
  hops: number;
  ms: number | null;
  /** Failed checks in a row. */
  fails: number;
  /** Unix seconds; null until the first check. */
  checkedAt: number | null;
  lastOkAt: number | null;
  /** When the state last changed. */
  since: number | null;
  nextAt: number | null;
  links: { domain: string; slug: string; title: string | null }[];
}

export interface LinkChecksDTO {
  settings: CheckSettings;
  items: TargetCheckDTO[];
  /** Live links with checks turned off. */
  excluded: number;
  /** Destinations waiting more than an hour past due, or never checked. */
  overdue: number;
  /** Most destinations the schedule can check in a day. */
  capacityPerDay: number;
  lastRun: JobRun | null;
}

export interface UtmPresetDTO {
  id: number;
  name: string;
  template: string;
  /** Links whose custom template is exactly this preset's. */
  links: number;
  updatedAt: number;
}

/** One saved state of a link (Link page → History). */
export interface VersionDTO {
  id: number;
  /** Unix seconds. */
  at: number;
  action: HistoryAction;
  /** Access email, "api-token" or "system". */
  actor: string;
  /** The link after the change (before it, for a delete). */
  snapshot: StoredSnapshot;
  /** For a restore: the version it copied. */
  restoredFrom: number | null;
}

/** A capped link's counter (Link page → Protection). */
export interface CapDTO {
  limit: number | null;
  count: number;
}

export interface DeletedLinkDTO {
  /** The delete's version id. */
  versionId: number;
  domain: string;
  slug: string;
  deletedAt: number;
  actor: string;
  target: string;
  title: string | null;
}

export interface WebhookDTO {
  id: number;
  url: string;
  description: string;
  events: string[];
  active: boolean;
  createdAt: number;
  /** False after SESSION_SECRET changed: rotate the secret. */
  secretReadable: boolean;
  /** Deliveries waiting for a retry. */
  retrying: number;
  /** Deliveries given up on in the last 7 days. */
  failedRecent: number;
  last: { ok: boolean; httpStatus: number | null; at: number; error: string | null } | null;
}

export interface WebhookDeliveryDTO {
  id: string;
  eventId: string;
  type: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  /** Pending: when the next attempt is due. */
  nextAt: number | null;
  httpStatus: number | null;
  error: string | null;
  lastAt: number | null;
  durationMs: number | null;
  createdAt: number;
  /** The JSON body, exactly as signed. */
  payload: string;
}

export interface CheckRunDTO {
  checked: number;
  remaining: number;
}

export interface ImportRowResult {
  domain: string;
  slug: string;
  status: "created" | "updated" | "skipped" | "error";
  message?: string;
}

export interface ImportResult {
  dryRun: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: ImportRowResult[];
}

/** "custom" takes explicit from/to dates (see Period). */
export const RANGES = ["today", "7d", "14d", "30d", "90d", "180d", "270d", "365d", "all", "custom"] as const;
export type Range = (typeof RANGES)[number];

/** A stats period: a named range, or "custom" with inclusive UTC dates (YYYY-MM-DD). */
export interface Period {
  range: Range;
  from?: string;
  to?: string;
}

/** Breakdown dimensions shown on stats pages. */
export const DIMS = [
  "country",
  "device",
  "source",
  "city",
  "region",
  "os",
  "browser",
  "referrer",
  "language",
  "bot",
  "route",
] as const;
export type Dim = (typeof DIMS)[number];

export interface Totals {
  clicks: number;
  /** Sum of daily unique visitors (the visitor hash rotates daily). */
  uniques: number;
  bots: number;
}

export interface SeriesPoint extends Totals {
  date: string;
}

export interface BreakdownRow {
  value: string;
  clicks: number;
  bots: number;
}

/**
 * The period before, of equal length, compared on completed days only (today
 * is still in progress). Null for "today" and "all time".
 */
export interface ComparisonDTO {
  /** The completed days of the selected period that are compared. */
  current: Totals & { from: string; to: string };
  previous: Totals & { from: string; to: string };
  /** Daily totals of the previous period, oldest first, for the chart overlay. */
  series: SeriesPoint[];
}

export interface LinkStatsDTO {
  domain: string;
  slug: string;
  range: Range;
  from: string;
  to: string;
  aeAvailable: boolean;
  totals: Totals;
  series: SeriesPoint[];
  dims: Record<Dim, BreakdownRow[]>;
  comparison: ComparisonDTO | null;
}

/** The account-wide stats page: the dashboard's summary plus every breakdown. */
export interface AccountStatsDTO extends OverviewDTO {
  dims: Record<Dim, BreakdownRow[]>;
}

export interface TopLink extends Totals {
  domain: string;
  slug: string;
  target: string | null;
}

export interface OverviewDTO {
  range: Range;
  from: string;
  to: string;
  aeAvailable: boolean;
  totals: Totals;
  series: SeriesPoint[];
  comparison: ComparisonDTO | null;
  topLinks: TopLink[];
  countries: BreakdownRow[];
  sources: BreakdownRow[];
  devices: BreakdownRow[];
}

/** A visitor missing this many different paths in one UTC day is a scanner, whatever its user agent says. */
export const SCANNER_PATHS_PER_DAY = 5;

/**
 * What kinds of misses are recorded. A miss is a scanner probe when its path
 * looks like one and no link matches it even apart from case; otherwise it's
 * bot-only when only bots asked for it, and human when a person did. A kind
 * that isn't tracked isn't even written to Analytics Engine.
 */
export interface MissPolicy {
  /** People mistyping or opening old links. On by default. */
  trackHumans: boolean;
  /** Paths like /.env or /wp-login.php. Off by default. */
  trackProbes: boolean;
  /** Other paths only bots asked for. Off by default. */
  trackBots: boolean;
  /** Most recent probe paths kept when tracked. */
  probeLimit: (typeof NOISE_LIMITS)[number];
  /** Most recent bot-only paths kept when tracked. */
  botLimit: (typeof NOISE_LIMITS)[number];
  /** Days misses are kept. */
  retentionDays: (typeof MISS_RETENTION_DAYS)[number];
  /** Most recent human missed paths kept; 0 means no limit. */
  realLimit: (typeof REAL_MISS_LIMITS)[number];
}

export type MissKind = "human" | "probe" | "bot";
export const NOISE_LIMITS = [100, 250, 500] as const;
export const MISS_RETENTION_DAYS = [90, 180] as const;
export const REAL_MISS_LIMITS = [100, 250, 500, 1000, 0] as const;

export const DEFAULT_MISS_POLICY: MissPolicy = {
  trackHumans: true,
  trackProbes: false,
  trackBots: false,
  probeLimit: 100,
  botLimit: 100,
  retentionDays: 90,
  realLimit: 1000,
};

export interface MissRow {
  domain: string;
  slug: string;
  hits: number;
  bots: number;
  /** Last UTC day it was requested. */
  lastSeen: string;
  /** State of a link with exactly this slug, if one exists. */
  link: "none" | "active" | "disabled" | "expired";
  /** An existing slug that differs only in letter case. */
  suggestion: string | null;
  /** Looks like a vulnerability scanner request (".env", ".php", "wp-…"), not a mistyped link. */
  probe: boolean;
}

export interface RecentHit {
  time: string;
  domain: string;
  slug: string;
  event: "click" | "bot" | "miss";
  country: string;
  city: string;
  device: string;
  os: string;
  browser: string;
  referrer: string;
  source: string;
  botName: string;
  /** Misses only: the visitor missed SCANNER_PATHS_PER_DAY or more paths in a day, so the report counts it as a bot. */
  scanner?: boolean;
}

export interface DomainRecord {
  type: "A" | "AAAA" | "CNAME";
  value: string;
}

/** Live setup state of a short domain (Settings → Short domains → Check setup). */
export interface DomainCheckDTO {
  domain: string;
  /** Listed in SHORT_DOMAINS. */
  configured: boolean;
  /** False when DNS says the name doesn't exist (not registered, or a typo). */
  exists: boolean;
  /** The name whose nameservers were found (the domain itself or its parent). */
  zone: string | null;
  nameservers: string[];
  /** Every nameserver is *.ns.cloudflare.com. */
  onCloudflare: boolean;
  /** A, AAAA and CNAME records on the name itself. */
  records: DomainRecord[];
  /** Whether https://<domain>/health is answered by this Worker. */
  serving: "yes" | "no";
  servingDetail: string;
  error: string | null;
  checkedAt: number;
}

export interface SecurityDTO {
  /** The Access identity of this session ("admin" without Access, "api-token" for the Bearer API). */
  email: string;
  /** ADMIN_AUTH: Cloudflare Access plus the password, or the password alone. */
  mode: "access+password" | "password";
  /** ACCESS_TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAIL are all set. */
  accessConfigured: boolean;
  /** False only on localhost without ADMIN_PASSWORD_HASH. */
  passwordConfigured: boolean;
  /** Unix seconds; null without a password session. */
  sessionExpiresAt: number | null;
  failedLogins24h: number;
  lockedNetworks: number;
  /** Unix seconds while every login is paused, otherwise null. */
  globalLockedUntil: number | null;
  /** Newest first. */
  recent: { at: number; ok: boolean; country: string }[];
}

/** Email delivery services. Picked in Settings → Weekly digest, or DIGEST_PROVIDER in wrangler.jsonc. */
export const DIGEST_PROVIDERS = ["cloudflare", "resend", "emailit", "postmark", "sendgrid", "mailgun", "custom", "webhook", "off"] as const;
export type DigestProvider = (typeof DIGEST_PROVIDERS)[number];

export interface MailProviderDTO {
  id: DigestProvider;
  name: string;
  /** Why it can't send, or null when it could be used right now. */
  problem: string | null;
  /** Wrangler secrets it reads, and whether each is set (never their values). */
  secrets: { name: string; set: boolean }[];
}

export interface MailSetupDTO {
  provider: string;
  from: string;
  /** Config-only (DIGEST_TO). */
  to: string;
  mailgunDomain: string;
  mailgunRegion: "us" | "eu";
  /** True when the admin's choice overrides wrangler.jsonc. */
  customized: boolean;
  /** What wrangler.jsonc says, used after a reset. */
  defaults: { provider: string; from: string };
  providers: MailProviderDTO[];
}

export interface SettingsDTO {
  defaultUtm: string;
  /** The first UTC day with stats or links: the earliest a custom period can start. */
  statsSince: string | null;
  publicOrigin: string;
  aeAvailable: boolean;
  lastRolled: string | null;
  /** Finished days the next rollup would summarize; null when up to date. */
  rollupPending: { from: string; to: string; days: number } | null;
  lastDigestWeek: string | null;
  /** Null for the API token, which doesn't see the recipient. */
  digestTo: string | null;
  /** Display name of the delivery provider (DIGEST_PROVIDER). */
  digestProvider: string;
  /** Why the digest can't be sent, or null when it's ready. */
  digestProblem: string | null;
  /** Short domains, primary first. */
  domains: string[];
  primaryDomain: string;
  /** Where the admin and the API are served (ADMIN_HOST or the primary domain). */
  adminHost: string;
  /** Links per domain, including domains no longer in SHORT_DOMAINS. */
  linksPerDomain: Record<string, number>;
  /** Sample data from `npm run seed:dev`, or null. */
  demo: DemoDTO | null;
  /** Null for the API token, which doesn't see login activity. */
  security: SecurityDTO | null;
}

export interface DemoDTO {
  domain: string;
  links: number;
}

export interface PurgeDomainDTO {
  domain: string;
  /** Links removed by this call. */
  deleted: number;
  /** False while links are left: call again. */
  done: boolean;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

export type HealthStatus = "ok" | "warn" | "error";

/** One line of Dashboard → System status. */
export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  /** A command that fixes it, e.g. "npm run setup -- email". */
  fix?: string;
  /** Where the manual explains it, e.g. "docs/SETUP.md#email". */
  docs?: string;
  /** A warning about a deliberate setup choice: shown here, never emailed. */
  advisory?: boolean;
}

/** The outcome of a scheduled job, as last recorded. */
export interface JobRun {
  ok: boolean;
  /** Unix seconds. */
  at: number;
  error?: string;
}

export interface SystemHealthDTO {
  checks: HealthCheck[];
  /** Worst status across the checks that aren't advisory. */
  status: HealthStatus;
  checkedAt: number;
  /** Where alerts go, or null when email can't be sent. */
  alertsTo: string | null;
  lastAlert: JobRun | null;
}

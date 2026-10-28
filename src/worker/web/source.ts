// Where a website visit came from: a source name and a channel, decided once
// per session from its landing URL and referrer.
//
// Precedence: a short-link click token, then click IDs from ad platforms, then
// UTM tags (and ?ref=), then the referrer, then Direct. Direct visits are told
// apart by their source: an app's in-app browser, a return from checkout, a
// deep link opened with no referrer, or a typed address / bookmark.

import type { Channel } from "../../shared/sites";
import type { ClickToken } from "./token";

interface KnownSource {
  name: string;
  channel: Channel;
  /** Matches a referrer host, or a utm_source / ref value. */
  re: RegExp;
}

const KNOWN: KnownSource[] = [
  // AI assistants first: some live on search domains (Gemini, Copilot).
  { name: "ChatGPT", channel: "AI", re: /(^|\.)chatgpt\.com$|(^|\.)openai\.com$|^chatgpt$|^openai$/ },
  { name: "Claude", channel: "AI", re: /(^|\.)claude\.ai$|^claude$/ },
  { name: "Perplexity", channel: "AI", re: /(^|\.)perplexity\.ai$|^perplexity$/ },
  { name: "Gemini", channel: "AI", re: /^gemini\.google\.com$|^gemini$/ },
  { name: "Copilot", channel: "AI", re: /^copilot\.microsoft\.com$|^copilot$/ },
  { name: "DeepSeek", channel: "AI", re: /(^|\.)deepseek\.com$|^deepseek$/ },
  { name: "Grok", channel: "AI", re: /(^|\.)grok\.com$|^grok$/ },
  { name: "Mistral", channel: "AI", re: /^chat\.mistral\.ai$/ },
  { name: "Google", channel: "Organic Search", re: /(^|\.)google\.[a-z.]+$|^google$/ },
  { name: "Bing", channel: "Organic Search", re: /(^|\.)bing\.com$|^bing$/ },
  { name: "DuckDuckGo", channel: "Organic Search", re: /(^|\.)duckduckgo\.com$|^ddg$|^duckduckgo$/ },
  { name: "Yahoo", channel: "Organic Search", re: /(^|\.)search\.yahoo\.com$|^yahoo$/ },
  { name: "Yandex", channel: "Organic Search", re: /(^|\.)yandex\.[a-z.]+$|^yandex$/ },
  { name: "Baidu", channel: "Organic Search", re: /(^|\.)baidu\.com$|^baidu$/ },
  { name: "Ecosia", channel: "Organic Search", re: /(^|\.)ecosia\.org$|^ecosia$/ },
  { name: "Brave Search", channel: "Organic Search", re: /^search\.brave\.com$/ },
  { name: "Kagi", channel: "Organic Search", re: /(^|\.)kagi\.com$/ },
  { name: "Seznam", channel: "Organic Search", re: /(^|\.)seznam\.cz$|^seznam$/ },
  { name: "LinkedIn", channel: "Organic Social", re: /(^|\.)linkedin\.com$|^lnkd\.in$|^linkedin$|^li$/ },
  { name: "X", channel: "Organic Social", re: /^t\.co$|(^|\.)x\.com$|(^|\.)twitter\.com$|^x$|^twitter$/ },
  { name: "Facebook", channel: "Organic Social", re: /(^|\.)facebook\.com$|^fb\.me$|^l\.messenger\.com$|^facebook$|^fb$/ },
  { name: "Instagram", channel: "Organic Social", re: /(^|\.)instagram\.com$|^instagram$|^ig$/ },
  { name: "Threads", channel: "Organic Social", re: /(^|\.)threads\.(net|com)$|^threads$/ },
  { name: "Bluesky", channel: "Organic Social", re: /(^|\.)bsky\.app$|^bluesky$|^bsky$/ },
  { name: "Mastodon", channel: "Organic Social", re: /(^|\.)mastodon\.[a-z.]+$|^mastodon$/ },
  { name: "YouTube", channel: "Organic Social", re: /(^|\.)youtube\.com$|^youtu\.be$|^youtube$|^yt$/ },
  { name: "TikTok", channel: "Organic Social", re: /(^|\.)tiktok\.com$|^tiktok$/ },
  { name: "Pinterest", channel: "Organic Social", re: /(^|\.)pinterest\.[a-z.]+$|^pinterest$/ },
  { name: "Reddit", channel: "Organic Social", re: /(^|\.)reddit\.com$|^reddit$/ },
  { name: "Hacker News", channel: "Organic Social", re: /^news\.ycombinator\.com$|^hn$|^hackernews$/ },
  { name: "Product Hunt", channel: "Referral", re: /(^|\.)producthunt\.com$|^producthunt$/ },
  { name: "GitHub", channel: "Referral", re: /(^|\.)github\.com$|^github$/ },
  { name: "Medium", channel: "Referral", re: /(^|\.)medium\.com$|^medium$/ },
  { name: "Substack", channel: "Referral", re: /(^|\.)substack\.com$|^substack$/ },
  { name: "Dev.to", channel: "Referral", re: /^dev\.to$/ },
  { name: "Indie Hackers", channel: "Referral", re: /(^|\.)indiehackers\.com$/ },
  { name: "Gmail", channel: "Email", re: /^mail\.google\.com$|^gmail$/ },
  { name: "Outlook", channel: "Email", re: /^outlook\.(live|office|office365)\.com$/ },
  { name: "Newsletter", channel: "Email", re: /^newsletter$|^email$|^e-?mail$/ },
];

/** Click IDs that ad platforms add to the landing URL. */
const CLICK_IDS: ReadonlyArray<readonly [string, string]> = [
  ["gclid", "Google Ads"],
  ["gbraid", "Google Ads"],
  ["wbraid", "Google Ads"],
  ["msclkid", "Microsoft Ads"],
  ["fbclid", "Facebook"],
  ["ttclid", "TikTok Ads"],
  ["li_fat_id", "LinkedIn Ads"],
  ["twclid", "X Ads"],
];

const PAID_MEDIUM = /^(cpc|ppc|cpm|cpv|cpa|paid|paidsocial|paid[-_ ]social|paid[-_ ]search|display|banner|ads?|retargeting|affiliate)$/i;
const EMAIL_MEDIUM = /^(e-?mail|newsletter|mail)$/i;
const SOCIAL_MEDIUM = /^(social|social[-_ ]media|sm|social[-_ ]network|organic[-_ ]social)$/i;
const SEARCH_MEDIUM = /^(organic|seo)$/i;

/** Source codes of the click path (src/worker/analytics.ts resolveSource) that aren't site names. */
const LINK_SOURCES: Record<string, string> = { direct: "", referral: "", site: "", qr: "QR code", nl: "Newsletter", email: "Email" };

function known(value: string): KnownSource | undefined {
  const v = value.toLowerCase();
  return KNOWN.find((k) => k.re.test(v));
}

/** In-app browsers, by the marker their user agent carries. Order matters: Threads and Instagram share Meta's markers. */
const IN_APP: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBarcelona\b/, "Threads"],
  [/\bInstagram\b/, "Instagram"],
  [/FBAN|FBAV|FB_IAB|FBIOS|\bFB4A\b/, "Facebook"],
  [/musical_ly|\bTikTok\b|BytedanceWebview|\btrill_/, "TikTok"],
  [/LinkedInApp/, "LinkedIn"],
  [/Twitter(Android)?\b|\bTwitter for/, "X"],
  [/\bReddit\b/i, "Reddit"],
  [/\bTelegram\b/i, "Telegram"],
  [/\bSnapchat\b/, "Snapchat"],
  [/\bPinterest\b/, "Pinterest"],
  [/\bWhatsApp\b/, "WhatsApp"],
  [/\bLine\//, "LINE"],
  [/\bGSA\//, "Google app"],
];

/** The app whose in-app browser sent this user agent, or "". */
export function inAppBrowser(ua: string): string {
  for (const [re, name] of IN_APP) if (re.test(ua)) return name;
  return "";
}

/** Payment pages a buyer comes back from: a referrer, not a source. */
const CHECKOUT_HOST = /(^|\.)(stripe\.com|paypal\.com|lemonsqueezy\.com|polar\.sh|creem\.io|paddle\.com|gumroad\.com|dodopayments\.com|fastspring\.com|onfastspring\.com)$/;

export function isCheckoutHost(host: string): boolean {
  return CHECKOUT_HOST.test(host);
}

/** Labels of Direct visits (the source column). */
export const DIRECT_SOURCES = {
  checkout: "Checkout return",
  shared: "Shared link",
  typed: "Typed / bookmark",
  inApp: (app: string) => `${app} (in-app)`,
} as const;

/** What the collector knows about a visit with nothing else to name it by. */
export interface DirectHints {
  /** The app whose in-app browser opened the page. */
  inApp?: string;
  /** The landing page is a return page after checkout. */
  checkoutReturn?: boolean;
}

export interface Attribution {
  source: string;
  channel: Channel;
  utm: { source: string; medium: string; campaign: string; term: string; content: string };
  link: { domain: string; slug: string } | null;
}

const cap = (s: string | null, n = 200) => (s ?? "").trim().slice(0, n);

export function attributionOf(landing: URL | null, referrerHost: string, click: ClickToken | null, hints: DirectHints = {}): Attribution {
  const q = landing?.searchParams;
  const utm = {
    source: cap(q?.get("utm_source") ?? null, 100),
    medium: cap(q?.get("utm_medium") ?? null, 100),
    campaign: cap(q?.get("utm_campaign") ?? null),
    term: cap(q?.get("utm_term") ?? null),
    content: cap(q?.get("utm_content") ?? null),
  };
  const ref = cap(q?.get("ref") ?? q?.get("via") ?? null, 100);

  if (click) {
    // The link's own source tag (or where the click came from) names it.
    const fromLink = LINK_SOURCES[click.source] ?? (click.source ? known(click.source)?.name ?? click.source : "");
    return { source: fromLink || `${click.domain}/${click.slug}`, channel: "Short link", utm, link: { domain: click.domain, slug: click.slug } };
  }

  for (const [param, name] of CLICK_IDS) {
    if (q?.has(param) && (param !== "fbclid" || PAID_MEDIUM.test(utm.medium))) {
      return { source: utm.source ? known(utm.source)?.name ?? utm.source : name, channel: "Paid", utm, link: null };
    }
  }

  const tag = utm.source || ref;
  if (!tag && (hints.checkoutReturn || (referrerHost && isCheckoutHost(referrerHost)))) {
    return { source: DIRECT_SOURCES.checkout, channel: "Direct", utm, link: null };
  }
  const tagKnown = tag ? known(tag) : undefined;
  const refKnown = referrerHost ? known(referrerHost) : undefined;
  const source = tagKnown?.name ?? (tag || refKnown?.name || referrerHost || directSource(landing, hints));

  let channel: Channel;
  if (PAID_MEDIUM.test(utm.medium)) channel = "Paid";
  else if (EMAIL_MEDIUM.test(utm.medium)) channel = "Email";
  else if (tagKnown) channel = tagKnown.channel;
  else if (SOCIAL_MEDIUM.test(utm.medium)) channel = "Organic Social";
  else if (SEARCH_MEDIUM.test(utm.medium)) channel = "Organic Search";
  else if (tag) channel = refKnown?.channel ?? "Referral";
  else if (refKnown) channel = refKnown.channel;
  else if (referrerHost) channel = "Referral";
  else channel = "Direct";
  return { source, channel, utm, link: null };
}

function directSource(landing: URL | null, hints: DirectHints): string {
  if (hints.inApp) return DIRECT_SOURCES.inApp(hints.inApp);
  const path = landing?.pathname ?? "/";
  return path === "/" || path === "" || /^\/index\.html?$/.test(path) ? DIRECT_SOURCES.typed : DIRECT_SOURCES.shared;
}

/** True when a landing carries campaign information that should start a new session. */
export function hasCampaign(a: Attribution): boolean {
  return Boolean(a.link || a.utm.source || a.utm.campaign || a.channel === "Paid");
}

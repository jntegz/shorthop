// Explanations behind the (i) buttons. Keep them in step with the code they
// describe; numbers come from shared constants where one exists.

import * as L from "../../shared/login-policy";
import { BLOCKED_INTERVAL, CHECK_TIMEOUT_MS, DOWN_AFTER_FAILS, MAX_HOPS } from "../../shared/link-check";
import { SCANNER_PATHS_PER_DAY } from "../../shared/types";

export interface Help {
  title: string;
  body: string;
  example?: string;
}

const h = (title: string, body: string, example?: string): Help => ({ title, body, example });

/** 60 → "1 minute", 900 → "15 minutes", 43200 → "12 hours". */
function duration(sec: number): string {
  const [n, unit] = sec % 3600 === 0 ? [sec / 3600, "hour"] : [sec / 60, "minute"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export const LINK_HELP = {
  domain: h(
    "Domain",
    "Which short domain this link lives on. Each domain has its own slugs, so the same slug can lead somewhere different on each domain. The domain can't be changed later: create a new link instead.",
    "sh.example/guide and alt.example/guide are two separate links",
  ),
  target: h(
    "Destination URL",
    "Where visitors end up. It must start with https:// (links imported from another shortener may keep http://), can't contain a username or password, can't point back at one of your short domains, and can be up to 2,048 characters. Changes reach every Cloudflare location within about a minute.",
    "https://example.com/guide",
  ),
  slug: h(
    "Custom slug",
    "Your own text for the end of the short link, the part after the domain (sh.example/your-slug): 1–64 letters, digits, - or _, starting with a letter or digit. It's case-sensitive, so /Guide and /guide are different links. api, _admin, health, cdn-cgi, robots.txt and favicon.ico are reserved. Leave it empty for a random 6-character slug. A slug can't be renamed later.",
    "sh.example/job-search-guide",
  ),
  title: h("Title", "A private label for the link list and search. Visitors never see it. Up to 300 characters."),
  tags: h(
    "Tags",
    "Comma-separated labels for filtering the link list. They're saved in lowercase with spaces turned into hyphens, up to 40 characters each and 20 per link. Visitors never see them.",
    "LinkedIn, Job Search → linkedin, job-search",
  ),
  notes: h("Notes", "Private notes, for example where you posted the link. Visitors never see them; the link search includes them. Up to 5,000 characters."),
  expires: h(
    "Expires",
    "When the link stops working, in your browser's local time. After that, visitors see the “link not found” page and the visit shows under Link health as expired. The link and its stats stay; clear or change the date to bring it back. Leave empty to keep it forever.",
  ),
  active: h(
    "Active",
    "Turn off to pause the link without deleting it. Visitors then see the “link not found” page and the visit shows under Link health as disabled. Stats are kept. Turning it back on restores the redirect within about a minute.",
  ),
  broken: h(
    "Link no longer working",
    "For a link whose destination is gone or no longer works. The slug stays live, but instead of redirecting, visitors see a page saying the original link no longer works. If you pick a replacement link, the page points to it as the next best thing. Without one (or if the replacement is later deleted, disabled, expired or also marked as not working), the page sends visitors to the site set in Settings after a few seconds. The wording, the site and the delay are set under Settings → “Link no longer working” page. Visits still count for this link.",
  ),
  replacement: h(
    "Replacement link",
    "Another of your short links that visitors are pointed to instead. The button goes through the replacement's short link, so its clicks are counted there too. Only links that work right now are listed.",
  ),
  utm: h(
    "Add UTM parameters",
    "Adds UTM tags to the destination at the moment someone clicks, so analytics tools like Google Analytics can attribute the visit. The saved destination doesn't change. Tags already in the destination, or passed through from the short link, are never overwritten. Off by default for new links. Uses this link's template if set, otherwise the default from Settings.",
    "…/guide?utm_source=sh.example&utm_medium=shortlink&utm_campaign=guide",
  ),
  utmTemplate: h(
    "Custom UTM template",
    "Replaces the default template for this link only: key=value pairs joined by &, ASCII only, without spaces, ? or #, up to 512 characters. {slug} becomes the slug, {domain} the short domain. {source} becomes the ?s= tag, qr for QR scans, the in-app browser (li, fb, ig, x), the referrer or direct. {variant} becomes the smart-routing destination's name (or its rule's), or default. Leave empty to follow the default, including later changes to it.",
    "utm_source=linkedin&utm_campaign={slug}&utm_content={source}",
  ),
  routing: h(
    "Smart routing",
    "Send visitors to different destinations by device (iPhone & iPad, Android, desktop, other) and country, or split them between destinations for an A/B test. Rules are checked from the top and the first match wins; everyone no rule matches goes to the destination URL. Devices and countries are detected from the browser and Cloudflare's location data, so VPNs and unusual browsers can land elsewhere. iPads that ask for desktop sites count as desktop. Each visit is assigned on its own, with no cookie. Bots and link previews always get the destination URL. Changes go live within about a minute.",
    "iPhone → App Store, Android → Google Play, everyone else → the website",
  ),
  preview: h(
    "Social preview",
    "The title, description and image LinkedIn, Slack, X, Facebook, iMessage, WhatsApp, Discord and Telegram show when someone shares this short link. Their preview crawlers get a small page with these details; people who click are redirected as usual. Without one, the platforms show the destination's own preview. Platforms keep previews for days, so a change can take a while to appear unless you refresh it in their tools.",
  ),
  monitor: h(
    "Check the destination",
    `Off for new links until you switch it on. Once it's on and automatic checking is turned on under Link health, Shorthop visits the destination as often as chosen there and lists it under Link health. After ${DOWN_AFTER_FAILS} failed checks in a row it counts as not working and you get an email. Leave it off for pages that only work when signed in, or that you know block automated visitors.`,
  ),
  passQuery: h(
    "Pass query parameters through",
    "Forwards extra ?parameters from the short link to the destination, unchanged and in order. Two are kept by Shorthop for its stats and never forwarded: s (source tag) and q=1 (QR scan). When this is off, extra parameters are dropped. A parameter that's already in the destination is sent twice.",
    "sh.example/guide?ref=post → …/guide?ref=post",
  ),
} satisfies Record<string, Help>;

export const SETTINGS_HELP = {
  webhooks: h(
    "Webhooks",
    "Each event is a POST with a JSON body: id, type, created_at, api_version and data. Link events carry the link (never its password); updates also list the fields that changed. Requests are signed with X-Shorthop-Signature (HMAC-SHA256 of t.body with the webhook's secret), carry X-Shorthop-Event and X-Shorthop-Delivery, and must be answered with a 2xx within 10 seconds. Redirects aren't followed. A failed delivery is retried after 30 minutes, then 2, 6, 12 and 24 hours; changes you make are sent at once, while destination alerts, milestones and retries go out with the half-hourly checks. A delivery can arrive twice, so use X-Shorthop-Delivery to ignore repeats.",
  ),
  domains: h(
    "Short domains",
    "Every domain listed here serves its own short links: sh.example/guide and alt.example/guide can point to different places. The first (primary) domain is the default for new links, and it hosts this admin and the API unless ADMIN_HOST names a separate host. Domains are set in the Worker's configuration (SHORT_DOMAINS plus one route per domain), so adding one takes a deploy; each must be a domain in the same Cloudflare account.",
    "SHORT_DOMAINS = sh.example,alt.example",
  ),
  cloudflare: h(
    "Cloudflare foundation",
    "The Cloudflare services this app runs on and what their plans include. It's a static guide, not live usage: check Workers requests and CPU, KV writes and D1 rows in the Cloudflare dashboard.",
  ),
  defaultUtm: h(
    "UTM parameters",
    "The default template is used by every link that has UTM turned on and no template of its own. Saving it republishes those links, at one KV write each (the Free plan allows 1,000 writes a day). Links with UTM off, such as imported links, aren't touched. Presets are saved templates you can apply to a link in one click; the link gets a copy, so editing or deleting a preset never changes links. Placeholders: {slug}, {source} (the ?s= tag, qr, the app or referrer), {domain} (the short domain) and {variant} (the smart-routing destination's name). Parameters the destination already has are never overwritten.",
    "utm_source={domain}&utm_medium=shortlink&utm_campaign={slug}",
  ),
  publishing: h(
    "Publishing",
    "Copies every link from the database (the source of truth) to the edge store that redirects read from. You don't need it in normal use: every save publishes on its own. Use it when a save said “not published”, after restoring the database, or after adding a domain. Costs one KV write per link (Free plan: 1,000 a day). Changes reach every location within about a minute.",
  ),
  statistics: h(
    "Statistics",
    "Every click is recorded in Analytics Engine, which keeps raw events for about 90 days. Each night at 01:15 UTC, finished days are summarized into the database and kept for good. “Run rollup now” fills any gaps and is safe to repeat. Today's live numbers need CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN. All dates are UTC.",
  ),
  digest: h(
    "Weekly digest",
    "An email every Monday at 07:00 UTC about the previous seven full UTC days: totals, top links, countries, sources, new links and missing slugs. Alerts from System status use the same service. “Set up email” picks it: Cloudflare Email Service (default), Resend, Emailit, Postmark, SendGrid, Mailgun, any other JSON email API, a signed webhook (n8n, Zapier, your own relay), or off, with steps for each. API keys are Wrangler secrets and never shown here. It goes only to DIGEST_TO, which can't be changed from here. “Send test” sends it now without counting as this week's email.",
  ),
  exports: h(
    "Exports",
    "Links CSV: every link with all its settings. Daily stats CSV: human clicks, daily unique visitors and bots per link and day, from the saved daily summaries, so today isn't included. Daily uniques add up per day, so a visitor who returns on three days counts three times. Cells starting with =, +, - or @ get a leading ' so spreadsheets don't run them as formulas.",
  ),
  api: h(
    "API and iOS Shortcut",
    "Scripts, tools and the Shortcut use the API with a key, not your browser session. Create a personal key under API keys: it's shown once, can only do what you allow (and never more than you can), and stops working when it's revoked, when it expires or when you lose access. An older API_TOKEN secret also works: by default it can read and create links but not change or delete them (API_TOKEN_SCOPE=\"full\" in wrangler.jsonc allows that). After 10 wrong keys in a minute, a network is refused for a while. Add ?format=text to get only the short URL, and \"domain\" in the JSON body to use another short domain.",
  ),
  apiKeys: h(
    "Personal API keys",
    "Each key acts as you, limited to the permissions you tick. If an admin later takes a permission away from you, your keys lose it too, and without “Personal API keys” they stop working. Keys can't add people, create other keys or log anyone out. Only a fingerprint is stored, so a lost key can't be shown again: revoke it and create a new one. “Last used” updates at most once an hour.",
  ),
  people: h(
    "People and roles",
    "Owners are set in ADMIN_EMAIL (wrangler.jsonc) and can do everything; they can't be changed here. Admins can do everything too, including adding admins. Managers add, change and remove users, and can only give permissions they have themselves. Users view and copy links, plus what's ticked for them. Changes apply on their next click. Removing someone ends their sessions and API keys at once, but also take them out of your Cloudflare Access policy. People are told apart by their Access email, so with ADMIN_AUTH set to \"password\" there are only owners.",
  ),
  security: h(
    "Security",
    `With Cloudflare Access on (the default), two locks protect the admin: Access checks who you are, and a password confirms it's you (owners use the admin password, everyone else their own). With ADMIN_AUTH set to "password", only the admin password does, so keep it long; everyone who signs in is then the owner. A login lasts ${duration(L.SESSION_TTL_SEC)} and, with Access, only works with the same Access account. Logging out ends that session; “Log out everyone” ends every session of every person at once, including this one. After ${L.MAX_FAILS} wrong passwords within ${duration(L.WINDOW_SEC)}, a network is locked for ${duration(L.LOCK_BASE_SEC)}, doubling with each lockout up to ${duration(L.LOCK_MAX_SEC)}. ${L.GLOBAL_MAX_FAILS} failures in an hour from ${L.GLOBAL_MIN_NETWORKS} or more networks pause all logins for ${duration(L.GLOBAL_LOCK_SEC)}. IP addresses are never stored, only a keyed hash.`,
  ),
} satisfies Record<string, Help>;

export const MISSES_HELP = {
  live: h(
    "Latest misses, as recorded",
    `Every miss on your short domains from the last 7 days, newest first, with how the report counts it. The table above lists human visits only, so a visit can be recorded and still not show there. It counts as a bot when: one visitor (same network and browser) misses ${SCANNER_PATHS_PER_DAY} or more different paths in one UTC day (the scanner rule, easy to trip when you test several typos yourself); the visit came from a VPN or hosting network; or the user agent is a bot or a tool such as curl. A browser loading the address while you type it counts as you. Each kind of miss is only recorded while it's tracked (Tracking settings): human misses by default, scanner probes and bot-only misses when you turn them on. Bot misses show in the table with “Hide bot-only misses” unticked. The admin host itself records nothing. New visits take about a minute to appear.`,
  ),
} satisfies Record<string, Help>;

export const IMPORT_HELP = {
  format: h(
    "File format",
    "A CSV (comma, semicolon or tab separated) with a header row, or JSON. Slugs can use letters, digits and . _ ~ -, start with a letter or digit, and be up to 96 characters; case matters. A slug that already exists is skipped, or with “Overwrite destination” gets the new destination (and the title and clicks, when the file has them) while its other settings stay. New links are active, never expire, and have UTM and query pass-through off. Each imported link costs one KV write (the Free plan allows 1,000 a day). Rows are sent 100 at a time; run “Check (dry run)” first to see every issue without saving.",
    "guide,https://example.com/guide,Job search guide",
  ),
} satisfies Record<string, Help>;

export const PROBE_HELP = h(
  "Scanner probe",
  "Automated scanners request paths like /.env, /wp-login.php or /config.json on every site, looking for leaked secrets or vulnerable software. They get the not-found page; nothing is exposed.",
);
export const STATS_HELP = {
  live: h(
    "When new clicks appear",
    "Every click is recorded the moment it's redirected, but Cloudflare Analytics Engine makes new data searchable in batches, usually within a minute or two and occasionally later. While the period includes today, this page refreshes every minute as long as you're using it (it pauses after 10 minutes without a click or keypress, because the Free plan allows 10,000 Analytics Engine queries a day). Refresh checks right away. Completed days come from the daily rollup and don't change.",
  ),
} satisfies Record<string, Help>;

export const CHECKS_HELP = {
  overview: h(
    "Destination checks",
    `Automatic checking is off until someone turns it on here (Activate automatic checking). Then every 30 minutes Shorthop checks the destinations that are due: a working one as often as chosen (once a day, every 3 days, once a week, or anything from 1 hour to 30 days), one with a problem again after 1 and then 4 hours. Check now works either way. It sends a HEAD request (then a GET if the server doesn't answer HEAD properly), follows up to ${MAX_HOPS} redirects, and waits up to ${CHECK_TIMEOUT_MS / 1000} seconds. Page contents are never downloaded or stored. Links that are disabled, expired, marked as no longer working, or have checks turned off are skipped. A destination shared by several links is checked once.`,
  ),
  states: h(
    "What each state means",
    `Working: the last check loaded the page (HTTP 2xx, after any redirects). Problem, confirming: it failed once or twice; one bad check can be a short outage, so it's rechecked sooner. Not working: ${DOWN_AFTER_FAILS} failures in a row, usually over about 5 hours; you get one email. Can't check: the site answered but refused an automated visitor (HTTP 401, 403, 429, LinkedIn's 999, or a Cloudflare challenge). People can usually still open it; it's rechecked every ${duration(BLOCKED_INTERVAL)} and never alerts.`,
  ),
  limits: h(
    "Limits that keep checks cheap and polite",
    `Checks run on a schedule, never on a visitor's click, so they can't slow down or block your links or the API. Each half-hourly run checks at most 25 destinations and makes at most 40 outbound requests (the Free plan allows 50 per run), about 900 routine checks a day with room left for rechecks. Links sharing a destination are checked once. At most 2 pages of one site are checked per run, so a site with hundreds of your links (LinkedIn, Amazon) isn't hammered and doesn't block the checker. With more destinations than the schedule can check as often as you chose, working ones are checked less often instead of falling behind: about daily at 900, about every 5 days at 4,500. Checks are free: outbound visits aren't billed, and the half-hourly cron runs anyway (for webhooks). They never count as clicks.`,
  ),
  email: h(
    "Email alerts",
    "One email when destinations become “not working”, listing every link that uses them, and one when they work again. Nothing is repeated while a destination stays down. Alerts use the same email setup as the weekly digest, and the digest lists destinations that are still down.",
  ),
} satisfies Record<string, Help>;

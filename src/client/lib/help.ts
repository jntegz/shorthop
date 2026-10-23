// Explanations behind the (i) buttons. Keep them in step with the code they
// describe; numbers come from shared constants where one exists.

import * as L from "../../shared/login-policy";
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
    "Replaces the default template for this link only: key=value pairs joined by &, ASCII only, without spaces, ? or #, up to 512 characters. {slug} becomes the slug, {domain} the short domain. {source} becomes the ?s= tag, qr for QR scans, the in-app browser (li, fb, ig, x), the referrer or direct. Leave empty to follow the default, including later changes to it.",
    "utm_source=linkedin&utm_campaign={slug}&utm_content={source}",
  ),
  passQuery: h(
    "Pass query parameters through",
    "Forwards extra ?parameters from the short link to the destination, unchanged and in order. Two are kept by Shorthop for its stats and never forwarded: s (source tag) and q=1 (QR scan). When this is off, extra parameters are dropped. A parameter that's already in the destination is sent twice.",
    "sh.example/guide?ref=post → …/guide?ref=post",
  ),
} satisfies Record<string, Help>;

export const SETTINGS_HELP = {
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
    "Default UTM template",
    "Used by every link that has UTM turned on and no custom template. Saving republishes those links, at one KV write each (the Free plan allows 1,000 writes a day). Links with UTM off, such as imported links, aren't touched.",
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
    "Scripts and the Shortcut use the API_TOKEN secret as a Bearer token, not this login. By default the token can read and create links but not change or delete them (API_TOKEN_SCOPE=\"full\" in wrangler.jsonc allows that). Keep it in your password manager and rotate it with npm run setup -- secrets --rotate (which also signs out every admin session). After 10 wrong tokens in a minute, an IP is refused for a while. Add ?format=text to get only the short URL, and \"domain\" in the JSON body to use another short domain.",
  ),
  security: h(
    "Security",
    `With Cloudflare Access on (the default), two locks protect the admin: Access checks who you are, and this password confirms it's you. With ADMIN_AUTH set to "password", only the password does, so keep it long. A login lasts ${duration(L.SESSION_TTL_SEC)} and, with Access, only works with the same Access account. “Log out everywhere” ends every session at once, including this one. After ${L.MAX_FAILS} wrong passwords within ${duration(L.WINDOW_SEC)}, a network is locked for ${duration(L.LOCK_BASE_SEC)}, doubling with each lockout up to ${duration(L.LOCK_MAX_SEC)}. ${L.GLOBAL_MAX_FAILS} failures in an hour from ${L.GLOBAL_MIN_NETWORKS} or more networks pause all logins for ${duration(L.GLOBAL_LOCK_SEC)}. IP addresses are never stored, only a keyed hash.`,
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

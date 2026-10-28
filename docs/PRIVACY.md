# Visitor privacy

What Shorthop records when someone opens one of your short links or visits a website you track with it, how long it's kept, and a starting point for your privacy notice. Under the GDPR and similar laws you, the operator, are responsible for telling visitors about it. This page isn't legal advice.

## What is recorded per visit

Each request to a short domain becomes one Analytics Engine data point, written after the redirect has been sent:

| Data | Where it comes from |
|---|---|
| Time, short domain and slug (or the missed path) | The request |
| Event: click, bot or miss | Shorthop's classification |
| Country, region, city, continent | Cloudflare's IP geolocation |
| Network operator (ASN and its name) and Cloudflare data center | Cloudflare |
| Device type, operating system, browser, preferred language | The `User-Agent`, client hints and `Accept-Language` headers |
| Referring website (host name only) and source tag (`?s=`) | The `Referer` header and the link |
| Bot name, for previews and crawlers | The `User-Agent` |
| Visitor hash | See below |

## What is not recorded

- **IP addresses.** They're used during the request (Cloudflare derives the location from them) and for the visitor hash, but never stored.
- **Cookies.** Visitors get none: a short link is a redirect. The one exception is a password-protected link: after the right password, a functional cookie for that link only (`sh_access`, scoped to the link's path) remembers it for 12 hours, so the visitor isn't asked again. It holds no personal data, only a signed expiry.
- **Full referrer URLs.** Only the host name is kept.

## How unique visitors are counted

A visitor hash is the first 16 hex characters of SHA-256 over the IP address, the user agent, the UTC date, the `VISITOR_SALT` secret (or, on an install without it, a random value generated once and kept in D1) and a random salt for that day. Every isolate shares the day's salt through D1. The daily job (01:15 UTC) deletes the salt of each day that has ended. After that, nobody, the owner included, can work out whose visit a hash was, even with a known IP address. Hashes change every day, so they can't follow a visitor across days.

## How long it is kept

| Data | Kept |
|---|---|
| Per-visit data points in Analytics Engine | About 90 days (Cloudflare deletes them; they can't be deleted earlier) |
| Daily totals in D1: per link, country, device and source, and per city, region, OS, browser, referrer, language and bot | Until you delete the link's domain in Settings → Short domains, or the database |
| Missed paths | As set on the Misses page: Keep for 30 days, 2 months or 3 months, and the path limits |
| The day's salt | Until the daily job after that day ends |
| Website events in Analytics Engine | About 90 days |
| Website visits, identified visitors and payments in D1, and daily page, goal and outbound totals | Until you delete the site in Websites, or the database |

The daily totals contain counts only, no hashes.

## Visitors to your tracked websites

This applies only to sites you add under Websites and put the script (`/_t/script.js`) on.

**Each page view and event** (goal, outbound click, page speed) becomes an Analytics Engine data point: the time, the page path, the referring host, UTM tags, the country, region, city, continent and time zone, the network operator, the device type, operating system, browser, language, a screen size class, reading time, scroll depth and page speed. No IP address and no full referrer URL is stored.

**Each visit** (a visitor's events with no gap over 30 minutes) is also kept in D1: its start and end, entry and exit page, source, channel, UTM tags, the short link that brought it, location (country, region and city), device, operating system, browser and language, and a visitor ID.

How a visitor is told apart is set per site (Settings & setup → Visitor identification):

- **Cookieless** (the default): the visitor ID is a hash of the IP address, the user agent and the site, made with the same daily salt as [short links](#how-unique-visitors-are-counted). Nothing is stored in the browser, and the ID changes every day.
- **Recognise returning visitors:** one random ID in the browser's localStorage (`sh_vid`, not a cookie), first-party on your domain. It recognises the visitor across days. In the EU this needs consent.
- **After consent:** cookieless until your consent banner, or the built-in one (`data-consent-banner`), records consent. The choice is kept in localStorage as `sh_consent`.

With **Respect Global Privacy Control** on, visitors who send Global Privacy Control or Do Not Track are always counted cookieless.

A short link to a tracked site adds a signed `sh_c` parameter to the address, naming the click. The script reads it on the first page, removes it from the address bar, and credits the visit to that link. It holds no personal data and is valid for 7 days.

## Payments and customers

With a payment provider connected, its webhooks send each payment. Shorthop keeps: the amount and currency, the kind (charge, refund, dispute), the provider's customer, order and subscription IDs, the **customer's email** when the provider sends one, and the visit it was matched to.

Payments are matched to a visit by the reference passed through checkout, the return page after payment, the same customer, an identified email, or checkout timing. **Identified emails** come from `shorthop("identify", …)` on your site or from your server's API, stored with the visitor ID and an optional name and user ID. A site can match by email only to identities your server sent.

Only people with the **See revenue** permission see payments, revenue and customers.

## The admin's own users

This is about the people who use the admin, not visitors.

- **Login log:** the time, the result, the email of who signed in, the country and a keyed hash of the network (never the IP address), kept for 30 days.
- **Cookies:** the admin uses a session cookie, and Cloudflare Access sets its own when it's on; both are needed to sign in.
- **People** added in Settings → Access & security: their email, name, role, permissions, who added them, when they last signed in, and whether, until when and by whom their access is paused. This stays until they are removed. Their password is stored only as a PBKDF2 hash, and invite and reset links only as SHA-256 hashes.
- **Emails to people:** invite and password-reset emails go to their Access address through your email provider.
- **Bot check:** with Turnstile on, the password pages load Cloudflare's challenge script, and the result is checked with Cloudflare along with the person's IP address. Cloudflare's Turnstile privacy terms apply.
- **Personal API keys:** the name, owner, permissions, expiry and when the key was last used (at most hourly). The key itself is stored only as a SHA-256 hash.
- **Link history:** each version records who made the change, as an email or `api-token`, or as an email and an API key's name. Versions are kept for a year; the latest one of each link for as long as the link exists.

## Requests Shorthop makes

None of these carry visitor data.

- **Destination checks** fetch your links' destinations, once you turn them on. They send a `ShorthopLinkCheck/1.0` user agent.
- **"Start from the destination"** in the social-preview editor fetches that destination's page to read its preview.
- **Webhooks** send link data (slug, destination, title, tags, click milestones) to the endpoints you configure, signed with your secret. The `site.payment` webhook sends a payment's amount and source, and the customer's email when known.
- **Payment providers:** importing past payments, and checking PayPal's webhook signatures, call the provider's API with your connection's keys.
- **Exchange rates:** once a day, the day's ECB rates from `api.frankfurter.dev`.
- **Version check:** at most once a day, when someone opens System status, the latest release from GitHub's API.

## A starting point for your privacy notice

Adapt this to your service and your jurisdiction:

> When you open a short link on go.example.com, we record the time, the link, your approximate location (country, region and city, derived from your IP address by our hosting provider Cloudflare), your network operator, your device type, operating system, browser and preferred language, and the website that sent you. To count unique visitors, we compute a one-way code from your IP address and browser that changes every day; the random value behind each day's codes is deleted once the day is over. We don't store your IP address and don't set cookies, except on a password-protected link: once you enter its password, a cookie for that link only remembers it for 12 hours so you aren't asked again. Detailed records are deleted after about 90 days; daily totals without any personal reference are kept longer. We use this information to understand how our links are used (legitimate interest). Contact: privacy@example.com.

If you track your website with Shorthop, add something like this, and choose the sentence that fits the site's visitor identification:

> On this website we record the pages you view, where you came from, your approximate location (derived from your IP address by our hosting provider Cloudflare), your network operator, device, browser, language and screen size class, how long you read and how far you scroll, and how fast pages load. *(Cookieless:)* We don't store your IP address or anything in your browser; a code that changes every day tells visits apart. *(Recognise returning visitors / after consent:)* With your consent, we keep a random ID in your browser's local storage (`sh_vid`) to recognise you when you come back; you can withdraw consent at any time under Cookie settings. When you buy, we receive the purchase from our payment provider, including your email address, and connect it to the visit that led to it, to learn which pages and campaigns bring customers. Detailed page-view records are deleted after about 90 days; visit and purchase records are kept as long as we keep our website statistics. Contact: privacy@example.com.

Link the notice from your website. The not-found page's button can point to it (Settings → Not-found page).

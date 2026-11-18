# Visitor privacy

What Shorthop records when someone opens one of your short links or visits a website you track with it, how long it's kept, and a starting point for your privacy notice. Under the GDPR and similar laws you, the operator, are responsible for telling visitors about it. This page isn't legal advice.

## What is recorded per visit

Each request to a short domain becomes one Analytics Engine data point, written after the redirect has been sent:

| Data | Where it comes from |
|---|---|
| Time, short domain and slug (or the missed path) | The request |
| Event: click, bot or miss | Shorthop's classification |
| Country, region, city, continent | Cloudflare's IP geolocation |
| The city's position, rounded to 0.1° (about 11 km), for the live map | Cloudflare's IP geolocation |
| Network operator (ASN and its name) and Cloudflare data center | Cloudflare |
| Device type, operating system, browser, preferred language | The `User-Agent`, client hints and `Accept-Language` headers |
| Referring website (host name only) and source tag (`?s=`) | The `Referer` header and the link |
| Bot name, for previews and crawlers | The `User-Agent` |
| Visitor hash | See below |

## What is not recorded

- **IP addresses.** They're used during the request (Cloudflare derives the location from them) and for the visitor hash, but Shorthop never writes them to its database or analytics. Rate limiters receive a keyed hash of the network instead of the address. Cloudflare handles the address itself to run the service, under its own terms: Shorthop turns off Cloudflare's per-request invocation logs and traces in its config, so they aren't kept in Workers Logs unless you turn them back on. What Cloudflare records elsewhere isn't something Shorthop controls.
- **Cookies.** Visitors get none: a short link is a redirect. The one exception is a password-protected link: after the right password, a functional cookie for that link only (`sh_access`, scoped to the link's path) remembers it for 12 hours, so the visitor isn't asked again. It holds no personal data, only a signed expiry.
- **Full referrer URLs.** Only the host name is kept.

## How unique visitors are counted

A visitor hash is the first 16 hex characters of SHA-256 over the IP address, the user agent, the UTC date, the `VISITOR_SALT` secret (or, on an install without it, a random value generated once and kept in D1) and a random salt for that day. Every isolate shares the day's salt through D1. The daily cleanup (02:00 UTC, tried again if it fails) deletes the salt of each day that has ended, and System status warns if one stays. After that, a hash can't be worked out again from what Shorthop keeps, even with a known IP address. A deleted salt can still sit in D1's point-in-time recovery for as long as Cloudflare keeps that history, so someone with access to your Cloudflare account could recover it during that time. Hashes change every day, so they can't follow a visitor across days.

## How long it is kept

| Data | Kept |
|---|---|
| Per-visit data points in Analytics Engine | About 90 days (Cloudflare deletes them; they can't be deleted earlier) |
| Daily totals in D1: per link, country, device and source, and per city, region, OS, browser, referrer, language and bot | Until you delete the link's domain in Settings → Short domains, or the database |
| Missed paths | As set on the Misses page: Keep for 30 days, 2 months or 3 months, and the path limits |
| The day's salt | Until the daily job after that day ends |
| Website events in Analytics Engine | About 90 days |
| Payment amounts and daily page, goal and outbound totals in D1 | Until you delete the site in Websites, or the database |
| Website visits in D1 | As set in the site's Settings & setup → Privacy (1 to 7 years); with no period, until the site is deleted. Past it they are deleted, a batch a day, except visits a payment is credited to, which stay without their visitor ID or finer details |
| Customers' emails, customer IDs and identified visitors | As set in the site's Settings & setup → Privacy (1 to 7 years), or until the site is deleted; or until you [erase the person](#requests-from-visitors-and-customers) |
| Return-page references and short-link checkout clicks | 90 days |
| Queued and logged webhook deliveries, payloads included | 30 days after they are sent or given up on; `link.clicked` isn't logged at all |
| IDs of provider events already handled | 400 days |
| Erasure ledger: keyed hashes of what was erased | 400 days |
| Keyed hashes of browser IDs whose consent was withdrawn | 90 days |
| Backups in your R2 bucket | The newest eight; downloaded ZIPs for as long as you keep them |
| Export and erasure requests (who asked, when, how many records; never whom about) | Until the site is deleted |

The daily totals contain counts only, no hashes.

## Visitors to your tracked websites

This applies only to sites you add under Websites and put the script (`/_t/script.js`) on.

**Each page view and event** (goal, outbound click, checkout click, page speed) becomes an Analytics Engine data point: the time, the event type, the page path and host, the referring host, source, channel, `utm_source`, `utm_medium` and `utm_campaign`, the short link that brought the visit, the country, region and city, the device type, operating system, browser and language, the screen width in pixels, reading time, scroll depth and page speed, the goal's name and properties or the outbound link's host and path, and **the visit ID and visitor ID**. No IP address, name, email or full referrer URL is stored there. Those two IDs tie a visit's events together: anyone who can query your Analytics Engine data in your Cloudflare account can follow them, though the admin doesn't offer that.

Before anything is stored, paths, goal names and properties, `utm_` tags, `ref`/`via` values and missed short-link addresses are screened for things shaped like email addresses and secrets (`[email]`, `[redacted]`): JSON Web Tokens, long hex strings, `token=`-style pairs, and runs of 32 or more characters that mix capitals, lower case and digits without reading as words. Long slugs and campaign names stay as they are. This goes by shape, so it can miss some, a short or unusually word-like key among them, and what you put in your own URLs stays your responsibility. With `data-hash`, only a route (`#/orders`, without anything after `?`) counts as a page; other fragments aren't sent or kept.

**Each visit** (a visitor's events with no gap over 30 minutes) is also kept in D1: its start and end, entry and exit page, host, referring host, source, channel, UTM tags, the short link that brought it, location (country, region, city, continent and time zone), network operator, device, operating system, browser, language, screen size class, when it last clicked a checkout link, whether the visitor had been before, and a visit ID and visitor ID.

How a visitor is told apart is set per site (Settings & setup → Visitor identification):

- **Cookieless** (the default): the visitor ID is a hash of the IP address, the user agent and the site, made with the same daily salt as [short links](#how-unique-visitors-are-counted). Nothing is stored in the browser, and the ID changes every day at midnight UTC. A visit in progress at midnight is continued for up to 30 minutes (matched with the previous day's ID while its salt still exists); otherwise days aren't linked.
- **Recognise returning visitors:** one random ID in the browser's localStorage (`sh_vid`, not a cookie), first-party on your domain. It recognises the visitor across days. In the EU this needs consent.
- **After consent:** cookieless until your consent banner, or the built-in one (`data-consent-banner`), records consent. The choice is kept in localStorage as `sh_consent`.

With **Respect Global Privacy Control** on, visitors who send Global Privacy Control or Do Not Track are always counted cookieless. With or without that setting, for a browser sending either signal Shorthop ignores `identify`, doesn't hand out or store a checkout reference or return-page reference, doesn't keep its checkout clicks for matching, and adds no checkout reference to a short link it opens. `shorthop.ref()` is then `null`, `shorthop.ref(callback)` calls back with `null`, and checkouts go on without a reference. Your own server can still report that person through the API.

Withdrawing consent (`shorthop("consent", false)`, or Decline in the built-in banner) clears the browser's ID at once, in every open tab, and the browser starts over without it. It also tells Shorthop, which stops accepting that ID for 90 days. Shorthop records this once per ID, only for an ID the site has seen, and up to a daily number per site (1,000 on Workers Free, 20,000 on Paid). On Workers Free, once the day's budget for website events is spent, it records nothing more that day: the browser's own step still applies, and no events are being stored anyway, but a copy of the old ID used elsewhere wouldn't be refused. What was collected under the ID stays until the site's retention period or an [erasure](#requests-from-visitors-and-customers).

A short link to a tracked site adds a signed `sh_c` parameter to the address, naming the click. The script reads it on the first page, removes it from the address bar, and credits the visit to that link. It holds no personal data and is valid for 7 days.

## Payments and customers

With a payment provider connected, its webhooks send each payment. Shorthop keeps: the amount and currency, the kind (charge, refund, dispute), the provider's customer, order and subscription IDs, the **customer's email** when the provider sends one, and the visit it was matched to.

Payments are matched to a visit by the reference passed through checkout, the return page after payment, the same customer, an identified email, or checkout timing. That says which visit gets the credit. It says who paid only when your server stands behind it: an email your server reported for the visitor, or a visitor your server named for the payment. A reference on a checkout address can be put there by anyone, so neither it nor a return page ties the buyer's email to that visitor or links them in a privacy request. **Identified emails** come from `shorthop("identify", …)` on your site or from your server's API, stored with the visitor ID and an optional name and user ID. A site can match by email only to identities your server sent.

A short link that goes straight to a hosted checkout (Stripe Payment Links, Lemon Squeezy, Dodo, Creem or Gumroad), on a provider connected to one of your sites, adds a random **checkout reference** to the checkout address. Shorthop keeps it with the link, the source, the country, region and city, and the device, operating system and browser, never an IP address or visitor hash, for 90 days. When the provider's webhook brings the reference back with a payment, the click becomes a visit credited to the link. Paddle, PayPal and FastSpring links can't carry a reference in the address.

Only people with the **See revenue** permission see payments, revenue and customers.

**Retention** (Settings & setup → Privacy) works through everything older than the period you choose, every night: payments lose the customer's email, customer ID and visitor; subscriptions that ended lose their customer ID; identified visitors who haven't been back are forgotten; and visits last seen before it are deleted, a limited number a night, so a long history takes several nights. A visit a payment is credited to stays so revenue by source still adds up, but only as that: its source, channel, referring host, `utm_source`, `utm_medium`, `utm_campaign` and short link, and the day it began (UTC). It gets a random visitor ID, loses its pages, exact times, location, device and everything else, and no longer counts as traffic, so revenue by page, country or device shows it under an empty value. The kept visit of an erased person is reduced the same way once it passes the period. Older visitor and visit counts go down as visits are removed. With no period set, nothing is removed. Your payment provider keeps its own records.

## Requests from visitors and customers

In a site's Settings & setup → Privacy, find a person by their email, visitor ID or a payment ID. Shorthop collects the visitors your server identified with that email and their visits, the payments with that email or whose match proves who paid (an email your server reported, or a visitor it named) and those payments' visitors, the same provider customer's other payments and refunds, and their subscriptions. It doesn't follow a customer to other customers.

Anything a browser could have sent proves nothing, so it is **shown separately and left out unless you include it**: visitors whose browser reported that email, and visitors tied to the person's payments only by a checkout reference. Including them adds their identity and visits and nothing further. A visitor ID doesn't reach a payment matched to it by a reference or a guess, because someone else may have made that payment; the lookup counts those payments so you can search for their customer directly. Checking who is asking stays with you. On a cookieless site a visitor ID is a daily hash that people on the same network with the same browser can share.

Doing this needs both **Manage websites** and **See revenue**, and works through the API too (`POST /api/sites/<id>/privacy/lookup`, `/export`, `/erase` with `"confirm": true`, each taking `"include": ["claimed_email", "payment_reference"]` to add those links, and `GET …/privacy/requests`), with the email or ID in the request body, never the address.

- **Export** downloads what is stored about them as JSON, as stored: identities, visits (up to 50,000), payments, subscriptions, their return-page references, the short-link checkout clicks behind their visits, and queued or logged `site.payment` webhooks for their payments. It lists what it leaves out and why. A payment matched to a visit that isn't shown as theirs is exported without that link.
- **Erase** deletes their identities and visits, and removes their email, customer ID, visit reference and visitor from their payments, which keep the amount, date and credited visit. A visit a payment is credited to stays, so revenue by source still adds up, but belongs to nobody: it gets a new visit ID and a new random visitor ID, and its region, city, network, time zone, language, screen, host, `utm_term` and `utm_content` and any `#fragment` of its pages are cleared; matching and identify ignore it from then on. The new IDs mean what stays in D1 no longer joins to the events in Analytics Engine. A payment can also be credited to a visit that isn't being erased, because a checkout reference doesn't prove whose visit it was. That visit stays as it is, and the payment moves to an anonymous copy of it: new visit ID, new random visitor ID, only the day it started, the same source, channel, campaign, short link, landing page, country and device, and not counted as traffic. Revenue by source doesn't change, and nothing on the payment leads to that visit or its browser ID any more. The copy can still resemble the original, so someone comparing day, source and landing page could guess at it. Someone else's payment matched to their visitor is unlinked, to be matched again, and otherwise left alone. Return-page references to their visits or to their payments' provider IDs, the short-link checkout clicks behind either (with the visit made from such a click, unless another payment is credited to it) and queued or logged `site.payment` webhooks for their payments are deleted too. Refunds, repeated webhooks and subscription updates that arrive later for an erased payment or subscription are stored without the personal details again. The provider's own order and subscription IDs stay on the payment, to link refunds and disputes; they identify the person only together with the provider's records.
- **Afterwards:** keyed hashes of their browser ID, email, customer ID, payment IDs and the provider's order and subscription IDs go on an erasure ledger for 400 days. The collector refuses that browser ID, within about a minute, so a returning browser is counted cookieless and then gets a new, unconnected ID; the site's server can't identify it again either. A return page or webhook naming those provider IDs can't tie the payment to a visit again. The hashes can't be read back without `SESSION_SECRET` or `ENCRYPTION_KEY`. A cookieless visitor's daily hash isn't blocked: it changes at midnight UTC anyway.

What erasure can't reach: single page views and events in Analytics Engine, which have no name or email but do carry the old visitor and visit IDs, until they expire after about 90 days; daily totals, which are counts; emails already sent (payment alerts, digests) and webhooks already delivered to your endpoints; the payment provider's own records, whose checkout metadata can still hold the old reference, which is the ID of any visit left in place; platform logs at Cloudflare; the person's data on your other tracked sites, which is erased per site; and copies made before the erasure. **D1's point-in-time recovery and your backups (the R2 copies and any downloaded ZIP) still hold the erased data** until they expire or you delete them. If you restore one, run **Re-apply erasures** in the site's Privacy section right after it ([restore steps](SETUP.md#restore)); that works for 400 days after an erasure, and leaves records first stored after it, such as a later purchase by someone who came back. A subscription that is still active brings the customer's details back with its next renewal, so cancel or erase it at the provider as well.

Each export and erasure is logged with who did it, when and how many records, without anything identifying the person.

## The admin's own users

This is about the people who use the admin, not visitors.

- **Login log:** the time, the result, the email of who signed in, the country and a keyed hash of the network (never the IP address), kept for 30 days.
- **Cookies:** the admin uses a session cookie, and Cloudflare Access sets its own when it's on; both are needed to sign in.
- **People** added in Settings → Access & security: their email, name, role, permissions, who added them, when they last signed in, and whether, until when and by whom their access is paused. This stays until they are removed. Their password is stored only as a PBKDF2 hash, and invite and reset links only as SHA-256 hashes.
- **After someone is removed:** their account and API keys go, but their email stays where it records what they did: in link history (versions are kept for a year, a link's latest one for as long as the link exists), on shares they created and in privacy-request records. It isn't anonymized, so you can still tell who changed what.
- **Backups** always contain your team's emails and names, including those records. The "people's details" tick only adds customers' emails and ids and visitor ids.
- **Emails to people:** invite and password-reset emails go to their Access address through your email provider.
- **Bot check:** with Turnstile on, the login and forgot-password pages load Cloudflare's challenge script, and the result is checked with Cloudflare along with the person's IP address. Cloudflare's Turnstile privacy terms apply.
- **Personal API keys:** the name, owner, permissions, expiry and when the key was last used (at most hourly). The key itself is stored only as a SHA-256 hash.
- **Link history:** each version records who made the change: an email, an email and an API key's name, `admin` with a short hash of the session (without Cloudflare Access, where everyone signs in as the same admin), or `api-token` with a short keyed hash of the network it came from. Neither hash can be turned back into a cookie or an IP address. Versions are kept for a year; the latest one of each link for as long as the link exists.
- **Webhooks:** who created or last changed each one, as an identity like those above, and which API key did. This stays until the webhook is deleted.

## Requests Shorthop makes

Some of these carry data about your visitors and customers, as each entry says. Everything sent to a webhook or by email leaves Shorthop: its retention and erasure don't reach the copy.

- **Destination checks** fetch your links' destinations, once you turn them on, with a `ShorthopLinkCheck/1.0` user agent. No visitor data.
- **"Start from the destination"** in the social-preview editor fetches that destination's page to read its preview. No visitor data.
- **Webhooks** send link data (slug, destination, title, tags, click milestones) to the endpoints you configure, signed with your secret. Each endpoint is set to **Full** or **Minimal** data about people; endpoints from before this choice, and ones created through the API without saying, are Full, and new ones in the admin start at Minimal. With Full, `site.payment` sends the payment, the customer's email when known, the credited visit's channel, source, campaign, short link, landing page, country and device, how it was matched and the visitor's number of visits and first source; `link.clicked` sends each human click's time, country, city, device, operating system, browser, source and referring host. With Minimal, `site.payment` leaves out the email, the visit details and the journey, and `link.clicked` sends only the link, the time and the country. Neither ever carries an IP address or visitor hash. Sources, campaigns and landing pages come from visitors' links and are listed in `visitor_supplied`: treat them as untrusted text.
- **Emails you turned on:** payment alerts go to the digest recipient with the amount, the customer's email and the visit's source (shortened, and marked as reported by the visit); digests hold totals and top sources. They go through your email provider.
- **Unsafe-destination check:** when a link is created or its destination changes, the destination's host name (only the host, no visitor data) is looked up at Cloudflare's security resolver (`security.cloudflare-dns.com`), which says whether Cloudflare flags it as malware or phishing. `SAFETY_DNS="off"` turns this off.
- **Workers AI (optional):** with the `AI` binding, "Suggest" and "Write with AI" in the link form send the destination's address, title and description to a model on your own Cloudflare account. No visitor data.
- **Payment providers:** importing past payments, reading Gumroad sales and checking PayPal's webhook signatures call the provider's API with your connection's keys. These requests name payments and customers the provider already holds.
- **Exchange rates:** once a day, the day's ECB rates from `api.frankfurter.dev`. No visitor data.
- **Version check:** at most once a day, when someone opens System status, the latest release from GitHub's API. No visitor data.

## A starting point for your privacy notice

Adapt this to your service and your jurisdiction:

> When you open a short link on go.example.com, we record the time, the link, your approximate location (country, region and city, derived from your IP address by our hosting provider Cloudflare), your network operator, your device type, operating system, browser and preferred language, and the website that sent you. To count unique visitors, we compute a one-way code from your IP address and browser that changes every day; the random value behind each day's codes is deleted once the day is over. We don't store your IP address and don't set cookies, except on a password-protected link: once you enter its password, a cookie for that link only remembers it for 12 hours so you aren't asked again. Detailed records are deleted after about 90 days; daily totals without any personal reference are kept longer. We use this information to understand how our links are used (legitimate interest). Contact: privacy@example.com.

If you track your website with Shorthop, add something like this, and choose the sentence that fits the site's visitor identification:

> On this website we record the pages you view, where you came from, your approximate location (derived from your IP address by our hosting provider Cloudflare), your network operator, device, browser, language and screen size class, how long you read and how far you scroll, and how fast pages load. *(Cookieless:)* We don't store your IP address or anything in your browser; a code that changes every day tells visits apart. *(Recognise returning visitors / after consent:)* With your consent, we keep a random ID in your browser's local storage (`sh_vid`) to recognise you when you come back; you can withdraw consent at any time under Cookie settings. When you buy, we receive the purchase from our payment provider, including your email address, and connect it to the visit that led to it, to learn which pages and campaigns bring customers. Detailed page-view records are deleted after about 90 days; visit records, and your email and customer details on purchases, are kept for [N years, or: as long as we keep our website statistics]. *(If payment or click data goes to other services through webhooks or email, name them here.)* You can ask for a copy of your data or for its deletion at privacy@example.com.

The built-in consent banner only says that a random ID recognises return visits: set `data-consent-text` if your notice needs it to say more. Link the notice from your website. The not-found page's button can point to it (Settings → Not-found page).

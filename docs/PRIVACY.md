# Visitor privacy

What Shorthop records when someone opens one of your short links, how long it's kept, and a starting point for your privacy notice. Under the GDPR and similar laws you, the operator, are responsible for telling visitors about it. This page isn't legal advice.

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

The daily totals contain counts only, no hashes.

## The admin's own users

This is about the people who use the admin, not visitors.

- **Login log:** the time, the result, the email of who signed in, the country and a keyed hash of the network (never the IP address), kept for 30 days.
- **Cookies:** the admin uses a session cookie, and Cloudflare Access sets its own when it's on; both are needed to sign in.
- **People** added in Settings → Access & security: their email, name, role, permissions, who added them, and when they last signed in. This stays until they are removed. Their password is stored only as a PBKDF2 hash, and an invite link only as a SHA-256 hash.
- **Personal API keys:** the name, owner, permissions, expiry and when the key was last used (at most hourly). The key itself is stored only as a SHA-256 hash.
- **Link history:** each version records who made the change, as an email or `api-token`, or as an email and an API key's name. Versions are kept for a year; the latest one of each link for as long as the link exists.

## Requests Shorthop makes

None of these carry visitor data.

- **Destination checks** fetch your links' destinations, once you turn them on. They send a `ShorthopLinkCheck/1.0` user agent.
- **"Start from the destination"** in the social-preview editor fetches that destination's page to read its preview.
- **Webhooks** send link data (slug, destination, title, tags, click milestones) to the endpoints you configure, signed with your secret.

## A starting point for your privacy notice

Adapt this to your service and your jurisdiction:

> When you open a short link on go.example.com, we record the time, the link, your approximate location (country, region and city, derived from your IP address by our hosting provider Cloudflare), your network operator, your device type, operating system, browser and preferred language, and the website that sent you. To count unique visitors, we compute a one-way code from your IP address and browser that changes every day; the random value behind each day's codes is deleted once the day is over. We don't store your IP address and don't set cookies, except on a password-protected link: once you enter its password, a cookie for that link only remembers it for 12 hours so you aren't asked again. Detailed records are deleted after about 90 days; daily totals without any personal reference are kept longer. We use this information to understand how our links are used (legitimate interest). Contact: privacy@example.com.

Link the notice from your website. The not-found page's button can point to it (Settings → Not-found page).

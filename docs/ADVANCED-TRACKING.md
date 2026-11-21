# Advanced tracking

An opt-in click log for a single link. Each click on a tracked link is stored on its own, with everything Cloudflare already knows about the request and, if you allow it, a few values from the visitor's browser. No third-party service is asked about anyone.

It is off for every link until someone switches it on, and the workspace rules start cautious: no IP addresses, at most 90 days, a written purpose required. The guide in the admin (`/_admin/tracking-guide`) explains it for the people who use it: what each setting records, a GDPR checklist, how to read the log and how to answer people's requests. This page is the reference for operators and contributors.

- [What it records](#what-it-records)
- [Switching it on](#switching-it-on)
- [Workspace rules](#workspace-rules)
- [Permissions](#permissions)
- [Email opens](#email-opens)
- [Notifications and webhooks](#notifications-and-webhooks)
- [Retention and housekeeping](#retention-and-housekeeping)
- [API](#api)
- [How it works](#how-it-works)
- [Security and privacy design](#security-and-privacy-design)
- [Costs on Workers Free](#costs-on-workers-free)
- [Accepted limits](#accepted-limits)

## What it records

One D1 row per hit (table `tracked_clicks`), written after the redirect has been sent:

| Group | Data | Source |
|---|---|---|
| Event | Time to the second; `click`, `open` (the email pixel) or `bot`, with the bot's name, or for opens the mail proxy ("Gmail image proxy") | Worker, bot detection |
| Location | Country, region, city, postal code, metro code, the city's coordinates, time zone, continent, EU or not | `request.cf` |
| Network | ASN and operator, Cloudflare data center, TLS and HTTP version, round-trip time | `request.cf` |
| Network name | The address's reverse DNS name, only when it resolves back to the same address. With IP addresses the whole name, otherwise only its domain | 1.1.1.1 over HTTPS |
| Signals | Tor (Cloudflare's `T1`), hosting network, iCloud Private Relay / WARP, a named VPN provider from a public list | Derived, [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn) (MIT) |
| Device | Full user agent, device, model, operating system and browser with versions | `User-Agent`, `Sec-CH-UA-*` |
| Context | Every accepted language, the full referrer, the source tag, QR scan or not | Headers |
| Visitor | A number per link (V1, V2…) for the same browser on the same network | Keyed hash of IP and user agent |
| IP address | Only in IP mode, AES-GCM encrypted | `CF-Connecting-IP` |

Optional **browser details** (table `tracked_click_details`): people see a short page for 100 to 300 ms that reads screen and window size, pixel ratio, the browser's time zone, languages, platform, processor cores, memory, touch points, connection type, colour scheme, Do Not Track, Global Privacy Control and, in Chromium, the Client Hints model, platform version and full browser version. It posts them to `/_k` and replaces itself with the destination. When the browser's clock disagrees with the IP's time zone, the click gets a "VPN?" hint.

Deliberately not built: WebRTC address leaks, GPS prompts, canvas / WebGL / audio fingerprinting and disguise domains. They mostly serve to de-anonymise people.

Ordinary statistics (Analytics Engine, daily totals) are unchanged and keep no IP addresses, whether tracking is on or off.

## Switching it on

Two places, with the same fields and the same checks (`resolveTracking()` in `src/worker/api/tracking.ts`):

- **A new link:** the **Advanced tracking** section of Create a new link, between Protection and Link settings. Shown only to people with See click logs. If the choices aren't valid, the link isn't created.
- **An existing link:** the link page → More → **Advanced tracking…**.

Settings per link:

| Setting | Values |
|---|---|
| Mode | Off, **Without IP** (`details`), **With IP addresses** (`ip`) |
| Purpose | Why the link is tracked, 10 to 300 characters when the rules require it. Shown on the click log |
| Keep each click for | 7, 30, 90 days or 1 year, capped by the rules |
| Browser details | Off or on |
| Email-open pixel | Off or on |
| Email me | Never, on the first click (and first open) by a person, or on every one (at most every 10 minutes) |

IP mode needs the **See IP addresses** permission and a GDPR warning accepted once per link. Who accepted it and when is stored with the setting. Leaving IP mode clears the addresses already recorded on that link at once, with the full reverse-DNS names stored next to them.

Editing a link never changes its tracking: the link `UPDATE`, version restores and the import upsert don't touch the `tracking` column, and version snapshots don't contain it. Deleting a link deletes its click log, and a restored link comes back with tracking off.

## Workspace rules

Settings → Access & security → **Advanced tracking rules** (admins, from a signed-in session):

| Rule | Default |
|---|---|
| Allow Advanced tracking | On |
| Allow recording IP addresses | **Off** |
| Allow browser details | On |
| Allow the email-open pixel | On |
| Longest retention | 90 days |
| Require a purpose | On |

The rules are enforced three times:

1. **When tracking is set** (on a new link or an existing one). Switching it off is always allowed.
2. **When the rules get tighter.** Every tracked link is brought within them, stored IP addresses are cleared when IP is no longer allowed, all browser details are deleted when those aren't, and stored clicks are cut to the new longest retention. Up to 10 links (Free) or 200 (Paid) are republished in the same request; the admin then runs **Republish** for the rest.
3. **On every click, open and beacon.** A KV record published before a change can't break the rules.

## Permissions

| Permission | Allows |
|---|---|
| **See click logs** (`clicks.view`) | Reading click logs (without IP addresses), switching tracking on when creating a link, subscribing to `link.tracked_click` |
| **See IP addresses** (`clicks.ip`) | Seeing IP addresses where they are recorded, choosing IP mode, finding and erasing a person's clicks by IP |

Admins have both. Changing tracking on an existing link, and deleting clicks, also needs Edit links. Who accepted the GDPR warning (an email) is blanked for people without See click logs. The MCP tool `click_log` never returns IP addresses, whatever the key may see, and the MCP `create_link` tool can't switch tracking on.

## Email opens

With the pixel switched on for a link, the click log shows an `<img>` tag to paste into an email: `https://<short domain>/_p/<slug>.gif`. It always answers the same 43-byte transparent GIF, for any slug, so it says nothing about which links exist. An `open` is recorded only for a GET on a live link with tracking and the pixel on. Opens are not clicks: no Analytics Engine point, no click limit, no routing.

Who loaded it:

1. Gmail's and Yahoo's image proxies count as opens "via" that proxy. The place and device are the proxy's.
2. A `Referer` from a website that isn't web mail is a bot, "Embedded on <host>": the pixel is public, and strangers on a web page never got the email.
3. Outlook and Office user agents count as opens, except from datacenter networks, where Microsoft's link scanners use the same names.
4. Otherwise the usual bot detection decides.

Apple Mail Privacy Protection loads images when the email arrives, so an open from Apple doesn't prove anyone read it. In the EU, a tracking pixel generally needs the recipient's consent (ePrivacy Directive Art. 5(3)); the admin says so next to the pixel.

## Notifications and webhooks

- **Email** to `DIGEST_TO` through your email setup, for people only (never bots, previews or scanners): time, visit number, place, network and host name, the IP in IP mode, device, referrer and flags, with a link to the click log. Clicks and opens are counted separately. "First" and "every" are claimed with one atomic write, so two clicks at once can't both send.
- **Webhook `link.tracked_click`:** every person's click and open, through the webhook outbox with retries. It carries location, network (host name as its domain only, VPN name, flags), device, visit number and `ip_masked` (`203.0.113.***`), never a full IP address. Subscribing needs See click logs.

## Retention and housekeeping

Each row stores its own `expires_at`. The half-hourly cron's **03:30 UTC** run deletes expired clicks and browser details whose click is gone, and, while at least one link is tracked, downloads the VPN and hosting lists (streamed, refused past 256 KB, at most 5,000 entries; a failed download keeps the previous lists). It costs one query when nothing is tracked. The lists are also fetched once when tracking is first switched on. `TRACKING_NET="off"` turns off both outbound lookups (reverse DNS and the lists); the tests set it.

Backups: `tracked_clicks` and `tracked_click_details` are personal tables (exported only with people's details), and `ip_enc` / `ip_key` are never exported.

## API

All under `/api` (keys) and `/_admin/api` (the admin), described in the OpenAPI reference under **Advanced tracking**:

| Route | Needs |
|---|---|
| `POST /links` with `tracking` | Create links + See click logs (IP mode: See IP addresses) |
| `PUT /links/:domain/:slug/tracking` | Edit links + See click logs (IP mode: See IP addresses) |
| `GET /links/:domain/:slug/clicks` | See click logs |
| `GET /links/:domain/:slug/clicks.csv` | See click logs |
| `DELETE /links/:domain/:slug/clicks` | Edit links + See click logs |
| `DELETE /links/:domain/:slug/clicks/:id` | Edit links + See click logs |
| `POST /clicks/by-ip`, `POST /clicks/by-ip/erase` | See click logs + See IP addresses (erase: also Edit links) |
| `GET /tracking/policy` | Signed in |
| `PUT /tracking/policy` | Admin, signed-in session only (not in the public reference) |

The tracking body, for `PUT …/tracking` or `tracking` in `POST /links`:

```json
{
  "mode": "details",
  "retentionDays": 30,
  "browser": false,
  "pixel": true,
  "notify": "first",
  "purpose": "To see whether the candidate opened the offer, so I know when to follow up."
}
```

`mode: "ip"` also needs `"acknowledged": true` the first time. `null` switches tracking off. Unknown keys are refused; `ackAt`, `ackBy` and `since` come only from the server. Errors: 403 `forbidden` (a permission is missing), 403 `policy` (tracking is off for the workspace), 400 `policy` (an option the rules don't allow), 400 `purpose_required`, 400 `ack_required`. On `POST /links` they come back before anything is saved, with the message starting `tracking: `.

`GET …/clicks?event=all|click|open|bot&limit=1..500&offset=&visitor=` returns the clicks with totals (`people`, `opens`, `bots`, `visitors`) and `canSeeIp`. The CSV export has up to 20,000 rows and 44 columns, with formula injection neutralised.

## How it works

| File | Role |
|---|---|
| `migrations/0047_advanced_tracking.sql` | `links.tracking`, `tracked_clicks` with three indexes, `tracked_click_details` |
| `migrations/0048_tracked_links_index.sql` | Partial index `links_tracked` for "which links are tracked" |
| `migrations/0049_tracking_network.sql` | `hostname`, `vpn_name` |
| `src/shared/tracking.ts` | Types, rules (`TrackingPolicy`, `withinPolicy`), schemas, warning texts |
| `src/worker/tracking.ts` | Recording, user-agent parsing, keyed hashes, notifications, the browser-details page and beacon, the pixel, reverse DNS, the lists, retention |
| `src/worker/api/tracking.ts` | The routes, and `resolveTracking()` shared with `POST /links` |
| `src/client/app/link/Tracking.tsx` | Click log, map, settings dialog and the fields the link form reuses |
| `src/client/app/settings/tracking.tsx` | The rules section |
| `src/client/app/docs/TrackingGuide.tsx` | The guide at `/_admin/tracking-guide` |

The KV record gains `tk` (1 without IP, 2 with), `tr` (retention days), `tj` (browser details), `tn` (1 first, 2 every) and `tp` (pixel). A link without tracking costs nothing extra on the redirect: one KV read, then the 302. A tracked link adds one D1 insert after the response, plus the reverse-DNS lookup for people.

Publishing follows the rest of Shorthop: the tracking routes publish the row D1 returns from their `UPDATE … RETURNING` and read it back (`publishLatest()` in `src/worker/db.ts`), so a save that reached KV in the other order is published again and KV ends up matching D1.

## Security and privacy design

- IP addresses are AES-256-GCM encrypted with a random IV, keyed from `ENCRYPTION_KEY` (or `SESSION_SECRET`), with `tracking:ip` as associated data. `visitor` and the IP lookup key are keyed HMACs, not plain hashes.
- Reverse DNS names are kept only when forward-confirmed: whoever runs an address can put any name in its PTR record.
- The browser-details page has a nonce CSP (`default-src 'none'`, `connect-src 'self'`), `Referrer-Policy: no-referrer` and `no-store`, and escapes the destination. Bots, previews, prefetches and HEAD requests always get the plain 302.
- The beacon token is `<click id>.<unix s>.<HMAC>`, valid 10 minutes and written once. The body is read as a stream and refused past 4 KB, and only whitelisted, size-checked fields are kept.
- `/_k` and `/_p/` sit behind the public rate limiter, like every public path.
- All SQL is bound; only zod-validated integers are interpolated for `LIMIT` / `OFFSET`.

## Costs on Workers Free

- D1: one row per tracked click or open, plus one for browser details, each with index entries. 100,000 rows written a day is roughly 20,000 tracked clicks.
- Subrequests: a tracked click adds one D1 write and, for people, up to three DNS-over-HTTPS lookups, all after the response. A rules change republishes 10 links per request on Free. The 03:30 run stays far below the 50-call limit.

## Accepted limits

- **"Without IP" is pseudonymous, not anonymous.** Whoever holds `ENCRYPTION_KEY` / `SESSION_SECRET` and the database could try all 2^32 IPv4 addresses against `visitor`, since the user agent is stored. People using the admin can't.
- **D1 write budget.** Tracked links and the pixel can be requested in bulk to spend it. The public rate limiter slows one client; a WAF rate-limit rule on the zone is the real protection.
- **Browser details hide the referrer from the destination.** The short page in between sends `Referrer-Policy: no-referrer`, so the destination's own analytics count those visits as direct. Shorthop's own click log still records the full referrer, and `?s=` / UTM tags still reach the destination.
- **Changing `ENCRYPTION_KEY`** makes stored IP addresses unreadable. They are short-lived, so they aren't re-encrypted.
- **Hints, not proof.** A VPN that isn't on the public list looks like an ordinary network; an office network can look like hosting; mobile networks can place a city far away.
- **Shorthop has no public privacy page.** Your own notice must describe tracked links; [docs/PRIVACY.md](PRIVACY.md#advanced-tracking) has wording to start from.

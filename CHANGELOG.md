# Changelog

What changed in each Shorthop release, and what to do when you upgrade.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Links: **Link no longer working**. Mark a link whose destination is gone and optionally pick a replacement link. Visitors get a 410 page with a button to the replacement's short link. Without a usable replacement, they're sent after a few seconds to the site set in Settings. The visit still counts for the original link. A "Not working" badge and status filter, `broken` and `replacement` in the API (`PATCH /links/:domain/:slug`, `GET /links?status=broken`, `GET /links/:domain/:slug/dependents`) and in the links CSV.
- Settings: a **"Link no longer working" page** card for the wording of both versions, where to send visitors, and the delay (3–60 seconds, 7 by default). A live preview can show the page with one of your links. The replacement itself is chosen per link, in its settings.
- **Full statistics** (`/_admin/stats`): every breakdown for all links together, the top 20 links, recent hits and a CSV export. API: `GET /stats/account`.
- Date ranges: Today · 7 days · 30 days · 90 days · **Custom…**, which offers 6, 9 and 12 months, All time, or any from–to dates (UTC). Used on Overview, Full statistics, link stats and Misses. The API takes `range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`.
- The status banner can be closed. It comes back when the set of problems changes.

### Changed

- Misses: separate switches for **human misses** (on by default), **scanner probes** and **bot-only misses**, each with its own limit. Saving removes stored misses of a kind you turn off.
- Misses: an address the browser loads while you type it counts as a human miss. For a working link, it still isn't counted as a click.
- A past custom period no longer includes today's live data.

### Fixed

- Changing or resetting the email setup also clears an old "alert couldn't be sent" from System status, and that check is hidden while email is turned off.

### Upgrading

- Run the new database migration (`npm run setup -- upgrade` does this) **before** the Worker is deployed. Otherwise saving a link fails.
- Saved miss-tracking settings are converted when they're read: "scanner probes and bot-only misses" becomes the two new switches, and human misses stay on.

## [1.0.2] - 2026-10-22

### Added

- Misses: **Latest misses, as recorded** lists the last 7 days of misses with how each was counted (human, a named bot, or the scanner rule), so you can see why a visit you made doesn't show in the table.
- Import: a **File format** card with an example CSV to download. `legacy_clicks` is recognized as a clicks column.
- Settings → Weekly digest → **Set up email**: every email service with its status, short steps with copyable commands, and which secrets are set. Switching services there needs no deploy; it overrides `DIGEST_PROVIDER` and `DIGEST_FROM` until you press **Use wrangler.jsonc**.
- Email through **Emailit**, or through **any other JSON email API** (`custom`, with `DIGEST_CUSTOM_URL`, `DIGEST_CUSTOM_API_KEY` and the optional `DIGEST_CUSTOM_AUTH` and `DIGEST_CUSTOM_BODY`).
- Each email service has its own key secret: `RESEND_API_KEY`, `EMAILIT_API_KEY`, `POSTMARK_API_KEY`, `SENDGRID_API_KEY`, `MAILGUN_API_KEY`.

### Changed

- New links have **Add UTM parameters** off by default, in the admin and in the API (`POST /links`). Send `"utm": true` to turn it on. Existing links keep their setting.
- Create link: the slug field is now **Custom slug (your own link ending)**, with a hint showing where your text goes.
- Misses: creating a link from a miss row clears that miss.
- Settings: the Publishing help says that every save already publishes on its own. Publish errors point to **Republish all links** instead of "Resync".
- Logging out ends that session on the server, so a copy of the cookie stops working. Changing the admin password ends every session.
- All logins pause only after 30 failures in an hour from 5 or more networks, so one network can no longer lock you out.
- Wrong API tokens lock the sending network after 10 in a minute; a locked network is refused before its token is checked.
- The API token no longer sees login activity or the digest recipient: `GET /api/settings` returns `security` and `digestTo` as `null`, and `GET /api/settings/mail` is admin-only.
- **Send test** works once a minute. A successful test, or a change in Set up email, clears an old "digest failed" on the status page.
- Referrers whose host isn't a valid hostname now count as direct visits.
- `expiresAt` and import `createdAt` must be Unix seconds before the year 10000 (milliseconds are refused).

### Fixed

- Misses: **Clear scanner probes** clears every stored probe, not just the ones listed, so probes past the noise limit no longer appear right after a clear. Probes requested later that day show again from the next day (UTC).
- The nightly rollup now applies clears even before a miss tracking policy has been saved, so re-rolling a day can't bring cleared misses back.
- A crafted `Referer` could make two "(other)" rows for one day and stop the nightly rollup for good. It can't anymore.
- The rollup no longer saves a day that Analytics Engine cut off at 10,000 rows: it reads a day at a time instead, and stops (and retries next run) if one day is still too large.
- A digest that timed out showed "23" as its reason and wasn't recorded on the status page. Provider error text no longer includes secrets.
- Set up email: **Use wrangler.jsonc** could leave the old choice in the form, and saving brought it back. **Off** and **webhook** can be saved without a sender.
- Deleting a domain's data stays under the KV limit per request on large domains.
- Editing a link while it's being deleted can no longer bring it back.
- A link pointing at the shortener itself with a trailing dot (`sh.example.`) is refused.
- The links CSV no longer fails on an out-of-range expiry date. The tag filter treats `%` and `_` literally.
- Sorting links by clicks finds the most clicked links even with more than 5,000 links.

### Upgrading

- Everyone is logged out once after this deploy: sessions now include the password hash.
- Older setups with `DIGEST_API_KEY` keep working for the service named in `DIGEST_PROVIDER`. To switch services in the admin, store each key under its own name (`npx wrangler secret put RESEND_API_KEY`, …) or run `npm run setup -- email`.
- Scripts that read `security` or `digestTo` from `GET /api/settings` with the API token get `null` now.

## [1.0.1] - 2026-10-22

### Added

- Links and Misses: click a column header to sort by it, and click again to flip the order.
- Links and Misses: pages of 25, 50 or 100 rows. Your browser remembers the page size. On Links, the sort and page are in the URL, so you can bookmark them.

### Fixed

- Scanners no longer show up as human misses. A visitor who misses 5 or more different paths in one UTC day now counts as a bot, whatever its user agent says.
- More scanner paths are recognized as probes, such as `yarn.lock`, `*.js.map`, `Dockerfile`, `docker-compose.yml`, `server-status` and `swagger`.
- More hosting networks are treated as datacenters, such as M247, Leaseweb, Hostinger, IONOS, netcup and Censys.

### Upgrading

- Days already rolled up keep their old miss counts. To start clean, click **Clear all** on the Misses page once after you deploy. Today's misses, and every day after, use the new rule.

## [1.0.0] - 2026-10-21

First release.

[1.0.2]: https://github.com/jntegz/shorthop/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jntegz/shorthop/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jntegz/shorthop/releases/tag/v1.0.0

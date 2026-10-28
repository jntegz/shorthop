# Changelog

What changed in each Shorthop release, and what to do when you upgrade.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-10-28

### Added

- **Websites:** analytics and revenue for your own sites. A small script (`/_t/script.js`) records visits, sources and channels, pages, goals (`data-sh-goal`, scroll goals with `data-sh-scroll`, or `shorthop("goal", …)`), outbound clicks and page speed (LCP, CLS, INP). Cookieless by default; a site can instead recognise returning visitors with a first-party ID, always or after consent, with an optional built-in consent banner (`data-consent-banner`). Pause tracking per site. Each site has a setup guide, a live install check, and notes for Content Security Policy.
- **Revenue:** payments from Stripe, Paddle, Lemon Squeezy, Dodo Payments, Creem, Gumroad, FastSpring and PayPal arrive as verified webhooks at `/_pay/<provider>/<connection>`, are converted at the day's ECB rate and matched to the visit that led to them (the visit reference passed through checkout, a return page, the same customer, an identified email, then checkout timing), with how sure each match is. Refunds, disputes, subscriptions (MRR, churn, new against renewal) and an import of past payments. A server API (`/api/sites/<id>/payments`, `/identify`) covers other billing. Connection secrets can be Cloudflare Worker secrets (only the name is saved) or stored encrypted. Seeing revenue needs the new **See revenue** permission; managing sites, **Manage websites**.
- **Site dashboard:** the path to money, a main chart (visitors, visits, pageviews, time per visit, goal conversion) compared with the period before and with traffic spikes marked, funnels, peak hours, reading time and scroll depth, path to purchase, customer value by first source, AI-assistant landing pages, and location, device, network and UTM breakdowns. Page, goal and outbound totals are copied to D1 every night, so they outlast Analytics Engine's 90 days.
- **Revenue per short link:** short links to a tracked site carry a signed click token (`?sh_c=`), so a link's page shows the visits and revenue it brought. Link stats also get a Networks breakdown.
- **Website alerts:** an email for each payment, hourly traffic-spike alerts, a daily summary, and `site.payment` / `site.traffic_spike` webhooks. The weekly digest lists each site's visitors and revenue.
- **Shared statistics:** a read-only page for one link at `/_share/<id>.<secret>`, with an optional end date, password (rate-limited and locked like protected links), period limit, recent clicks, and an automatic, light or dark theme. It never shows the destination, history or revenue. The Links list marks shared links and can filter by them.
- **Turning a link off** asks where visitors go meanwhile: the 404 page, your site, or another of your links. The Links list shows a Disabled badge saying where, with a Disabled filter.
- **Misses:** ignore a path for good, or send it to an existing link with a link picker. The Ignored tab clears, exports and imports its list as CSV. Creating a link from a miss keeps you on the page, to fix the next one.
- **Link health:** open a destination's link from its row, or edit it (a menu when several links share the destination).
- **Appearance:** an accent colour per browser (Settings → Access & security).
- **One-click updates for button installs:** an **Update Shorthop** workflow (Actions → Update Shorthop → Run workflow) brings a Deploy to Cloudflare copy to the latest release in a pull request, keeping its `wrangler.toml` ids, routes and vars and adding the new bindings (`scripts/setup/update-copy.ts`). A `.shorthop-keep` file lists files to leave alone.
- **Version notice:** System status shows the running version and says when a newer release is out (GitHub is asked at most once a day, through the Worker).
- **Secret scanning:** CI runs gitleaks over the full history.

### Changed

- **Phones:** the bottom bar has Overview, Stats, Links and Websites, and **More** opens the other pages, the account and log out. Wide tables become labelled rows, and pages no longer scroll sideways.
- The admin's spacing, type sizes and corners are tighter and more consistent; tab bars no longer show a scrollbar.
- A tab opened before a deploy reloads once when it asks for files the new deploy no longer has, and shows a short error page instead of a blank one.
- **Cron schedule:** the daily trigger now runs hourly at :15 (the daily rollup still at 01:15 UTC; website alerts the other hours). The half-hourly runs at 02:30 and 03:00 UTC copy website totals to D1 and fetch exchange rates and match payments, instead of checking destinations. Milestone webhooks and the health alert moved to the 02:00 cleanup run; the Monday digest run no longer checks health itself.
- Failed logins by people pause only people's logins, never the owners'.
- Click counts in the Links list and the digest preview need the **View statistics** permission.

### Fixed

- **Workers Free:** a rollup catching up two weeks, the Monday digest and the 02:00 cleanup could pass the 50 calls one invocation may make. The rollup writes each window in one batch instead of one per day, milestone events go out in one write, and unused uploads are deleted in one D1 call; a test now counts every scheduled run's calls.
- A new invite, or pausing someone, ends the reset link they'd asked for. Using a reset link no longer clears the network's wrong-password count. When the reset email can't be sent, they can ask again straight away.
- Link passwords need at least 8 characters, and a link locks for a while after 20 wrong passwords from anywhere. Previews, prefetches and HEAD requests on links with a click limit aren't sent on.
- Deleting a link answers 502 and keeps it when it can't be removed from KV, instead of failing halfway.

### Upgrading

- Run `npm run setup -- upgrade` **before** deploying. It applies migrations 0015–0024 and adds what Websites needs to `wrangler.jsonc` (your values are kept, and you see the diff first):
  - the `WEB` Analytics Engine dataset and the `AE_WEB_DATASET` var;
  - the `PUBLIC_LIMITER` and `COLLECT_LIMITER` rate limiters;
  - the hourly cron `"15 * * * *"` in place of `"15 1 * * *"`.

  A plain `npm run deploy` refuses an older `wrangler.jsonc` and names what's missing.
- Installed with the Deploy to Cloudflare button: run the **Update Shorthop** workflow in your copy and merge its pull request; the deploy applies the migrations ([docs/SETUP.md](docs/SETUP.md#update-button)). Copies from 1.1.1 and earlier don't have the workflow yet: add [`.github/workflows/update-shorthop.yml`](.github/workflows/update-shorthop.yml) to your copy once (Add file → Create new file), then run it. Or pull this version with git and keep the new entries when `wrangler.toml` conflicts.
- Websites read Analytics Engine with the same `CF_ACCOUNT_ID` and `CF_ANALYTICS_TOKEN` as link stats; without them, sites record visits but the dashboard can't show them.

## [1.1.1] - 2026-10-24

### Added

- **Recent hits** page (`/_admin/hits`, in the menu under All links, for people who can view statistics): the latest hits one row each, with time, link, type, location, device, source and referrer. Filter by slug, domain, type (clicks, bots, misses), country, device, time window (last hour to 30 days) and number of rows (50, 100 or 200); the filters stay in the URL, and clicking a country sets that filter. Hits are read live from Analytics Engine, so nothing is stored, and each load is one query. **Filter and see more** on the Recent hits cards opens it. API: `GET /stats/recent` accepts `event=click|bot|miss`, `country`, `device` and `hours` (1–720, 168 by default).
- **Link health → Check settings → Which links:** check only the links whose **Check that the destination works** switch is on (as before, the default) or all links, without switching each one on. The link form has a new **Never check this link** switch that keeps a link out of checks in both modes; **Stop checking** in the Fix dialog now sets it. API: links have a `neverCheck` field (create and update accept it), and `PUT /checks/settings` accepts `scope: "selected" | "all"`. No migration, and nothing changes until someone picks **All links**.

### Fixed

- **Recent hits** (Full statistics and a link's page) and **Latest misses, as recorded** (Misses) said "Not available … Analytics Engine isn't configured" even when it was: the query sorted by a column it didn't select, which the Analytics Engine SQL API rejects. When the query fails for some other reason (a token without access, a timeout), these cards now show the error instead of saying Analytics Engine isn't configured. API: `GET /stats/recent` then answers `aeAvailable: true` with an `error` message.
- **Workers Free:** one invocation may make 50 calls (fetches, KV, D1 and Durable Object calls alike), and several bulk jobs made more: Republish all links and Remove domain worked in pages of 200 KV writes, an import published up to 100 at once, the daily cron pruned up to 400 upload records, and a busy destination-check run could pass 50 with webhooks due. On Free these failed partway with "Too many subrequests"; after a default-UTM change, links on the default template kept the old tags. Every bulk job is now sized from `WORKERS_PLAN` (`src/worker/plan.ts`): Free gets pages of 40 links, imports of 20 rows per request, 10 destination checks and 2 webhook deliveries per run, and a rollup that continues over several runs when it has many days to catch up; Paid keeps the previous sizes. The import page splits files to the plan's size; the API answers `413` with the limit when a script sends more. The daily cleanup (login events, salts, expired keys, history, unused uploads) moved to the half-hourly cron's 02:00 UTC run, so it has an invocation to itself; no cron trigger changed.
- Protected links answer with the "try again" page while a Deploy to Cloudflare install can't read its generated `SESSION_SECRET` from D1, instead of an error.
- A click limit no longer loses a click when the counter answers after the visitor was already turned away: the click is given back.
- The daily cron's prune jobs log their failures as the other jobs do.

### Changed

- **Link no longer working** asks what visitors see: **Error page** (the "This link no longer works" page, then the site set in Settings) or **Another of my links** (the same page with a button to the link you pick). Before, the error page was the replacement list's "None" option. With **Another of my links**, the form doesn't save until a link is picked. Existing links open on the option they already use; the API is unchanged.
- The menu bar on phones centers its labels, so the ones that wrap onto two lines stay under their icons.
- **API lockouts** double up to an hour instead of a day (login lockouts still go up to a day), and a request with no `Authorization` header at all isn't counted as a wrong key. A network is often shared by several people and devices, and one script with a stale key mustn't lock the others out of the API for a day ([SECURITY.md](SECURITY.md)).
- "Admin password is not configured" now says what to do, for both ways of installing: set the `ADMIN_PASSWORD` secret under the Worker's Settings → Variables and Secrets, or run `npm run setup -- password`.
- `WORKERS_PLAN` is documented as sizing bulk work, not only the password hash cost; say `free` unless you pay for Workers.
- Deploy to Cloudflare: every field on the setup page has a note saying what to enter (most say to leave it as it is), and [docs/SETUP.md](docs/SETUP.md#deploy-form) has a table of all of them. Only the admin password needs filling in.

## [1.1.0] - 2026-10-24

### Added

- **Deploy to Cloudflare button** in the README: copies Shorthop into your GitHub or GitLab account, creates the KV namespace and the D1 database, asks for an admin password and deploys with Workers Builds. It starts on `workers.dev` with password-only sign-in; [docs/SETUP.md](docs/SETUP.md#deploy-button) shows how to add a domain, statistics, Access and email. Its config is `wrangler.toml`, generated from the same template as `wrangler.example.jsonc`.
- The owners' password can be the plain `ADMIN_PASSWORD` secret (at least 9 characters) when `ADMIN_PASSWORD_HASH` isn't set. Without the `SESSION_SECRET` or `VISITOR_SALT` secret, a random value is generated once and kept in D1.
- Links: **Link no longer working**. Mark a link whose destination is gone and optionally pick a replacement link. Visitors get a 410 page with a button to the replacement's short link. Without a usable replacement, they're sent after a few seconds to the site set in Settings. The visit still counts for the original link. The link shows as **Replaced** or **Retired**, with a status filter. In the API: `broken` and `replacement` (`PATCH /links/:domain/:slug`, `GET /links?status=broken`, `GET /links/:domain/:slug/dependents`), and in the links CSV.
- Settings: a **"Link no longer working" page** card for the wording of both versions, where to send visitors, and the delay (3–60 seconds, 7 by default). A live preview can show the page with one of your links. The replacement itself is chosen per link, in its settings.
- **Full statistics** (`/_admin/stats`): every breakdown for all links together, the top 20 links, recent hits and a CSV export. API: `GET /stats/account`.
- Date ranges: Today · 7 days · 30 days · 90 days · **Custom…**, which offers 6, 9 and 12 months, All time, or any from–to dates (UTC). Used on Overview, Full statistics, link stats and Misses. The API takes `range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`.
- **Comparison with the previous period** on all stats pages, and a previous-period line on the charts.
- Stats pages say when new clicks appear, have a Refresh button, and refresh every minute while in use.
- **Link health → Destinations:** once you press **Activate automatic checking** and choose how often (once a day, every 3 days, once a week, or 1 hour to 30 days), the destinations of the links you picked are checked as they come due, with redirects followed safely.
  - After 3 failures in a row a destination counts as not working: one email, a badge on the link, and a Fix dialog.
  - Sites that refuse automated checks show as "can't check" and never alert.
  - Each link has its own **Check that the destination works** switch, off for new and imported links. **Check now** works while automatic checking is off. Link health has a Refresh button.
- **History** on every link: each change is a version with who made it, and you can restore any earlier version. Deleted links can be restored for 90 days (Links → Recently deleted, or Undo after deleting).
- **Smart routing:** rules by device (iPhone & iPad, Android, desktop, other) and country, first match wins, with A/B splits across up to 10 weighted destinations.
  - A simulator in the editor, results per rule and variant on the link page, and `{variant}` in UTM templates.
  - Bots and previews get the default destination; no cookies.
- **Social previews:** your own title, description and image for LinkedIn, Slack, X, iMessage and other link previews, with mockups while editing and a button to start from the destination's own preview.
- **UTM builder and presets:** one field per parameter, saved presets, and a preview of the final URL.
- **QR studio:** colours with a contrast check, dot and corner shapes, a logo, frames with a caption, a live scan test, SVG/PNG up to 4096 px, print sheets, per-link and default designs, and a ZIP of every link's QR code.
- **Password-protected links** and **click limits**, counted exactly by a Durable Object. Bots and previews don't count.
- **Webhooks:** signed events for link created, updated, deleted, destination down or back, and click milestones, with retries and a delivery log.
- **People and roles:** add people in Settings → Access & security as admins, managers or users, and tick what each user may do (create, edit or delete links, statistics, Link health, workspace settings, API keys). Each person chooses their own password from a one-time invite link. Requires Cloudflare Access; without it, there's only the owner.
- People: **pause** someone's access until a date or until resumed, and **sign them out everywhere**.
- **Forgot your password?** on the login page for people added in Settings: a reset link, rate-limited, emailed to their Access address (or an admin is told when email can't reach them). Invite links can be emailed too. Without Access there's only the owner, so no link is shown.
- An optional **bot check** with Cloudflare Turnstile on the password pages (Settings → Access & security), with the `TURNSTILE_SECRET` secret. With Cloudflare Email Service, an optional `PEOPLE_MAIL` binding emails invites and resets (Workers Paid).
- Link form: the custom slug field shows the domain beside it and a preview of the short link.
- **Personal API keys** in Settings → API & webhooks. Each is limited to what you allow and never more than its owner can do, with optional expiry and "last used".
- Settings are split into tabs, with an **API** card (base URL, every endpoint, and what the older API token may do) and **My account**.
- The status banner can be closed. It comes back when the set of problems changes.

### Changed

- **Keep misses for** offers 30 days, 2 months or 3 months.
- Misses: separate switches for **human misses** (on by default), **scanner probes** and **bot-only misses**, each with its own limit. Saving removes stored misses of a kind you turn off.
- Misses: an address the browser loads while you type it counts as a human miss. For a working link, it still isn't counted as a click.
- A past custom period no longer includes today's live data.
- Recent logins shows the last 10, with who signed in. "Log out everywhere" is now **Log out everyone**.
- `API_TOKEN` is optional, and `npm run setup` no longer creates one: personal API keys are the recommended way to use the API. An existing token keeps working, with its scope.
- With the API token, domain removal and the email setup's secrets stay off limits; they're for people signed in to the admin. Reading a webhook's delivery log (whose payloads hold link destinations) needs `API_TOKEN_SCOPE` set to `"full"`.
- Until `SHORT_DOMAINS` has a domain, links can't be created or imported, and Settings → Short domains explains how to add one.

### Fixed

- Changing or resetting the email setup also clears an old "alert couldn't be sent" from System status, and that check is hidden while email is turned off.

### Upgrading

- Run `npm run setup -- upgrade` **before** deploying. It applies migrations 0002–0014 and adds what the new version needs to `wrangler.jsonc` (your values are kept, and you see the diff first):
  - the cron `"*/30 * * * *"`;
  - the `LINK_PASSWORD_LIMITER` rate limiter;
  - the `CLICK_CAPS` Durable Object with its `migrations` entry.

  A plain `npm run deploy` refuses an older `wrangler.jsonc` and names what's missing. The first deploy creates the Durable Object.
- Everyone signs in once more after deploying (new session cookie). People other than the owners are added in Settings → Access & security, and their emails must also be in the Access policy.
- Automatic destination checks start off, and so does every link's **Check that the destination works** switch, existing links included. Turn checking on under Link health → **Activate automatic checking**, choose how often, and switch it on for the links you want checked.
- "Keep misses for: 6 months" is no longer offered. It reads as 3 months, and misses older than that are removed after the next nightly rollup. To keep them, export them first: Link health → Missed visits → Export CSV.
- Saved miss-tracking settings are converted when they're read: "scanner probes and bot-only misses" becomes the two new switches, and human misses stay on.
- The visitor privacy notice ([docs/PRIVACY.md](docs/PRIVACY.md)) now mentions the cookie that password-protected links set. Update yours if you use password-protected links.
- Scripts and the iOS Shortcut can keep using `API_TOKEN`, or switch to a personal API key ([docs/ios-shortcut.md](docs/ios-shortcut.md)). Error messages now say "API key".

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

[1.2.0]: https://github.com/jntegz/shorthop/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/jntegz/shorthop/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/jntegz/shorthop/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/jntegz/shorthop/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jntegz/shorthop/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jntegz/shorthop/releases/tag/v1.0.0

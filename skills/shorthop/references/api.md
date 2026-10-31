# Shorthop API reference

Generated from the server's own catalog (`scripts/skill-reference.ts`). Base URL: `https://<admin host>/api`. Every request: `Authorization: Bearer shp_…`. The full OpenAPI document is at `GET /api/openapi.json`.

## Account

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /me` | Who the key acts as, its permissions, and the workspace basics | any key |

## Links

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /links` | List links with clicks in a period (up to 5,000) | any key |
| `POST /links` | Create a link (target or url is required). ?format=text returns just the short URL. | links.create |
| `GET /links/{domain}/{slug}` | One link with all its settings | any key |
| `PATCH /links/{domain}/{slug}` | Change any of a link's settings; only the fields sent change | links.edit |
| `DELETE /links/{domain}/{slug}` | Delete a link (restorable for 90 days) | links.delete |
| `GET /links/{domain}/{slug}/dependents` | Links that send their visitors to this one | any key |
| `GET /links/{domain}/{slug}/history` | A link's saved versions | any key |
| `POST /links/{domain}/{slug}/history/{id}/restore` | Put a link back the way it was in a version | links.edit |
| `GET /links/{domain}/{slug}/cap` | A capped link's click counter | any key |
| `POST /links/{domain}/{slug}/cap/reset` | Start a capped link's count again | links.edit |
| `GET /links/by-target` | Links that already go to a destination | any key |
| `POST /links/bulk` | Enable, disable, tag, untag or delete many links (20 per request on Workers Free, 100 on Paid) | links.edit or links.delete |
| `GET /deleted` | Recently deleted links | any key |
| `POST /deleted/{domain}/{slug}/restore` | Restore a deleted link | links.delete |
| `GET /tags` | Tags, with how many links have each | any key |
| `POST /tags/rename` | Rename a tag on every link, or merge it into another | links.edit |
| `DELETE /tags/{tag}` | Remove a tag from every link | links.edit |
| `POST /import` | Import links (20 rows per request on Workers Free, 100 on Paid) | links.create |
| `POST /resync` | Republish links to the edge, a page at a time; call again with next until it is null | links.edit or settings.manage |
| `GET /export/links.csv` | Links as CSV, optionally filtered | any key |
| `GET /export/links.json` | Every link with its settings, as import rows (never passwords) | any key |

## Sharing

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /links/{domain}/{slug}/shares` | A link's shared statistics pages | stats.view and links.edit |
| `POST /links/{domain}/{slug}/shares` | Share a link's statistics on a read-only page | stats.view and links.edit |
| `GET /shares` | Shared campaign reports (a tag or a set of links) | stats.view and links.edit |
| `POST /shares` | Share a report on every link with a tag, or a set of links (a tag or links is required) | stats.view and links.edit |
| `PATCH /shares/{id}` | Change or stop a share | stats.view and links.edit |
| `DELETE /shares/{id}` | Remove an ended share from the list | stats.view and links.edit |

## Statistics

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /stats/overview` | All links: totals, daily series, top links, countries, sources, devices, comparison | stats.view |
| `GET /stats/account` | The overview with every breakdown | stats.view |
| `GET /stats/links/{domain}/{slug}` | One link's statistics with every breakdown | stats.view |
| `GET /stats/peak-hours` | All links' clicks by weekday and hour (tz, days up to 89) | stats.view |
| `GET /stats/links/{domain}/{slug}/peak-hours` | One link's clicks by weekday and hour (tz, days up to 89) | stats.view |
| `GET /stats/live` | Human clicks with a city-level location in the last minutes (minutes, default 15; domain), for a live map | stats.view |
| `GET /stats/recent` | Latest hits (domain, slug, limit, event, country, device, hours) | stats.view |
| `GET /stats/export.csv` | Daily clicks per link as CSV | stats.view |

## Link health

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /stats/misses` | Addresses opened that have no link | health.manage |
| `POST /stats/misses/clear` | Clear missed-link counts | health.manage |
| `POST /stats/misses/ignore` | Stop listing missed paths, optionally sending them to a link | health.manage |
| `POST /stats/misses/unignore` | List ignored paths again | health.manage |
| `GET /stats/misses/ignored` | Ignored paths | health.manage |
| `GET /stats/misses/ignored.csv` | Ignored paths as CSV | health.manage |
| `POST /stats/misses/ignored/clear` | List every ignored path again | health.manage |
| `GET /stats/misses/export.csv` | Missed links as CSV | health.manage |
| `PUT /stats/misses/policy` | Which misses are recorded, and how many kept | settings.manage |
| `GET /checks` | Destination checks for every link | health.manage |
| `PUT /checks/settings` | Turn checks on or off, and how often | settings.manage |
| `POST /checks/recheck` | Check destinations with problems now | health.manage |
| `GET /checks/links/{domain}/{slug}` | One link's destination checks | any key |
| `POST /checks/links/{domain}/{slug}` | Check one link's destinations now | health.manage |

## Tools

| Endpoint | What it does | Permission |
|---|---|---|
| `POST /previews/images` | Upload a social-preview image (raw bytes, up to 5 MB) | links.create or links.edit |
| `POST /previews/fetch` | Read a page's own title, description and image | links.create or links.edit |
| `POST /previews/ai/slug` | Workers AI: slug ideas for a destination (501 without the AI binding) | links.create or links.edit |
| `POST /previews/ai/preview` | Workers AI: a preview title and description (501 without the AI binding) | links.create or links.edit |
| `GET /utm-presets` | Saved UTM templates | any key |
| `POST /utm-presets` | Save a UTM template | settings.manage |
| `PUT /utm-presets/{id}` | Change a UTM template | settings.manage |
| `DELETE /utm-presets/{id}` | Delete a UTM template | settings.manage |
| `GET /qr/default` | The default QR code design | any key |
| `PUT /qr/default` | Set the default QR code design | settings.manage |

## Webhooks

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /webhooks` | Webhooks and their delivery status | settings.manage |
| `POST /webhooks` | Add a webhook | settings.manage |
| `PUT /webhooks/{id}` | Change a webhook | settings.manage |
| `POST /webhooks/{id}/rotate` | Make a new signing secret | settings.manage |
| `DELETE /webhooks/{id}` | Delete a webhook | settings.manage |
| `POST /webhooks/{id}/test` | Send a test event | settings.manage |
| `GET /webhooks/{id}/deliveries` | The last deliveries | settings.manage |
| `POST /webhooks/deliveries/{delivery}/redeliver` | Send a delivery again | settings.manage |

## AI assistants

| Endpoint | What it does | Permission |
|---|---|---|
| `POST /mcp` | Model Context Protocol server (JSON-RPC): tools to create links and read statistics | any key |

## Websites

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /sites` | Tracked websites with visitors and revenue | stats.view |
| `POST /sites` | Add a website | sites.manage |
| `GET /sites/by-link/{domain}/{slug}` | Revenue a short link brought to your websites | revenue.view |
| `GET /sites/{id}` | One website's settings | stats.view |
| `PATCH /sites/{id}` | Change a website's settings | sites.manage |
| `DELETE /sites/{id}` | Delete a website and all its data | sites.manage |
| `GET /sites/{id}/overview` | Visitors, sessions, revenue and conversion, with a series | stats.view |
| `GET /sites/{id}/breakdown` | Visitors and revenue by one dimension | stats.view |
| `GET /sites/{id}/events` | Pages, goals or outbound links | stats.view |
| `GET /sites/{id}/goal-props` | The properties sent with a goal | stats.view |
| `GET /sites/{id}/live` | Visitors online now and the latest visits | stats.view |
| `GET /sites/{id}/peak-hours` | Visits, sales or revenue by weekday and hour | stats.view |
| `GET /sites/{id}/engagement` | Reading time and scroll depth per page | stats.view |
| `GET /sites/{id}/page-speed` | Core Web Vitals at the 75th percentile | stats.view |
| `GET /sites/{id}/purchase-paths` | How long new customers took, and where they came from | revenue.view |
| `GET /sites/{id}/customer-value` | Customer value by first source | revenue.view |
| `GET /sites/{id}/install-status` | Whether the tracker is sending visits | stats.view |
| `GET /sites/{id}/funnels` | Saved funnels | stats.view |
| `POST /sites/{id}/funnels` | Save a funnel | sites.manage |
| `DELETE /sites/{id}/funnels/{funnel}` | Delete a funnel | sites.manage |
| `GET /sites/{id}/funnels/{funnel}/report` | How many visitors reach each step | stats.view |

## Revenue

| Endpoint | What it does | Permission |
|---|---|---|
| `GET /sites/{id}/payments` | Payments and the visits they were matched to | revenue.view |
| `GET /sites/{id}/payments.csv` | Payments as CSV | revenue.view |
| `GET /sites/{id}/subscriptions` | MRR, new subscriptions and churn | revenue.view |
| `GET /sites/{id}/visitors/{visitor}` | One visitor's visits and payments | revenue.view |
| `POST /sites/{id}/rematch` | Try matching unmatched payments again | sites.manage |
| `POST /sites/{id}/payments` | Record a payment from your own backend (billing without a provider adapter) | sites.manage |
| `POST /sites/{id}/identify` | Tell who a visitor is, from your own backend | sites.manage |

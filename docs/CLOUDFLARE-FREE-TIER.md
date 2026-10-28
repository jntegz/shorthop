# Cloudflare free-tier guide

Reviewed against Cloudflare documentation on 19 October 2026. Shorthop uses the services below and assumes no paid subscription. Allowances change: check the linked pricing pages before you rely on them.

## What this app uses

| Service | Benefit here | Free allowance / condition |
| --- | --- | --- |
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | Redirects, authenticated API, admin shell | 100,000 requests/day; [10 ms CPU per HTTP request](https://developers.cloudflare.com/workers/platform/limits/). Account-wide usage matters. The daily limit is a hard cap: past it, every link fails with error 1027 until midnight UTC ([how to protect it](../SECURITY.md#daily-cap)). |
| [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) | React bundles, styles, brand icon | Static asset requests are free and unlimited. The private HTML shell intentionally runs the Worker for authentication. |
| [Workers KV](https://developers.cloudflare.com/kv/platform/pricing/) | Fast redirect lookups; uploaded social-preview images and QR logos | 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1,000 lists/day, 1 GB storage. Imports and republishing consume writes, one per link; an image upload is one more. Unused preview images are deleted daily. |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/) | Link records and historical analytics | 5 million rows read/day, 100,000 rows written/day, 5 GB account storage. [Each free database is capped at 500 MB](https://developers.cloudflare.com/d1/platform/limits/). Index writes also contribute to usage. |
| [D1 Time Travel](https://developers.cloudflare.com/d1/platform/limits/) | Recover accidental data changes | Automatic seven-day recovery history on Free. Restore through Cloudflare; after restoring link records, republish them to synchronize KV. |
| [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | Clicks, daily unique visitors, bots, countries, devices and sources; website visits in a second dataset | Published Free allowance: 100,000 data points/day and 10,000 read queries/day. The pricing page currently says billing is not yet active; check it before you rely on it. Stats pages that include today refresh every minute while in use and pause after 10 idle minutes, so an open tab doesn't spend the query budget. |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/) | Exact click counts for links with a click limit (`ClickCap`) | SQLite-backed, so available on Free: 100,000 requests/day and 5 GB storage. Used only by links with a limit: one request per click on those. |
| [Cloudflare Access](https://www.cloudflare.com/plans/) | Private admin login (optional, recommended) | Free plan for up to 50 users. Configure the application, identity policy, team domain and audience. The Worker verifies JWTs. |
| [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/) | Weekly digest and alerts to the owner (optional; other providers work too) | Delivery to verified destination addresses in your account is free on all plans. Arbitrary recipients require Workers Paid. Verify the destination and retain the restricted binding. |
| [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Daily analytics rollup (01:15 UTC), website alerts at :15 the other hours, weekly digest (Monday 07:00), destination checks and webhook retries every 30 minutes; that cron's 02:00 run does the daily cleanup and the health alert, its 02:30 run copies website totals to D1, and its 03:00 run fetches exchange rates and matches payments | 5 triggers per account on Free; Shorthop uses 3. Each run is a Worker invocation and counts toward the same limits as requests, including the 50 calls (fetch, KV, D1, Durable Objects) one invocation may make on Free; `WORKERS_PLAN=free` sizes each run to fit. |
| [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) | Deploys after every push, for installs from the Deploy to Cloudflare button | A monthly allowance of build minutes is included on Free. Not used with `npm run setup`. |
| [Workers Logs](https://developers.cloudflare.com/workers/platform/pricing/) | Diagnose failures | Free currently includes 200,000 log events/day with three-day retention. Logs and sampled traces are already configured. [Observability pricing changes on 1 December 2026](https://developers.cloudflare.com/observability/pricing/). |
| [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | Throttle failed API key attempts, admin password attempts, password-protected link attempts, shared statistics pages, payment webhooks and website events | 10 failed key attempts per minute per client IP, 5 admin password attempts per minute per client network, 10 attempts per minute per network on each protected link, 120 shared-statistics or payment-webhook requests and 300 website events per minute per network, at each Cloudflare location. The lockouts that count are kept in D1. None is a global billing quota or a substitute for Access. |

## Stay within the allowances

[SETUP.md](SETUP.md) and `npm run setup` create the resources, configure Access, the analytics token and email, and pick a password hash cost that fits your plan. The Settings page's Cloudflare card describes what each service does; it doesn't show live usage.

Use the Cloudflare dashboard to review Workers CPU and requests, KV writes, D1 size and row usage, and analytics queries. Free-plan limits can stop requests; an allowance is not a guarantee of unlimited service. Measure the admin, CSV imports, rollup catch-up, and redirects on the deployed runtime before you move real traffic: local tests do not enforce production CPU limits. Plan large imports and full republishing around the KV daily write allowance. Long-term analytics eventually need a storage-retention policy to stay below the per-database cap.

### Destination checks, people and keys

- **Destination checks** are off until you activate them on Link health. Then every 30 minutes up to 25 destinations are checked, within 50 outbound requests per run (40 for checks, the rest for webhook deliveries and an alert email), and at most 2 pages of one site per run.
  - That's about 900 routine checks a day. When the chosen frequency can't cover every destination, the interval stretches automatically: daily at 900 destinations, every 5 days at 4,500.
  - They write at most about 1,200 D1 rows a day, which is fine on Free with thousands of links.
- **Websites** on Free: the 02:30 run copies up to 7 days of page, goal and outbound totals to D1 (Paid: 30), the 03:00 run converts 5 payments and retries 2 unmatched ones (Paid: 500 and 300), and each hourly run checks 2 sites for traffic spikes and daily summaries. A website visit is one Analytics Engine data point per pageview or event; sessions and payments are D1 rows.
- **An admin request** costs one D1 round trip for the session: one query for owners, two in one batch for everyone else.
- **An API key** costs one D1 read per request, plus at most one write per key per hour for "last used".

## Get value without extra services

- Static bundles bypass the Worker and use immutable browser caching. The admin page and the API still go through the Worker for authentication and are never cached.
- QR codes (designs, the scan test, print sheets and the ZIP of every link) and CSV parsing happen in the browser; they need no paid image or file-storage service.
- D1 summaries preserve analytics history after raw Analytics Engine events expire: link clicks in `daily_stats`/`daily_dims`, and website pages, goals and outbound links in `web_daily_events`. No separate analytics subscription is needed within applicable limits.
- Website visits record what Cloudflare already provides on every plan (`request.cf`): country, region, city, continent, time zone and the network's operator. Page speed (Core Web Vitals) is measured by the script itself, so Cloudflare Web Analytics isn't needed for it.
- TLS and zone protections come with the domain. Avoid challenge pages (such as Under Attack mode) on short domains: they interrupt every visitor's redirect.

Turnstile would be useful for a future public submission form, but the current creation API is private. R2, Queues, AI, and media services should be introduced for a concrete feature, with their own usage budget, rather than enabled merely because an allowance exists. Paid Workers is an optional capacity choice, not an automatic dependency of the design.

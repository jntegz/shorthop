# Cloudflare free-tier guide

Reviewed against Cloudflare documentation on 19 October 2026. Shorthop uses the services below and assumes no paid subscription. Allowances change: check the linked pricing pages before you rely on them.

## What this app uses

| Service | Benefit here | Free allowance / condition |
| --- | --- | --- |
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | Redirects, authenticated API, admin shell | 100,000 requests/day; [10 ms CPU per HTTP request](https://developers.cloudflare.com/workers/platform/limits/). Account-wide usage matters. The daily limit is a hard cap: past it, every link fails with error 1027 until midnight UTC ([how to protect it](../SECURITY.md#daily-cap)). |
| [Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) | React bundles, styles, brand icon | Static asset requests are free and unlimited. The private HTML shell intentionally runs the Worker for authentication. |
| [Workers KV](https://developers.cloudflare.com/kv/platform/pricing/) | Fast redirect lookups | 100,000 reads/day, 1,000 writes/day, 1,000 deletes/day, 1,000 lists/day, 1 GB storage. Imports and republishing consume writes. |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/) | Link records and historical analytics | 5 million rows read/day, 100,000 rows written/day, 5 GB account storage. [Each free database is capped at 500 MB](https://developers.cloudflare.com/d1/platform/limits/). Index writes also contribute to usage. |
| [D1 Time Travel](https://developers.cloudflare.com/d1/platform/limits/) | Recover accidental data changes | Automatic seven-day recovery history on Free. Restore through Cloudflare; after restoring link records, republish them to synchronize KV. |
| [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) | Clicks, daily unique visitors, bots, countries, devices and sources | Published Free allowance: 100,000 data points/day and 10,000 read queries/day. The pricing page currently says billing is not yet active; check it before you rely on it. |
| [Cloudflare Access](https://www.cloudflare.com/plans/) | Private admin login (optional, recommended) | Free plan for up to 50 users. Configure the application, identity policy, team domain and audience. The Worker verifies JWTs. |
| [Email Service](https://developers.cloudflare.com/email-service/platform/pricing/) | Weekly digest and alerts to the owner (optional; other providers work too) | Delivery to verified destination addresses in your account is free on all plans. Arbitrary recipients require Workers Paid. Verify the destination and retain the restricted binding. |
| [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | Daily analytics rollup and weekly digest | Each run is a Worker invocation and counts toward the same limits as requests. |
| [Workers Logs](https://developers.cloudflare.com/workers/platform/pricing/) | Diagnose failures | Free currently includes 200,000 log events/day with three-day retention. Logs and sampled traces are already configured. [Observability pricing changes on 1 December 2026](https://developers.cloudflare.com/observability/pricing/). |
| [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | Throttle failed API-token attempts and admin password attempts | 10 failed token attempts per minute per client IP, and 5 password attempts per minute per client network, at each Cloudflare location. The password lockout that counts is kept in D1. Neither is a global billing quota or a substitute for Access. |

## Stay within the allowances

[SETUP.md](SETUP.md) and `npm run setup` create the resources, configure Access, the analytics token and email, and pick a password hash cost that fits your plan. The Settings page's Cloudflare card describes what each service does; it doesn't show live usage.

Use the Cloudflare dashboard to review Workers CPU and requests, KV writes, D1 size and row usage, and analytics queries. Free-plan limits can stop requests; an allowance is not a guarantee of unlimited service. Measure the admin, CSV imports, rollup catch-up, and redirects on the deployed runtime before you move real traffic: local tests do not enforce production CPU limits. Plan large imports and full republishing around the KV daily write allowance. Long-term analytics eventually need a storage-retention policy to stay below the per-database cap.

## Get value without extra services

- Static bundles bypass the Worker and use immutable browser caching. The admin page and the API still go through the Worker for authentication and are never cached.
- QR SVG/PNG creation and CSV parsing happen in the browser; they need no paid image or file-storage service.
- D1 summaries preserve analytics history after raw Analytics Engine events expire. No separate analytics subscription is needed within applicable limits.
- TLS and zone protections come with the domain. Avoid challenge pages (such as Under Attack mode) on short domains: they interrupt every visitor's redirect.

Turnstile would be useful for a future public submission form, but the current creation API is private. R2, Queues, AI, and media services should be introduced for a concrete feature, with their own usage budget, rather than enabled merely because an allowance exists. Paid Workers is an optional capacity choice, not an automatic dependency of the design.

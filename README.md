# Shorthop

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 22.12+](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)](package.json)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com/)

A personal URL shortener that runs on one Cloudflare Worker. Short links on your own domains, click analytics without a paid geo service, a private admin, and a weekly email digest. For most personal use it fits inside Cloudflare's free allowances.

**Shorthop is built primarily for Cloudflare.** It uses Workers, Workers KV, D1, Analytics Engine, Cloudflare Access and Cloudflare Email Service directly; it isn't a portable app with a Cloudflare adapter. You need a Cloudflare account and at least one domain on it.

![The Shorthop dashboard: clicks, unique visitors and bots over the last 30 days](docs/images/dashboard.png)

- **Fast redirects:** one KV read, then a `302`. Analytics is written after the response, so it never slows down or breaks a click.
- **Analytics:** country, region, city, device, OS, browser, referrer, source tag and language per click. Humans, bots and misses are counted separately. No IP addresses or cookies are stored. Unique visitors are counted with a daily hash whose random salt is deleted once the day is over. See [visitor privacy](docs/PRIVACY.md).
- **History:** a daily job saves each day into D1, so stats outlive Analytics Engine's 90-day retention.
- **Admin at `/_admin`:** create, edit, disable, expire, tag and search links; per-link and overall stats; QR codes; CSV import and export; a report of missed slugs; a custom 404 page; a System status page with setup checks.
- **API at `/api`:** Bearer-token access for scripts and an [iOS Shortcut](docs/ios-shortcut.md). By default the token can read and create links, not change or delete them.
- **Several domains:** each short domain has its own slugs and stats. The admin can live on the primary domain or on a separate host.
- **Weekly digest and alerts:** by Cloudflare Email Service, Resend, Postmark, SendGrid, Mailgun or a signed webhook.

| Links | Link statistics |
|---|---|
| ![All links with tags, click counts and status](docs/images/links.png) | ![One link's statistics, QR code and edit actions](docs/images/link-detail.png) |
| **Short domains** | **Custom 404 page** |
| ![Settings → Short domains: the domain list, Remove, and a guided setup for a new domain](docs/images/settings-domains.png) | ![The not-found page visitors see for an unknown slug](docs/images/not-found.png) |

<sub>Screenshots from local development with `npm run seed:dev` sample data.</sub>

## Quick start

You need Node.js 22.12+, a Cloudflare account, and a domain whose DNS is on Cloudflare (a spare subdomain of a domain you already have works too).

```sh
git clone https://github.com/jntegz/shorthop.git
cd shorthop
npm ci
npx wrangler login
npm run setup
```

`npm run setup` asks for your domains, how to protect the admin, your admin password and how to send email. It then creates the KV namespace and D1 database, writes `wrangler.jsonc`, uploads the secrets, deploys, and checks the result. It's safe to re-run, and parts of it can be run on their own (`npm run setup -- email`, `-- access`, `-- password`, ...). Add `--dry-run` to see what it would do without changing anything.

The full manual, including every Cloudflare dashboard step, is in **[docs/SETUP.md](docs/SETUP.md)**.

## Documentation

- **[Setup manual](docs/SETUP.md):** [requirements](docs/SETUP.md#what-you-need), [domains](docs/SETUP.md#domains), [Cloudflare Access](docs/SETUP.md#access), [email](docs/SETUP.md#email), [troubleshooting](docs/SETUP.md#troubleshooting), [updating](docs/SETUP.md#updating), [moving from another shortener](docs/SETUP.md#import), [uninstalling](docs/SETUP.md#uninstalling)
- **[Cloudflare free tier](docs/CLOUDFLARE-FREE-TIER.md):** what each service allows and what Shorthop uses
- **[iOS Shortcut](docs/ios-shortcut.md):** shorten a link from the share sheet
- **[Visitor privacy](docs/PRIVACY.md):** what Shorthop records about visitors, for your privacy notice
- **[Security](SECURITY.md):** reporting a vulnerability, protections and a hardening checklist

## Costs

Shorthop doesn't assume a paid plan. On Workers Free you get 100,000 requests a day, 1,000 KV writes a day (each link save is one), and 10 ms of CPU per request; the setup tunes the admin password hash to fit. Cloudflare Access is free for up to 50 users, and Email Service is free when sending to a verified address in your own account. Workers Paid ($5/month) raises the limits. See [docs/CLOUDFLARE-FREE-TIER.md](docs/CLOUDFLARE-FREE-TIER.md) for every service and its allowance.

On Free, the daily requests are a hard cap for the whole account: once they're used up, every short link fails until midnight UTC, and anyone can use them up by sending requests. Add a rate-limiting rule ([SECURITY.md](SECURITY.md#daily-cap)), and choose Paid if your links must not go down.

## Security model

- **Admin:** Cloudflare Access (verified in the Worker, not only at the edge) plus an admin password, by default. Password-only sign-in is possible, but only with the exact setting `ADMIN_AUTH="password"`; any other gap in the configuration keeps the admin closed. See [SECURITY.md](SECURITY.md).
- **Password login:** at least 9 characters (the setup generates a 32-character one by default), PBKDF2-SHA256, a signed `__Host-` session cookie bound to the signed-in identity, lockouts per network that double with each lockout, and a global brake. IP addresses are never stored, only a keyed hash.
- **API:** a Bearer token compared in constant time; failed attempts are rate-limited per IP. By default the token can read and create links but not change or delete them, so a lost token can't retarget links people already have (`API_TOKEN_SCOPE`).
- **Secrets:** stored as Wrangler secrets. The setup sends them to Cloudflare through stdin and never writes them to disk. The admin never displays them.
- **Redirects:** targets must be `https://` and can't point back at the shortener.

## Local development

```sh
npm ci
npm run setup -- local        # writes .dev.vars with random dev secrets
npm run db:migrate:local
npm run seed:dev              # optional: sample links and 120 days of fake stats
npm run dev                   # http://localhost:5173/_admin/
```

Without `wrangler.jsonc`, local development uses `wrangler.example.jsonc`. On localhost, `DEV_AUTH_BYPASS=1` skips Cloudflare Access (the password is still asked for if one is set). It's ignored on every other host.

```sh
curl -sI 'localhost:5173/guide?s=li'                               # 302 with UTM parameters
curl -sI localhost:5173/nope                                       # the 404 page
curl 'localhost:5173/cdn-cgi/handler/scheduled?cron=15+1+*+*+*'    # run the daily rollup
```

Analytics Engine can't be queried locally, so "today" stays empty in dev. Earlier days come from D1, which the seed script fills.

### Checks

```sh
npm run typecheck        # tsc -b across shared, worker, admin and scripts
npm test                 # Workers-runtime tests (Vitest) and Node tests for the setup
npm run build            # needs wrangler.jsonc, or SHORTHOP_ALLOW_EXAMPLE_CONFIG=1
npm run config:example   # rewrite wrangler.example.jsonc after changing the config template
npm run types            # then regenerate worker-configuration.d.ts
```

## Configuration

`npm run setup` writes `wrangler.jsonc` (gitignored) from the template in `scripts/setup/template.ts`; `wrangler.example.jsonc` shows its shape with placeholder values. Vars live in the config; secrets are Wrangler secrets.

| Name | Kind | Purpose |
|---|---|---|
| `SHORT_DOMAINS` | var | Short domains, primary first (`go.example.com,go.example.net`). Each has a custom domain route |
| `ADMIN_HOST` | var | Optional separate host for the admin and the API. Empty: the primary domain |
| `FALLBACK_URL` | var | Where `/` goes, and clicks when the link store can't be read. Referrals from its host count as source "site" |
| `ADMIN_AUTH` | var | `access+password` (default; empty means the same) or `password`. Anything else locks the admin |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | var | Cloudflare Access team domain and application AUD tag |
| `ADMIN_EMAIL` | var | The Access identities allowed in (comma-separated) |
| `CF_ACCOUNT_ID` | var | For Analytics Engine SQL queries |
| `AE_DATASET` | var | The Analytics Engine dataset name (letters, digits, `_`) |
| `WORKERS_PLAN` | var | `free` or `paid`; System status checks the password hash cost against it |
| `API_TOKEN_SCOPE` | var | `create` (default): the API token reads, creates links and imports new ones. `full`: it can also change and delete links and settings. Anything else means `create` |
| `KV_CACHE_TTL` | var | Edge cache for slug lookups in seconds (default 60; values under 30 fall back to 60) |
| `DIGEST_PROVIDER` | var | `cloudflare`, `resend`, `postmark`, `sendgrid`, `mailgun`, `webhook` or `off` |
| `DIGEST_FROM`, `DIGEST_TO` | var | Sender and the only recipient of the digest and alerts |
| `DIGEST_MAILGUN_DOMAIN`, `DIGEST_MAILGUN_REGION` | var | Mailgun only |
| `DEV_AUTH_BYPASS` | var | `1` only in `.dev.vars`: skips Access on localhost. Ignored on any other host |
| `API_TOKEN` | secret | Bearer token for `/api` |
| `VISITOR_SALT` | secret | Mixed into the visitor hash, together with a random salt per day that's deleted once the day is over |
| `ADMIN_PASSWORD_HASH` | secret | PBKDF2 hash of the admin password |
| `SESSION_SECRET` | secret | Signs admin sessions; rotating it logs everyone out |
| `CF_ANALYTICS_TOKEN` | secret | Optional: API token with Account Analytics Read, for stats |
| `DIGEST_API_KEY` | secret | Resend, Postmark, SendGrid or Mailgun API key |
| `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_SECRET` | secret | Webhook endpoint and its HMAC key |

## How requests are routed

| Path | Handled by |
|---|---|
| `/{slug}` | KV lookup of `<domain>/<slug>`, then a 302, or the 404 page (logged as a miss) |
| `/` | 302 to `FALLBACK_URL` (or to `/_admin/` on a separate admin host) |
| `/_admin` | 301 to `/_admin/` |
| `/_admin/login`, `/_admin/logout` | The password step: a server-rendered form, lockouts, signed session cookie |
| `/_admin`, `/_admin/**` | Access JWT (unless password-only) and the password session, then the admin app with a strict CSP |
| `/_admin/assets/*`, `/robots.txt`, `/favicon.ico` | Static assets, served without running the Worker |
| `/_admin/api/*` | The API for the admin app: CSRF check, identity and session |
| `/api/*` | The same API with a Bearer token (read and create only, unless `API_TOKEN_SCOPE` is `full`) |
| `/health` | `ok` |

Asset routing uses `html_handling: "none"`, `not_found_handling: "none"` and `run_worker_first: ["/_admin/*", "!/_admin/assets/*"]`. Don't turn on SPA mode: browser navigations to slugs would stop reaching the Worker.

## Project layout

```
_admin/index.html          admin app entry (builds to dist/client/_admin/)
migrations/                D1 schema
public/                    robots.txt, favicon, brand icon
scripts/setup/             npm run setup: the wizard, config template, deploy guard
scripts/                   import, check-slugs, seed-dev, hash-password
src/shared/                slug rules, domains, UTM handling, schemas, API types, brand, cron schedule
src/worker/index.ts        entry: request dispatch and cron handlers
src/worker/redirect.ts     the click path
src/worker/auth.ts         Access JWT, sign-in mode, session and Bearer token checks
src/worker/health.ts       System status, setup checks and alert emails
src/worker/api/            links, stats and settings routes
src/client/                admin app (React, Vite, Tailwind, TanStack Query, Recharts)
test/                      Workers-runtime tests; test/node: setup tests
docs/                      SETUP.md, CLOUDFLARE-FREE-TIER.md, PRIVACY.md, ios-shortcut.md, images/ (README screenshots)
```

## Design notes

- **302, not 301:** browsers cache 301s, which would skip the Worker on repeat clicks, lose the data, and make links impossible to retarget.
- **A 60-second KV cache:** a cached value, including a cached "not found", lives until its TTL ends. At 60 seconds, edits reach everyone within about a minute.
- **Daily uniques:** the visitor hash covers the IP address, user agent and date, with a secret salt and a random salt for that day. The daily job deletes each day's salt once the day is over, so afterwards nobody, the owner included, can work out whose visit a hash was. Hashes can't be followed across days. Stats show the sum of daily uniques.
- **Imported links** keep `http://` targets and get no UTM tags, so they redirect exactly as before. New links must be `https://`.
- **Bots** still get the redirect but are counted separately, by user agent, HEAD and prefetch requests, and datacenter networks. iCloud Private Relay is deliberately not flagged.

## FAQ

**Why does it redirect with 302 and not 301?**
Browsers and some proxies keep a 301 forever. After the first click, the browser would skip Shorthop: changing a link's target, disabling it or letting it expire would no longer reach people who clicked before, and their repeat clicks wouldn't be counted. A 302 keeps every link editable and every click measured. Search engines still follow 302s to the target. There's no per-link 301 option for these reasons.

**What does it cost?**
Usually nothing. A personal shortener fits inside Workers Free (100,000 requests and 1,000 link saves a day). See [Costs](#costs) and [docs/CLOUDFLARE-FREE-TIER.md](docs/CLOUDFLARE-FREE-TIER.md).

**How do I add or remove a domain?**
Add one with `npm run setup -- domains` and deploy; Settings → Short domains walks through the DNS and checks it live. To remove one, use **Remove** in Settings → Short domains: it deletes the domain's links, stats and missed paths after you type the domain name. Then take it out with `npm run setup -- domains` (or edit `SHORT_DOMAINS` and `routes` in `wrangler.jsonc`) and deploy. The Worker can't change its own configuration.

**What are the password rules?**
At least 9 characters. The setup offers a generated 32-character password by default, which is the better choice, especially with [password-only sign-in](docs/SETUP.md#password-only). Wrong passwords are slowed down by per-network lockouts and a global brake.

**How long are stats kept?**
Analytics Engine keeps raw clicks for about 90 days; a daily job copies each finished day into D1, where it stays until you delete it. "Today" is read live from Analytics Engine.

**What is the demo data in my local admin?**
`npm run seed:dev` fills your local database with five sample links and 120 days of fake stats, so the admin has something to show. It never touches a deployed Worker. Remove it in Settings → Short domains; it also goes on its own once you configure a real domain.

**Can I use it without Cloudflare?**
No. Shorthop is built on Workers, KV, D1 and Analytics Engine directly.

## Author

Built by [Jan Tegze](https://jantegze.com).

## License

[MIT](LICENSE)

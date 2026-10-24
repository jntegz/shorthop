# Setting up Shorthop on Cloudflare

This guide takes you from nothing to a running Shorthop. Shorthop is built primarily for Cloudflare: it runs on one Worker and uses Workers KV, D1, Analytics Engine, Cloudflare Access and Cloudflare Email Service. `npm run setup` does most of the work; this manual explains each step, the Cloudflare dashboard parts the wizard can't do for you, and what to do when something goes wrong.

Contents: [What you need](#what-you-need) · [Put your domain on Cloudflare](#zone) · [Free or Paid](#plan) · [The Deploy to Cloudflare button](#deploy-button) · [Run the setup](#run-the-setup) · [Domains](#domains) · [Cloudflare Access](#access) · [Password-only sign-in](#password-only) · [Admin password](#password) · [People and roles](#people) · [API keys](#api-keys) · [Storage and analytics](#analytics) · [Email](#email) · [Secrets](#secrets) · [Deploy](#deploy) · [Troubleshooting](#troubleshooting) · [Updating](#updating) · [Moving from another shortener](#import) · [Uninstalling](#uninstalling)

<a id="what-you-need"></a>
## What you need

- **Node.js 22.12 or newer** and git.
- **A Cloudflare account.** The free plan is enough to start.
- **A domain on Cloudflare**, or one you can move there. Short links need a hostname you control, such as `go.example.com` or a short domain of its own. A subdomain of a domain you already use is fine.
- **About 20 minutes**, most of it in the Cloudflare dashboard for Access and email.

Using the [Deploy to Cloudflare button](#deploy-button) instead? Then you need only a Cloudflare account and a GitHub or GitLab account to start, and a domain once you want short links on it.

```sh
git clone https://github.com/jntegz/shorthop.git
cd shorthop
npm ci
npx wrangler login        # opens the browser; allow the requested permissions
```

`npx wrangler whoami` shows which account you're logged in to. If you use several Cloudflare accounts, the setup asks which one to use.

<a id="zone"></a>
## Put your domain on Cloudflare

Every short domain, and the admin host if you use a separate one, must be in a **zone in the same Cloudflare account** as the Worker. Skip this if the domain is already there.

1. Dashboard → **Add a domain** → enter the domain (not a subdomain) → the Free plan is fine.
2. Cloudflare imports your existing DNS records. Check them against your current DNS provider, especially MX and TXT records for email.
3. At your registrar, replace the nameservers with the two Cloudflare shows you.
4. Wait until the zone shows **Active** (minutes to a few hours). The setup refuses domains that aren't zones in the account.

You don't need to create any DNS record for the short links: the deploy attaches each hostname to the Worker as a **custom domain**, which creates the DNS record and the certificate.

<a id="plan"></a>
## Free or Paid

| | Workers Free | Workers Paid ($5/month) |
|---|---|---|
| Requests | 100,000 a day, account-wide | 10 million a month included |
| CPU per request | 10 ms | 30 s |
| KV writes | 1,000 a day (one per link save or republish) | 1 million a month included |
| Admin password hash | 25,000 PBKDF2 iterations | 100,000 iterations |
| Calls per invocation | 50 (every fetch, KV, D1 and Durable Object call counts) | 10,000 |
| Bulk work, sized to that | Republish and remove-domain pages of 40 links, imports of 20 rows per request, 10 destination checks per run | Pages of 200, imports of 100, 25 checks per run |

A personal shortener usually fits Free. The setup asks which plan you're on and writes it to `WORKERS_PLAN`, which does two things: it picks the password hash cost (PBKDF2 at 100,000 iterations can exceed Free's 10 ms CPU limit and make logins fail), and it sizes every bulk job to the plan's calls-per-invocation limit, so a republish, an import, a domain removal or a cron run never fails halfway with "Too many subrequests". Say Free unless you pay for Workers: a Free account set to Paid gets pages too large for it. You can switch later: change the plan in Cloudflare, then run `npm run setup`, pick the new plan and choose a new password. [CLOUDFLARE-FREE-TIER.md](CLOUDFLARE-FREE-TIER.md) lists every service's allowance.

On Free, the 100,000 requests are a hard daily cap: once they're used up, every short link fails until midnight UTC. Add the rate-limiting rule from [SECURITY.md](../SECURITY.md#daily-cap); choose Paid if your links must not go down.

<a id="deploy-button"></a>
## The Deploy to Cloudflare button

The button in the README is the quickest start: no Node.js, no terminal. It installs a smaller Shorthop that you complete later:

- it runs on `workers.dev`;
- sign-in is password-only;
- email is off.

The steps below add the rest.

**What it does**

1. It copies Shorthop into a new repository on your GitHub or GitLab account. This is a copy, not a fork: it can be private.
2. It creates the KV namespace and the D1 database, and writes their ids into your copy's `wrangler.toml`.
3. It asks for one secret, `ADMIN_PASSWORD`. Use at least 9 characters; a long random one from your password manager is best, because it alone protects the admin.
4. It deploys with Workers Builds. Builds are free within Cloudflare's monthly allowance. Every later push to your copy deploys again, and each deploy applies new database migrations first.

The session secret and the visitor salt are generated on the first request and kept in D1.

<a id="deploy-form"></a>
**Filling in the setup page**

Cloudflare's setup page lists about 20 fields. **Only the admin password needs you.** Every other field already holds a working value, and each has a short note on the page. You can change any of them later in `wrangler.toml`.

| On the page | What to enter | Why |
|---|---|---|
| Git account | Your GitHub or GitLab account | Where your copy of Shorthop is created |
| Repository name | `shorthop`, or any name | Your copy. Making it private is fine |
| Project / Worker name | Leave `shorthop` | It becomes the address: `shorthop.<your-subdomain>.workers.dev` |
| KV namespace, D1 database | Leave the suggested names | They're created for you, empty |
| **`ADMIN_PASSWORD`** | **A long random password**, at least 9 characters | It's the only lock on the admin until you add Cloudflare Access. A password manager can make one |
| `FALLBACK_URL` | Your website, such as `https://www.example.com` (optional) | Where people go who open the short domain itself, without a link |
| `WORKERS_PLAN` | Leave `free`, unless you pay for Workers | Big jobs (imports, checks) are sized to fit your plan |
| `CF_ACCOUNT_ID` | Leave empty, or paste your account ID | Needed later to read click statistics |
| `ADMIN_AUTH` | **Leave `password`** | Anything else locks the admin until Cloudflare Access is set up |
| `SHORT_DOMAINS` | Leave empty | You add your domain after the deploy, together with a route (below) |
| Everything else (`ACCESS_…`, `ADMIN_EMAIL`, `ADMIN_HOST`, `KV_CACHE_TTL`, `AE_DATASET`, `API_TOKEN_SCOPE`, `DIGEST_…`, `DEV_AUTH_…`) | Leave as it is | For features you turn on later (Access, email) or for local development |
| Build and deploy commands | Leave as they are | They come from Shorthop's `package.json` |

So for a typical first install you type one thing, the password, and press the deploy button at the bottom of the page.

**After the deploy**

Open `https://shorthop.<your-subdomain>.workers.dev/_admin/` and sign in with the password. Dashboard → **System status** lists what's left. Links can't be created until you add a short domain: a link saved under a placeholder would be stranded when you did.

**Add your short domain.** The domain must be a zone in the same Cloudflare account ([Put your domain on Cloudflare](#zone)). In your copy of the repository, edit `wrangler.toml` (on GitHub, open the file and press the pencil icon):

```toml
workers_dev = true
preview_urls = false
routes = [{ pattern = "go.example.com", custom_domain = true }]   # uncomment, with your domain

[vars]
SHORT_DOMAINS = "go.example.com"         # the same domain; more, comma-separated
FALLBACK_URL = "https://www.example.com" # where "/" goes: your own site
```

Commit, and Workers Builds deploys it. The custom domain gets its DNS record and certificate within a few minutes. The admin is then at `https://go.example.com/_admin/`; the `workers.dev` address keeps working too. Settings → Short domains checks the domain live.

**Statistics.** Clicks are recorded from the start. To read them:

1. Put your account ID in `CF_ACCOUNT_ID` in `wrangler.toml`.
2. Add a `CF_ANALYTICS_TOKEN` secret ([the analytics token](#analytics)): Workers & Pages → your Worker → Settings → **Variables and Secrets** → Add → Secret. Secrets stay across deploys; vars come from `wrangler.toml`.

**Everything else** is set the same way, in `wrangler.toml` (vars) or as secrets in the dashboard:

- **Cloudflare Access and people:** create the Access application ([Cloudflare Access](#access)). Then set `ADMIN_AUTH = "access+password"`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ADMIN_EMAIL`.
- **Email:** Settings → Statistics & email → **Set up email** shows each provider's steps. Its keys are secrets. Cloudflare Email Service also needs a `send_email` binding: copy it from `wrangler.example.jsonc`.
- **A hashed password:** run `npx tsx scripts/hash-password.ts --generate` anywhere you have Node.js, put the output in an `ADMIN_PASSWORD_HASH` secret, then delete `ADMIN_PASSWORD`. Changing either one signs everyone out.
- **Your own session secret or visitor salt:** add `SESSION_SECRET` (32+ random characters) or `VISITOR_SALT` as secrets, and they replace the generated ones. A new session secret signs everyone out, and webhook secrets then need rotating.

**Updates.** Your copy doesn't follow this repository by itself. To update, pull the new version into a clone of your copy and push:

```sh
git remote add upstream https://github.com/jntegz/shorthop.git
git pull upstream main     # keep your values when wrangler.toml conflicts
git push
```

Read the [changelog](../CHANGELOG.md)'s Upgrading notes first: a new version can add bindings to `wrangler.toml`.

**Limits.** Shorthop uses 3 of the 5 cron triggers an account has on Workers Free.

## Run the setup

```sh
npm run setup
```

It walks through these steps. Each is explained in the sections below.

1. **Account:** checks the Wrangler login and picks the account.
2. **Worker:** its name (default `shorthop`), the Analytics Engine dataset name, and your plan.
3. **Domains:** short domains, an optional admin host, and the fallback URL. It checks each hostname is in one of your zones and isn't attached to another Worker.
4. **Admin sign-in:** Cloudflare Access plus a password (recommended), password only, or decide later.
5. **Admin password:** generated or typed; hashed for your plan.
6. **Analytics token:** optional, checked against the Analytics Engine API.
7. **Email:** provider, sender and recipient.
8. **Storage:** finds or creates the KV namespace and the D1 database.
9. **Config:** shows the changes to `wrangler.jsonc` and writes it after you confirm.
10. **Secrets:** generates the session secret and visitor salt, and uploads every secret in one request through stdin. Nothing is written to disk. (It no longer creates an `API_TOKEN`: scripts use [personal API keys](#api-keys).)
11. **Deploy:** builds, applies the database migrations, deploys.
12. **Checks:** `/health`, that the admin is protected, optionally that the API accepts a personal key, and an optional test email.
13. **Summary:** the admin URL and the generated password, **shown once**. Save it in your password manager.

The setup is **re-runnable**: it reads its earlier answers back from `wrangler.jsonc` and keeps existing secrets unless you choose to replace them. To change one part later:

| Command | Changes |
|---|---|
| `npm run setup -- domains` | Short domains, admin host, fallback URL |
| `npm run setup -- access` | Cloudflare Access settings, or switch to password-only |
| `npm run setup -- password` | A new admin password |
| `npm run setup -- analytics` | The Analytics Engine token |
| `npm run setup -- email` | Email provider, sender, recipient, keys |
| `npm run setup -- secrets --rotate` | New session secret, and a new `API_TOKEN` if you still have one (`--salt`: the visitor salt too) |
| `npm run setup -- deploy` | Build, migrate, deploy, check |
| `npm run setup -- check` | Test the live deployment |
| `npm run setup -- local` | Write `.dev.vars` for local development |
| `npm run setup -- upgrade` | After updating the code: re-render the config, migrate, deploy |

Add `--dry-run` to any of them to print the commands and the config it would write, without changing your account.

<a id="configuration"></a>
### The fallback URL

`FALLBACK_URL` is where visitors land when they open a short domain's root (`/`), and where a click goes if the link store can't be read. Usually it's your website. Referrals from that site (and its subdomains) show up as the source "site" in the stats. It must be `https://`.

<a id="domains"></a>
## Domains

- **Short domains** (`SHORT_DOMAINS`) are listed primary first. Each one has its own slugs: `go.example.com/guide` and `go.example.net/guide` can lead to different places. New links default to the primary domain.
- **The admin host** (`ADMIN_HOST`) is optional. Without it, the admin and the API live on the primary short domain under `/_admin` and `/api`. With it (for example `admin.example.com`), they live there instead, and that host serves no short links.

During the setup, each hostname is checked:

- **It must be in a zone of this account.** If not, see [Put your domain on Cloudflare](#zone).
- **It must not belong to another Worker.** Deploying would move it, so the setup stops and tells you which Worker has it. Detach it there (Workers & Pages → that Worker → Settings → Domains & Routes), or pick another hostname.
- **Existing DNS records are listed.** A, AAAA and CNAME records on the hostname itself conflict with the custom domain. During the deploy Wrangler asks before replacing them: answer yes only for hostnames you expect. MX and TXT records, and records on other names such as `www`, are not affected.

**Adding a domain later:** run `npm run setup -- domains`, add it to the list, and deploy. The admin's Settings → Short domains has a live check that shows whether the nameservers, DNS and certificate are ready.

**Removing a domain:** in Settings → Short domains, choose **Remove** next to it and type the domain name to confirm. This permanently deletes the domain's links (from KV and D1), its click stats and its missed paths; export your links first (Links → Export CSV) if you might want them back. Clicks already in Analytics Engine are hidden, so a later rollup can't bring them back. Then run `npm run setup -- domains`, take the domain off the list, and deploy: until then it still reaches the Worker and answers with the not-found page. To retire the primary domain, put another one first in the list.

**Demo data:** `npm run seed:dev` marks the sample links it creates in your local database. Settings → Short domains shows them with a **Remove demo data** button, and they're removed automatically once `SHORT_DOMAINS` holds a real domain besides the seeded one.

**Turn on Always Use HTTPS** for each zone (SSL/TLS → Edge Certificates) so `http://` links upgrade before they reach the Worker.

<a id="access"></a>
## Cloudflare Access (recommended)

With Access, nobody reaches the admin's login page without first proving they own your email address, and the Worker verifies Access's signed token on every admin request. The admin password is then a second lock. Access is free for up to 50 users.

The setup prints these steps and asks for the values at the end.

1. Open the **Zero Trust** dashboard: <https://one.dash.cloudflare.com>. The first time, pick a **team name** (it becomes `yourteam.cloudflareaccess.com`) and the Free plan.
2. **Settings → Authentication → Login methods → Add new → One-time PIN.** Access then emails you a code to sign in. You can add Google, GitHub or another identity provider instead.
3. **Access → Applications → Add an application → Self-hosted.**
   - Application name: anything, such as "Shorthop admin".
   - Add **two** public hostnames on your admin host (the primary short domain if you have no separate admin host):
     - domain `admin.example.com`, path `_admin`
     - domain `admin.example.com`, path `_admin/*`

     Access treats `_admin` and `_admin/*` as different paths, so add both. **Don't protect the whole domain, not even a separate admin host:** short links must stay public, and `/api` uses its own token. With Access in front of `/api`, scripts and the iOS Shortcut get Access's sign-in page instead of an answer.
   - Session duration: 24 hours is a good default.
4. **Policies → Add a policy:** Action **Allow**, Include → **Emails** → your email address. Save the application.
5. Under the application's advanced settings, keep the cookie **SameSite** at **Lax** and **HttpOnly** on. (The admin's own session cookie is the strict one.)
6. Open the application's overview and copy the **Application Audience (AUD) Tag**, a 64-character hex string.

Then give the setup:

- **Team domain:** `yourteam` or `yourteam.cloudflareaccess.com`. The setup checks that it serves Access signing keys.
- **AUD tag:** from step 6.
- **Allowed emails:** the address(es) from step 4 (`ADMIN_EMAIL`). The Worker refuses any other Access identity, even one your policy lets through.

To set it up later: `npm run setup -- access`. Until then, with Access selected but not configured, the admin stays closed (it "fails closed").

<a id="password-only"></a>
## Password-only sign-in

If you don't want Access, choose **Password only** in the setup (`ADMIN_AUTH="password"`). The admin is then protected by the password alone. Only that exact value turns Access off: empty Access settings without it keep the admin closed, and a typo such as `"Password"` locks the admin.

What changes:

- **The login page is public.** Anyone who finds `/_admin/login` can try passwords. They're slowed by the lockout (5 wrong passwords within 15 minutes lock a network for a minute, doubling up to 24 hours; 30 failures an hour from 5 or more networks pause every login for 15 minutes), but nothing stops them from trying.
- **Someone with several networks can keep you from signing in.** That global pause applies to you too: by failing from 5 or more networks every 15 minutes, an attacker can block new logins. One network alone can't trigger it. Sessions you already have keep working. Access avoids this, because nobody reaches the login page without your email.
- **Use a long random password.** The setup accepts any password of at least 9 characters, but the generated one (32 characters) is the right choice.
- **Add a rate-limiting rule** for `/_admin/login` in the Cloudflare WAF. See [SECURITY.md](../SECURITY.md).
- The admin shows a "Cloudflare Access off" warning in Settings → Access & security and in System status. It isn't emailed as an alert, unless Access settings are left filled in (then it's a configuration warning).

Switching to Access later is `npm run setup -- access`. Existing password-only sessions stop working when Access is on, so you'll sign in again.

<a id="password"></a>
## Admin password

A typed password needs at least 9 characters; the generated one is 32 random characters and is the better choice. The password is stored only as a PBKDF2-SHA256 hash (`ADMIN_PASSWORD_HASH`), with 25,000 iterations on Workers Free or 100,000 on Paid. A login lasts 12 hours. Logging out ends that session on the server too, and changing the password ends every session. Settings → Access & security → **Log out everyone** ends every session of every person.

- **New password:** `npm run setup -- password`. It takes effect right away and signs out existing sessions.
- **Forgot it:** the same command; you don't need the old one.
- **Locked out by wrong passwords:** wait (the lock doubles from 1 minute up to 24 hours), or clear all locks:

  ```sh
  npx wrangler d1 execute DB --remote --command "DELETE FROM auth_failures"
  ```

<a id="people"></a>
## People and roles

The owners are the emails in `ADMIN_EMAIL`. They can do everything, sign in with the admin password, and can't be changed or locked out from the admin. Anyone else is added in Settings → Access & security → **People**:

- **Admin:** everything, including people and security.
- **Manager:** adds, changes and removes users, and can give only the permissions they have themselves.
- **User:** views and copies links, plus what you tick: create, edit or delete links; statistics; Link health and missed visits; workspace settings; personal API keys.

**Adding someone** creates a one-time invite link (`/_admin/invite/…`). It works for 24 hours and only for their Access email, and they choose their own password with it (at least 12 characters). Shorthop can email it to them, or you send it yourself. Also add their email to the Access policy ([Cloudflare Access](#access), step 4): Access lets them reach the admin, and their role decides what they can do there. Changes apply on their next click.

- **Forgot their password:** they press **Forgot your password?** on the login page. A reset link goes to their Access address, works once for 1 hour, and their current password keeps working until they use it. Asking is limited: one link per 15 minutes, 3 a day per person, 5 an hour per network, and 20 an hour in all. If email can't reach them, an admin is told instead. An admin or manager can also reset it from the person's ⋯ menu, which signs them out.
- **Pausing someone:** stops their sign-in, sessions and API keys until a date, or until someone presses Resume, and keeps everything else. **Sign out everywhere** ends their sessions without pausing them.
- **Removing someone:** ends their sessions and API keys at once. Take them out of the Access policy too.

**Emailing people** (invites and reset links) uses the email setup from Settings → Statistics & email. Resend, Emailit, Postmark, SendGrid, Mailgun and a custom API can send to anyone. Cloudflare Email Service sends the digest only to `DIGEST_TO`; to email people with it, add a `PEOPLE_MAIL` binding (Email Sending, Workers Paid; it's commented out in `wrangler.example.jsonc`). Without email, you copy the links yourself.

**Bot check (optional).** Cloudflare Turnstile can ask everyone on the login, forgot-password, invite and reset pages to pass a quick, usually invisible check:

1. In the Cloudflare dashboard, open **Turnstile → Add widget** and add your admin host.
2. Paste the site key in Settings → Access & security → **Bot check**.
3. Store the secret key with `npx wrangler secret put TURNSTILE_SECRET`.
4. Press **Test and turn on**. It only turns on once a check passes.

With Access in front it's rarely needed. With password-only sign-in, where anyone can reach the login page, it's worth turning on. If it locks you out: `npx wrangler d1 execute DB --remote --command "DELETE FROM settings WHERE key = 'turnstile'"`.

People need Cloudflare Access: it's how they are told apart. With [password-only sign-in](#password-only), everyone who knows the admin password is the owner, and People stays empty.

Locally, set `DEV_AUTH_EMAIL` in `.dev.vars` to someone's email to see the admin as they do.

<a id="api-keys"></a>
## API keys

Scripts, the [iOS Shortcut](ios-shortcut.md), and tools such as Zapier or Make use **personal API keys**. Create one in Settings → API & webhooks → **Create API key**:

- Give it a name and tick only what it needs. A key can never do more than its owner can at the moment it's used.
- Optionally, let it expire after 30, 90 or 365 days.
- The key (`shp_…`) is shown once. Only a SHA-256 hash of it is stored.

Revoke a key in the same place. Keys stop working when their owner is removed or loses the API permission. Keys can't manage people, other keys or sessions. Settings shows when each was last used (updated at most once an hour).

The older `API_TOKEN` secret still works if you set it, sent the same way (`Authorization: Bearer …`). By default it can read, create links and import new ones; with `API_TOKEN_SCOPE` set to `"full"` it can do everything an owner can. New installs don't get one. If yours still uses it, move your scripts to a key and run `npx wrangler secret delete API_TOKEN`.

<a id="analytics"></a>
## Storage and analytics

The setup creates these for you:

| Resource | Name | Holds |
|---|---|---|
| Workers KV namespace | `<worker>-links` | The read copy of every link, used by redirects |
| D1 database | `<worker>` | Links (the source of truth), daily stats, settings, login state |
| Analytics Engine dataset | `AE_DATASET` (default `<worker>_clicks`) | One data point per click; created on the first write |
| Durable Object `ClickCap` | (none) | Exact click counts for links with a click limit; created on the first deploy, used only by those links |

Three cron triggers run the Worker's jobs: the daily rollup (01:15 UTC), the weekly digest (Mondays 07:00 UTC) and the destination checks with webhook retries (every 30 minutes; the 02:00 UTC run does the daily cleanup of old login events, salts, expired keys, history and unused uploads instead). Each run is one invocation, sized to the plan ([Free or Paid](#plan)). Workers Free allows 5 triggers per account.

It reads the KV and D1 ids back from Wrangler's list commands and writes them into `wrangler.jsonc`. A config without them can't be deployed: `npm run deploy` refuses it, because Wrangler would otherwise create new, empty resources.

### The analytics token

Clicks are always recorded. To **read** them (the stats pages, and the nightly rollup that saves each day into D1), the Worker needs an API token:

1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Create Custom Token**.
2. Permissions: **Account → Account Analytics → Read**.
3. Account Resources: **Include → your account** only.
4. Create it and copy the token.

Give it to the setup when asked, or later with `npm run setup -- analytics`. The setup tests it against the Analytics Engine SQL API before saving it as the `CF_ANALYTICS_TOKEN` secret. Without it, System status shows "Analytics Engine" as a warning and stats stay empty. Analytics Engine keeps raw clicks for about 90 days, but the first rollup saves only the last 7 days into D1: add the token within a week of deploying to keep the full history.

<a id="email"></a>
## Email: the weekly digest and alerts

Every Monday at 07:00 UTC, Shorthop emails a summary of the past week. When a check on the System status page starts failing (for example the nightly rollup), it emails an alert, and again once everything is OK. Email always goes to the single address in `DIGEST_TO`; nothing in the admin or the API can change the recipient.

Choose a provider in the setup or with `npm run setup -- email`. You can also switch later without a deploy: Settings → Statistics & email → Weekly digest → **Set up email** lists every provider with what's missing, shows the steps and commands for each, and saves your choice. `DIGEST_PROVIDER` and `DIGEST_FROM` in `wrangler.jsonc` are the defaults; a choice saved in the admin overrides them until you press **Use wrangler.jsonc**. API keys still go in with `wrangler secret put`, which takes effect right away; press **Check again** after adding one.

### Cloudflare Email Service (`cloudflare`)

No extra account. The sender must be on a domain in your Cloudflare account.

- The setup runs `wrangler email sending enable <sender domain>`, which adds the SPF and DKIM records to the zone.
- It adds `DIGEST_TO` as a **destination address** under Email Routing and waits while you click the verification link Cloudflare emails you. Sending to verified addresses in your own account is free on all plans.
- The config gets a `send_email` binding restricted to that one address.

If the digest fails with `E_SENDER_NOT_VERIFIED`, the DNS records may still be propagating; try again later. Check Email → Email Routing → Destination addresses for the verification state.

### Resend, Emailit, Postmark, SendGrid or Mailgun

1. Verify your sender's domain with the provider (they give you DNS records to add; add them in the Cloudflare zone).
2. Create an API key that can only send email.
3. Give the setup the sender, recipient and key, or save the key yourself under that provider's name:

```sh
npx wrangler secret put RESEND_API_KEY     # or EMAILIT_API_KEY, POSTMARK_API_KEY, SENDGRID_API_KEY, MAILGUN_API_KEY
```

Each provider has its own secret, so you can keep several and switch in the admin; a key is only ever sent to its own provider. `DIGEST_API_KEY` from older setups still works, for the provider named in `DIGEST_PROVIDER` only.

Mailgun also needs its sending domain (`DIGEST_MAILGUN_DOMAIN`) and region (`us` or `eu`); the setup and the admin ask.

Emailit: until your workspace is verified, it can only send to workspace members' account addresses. That's enough when `DIGEST_TO` is your account address.

<a id="custom"></a>
### Any other email API (`custom`)

For services with an HTTPS JSON API that isn't built in (Brevo, MailerSend, SMTP2GO, ZeptoMail, your own relay):

```sh
npx wrangler secret put DIGEST_CUSTOM_URL       # the send endpoint, https:// only
npx wrangler secret put DIGEST_CUSTOM_API_KEY
```

By default the key goes in `Authorization: Bearer <key>` and the body is `{"from","to":[...],"subject","html","text"}`, like Resend. For anything else, describe it in `vars` and deploy:

```jsonc
// Brevo
"DIGEST_CUSTOM_AUTH": "api-key: {key}",
"DIGEST_CUSTOM_BODY": "{\"sender\":{\"email\":\"{from_email}\",\"name\":\"{from_name}\"},\"to\":[{\"email\":\"{to}\"}],\"subject\":\"{subject}\",\"htmlContent\":\"{html}\",\"textContent\":\"{text}\"}"
```

Placeholders in the body: `{from}` (`Name <email>`), `{from_email}`, `{from_name}`, `{to}`, `{subject}`, `{html}`, `{text}`; in the header: `{key}`. Values are filled into the parsed JSON, so email content can't change its structure. The setup keeps both vars when it rewrites `wrangler.jsonc`.

<a id="webhook"></a>
### Signed webhook (`webhook`)

For n8n, Zapier, Make or your own relay. The Worker POSTs each email (the digest and alerts alike) as JSON to your HTTPS endpoint:

```json
{ "type": "shorthop.digest", "from": { "email": "...", "name": "Shorthop" }, "to": "...", "subject": "...", "html": "...", "text": "..." }
```

The URL is stored as a secret (hook URLs often work as passwords). The setup generates `DIGEST_WEBHOOK_SECRET` and shows it once. Every request carries:

```
X-Shorthop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

Your receiver should recompute the HMAC, compare it in constant time, and reject a `t` more than 5 minutes old:

```js
import crypto from "node:crypto";

function verify(rawBody, header, secret) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest();
  return crypto.timingSafeEqual(Buffer.from(m[2], "hex"), expected);
}
```

### Off (`off`)

No email; pick **Off** in the admin or the setup. Problems only show on the dashboard.

### How keys are protected

API keys, the custom and webhook URLs and the webhook secret are Wrangler secrets; the admin shows only the provider names, whether each secret is set, and whether it's ready. The admin can pick a provider and the sender, never a URL, a key or the recipient. Which secrets are set is shown only to people signed in to the admin. An API key can change the choice only with the workspace settings permission; the older API token only with `API_TOKEN_SCOPE` set to `full`. Provider hosts are fixed in the code and each key only goes to its own provider; redirects are refused so credentials can't follow one, and requests time out after 10 seconds.

Test it from the admin (Settings → Statistics & email → Weekly digest → **Send test**) or at the end of the setup.

<a id="secrets"></a>
## Secrets

| Secret | Created by | Rotate with |
|---|---|---|
| `API_TOKEN` | optional: older installs (40 random characters) | `npm run setup -- secrets --rotate`, then update scripts and the iOS Shortcut. Better: switch them to [personal API keys](#api-keys) and delete it |
| `SESSION_SECRET` | the setup (button installs: generated in D1) | `npm run setup -- secrets --rotate`. This logs everyone out, also signs visitors out of password-protected links, and makes webhook secrets unreadable: rotate each webhook's secret afterwards (Settings → API & webhooks) |
| `VISITOR_SALT` | the setup | `npm run setup -- secrets --rotate --salt` (visitors already counted today may be counted again) |
| `ADMIN_PASSWORD_HASH` | the setup | `npm run setup -- password` |
| `ADMIN_PASSWORD` | the Deploy to Cloudflare button | the Worker's Settings → Variables and Secrets. Used only without `ADMIN_PASSWORD_HASH` |
| `CF_ANALYTICS_TOKEN` | you, in the dashboard | `npm run setup -- analytics` |
| `TURNSTILE_SECRET` | you, optional ([bot check](#people)) | `npx wrangler secret put TURNSTILE_SECRET`, then test it again in Settings |
| `RESEND_API_KEY` (and the other providers' keys), `DIGEST_CUSTOM_URL`, `DIGEST_CUSTOM_API_KEY`, `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_SECRET` | you / the setup | `npm run setup -- email` |

The setup uploads secrets with one `wrangler secret bulk` call, passing them through stdin, so they never touch the disk or your shell history. Secret changes take effect immediately. To set one by hand: `npx wrangler secret put <NAME>`.

A generated password is printed **once**, at the end of the setup.

<a id="deploy"></a>
## Deploy

The setup deploys for you. Later, after changing code or config:

```sh
npm run setup -- deploy     # build, migrate, deploy, check
# or, step by step:
npm run db:migrate:remote
npm run deploy              # refuses wrangler.jsonc if ids are missing or domains are placeholders
```

On the first deploy, Cloudflare attaches each hostname and issues its certificate; this can take a few minutes. Wrangler shows its own prompts in your terminal, for example before replacing a DNS record.

Afterwards, open `https://<admin host>/_admin/`. Dashboard → **System status** lists anything still missing, each with the command that fixes it. Destination checks are off until you press **Activate automatic checking** on Link health and choose how often they run, and each link is checked only once its **Check that the destination works** switch is on.

<a id="troubleshooting"></a>
## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `https://<domain>/health` doesn't answer | DNS or the certificate is still on its way (wait a few minutes), or the zone isn't Active yet. Workers & Pages → your Worker → Settings → Domains & Routes shows each custom domain's state |
| "Hostname already has externally managed DNS records" during deploy | An A/AAAA/CNAME record exists on the hostname. Let Wrangler replace it, or delete it in the zone's DNS settings |
| The setup says a hostname belongs to another Worker | Detach it from that Worker first, or pick another hostname |
| Admin shows "Access denied: Admin access is not configured" | Access is on but `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` or `ADMIN_EMAIL` is empty: `npm run setup -- access` |
| Admin shows "This account is not allowed" | You signed in to Access with an email that isn't in `ADMIN_EMAIL` and isn't in Settings → People |
| "Add a short domain first" when creating a link | `SHORT_DOMAINS` is empty, as after the [Deploy to Cloudflare button](#deploy-button): add your domain |
| The API or the iOS Shortcut gets a sign-in page or `HTTP 302` | Cloudflare Access covers `/api`. Edit the Access application so it protects only the paths `_admin` and `_admin/*`, not the whole domain ([Cloudflare Access](#access)) |
| Admin shows "Admin password is not configured" | `npm run setup -- password`, or on a Deploy to Cloudflare install set the `ADMIN_PASSWORD` secret (9 or more characters) under the Worker's Settings → Variables and Secrets |
| "Too many subrequests" in the logs, or Republish all links, an import or Remove domain fails partway | `WORKERS_PLAN` says `paid` on a Free account: set it to `free` and deploy ([Free or Paid](#plan)) |
| Import answers `413` "Import at most 20 rows per request" | A script sends more rows than the plan allows per request; the admin's import page already splits files to fit. Send smaller batches, or set `WORKERS_PLAN` to `paid` if you are on Paid |
| `ADMIN_AUTH must be empty, "access+password" or "password"` | A typo in `ADMIN_AUTH` in `wrangler.jsonc`; fix it and deploy |
| Logins fail or time out on Workers Free | The password hash is too expensive for 10 ms CPU: set the plan to Free in the setup, then `npm run setup -- password` |
| Stats are empty | No analytics token (`npm run setup -- analytics`), or no clicks yet. "Today" is never shown in local dev |
| The digest isn't sent | Dashboard → System status names the problem. With Cloudflare Email Service, check the destination address is verified |
| A new link shows the 404 page | Someone opened it before it was created, and KV caches that miss where it was opened for up to `KV_CACHE_TTL` seconds (60 by default). Wait that long, or try from another location |
| "Missing required secrets" on deploy | A secret upload failed: `npm run setup` re-uploads what's missing |
| Locked out by wrong passwords | See [Admin password](#password) |

Logs: Workers & Pages → your Worker → **Logs** (structured JSON). Failed logins are logged as `admin login failed` with a keyed hash of the network, never the IP address.

<a id="updating"></a>
## Updating

```sh
git pull
npm ci
npm test
npm run setup -- upgrade
```

`upgrade` re-renders `wrangler.jsonc` with the new version's template (your values are kept, and you see the diff before it's written), applies new database migrations and deploys. Run it **before** `npm run deploy`: a plain deploy refuses a `wrangler.jsonc` that lacks bindings the new version uses. Read the [changelog](../CHANGELOG.md)'s Upgrading notes too.

Installed with the button? See [updates](#deploy-button) there.

<a id="import"></a>
## Moving from another shortener

Imported links keep `http://` destinations and get no UTM tags, so they behave as before; their old click counts are shown as "Clicks before import". Mind the KV write allowance on Workers Free: 1,000 links a day.

**1. Rehearse locally.** Save your links as a JSON array of `{ "domain", "slug", "target" }` (see `ExportRow` in `scripts/lib.ts`), then import them into the local dev server and compare every slug with the old service:

```sh
npm run setup -- local && npm run db:migrate:local && npm run dev     # in one terminal
SHORTHOP_TOKEN=<a key from the local admin's Settings → API & webhooks> npx tsx scripts/import.ts --base http://localhost:5173 --data data/links.json
npx tsx scripts/check-slugs.ts --base http://localhost:5173 --data data/links.json --live --probe
```

`--live` asks the old service for each slug, and `--probe` shows how it treats letter case, trailing slashes and query strings. The import skips slugs that already exist; `--overwrite` replaces their targets instead, which needs a key with **Edit links** (the older API token only with `API_TOKEN_SCOPE="full"`), or use Admin → **Import links**.

**2. Move production.** The short domains switch to Shorthop when you deploy (Wrangler asks before it replaces the old service's DNS records), so have the import ready and run it straight after:

1. Run the setup and deploy.
2. Import right away: `SHORTHOP_TOKEN=<API key> npx tsx scripts/import.ts --base https://<admin host> --data data/links.json` takes seconds for a few hundred links. Until it finishes, visitors see the not-found page. (Or upload the old service's CSV export in Admin → **Import links**, mapping its columns.)
3. Check every slug on its live domain: `npx tsx scripts/check-slugs.ts --per-domain --data data/links.json`.

<a id="uninstalling"></a>
## Uninstalling

```sh
npx wrangler delete <worker name>                       # the Worker and its custom domains
npx wrangler d1 delete <worker name>                    # the database (links and stats are gone for good)
npx wrangler kv namespace delete --namespace-id <id>    # the id is in wrangler.jsonc (or wrangler.toml)
```

Then delete the Access application in Zero Trust, the analytics API token in your profile, and, if you used Cloudflare Email Service, the destination address under Email Routing. Analytics Engine data expires on its own after about 90 days.

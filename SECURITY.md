# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue. Include the steps to reproduce and the version (commit) you tested. Reporters are credited unless they prefer otherwise.

Shorthop is a personal project without a bug bounty.

## How Shorthop protects itself

- **Admin (`/_admin`):** by default, Cloudflare Access plus a password. The Worker verifies the Access JWT itself (issuer, audience, RS256 signature) on every request, so a misconfigured Access application or a direct request can't bypass it. Only owners (`ADMIN_EMAIL`) and people added in the admin get in. The password session is bound to the identity it was issued to.
- **People and permissions:** every API route has a permission rule, checked in the Worker after sign-in. A route without one is refused, and a test fails until it has one. Owners use the admin password. Everyone else chooses their own (PBKDF2, at least 12 characters) from a one-time invite link, which is stored only as a SHA-256 hash and works for 7 days, once, for one Access email. Each person has their own session epoch, so a reset, a pause or a removal ends their sessions at once. Without Access there is only the owner.
- **Password resets:** a reset link goes only to the person's Access address, never to a typed one, and is stored as a SHA-256 hash. It works once, for 1 hour, and asking for one doesn't change the current password. Requests are limited per person (one per 15 minutes, 3 a day), per network (5 an hour) and in all (20 an hour), and wrong links lock the network like wrong passwords. Owners reset theirs through the Worker secret. Without Access there's no self-service reset.
- **Optional bot check:** Cloudflare Turnstile on the login, forgot-password, invite and reset pages, verified in the Worker with `TURNSTILE_SECRET`. It turns on only after a test passes. If Cloudflare can't be reached, logins still work, and the lockouts still apply.
- **Fail closed:** missing or malformed configuration keeps the admin shut. Access is only turned off by the exact value `ADMIN_AUTH="password"`; empty Access settings without it, or any other value, return an error.
- **Password login:** PBKDF2-SHA256 (25,000 or 100,000 iterations), constant-time comparison, a signed `__Host-` cookie with `SameSite=Strict`, CSRF checks, 5 attempts per network before a lockout that doubles up to 24 hours, and a global pause after 30 failures in an hour from 5 or more networks. Logging out revokes that session on the server, and a password change ends every session. Wrong API keys or tokens lock the sending network after 10 a minute, before anything is even compared; a request with no token at all isn't counted. API lockouts double only up to an hour (logins: a day), because the network is often an office or a home shared by several people and devices, and one script with a stale key mustn't shut the others out of the API for a day. Give each device and script its own personal key, so one can be revoked without touching the rest. IP addresses are never stored: lockouts and the login log use a keyed hash of the network.
- **API (`/api`):** personal API keys (`shp_…`, 256 random bits), stored only as a SHA-256 hash and shown once. A key does what was ticked on it, limited to what its owner may do at the moment it's used, and it stops working when it expires, is revoked or its owner is removed. Keys and the API token can't manage people, keys or sessions, can't remove a domain, and can't see which email secrets are set. The older `API_TOKEN` secret is compared in constant time. By default it can only read and create: changing or deleting links, overwriting imports and changing settings need the admin or a key, so a token lost with a phone can't retarget links people already have. `API_TOKEN_SCOPE="full"` lifts that limit.
- **Secrets** are Wrangler secrets. The setup passes them to Wrangler through stdin and never writes them to disk; the admin never displays them, and System status reports only whether they're set and long enough.
- **Deploy to Cloudflare installs:**
  - The owners' password is the plain `ADMIN_PASSWORD` secret, compared in constant time and ignored below 9 characters. A hash (`ADMIN_PASSWORD_HASH`) wins once it's set.
  - The session secret and the visitor salt are generated once and kept in D1 until you set them as secrets. Anyone who can read your D1 database can then read them; that's someone who already has access to your Cloudflare account.
- **Outbound requests:**
  - Destination checks, the social-preview fetch and webhooks only reach public addresses: private, loopback and link-local ranges are refused. Each redirect is checked again before it's followed, or isn't followed at all (webhooks).
  - Email provider hosts are fixed in the code, redirects are refused, and the recipient comes only from configuration.
  - Webhooks are signed with HMAC-SHA256 (`X-Shorthop-Signature`). Their secrets are encrypted at rest with AES-GCM, with a key derived from `SESSION_SECRET`, and shown only once.
- **Password-protected links:** PBKDF2 at 30,000 iterations on Workers Free (a check fits its CPU limit) and 100,000 on Paid (`WORKERS_PLAN`), attempts rate-limited per network and link. A correct password is remembered for 12 hours in a cookie scoped to that link and signed with `SESSION_SECRET`; changing the link's password ends every remembered access. The destination is never revealed before the password, not even to preview crawlers.
- **Admin pages** are served with a strict Content Security Policy, `X-Frame-Options: DENY` and `no-store` caching. Every page and redirect sends `Strict-Transport-Security`.
- **Visitors:** no IP addresses are stored, and no cookies are set except on a password-protected link. The daily visitor hash uses a random salt per day that's deleted once the day is over. See [docs/PRIVACY.md](docs/PRIVACY.md).
- **Redirect targets** must be `https://` and can't point back at the shortener's own hosts.

<a id="daily-cap"></a>
## Workers Free: protect the daily request cap

On Workers Free, the 100,000 requests a day are a hard cap for the whole account, and every request to a short domain counts, including requests for slugs that don't exist. Once the cap is used up, Cloudflare answers with error 1027 until midnight UTC: every short link stops working. The Worker can't prevent that, because each request that reaches it already counts.

So anyone who sends enough requests can take your links down for the rest of the day. Two things help:

- **A rate-limiting rule** in each short domain's zone stops a single client from doing it quickly. Blocked requests stop at Cloudflare's edge and never reach the Worker. In the Cloudflare dashboard, for the zone:
  1. **Security → WAF → Rate limiting rules → Create rule.**
  2. **If incoming requests match:** URI Path wildcard `/*`. The Free plan can't match on the hostname, so the rule covers every site in the zone; mind that if the zone serves more than Shorthop.
  3. **With the same characteristics:** IP.
  4. **When rate exceeds:** 50 requests per 10 seconds. A visitor sends one request per click; opening the admin loads a few dozen files, so raise the limit if the admin is on this zone and you hit it.
  5. **Then take action:** Block, for 10 seconds.
  6. Deploy.

  The Free plan allows one rule per zone. If the admin login is on the same zone, this rule takes the place of the login rule below; Shorthop's own lockout still limits password guesses. A rule raises the bar but doesn't remove it: many clients, or one that stays under the limit for hours, can still use up the day.
- **Workers Paid** ($5/month) has no daily cap: requests beyond the 10 million a month included are billed instead. Choose it if your links must not go down.

## Password-only mode: add a rate-limiting rule

With `ADMIN_AUTH="password"` the login page is reachable by anyone. Shorthop's own lockout slows guessing, but stopping floods at Cloudflare's edge is cheaper and keeps the noise out of your logs. In the Cloudflare dashboard, for the admin host's zone:

1. **Security → WAF → Rate limiting rules → Create rule.**
2. **If incoming requests match:** URI Path equals `/_admin/login`. (The Free plan matches on the path only; on higher plans you can add `http.request.method eq "POST"` so that only attempts count.)
3. **With the same characteristics:** IP.
4. **When rate exceeds:** 10 requests per 10 seconds (the Free plan allows one rule with a 10-second period).
5. **Then take action:** Block, for 10 seconds (longer on paid plans).
6. Deploy.

Better still, keep Cloudflare Access on: `npm run setup -- access`.

**A known trade-off:** after 30 failed logins in an hour from 5 or more networks, Shorthop pauses every login for 15 minutes. Without Access, an attacker with that many networks can trigger the pause repeatedly and keep you from signing in (existing sessions keep working). The pause exists to stop distributed password guessing; Access removes the problem, because the login page is then unreachable without your email.

## Hardening checklist

- Use the generated admin password and keep it in a password manager.
- Turn on **Always Use HTTPS** for each zone. Shorthop also sends `Strict-Transport-Security`, so a browser that has visited once stays on HTTPS.
- Give each script or device its own personal API key with only the permissions it needs, and an expiry where that fits. Revoke the key if the device (such as a phone with the iOS Shortcut) is lost.
- If you still have the older `API_TOKEN`, move to keys and delete it (`npx wrangler secret delete API_TOKEN`). Until then, keep `API_TOKEN_SCOPE` at `create`.
- Turn on Cloudflare Access, even on a Deploy to Cloudflare install: password-only sign-in leaves the login page open to anyone.
- When someone leaves, remove them in Settings → People and take them out of the Access policy.
- On Workers Free, add the rate-limiting rule from [the daily cap section](#daily-cap).
- Monitor a real short link from outside: an uptime service that requests one of your links and expects a `302` notices a used-up daily cap or a broken deploy within minutes. `/health` only shows that the Worker runs; it doesn't read the link store.
- Review **Settings → Access & security** for failed logins now and then; the System status page emails you when a check fails.

---
name: shorthop
description: Create and manage short links, read click statistics, and see which links brought revenue, on a self-hosted Shorthop instance (one Cloudflare Worker). Use when the user wants to shorten a URL, make a branded or tagged link, check how a link or campaign performed, find broken or missed links, share a statistics report, or ask which posts, newsletters or AI answers brought paying customers. Triggers - "shorten this", "short link for", "how many clicks", "which link brought sales", "Shorthop".
license: MIT
compatibility: Needs a Shorthop instance URL (its admin host) and a personal API key (shp_…) from Settings → API keys.
---

# Shorthop

Shorthop is a self-hosted URL shortener with click statistics, website analytics and revenue attribution. Everything is reachable through its HTTP API or its MCP server, both authenticated with a personal API key.

## Setup

Ask the user for two things, unless they're already in the environment:

- `SHORTHOP_URL`: the instance's admin host, such as `https://links.example.com`. The API lives at `$SHORTHOP_URL/api`.
- `SHORTHOP_KEY`: a personal API key, `shp_…`, from **Settings → API keys**. A key can do only what it was given. Suggest a key with **Create links** and **Statistics** for everyday use. Use a key with **Edit** or **Delete** only when the user wants changes.

Never print the key. Send it only as `Authorization: Bearer $SHORTHOP_KEY` to `$SHORTHOP_URL`.

### Prefer MCP when the client supports it

The instance runs an MCP server at `$SHORTHOP_URL/api/mcp` (HTTP, JSON). With Claude Code:

```bash
claude mcp add --transport http shorthop "$SHORTHOP_URL/api/mcp" --header "Authorization: Bearer $SHORTHOP_KEY"
```

Its tools:
- **Links:** `create_link`, `list_links`, `get_link`, `update_link`, `delete_link`, `list_tags`.
- **Statistics:** `stats_overview`, `link_stats`, `recent_hits`, `missed_links`.
- **Websites and revenue:** `list_sites`, `site_overview`, `link_revenue`.
- **Previews:** `fetch_preview`.

Use them instead of raw HTTP when they're available.

## Common tasks with the HTTP API

Links are identified by **domain and slug**, for example `sh.example` and `guide`. Slugs are case-sensitive.

**Shorten a URL** (just the short URL back):

```bash
curl -s -X POST "$SHORTHOP_URL/api/links?format=text" \
  -H "Authorization: Bearer $SHORTHOP_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/post","slug":"post","tags":["newsletter"]}'
```

Leave `slug` out for a random one. Optional fields:
- `title`, `notes`, `expiresAt` (ISO date)
- `utm` (true adds the default UTM tags)
- `maxClicks`, `password`
- `routing` (device and country rules)
- `preview` (social preview: title, description, image)

**Read statistics**
- All links: `GET /api/stats/overview?range=30d`
- One link: `GET /api/stats/links/{domain}/{slug}?range=30d`, which returns totals, a daily series, and breakdowns by country, city, source, referrer, device, OS, browser and language.
- Ranges are `today`, `7d`, `30d`, `90d`, `365d` and `all`, in UTC days.
- `GET /api/stats/recent?domain=…&slug=…&limit=50` returns the latest clicks.

**Find links**
- `GET /api/links?q=text&tag=launch&status=active&period=7d`, newest first, with `clicksPeriod` and `clicksTotal`.
- `GET /api/links/by-target?url=…` shows whether a destination is already shortened.

**Revenue a link brought**
- `GET /api/sites/by-link/{domain}/{slug}?days=365` returns payments credited to the link on the user's tracked websites.
- Links straight to Stripe, Lemon Squeezy, Dodo, Creem or Gumroad checkouts are credited too.

**Many links at once**
- `POST /api/links/bulk` with `{"links":[{"domain":"…","slug":"…"}],"action":"addTag","tag":"launch"}`.
- Actions: `enable`, `disable`, `addTag`, `removeTag`, `delete`.
- At most 20 links per request on Workers Free and 100 on Paid. Split bigger sets.

**Share results with someone**
- `POST /api/shares` with `{"scope":"tag","tag":"launch","title":"Launch week","showRevenue":false}`.
- It returns a read-only page address to send, for example to a sponsor.
- One link: `POST /api/links/{domain}/{slug}/shares`.

**Broken and missing links**
- `GET /api/checks` returns destination health.
- `GET /api/stats/misses?range=30d` lists addresses people opened that have no link.

## Good practice

- **Before creating a link, check for an existing one.** Use `GET /api/links/by-target?url=…`. Offer the existing link unless the user wants another, for example to track a different channel with a source tag: add `?s=newsletter` to the short URL.
- **Deleting is restorable for 90 days.** Restore with `POST /api/deleted/{domain}/{slug}/restore`.
- **Disabling is often better than deleting.** `PATCH` with `{"active":false}` keeps the statistics and the slug.
- **Errors are JSON `{ "error": "…" }`.**
  - A 403 means the key lacks the permission. Say which one is needed rather than retrying.
  - A 413 with `too_many_rows` means the request was too big: send fewer at a time.
- **Click counts are people only.** Bots and link previews are counted separately and never inflate clicks.

## Reference

- Every endpoint with its permission: [references/api.md](references/api.md).
- The machine-readable description: `GET $SHORTHOP_URL/api/openapi.json`.

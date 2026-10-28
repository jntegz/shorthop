-- Website analytics: the owner's own sites, tracked by /_t/script.js.
-- Raw events (pageviews, goals, outbound clicks) go to Analytics Engine
-- (the AE_WEB_DATASET dataset); D1 keeps one row per session, which is what
-- revenue is attributed to and what the site dashboard reads.

CREATE TABLE sites (
  id TEXT PRIMARY KEY,                                  -- "st_" + random, public (in the snippet)
  name TEXT NOT NULL,
  domains TEXT NOT NULL,                                -- JSON array of hostnames; their subdomains count too
  timezone TEXT NOT NULL DEFAULT 'UTC',                 -- IANA zone for days and charts
  currency TEXT NOT NULL DEFAULT 'USD',                 -- ISO 4217; revenue is converted into it
  id_mode TEXT NOT NULL DEFAULT 'cookieless',           -- 'cookieless' (daily hash) | 'persistent' (first-party ID)
  respect_gpc INTEGER NOT NULL DEFAULT 1,               -- persistent mode: GPC/DNT visitors fall back to cookieless
  attribution_model TEXT NOT NULL DEFAULT 'last_non_direct', -- 'last_non_direct' | 'last_touch' | 'first_touch'
  lookback_days INTEGER NOT NULL DEFAULT 30,
  exclude_paths TEXT NOT NULL DEFAULT '[]',             -- JSON array of path globs not recorded
  tag_links INTEGER NOT NULL DEFAULT 1,                 -- short links to this site carry a signed click token
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A visit: events of one visitor with no gap over 30 minutes. A new campaign
-- or short-link click also starts a new one.
CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY,                                  -- random; also the checkout reference (sh_ref)
  site_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,                             -- daily hash (cookieless) or the first-party ID
  started_at INTEGER NOT NULL,                          -- unix seconds
  last_seen_at INTEGER NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  hostname TEXT NOT NULL DEFAULT '',
  entry_path TEXT NOT NULL DEFAULT '',
  exit_path TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',                      -- "Google", "LinkedIn", a utm_source, a link source tag…
  channel TEXT NOT NULL DEFAULT 'Direct',               -- see CHANNELS in src/shared/sites.ts
  utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_term TEXT NOT NULL DEFAULT '',
  utm_content TEXT NOT NULL DEFAULT '',
  link_domain TEXT NOT NULL DEFAULT '',                 -- the short link that brought the visit, if any
  link_slug TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  checkout_at INTEGER                                   -- last click on a checkout link (timing match)
);
CREATE INDEX web_sessions_site_started ON web_sessions (site_id, started_at);
CREATE INDEX web_sessions_site_visitor ON web_sessions (site_id, visitor_id, last_seen_at);
CREATE INDEX web_sessions_link ON web_sessions (link_domain, link_slug) WHERE link_slug != '';
CREATE INDEX web_sessions_checkout ON web_sessions (site_id, checkout_at) WHERE checkout_at IS NOT NULL;

-- Who a visitor is, when the site says so (identify). The browser can only
-- fill empty fields (trust 'client'); the API can overwrite (trust 'server').
CREATE TABLE web_visitors (
  site_id TEXT NOT NULL,
  id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  email TEXT,
  name TEXT,
  user_id TEXT,
  trust TEXT NOT NULL DEFAULT 'client',
  PRIMARY KEY (site_id, id)
);
CREATE INDEX web_visitors_email ON web_visitors (site_id, email) WHERE email IS NOT NULL;

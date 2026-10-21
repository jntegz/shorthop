-- Links: D1 is the source of truth, KV holds a read copy for redirects. Every
-- short domain has its own slugs: the same slug can exist on every domain.
CREATE TABLE links (
  domain         TEXT NOT NULL,                  -- lowercase hostname from SHORT_DOMAINS
  slug           TEXT NOT NULL,                  -- case-sensitive
  target         TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  expires_at     INTEGER,                        -- unix seconds, NULL = never
  utm            INTEGER NOT NULL DEFAULT 1,     -- append UTM template on redirect
  utm_template   TEXT,                           -- NULL = use settings.default_utm
  pass_query     INTEGER NOT NULL DEFAULT 0,
  title          TEXT,
  tags           TEXT NOT NULL DEFAULT '',       -- comma-separated
  notes          TEXT NOT NULL DEFAULT '',
  source         TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'import')),
  imported_clicks INTEGER,                       -- lifetime clicks reported by the previous shortener
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (domain, slug)
);
CREATE INDEX links_slug_nocase ON links (domain, slug COLLATE NOCASE);
CREATE INDEX links_created ON links (created_at);

-- Daily rollups from Analytics Engine, kept forever.
CREATE TABLE daily_stats (
  date    TEXT NOT NULL,                        -- YYYY-MM-DD, UTC
  domain  TEXT NOT NULL,
  slug    TEXT NOT NULL,
  country TEXT NOT NULL,
  device  TEXT NOT NULL,
  source  TEXT NOT NULL,
  clicks  INTEGER NOT NULL,
  uniques INTEGER NOT NULL,
  bots    INTEGER NOT NULL,
  PRIMARY KEY (date, domain, slug, country, device, source)
) WITHOUT ROWID;
CREATE INDEX daily_stats_slug ON daily_stats (domain, slug, date);

-- One row per day, slug, dimension and value. dim = 'total' holds the true
-- per-day uniques; 'miss' rows count hits on unknown or inactive slugs.
CREATE TABLE daily_dims (
  date    TEXT NOT NULL,
  domain  TEXT NOT NULL,
  slug    TEXT NOT NULL,
  dim     TEXT NOT NULL,   -- total|city|region|os|browser|referrer|language|bot|miss
  value   TEXT NOT NULL,
  clicks  INTEGER NOT NULL,
  uniques INTEGER NOT NULL DEFAULT 0,
  bots    INTEGER NOT NULL,
  PRIMARY KEY (date, domain, slug, dim, value)
) WITHOUT ROWID;
CREATE INDEX daily_dims_slug ON daily_dims (domain, slug, date);
CREATE INDEX daily_dims_dim ON daily_dims (dim, date);

-- default_utm, last_rolled, last_digest_week, session_epoch (missing = "0"), ...
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- {domain} is the short domain the link lives on.
INSERT INTO settings (key, value) VALUES
  ('default_utm', 'utm_source={domain}&utm_medium=shortlink&utm_campaign={slug}');

-- Admin password login. No raw IPs are stored: `key` and `ip_hash` are an HMAC
-- of the client network (/32 for IPv4, /64 for IPv6) under SESSION_SECRET.
-- The row with key '*' is the global brake across all networks.
CREATE TABLE auth_failures (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,            -- attempts in the current window
  window_start INTEGER NOT NULL,            -- unix seconds
  locked_until INTEGER NOT NULL DEFAULT 0,  -- unix seconds, 0 = not locked
  lockouts     INTEGER NOT NULL DEFAULT 0,  -- lockouts in a row (exponential backoff)
  updated_at   INTEGER NOT NULL
) WITHOUT ROWID;

-- Successful and failed logins, pruned to 30 days by the daily cron.
CREATE TABLE login_events (
  ts      INTEGER NOT NULL,
  ok      INTEGER NOT NULL,                 -- 1 success, 0 failure
  ip_hash TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT ''
);
CREATE INDEX login_events_ts ON login_events (ts);

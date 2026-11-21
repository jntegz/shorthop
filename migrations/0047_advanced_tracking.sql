-- Advanced tracking (src/shared/tracking.ts, src/worker/tracking.ts): an
-- opt-in click log per link, with every detail Cloudflare knows about a
-- request and, in IP mode, the IP address (AES-GCM encrypted).

-- The link's tracking settings as JSON (TrackingConfig), or NULL when off.
-- Saving a link's other settings leaves it as it is.
ALTER TABLE links ADD COLUMN tracking TEXT;

CREATE TABLE tracked_clicks (
  id TEXT PRIMARY KEY,                    -- random, also signs the browser-details beacon
  domain TEXT NOT NULL,
  slug TEXT NOT NULL,
  at INTEGER NOT NULL,                    -- unix seconds
  expires_at INTEGER NOT NULL,            -- at + the link's retention; the daily cleanup deletes after it
  event TEXT NOT NULL,                    -- 'click' (a person) or 'bot'
  bot_name TEXT NOT NULL DEFAULT '',
  ip_enc TEXT,                            -- IP mode only: encrypted with ENCRYPTION_KEY (or SESSION_SECRET)
  ip_key TEXT,                            -- IP mode only: keyed hash of the IP, to find a person's clicks on request
  visitor TEXT NOT NULL,                  -- keyed hash of IP and user agent, per link: the same browser and network
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  metro_code TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  timezone TEXT NOT NULL DEFAULT '',
  continent TEXT NOT NULL DEFAULT '',
  is_eu INTEGER NOT NULL DEFAULT 0,
  asn INTEGER NOT NULL DEFAULT 0,
  as_org TEXT NOT NULL DEFAULT '',
  colo TEXT NOT NULL DEFAULT '',
  tls_version TEXT NOT NULL DEFAULT '',
  http_protocol TEXT NOT NULL DEFAULT '',
  rtt_ms INTEGER,
  user_agent TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  browser_version TEXT NOT NULL DEFAULT '',
  device_model TEXT NOT NULL DEFAULT '',
  languages TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',      -- the full Referer, when the browser sent one
  source TEXT NOT NULL DEFAULT '',
  qr INTEGER NOT NULL DEFAULT 0,
  tor INTEGER NOT NULL DEFAULT 0,
  datacenter INTEGER NOT NULL DEFAULT 0,
  private_relay INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tracked_clicks_link ON tracked_clicks (domain, slug, at DESC);
CREATE INDEX tracked_clicks_expiry ON tracked_clicks (expires_at);
CREATE INDEX tracked_clicks_ip ON tracked_clicks (ip_key) WHERE ip_key IS NOT NULL;

-- What the browser-details page sent back for a click (one row at most).
-- Its own table, so the beacon never waits for the click's row to be written.
CREATE TABLE tracked_click_details (
  click_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,                     -- BrowserDetails JSON
  created_at INTEGER NOT NULL
);

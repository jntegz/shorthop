-- Outbound webhooks: endpoints that get a signed JSON POST when something
-- happens to a link. Deliveries are an outbox: sent at once when possible,
-- retried with backoff by the half-hourly cron, kept 30 days for the log.
CREATE TABLE webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  events      TEXT NOT NULL,              -- JSON array of event types
  secret      TEXT NOT NULL,              -- AES-GCM under a key derived from SESSION_SECRET
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id          TEXT PRIMARY KEY,           -- "dlv_…", sent as X-Shorthop-Delivery
  webhook_id  INTEGER NOT NULL,
  event_id    TEXT NOT NULL,              -- "evt_…", the same for every endpoint
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL,              -- the JSON body, exactly as signed
  status      TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER,                    -- pending: due from this moment
  last_status INTEGER,                    -- the endpoint's last HTTP status
  last_error  TEXT,
  last_at     INTEGER,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_at);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at);

-- The highest click milestone each link has passed, so each is announced once.
CREATE TABLE link_milestones (
  domain    TEXT NOT NULL,
  slug      TEXT NOT NULL,
  milestone INTEGER NOT NULL,
  PRIMARY KEY (domain, slug)
) WITHOUT ROWID;

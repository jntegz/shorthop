-- Funnels on tracked sites, and an email for each payment.

-- A funnel: ordered steps, each a page (path glob) or a goal, that a visitor
-- has to reach in that order within window_hours of the first step.
CREATE TABLE funnels (
  id TEXT PRIMARY KEY,                     -- "fn_" + random
  site_id TEXT NOT NULL,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,                     -- JSON [{ "type": "page" | "goal", "value": "/pricing" }]
  window_hours INTEGER NOT NULL DEFAULT 24,
  created_at INTEGER NOT NULL
);
CREATE INDEX funnels_site ON funnels (site_id);

-- Email the digest recipient about each new payment (not refunds, not tests).
ALTER TABLE sites ADD COLUMN notify_payments INTEGER NOT NULL DEFAULT 0;

-- Alerts for tracked sites: traffic spikes and a daily summary, both by email
-- to the digest recipient (and as webhooks, for endpoints subscribed to them).

-- Email (and webhook) when a source sends at least 4x its usual hourly visits.
ALTER TABLE sites ADD COLUMN spike_alerts INTEGER NOT NULL DEFAULT 1;
-- A short email each day about the day before, at this hour of the site's time zone.
ALTER TABLE sites ADD COLUMN daily_digest INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN digest_hour INTEGER NOT NULL DEFAULT 8;
-- The site's local date of the last daily digest sent (so a run can't send it twice).
ALTER TABLE sites ADD COLUMN digest_sent_on TEXT;

-- Spikes already reported, so the same surge isn't reported every hour.
CREATE TABLE site_spikes (
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,
  detected_at INTEGER NOT NULL,           -- unix seconds
  visits INTEGER NOT NULL,                -- in the hour before detected_at
  baseline REAL NOT NULL,                 -- usual visits per hour over the 7 days before
  PRIMARY KEY (site_id, source, detected_at)
);
CREATE INDEX site_spikes_recent ON site_spikes (site_id, detected_at);

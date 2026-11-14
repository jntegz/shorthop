-- Payment webhooks that finish are told apart from ones still being processed,
-- so a retry of an event that failed halfway is processed again instead of
-- being answered "duplicate". Events recorded before this count as finished.
ALTER TABLE payment_events ADD COLUMN processed_at INTEGER;
UPDATE payment_events SET processed_at = received_at;

-- When the daily job last tried to convert a payment still waiting for an
-- exchange rate: the longest-waiting ones go first, so a payment that can't be
-- converted yet doesn't keep the others out of the batch.
ALTER TABLE payments ADD COLUMN fx_tried_at INTEGER;
CREATE INDEX payments_unconverted ON payments (fx_tried_at) WHERE amount_site_minor IS NULL;

-- "Online now", the live list and the websites list filter and sort on the last event.
CREATE INDEX web_sessions_site_seen ON web_sessions (site_id, last_seen_at);

-- The daily rollup replaces one day across every site.
CREATE INDEX web_daily_events_day ON web_daily_events (day);

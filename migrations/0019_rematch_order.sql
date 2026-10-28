-- When matching an unmatched charge was last tried, so the daily retry goes
-- round all of them instead of the same newest ones every day.
ALTER TABLE payments ADD COLUMN last_match_at INTEGER;
CREATE INDEX payments_retry ON payments (last_match_at) WHERE session_id IS NULL AND kind = 'charge';

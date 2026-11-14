-- A security DNS lookup that fails (timeout, error) is not an answer: the link
-- keeps unsafe_at NULL and is looked up again. unsafe_tried_at: when the last
-- attempt failed, so the half-hourly backlog takes destinations never tried
-- first and the ones that keep failing last.
ALTER TABLE links ADD COLUMN unsafe_tried_at INTEGER;

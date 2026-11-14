-- A person opened a destination that refuses automated checks and says it works.
-- Unix seconds; NULL = not confirmed. Cleared by the first check the site doesn't refuse.
ALTER TABLE target_checks ADD COLUMN confirmed_at INTEGER;

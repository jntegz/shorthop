-- rev: a random token replaced by every saved change to a link. It is the
-- link's version in the API (NULL reads as "0"), so a client can refuse to
-- overwrite a change it hasn't seen, and it ties a history row to the write
-- that made it.
ALTER TABLE links ADD COLUMN rev TEXT;

-- cap_since: when this link's click limit began counting, for links that come
-- back through an import: a counter older than this starts again from zero, so
-- a re-imported link doesn't inherit the clicks of the one it replaces.
ALTER TABLE links ADD COLUMN cap_since INTEGER;

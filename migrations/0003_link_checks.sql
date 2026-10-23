-- Destination checks: whether each link's target still loads. Keyed by the
-- target itself, so links sharing a destination are checked once.
ALTER TABLE links ADD COLUMN monitor INTEGER NOT NULL DEFAULT 1;  -- 0 = never check this link's target
CREATE INDEX links_target ON links (target);

CREATE TABLE target_checks (
  target      TEXT PRIMARY KEY,           -- links.target, exactly as stored
  status      TEXT NOT NULL CHECK (status IN ('ok', 'warning', 'down', 'blocked')),
  http_status INTEGER,                    -- the last response's status; NULL when none came back
  problem     TEXT,                       -- a CheckProblem code; NULL when ok
  final_url   TEXT,                       -- where redirects ended, when somewhere else
  hops        INTEGER NOT NULL DEFAULT 0, -- redirects followed
  ms          INTEGER,                    -- time for the whole check
  fails       INTEGER NOT NULL DEFAULT 0, -- failed checks in a row
  checked_at  INTEGER NOT NULL,           -- unix seconds
  last_ok_at  INTEGER,
  since       INTEGER NOT NULL,           -- when the status last changed
  next_at     INTEGER NOT NULL,           -- due again from this moment
  notified    INTEGER NOT NULL DEFAULT 0  -- 1 once an email reported it as not working
);
CREATE INDEX target_checks_next ON target_checks (next_at);

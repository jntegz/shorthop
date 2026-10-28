-- More about each visit, from Cloudflare's request data (no IP is stored):
-- the network's owner (an ISP, or a company's own network), the continent and
-- time zone, the screen class from the window width, and whether the visitor
-- had an earlier visit (across days only for sites with persistent ids).
ALTER TABLE web_sessions ADD COLUMN org TEXT NOT NULL DEFAULT '';
ALTER TABLE web_sessions ADD COLUMN continent TEXT NOT NULL DEFAULT '';
ALTER TABLE web_sessions ADD COLUMN timezone TEXT NOT NULL DEFAULT '';
ALTER TABLE web_sessions ADD COLUMN screen TEXT NOT NULL DEFAULT '';
ALTER TABLE web_sessions ADD COLUMN return_visit INTEGER NOT NULL DEFAULT 0;

-- Daily totals of the event lists that live in Analytics Engine (pages,
-- outbound links, goals), so they outlast its 90 days. Written by the daily
-- rollup for each completed UTC day.
CREATE TABLE web_daily_events (
  site_id    TEXT NOT NULL,
  day        TEXT NOT NULL,      -- UTC YYYY-MM-DD
  kind       TEXT NOT NULL,      -- 'pageview' | 'outbound' | 'goal'
  name       TEXT NOT NULL,      -- the path, outbound host+path, or goal name
  events     INTEGER NOT NULL,
  visitors   INTEGER NOT NULL,   -- distinct visitors that day
  engaged_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, day, kind, name)
) WITHOUT ROWID;

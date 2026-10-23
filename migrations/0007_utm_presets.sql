-- Saved UTM templates ("LinkedIn", "Newsletter") to apply to links. A link
-- gets a copy, so editing a preset later doesn't change links already using it.
CREATE TABLE utm_presets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  template   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

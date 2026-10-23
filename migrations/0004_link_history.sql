-- Change history: one row per saved state of a link (after the change), so
-- any earlier version can be restored and a deleted link brought back.
CREATE TABLE link_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  at            INTEGER NOT NULL,                -- unix seconds
  action        TEXT NOT NULL CHECK (action IN ('baseline', 'create', 'update', 'import', 'restore', 'delete')),
  actor         TEXT NOT NULL,                   -- Access email, "api-token" or "system"
  snapshot      TEXT NOT NULL,                   -- JSON: the link's columns after the change (before it, for a delete)
  restored_from INTEGER                          -- the version a restore copied
);
CREATE INDEX link_versions_link ON link_versions (domain, slug, id);
CREATE INDEX link_versions_action ON link_versions (action, at);

-- Links that existed before history start with their current state.
INSERT INTO link_versions (domain, slug, at, action, actor, snapshot)
SELECT domain, slug, updated_at, 'baseline', 'system',
       json_object('target', target, 'active', active, 'expires_at', expires_at, 'utm', utm, 'utm_template', utm_template,
                   'pass_query', pass_query, 'title', title, 'tags', tags, 'notes', notes, 'broken', broken,
                   'replacement', replacement, 'monitor', monitor, 'source', source, 'imported_clicks', imported_clicks,
                   'created_at', created_at)
FROM links;

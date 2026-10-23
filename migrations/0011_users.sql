-- People who may use the admin besides the owners in ADMIN_EMAIL (who are
-- always admins and never stored here), and their personal API keys.
-- Cloudflare Access still decides who reaches the admin at all: everyone here
-- must also be allowed by the Access policy.
CREATE TABLE users (
  email          TEXT PRIMARY KEY,               -- lowercased, as Access reports it
  name           TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'user')),
  permissions    TEXT NOT NULL DEFAULT '',       -- comma-separated (src/shared/permissions.ts); ignored for admins
  password_hash  TEXT,                           -- PBKDF2 (src/shared/password.ts); NULL until the invite is used
  session_epoch  TEXT NOT NULL,                  -- random; part of every session cookie, rotated to end them
  invite_hash    TEXT,                           -- SHA-256 hex of the one-time invite token
  invite_expires INTEGER,                        -- unix seconds
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER
) WITHOUT ROWID;

-- Keys look like shp_<id>_<secret>; only a SHA-256 of the whole key is kept.
-- A key can do what it was given, and never more than its owner can do now.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,                 -- 8 characters [a-z0-9], shown in the list
  hash         TEXT NOT NULL UNIQUE,
  owner        TEXT NOT NULL,                    -- an owner's email or users.email
  name         TEXT NOT NULL,
  permissions  TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,                          -- updated at most hourly
  expires_at   INTEGER                           -- unix seconds, NULL = never
);
CREATE INDEX api_keys_owner ON api_keys (owner);

-- Who signed in (older rows have none).
ALTER TABLE login_events ADD COLUMN email TEXT;

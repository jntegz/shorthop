-- Where a turned-off link sends visitors: NULL shows the not-found page,
-- 'home' goes to FALLBACK_URL, 'domain/slug' to another of your links.
ALTER TABLE links ADD COLUMN off_redirect TEXT;

-- Read-only statistics pages for one link, opened at /_share/<id>.<secret>
-- without signing in. Only a SHA-256 of the secret is used to check a visit;
-- the encrypted copy lets the admin show the address again.
CREATE TABLE stat_shares (
  id             TEXT PRIMARY KEY,               -- 8 characters [a-z0-9]
  domain         TEXT NOT NULL,
  slug           TEXT NOT NULL,
  secret_hash    TEXT NOT NULL,                  -- SHA-256 hex of the secret
  secret_enc     TEXT NOT NULL,                  -- AES-GCM (SESSION_SECRET), for "Copy link"
  password_hash  TEXT,                           -- PBKDF2 (src/shared/password.ts), NULL = no password
  expires_at     INTEGER,                        -- unix seconds, NULL = until revoked
  range_limit    TEXT,                           -- longest period viewers may pick, NULL = any
  show_recent    INTEGER NOT NULL DEFAULT 0,     -- 1: list recent visits (no visitor ids)
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  views          INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER
) WITHOUT ROWID;

CREATE INDEX stat_shares_link ON stat_shares (domain, slug);

-- Custom social previews: what link-preview crawlers see for a link, as JSON
-- (see src/shared/preview.ts). NULL: they follow the redirect as before.
ALTER TABLE links ADD COLUMN preview TEXT;

-- Uploaded preview images (bytes in KV under "og:<key>"), so ones no link or
-- saved version uses can be found and deleted.
CREATE TABLE preview_images (
  key        TEXT PRIMARY KEY,   -- random, with the file extension
  created_at INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER
);

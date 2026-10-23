-- Links marked "no longer working", optionally pointing visitors to another link.
ALTER TABLE links ADD COLUMN broken INTEGER NOT NULL DEFAULT 0;
-- "domain/slug" of the replacement link, or NULL to send visitors to the site in Settings.
ALTER TABLE links ADD COLUMN replacement TEXT;

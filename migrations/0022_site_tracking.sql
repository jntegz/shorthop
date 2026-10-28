-- Off: the collector drops this site's visits and short links stop tagging clicks.
-- Payments from connected providers are still recorded.
ALTER TABLE sites ADD COLUMN tracking INTEGER NOT NULL DEFAULT 1;

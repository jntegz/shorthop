-- Shared statistics pages for more than one link: every link with a tag, or a
-- hand-picked set (a campaign or sponsor report). Link shares keep scope
-- 'link' and their domain/slug; the others leave those empty.
ALTER TABLE stat_shares ADD COLUMN scope TEXT NOT NULL DEFAULT 'link';  -- link | tag | set
ALTER TABLE stat_shares ADD COLUMN tag TEXT;                            -- scope 'tag'
ALTER TABLE stat_shares ADD COLUMN links TEXT;                          -- scope 'set': JSON ["domain/slug", …]
ALTER TABLE stat_shares ADD COLUMN title TEXT;                          -- shown as the page heading
ALTER TABLE stat_shares ADD COLUMN show_revenue INTEGER NOT NULL DEFAULT 0;
CREATE INDEX stat_shares_scope ON stat_shares (scope) WHERE scope != 'link';

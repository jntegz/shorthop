-- The half-hourly backlog of links whose destinations haven't been looked up
-- yet (src/worker/health.ts) reads them in this order: by index, so a run
-- takes its links without scanning and sorting every unchecked one.
CREATE INDEX links_unsafe_backlog ON links (COALESCE(unsafe_tried_at, 0), target, domain, slug) WHERE unsafe_at IS NULL;

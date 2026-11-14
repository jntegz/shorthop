-- Whether a domain has any slug that isn't all lower case (src/worker/redirect.ts):
-- when it has none, a not-found slug that differs only by case is recovered
-- with a KV read of its lower-case form instead of a D1 lookup per miss.
CREATE INDEX links_mixed_case ON links (domain) WHERE slug != lower(slug);

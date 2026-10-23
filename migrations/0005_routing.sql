-- Smart routing: ordered device/country rules with weighted destinations (A/B
-- tests), as JSON (see src/shared/routing.ts). NULL: one destination, the target.
ALTER TABLE links ADD COLUMN routing TEXT;

-- Every destination a link can send visitors to: its target (the fallback)
-- and the destinations of its enabled rules. Destination checks use this.
CREATE VIEW link_destinations AS
SELECT domain, slug, title, target AS url, target, active, broken, monitor, expires_at FROM links
UNION
SELECT l.domain, l.slug, l.title, json_extract(v.value, '$.url'), l.target, l.active, l.broken, l.monitor, l.expires_at
FROM links l, json_each(l.routing, '$.rules') r, json_each(r.value, '$.variants') v
WHERE l.routing IS NOT NULL AND json_extract(r.value, '$.enabled') = 1;

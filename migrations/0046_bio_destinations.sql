-- Direct bio page buttons are destinations too: visitors are sent there, so
-- destination checks look at them like a link's target and routing variants.
-- A bio that isn't valid JSON counts as none: it must not break every check.
DROP VIEW link_destinations;

CREATE VIEW link_destinations AS
SELECT domain, slug, title, target AS url, target, active, broken, monitor, expires_at FROM links
UNION
SELECT l.domain, l.slug, l.title, json_extract(v.value, '$.url'), l.target, l.active, l.broken, l.monitor, l.expires_at
FROM links l, json_each(l.routing, '$.rules') r, json_each(r.value, '$.variants') v
WHERE l.routing IS NOT NULL AND json_extract(r.value, '$.enabled') = 1
UNION
SELECT l.domain, l.slug, l.title, json_extract(b.value, '$.url'), l.target, l.active, l.broken, l.monitor, l.expires_at
FROM links l, json_each(CASE WHEN json_valid(l.bio) THEN l.bio END, '$.blocks') b
WHERE l.bio IS NOT NULL AND json_extract(b.value, '$.url') IS NOT NULL;

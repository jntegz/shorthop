-- Which links have Advanced tracking: the 03:30 run asks it every day, and a
-- change to the tracking rules reads every tracked link. This partial index
-- holds only the tracked ones and covers the query, so neither scans all links.
CREATE INDEX links_tracked ON links (tracking) WHERE tracking IS NOT NULL;

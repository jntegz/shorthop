-- "Check that the destination works" is now off for new links until someone
-- switches it on (src/worker/api/links.ts). Switch it off on existing links
-- too, so only the links someone chooses are checked once automatic checking
-- is activated under Link health. The column default stays 1; every insert
-- sets it explicitly.
UPDATE links SET monitor = 0;

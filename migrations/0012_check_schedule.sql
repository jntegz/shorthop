-- Automatic destination checks are now off until someone turns them on (Link
-- health → Activate automatic checking) and choose how often they run. Turn
-- them off here too, where they were saved as on, and start from once a day.
-- The email choice is kept. Installs that never saved settings are off already
-- through the new default in src/worker/link-check.ts.
UPDATE settings SET value = json_set(value, '$.enabled', json('false'), '$.everyHours', 24) WHERE key = 'link_checks';

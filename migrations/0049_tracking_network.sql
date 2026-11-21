-- Advanced tracking: the IP's reverse DNS name and the VPN
-- provider from the public list (src/worker/tracking.ts). Email opens (the
-- pixel at /_p/<slug>) are rows with event 'open'.
ALTER TABLE tracked_clicks ADD COLUMN hostname TEXT NOT NULL DEFAULT '';
ALTER TABLE tracked_clicks ADD COLUMN vpn_name TEXT NOT NULL DEFAULT '';

-- How much an endpoint receives about people: 'full' (what every webhook has been
-- sent so far, so existing endpoints don't change) or 'minimal'.
ALTER TABLE webhooks ADD COLUMN fields TEXT NOT NULL DEFAULT 'full';

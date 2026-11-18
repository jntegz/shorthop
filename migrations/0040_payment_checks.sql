-- What the payment checks found. anomaly on a row: refund_capped (more than the
-- charge was reported, the stored amount is capped), refund_currency (not the
-- charge's currency), refund_unknown (a partial refund of an unstated size, stored
-- as 0), no_charge (no charge found for it). Nothing is dropped.
ALTER TABLE payments ADD COLUMN anomaly TEXT;

-- 1: nothing but the webhook's own word backs this payment (a Gumroad ping with
-- no access token, or one Gumroad couldn't confirm when it arrived).
ALTER TABLE payments ADD COLUMN unverified INTEGER NOT NULL DEFAULT 0;

-- When the provider says the payment was begun, where that can be long before it
-- completed (a bank debit). Return-page references are compared with it too.
ALTER TABLE payments ADD COLUMN started_at INTEGER;

-- Gumroad payments received so far on connections without an access token were
-- never checked. A label only: amounts and matches stay as they are.
UPDATE payments SET unverified = 1
WHERE provider = 'gumroad' AND connection_id IN (
  SELECT id FROM payment_connections WHERE provider = 'gumroad' AND api_key IS NULL AND api_key_ref IS NULL
);

-- Refunds and disputes still waiting for their charge: looked through whenever a
-- charge is stored.
CREATE INDEX payments_waiting ON payments (site_id, provider) WHERE parent_id IS NULL AND kind != 'charge';

-- Counts for System status: one row per site and kind. site_id '' is install-wide
-- (exchange rates). detail holds a payment id or a currency, never a customer.
CREATE TABLE payment_anomalies (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (site_id, kind)
);

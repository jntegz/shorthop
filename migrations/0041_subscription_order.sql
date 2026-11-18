-- When the provider says the event behind a subscription's stored state happened,
-- so an older event delivered later can't overwrite it.
ALTER TABLE subscriptions ADD COLUMN last_event_at INTEGER;

-- A cancellation or end that a webhook announced and the provider didn't confirm
-- ('canceled' or 'ended'), and when it came. The subscription's own state stays.
-- With no subscription stored yet, the row has status 'unconfirmed'.
ALTER TABLE subscriptions ADD COLUMN unconfirmed_end TEXT;
ALTER TABLE subscriptions ADD COLUMN unconfirmed_at INTEGER;

-- PayPal cancellations were dated at the subscription's creation. The closest
-- thing known is when the cancellation was stored.
UPDATE subscriptions
SET canceled_at = CASE WHEN canceled_at IS NULL THEN NULL ELSE updated_at END,
    ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE updated_at END
WHERE provider = 'paypal' AND status IN ('canceled', 'ended');

-- A subscription already canceled or ended keeps that state against anything
-- older than the moment it ended. Never later than when it was stored: a date
-- in the future (the end of a paid period) would block real events after it.
UPDATE subscriptions
SET last_event_at = MIN(updated_at, MAX(COALESCE(canceled_at, 0), COALESCE(ended_at, 0)))
WHERE status IN ('canceled', 'ended') AND COALESCE(canceled_at, ended_at) IS NOT NULL;

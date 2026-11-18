-- Where a payment_claims row came from: 'browser' (a return page, which anyone
-- can send) or 'provider' (a signed webhook naming the visit). Rows from before
-- this migration stay NULL: the two can't be told apart, so they are treated like
-- browser claims, except that one naming a subscription still counts for that
-- subscription's payments, at low confidence, until claims expire after 90 days
-- (a trial begun before the upgrade only pays later).
ALTER TABLE payment_claims ADD COLUMN source TEXT;

-- For the cap on how many references one visit may claim.
CREATE INDEX payment_claims_session ON payment_claims (session_id);

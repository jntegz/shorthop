-- Privacy tools for tracked sites: one person's records can be exported or
-- erased, and customer details can expire after a set time (src/worker/web/privacy.ts).

-- When a payment's personal details (email, customer id, visit reference,
-- visitor) were removed, by an erasure or by retention. Its amount, date and
-- credited visit stay, so revenue reports still add up; matching never
-- touches it again.
ALTER TABLE payments ADD COLUMN personal_cleared_at INTEGER;
DROP INDEX payments_unmatched;
CREATE INDEX payments_unmatched ON payments (site_id, occurred_at) WHERE session_id IS NULL AND kind = 'charge' AND personal_cleared_at IS NULL;
DROP INDEX payments_retry;
CREATE INDEX payments_retry ON payments (last_match_at) WHERE session_id IS NULL AND kind = 'charge' AND personal_cleared_at IS NULL;

-- The same for a subscription: its customer id is gone, and later events don't bring it back.
ALTER TABLE subscriptions ADD COLUMN personal_cleared_at INTEGER;

-- Months after which a payment's personal details are removed; NULL keeps them until the site is deleted.
ALTER TABLE sites ADD COLUMN customer_retention_months INTEGER;

-- Export and erasure requests, for accountability: who, when and how many
-- records, never whom they were about.
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY,                    -- "pr_" + random
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- export | erase
  by_identity TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  counts TEXT NOT NULL                    -- JSON: records of each kind
);
CREATE INDEX privacy_requests_site ON privacy_requests (site_id, created_at);

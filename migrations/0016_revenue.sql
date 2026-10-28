-- Revenue: payment providers post webhooks to /_pay/<provider>/<connection>,
-- each payment is matched to a visitor's session and credited to one session
-- by the site's attribution model.

CREATE TABLE payment_connections (
  id TEXT PRIMARY KEY,                    -- "pc_" + random, part of the webhook URL
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- stripe | paddle | lemonsqueezy | dodo | creem
  label TEXT NOT NULL DEFAULT '',
  webhook_secret TEXT,                    -- encrypted (src/worker/webhooks.ts encryptSecret)
  api_key TEXT,                           -- encrypted, optional: lookups the webhook lacks
  product_filter TEXT NOT NULL DEFAULT '[]', -- JSON array of product IDs; empty = all
  created_at INTEGER NOT NULL,
  last_event_at INTEGER,
  last_error TEXT,
  last_error_at INTEGER
);
CREATE INDEX payment_connections_site ON payment_connections (site_id);

-- Every webhook delivery we accepted, so retries and replays are ignored.
CREATE TABLE payment_events (
  connection_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (connection_id, event_id)
);
CREATE INDEX payment_events_received ON payment_events (received_at);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,                    -- "<provider>:<kind>:<provider id>"
  site_id TEXT NOT NULL,
  connection_id TEXT,                     -- NULL when sent through the API
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- charge | refund | dispute | dispute_won
  billing TEXT NOT NULL DEFAULT 'one_time', -- one_time | sub_new | sub_renewal
  occurred_at INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,          -- signed: refunds and disputes are negative
  currency TEXT NOT NULL,
  amount_site_minor INTEGER,              -- in the site's currency; NULL until a rate is known
  customer_id TEXT,
  email TEXT,
  subscription_id TEXT,
  order_ref TEXT,                         -- provider ids a return page can report (checkout/order/payment)
  parent_id TEXT,                         -- refunds and disputes: the charge they belong to
  ref TEXT,                               -- sh_ref sent through checkout metadata
  session_id TEXT,                        -- the session that was matched
  visitor_id TEXT,
  credited_session_id TEXT,               -- the session the attribution model credits
  matched_by TEXT,                        -- ref | customer | claim | email | timing
  confidence TEXT,                        -- high | medium | low
  unmatched_reason TEXT,
  test_mode INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX payments_site_time ON payments (site_id, occurred_at);
CREATE INDEX payments_credited ON payments (credited_session_id) WHERE credited_session_id IS NOT NULL;
CREATE INDEX payments_customer ON payments (site_id, provider, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX payments_subscription ON payments (site_id, provider, subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX payments_unmatched ON payments (site_id, occurred_at) WHERE session_id IS NULL AND kind = 'charge';
CREATE INDEX payments_parent ON payments (parent_id) WHERE parent_id IS NOT NULL;

-- Provider ids seen on a return page (?session_id=, ?order_id=…): proves which
-- session a checkout came from, whichever arrives first.
CREATE TABLE payment_claims (
  site_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  session_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, ref)
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,                    -- "<provider>:<subscription id>"
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  customer_id TEXT,
  status TEXT NOT NULL,                   -- active | trialing | past_due | canceled | ended
  interval_unit TEXT,                     -- day | week | month | year
  interval_count INTEGER NOT NULL DEFAULT 1,
  amount_minor INTEGER,                   -- per interval
  currency TEXT,
  mrr_site_minor INTEGER,                 -- monthly, in the site's currency
  started_at INTEGER NOT NULL,
  canceled_at INTEGER,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_site ON subscriptions (site_id, status);

-- Daily reference rates (ECB, via frankfurter): 1 EUR = rate units of currency.
CREATE TABLE fx_rates (
  date TEXT NOT NULL,
  currency TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (date, currency)
);

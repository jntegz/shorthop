-- What was erased, as keyed hashes only (src/worker/web/erasure.ts): a browser id
-- that must not be collected again, and what a restored backup must lose again.
CREATE TABLE erasure_ledger (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- visitor | email | customer | payment | reference | withdrawn
  hash TEXT NOT NULL,                     -- HMAC of the value; can't be read back
  key_id TEXT NOT NULL,                   -- which secret made it
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, kind, hash)
) WITHOUT ROWID;
CREATE INDEX erasure_ledger_expires ON erasure_ledger (expires_at);

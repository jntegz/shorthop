-- Two-factor sign-in: an authenticator app (TOTP) and, later, passkeys. Keyed
-- by email rather than users, because owners (ADMIN_EMAIL) have no users row.

CREATE TABLE auth_factors (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('totp', 'passkey')),
  name          TEXT NOT NULL DEFAULT '',
  -- TOTP: the shared secret, encrypted (encryptSecret, purpose "totp").
  secret_enc    TEXT,
  -- Passkeys: the WebAuthn credential.
  credential_id TEXT UNIQUE,
  public_key    TEXT,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  -- TOTP: the last time step accepted, so a code works once.
  last_step     INTEGER,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX auth_factors_email ON auth_factors (email);
-- One authenticator app per person.
CREATE UNIQUE INDEX auth_factors_one_totp ON auth_factors (email) WHERE kind = 'totp';

-- One-time recovery codes; only their SHA-256 is stored.
CREATE TABLE recovery_codes (
  email      TEXT NOT NULL,
  hash       TEXT NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, hash)
);

-- Short-lived values of a sign-in or setup in progress: a TOTP secret waiting
-- for its first code, WebAuthn challenges. Deleted when used; the daily
-- cleanup removes expired ones.
CREATE TABLE auth_challenges (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_email ON auth_challenges (email, purpose);
CREATE INDEX auth_challenges_expires ON auth_challenges (expires_at);

-- How a login was completed: password, password+totp, password+recovery, passkey.
ALTER TABLE login_events ADD COLUMN method TEXT;

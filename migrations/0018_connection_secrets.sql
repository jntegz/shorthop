-- Payment connections: on/off, secrets kept as Cloudflare Worker secrets,
-- provider-specific settings, and the connection checker's last result.

-- 0 = turned off: webhooks are answered but nothing is recorded.
ALTER TABLE payment_connections ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
-- Names of Worker secrets (wrangler secret put NAME) holding the signing
-- secret or API key, instead of an encrypted copy in D1.
ALTER TABLE payment_connections ADD COLUMN webhook_secret_ref TEXT;
ALTER TABLE payment_connections ADD COLUMN api_key_ref TEXT;
-- JSON of non-secret settings, e.g. PayPal's client id, webhook id and sandbox flag.
ALTER TABLE payment_connections ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
-- JSON of the last "Check connection" run.
ALTER TABLE payment_connections ADD COLUMN last_check TEXT;

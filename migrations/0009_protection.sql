-- Password-protected links (a PBKDF2 hash, never returned by the API) and
-- click limits (counted exactly by the ClickCap Durable Object).
ALTER TABLE links ADD COLUMN password_hash TEXT;
ALTER TABLE links ADD COLUMN max_clicks INTEGER;

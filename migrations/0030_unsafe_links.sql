-- Destinations Cloudflare's security DNS (1.1.1.2) blocks as malware or
-- phishing: 1 = flagged (visitors see a warning first), 2 = the owner trusts
-- it anyway, 0 = not flagged. unsafe_at: when it was last looked up, so the
-- half-hourly checks can work through links that were never looked up.
ALTER TABLE links ADD COLUMN unsafe INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN unsafe_at INTEGER;

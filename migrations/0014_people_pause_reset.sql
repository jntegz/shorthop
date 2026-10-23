-- Pausing someone's access, and self-service password resets.
-- A pause blocks their sign-in, sessions and API keys without removing them;
-- with paused_until it lifts by itself at that time, without it it lasts until
-- someone presses Resume. Pausing also rotates session_epoch, so resuming
-- doesn't bring old sessions back.
ALTER TABLE users ADD COLUMN paused_at INTEGER;     -- unix seconds; NULL = not paused
ALTER TABLE users ADD COLUMN paused_until INTEGER;  -- unix seconds; NULL = until resumed
ALTER TABLE users ADD COLUMN paused_by TEXT;

-- "Forgot password": a one-time reset link, separate from the invite so asking
-- for one doesn't sign anyone out or clear their password.
ALTER TABLE users ADD COLUMN reset_hash TEXT;       -- SHA-256 hex of the one-time token
ALTER TABLE users ADD COLUMN reset_expires INTEGER; -- unix seconds

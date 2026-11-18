-- Who created or last changed a webhook, and through which API key. When that
-- key is revoked the webhook is flagged for review (Settings shows it, System
-- status warns); it keeps sending. Older webhooks stay NULL.
ALTER TABLE webhooks ADD COLUMN changed_by TEXT;
ALTER TABLE webhooks ADD COLUMN key_id TEXT;
ALTER TABLE webhooks ADD COLUMN key_revoked_at INTEGER;

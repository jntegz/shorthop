-- Payments are matched by email only to identities the site's own server sent
-- (POST /api/sites/:id/identify), never to an email the browser reported.
ALTER TABLE sites ADD COLUMN server_emails_only INTEGER NOT NULL DEFAULT 0;

-- Link-in-bio: a link that shows a page of buttons instead of redirecting
-- (src/shared/bio.ts). NULL for ordinary links. The target stays as the
-- address older Workers (and anything that can't render the page) send people to.
ALTER TABLE links ADD COLUMN bio TEXT;

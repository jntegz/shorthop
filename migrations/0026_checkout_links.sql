-- Short links that go straight to a hosted checkout (Stripe Payment Links,
-- Lemon Squeezy, Dodo, Creem, Gumroad): each human click gets a random
-- reference in the checkout URL, recorded here. When a payment webhook brings
-- the reference back, the matcher turns the click into a visit of the site the
-- payment connection belongs to, credited to the link. No IP, no visitor hash.
CREATE TABLE link_clicks (
  ref TEXT PRIMARY KEY,                       -- the reference added to the checkout URL
  domain TEXT NOT NULL,
  slug TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '',
  clicked_at INTEGER NOT NULL
);
CREATE INDEX link_clicks_clicked ON link_clicks (clicked_at);

-- How a visit started: '' on the site itself, 'checkout' for a short-link
-- click straight to a checkout (never on the site, so left out of traffic counts).
ALTER TABLE web_sessions ADD COLUMN via TEXT NOT NULL DEFAULT '';

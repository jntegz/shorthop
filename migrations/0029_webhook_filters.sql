-- Narrows a webhook's link.clicked events to links with one of these tags:
-- JSON {"tags": ["launch", …]}. NULL (or no tags) sends every human click.
ALTER TABLE webhooks ADD COLUMN filters TEXT;

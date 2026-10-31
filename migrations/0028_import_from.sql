-- Where an imported link came from, so its page can say "Bitly lifetime clicks"
-- and the like. NULL for links made here. source stays 'import' for every
-- imported link (it keeps http:// destinations editable).
ALTER TABLE links ADD COLUMN import_from TEXT;

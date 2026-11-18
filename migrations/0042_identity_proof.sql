-- Whether a payment's match says who the buyer is. A checkout reference (sh_ref
-- and the like) credits a visit, but anyone can put one on a checkout address, so
-- it proves nothing about the person. Set for a match through an email the site's
-- server reported, or a visitor the site's server named for the payment. Medium
-- confidence has only ever come from the first of these; everything else stays 0.
ALTER TABLE payments ADD COLUMN proves_identity INTEGER NOT NULL DEFAULT 0;
UPDATE payments SET proves_identity = 1 WHERE confidence = 'medium';

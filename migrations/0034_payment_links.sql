-- Ids a provider reports for a charge apart from the charge itself, kept until
-- the charge is stored: Stripe's invoice_payment.paid names the PaymentIntent
-- or charge that paid an invoice, and may arrive before invoice.paid does.
-- A row is removed once its charge has learned the id.
CREATE TABLE payment_links (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  charge_ref TEXT NOT NULL,               -- an id the charge is stored under (in_...)
  ref TEXT NOT NULL,                      -- another id of the same payment (pi_..., ch_...)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, provider, charge_ref, ref)
);

-- A refund row that holds a charge's running total: when that total was read.
-- A single refund made before then is already inside it and is not added again.
ALTER TABLE payments ADD COLUMN total_at INTEGER;

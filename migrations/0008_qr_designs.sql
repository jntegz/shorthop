-- QR code design per link (src/shared/qr.ts), so a code can be downloaded
-- again exactly as printed. NULL: the default design (settings "qr_default").
ALTER TABLE links ADD COLUMN qr TEXT;

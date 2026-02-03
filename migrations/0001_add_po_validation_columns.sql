-- Add PO validation columns to email_po_attachments table
-- Run this migration manually if db:push fails

ALTER TABLE email_po_attachments
ADD COLUMN IF NOT EXISTS is_valid_po BOOLEAN DEFAULT NULL;

ALTER TABLE email_po_attachments
ADD COLUMN IF NOT EXISTS not_po_reason TEXT DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN email_po_attachments.is_valid_po IS 'NULL = not analyzed, true = confirmed PO, false = not a PO';
COMMENT ON COLUMN email_po_attachments.not_po_reason IS 'Why document is not a PO (e.g., "This is a quotation")';

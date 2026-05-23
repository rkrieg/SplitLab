-- Add scan_results JSONB column to tests table
-- Stores the output of the page scanner (elements found on the page)
-- Just a snapshot — not a separate table, not historical
ALTER TABLE tests ADD COLUMN IF NOT EXISTS scan_results JSONB;

-- Add redirect_url column to test_variants for external URL split testing
ALTER TABLE test_variants ADD COLUMN IF NOT EXISTS redirect_url TEXT;

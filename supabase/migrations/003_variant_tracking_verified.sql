-- Add tracking verification columns to test_variants
ALTER TABLE test_variants
ADD COLUMN tracking_verified BOOLEAN DEFAULT NULL,
ADD COLUMN tracking_verified_at TIMESTAMPTZ DEFAULT NULL;

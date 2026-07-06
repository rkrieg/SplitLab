-- Drop legacy AI scrape-to-variant tables and columns.
-- Safe when variant_pages / scraped_pages are empty (prod verified).

DROP TABLE IF EXISTS variant_pages;
DROP TABLE IF EXISTS scraped_pages;

ALTER TABLE test_variants DROP COLUMN IF EXISTS is_ai_generated;
ALTER TABLE test_variants DROP COLUMN IF EXISTS hosted_url;

-- Reset any orphaned hosted variants to external (dev may have rows)
UPDATE test_variants SET variant_type = 'external' WHERE variant_type = 'hosted';

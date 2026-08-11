-- ============================================================
-- VARIANT ARCHIVING
-- ============================================================
-- Lets a variant be archived: removed from the live traffic split and hidden
-- from the active variants list, while keeping all of its historical stats.
-- Archived variants show in a collapsible section below the active ones.
ALTER TABLE test_variants
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_test_variants_archived_at
  ON test_variants (archived_at);

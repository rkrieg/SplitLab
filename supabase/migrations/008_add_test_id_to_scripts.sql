-- Add test_id to scripts table for test-scoped script assignment.
-- Previously scripts could only be scoped to a workspace (page_id IS NULL)
-- or a specific custom HTML page (page_id = UUID). Hosted URL pages never
-- created a pages record, so they were invisible to the script assignment
-- system. This column allows scripts to be scoped to any test (both custom
-- HTML and hosted URL), giving per-page granularity without fake pages rows.
--
-- Scoping rules after this migration:
--   page_id IS NULL AND test_id IS NULL  →  workspace-level (all pages)
--   page_id = UUID                       →  legacy page-scoped (still supported)
--   test_id = UUID                       →  test-scoped (new, used by dropdown)

ALTER TABLE scripts ADD COLUMN IF NOT EXISTS test_id UUID REFERENCES tests(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_scripts_test_id ON scripts(test_id);

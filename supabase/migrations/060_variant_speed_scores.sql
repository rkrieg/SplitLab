-- Per-variant PageSpeed (Lighthouse) performance scores, run on demand.
-- 0-100 each; NULL until first tested. speed_tested_at records the last run.
ALTER TABLE test_variants
  ADD COLUMN IF NOT EXISTS speed_mobile    INTEGER,
  ADD COLUMN IF NOT EXISTS speed_desktop   INTEGER,
  ADD COLUMN IF NOT EXISTS speed_tested_at TIMESTAMPTZ;

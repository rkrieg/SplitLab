-- ============================================================
-- SCRAPED PAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS scraped_pages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url               TEXT UNIQUE NOT NULL,
  html              TEXT NOT NULL,
  analysis          JSONB,
  screenshot_desktop TEXT,
  screenshot_mobile  TEXT,
  scraped_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scraped_pages_url ON scraped_pages(url);

-- ============================================================
-- VARIANT PAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS variant_pages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id        UUID NOT NULL REFERENCES test_variants(id) ON DELETE CASCADE,
  html_storage_path TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  generation_prompt TEXT,
  changes_summary   JSONB,
  status            TEXT NOT NULL DEFAULT 'generating',
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_variant_pages_variant_id ON variant_pages(variant_id);

-- ============================================================
-- ADD COLUMNS TO TEST_VARIANTS
-- ============================================================
ALTER TABLE test_variants ADD COLUMN IF NOT EXISTS is_ai_generated BOOLEAN DEFAULT false;
ALTER TABLE test_variants ADD COLUMN IF NOT EXISTS hosted_url TEXT;
ALTER TABLE test_variants ADD COLUMN IF NOT EXISTS variant_type TEXT DEFAULT 'external';

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE scraped_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE variant_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on scraped_pages"
  ON scraped_pages
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access on variant_pages"
  ON variant_pages
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

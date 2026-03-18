-- ============================================================
-- AI Page Builder: extend pages table + page_performance
-- ============================================================

-- Add AI builder columns to existing pages table
ALTER TABLE pages ADD COLUMN IF NOT EXISTS prompt TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);
ALTER TABLE pages ADD COLUMN IF NOT EXISTS brand_settings JSONB;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS quality_score INTEGER;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS quality_details JSONB;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS published_url TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'manual'
  CHECK (source_type IN ('manual', 'ai_generated'));

-- ============================================================
-- PAGE PERFORMANCE (learning loop data)
-- ============================================================
CREATE TABLE IF NOT EXISTS page_performance (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id           UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  vertical          VARCHAR(50),
  total_views       INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  conversion_rate   NUMERIC(5,4) DEFAULT 0,
  section_order     JSONB,
  headline_style    VARCHAR(100),
  form_field_count  INTEGER,
  has_video         BOOLEAN DEFAULT FALSE,
  cta_count         INTEGER,
  recorded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_page_performance_page_id ON page_performance(page_id);
CREATE INDEX IF NOT EXISTS idx_page_performance_vertical ON page_performance(vertical);
CREATE INDEX IF NOT EXISTS idx_pages_source_type ON pages(source_type);

ALTER TABLE page_performance DISABLE ROW LEVEL SECURITY;

-- Columns and tables that were added directly to the dev DB
-- without a corresponding migration file. Run this after 001–014.

-- test_variants: tracking verification + proxy_mode
ALTER TABLE test_variants ADD COLUMN IF NOT EXISTS tracking_verified BOOLEAN DEFAULT NULL;
ALTER TABLE test_variants ADD COLUMN IF NOT EXISTS tracking_verified_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE test_variants ADD COLUMN IF NOT EXISTS proxy_mode BOOLEAN DEFAULT true;

-- domains: fallback_url
ALTER TABLE domains ADD COLUMN IF NOT EXISTS fallback_url TEXT;

-- pages: AI generation and quality columns
ALTER TABLE pages ADD COLUMN IF NOT EXISTS prompt TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS vertical VARCHAR;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS brand_settings JSONB;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS quality_score INTEGER;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS quality_details JSONB;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS published_url TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_type VARCHAR DEFAULT 'manual';

-- page_performance: entire table (never had a migration file)
CREATE TABLE IF NOT EXISTS page_performance (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id           UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  vertical          VARCHAR,
  total_views       INTEGER DEFAULT 0,
  total_conversions INTEGER DEFAULT 0,
  conversion_rate   NUMERIC DEFAULT 0,
  section_order     JSONB,
  headline_style    VARCHAR,
  form_field_count  INTEGER,
  has_video         BOOLEAN DEFAULT false,
  cta_count         INTEGER,
  recorded_at       TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE page_performance DISABLE ROW LEVEL SECURITY;
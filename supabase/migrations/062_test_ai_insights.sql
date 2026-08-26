-- Cached AI Insights for a test (generated from our own per-variant stats +
-- optional Clarity page-level behavioral metrics). Stored so the pane loads
-- instantly and we don't re-run the model / re-hit Clarity's rate-limited API
-- on every view. Shape: { generatedAt, model, summary, variants:[...],
-- recommendations:[...], clarity:{used,note} }.
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS ai_insights JSONB;

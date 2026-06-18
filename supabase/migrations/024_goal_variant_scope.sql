-- Allow goals to be scoped to a specific variant.
-- NULL = test-level goal (existing behavior, tracked across all variants).
-- Non-null = only fires for that variant.
ALTER TABLE conversion_goals
  ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES test_variants(id) ON DELETE CASCADE;

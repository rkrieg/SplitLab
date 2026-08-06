-- Track which variant a duplicate was cloned from. Points at the immediate
-- parent (not the root ancestor) — if a duplicate is itself duplicated again,
-- walk the chain via this column rather than flattening it at write time.
-- ON DELETE SET NULL: deleting the source variant later must not cascade to
-- (or break) variants that were duplicated from it — this is a lineage
-- marker, not a hard dependency.
ALTER TABLE test_variants
  ADD COLUMN IF NOT EXISTS duplicated_from_id UUID REFERENCES test_variants(id) ON DELETE SET NULL;

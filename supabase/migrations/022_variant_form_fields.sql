-- ============================================================
-- Store form field names per variant, populated by tracker.js
-- on page load (before any lead is submitted)
-- ============================================================

CREATE TABLE variant_form_fields (
  variant_id  uuid PRIMARY KEY REFERENCES test_variants(id) ON DELETE CASCADE,
  fields      text[] NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE variant_form_fields DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- Dynamic UTM/click-ID field support for HubSpot mapping
-- ============================================================
-- Two independent concerns, kept in separate tables on purpose:
--
-- 1. custom_utm_params: params staff manually register (not auto-detected
--    from a URL pattern) so they get hidden-field-injected + become
--    mappable. Scope is chosen at creation time via test_id:
--      test_id IS NULL     -> applies to every test in the workspace
--      test_id IS NOT NULL -> applies only to that one test
--    Two partial unique indexes (rather than one UNIQUE(workspace_id,
--    test_id, name)) because Postgres treats NULL as distinct from NULL in
--    a plain unique constraint — two workspace-wide rows with the same name
--    would NOT collide under a naive constraint.
--
-- 2. dismissed_lead_fields: staff can dismiss an auto-discovered
--    extra_params key from the "new fields" suggestion list in the mapping
--    screen. Deliberately NOT stored in test_integration_mappings.field_mappings
--    — that JSON is what actually drives what gets sent to HubSpot, and a
--    sentinel "dismissed" value in there risks being read back as a real
--    HubSpot property name. Dismissing a suggestion must never be able to
--    corrupt real sync config.

CREATE TABLE IF NOT EXISTS custom_utm_params (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  test_id       UUID REFERENCES tests(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custom_utm_params_workspace ON custom_utm_params(workspace_id);
CREATE INDEX IF NOT EXISTS idx_custom_utm_params_test ON custom_utm_params(test_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_utm_params_workspace_unique
  ON custom_utm_params(workspace_id, name) WHERE test_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_utm_params_test_unique
  ON custom_utm_params(workspace_id, test_id, name) WHERE test_id IS NOT NULL;

ALTER TABLE custom_utm_params DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS dismissed_lead_fields (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(test_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_dismissed_lead_fields_test ON dismissed_lead_fields(test_id);

ALTER TABLE dismissed_lead_fields DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPC: distinct extra_params keys ever captured for a test
-- Mirrors get_distinct_form_field_keys (021_test_integration_mappings.sql)
-- but over extra_params instead of form_fields — kept as a separate function
-- (not merged into the existing one) so the two stay independently queryable,
-- matching the deliberate form-fields-vs-ad-params UI separation.
-- ============================================================

CREATE OR REPLACE FUNCTION get_distinct_extra_param_keys(p_test_id uuid)
RETURNS TABLE(key text) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT jsonb_object_keys(extra_params)
  FROM form_leads
  WHERE test_id = p_test_id;
END;
$$ LANGUAGE plpgsql;

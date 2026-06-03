-- ============================================================
-- Replace per-variant mappings with per-test mappings
-- One mapping table per test (not per variant)
-- ============================================================

DROP TABLE IF EXISTS variant_integration_mappings CASCADE;

CREATE TABLE test_integration_mappings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id                   uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  workspace_integration_id  uuid NOT NULL REFERENCES workspace_integrations(id) ON DELETE CASCADE,
  enabled                   boolean NOT NULL DEFAULT false,
  -- field_mappings: { "our_field": "hubspot_property_name" }
  -- our_field: system field (ip_address, variant, submitted_at, utm_*) or any form field key
  field_mappings            jsonb NOT NULL DEFAULT '{}',
  -- sync tracking
  last_synced_at            timestamptz,
  total_synced              integer NOT NULL DEFAULT 0,
  total_failed              integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE(test_id, workspace_integration_id)
);

CREATE INDEX idx_test_integration_mappings_test_id ON test_integration_mappings(test_id);
CREATE INDEX idx_test_integration_mappings_integration_id ON test_integration_mappings(workspace_integration_id);

ALTER TABLE test_integration_mappings DISABLE ROW LEVEL SECURITY;

CREATE TRIGGER update_test_integration_mappings_updated_at
  BEFORE UPDATE ON test_integration_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Update RPC helpers to reference test_integration_mappings
-- ============================================================

CREATE OR REPLACE FUNCTION increment_integration_synced(p_mapping_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE test_integration_mappings
  SET total_synced = total_synced + 1,
      last_synced_at = now()
  WHERE id = p_mapping_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION increment_integration_failed(p_mapping_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE test_integration_mappings
  SET total_failed = total_failed + 1
  WHERE id = p_mapping_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: get distinct form field keys across ALL variants of a test
-- ============================================================

DROP FUNCTION IF EXISTS get_distinct_form_field_keys(uuid);

CREATE OR REPLACE FUNCTION get_distinct_form_field_keys(p_test_id uuid)
RETURNS TABLE(key text) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT jsonb_object_keys(form_fields)
  FROM form_leads
  WHERE test_id = p_test_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Integrations: workspace-level credentials + per-variant mappings
-- ============================================================

CREATE TABLE workspace_integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type          text NOT NULL,  -- 'hubspot' (extensible for future integrations)
  config        jsonb NOT NULL DEFAULT '{}',  -- { access_token: string }
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, type)
);

CREATE TABLE variant_integration_mappings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id                uuid NOT NULL REFERENCES test_variants(id) ON DELETE CASCADE,
  workspace_integration_id  uuid NOT NULL REFERENCES workspace_integrations(id) ON DELETE CASCADE,
  enabled                   boolean NOT NULL DEFAULT false,
  -- field_mappings: { "our_field": "hubspot_property_name" }
  -- our_field can be a system field (ip_address, variant, submitted_at, utm_source, etc.)
  -- or a form field key from form_leads.form_fields
  field_mappings            jsonb NOT NULL DEFAULT '{}',
  -- sync tracking
  last_synced_at            timestamptz,
  total_synced              integer NOT NULL DEFAULT 0,
  total_failed              integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE(variant_id, workspace_integration_id)
);

CREATE INDEX idx_workspace_integrations_workspace_id ON workspace_integrations(workspace_id);
CREATE INDEX idx_variant_integration_mappings_variant_id ON variant_integration_mappings(variant_id);
CREATE INDEX idx_variant_integration_mappings_integration_id ON variant_integration_mappings(workspace_integration_id);

ALTER TABLE workspace_integrations DISABLE ROW LEVEL SECURITY;
ALTER TABLE variant_integration_mappings DISABLE ROW LEVEL SECURITY;

CREATE TRIGGER update_workspace_integrations_updated_at
  BEFORE UPDATE ON workspace_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_variant_integration_mappings_updated_at
  BEFORE UPDATE ON variant_integration_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- RPC helpers for atomic counter increments
-- ============================================================

CREATE OR REPLACE FUNCTION increment_integration_synced(p_mapping_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE variant_integration_mappings
  SET total_synced = total_synced + 1,
      last_synced_at = now()
  WHERE id = p_mapping_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION increment_integration_failed(p_mapping_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE variant_integration_mappings
  SET total_failed = total_failed + 1
  WHERE id = p_mapping_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC helper: get distinct form field keys for a variant
-- ============================================================

CREATE OR REPLACE FUNCTION get_distinct_form_field_keys(p_variant_id uuid)
RETURNS TABLE(key text) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT jsonb_object_keys(form_fields)
  FROM form_leads
  WHERE variant_id = p_variant_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC helper: merge updated OAuth tokens into config JSONB
-- Used on token refresh so other config fields are preserved
-- ============================================================

CREATE OR REPLACE FUNCTION update_integration_tokens(
  p_integration_id uuid,
  p_access_token   text,
  p_refresh_token  text,
  p_expires_at     text
)
RETURNS void AS $$
BEGIN
  UPDATE workspace_integrations
  SET config = config
    || jsonb_build_object(
         'access_token',  p_access_token,
         'refresh_token', p_refresh_token,
         'expires_at',    p_expires_at
       )
  WHERE id = p_integration_id;
END;
$$ LANGUAGE plpgsql;

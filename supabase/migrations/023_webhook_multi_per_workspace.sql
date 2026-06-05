-- Allow multiple webhook integrations per workspace.
-- HubSpot and Email still use upsert in code, so they remain effectively unique.
ALTER TABLE workspace_integrations
DROP CONSTRAINT workspace_integrations_workspace_id_type_key;

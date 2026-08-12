-- ============================================================
-- MCP AUDIT LOG
-- ============================================================
-- Every write an MCP tool makes on a user's behalf is logged here — added
-- now (Phase 0) even though no UI surfaces it yet, since retrofitting an
-- audit trail after MCP-originated rows already exist is riskier than
-- adding the storage upfront. Later this can back an "edited via AI"
-- indicator in the dashboard. NOT run by this migration file; apply
-- manually when ready.
CREATE TABLE IF NOT EXISTS mcp_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id      UUID REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  target_table  TEXT,
  target_id     TEXT,
  status        TEXT NOT NULL, -- 'ok' | 'error'
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_user_id ON mcp_audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_created_at ON mcp_audit_log (created_at);

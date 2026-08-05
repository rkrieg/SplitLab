-- Holds invites for users who already have an account (existing email invited
-- into a new client's workspace). Membership is only granted once the invite
-- is accepted via the emailed link — unlike brand-new users, an existing user
-- can already log in, so without this gate they'd get instant access with no
-- consent step.
CREATE TABLE IF NOT EXISTS pending_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('manager', 'viewer')),
  -- Not unique: one token is shared across multiple rows when a single
  -- invite covers several workspaces owned by the same manager.
  token VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_invites_token ON pending_invites(token);
CREATE INDEX IF NOT EXISTS idx_pending_invites_user_id ON pending_invites(user_id);

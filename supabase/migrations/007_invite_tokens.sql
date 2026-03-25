-- Invite tokens for password-less user invitations
CREATE TABLE IF NOT EXISTS invite_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_invite_tokens_token ON invite_tokens(token);

-- Add 'invited' status to users (they can't log in until they accept)
-- Existing users stay 'active'; new invites will be 'invited' until accepted

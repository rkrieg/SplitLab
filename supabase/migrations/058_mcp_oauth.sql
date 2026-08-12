-- ============================================================
-- MCP OAUTH 2.1 AUTHORIZATION SERVER
-- ============================================================
-- Lets Claude Desktop/Code/claude.ai (or ChatGPT) connect to a user's
-- SplitLab account over MCP. The resulting access token maps back onto the
-- exact same {id, role, plan} shape session.user already has (see
-- resolveMcpPrincipal in src/lib/mcp/auth.ts) — there is no separate
-- authorization model, just a new way to arrive at the same principal.
--
-- Secrets/tokens are stored as hashes only, same convention as
-- users.password_hash — never store raw client secrets or access/refresh
-- tokens. NOT run by this migration file; apply manually when ready.

-- Registered OAuth clients (Dynamic Client Registration, RFC 7591).
-- client_secret_hash is nullable because public clients using PKCE (Claude
-- Desktop, Claude Code) register without a secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id                 TEXT PRIMARY KEY,             -- e.g. 'mcp_xxxxxxxx'
  client_secret_hash TEXT,
  client_name        TEXT NOT NULL,
  redirect_uris      TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived authorization codes (PKCE flow). Single-use — consumed_at is
-- set the moment /api/oauth/token exchanges the code, and the token
-- endpoint must reject an already-consumed code.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope                 TEXT NOT NULL DEFAULT 'splitlab:read splitlab:write',
  expires_at            TIMESTAMPTZ NOT NULL,
  consumed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires_at ON oauth_authorization_codes (expires_at);

-- Issued access/refresh token pairs. Access tokens should be short-lived
-- (e.g. 1h); refresh tokens rotate on use. revoked_at lets a user disconnect
-- an assistant from SplitLab without waiting for natural expiry.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token_hash   TEXT NOT NULL UNIQUE,
  refresh_token_hash  TEXT UNIQUE,
  client_id           TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope               TEXT NOT NULL DEFAULT 'splitlab:read splitlab:write',
  expires_at          TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_hash ON oauth_tokens (access_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_hash ON oauth_tokens (refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens (user_id);

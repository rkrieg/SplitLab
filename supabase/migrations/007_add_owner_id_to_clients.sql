-- Add owner_id to clients for tenant isolation
-- Each client is owned by the user (manager) who created it.
-- Admins own no clients (NULL) but can see all via role check.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL;

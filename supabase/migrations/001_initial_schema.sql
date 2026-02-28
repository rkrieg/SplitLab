-- ============================================================
-- SplitLab Initial Schema
-- Run this in your Supabase SQL editor or via supabase db push
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  logo_url    TEXT,
  status      VARCHAR(20) DEFAULT 'active'
                CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- WORKSPACES
-- ============================================================
CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) NOT NULL,
  status      VARCHAR(20) DEFAULT 'active'
                CHECK (status IN ('active', 'archived')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, slug)
);

-- ============================================================
-- DOMAINS
-- ============================================================
CREATE TABLE IF NOT EXISTS domains (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain        VARCHAR(255) NOT NULL UNIQUE,
  cname_target  VARCHAR(255),
  verified      BOOLEAN DEFAULT FALSE,
  verified_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USERS  (internal agency staff, not end-visitors)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  name           VARCHAR(255) NOT NULL,
  password_hash  TEXT NOT NULL,
  role           VARCHAR(20) DEFAULT 'viewer'
                   CHECK (role IN ('admin', 'manager', 'viewer')),
  status         VARCHAR(20) DEFAULT 'active'
                   CHECK (status IN ('active', 'inactive')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- WORKSPACE MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS workspace_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(20) DEFAULT 'viewer'
                  CHECK (role IN ('manager', 'viewer')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)
);

-- ============================================================
-- PAGES  (HTML landing pages)
-- ============================================================
CREATE TABLE IF NOT EXISTS pages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(500),
  html_url      TEXT NOT NULL,
  html_content  TEXT,
  tags          TEXT[] DEFAULT '{}',
  status        VARCHAR(20) DEFAULT 'active'
                  CHECK (status IN ('active', 'archived')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS tests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  url_path      VARCHAR(500) NOT NULL,
  status        VARCHAR(20) DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TEST VARIANTS
-- ============================================================
CREATE TABLE IF NOT EXISTS test_variants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id         UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  page_id         UUID REFERENCES pages(id) ON DELETE SET NULL,
  traffic_weight  INTEGER NOT NULL DEFAULT 50,
  is_control      BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONVERSION GOALS
-- ============================================================
CREATE TABLE IF NOT EXISTS conversion_goals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id      UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  type         VARCHAR(50) NOT NULL
                 CHECK (type IN ('form_submit', 'button_click', 'url_reached', 'call_click')),
  selector     TEXT,
  url_pattern  TEXT,
  is_primary   BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SCRIPTS
-- ============================================================
CREATE TABLE IF NOT EXISTS scripts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id       UUID REFERENCES pages(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(50) NOT NULL
                  CHECK (type IN ('gtm', 'meta_pixel', 'ga4', 'custom')),
  content       TEXT NOT NULL,
  placement     VARCHAR(20) DEFAULT 'head'
                  CHECK (placement IN ('head', 'body_end')),
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- EVENTS  (pageviews & conversions)
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  variant_id    UUID NOT NULL REFERENCES test_variants(id) ON DELETE CASCADE,
  goal_id       UUID REFERENCES conversion_goals(id) ON DELETE SET NULL,
  visitor_hash  VARCHAR(64) NOT NULL,
  type          VARCHAR(50) NOT NULL
                  CHECK (type IN ('pageview', 'conversion')),
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_workspaces_client_id   ON workspaces(client_id);
CREATE INDEX IF NOT EXISTS idx_domains_workspace_id   ON domains(workspace_id);
CREATE INDEX IF NOT EXISTS idx_domains_domain         ON domains(domain);
CREATE INDEX IF NOT EXISTS idx_workspace_members_ws   ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_pages_workspace_id     ON pages(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tests_workspace_id     ON tests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_test_variants_test_id  ON test_variants(test_id);
CREATE INDEX IF NOT EXISTS idx_conversion_goals_test  ON conversion_goals(test_id);
CREATE INDEX IF NOT EXISTS idx_scripts_workspace_id   ON scripts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_events_test_id         ON events(test_id);
CREATE INDEX IF NOT EXISTS idx_events_variant_id      ON events(variant_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at      ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_visitor_hash    ON events(visitor_hash);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pages_updated_at
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tests_updated_at
  BEFORE UPDATE ON tests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_scripts_updated_at
  BEFORE UPDATE ON scripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ROW LEVEL SECURITY (disable for service-role access)
-- ============================================================
ALTER TABLE clients           DISABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces        DISABLE ROW LEVEL SECURITY;
ALTER TABLE domains           DISABLE ROW LEVEL SECURITY;
ALTER TABLE users             DISABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members DISABLE ROW LEVEL SECURITY;
ALTER TABLE pages             DISABLE ROW LEVEL SECURITY;
ALTER TABLE tests             DISABLE ROW LEVEL SECURITY;
ALTER TABLE test_variants     DISABLE ROW LEVEL SECURITY;
ALTER TABLE conversion_goals  DISABLE ROW LEVEL SECURITY;
ALTER TABLE scripts           DISABLE ROW LEVEL SECURITY;
ALTER TABLE events            DISABLE ROW LEVEL SECURITY;

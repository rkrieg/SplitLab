-- An AI edit now survives the tab that started it, the same way a build does.
-- It reuses page_builds as its lock, so a row needs to say which kind of work
-- it is: a returning tab must not open the build progress screen for an edit.
--
-- Existing rows are all builds, hence the default.
ALTER TABLE page_builds
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'build';   -- build | edit

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('072', 'page_builds_kind') ON CONFLICT (version) DO NOTHING;

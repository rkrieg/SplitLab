-- One row per AI page build, so a build outlives the browser that asked for it.
--
-- Builds used to live entirely in the requesting tab: it held the SSE stream
-- open for the whole run and saved the result itself, so navigating away lost
-- the lot. The build now runs in the background and writes here; the tab only
-- polls. See the diagram at the top of src/app/api/pages/build/route.ts.
CREATE TABLE IF NOT EXISTS page_builds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'running',   -- running | saving | done | error
  -- Progress events, in order, exactly as they used to go down the wire.
  events       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The finished 'done' event. Read by a tab that reattaches after the fact.
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Bumped by every append. A run killed at the platform's duration cap cannot
  -- mark its own row, so staleness is judged from this on read.
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_page_builds_page ON page_builds(page_id, created_at DESC);

-- At most one live build per page.
--
-- The route checks for a running build before inserting, but check-then-act
-- loses a race two tabs (or one double click) can really run: both see nothing
-- and both start, then both write the same page and the last one wins. This
-- settles it where the race actually happens.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_page_builds_live
  ON page_builds(page_id)
  WHERE status IN ('running', 'saving');

ALTER TABLE page_builds DISABLE ROW LEVEL SECURITY;

-- Atomic append. Reading the array, pushing, and writing it back would drop
-- events whenever two appends overlap, and costs a round trip per event — one
-- real build emitted ~250 of them.
CREATE OR REPLACE FUNCTION append_build_events(p_build_id uuid, p_events jsonb)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE page_builds
     SET events = events || p_events,
         updated_at = now()
   WHERE id = p_build_id;
$$;

-- ── Ledger ──────────────────────────────────────────────────────────────────
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('071', 'page_builds')
ON CONFLICT (version) DO NOTHING;

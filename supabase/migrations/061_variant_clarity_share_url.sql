-- Optional per-variant Microsoft Clarity "Share" link. When set, the analytics
-- row's "Recordings/Heatmap" button opens this pre-filtered view directly;
-- otherwise it deep-links to the workspace's Clarity project (filter by the
-- sl_variant custom tag). Workspace-level Clarity project id lives in
-- workspace_integrations (type='clarity', config={ project_id }).
ALTER TABLE test_variants
  ADD COLUMN IF NOT EXISTS clarity_share_url TEXT;

-- Per-test switch for forwarding UTM / ad-click params onto outbound
-- destinations (outbound link clicks + redirect/proxy destination URLs).
-- Default ON. When false, sl_* tracking context and lead-form capture are
-- unaffected — only the pass-through of ad params to the next URL is disabled.
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS forward_url_params BOOLEAN NOT NULL DEFAULT true;

-- AI builder Skills + Style selection.
--
-- Both are nullable and both have a meaning for NULL, so no backfill is needed
-- and nothing about existing pages changes:
--   skills = NULL -> the page predates the picker; the mandatory skill is
--                    applied at read time by resolveSkills().
--   style  = NULL -> "Auto", which is the behaviour every page has had until
--                    now (the design-brief call picks the style).
--
-- Read and written only through src/lib/skills/persistence.ts, which swallows
-- errors on purpose: if this migration has not been applied yet, page builds
-- must keep working with no skills persisted rather than failing.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS skills TEXT[];
ALTER TABLE pages ADD COLUMN IF NOT EXISTS style VARCHAR;

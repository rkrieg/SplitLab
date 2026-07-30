-- UTM Personalization V2: hero auto-field-mapping storage.
-- See docs/utm-personalization-v2-automation.md ("Hero auto-field-mapping design").
--
-- Separate from the manual `field_selectors_json` — same shape
-- (Record<string, { selector, type, label }>), but its own column, never
-- merged/deduped with manual mappings (manual keys are arbitrary slugified
-- user labels; auto mapping uses fixed keys: hero.headline, hero.subhead,
-- hero.cta_text, hero.background_image). See doc for why merging was
-- explicitly rejected.
alter table pages
  add column if not exists auto_field_selectors_json jsonb;

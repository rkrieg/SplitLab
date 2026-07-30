-- UTM Personalization V2, PIVOT 3 (2026-07-31). See docs/utm-personalization-v2-automation.md,
-- "PIVOT 3" section. Replaces `utm_auto_rules.fields`/`hint` (one shared
-- hint for a set of AND'd fields) with `rows` (an ordered list of per-field
-- rows, each independently a literal filter or an AI-judged category with
-- its own personalization instructions).
--
-- A row is {field, look_for, personalize, instructions?}:
--   - field: which UTM/tracking param this row watches.
--   - look_for: for personalize=false rows, a literal filter value (matched
--     case-insensitive/contains at judge time); for personalize=true rows, a
--     loose category description for AI to judge against the actual value
--     (e.g. "location", "messaging angle") — never a literal value.
--   - personalize: whether this row's detected value should drive content
--     generation (true) or is purely a match/filter condition (false).
--   - instructions: optional, only meaningful when personalize=true — how
--     to use the detected value in the generated content.
-- The same field may appear in multiple rows with different look_for targets.

alter table utm_auto_rules add column if not exists rows jsonb not null default '[]';
alter table utm_auto_rules drop column if exists fields;
alter table utm_auto_rules drop column if exists hint;

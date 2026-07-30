-- UTM Personalization V2, race-condition fix (2026-07-31). See
-- docs/utm-personalization-v2-automation.md, "Bug found this session —
-- duplicate-rule race condition" (PIVOT 3 follow-up). insertLiveAutoRule()'s
-- duplicate check was a select-then-insert (app-level, non-atomic) — two
-- concurrent cron invocations (e.g. the cron endpoint manually triggered
-- twice in close succession during testing) could both pass the "does this
-- condition combination already exist" check before either insert
-- committed, producing two personalization_rules rows with identical
-- conditions. This migration moves the guarantee to the database.

alter table personalization_rules add column if not exists condition_signature text;

-- Backfill: multi-condition rows (conditions_json array, current shape).
update personalization_rules
set condition_signature = (
  select string_agg(
    (cond->>'match_param') || '=' || lower(trim(cond->>'match_value')),
    '&' order by (cond->>'match_param') || '=' || lower(trim(cond->>'match_value'))
  )
  from jsonb_array_elements(conditions_json) as cond
)
where is_fallback = false
  and conditions_json is not null
  and jsonb_array_length(conditions_json) > 0
  and condition_signature is null;

-- Backfill: legacy single-condition rows (no conditions_json populated, only
-- the older match_param/match_value columns).
update personalization_rules
set condition_signature = match_param || '=' || lower(trim(match_value))
where is_fallback = false
  and (conditions_json is null or jsonb_array_length(conditions_json) = 0)
  and match_value is not null
  and condition_signature is null;

-- Remove pre-existing exact-duplicate rows (same page + same condition
-- signature) before the constraint below can be added — keep the oldest row
-- of each duplicate set, drop the rest.
delete from personalization_rules p
using personalization_rules p2
where p.is_fallback = false
  and p2.is_fallback = false
  and p.page_id = p2.page_id
  and p.condition_signature = p2.condition_signature
  and p.condition_signature is not null
  and (p.created_at > p2.created_at or (p.created_at = p2.created_at and p.id > p2.id));

-- Enforce going forward, atomically: one rule per (page, condition
-- signature). Postgres treats NULL as distinct from every other NULL for
-- uniqueness purposes, so fallback rows (condition_signature always NULL)
-- are never affected by this constraint.
create unique index if not exists idx_personalization_rules_page_signature
  on personalization_rules (page_id, condition_signature);

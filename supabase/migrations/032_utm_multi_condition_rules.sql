-- Multi-condition UTM rules: a rule can now match on multiple UTM params at once
-- (e.g. utm_source=facebook AND utm_campaign=builder), not just one.
--
-- conditions_json: array of { "match_param": "utm_source", "match_value": "facebook" }.
-- Nullable and additive — existing rows keep working unchanged via the legacy
-- match_param/match_value columns (still populated for backward compatibility:
-- the app dual-writes the first condition into match_param/match_value on save).
alter table personalization_rules
  add column if not exists conditions_json jsonb;

-- The old constraint forced every non-fallback row to carry a single match_value.
-- We keep dual-writing match_param/match_value for the first condition (so this
-- constraint still holds and legacy readers keep working), but relax it to also
-- accept a row that only has conditions_json populated, in case that changes later.
alter table personalization_rules
  drop constraint if exists personalization_rules_match_value_required;

alter table personalization_rules
  add constraint personalization_rules_match_value_required
  check (
    is_fallback = true
    or match_value is not null
    or (conditions_json is not null and jsonb_array_length(conditions_json) > 0)
  );

-- Cap conditions per rule at 5 (enforced in the API too; this is a hard backstop).
alter table personalization_rules
  add constraint personalization_rules_conditions_max
  check (conditions_json is null or jsonb_array_length(conditions_json) <= 5);

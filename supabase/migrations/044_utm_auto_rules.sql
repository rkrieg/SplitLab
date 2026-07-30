-- UTM Personalization V2 pivot (2026-07-30) — see docs/utm-personalization-v2-automation.md,
-- "PIVOT" section. Replaces the reactive "detect traffic, show value chips,
-- require approval" model with: user defines a rule (field(s) + optional
-- loose hint) upfront, AI judges new incoming values against it in the
-- background, and matched content goes straight live — no approval step.

-- A user-defined rule template: which UTM field(s) to watch (AND'd
-- together) and an optional loose hint describing what to look for /
-- how to personalize. Not tied to any specific value — that's the point.
create table if not exists utm_auto_rules (
  id           uuid primary key default gen_random_uuid(),
  page_id      uuid not null references pages(id) on delete cascade,
  fields       text[] not null,
  hint         text not null default '',
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_utm_auto_rules_page on utm_auto_rules(page_id);

-- Cache of AI judgments per (rule, exact value-combination) so the same
-- value-combination is only ever judged once — repeat traffic is a lookup,
-- not a repeat AI call. `personalization_rule_id` is set only when matched
-- is true, linking to the live rule that was created for this combination.
create table if not exists utm_auto_rule_matches (
  id                      uuid primary key default gen_random_uuid(),
  auto_rule_id            uuid not null references utm_auto_rules(id) on delete cascade,
  utm_sig                 text not null,
  utm                     jsonb not null default '{}',
  matched                 boolean not null,
  personalization_rule_id uuid references personalization_rules(id) on delete set null,
  judged_at               timestamptz not null default now(),
  unique (auto_rule_id, utm_sig)
);

create index if not exists idx_utm_auto_rule_matches_rule on utm_auto_rule_matches(auto_rule_id);

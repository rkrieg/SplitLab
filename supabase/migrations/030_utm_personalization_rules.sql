create table personalization_rules (
  id uuid primary key default gen_random_uuid(),
  page_id uuid references pages(id) on delete cascade not null,
  match_param text not null check (match_param in ('utm_source','utm_medium','utm_campaign','utm_content','utm_term')),
  match_value text,
  match_type text not null default 'exact',
  overrides_json jsonb not null default '{}',
  priority int not null default 0,
  is_fallback boolean not null default false,
  created_at timestamptz not null default now()
);

create index on personalization_rules(page_id);

-- Only one fallback row per page
create unique index personalization_rules_one_fallback
  on personalization_rules(page_id)
  where is_fallback = true;

-- Non-fallback rows must have a match_value
alter table personalization_rules
  add constraint personalization_rules_match_value_required
  check (is_fallback = true or match_value is not null);


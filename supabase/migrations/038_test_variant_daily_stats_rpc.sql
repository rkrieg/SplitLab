-- Server-side aggregation for the Reporting tab (chart + summary cards).
-- Same defect class as migration 037: /api/tests/[id]/reporting fetched every raw
-- event row for the test with no .range()/.limit()/.order(), so it was exposed to
-- Supabase's default 1,000-row PostgREST cap on any test with enough traffic —
-- silently truncating and randomizing the chart/cards on reload just like the
-- main analytics tab did before Bug 1 was fixed there.
--
-- Returns one row per (date, variant) bucket instead of raw events, so the result
-- set stays small (days × variants) regardless of how many events exist.
create or replace function test_variant_daily_stats(p_test_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  day date,
  variant_id uuid,
  views bigint,
  unique_visitors bigint,
  conversions bigint
)
language sql stable as $$
  with goals as (
    select id from conversion_goals where test_id = p_test_id
  )
  select
    e.created_at::date as day,
    e.variant_id,
    count(*) filter (where e.type = 'pageview') as views,
    count(distinct e.visitor_hash) filter (where e.type = 'pageview') as unique_visitors,
    count(distinct e.visitor_hash) filter (
      where e.type = 'conversion'
        and e.goal_id is not null
        and (
          (select count(*) from goals) = 0
          or e.goal_id in (select id from goals)
        )
    ) as conversions
  from events e
  where e.test_id = p_test_id
    and (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at <= p_to)
  group by e.created_at::date, e.variant_id;
$$;

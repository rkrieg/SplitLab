-- Server-side aggregation for the test analytics dashboard.
-- Replaces the unbounded `select * from events where test_id = ...` fetch in
-- /api/tests/[id]/analytics, which silently truncated at Supabase's default
-- 1,000-row PostgREST cap (no .range()/.limit()/.order() on that query),
-- producing non-deterministic views/conversions/goalHits on every reload.
create or replace function test_variant_stats(p_test_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  variant_id uuid,
  views bigint,
  unique_visitors bigint,
  conversions bigint,
  goal_hits bigint
)
language sql stable as $$
  with goals as (
    select id from conversion_goals where test_id = p_test_id
  )
  select
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
    ) as conversions,
    count(*) filter (
      where e.type = 'conversion'
        and e.goal_id is not null
        and (
          (select count(*) from goals) = 0
          or e.goal_id in (select id from goals)
        )
    ) as goal_hits
  from events e
  where e.test_id = p_test_id
    and (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at <= p_to)
  group by e.variant_id;
$$;

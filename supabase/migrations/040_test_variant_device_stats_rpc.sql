-- Device-split aggregation for the desktop/mobile CVR breakdown. Mirrors
-- test_variant_stats (037) but groups by device_type in addition to variant,
-- kept as a separate function since Postgres can't add a column to an
-- existing RETURNS TABLE function via CREATE OR REPLACE without a drop.
create or replace function test_variant_device_stats(p_test_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  variant_id uuid,
  device_type text,
  views bigint,
  unique_visitors bigint,
  conversions bigint
)
language sql stable as $$
  with goals as (
    select id from conversion_goals where test_id = p_test_id
  )
  select
    e.variant_id,
    e.device_type,
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
    and e.device_type is not null
    and (p_from is null or e.created_at >= p_from)
    and (p_to is null or e.created_at <= p_to)
  group by e.variant_id, e.device_type;
$$;

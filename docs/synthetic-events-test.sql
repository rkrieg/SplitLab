-- ============================================================
-- DEV-ONLY: Synthetic events for testing the Bug 1 row-cap fix
-- (migrations 037/038) before/after comparison.
--
-- For use in the Supabase SQL Editor (web UI) — no psql meta-commands.
-- The target test_id is hardcoded below wherever needed; every query
-- is scoped to it explicitly.
--
-- SCOPE: this ONLY inserts events for one specific, already-existing
-- test: d893ddb6-9eec-4bd9-b973-54e69cbd5204
-- (https://dev.trysplitlab.com/clients/d9a683d6-e20c-49dc-886f-22307a2eed50/tests/d893ddb6-9eec-4bd9-b973-54e69cbd5204)
--
-- No new client, workspace, test, or variant rows are created; this
-- only inserts rows into `events`, reusing that test's EXISTING
-- variants. Every synthetic visitor_hash is prefixed 'synthetic-' so
-- it's trivially removable later with one scoped DELETE (step 9).
--
-- Run each numbered block ONE AT A TIME (select the block, run it,
-- check the result, then move to the next). Do not paste the whole
-- file at once.
-- ============================================================

-- ============================================================
-- STEP 0 — sanity check: confirm the test exists, see current real
-- event volume before touching anything.
-- ============================================================

select id, name, status from tests where id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204';

select
  variant_id,
  count(*) filter (where type = 'pageview') as real_views,
  count(distinct visitor_hash) filter (where type = 'pageview') as real_unique_visitors,
  count(distinct visitor_hash) filter (where type = 'conversion') as real_conversions
from events
where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
group by variant_id;

OUTPUT:
[
  {
    "variant_id": "9dca7280-de78-4366-b11e-0339d81b9b6d",
    "real_views": 3,
    "real_unique_visitors": 3,
    "real_conversions": 1
  }
]

-- ============================================================
-- STEP 1 — confirm this test has variants to insert against.
-- If this returns 0 rows, STOP — the inserts below will silently do
-- nothing (nothing to JOIN against).
-- ============================================================

select id, name, is_control from test_variants where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204';
OUTPUT:
[
  {
    "id": "9dca7280-de78-4366-b11e-0339d81b9b6d",
    "name": "Control",
    "is_control": true
  }
]
-- ============================================================
-- STEP 2 — insert 1,600 synthetic pageview events, distributed
-- round-robin across this test's EXISTING variants, spread over 8
-- days, ~20% repeat visitor_hashes to simulate refreshes.
-- ============================================================

with variants as (
  select id, row_number() over (order by id) as rn, count(*) over () as total
  from test_variants
  where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
)
insert into events (test_id, variant_id, visitor_hash, type, created_at)
select
  'd893ddb6-9eec-4bd9-b973-54e69cbd5204'::uuid,
  v.id,
  case when (n % 5 = 0) then 'synthetic-' || md5(('visitor-' || (n / 5) || '-' || (n % 200))::text)
       else 'synthetic-' || md5(('visitor-' || n)::text)
  end,
  'pageview',
  now() - ((n % 8) || ' days')::interval - (random() * interval '20 hours')
from generate_series(1, 1600) as n
join variants v on v.rn = (n % v.total) + 1;

OUTPUT:
Success. No rows returned


-- After running: check the Supabase SQL Editor's result banner — it
-- should say something like "Success. 1600 rows affected" (or similar).
-- If it says 0 rows affected, STEP 1 returned 0 variants — go back and
-- check that first.

-- ============================================================
-- STEP 3 — insert ~130 synthetic conversions, same visitor pool
-- pattern, same variants.
-- ============================================================

with variants as (
  select id, row_number() over (order by id) as rn, count(*) over () as total
  from test_variants
  where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
)
insert into events (test_id, variant_id, visitor_hash, type, created_at)
select
  'd893ddb6-9eec-4bd9-b973-54e69cbd5204'::uuid,
  v.id,
  'synthetic-' || md5(('visitor-' || n)::text),
  'conversion',
  now() - ((n % 8) || ' days')::interval - (random() * interval '20 hours')
from generate_series(1, 1600) as n
join variants v on v.rn = (n % v.total) + 1
where n % 12 = 0;

-- ============================================================
-- STEP 4 — confirm the inserts landed. Should now be roughly
-- 1600 + ~130 + (step 0's original count).
-- ============================================================

select count(*) from events where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204';

-- ============================================================
-- STEP 5 — GROUND TRUTH: uncapped, correct aggregation.
-- Save these numbers — this is "truth."
-- ============================================================

select
  variant_id,
  count(*) filter (where type = 'pageview') as views,
  count(distinct visitor_hash) filter (where type = 'pageview') as unique_visitors,
  count(distinct visitor_hash) filter (where type = 'conversion') as conversions
from events
where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
group by variant_id;

-- ============================================================
-- STEP 6 — REPRODUCE THE OLD BUG: simulate the pre-fix behavior,
-- where PostgREST capped the unbounded select at 1,000 rows with no
-- ORDER BY. Run this block SEVERAL TIMES IN A ROW — because there's
-- no ORDER BY, Postgres can return a different arbitrary 1,000-row
-- slice each time, so the numbers should visibly shift between runs
-- and NOT match STEP 5's ground truth.
-- ============================================================

with capped_events as (
  select variant_id, type, goal_id, visitor_hash
  from events
  where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
  limit 1000
)
select
  variant_id,
  count(*) filter (where type = 'pageview') as views,
  count(distinct visitor_hash) filter (where type = 'pageview') as unique_visitors,
  count(distinct visitor_hash) filter (where type = 'conversion') as conversions
from capped_events
group by variant_id;

-- ============================================================
-- STEP 7 — apply migrations 037_test_variant_stats_rpc.sql and
-- 038_test_variant_daily_stats_rpc.sql to this dev database BEFORE
-- running the next block (paste their contents here and run, or run
-- them as separate scripts — your choice).
-- ============================================================

-- ============================================================
-- STEP 8 — CONFIRM THE FIX: run this several times in a row. It
-- should return IDENTICAL numbers every time, and those numbers
-- should exactly match STEP 5's ground truth.
-- ============================================================

select * from test_variant_stats('d893ddb6-9eec-4bd9-b973-54e69cbd5204'::uuid, null, null);

select * from test_variant_daily_stats('d893ddb6-9eec-4bd9-b973-54e69cbd5204'::uuid, null, null)
order by day, variant_id;

-- ============================================================
-- STEP 9 — CLEANUP. Removes ONLY the synthetic rows (test_id AND
-- 'synthetic-' visitor_hash prefix). Real events for this test, and
-- everything else in the database, are untouched.
-- ============================================================

delete from events
where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
  and visitor_hash like 'synthetic-%';

-- Verify cleanup — should return 0:
select count(*) from events
where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
  and visitor_hash like 'synthetic-%';

-- Confirm real data is intact (compare against STEP 0's numbers):
select
  variant_id,
  count(*) filter (where type = 'pageview') as real_views,
  count(distinct visitor_hash) filter (where type = 'pageview') as real_unique_visitors,
  count(distinct visitor_hash) filter (where type = 'conversion') as real_conversions
from events
where test_id = 'd893ddb6-9eec-4bd9-b973-54e69cbd5204'
group by variant_id;

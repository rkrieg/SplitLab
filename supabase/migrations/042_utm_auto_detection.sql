-- UTM Personalization V2: automatic audience/angle detection.
-- See docs/utm-personalization-v2-automation.md for the full design.
--
-- Distinguish auto-detected rules from manually-authored ones, and allow a
-- rule to be saved as an incomplete "shell" (condition set locked, content
-- not generated/approved yet) without tripping the existing
-- "every rule must change something" validation in the manual POST endpoint.
alter table personalization_rules
  add column if not exists source text not null default 'manual' check (source in ('manual', 'auto')),
  add column if not exists is_draft boolean not null default false;

-- The legacy `match_param` column (dual-written from a rule's first
-- condition for backward compatibility — see 032/034) was constrained to
-- the 5 manual-UI UTM params. Auto-detection can key a rule on a broader
-- set (hsa_*, ad_id/adset_id/campaign_id/creative_id/placement_id — see
-- tracker.js EXTRA_ID_PARAMS), which that CHECK would reject on insert.
-- `conditions_json` entries were never constrained this way; app-level
-- validation in each route is the actual source of truth for allowed
-- values now, so this constraint is relaxed to just "non-empty" instead of
-- re-listing every allowed param here too.
alter table personalization_rules drop constraint if exists personalization_rules_match_param_check;
alter table personalization_rules add constraint personalization_rules_match_param_check check (match_param <> '');

-- Per-page settings for the auto-detection flow. One row per page, created
-- lazily on first use (not required up front — see doc's "no mandatory
-- setup step" decision).
create table if not exists utm_detection_settings (
  page_id               uuid primary key references pages(id) on delete cascade,
  -- Sticky default field(s) the user has chosen to key detection on for this
  -- page (e.g. ['utm_campaign']). Null until the user's first accept/confirm.
  detection_fields      text[],
  visitor_threshold     integer not null default 8 check (visitor_threshold > 0),
  scan_interval_minutes integer not null default 45 check (scan_interval_minutes > 0),
  -- The Vercel Cron entry itself runs on one fixed, frequent baseline schedule
  -- (see vercel.json) — a per-page adjustable interval can't be a distinct
  -- cron trigger per page. Instead the job runs frequently and skips a page
  -- until `scan_interval_minutes` has elapsed since last_scanned_at.
  last_scanned_at       timestamptz,
  updated_at            timestamptz not null default now()
);

-- Candidate UTM combinations seen in traffic for a page, tracked toward the
-- distinct-visitor threshold. `utm_sig` is a canonical, sorted "k=v&k=v"
-- string of the raw tracking params captured on the pageview event
-- (computed server-side in /api/event — see events.metadata.utm_sig),
-- excluding click-ID params (gclid/fbclid/etc. are unique per click and
-- would never accumulate distinct visitors).
create table if not exists utm_auto_detections (
  id                    uuid primary key default gen_random_uuid(),
  page_id               uuid not null references pages(id) on delete cascade,
  utm_sig               text not null,
  utm                   jsonb not null default '{}',
  distinct_visitor_count integer not null default 0,
  status                text not null default 'pending'
                          check (status in ('pending', 'notified', 'accepted', 'rejected')),
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  notified_at           timestamptz,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (page_id, utm_sig)
);

create index if not exists idx_utm_auto_detections_page_status
  on utm_auto_detections(page_id, status);

-- Event volume grows fast (every pageview, across every client), so the
-- detection cron job aggregates via this SQL function instead of pulling
-- raw rows and grouping in JS — a JS-side reduce over a 30-day pageview
-- window does not scale as traffic grows. Supporting indexes below make
-- both the join and the WHERE filter cheap even as `events` gets large.
create index if not exists idx_events_variant_id on events(variant_id);

create index if not exists idx_events_pageview_utm_sig
  on events(created_at)
  where type = 'pageview' and metadata->>'utm_sig' is not null;

create or replace function utm_aggregate_pageviews(since timestamptz)
returns table (
  page_id uuid,
  utm_sig text,
  utm jsonb,
  distinct_visitor_count integer
)
language sql
stable
as $$
  select
    tv.page_id,
    e.metadata->>'utm_sig' as utm_sig,
    -- Any row's raw utm object is representative of the group — they all
    -- share the same utm_sig by construction, so the params match exactly.
    (array_agg(e.metadata->'utm'))[1] as utm,
    count(distinct e.visitor_hash)::integer as distinct_visitor_count
  from events e
  join test_variants tv on tv.id = e.variant_id
  where e.type = 'pageview'
    and e.metadata->>'utm_sig' is not null
    and e.created_at >= since
  group by tv.page_id, e.metadata->>'utm_sig';
$$;

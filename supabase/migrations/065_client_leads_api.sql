-- ============================================================
-- Client Leads API v1  (GET /api/v1/clients/leads)
--
-- One aggregate query behind the whole endpoint: client → workspace → test →
-- variant, with lead/conversion/view counts at every level.
--
-- Counting deliberately happens HERE and not in JS. PostgREST caps a plain
-- select at 1,000 rows, which is exactly what silently truncated the analytics
-- numbers before 037_test_variant_stats_rpc.sql — a reporting API that
-- under-reports leads is worse than one that errors.
-- ============================================================

-- ---- Indexes -------------------------------------------------------------

-- Keyset cursor for the rows payload: filter by test_id, walk
-- (submitted_at, id) descending. The existing form_leads_submitted_at_idx is
-- not enough on its own — the query filters on test_id first, so without the
-- leading column every page degrades into a scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_form_leads_test_submitted
  ON form_leads (test_id, submitted_at DESC, id DESC);

-- Aggregation path for views/conversions per test within a date window.
CREATE INDEX IF NOT EXISTS idx_events_test_type_created
  ON events (test_id, type, created_at);

-- ---- Bot classification --------------------------------------------------

-- MIRROR OF isBotRequest() in src/lib/utils.ts. Kept as SQL because bot leads
-- have to be excluded from a COUNT(*) of millions of rows — pulling every row
-- into JS to classify it is the exact thing this migration exists to avoid.
--
-- IF YOU CHANGE THE REGEX IN utils.ts, CHANGE IT HERE TOO. The two disagreeing
-- means the API's lead count and the dashboard's lead table disagree, which
-- reads as data loss to whoever is looking at the report.
--
-- A NULL/empty user agent counts as a bot: no real browser omits it.
CREATE OR REPLACE FUNCTION sl_is_bot_ua(ua text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN ua IS NULL OR ua = '' THEN true
    -- cubot: Android handset brand whose UA contains "BOT". See utils.ts.
    WHEN ua ~* 'cubot' THEN false
    ELSE ua ~* 'bot|crawler|spider|facebookexternalhit|meta-externalagent|python-requests|python-urllib|go-http-client|okhttp|libwww-perl|scrapy|headlesschrome|phantomjs|slurp|bingpreview|ahrefsbot|semrushbot|mj12bot|petalbot|dataforseo|curl/|wget/|node-fetch|axios/|postmanruntime|whatsapp/|pinterest/|skypeuripreview|chrome-lighthouse|pingdom|statuscake|embedly|iframely|google-inspectiontool|google-read-aloud'
  END;
$$;

-- ---- Aggregate -----------------------------------------------------------

-- Returns ONE ROW PER VARIANT, fully denormalised up to the client. The route
-- nests it into the response tree. Tests with no variants and clients with no
-- tests still appear (LEFT JOINs) — a client with zero leads is a legitimate
-- row in a report, not an omission.
--
-- p_from / p_to apply to BOTH sides: form_leads.submitted_at and
-- events.created_at. If they only filtered one, a single response row would
-- carry "leads this month" next to "conversions all time" under one date
-- heading — a number mismatch nobody would be able to explain later.
CREATE OR REPLACE FUNCTION client_leads_report(
  p_client_ids uuid[],
  p_from       timestamptz,
  p_to         timestamptz,
  p_include_bots boolean DEFAULT false
)
RETURNS TABLE (
  client_id          uuid,
  client_name        text,
  client_slug        text,
  client_status      text,
  client_created_at  timestamptz,
  workspace_id       uuid,
  workspace_name     text,
  workspace_slug     text,
  test_id            uuid,
  test_name          text,
  test_url_path      text,
  test_status        text,
  test_created_at    timestamptz,
  variant_id         uuid,
  variant_name       text,
  is_control         boolean,
  traffic_weight     integer,
  views              bigint,
  unique_visitors    bigint,
  conversions        bigint,
  goal_hits          bigint,
  leads              bigint,
  bot_leads          bigint,
  last_lead_at       timestamptz,
  test_leads         bigint,
  test_bot_leads     bigint,
  test_last_lead_at  timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH
  -- Per-variant event aggregates. Mirrors test_variant_stats (037) exactly:
  -- conversions are DISTINCT visitors (one Bernoulli trial each), goal_hits is
  -- the raw count. The dashboard's CVR divides conversions by unique_visitors,
  -- so the API must produce the same two numbers or the two surfaces will
  -- quietly disagree about the same test.
  goals AS (
    SELECT cg.id, cg.test_id FROM conversion_goals cg
  ),
  ev AS (
    SELECT
      e.variant_id,
      count(*) FILTER (WHERE e.type = 'pageview')                         AS views,
      count(DISTINCT e.visitor_hash) FILTER (WHERE e.type = 'pageview')   AS unique_visitors,
      count(DISTINCT e.visitor_hash) FILTER (
        WHERE e.type = 'conversion' AND e.goal_id IS NOT NULL
          AND ( (SELECT count(*) FROM goals g WHERE g.test_id = e.test_id) = 0
                OR e.goal_id IN (SELECT g.id FROM goals g WHERE g.test_id = e.test_id) )
      ) AS conversions,
      count(*) FILTER (
        WHERE e.type = 'conversion' AND e.goal_id IS NOT NULL
          AND ( (SELECT count(*) FROM goals g WHERE g.test_id = e.test_id) = 0
                OR e.goal_id IN (SELECT g.id FROM goals g WHERE g.test_id = e.test_id) )
      ) AS goal_hits
    FROM events e
    WHERE (p_from IS NULL OR e.created_at >= p_from)
      AND (p_to   IS NULL OR e.created_at <= p_to)
    GROUP BY e.variant_id
  ),
  -- Per-variant lead aggregates. Bots are counted separately rather than
  -- dropped, so the response can report "412 leads, 17 bot rows excluded"
  -- instead of a number that silently shrank.
  fl AS (
    SELECT
      f.variant_id,
      count(*) FILTER (WHERE p_include_bots OR NOT sl_is_bot_ua(f.user_agent)) AS leads,
      count(*) FILTER (WHERE sl_is_bot_ua(f.user_agent))                       AS bot_leads,
      max(f.submitted_at) FILTER (WHERE p_include_bots OR NOT sl_is_bot_ua(f.user_agent)) AS last_lead_at
    FROM form_leads f
    WHERE (p_from IS NULL OR f.submitted_at >= p_from)
      AND (p_to   IS NULL OR f.submitted_at <= p_to)
    GROUP BY f.variant_id
  ),
  -- Test-level lead totals, keyed on test_id rather than variant_id.
  --
  -- NOT redundant with fl above: form_leads.variant_id is nullable (a deleted
  -- variant sets it NULL, and the public insert accepts leads without one), so
  -- summing the per-variant numbers would silently drop every orphaned lead
  -- from the client's total. form_leads.test_id is NOT NULL, so this is the
  -- honest total — the route rolls test → workspace → client up from HERE, and
  -- uses fl only for the per-variant breakdown. The variant numbers can
  -- therefore add up to less than the test total; that gap is real data, not a
  -- bug, and it is exactly what would have gone missing.
  fl_test AS (
    SELECT
      f.test_id,
      count(*) FILTER (WHERE p_include_bots OR NOT sl_is_bot_ua(f.user_agent)) AS leads,
      count(*) FILTER (WHERE sl_is_bot_ua(f.user_agent))                       AS bot_leads,
      max(f.submitted_at) FILTER (WHERE p_include_bots OR NOT sl_is_bot_ua(f.user_agent)) AS last_lead_at
    FROM form_leads f
    WHERE (p_from IS NULL OR f.submitted_at >= p_from)
      AND (p_to   IS NULL OR f.submitted_at <= p_to)
    GROUP BY f.test_id
  )
  SELECT
    c.id, c.name::text, c.slug::text, c.status::text, c.created_at,
    w.id, w.name::text, w.slug::text,
    t.id, t.name::text, t.url_path::text, t.status::text, t.created_at,
    v.id, v.name::text, v.is_control, v.traffic_weight,
    coalesce(ev.views, 0),
    coalesce(ev.unique_visitors, 0),
    coalesce(ev.conversions, 0),
    coalesce(ev.goal_hits, 0),
    coalesce(fl.leads, 0),
    coalesce(fl.bot_leads, 0),
    fl.last_lead_at,
    coalesce(fl_test.leads, 0),
    coalesce(fl_test.bot_leads, 0),
    fl_test.last_lead_at
  FROM clients c
  LEFT JOIN workspaces    w  ON w.client_id = c.id
  LEFT JOIN tests         t  ON t.workspace_id = w.id
  LEFT JOIN test_variants v  ON v.test_id = t.id
  LEFT JOIN ev               ON ev.variant_id = v.id
  LEFT JOIN fl               ON fl.variant_id = v.id
  LEFT JOIN fl_test          ON fl_test.test_id = t.id
  WHERE p_client_ids IS NULL OR c.id = ANY(p_client_ids)
  ORDER BY c.created_at DESC, w.created_at, t.created_at, v.is_control DESC, v.created_at;
$$;

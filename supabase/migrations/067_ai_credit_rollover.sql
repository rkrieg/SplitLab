-- ============================================================
-- AI CREDIT ROLLOVER (purchased top-ups no longer expire)
-- ============================================================
-- Before this migration, getAiUsageSummary() counted top-ups with
-- `created_at >= period_start`, so prepaid credits silently vanished at the end
-- of the calendar month they were bought in. Someone buying $500 on the 28th
-- lost it three days later. Purchased credits are now a persistent balance.
--
-- The model after this migration:
--   * plan allowance  -> resets every calendar month, use it or lose it
--   * purchased credits -> persistent balance, never expires
--   * draw order      -> plan allowance first, then purchased, then overage
--
-- The balance is held in TOKENS rather than credits on purpose. A credit is
-- 1,000 tokens, but individual model calls are not credit-aligned; storing
-- credits would force a rounding decision on every call and drift the balance
-- over thousands of small draws. Tokens divide exactly; the UI divides by
-- TOKENS_PER_CREDIT for display.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ai_topup_tokens BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN users.ai_topup_tokens IS
  'Remaining prepaid AI credits, in tokens (1 credit = 1,000 tokens). Never expires. Drawn down only after the monthly plan allowance is exhausted.';

-- Per-owner, per-month rollup of AI usage. Exists so the billing page and the
-- allowance gate are two indexed lookups instead of a scan over every ai_usage
-- row for the period, and so overage cost can be accumulated exactly at write
-- time (it depends on per-call cost, which a summed rollup alone would lose).
-- ai_usage stays the immutable per-call ledger; this table is derived from it
-- and can be rebuilt from it at any time.
CREATE TABLE IF NOT EXISTS ai_usage_monthly (
  owner_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period              DATE NOT NULL,                    -- first day of the UTC month
  tokens              BIGINT NOT NULL DEFAULT 0,        -- total tokens used in the period
  cost_micros         BIGINT NOT NULL DEFAULT 0,        -- our provider cost, micro-dollars
  overage_cost_micros BIGINT NOT NULL DEFAULT 0,        -- billable overage, at cost + markup
  topup_tokens_drawn  BIGINT NOT NULL DEFAULT 0,        -- purchased tokens consumed this period
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, period)
);

-- ── Atomic usage recording ──────────────────────────────────────────────────
-- Records one model call against the owner: rolls it into the month, draws any
-- portion past the plan allowance from the purchased balance, and accumulates
-- the cost of whatever is left over as billable overage.
--
-- Runs under a row lock on users so two concurrent AI calls cannot both see the
-- same balance and double-spend it. p_plan_tokens is passed in rather than
-- derived here so the plan -> credits mapping stays in one place (AI_CREDITS in
-- src/lib/plans.ts) instead of being duplicated in SQL that nobody remembers to
-- update.
CREATE OR REPLACE FUNCTION record_ai_usage_rollup(
  p_owner       UUID,
  p_period      DATE,
  p_tokens      BIGINT,
  p_cost_micros BIGINT,
  p_plan_tokens BIGINT,
  p_markup_num  INTEGER DEFAULT 11,   -- cost + 10% => 11/10
  p_markup_den  INTEGER DEFAULT 10
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_available      BIGINT;
  v_tokens_before  BIGINT;
  v_past_before    BIGINT;
  v_past_after     BIGINT;
  v_new_past       BIGINT;
  v_draw           BIGINT;
  v_overage_tokens BIGINT;
  v_overage_micros BIGINT;
BEGIN
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    RETURN;
  END IF;

  -- Lock the owner for the duration: balance read + decrement must be atomic.
  SELECT ai_topup_tokens INTO v_available FROM users WHERE id = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;   -- usage we cannot attribute is not billed
  END IF;

  INSERT INTO ai_usage_monthly (owner_id, period)
  VALUES (p_owner, p_period)
  ON CONFLICT (owner_id, period) DO NOTHING;

  SELECT tokens INTO v_tokens_before
  FROM ai_usage_monthly
  WHERE owner_id = p_owner AND period = p_period
  FOR UPDATE;

  -- How much of THIS call falls past the monthly plan allowance.
  v_past_before := GREATEST(0, v_tokens_before - p_plan_tokens);
  v_past_after  := GREATEST(0, v_tokens_before + p_tokens - p_plan_tokens);
  v_new_past    := v_past_after - v_past_before;

  -- Purchased credits cover that next; anything still uncovered is overage.
  v_draw           := LEAST(v_new_past, GREATEST(0, v_available));
  v_overage_tokens := v_new_past - v_draw;

  -- Charge the overage slice its proportional share of this call's real cost.
  v_overage_micros := (p_cost_micros * v_overage_tokens / p_tokens) * p_markup_num / p_markup_den;

  IF v_draw > 0 THEN
    UPDATE users SET ai_topup_tokens = ai_topup_tokens - v_draw WHERE id = p_owner;
  END IF;

  UPDATE ai_usage_monthly SET
    tokens              = tokens + p_tokens,
    cost_micros         = cost_micros + p_cost_micros,
    overage_cost_micros = overage_cost_micros + v_overage_micros,
    topup_tokens_drawn  = topup_tokens_drawn + v_draw,
    updated_at          = NOW()
  WHERE owner_id = p_owner AND period = p_period;
END;
$$;

-- ── Granting purchased credits ──────────────────────────────────────────────
-- Called by the Stripe webhook once a top-up payment succeeds. A function
-- rather than an UPDATE from the app so the increment is atomic against
-- concurrent draws by record_ai_usage_rollup().
CREATE OR REPLACE FUNCTION grant_ai_topup_tokens(
  p_owner  UUID,
  p_tokens BIGINT
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    RETURN;
  END IF;
  UPDATE users
  SET ai_topup_tokens = ai_topup_tokens + p_tokens
  WHERE id = p_owner;
END;
$$;

-- ── Backfill ────────────────────────────────────────────────────────────────

-- 1. Rebuild the rollup from the existing per-call ledger. Exact for tokens and
--    cost. overage_cost_micros is left at 0 for history and recomputed below
--    only where it still matters (see step 3).
INSERT INTO ai_usage_monthly (owner_id, period, tokens, cost_micros)
SELECT
  owner_id,
  (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date,
  SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)),
  SUM(COALESCE(cost_micros, 0))
FROM ai_usage
WHERE owner_id IS NOT NULL
GROUP BY 1, 2
ON CONFLICT (owner_id, period) DO NOTHING;

-- 2. Restore credits that expired unused under the old month-scoped rule.
--    For each month a user bought credits, the old code let them spend at most
--    what they used past the plan allowance in that same month; the rest was
--    silently dropped at month end. Give that remainder back.
--
--    The plan -> credits table is inlined here as a point-in-time snapshot of
--    AI_CREDITS (src/lib/plans.ts) as of this migration. It is deliberately not
--    kept in sync: this statement runs once, against the plans as they were.
WITH plan_tokens AS (
  SELECT
    u.id AS owner_id,
    (CASE u.plan
       WHEN 'growth' THEN 2000
       WHEN 'agency' THEN 5000
       WHEN 'scale'  THEN 15000
       ELSE 0
     END)::bigint * 1000 AS plan_tokens
  FROM users u
),
grants AS (
  SELECT
    owner_id,
    (date_trunc('month', created_at AT TIME ZONE 'UTC'))::date AS period,
    SUM(credits)::bigint * 1000 AS granted_tokens
  FROM ai_credit_topups
  WHERE status = 'completed'
  GROUP BY 1, 2
),
drawn AS (
  SELECT
    g.owner_id,
    g.granted_tokens,
    LEAST(
      g.granted_tokens,
      GREATEST(0, COALESCE(m.tokens, 0) - p.plan_tokens)
    ) AS drawn_tokens
  FROM grants g
  JOIN plan_tokens p       ON p.owner_id = g.owner_id
  LEFT JOIN ai_usage_monthly m ON m.owner_id = g.owner_id AND m.period = g.period
)
UPDATE users u
SET ai_topup_tokens = s.remaining
FROM (
  SELECT owner_id, SUM(granted_tokens - drawn_tokens) AS remaining
  FROM drawn
  GROUP BY 1
) s
WHERE u.id = s.owner_id
  AND s.remaining > 0;

-- 3. Recompute overage for the CURRENT month only. Historical months are already
--    billed and reported (users.ai_overage_reported_cents); rewriting them
--    would double-report. The current month still has unreported overage that
--    the billing job will pick up, so it must not read as $0 after this runs.
--    Proportional approximation: overage tokens' share of the month's real
--    cost, at cost + 10%. Exact when the month used one model, close otherwise.
UPDATE ai_usage_monthly m
SET overage_cost_micros = GREATEST(0,
  (m.cost_micros * GREATEST(0, m.tokens - (p.plan_tokens + m.topup_tokens_drawn)) / NULLIF(m.tokens, 0)) * 11 / 10
)
FROM (
  SELECT
    u.id AS owner_id,
    (CASE u.plan
       WHEN 'growth' THEN 2000
       WHEN 'agency' THEN 5000
       WHEN 'scale'  THEN 15000
       ELSE 0
     END)::bigint * 1000 AS plan_tokens
  FROM users u
) p
WHERE m.owner_id = p.owner_id
  AND m.period = (date_trunc('month', NOW() AT TIME ZONE 'UTC'))::date
  AND m.tokens > 0;

-- ── Ledger ──────────────────────────────────────────────────────────────────
-- Record this migration in the ledger created by 066. Nothing does this
-- automatically — these files are pasted into the Supabase SQL editor by hand —
-- so every migration from 067 on has to claim its own row, or
-- scripts/check-migrations.mjs falls back to guessing from the schema again.
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('067', 'ai_credit_rollover')
ON CONFLICT (version) DO NOTHING;

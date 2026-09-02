-- ============================================================
-- AI CREDIT ROLLOVER — corrections to 067
-- ============================================================
-- 067 is already applied to staging, so it is not edited in place: a migration
-- that has run somewhere must keep matching what ran, or the ledger stops being
-- evidence. This file corrects it instead, and is safe on both a database that
-- has run 067 (staging) and one that runs 067 and this back to back (prod).
--
-- Two problems, both found in review:
--
--  1. The top-up grant was not idempotent. 067 gave the app a bare
--     `grant_ai_topup_tokens()` that the Stripe webhook called AFTER a separate
--     insert into ai_credit_topups. Two concurrent webhook deliveries could both
--     pass the "already fulfilled?" check, both insert (one silently losing to
--     the unique index) and BOTH grant — paying $500 and receiving 20,000
--     credits. The mirror case lost credits instead: if the insert committed and
--     the grant failed, Stripe's retry saw the row, skipped the grant, and the
--     balance never moved. Fixed by doing both writes in one function, in one
--     transaction, keyed on the Stripe session id.
--
--  2. 067's backfill never populated ai_usage_monthly.topup_tokens_drawn. It
--     computed the figure (to work out what balance to restore) but only wrote
--     the balance, leaving the column at 0. 067's own overage backfill then read
--     that 0 and counted top-up-funded usage as overage — billing people, at
--     cost + 10%, for credits they had already bought.

-- ── 1. Idempotent top-up fulfilment ─────────────────────────────────────────
-- Records the purchase and credits the balance as a single unit. Returns true
-- only if THIS call was the one that fulfilled the session, so a retried webhook
-- is a no-op rather than a second grant.
--
-- The ON CONFLICT target carries the index predicate because 057's unique index
-- is partial (`WHERE stripe_session_id IS NOT NULL`); without it Postgres cannot
-- match the arbiter index.
CREATE OR REPLACE FUNCTION grant_ai_topup(
  p_owner             UUID,
  p_credits           INTEGER,
  p_amount_cents      INTEGER,
  p_session_id        TEXT,
  p_tokens_per_credit INTEGER DEFAULT 1000
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted UUID;
BEGIN
  IF p_owner IS NULL OR p_credits IS NULL OR p_credits <= 0 OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO ai_credit_topups (owner_id, credits, amount_cents, stripe_session_id, status)
  VALUES (p_owner, p_credits, p_amount_cents, p_session_id, 'completed')
  ON CONFLICT (stripe_session_id) WHERE stripe_session_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_inserted;

  -- Nothing inserted => an earlier delivery already fulfilled this session.
  IF v_inserted IS NULL THEN
    RETURN false;
  END IF;

  UPDATE users
  SET ai_topup_tokens = ai_topup_tokens + (p_credits::bigint * p_tokens_per_credit)
  WHERE id = p_owner;

  RETURN true;
END;
$$;

-- 067's grant_ai_topup_tokens() is superseded by the above and no longer called
-- by the app. Left in place rather than dropped: dropping it would break any
-- deploy still running the previous code during a rollout.

-- ── 2. Backfill the drawn column 067 left at zero ───────────────────────────
-- Same computation 067 used to decide what balance to restore: under the old
-- month-scoped rule, a top-up bought in month M could only be spent in month M,
-- and only on usage past that month's plan allowance.
--
-- Guarded to rows still sitting at 0. Since 067 ran, record_ai_usage_rollup()
-- has been recording real draws on staging; those are already correct and must
-- not be overwritten by a historical estimate.
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
)
UPDATE ai_usage_monthly m
SET topup_tokens_drawn = LEAST(
      g.granted_tokens,
      GREATEST(0, m.tokens - p.plan_tokens)
    )
FROM grants g
JOIN plan_tokens p ON p.owner_id = g.owner_id
WHERE m.owner_id = g.owner_id
  AND m.period   = g.period
  AND m.topup_tokens_drawn = 0;

-- ── 3. Recompute current-month overage with the corrected draw ──────────────
-- 067 ran this same statement against topup_tokens_drawn = 0, so any usage that
-- prepaid credits had actually covered was recorded as billable overage. Redone
-- here now the column is right. Current month only, for the reason 067 gives:
-- earlier months are already reported to Stripe and rewriting them double-bills.
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
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('069', 'ai_credit_rollover_fixes')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- AI USAGE METERING (AI Pages: build & edit with AI)
-- ============================================================
-- One row per AI model call. Monthly totals per account owner drive the
-- credit allowance (1 credit = 1,000 tokens), the soft cap when the allowance
-- is exhausted, and metered overage billing (our cost + 10%, bounded by a
-- user-set spend cap). Usage attaches to the account OWNER, not the invited
-- member who made the call — same pattern as visitor_usage / plan gating.

CREATE TABLE IF NOT EXISTS ai_usage (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id   UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  page_id        UUID,
  operation      VARCHAR(40) NOT NULL,          -- prepare | edit | build | image | route
  model          VARCHAR(80),
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  -- Actual provider cost in MICRO-dollars (1e-6 USD). Integer math, no floats:
  -- e.g. Sonnet 4.6 at $3/$15 per 1M tokens = 3 micro$/input tok + 15 micro$/output tok.
  cost_micros    BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_owner_created ON ai_usage (owner_id, created_at);

-- Overage controls on the account owner. Off by default: at the allowance the
-- account is soft-capped until the user opts in. cap_cents bounds how much
-- overage can be billed per cycle (Lovable/Replit-style hard ceiling), and
-- notify_cents is the increment at which we warn as they approach it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ai_overage_enabled     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_overage_cap_cents    INTEGER NOT NULL DEFAULT 5000,   -- $50 default ceiling
  ADD COLUMN IF NOT EXISTS ai_overage_notify_cents INTEGER NOT NULL DEFAULT 5000,   -- warn every $50
  -- Bookkeeping for Stripe metered reporting: how many overage cents we've
  -- already reported this cycle (so we report deltas, since Stripe meters sum
  -- events), and which cycle that figure belongs to (reset on rollover).
  ADD COLUMN IF NOT EXISTS ai_overage_reported_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_overage_period          DATE;

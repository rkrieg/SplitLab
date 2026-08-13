-- Prepaid AI credit top-ups. One row per successful Stripe one-time purchase.
-- These credits are added to the account owner's allowance for the current
-- billing period (calendar month), so the credits meter goes up after purchase.
-- Fulfilled by the Stripe webhook on checkout.session.completed (mode=payment).
CREATE TABLE IF NOT EXISTS ai_credit_topups (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits            INTEGER NOT NULL,            -- credits granted (1 credit = 1,000 tokens)
  amount_cents       INTEGER NOT NULL,            -- what the customer paid
  stripe_session_id  VARCHAR(255),                -- idempotency key for webhook fulfillment
  status             VARCHAR(20) NOT NULL DEFAULT 'completed',
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- One fulfillment per Stripe checkout session (webhooks can fire more than once).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_topups_session
  ON ai_credit_topups (stripe_session_id) WHERE stripe_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_topups_owner_created
  ON ai_credit_topups (owner_id, created_at);

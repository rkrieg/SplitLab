-- Add Stripe billing columns to users table.
-- These are nullable — existing users (manually created) won't have Stripe accounts.
-- subscription_status defaults to 'active' so existing paid (manually set) plans still work.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid'));

-- Index for webhook lookups (Stripe sends customer_id, we need to find the user fast)
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

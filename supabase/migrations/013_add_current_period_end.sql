-- Add subscription period-end timestamp to users table.
-- Populated by the Stripe webhook (customer.subscription.updated) and the change-plan route.
-- Used to display "Renews on [date]" in the billing UI.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;

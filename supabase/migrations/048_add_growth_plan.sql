-- Adds the 'growth' tier (between Pro and Agency) to the allowed plan values.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;

ALTER TABLE users ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro', 'growth', 'agency', 'scale'));

-- The plan column already exists from the original schema but used different values.
-- Drop the old check constraint, normalize 'starter' → 'free', then add the correct constraint.

-- 1. Add column if it somehow doesn't exist yet
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';

-- 2. Drop the old check constraint (safe if it doesn't exist)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;

-- 3. Normalize legacy value
UPDATE users SET plan = 'free' WHERE plan = 'starter';

-- 4. Add correct constraint
ALTER TABLE users ADD CONSTRAINT users_plan_check
  CHECK (plan IN ('free', 'pro', 'agency', 'scale'));

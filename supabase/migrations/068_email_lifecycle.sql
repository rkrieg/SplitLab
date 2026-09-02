-- Lifecycle email engine: send log (de-dupe + cadence), per-user preferences,
-- and a last-login stamp for re-engagement triggers.

-- Every lifecycle/activity email we send is logged here. One-time emails check
-- "has this email_key ever been sent to this user?"; recurring ones (cap warnings,
-- no-login nudges) check "how long since the last send?". Deliberately allows
-- multiple rows per (user, key).
CREATE TABLE IF NOT EXISTS email_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  email_key  text NOT NULL,       -- e.g. 'free.welcome', 'paid.clarity', 'act.significance'
  to_email   text,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_log_user_key ON email_log(user_id, email_key, sent_at DESC);

-- Per-user marketing preferences. Operational/critical alerts ignore these
-- (they always send) except unsubscribed_all, which is a hard global opt-out.
CREATE TABLE IF NOT EXISTS email_preferences (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lifecycle        boolean NOT NULL DEFAULT true,   -- Series 1 & 2 drips
  activity_wins    boolean NOT NULL DEFAULT true,   -- 🎉 wins (page live, winner, milestones)
  weekly_digest    boolean NOT NULL DEFAULT true,
  product_updates  boolean NOT NULL DEFAULT true,
  unsubscribed_all boolean NOT NULL DEFAULT false,  -- hard opt-out of everything non-critical
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_log         DISABLE ROW LEVEL SECURITY;
ALTER TABLE email_preferences DISABLE ROW LEVEL SECURITY;

-- Re-engagement triggers ("no login in 7/14 days") need a login timestamp.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- ── Ledger ──────────────────────────────────────────────────────────────────
-- Record this migration in the ledger created by 066. Nothing does this
-- automatically — these files are pasted into the Supabase SQL editor by hand —
-- so every migration has to claim its own row, or scripts/check-migrations.mjs
-- falls back to inferring from the schema.
--
-- Renumbered from 064: two files shared that number, and `version` is the
-- ledger's primary key, so only one of them could ever be recorded. This file
-- was the one with no row. Every object it creates is guarded by IF NOT EXISTS,
-- so re-running it where 064_email_lifecycle already applied is a no-op that
-- just claims the ledger row.
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('068', 'email_lifecycle')
ON CONFLICT (version) DO NOTHING;

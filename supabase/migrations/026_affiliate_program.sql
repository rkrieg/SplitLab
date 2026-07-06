-- ============================================================
-- AFFILIATE PROGRAM
-- ============================================================
-- Referral/affiliate system. Anyone can sign up as an affiliate, share a
-- referral link, and earn a recurring commission (default 20%) on every paid
-- invoice from users they refer. Free referrals earn nothing until the user
-- upgrades. Payouts are tracked in-app and settled manually (offline).

-- ── Affiliates ────────────────────────────────────────────────────────────
-- Standalone accounts (separate from `users`) with their own login. An
-- affiliate is not required to be a SplitLab customer.
CREATE TABLE IF NOT EXISTS affiliates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL UNIQUE,
  name           VARCHAR(255) NOT NULL,
  password_hash  TEXT NOT NULL,
  referral_code  VARCHAR(32) NOT NULL UNIQUE,
  -- Where/how to pay them (manual/offline payouts)
  payout_email   VARCHAR(255),
  payout_method  VARCHAR(20) NOT NULL DEFAULT 'paypal'
                   CHECK (payout_method IN ('paypal', 'wise', 'bank', 'other')),
  status         VARCHAR(20) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'suspended')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_affiliates_referral_code ON affiliates (referral_code);

-- ── Referrals ─────────────────────────────────────────────────────────────
-- A user attributed to an affiliate at signup. One referral per user (a user
-- can only ever be credited to a single affiliate — last touch at signup).
CREATE TABLE IF NOT EXISTS referrals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id   UUID NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_code  VARCHAR(32) NOT NULL,
  landing_path   TEXT,
  -- pending  = referred but still free (no commission yet)
  -- converted = has produced at least one paid invoice
  -- churned  = was paid, subscription later cancelled
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'converted', 'churned')),
  converted_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_affiliate_id ON referrals (affiliate_id);

-- ── Commissions ───────────────────────────────────────────────────────────
-- One ledger row per paid Stripe invoice from a referred user. Reversible:
-- status can move to 'reversed' on refund/chargeback. UNIQUE(invoice_id)
-- guarantees idempotency against duplicate webhook deliveries.
CREATE TABLE IF NOT EXISTS commissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id   UUID NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  referral_id    UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id     TEXT UNIQUE,
  base_cents     INTEGER NOT NULL,              -- invoice amount the commission is based on
  amount_cents   INTEGER NOT NULL,              -- commission owed (rate * base)
  rate           NUMERIC(5,4) NOT NULL DEFAULT 0.2000,
  -- pending  = accrued, not yet paid to the affiliate
  -- paid     = included in an affiliate_payouts settlement
  -- reversed = clawed back (refund/chargeback)
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'reversed')),
  payout_id      UUID,                           -- set when settled
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_commissions_affiliate_id ON commissions (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_commissions_status ON commissions (status);

-- ── Payouts ───────────────────────────────────────────────────────────────
-- A record that the agency paid an affiliate offline. Marking a payout flips
-- its covered commissions to 'paid'.
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id   UUID NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL,
  method         VARCHAR(20),
  reference      TEXT,                           -- external transaction id / note
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_affiliate_payouts_affiliate_id ON affiliate_payouts (affiliate_id);

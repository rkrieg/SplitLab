import crypto from 'crypto';
import { db } from '@/lib/supabase-server';

/** Commission rate paid to affiliates on referred paid invoices (20%). */
export const COMMISSION_RATE = 0.2;

/** Cookie that carries a referral code from landing → signup. */
export const REF_COOKIE = 'sl_ref';

/** Days a referral click stays attributable. */
export const REF_COOKIE_DAYS = 60;

/** Generate a URL-safe, human-typable referral code (no ambiguous chars). */
export function generateReferralCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

/**
 * Attribute a newly-created user to an affiliate by referral code.
 * No-ops if the code is unknown/inactive, the user is already referred, or the
 * affiliate would be referring themselves (same email). Best-effort: never
 * throws — attribution must not block signup.
 */
export async function attributeReferral(
  userId: string,
  code: string | null | undefined,
  landingPath?: string | null
): Promise<void> {
  if (!code) return;
  try {
    const { data: affiliate } = await db
      .from('affiliates')
      .select('id, email, status')
      .eq('referral_code', code.toUpperCase())
      .single();

    if (!affiliate || affiliate.status !== 'active') return;

    // Prevent self-referral (affiliate signing up with their own link)
    const { data: user } = await db
      .from('users')
      .select('email')
      .eq('id', userId)
      .single();
    if (user?.email && affiliate.email &&
        user.email.toLowerCase() === affiliate.email.toLowerCase()) {
      return;
    }

    // One referral per user — ignore if one already exists
    const { data: existing } = await db
      .from('referrals')
      .select('id')
      .eq('user_id', userId)
      .single();
    if (existing) return;

    await db.from('referrals').insert({
      affiliate_id:  affiliate.id,
      user_id:       userId,
      referral_code: code.toUpperCase(),
      landing_path:  landingPath ?? null,
      status:        'pending',
    } as never);
  } catch (err) {
    console.error('[affiliate] attributeReferral failed:', err);
  }
}

/**
 * Accrue a commission for a paid Stripe invoice. Called from the webhook on
 * every `invoice.payment_succeeded`. Idempotent via UNIQUE(invoice_id).
 * Marks the referral 'converted' on first paid invoice. Best-effort.
 */
export async function accrueCommissionForInvoice(params: {
  invoiceId: string | null;
  customerId: string | null;
  amountCents: number;
}): Promise<void> {
  const { invoiceId, customerId, amountCents } = params;
  if (!customerId || !amountCents || amountCents <= 0) return;

  try {
    // Which user does this Stripe customer belong to?
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();
    if (!user) return;

    // Was this user referred by an affiliate?
    const { data: referral } = await db
      .from('referrals')
      .select('id, affiliate_id, status')
      .eq('user_id', user.id)
      .single();
    if (!referral) return;

    const amount = Math.round(amountCents * COMMISSION_RATE);

    // Insert commission — UNIQUE(invoice_id) makes duplicate webhook
    // deliveries a no-op (the insert errors and we swallow it).
    const { error } = await db.from('commissions').insert({
      affiliate_id: referral.affiliate_id,
      referral_id:  referral.id,
      user_id:      user.id,
      invoice_id:   invoiceId,
      base_cents:   amountCents,
      amount_cents: amount,
      rate:         COMMISSION_RATE,
      status:       'pending',
    } as never);

    if (error) {
      // Likely a duplicate invoice (idempotent) — nothing to do.
      return;
    }

    // First paid invoice flips the referral to converted.
    if (referral.status !== 'converted') {
      await db.from('referrals')
        .update({ status: 'converted', converted_at: new Date().toISOString() } as never)
        .eq('id', referral.id);
    }
  } catch (err) {
    console.error('[affiliate] accrueCommissionForInvoice failed:', err);
  }
}

/** Mark a referred user's referral as churned when their subscription ends. */
export async function markReferralChurned(customerId: string | null): Promise<void> {
  if (!customerId) return;
  try {
    const { data: user } = await db
      .from('users')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .single();
    if (!user) return;

    await db.from('referrals')
      .update({ status: 'churned' } as never)
      .eq('user_id', user.id)
      .eq('status', 'converted');
  } catch (err) {
    console.error('[affiliate] markReferralChurned failed:', err);
  }
}

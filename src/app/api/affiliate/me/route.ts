import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { getAffiliateId } from '@/lib/affiliate-auth';
import { COMMISSION_RATE } from '@/lib/affiliate';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const affiliateId = getAffiliateId(request);
  if (!affiliateId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: affiliate } = await db
    .from('affiliates')
    .select('id, name, email, referral_code, payout_email, payout_method, status, created_at')
    .eq('id', affiliateId)
    .single();

  if (!affiliate) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Referrals for this affiliate
  const { data: referrals } = await db
    .from('referrals')
    .select('id, status, created_at, converted_at')
    .eq('affiliate_id', affiliateId)
    .order('created_at', { ascending: false });

  const refs = referrals ?? [];
  const referralStats = {
    total:     refs.length,
    pending:   refs.filter(r => r.status === 'pending').length,
    converted: refs.filter(r => r.status === 'converted').length,
    churned:   refs.filter(r => r.status === 'churned').length,
  };

  // Commission ledger
  const { data: commissions } = await db
    .from('commissions')
    .select('amount_cents, status, created_at')
    .eq('affiliate_id', affiliateId);

  const comms = commissions ?? [];
  const sum = (status: string) =>
    comms.filter(c => c.status === status).reduce((t, c) => t + (c.amount_cents ?? 0), 0);

  const earnings = {
    pending_cents:  sum('pending'),   // owed, not yet paid
    paid_cents:     sum('paid'),      // already settled
    reversed_cents: sum('reversed'),  // clawed back
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

  return NextResponse.json({
    affiliate: {
      id:            affiliate.id,
      name:          affiliate.name,
      email:         affiliate.email,
      referral_code: affiliate.referral_code,
      payout_email:  affiliate.payout_email,
      payout_method: affiliate.payout_method,
      status:        affiliate.status,
    },
    referral_link: `${appUrl}/?ref=${affiliate.referral_code}`,
    commission_rate: COMMISSION_RATE,
    referral_stats: referralStats,
    earnings,
  });
}

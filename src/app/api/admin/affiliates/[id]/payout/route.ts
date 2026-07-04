import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Record an offline payout to an affiliate: sum their currently-pending
 * commissions, create a payout record, and flip those commissions to 'paid'.
 * Admin only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const affiliateId = params.id;

  const { data: affiliate } = await db
    .from('affiliates')
    .select('id, payout_method')
    .eq('id', affiliateId)
    .single();
  if (!affiliate) return NextResponse.json({ error: 'Affiliate not found' }, { status: 404 });

  let reference = '';
  try {
    const body = await request.json();
    reference = typeof body?.reference === 'string' ? body.reference : '';
  } catch { /* no body is fine */ }

  // All currently-owed commissions for this affiliate
  const { data: pending } = await db
    .from('commissions')
    .select('id, amount_cents')
    .eq('affiliate_id', affiliateId)
    .eq('status', 'pending');

  const commissionIds = (pending ?? []).map(c => c.id);
  const amountCents = (pending ?? []).reduce((t, c) => t + (c.amount_cents ?? 0), 0);

  if (commissionIds.length === 0 || amountCents <= 0) {
    return NextResponse.json({ error: 'Nothing owed to this affiliate' }, { status: 400 });
  }

  // Create the payout record
  const { data: payout, error: payoutErr } = await db
    .from('affiliate_payouts')
    .insert({
      affiliate_id: affiliateId,
      amount_cents: amountCents,
      method:       affiliate.payout_method,
      reference:    reference || null,
    } as never)
    .select('id')
    .single();

  if (payoutErr || !payout) {
    return NextResponse.json({ error: payoutErr?.message || 'Failed to record payout' }, { status: 500 });
  }

  // Settle the commissions this payout covers
  const { error: updateErr } = await db
    .from('commissions')
    .update({ status: 'paid', payout_id: payout.id } as never)
    .in('id', commissionIds);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, amount_cents: amountCents, commissions_settled: commissionIds.length });
}

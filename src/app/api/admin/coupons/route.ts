import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getStripeClient } from '@/lib/stripeClient';
import { logEvent } from '@/lib/log';
import { z } from 'zod';
import type Stripe from 'stripe';

export const dynamic = 'force-dynamic';

async function requireRealAdmin() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return { error: 'Unauthorized', status: 401 as const, session: null };
  if (session.user.role !== 'admin' || session.user.impersonatorId) return { error: 'Forbidden', status: 403 as const, session: null };
  return { error: null, status: 200 as const, session };
}

// List active promotion codes (the codes customers type at checkout) with their
// coupon details.
export async function GET() {
  const gate = await requireRealAdmin();
  if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

  try {
    const stripe = getStripeClient();
    const list = await stripe.promotionCodes.list({ limit: 100, expand: ['data.promotion.coupon'] });
    const codes = list.data.map((p) => {
      const raw = p.promotion?.coupon;
      const c = raw && typeof raw === 'object' ? raw : null;
      return {
        id: p.id,
        code: p.code,
        active: p.active,
        timesRedeemed: p.times_redeemed,
        maxRedemptions: p.max_redemptions,
        created: p.created,
        discount: c?.percent_off != null ? `${c.percent_off}% off` : c?.amount_off != null ? `$${(c.amount_off / 100).toFixed(0)} off` : '—',
        duration: c ? (c.duration === 'repeating' ? `${c.duration_in_months} months` : c.duration) : '—', // once | forever | N months
      };
    });
    return NextResponse.json({ available: true, codes });
  } catch {
    return NextResponse.json({ available: false, codes: [] });
  }
}

const schema = z.object({
  kind: z.enum(['percent', 'amount', 'free_months']),
  value: z.number().positive(),                 // percent, dollars, or # months (free_months)
  durationMode: z.enum(['once', 'repeating', 'forever']).default('once'),
  durationMonths: z.number().int().positive().max(36).optional(),
  code: z.string().trim().max(40).optional(),
  maxRedemptions: z.number().int().positive().optional(),
});

export async function POST(request: NextRequest) {
  const gate = await requireRealAdmin();
  if (gate.error) return NextResponse.json({ error: gate.error }, { status: gate.status });

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid coupon settings' }, { status: 400 });
  }

  try {
    const stripe = getStripeClient();

    // Build the coupon definition.
    const couponParams: Stripe.CouponCreateParams = { duration: 'once' };
    if (data.kind === 'free_months') {
      couponParams.percent_off = 100;
      couponParams.duration = 'repeating';
      couponParams.duration_in_months = data.durationMonths ?? Math.round(data.value);
    } else {
      if (data.kind === 'percent') couponParams.percent_off = Math.min(100, data.value);
      else { couponParams.amount_off = Math.round(data.value * 100); couponParams.currency = 'usd'; }

      if (data.durationMode === 'forever') couponParams.duration = 'forever';
      else if (data.durationMode === 'repeating') { couponParams.duration = 'repeating'; couponParams.duration_in_months = data.durationMonths ?? 1; }
      else couponParams.duration = 'once';
    }

    const coupon = await stripe.coupons.create(couponParams);
    const promo = await stripe.promotionCodes.create({
      promotion: { type: 'coupon', coupon: coupon.id },
      ...(data.code ? { code: data.code.toUpperCase() } : {}),
      ...(data.maxRedemptions ? { max_redemptions: data.maxRedemptions } : {}),
    });

    void logEvent('admin_action', 'info', 'create_coupon', {
      adminId: gate.session!.user.id, code: promo.code, couponId: coupon.id, kind: data.kind, value: data.value, duration: couponParams.duration,
    });

    return NextResponse.json({ ok: true, code: promo.code });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not create coupon';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

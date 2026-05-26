import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const PLAN_PRICE_MAP: Record<string, string | undefined> = {
  pro:    process.env.STRIPE_PRICE_PRO,
  agency: process.env.STRIPE_PRICE_AGENCY,
  scale:  process.env.STRIPE_PRICE_SCALE,
};

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { plan } = await request.json();

    const priceId = PLAN_PRICE_MAP[plan];
    if (!priceId) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const { data: user } = await db
      .from('users')
      .select('stripe_subscription_id, plan')
      .eq('id', session.user.id)
      .single();

    const u = user as { stripe_subscription_id?: string | null; plan?: string } | null;

    if (!u?.stripe_subscription_id) {
      return NextResponse.json({ error: 'No active subscription found' }, { status: 400 });
    }

    if (u.plan === plan) {
      return NextResponse.json({ error: 'Already on this plan' }, { status: 400 });
    }

    const stripe = getStripeClient();

    const subscription = await stripe.subscriptions.retrieve(u.stripe_subscription_id);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) {
      return NextResponse.json({ error: 'Subscription item not found' }, { status: 400 });
    }

    const currentIdx = ['free', 'pro', 'agency', 'scale'].indexOf(u.plan ?? 'free');
    const newIdx     = ['free', 'pro', 'agency', 'scale'].indexOf(plan);
    const isUpgrade  = newIdx > currentIdx;

    const updatedSub = await stripe.subscriptions.update(u.stripe_subscription_id, {
      items: [{ id: itemId, price: priceId }],
      metadata: { plan },
      // Upgrades: charge prorated difference immediately
      // Downgrades: no charge/credit — user keeps current period, pays new price next cycle
      proration_behavior: isUpgrade ? 'create_prorations' : 'none',
    }) as unknown as { items: { data: Array<{ current_period_end: number }> } };

    // In Stripe API v2 (stripe-node v22+), current_period_end lives on the subscription item
    const periodEnd = updatedSub.items?.data?.[0]?.current_period_end;

    // Optimistic DB update — webhook will confirm it
    await db.from('users').update({
      plan,
      ...(periodEnd ? { subscription_current_period_end: new Date(periodEnd * 1000).toISOString() } : {}),
    } as never).eq('id', session.user.id);

    return NextResponse.json({ ok: true, plan });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to change plan';
    console.error('[stripe-change-plan]', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: user, error } = await db
    .from('users')
    .select('plan, stripe_customer_id, stripe_subscription_id, subscription_status')
    .eq('id', session.user.id)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const u = user as {
    plan: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string;
  };

  return NextResponse.json({
    plan:               u.plan ?? 'free',
    hasStripeCustomer:  !!u.stripe_customer_id,
    subscriptionStatus: u.subscription_status ?? 'active',
  });
}

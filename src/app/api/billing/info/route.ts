import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rawQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rows = await rawQuery<{
    plan: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string;
  }>(
    'SELECT plan, stripe_customer_id, stripe_subscription_id, subscription_status FROM users WHERE id = $1',
    [session.user.id]
  );

  const user = rows[0];
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  return NextResponse.json({
    plan: user.plan ?? 'starter',
    hasStripeCustomer: !!user.stripe_customer_id,
    subscriptionStatus: user.subscription_status ?? 'active',
  });
}

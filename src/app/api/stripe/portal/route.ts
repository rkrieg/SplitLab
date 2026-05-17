import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUncachableStripeClient } from '@/lib/stripeClient';
import { rawQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rows = await rawQuery<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [session.user.id]
    );
    const stripeCustomerId = rows[0]?.stripe_customer_id;

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: 'No billing account found. Please contact support.' },
        { status: 404 }
      );
    }

    const stripe = await getUncachableStripeClient();

    const host = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXTAUTH_URL || 'http://localhost:5000';

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${host}/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err: any) {
    console.error('[stripe-portal]', err);

    if (err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing') {
      return NextResponse.json(
        { error: 'Billing account not found. Please contact support.' },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: err.message || 'Failed to open billing portal' },
      { status: 500 }
    );
  }
}
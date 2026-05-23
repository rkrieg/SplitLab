import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: user } = await db
      .from('users')
      .select('stripe_customer_id')
      .eq('id', session.user.id)
      .single();

    const stripeCustomerId = (user as { stripe_customer_id?: string } | null)?.stripe_customer_id;

    if (!stripeCustomerId) {
      return NextResponse.json(
        { error: 'No billing account found. Please contact support.' },
        { status: 404 }
      );
    }

    const stripe  = getStripeClient();
    const appUrl  = process.env.NEXTAUTH_URL ?? `${request.nextUrl.protocol}//${request.nextUrl.host}`;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   stripeCustomerId,
      return_url: `${appUrl}/billing`,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (err: unknown) {
    console.error('[stripe-portal]', err);

    const code = (err as { code?: string; raw?: { code?: string } })?.code
      ?? (err as { raw?: { code?: string } })?.raw?.code;

    if (code === 'resource_missing') {
      return NextResponse.json(
        { error: 'Billing account not found. Please contact support.' },
        { status: 404 }
      );
    }

    const msg = err instanceof Error ? err.message : 'Failed to open billing portal';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

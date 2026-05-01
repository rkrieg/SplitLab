import { NextRequest, NextResponse } from 'next/server';
import { getUncachableStripeClient } from '@/lib/stripeClient';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('session_id');
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
    }

    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription'],
    });

    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 402 });
    }

    const customer = session.customer as any;
    const plan = (session.metadata?.plan || 'pro') as string;

    return NextResponse.json({
      email: session.customer_details?.email || customer?.email || '',
      name: session.customer_details?.name || customer?.name || '',
      plan,
      stripeCustomerId: typeof customer === 'string' ? customer : customer?.id,
    });
  } catch (err: any) {
    console.error('Stripe session error:', err);
    return NextResponse.json({ error: err.message || 'Failed to retrieve session' }, { status: 500 });
  }
}

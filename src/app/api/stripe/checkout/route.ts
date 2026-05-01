import { NextRequest, NextResponse } from 'next/server';
import { getUncachableStripeClient } from '@/lib/stripeClient';

export const dynamic = 'force-dynamic';

const PLAN_PRICE_MAP: Record<string, string> = {
  pro: 'price_1TS8ORPC9TrKO0BRRjCVw86b',
  agency: 'price_1TS8ORPC9TrKO0BRrGJPiIgK',
  scale: 'price_1TS8OSPC9TrKO0BRb3kulTzs',
};

export async function POST(request: NextRequest) {
  try {
    const { plan } = await request.json();

    const priceId = PLAN_PRICE_MAP[plan];
    if (!priceId) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const stripe = await getUncachableStripeClient();
    const host = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXTAUTH_URL || 'http://localhost:5000';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${host}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${host}/#pricing`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { plan },
      },
      metadata: { plan },
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('Stripe checkout error:', err);
    return NextResponse.json({ error: err.message || 'Checkout failed' }, { status: 500 });
  }
}

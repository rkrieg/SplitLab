import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUncachableStripeClient } from '@/lib/stripeClient';
import { rawQuery } from '@/lib/db';

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

    const session = await getServerSession(authOptions);
    const isLoggedIn = !!session?.user?.id;

    const checkoutParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { plan },
      },
      metadata: { plan, ...(isLoggedIn ? { userId: session!.user.id } : {}) },
    };

    if (isLoggedIn) {
      const rows = await rawQuery<{ stripe_customer_id: string | null; email: string; name: string }>(
        'SELECT stripe_customer_id, email, name FROM users WHERE id = $1',
        [session!.user.id]
      );
      const user = rows[0];

      checkoutParams.success_url = `${host}/billing?upgraded=1`;
      checkoutParams.cancel_url = `${host}/billing`;

      if (user?.stripe_customer_id) {
        checkoutParams.customer = user.stripe_customer_id;
      } else if (user?.email) {
        checkoutParams.customer_email = user.email;
      }

      if (checkoutParams.subscription_data) {
        checkoutParams.subscription_data.metadata = {
          ...checkoutParams.subscription_data.metadata,
          userId: session!.user.id,
        };
      }
    } else {
      checkoutParams.success_url = `${host}/welcome?session_id={CHECKOUT_SESSION_ID}`;
      checkoutParams.cancel_url = `${host}/#pricing`;
    }

    const stripeSession = await stripe.checkout.sessions.create(checkoutParams);

    return NextResponse.json({ url: stripeSession.url });
  } catch (err: any) {
    console.error('[stripe-checkout] error:', err);
    return NextResponse.json({ error: err.message || 'Checkout failed' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// Map plan ID → Stripe price ID. Must be set in environment variables.
const PLAN_PRICE_MAP: Record<string, string | undefined> = {
  pro:    process.env.STRIPE_PRICE_PRO,
  agency: process.env.STRIPE_PRICE_AGENCY,
  scale:  process.env.STRIPE_PRICE_SCALE,
};

export async function POST(request: NextRequest) {
  try {
    const { plan } = await request.json();

    const priceId = PLAN_PRICE_MAP[plan];
    if (!priceId) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const stripe = getStripeClient();
    const appUrl = process.env.NEXTAUTH_URL ?? `${request.nextUrl.protocol}//${request.nextUrl.host}`;

    // Carry any affiliate referral code through checkout so complete-signup can
    // attribute the new paid user even after the Stripe redirect round-trip.
    const ref = request.cookies.get('sl_ref')?.value ?? '';

    // Is the user already logged in? (upgrading an existing account)
    const session = await getServerSession(authOptions);
    const isLoggedIn = !!session?.user?.id;

    const checkoutParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      // plan is stored on the subscription itself so webhooks can read it
      subscription_data: {
        metadata: { plan, ...(ref ? { ref } : {}) },
      },
      // also on the checkout session for complete-signup to read
      metadata: { plan, ...(ref ? { ref } : {}) },
    };

    if (isLoggedIn) {
      // Existing user upgrading — return them to billing page
      checkoutParams.success_url = `${appUrl}/billing?upgraded=1`;
      checkoutParams.cancel_url  = `${appUrl}/billing`;

      // Attach to existing Stripe customer if they have one
      const { data: user } = await db
        .from('users')
        .select('stripe_customer_id, email, name')
        .eq('id', session!.user.id)
        .single();

      if (user?.stripe_customer_id) {
        checkoutParams.customer = user.stripe_customer_id;
      } else if (user?.email) {
        checkoutParams.customer_email = user.email;
      }

      // Include userId so the webhook can find the user even without a customer record yet
      checkoutParams.subscription_data!.metadata = {
        ...checkoutParams.subscription_data!.metadata,
        userId: session!.user.id,
      };
      checkoutParams.metadata = {
        ...checkoutParams.metadata,
        userId: session!.user.id,
      };
    } else {
      // New user — they'll complete signup on the welcome page after payment
      checkoutParams.success_url = `${appUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`;
      checkoutParams.cancel_url  = `${appUrl}/#pricing`;
    }

    const stripeSession = await stripe.checkout.sessions.create(checkoutParams);
    return NextResponse.json({ url: stripeSession.url });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Checkout failed';
    console.error('[stripe-checkout]', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

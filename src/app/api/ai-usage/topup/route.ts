import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';
import { TOPUP_AMOUNTS_CENTS, creditsForCents } from '@/lib/ai-usage';

export const dynamic = 'force-dynamic';

// Create a Stripe one-time Checkout session to buy prepaid AI credits. The
// webhook (checkout.session.completed, mode=payment) grants the credits once
// payment succeeds; nothing is granted here.
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { amountCents, returnUrl } = await request.json();
    if (!TOPUP_AMOUNTS_CENTS.includes(amountCents)) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    const credits = creditsForCents(amountCents);

    const stripe = getStripeClient();
    const origin = request.nextUrl.origin;

    // Only allow returning to a same-origin URL; otherwise fall back to billing.
    let base = `${origin}/billing`;
    if (typeof returnUrl === 'string' && returnUrl.startsWith(origin)) base = returnUrl.split('#')[0];
    const sep = base.includes('?') ? '&' : '?';

    const { data: user } = await db
      .from('users')
      .select('stripe_customer_id, email')
      .eq('id', session.user.id)
      .single();

    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: { name: `${credits.toLocaleString()} AI credits` },
        },
      }],
      // Read back by the webhook to grant credits to the right account.
      metadata: { kind: 'ai_topup', userId: session.user.id, credits: String(credits), amountCents: String(amountCents) },
      payment_intent_data: {
        metadata: { kind: 'ai_topup', userId: session.user.id, credits: String(credits) },
      },
      success_url: `${base}${sep}topup=success`,
      cancel_url: `${base}${sep}topup=cancel`,
      ...(user?.stripe_customer_id ? { customer: user.stripe_customer_id } : (user?.email ? { customer_email: user.email } : {})),
    });

    return NextResponse.json({ url: checkout.url });
  } catch (err) {
    console.error('[ai-topup] checkout error', err);
    return NextResponse.json({ error: 'Could not start checkout' }, { status: 500 });
  }
}

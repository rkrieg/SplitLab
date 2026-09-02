import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';
import { TOPUP_AMOUNTS_CENTS, creditsForCents } from '@/lib/ai-usage';
import { resolveAiBillingAccount } from '@/lib/workspace-auth';

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

    const { amountCents, returnUrl, workspaceId } = await request.json();
    if (!TOPUP_AMOUNTS_CENTS.includes(amountCents)) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    const credits = creditsForCents(amountCents);

    // Credits have to land on the account the gate actually checks. AI usage is
    // billed to the client owner, so an invited team member buying from inside
    // the editor was topping up their own personal balance while the owner's
    // stayed empty — they paid and stayed blocked. Resolve the owner, and let
    // only the owner (or platform staff) put a charge on that account.
    let ownerId = session.user.id;
    if (typeof workspaceId === 'string' && workspaceId) {
      const acct = await resolveAiBillingAccount(workspaceId, session.user.id, session.user.role);
      if (!acct) {
        return NextResponse.json({ error: 'No access to this workspace' }, { status: 403 });
      }
      if (!acct.canManage) {
        return NextResponse.json(
          {
            error: acct.ownerName
              ? `Only ${acct.ownerName} can buy credits for this account.`
              : 'Only the account owner can buy credits for this account.',
          },
          { status: 403 },
        );
      }
      ownerId = acct.ownerId;
    }

    const stripe = getStripeClient();
    const origin = request.nextUrl.origin;

    // Only allow returning to a same-origin URL; otherwise fall back to billing.
    let base = `${origin}/billing`;
    if (typeof returnUrl === 'string' && returnUrl.startsWith(origin)) base = returnUrl.split('#')[0];
    const sep = base.includes('?') ? '&' : '?';

    // Bill the same account the credits land on, so the charge and the balance
    // never end up on two different customers.
    const { data: user } = await db
      .from('users')
      .select('stripe_customer_id, email')
      .eq('id', ownerId)
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
      metadata: { kind: 'ai_topup', userId: ownerId, credits: String(credits), amountCents: String(amountCents) },
      payment_intent_data: {
        metadata: { kind: 'ai_topup', userId: ownerId, credits: String(credits) },
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

import { NextRequest, NextResponse } from 'next/server';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const schema = z.object({
  sessionId: z.string().min(1),
  name:      z.string().min(1),
  password:  z.string().min(8),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, name, password } = schema.parse(body);

    // Verify payment with Stripe
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'subscription'],
    });

    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 402 });
    }

    // Extract data from the Stripe session
    const customer          = session.customer as { id?: string; email?: string } | string | null;
    const stripeCustomerId  = typeof customer === 'string' ? customer : customer?.id ?? null;
    const email             = (
      session.customer_details?.email ??
      (typeof customer === 'object' && customer !== null ? customer.email : null) ??
      ''
    ).toLowerCase();

    // plan comes from checkout session metadata (always set by our checkout route)
    const plan = (session.metadata?.plan ?? 'pro') as string;

    const sub             = session.subscription as { id?: string } | string | null;
    const stripeSubId     = typeof sub === 'string' ? sub : sub?.id ?? null;

    if (!email) {
      return NextResponse.json({ error: 'No email found in Stripe session' }, { status: 400 });
    }

    // If the user already exists (e.g. they paid then came back), just attach the Stripe data
    const { data: existing } = await db
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      await db.from('users').update({
        stripe_customer_id:     stripeCustomerId,
        stripe_subscription_id: stripeSubId,
        subscription_status:    'active',
        plan,
      } as never).eq('id', existing.id);

      return NextResponse.json({ email, existed: true });
    }

    // New user — create account
    const passwordHash = await bcrypt.hash(password, 12);

    const { error } = await db.from('users').insert({
      name,
      email,
      password_hash:          passwordHash,
      role:                   'manager',   // self-signup = manager (not admin)
      status:                 'active',
      plan,
      stripe_customer_id:     stripeCustomerId,
      stripe_subscription_id: stripeSubId,
      subscription_status:    'active',
    } as never);

    if (error) {
      console.error('[complete-signup] insert error:', error);
      return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
    }

    return NextResponse.json({ email, existed: false });
  } catch (err: unknown) {
    console.error('[complete-signup] error:', err);

    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }
    // Stripe 404 (bad session ID)
    const stripeStatus = (err as { raw?: { statusCode?: number } })?.raw?.statusCode;
    if (stripeStatus === 404) {
      return NextResponse.json({ error: 'Checkout session not found' }, { status: 404 });
    }

    const msg = err instanceof Error ? err.message : 'Failed to complete signup';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

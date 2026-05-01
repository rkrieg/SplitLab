import { NextRequest, NextResponse } from 'next/server';
import { getUncachableStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const schema = z.object({
  sessionId: z.string(),
  name: z.string().min(1),
  password: z.string().min(8),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId, name, password } = schema.parse(body);

    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer'],
    });

    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 402 });
    }

    const customer = session.customer as any;
    const email = (session.customer_details?.email || customer?.email || '').toLowerCase();
    const plan = (session.metadata?.plan || 'pro') as string;
    const stripeCustomerId = typeof customer === 'string' ? customer : customer?.id;

    if (!email) {
      return NextResponse.json({ error: 'No email found in Stripe session' }, { status: 400 });
    }

    const { data: existing } = await db
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      await db
        .from('users')
        .update({ stripe_customer_id: stripeCustomerId, plan } as any)
        .eq('id', existing.id);

      return NextResponse.json({ email, existed: true });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { error } = await db.from('users').insert({
      name,
      email,
      password_hash: passwordHash,
      role: 'admin',
      status: 'active',
      stripe_customer_id: stripeCustomerId,
      plan,
    } as any);

    if (error) {
      console.error('User insert error:', error);
      return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
    }

    return NextResponse.json({ email, existed: false });
  } catch (err: any) {
    console.error('Complete signup error:', err);
    if (err?.name === 'ZodError') {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }
    return NextResponse.json({ error: err.message || 'Failed to complete signup' }, { status: 500 });
  }
}

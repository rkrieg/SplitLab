import { NextRequest, NextResponse } from 'next/server';
import { getStripeClient } from '@/lib/stripeClient';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stripe/session?session_id=cs_xxx
 *
 * Used by the /welcome page after a successful checkout.
 * Returns the email, name, and plan so the page can pre-fill the signup form.
 */
export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('session_id');
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session_id' }, { status: 400 });
    }

    const stripe  = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer'],
    });

    if (session.payment_status !== 'paid') {
      return NextResponse.json({ error: 'Payment not completed' }, { status: 402 });
    }

    const customer  = session.customer as { email?: string; name?: string } | string | null;
    const plan      = (session.metadata?.plan ?? 'pro') as string;

    return NextResponse.json({
      email: session.customer_details?.email
        ?? (typeof customer === 'object' && customer !== null ? customer.email : null)
        ?? '',
      name:  session.customer_details?.name
        ?? (typeof customer === 'object' && customer !== null ? customer.name : null)
        ?? '',
      plan,
      stripeCustomerId: typeof customer === 'string' ? customer : (customer as { id?: string })?.id ?? '',
    });
  } catch (err: unknown) {
    console.error('[stripe-session]', err);
    const status = (err as { raw?: { statusCode?: number } })?.raw?.statusCode === 404 ? 404 : 500;
    const msg    = err instanceof Error ? err.message : 'Failed to retrieve session';
    return NextResponse.json({ error: msg }, { status });
  }
}

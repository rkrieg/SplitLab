import { NextRequest, NextResponse } from 'next/server';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// Reverse map: Stripe price ID → plan ID.
// metadata.plan is always the primary source — this is just a fallback.
const PRICE_TO_PLAN: Record<string, string> = {
  ...(process.env.STRIPE_PRICE_PRO    ? { [process.env.STRIPE_PRICE_PRO]:    'pro'    } : {}),
  ...(process.env.STRIPE_PRICE_AGENCY ? { [process.env.STRIPE_PRICE_AGENCY]: 'agency' } : {}),
  ...(process.env.STRIPE_PRICE_SCALE  ? { [process.env.STRIPE_PRICE_SCALE]:  'scale'  } : {}),
};

/** Normalize Stripe subscription status to our DB enum. */
function mapStatus(s: string): string {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due')                   return 'past_due';
  if (s === 'unpaid')                     return 'unpaid';
  if (s === 'canceled')                   return 'canceled';
  return 'active'; // unknown statuses treated as active
}

/** Extract string ID from a Stripe expandable field (string | object | null). */
function extractId(val: unknown): string | null {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && 'id' in val) return (val as { id: string }).id;
  return null;
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: ReturnType<ReturnType<typeof getStripeClient>['webhooks']['constructEvent']>;
  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[stripe-webhook] signature verification failed:', msg);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    switch (event.type) {

      // ── Payment completed ────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object as {
          mode: string;
          customer: unknown;
          subscription: unknown;
          metadata: Record<string, string>;
        };
        if (session.mode !== 'subscription') break;

        const custId = extractId(session.customer);
        const subId  = extractId(session.subscription);
        const plan   = session.metadata?.plan ?? null;
        const userId = session.metadata?.userId ?? null;

        if (!custId) break;

        // If we have a userId in metadata (logged-in upgrade), use it directly
        if (userId) {
          await db.from('users').update({
            stripe_customer_id:     custId,
            stripe_subscription_id: subId,
            subscription_status:    'active',
            ...(plan ? { plan } : {}),
          } as never).eq('id', userId);
        } else {
          // New user via welcome page — complete-signup will create the account,
          // but we still update stripe_subscription_id if the user already exists
          await db.from('users').update({
            stripe_subscription_id: subId,
            subscription_status:    'active',
            ...(plan ? { plan } : {}),
          } as never).eq('stripe_customer_id', custId);
        }
        break;
      }

      // ── Subscription changed (upgrade, downgrade, renewal) ───────────────
      case 'customer.subscription.updated': {
        const sub = event.data.object as {
          id: string;
          customer: unknown;
          status: string;
          metadata: Record<string, string>;
          items: { data: Array<{ price: { id: string } }> };
        };

        const custId = extractId(sub.customer);
        if (!custId) break;

        // Resolve plan: metadata first (always set by our checkout), price ID fallback
        let plan: string | null = sub.metadata?.plan ?? null;
        if (!plan) {
          const priceId = sub.items?.data?.[0]?.price?.id;
          plan = PRICE_TO_PLAN[priceId] ?? null;
        }

        const status = mapStatus(sub.status);

        const updates: Record<string, unknown> = {
          subscription_status:    status,
          stripe_subscription_id: sub.id,
        };
        if (plan) updates.plan = plan;

        await db.from('users').update(updates as never).eq('stripe_customer_id', custId);
        break;
      }

      // ── Subscription cancelled ───────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object as { customer: unknown };
        const custId = extractId(sub.customer);
        if (!custId) break;

        // ⚠ Use 'free', NOT 'starter' — DB constraint is CHECK (plan IN ('free','pro','agency','scale'))
        await db.from('users').update({
          plan:                   'free',
          subscription_status:    'canceled',
          stripe_subscription_id: null,
        } as never).eq('stripe_customer_id', custId);
        break;
      }

      // ── Payment failed ───────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object as { customer: unknown };
        const custId = extractId(invoice.customer);
        if (!custId) break;
        await db.from('users').update({ subscription_status: 'past_due' } as never)
          .eq('stripe_customer_id', custId);
        break;
      }

      // ── Payment recovered ────────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as { customer: unknown; billing_reason: string };
        // subscription_create is handled by checkout.session.completed
        if (invoice.billing_reason === 'subscription_create') break;
        const custId = extractId(invoice.customer);
        if (!custId) break;
        await db.from('users').update({ subscription_status: 'active' } as never)
          .eq('stripe_customer_id', custId);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('[stripe-webhook] processing error for', event.type, err);
    // Return 200 anyway so Stripe doesn't retry — we log and fix bugs separately
  }

  return NextResponse.json({ received: true });
}

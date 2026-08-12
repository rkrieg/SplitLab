import { NextRequest, NextResponse } from 'next/server';
import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';
import { accrueCommissionForInvoice, markReferralChurned } from '@/lib/affiliate';
import { logEvent } from '@/lib/log';

export const dynamic = 'force-dynamic';

// Reverse map: Stripe price ID → plan ID.
// metadata.plan is always the primary source — this is just a fallback.
const PRICE_TO_PLAN: Record<string, string> = {
  ...(process.env.STRIPE_PRICE_PRO    ? { [process.env.STRIPE_PRICE_PRO]:    'pro'    } : {}),
  ...(process.env.STRIPE_PRICE_GROWTH ? { [process.env.STRIPE_PRICE_GROWTH]: 'growth' } : {}),
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
    await logEvent('stripe_webhook', 'warn', 'signature verification failed', { errorMessage: msg });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    switch (event.type) {

      // ── Payment completed ────────────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object as {
          id: string;
          mode: string;
          customer: unknown;
          subscription: unknown;
          metadata: Record<string, string>;
        };

        // ── Prepaid AI credit top-up (one-time payment) ──────────────────────
        // Grant credits once payment succeeds, idempotently (webhooks retry).
        if (session.mode === 'payment' && session.metadata?.kind === 'ai_topup') {
          const topupUserId = session.metadata?.userId ?? null;
          const credits     = parseInt(session.metadata?.credits ?? '0', 10);
          const amountCents  = parseInt(session.metadata?.amountCents ?? '0', 10);
          if (topupUserId && credits > 0) {
            const { data: existing } = await db
              .from('ai_credit_topups')
              .select('id')
              .eq('stripe_session_id', session.id)
              .maybeSingle();
            if (!existing) {
              await db.from('ai_credit_topups').insert({
                owner_id:          topupUserId,
                credits,
                amount_cents:      amountCents,
                stripe_session_id: session.id,
                status:            'completed',
              } as never);
            }
          }
          break;
        }

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
        const sub = event.data.object as unknown as {
          id: string;
          customer: unknown;
          status: string;
          metadata: Record<string, string>;
          items: { data: Array<{ price: { id: string }; current_period_end: number }> };
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
        const periodEnd = sub.items?.data?.[0]?.current_period_end;

        const updates: Record<string, unknown> = {
          subscription_status:    status,
          stripe_subscription_id: sub.id,
          ...(periodEnd ? { subscription_current_period_end: new Date(periodEnd * 1000).toISOString() } : {}),
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

        // ⚠ Use 'free', NOT 'starter' — DB constraint is CHECK (plan IN ('free','pro','growth','agency','scale'))
        await db.from('users').update({
          plan:                   'free',
          subscription_status:    'canceled',
          stripe_subscription_id: null,
        } as never).eq('stripe_customer_id', custId);

        // Affiliate: stop future commission accrual (lifetime = while they pay)
        await markReferralChurned(custId);
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

      // ── Payment recovered / recurring charge ─────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as {
          id: string;
          customer: unknown;
          billing_reason: string;
          amount_paid: number;
        };
        const custId = extractId(invoice.customer);
        if (!custId) break;

        // Affiliate commission accrues on EVERY paid invoice — including the
        // first (subscription_create) and each recurring renewal. Idempotent
        // per invoice id, so duplicate deliveries are safe.
        await accrueCommissionForInvoice({
          invoiceId:   invoice.id,
          customerId:  custId,
          amountCents: invoice.amount_paid,
        });

        // subscription_create status is handled by checkout.session.completed
        if (invoice.billing_reason === 'subscription_create') break;
        await db.from('users').update({ subscription_status: 'active' } as never)
          .eq('stripe_customer_id', custId);
        break;
      }

      default:
        break;
    }
    await logEvent('stripe_webhook', 'info', 'processed', { eventType: event.type, eventId: event.id });
  } catch (err) {
    console.error('[stripe-webhook] processing error for', event.type, err);
    // Return 200 anyway so Stripe doesn't retry — we log and fix bugs separately
    await logEvent('stripe_webhook', 'error', 'processing error', {
      eventType: event.type, eventId: event.id,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({ received: true });
}

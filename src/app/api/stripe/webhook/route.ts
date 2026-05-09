import { NextRequest, NextResponse } from 'next/server';
import { getUncachableStripeClient } from '@/lib/stripeClient';
import { rawQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

const PRICE_TO_PLAN: Record<string, string> = {
  'price_1TS8ORPC9TrKO0BRRjCVw86b': 'pro',
  'price_1TS8ORPC9TrKO0BRrGJPiIgK': 'agency',
  'price_1TS8OSPC9TrKO0BRb3kulTzs': 'scale',
};

function mapStatus(stripeStatus: string): string {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'past_due') return 'past_due';
  if (stripeStatus === 'canceled' || stripeStatus === 'unpaid') return 'canceled';
  return stripeStatus;
}

function customerId(val: any): string | null {
  if (typeof val === 'string') return val;
  return val?.id ?? null;
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  const rawBody = await request.text();

  let event: any;
  try {
    const stripe = await getUncachableStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const subId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id ?? null;
        const custId = customerId(session.customer);
        if (subId && custId) {
          await rawQuery(
            `UPDATE users
             SET stripe_subscription_id = $1, subscription_status = 'active'
             WHERE stripe_customer_id = $2`,
            [subId, custId]
          );
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const custId = customerId(sub.customer);
        if (!custId) break;

        let plan: string | null = sub.metadata?.plan ?? null;
        if (!plan) {
          const priceId = sub.items?.data?.[0]?.price?.id;
          plan = PRICE_TO_PLAN[priceId] ?? null;
        }

        const status = mapStatus(sub.status);

        if (plan) {
          await rawQuery(
            `UPDATE users
             SET plan = $1, subscription_status = $2, stripe_subscription_id = $3
             WHERE stripe_customer_id = $4`,
            [plan, status, sub.id, custId]
          );
        } else {
          await rawQuery(
            `UPDATE users
             SET subscription_status = $1, stripe_subscription_id = $2
             WHERE stripe_customer_id = $3`,
            [status, sub.id, custId]
          );
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const custId = customerId(sub.customer);
        if (!custId) break;
        await rawQuery(
          `UPDATE users
           SET plan = 'starter', subscription_status = 'canceled', stripe_subscription_id = NULL
           WHERE stripe_customer_id = $1`,
          [custId]
        );
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const custId = customerId(invoice.customer);
        if (!custId) break;
        await rawQuery(
          `UPDATE users SET subscription_status = 'past_due' WHERE stripe_customer_id = $1`,
          [custId]
        );
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason === 'subscription_create') break;
        const custId = customerId(invoice.customer);
        if (!custId) break;
        await rawQuery(
          `UPDATE users SET subscription_status = 'active' WHERE stripe_customer_id = $1`,
          [custId]
        );
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('[stripe-webhook] processing error for', event.type, err);
  }

  return NextResponse.json({ received: true });
}

import { getStripeClient } from '@/lib/stripeClient';
import { db } from '@/lib/supabase-server';
import { getAiUsageSummary } from '@/lib/ai-usage';

// ── AI overage → Stripe metered billing ─────────────────────────────────────
//
// The in-app soft cap (checkAiAllowance) is what actually protects the user
// from surprise bills — it pauses AI once overage cost reaches their spend cap.
// This module reports the *accrued* overage to Stripe so it lands on the next
// invoice at our cost + 10% (the markup is already baked into
// summary.overageCostCents).
//
// SETUP REQUIRED before this does anything (until then it's a safe no-op):
//   1. In Stripe, create a **Billing Meter** (e.g. event name "ai_overage_cents",
//      default aggregation = sum). Attach a metered price to it where
//      1 unit = 1 cent (unit_amount = 1, currency usd).
//   2. Put the meter's event name in env as STRIPE_AI_OVERAGE_METER_EVENT, and
//      subscribe paid customers to that metered price.
//
// Stripe meters SUM the events they receive, so we report the *delta* since our
// last report this cycle (tracked in users.ai_overage_reported_cents) rather
// than the cumulative — and reset that counter when the billing cycle rolls
// over (users.ai_overage_period).

/**
 * Report an owner's newly-accrued AI overage to Stripe as a meter event. No-op
 * unless overage is enabled, the meter is configured, and the owner has a
 * Stripe customer. Best-effort — never throws (billing must not break an AI request).
 */
export async function reportAiOverageUsage(ownerId: string | null): Promise<void> {
  const eventName = process.env.STRIPE_AI_OVERAGE_METER_EVENT;
  if (!ownerId || !eventName) return;

  try {
    const { data: user } = await db
      .from('users')
      .select('plan, stripe_customer_id, ai_overage_enabled, ai_overage_cap_cents, ai_overage_reported_cents, ai_overage_period')
      .eq('id', ownerId)
      .single();

    if (!user?.ai_overage_enabled || !user.stripe_customer_id) return;

    const summary = await getAiUsageSummary(ownerId, user.plan ?? 'free');
    const periodDate = summary.periodStart.slice(0, 10); // YYYY-MM-DD (1st of month)

    // Reset the reported counter when the cycle rolls over.
    const alreadyReported = user.ai_overage_period === periodDate
      ? (user.ai_overage_reported_cents ?? 0)
      : 0;

    // Cap total billable at the user's spend ceiling, then report only the delta.
    const billableCents = Math.min(summary.overageCostCents, user.ai_overage_cap_cents ?? 5000);
    const deltaCents = billableCents - alreadyReported;
    if (deltaCents <= 0) {
      // Still record a period reset if we rolled over with nothing to bill.
      if (user.ai_overage_period !== periodDate) {
        await db.from('users').update({ ai_overage_reported_cents: 0, ai_overage_period: periodDate } as never).eq('id', ownerId);
      }
      return;
    }

    const stripe = getStripeClient();
    await stripe.billing.meterEvents.create({
      event_name: eventName,
      payload: {
        stripe_customer_id: user.stripe_customer_id,
        value: String(deltaCents),
      },
    });

    await db
      .from('users')
      .update({ ai_overage_reported_cents: billableCents, ai_overage_period: periodDate } as never)
      .eq('id', ownerId);
  } catch (err) {
    console.error('[ai-overage] failed to report usage to Stripe', err);
  }
}

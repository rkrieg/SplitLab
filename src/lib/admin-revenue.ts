import { getStripeClient } from '@/lib/stripeClient';

/**
 * Actual money billed (from Stripe), not the DB `plan`/`subscription_status`
 * fields — those can be comps, test data, or manual overrides. Revenue = net of
 * succeeded charges (amount minus refunds), which covers both subscription and
 * one-time payments.
 *
 * Degrades gracefully: if STRIPE_SECRET_KEY isn't set (e.g. local dev), returns
 * `available: false` instead of throwing.
 */
export interface RevenueSummary {
  byCustomer: Map<string, number>; // stripe customer id -> net cents billed
  totalCents: number;
  payingCustomers: number;
  available: boolean;
}

export async function getRevenueByCustomer(maxPages = 25): Promise<RevenueSummary> {
  const byCustomer = new Map<string, number>();
  let totalCents = 0;
  try {
    const stripe = getStripeClient();
    let startingAfter: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await stripe.charges.list({ limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const c of page.data) {
        if (c.status !== 'succeeded' || !c.paid) continue;
        const net = (c.amount ?? 0) - (c.amount_refunded ?? 0);
        if (net <= 0) continue;
        totalCents += net;
        const cust = typeof c.customer === 'string' ? c.customer : c.customer?.id;
        if (cust) byCustomer.set(cust, (byCustomer.get(cust) ?? 0) + net);
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
    return { byCustomer, totalCents, payingCustomers: byCustomer.size, available: true };
  } catch {
    return { byCustomer, totalCents: 0, payingCustomers: 0, available: false };
  }
}

/** Lifetime net revenue for a single customer, in cents. -1 = Stripe unavailable. */
export async function getCustomerRevenue(customerId: string): Promise<number> {
  try {
    const stripe = getStripeClient();
    let total = 0;
    let startingAfter: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await stripe.charges.list({ customer: customerId, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const c of page.data) {
        if (c.status === 'succeeded' && c.paid) total += (c.amount ?? 0) - (c.amount_refunded ?? 0);
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
    return total;
  } catch {
    return -1;
  }
}

/** cents → "$1,234.56" */
export function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface RevenuePoint {
  label: string;         // "Feb 2026"
  collectedCents: number; // actual cash collected that month (net charges)
  mrrCents: number;       // recurring revenue active that month (approx)
}

export interface RevenueOverview {
  available: boolean;
  currentMrrCents: number;
  series: RevenuePoint[];
}

/** Normalize a subscription's recurring amount to cents-per-month. */
function subMonthlyCents(sub: {
  items: { data: Array<{ quantity?: number | null; price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number | null } | null } | null }> };
}): number {
  let m = 0;
  for (const item of sub.items?.data ?? []) {
    const price = item.price;
    if (!price || price.unit_amount == null) continue;
    const amt = price.unit_amount * (item.quantity ?? 1);
    const count = price.recurring?.interval_count ?? 1;
    switch (price.recurring?.interval) {
      case 'year': m += amt / (12 * count); break;
      case 'week': m += (amt * (52 / 12)) / count; break;
      case 'day':  m += (amt * (365 / 12)) / count; break;
      default:     m += amt / count; // month (or one-off with no interval → treated as monthly)
    }
  }
  return Math.round(m);
}

/**
 * Monthly collected revenue + recurring revenue (MRR) over the last `months`.
 * MRR per month is approximated using each subscription's CURRENT amount and its
 * active window (created → ended/canceled), so historical plan changes aren't
 * reflected — good enough for a growth view. Current MRR is exact (active subs now).
 */
export async function getRevenueOverview(months = 12): Promise<RevenueOverview> {
  try {
    const stripe = getStripeClient();
    const now = new Date();

    // Month buckets (UTC), oldest → newest.
    const buckets: { start: number; end: number; label: string; collectedCents: number; mrrCents: number }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      buckets.push({
        start: Math.floor(d.getTime() / 1000),
        end: Math.floor(end.getTime() / 1000),
        label: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
        collectedCents: 0,
        mrrCents: 0,
      });
    }
    const windowStart = buckets[0].start;

    // Collected: succeeded charges in the window, bucketed by month.
    let startingAfter: string | undefined;
    for (let i = 0; i < 25; i++) {
      const page = await stripe.charges.list({ limit: 100, created: { gte: windowStart }, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const c of page.data) {
        if (c.status !== 'succeeded' || !c.paid) continue;
        const net = (c.amount ?? 0) - (c.amount_refunded ?? 0);
        if (net <= 0) continue;
        const b = buckets.find((x) => c.created >= x.start && c.created < x.end);
        if (b) b.collectedCents += net;
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    // MRR: walk all subscriptions; add each one's monthly amount to every bucket
    // it was active during. Current MRR = active/trialing subs today.
    let currentMrrCents = 0;
    startingAfter = undefined;
    for (let i = 0; i < 25; i++) {
      const page = await stripe.subscriptions.list({ status: 'all', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      for (const sub of page.data) {
        const monthly = subMonthlyCents(sub as never);
        if (monthly <= 0) continue;
        const created = sub.created;
        const ended = (sub.ended_at ?? sub.canceled_at ?? null) as number | null;
        for (const b of buckets) {
          const activeThisMonth = created < b.end && (ended == null || ended >= b.start);
          if (activeThisMonth) b.mrrCents += monthly;
        }
        if (sub.status === 'active' || sub.status === 'trialing') currentMrrCents += monthly;
      }
      if (!page.has_more || page.data.length === 0) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    return {
      available: true,
      currentMrrCents,
      series: buckets.map((b) => ({ label: b.label, collectedCents: b.collectedCents, mrrCents: b.mrrCents })),
    };
  } catch {
    return { available: false, currentMrrCents: 0, series: [] };
  }
}

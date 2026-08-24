import { requireAdmin } from '@/lib/admin-auth';
import { getStripeClient } from '@/lib/stripeClient';
import CouponForm from './CouponForm';

export const dynamic = 'force-dynamic';

async function listCodes() {
  try {
    const stripe = getStripeClient();
    const list = await stripe.promotionCodes.list({ limit: 100, expand: ['data.promotion.coupon'] });
    return {
      available: true,
      codes: list.data.map((p) => {
        const raw = p.promotion?.coupon;
        const c = raw && typeof raw === 'object' ? raw : null;
        return {
          id: p.id,
          code: p.code,
          active: p.active,
          timesRedeemed: p.times_redeemed,
          maxRedemptions: p.max_redemptions,
          created: p.created,
          discount: c?.percent_off != null ? `${c.percent_off}% off` : c?.amount_off != null ? `$${(c.amount_off / 100).toFixed(0)} off` : '—',
          duration: c ? (c.duration === 'repeating' ? `${c.duration_in_months} mo` : c.duration) : '—',
        };
      }),
    };
  } catch {
    return { available: false, codes: [] as never[] };
  }
}

export default async function AdminCoupons() {
  await requireAdmin();
  const { available, codes } = await listCodes();

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold">Coupons</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Create discount codes customers enter at checkout. Codes work automatically on the checkout page.
        </p>
      </div>

      {!available && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          Stripe isn&apos;t configured in this environment, so coupons can&apos;t be created or listed here. Use this on production, where the live Stripe key is set — codes created there are the ones real customers can redeem.
        </div>
      )}

      <CouponForm />

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800">
          <h2 className="text-sm font-semibold">Existing codes ({codes.length})</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
              <th className="px-5 py-2.5 font-medium">Code</th>
              <th className="px-5 py-2.5 font-medium">Discount</th>
              <th className="px-5 py-2.5 font-medium">Duration</th>
              <th className="px-5 py-2.5 font-medium text-right">Redeemed</th>
              <th className="px-5 py-2.5 font-medium">Status</th>
              <th className="px-5 py-2.5 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => (
              <tr key={c.id} className="border-b border-slate-50 dark:border-slate-800/50">
                <td className="px-5 py-2.5"><code className="font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800">{c.code}</code></td>
                <td className="px-5 py-2.5">{c.discount}</td>
                <td className="px-5 py-2.5 capitalize text-slate-500 dark:text-slate-400">{c.duration}</td>
                <td className="px-5 py-2.5 text-right tabular-nums">{c.timesRedeemed}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}</td>
                <td className="px-5 py-2.5">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${c.active ? 'bg-green-500/15 text-green-700 dark:text-green-400' : 'bg-slate-400/15 text-slate-500'}`}>
                    {c.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-5 py-2.5 text-slate-500 dark:text-slate-400">{new Date(c.created * 1000).toLocaleDateString()}</td>
              </tr>
            ))}
            {codes.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-8 text-center text-slate-400">No coupon codes yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

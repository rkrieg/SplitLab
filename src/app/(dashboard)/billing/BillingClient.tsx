'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import {
  CreditCard, CheckCircle, AlertTriangle, ExternalLink,
  Loader2, FlaskConical, Building2, ArrowRight, Zap,
} from 'lucide-react';
import {
  PLAN_DETAILS, getPlanDetails, formatLimit,
  type PlanId,
} from '@/lib/plans';
import toast from 'react-hot-toast';

interface UsageStat { used: number; limit: number | null; pct: number; limitLabel: string; }
interface UsageData  { plan: string; planName: string; tests: UsageStat; clients: UsageStat; }

/** Horizontal progress bar — colour shifts red as it fills up. */
function MeterBar({ pct, limit }: { pct: number; limit: number | null }) {
  const isUnlimited = limit === null;
  const color = isUnlimited
    ? 'bg-green-500'
    : pct >= 100 ? 'bg-red-500'
    : pct >= 90  ? 'bg-red-400'
    : pct >= 70  ? 'bg-amber-400'
    : 'bg-green-500';

  return (
    <div className="flex-1 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all duration-500`}
        style={{ width: `${isUnlimited ? 8 : Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

const PAID_PLANS: PlanId[] = ['pro', 'agency', 'scale'];

export default function BillingClient({
  initialPlan,
  initialStatus,
  hasStripeCustomer,
}: {
  initialPlan:      string;
  initialStatus:    string;
  hasStripeCustomer: boolean;
}) {
  const { update } = useSession();
  const searchParams = useSearchParams();
  const [usage,           setUsage]           = useState<UsageData | null>(null);
  const [portalLoading,   setPortalLoading]   = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  const plan        = initialPlan as PlanId;
  const planDetails = getPlanDetails(plan);
  const isFree      = plan === 'free';
  const isPastDue   = initialStatus === 'past_due';
  const isCanceled  = initialStatus === 'canceled';

  // After Stripe redirect, refresh JWT so sidebar plan badge updates without re-login
  useEffect(() => {
    if (searchParams.get('upgraded') === '1') {
      update();
    }
  }, [searchParams, update]);

  useEffect(() => {
    fetch('/api/usage')
      .then(r => r.json())
      .then(setUsage)
      .catch(() => {/* non-critical — hide silently */});
  }, []);

  async function handleManageBilling() {
    setPortalLoading(true);
    try {
      const res  = await fetch('/api/stripe/portal', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Could not open billing portal'); return; }
      window.location.href = data.url;
    } catch { toast.error('An unexpected error occurred'); }
    finally { setPortalLoading(false); }
  }

  async function handleUpgrade(planId: string) {
    setCheckoutLoading(planId);
    try {
      const res  = await fetch('/api/stripe/checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ plan: planId }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Checkout failed'); return; }
      window.location.href = data.url;
    } catch { toast.error('An unexpected error occurred'); }
    finally { setCheckoutLoading(null); }
  }

  return (
    <div className="space-y-6 max-w-3xl">

      {/* ── Past-due / canceled banner ── */}
      {(isPastDue || isCanceled) && (
        <div className={`rounded-xl border p-4 flex items-start gap-3 ${
          isPastDue
            ? 'bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/30'
            : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30'
        }`}>
          <AlertTriangle size={16} className={`mt-0.5 flex-shrink-0 ${isPastDue ? 'text-orange-500' : 'text-red-500'}`} />
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {isPastDue ? 'Payment past due — please update your payment method' : 'Subscription canceled'}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {isPastDue
                ? 'Your tests may be paused until payment is resolved. Click "Manage Billing" to update your card.'
                : 'Your plan has been downgraded to Free. Re-subscribe below to restore access.'}
            </p>
          </div>
          {hasStripeCustomer && (
            <button
              onClick={handleManageBilling}
              disabled={portalLoading}
              className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-60"
            >
              {portalLoading && <Loader2 size={12} className="animate-spin" />}
              Manage Billing
            </button>
          )}
        </div>
      )}

      {/* ── Current plan card ── */}
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/15 flex items-center justify-center">
              <CreditCard size={20} className="text-indigo-500" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {planDetails.name} Plan
                </h2>
                {!isPastDue && !isCanceled && (
                  <span className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400">
                    <CheckCircle size={10} /> Active
                  </span>
                )}
                {isPastDue && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400">
                    Past Due
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {isFree
                  ? 'Free forever'
                  : `$${planDetails.monthlyPrice} / month · billed monthly`}
              </p>
            </div>
          </div>

          {!isFree && hasStripeCustomer && (
            <button
              onClick={handleManageBilling}
              disabled={portalLoading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-60"
            >
              {portalLoading ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              {portalLoading ? 'Opening…' : 'Manage Billing'}
            </button>
          )}
        </div>

        {/* Plan features list */}
        <div className="mt-5 grid grid-cols-2 gap-2">
          {planDetails.features.map(feat => (
            <div key={feat} className="flex items-center gap-2">
              <CheckCircle size={13} className="text-green-500 flex-shrink-0" />
              <span className="text-sm text-slate-600 dark:text-slate-400">{feat}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Usage meters ── */}
      {usage && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">
            Current Usage
          </h3>
          <div className="space-y-4">
            {([
              { icon: FlaskConical, label: 'Active Tests', stat: usage.tests },
              { icon: Building2,    label: 'Clients',      stat: usage.clients },
            ] as const).map(({ icon: Icon, label, stat }) => {
              const isUnlimited = stat.limit === null;
              return (
                <div key={label} className="flex items-center gap-3">
                  <Icon size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="text-sm text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">{label}</span>
                  <MeterBar pct={stat.pct} limit={stat.limit} />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300 w-24 text-right tabular-nums whitespace-nowrap">
                    {isUnlimited
                      ? `${stat.used.toLocaleString()} / ∞`
                      : `${stat.used.toLocaleString()} / ${stat.limitLabel}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Add billing method prompt (free + no customer) ── */}
      {isFree && !hasStripeCustomer && (
        <div className="rounded-xl border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/10 p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Ready to unlock more?</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Upgrade to run more tests, manage more clients, and use custom domains.
            </p>
          </div>
          <button
            onClick={() => handleUpgrade('pro')}
            disabled={!!checkoutLoading}
            className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors disabled:opacity-60"
          >
            {checkoutLoading === 'pro' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            Upgrade Now
          </button>
        </div>
      )}

      {/* ── Upgrade plan grid (shown when user is on free tier) ── */}
      {isFree && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2">
            <Zap size={14} className="text-indigo-500" />
            Choose a plan
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {PAID_PLANS.map(planId => {
              const p         = PLAN_DETAILS[planId];
              const isLoading = checkoutLoading === planId;
              const featured  = planId === 'agency';

              return (
                <div
                  key={planId}
                  className={`card p-5 flex flex-col gap-4 ${featured ? 'ring-2 ring-indigo-500' : ''}`}
                >
                  {featured && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-500 self-start uppercase tracking-wide">
                      Most Popular
                    </span>
                  )}

                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{p.name}</p>
                    <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                      ${p.monthlyPrice}
                      <span className="text-sm font-normal text-slate-500">/mo</span>
                    </p>
                  </div>

                  <ul className="space-y-1.5 flex-1">
                    {p.features.map(f => (
                      <li key={f} className="flex items-center gap-2">
                        <CheckCircle size={12} className="text-green-500 flex-shrink-0" />
                        <span className="text-xs text-slate-600 dark:text-slate-400">{f}</span>
                      </li>
                    ))}
                  </ul>

                  <button
                    onClick={() => handleUpgrade(planId)}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold transition-colors"
                  >
                    {isLoading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                    {isLoading ? 'Redirecting…' : 'Get started'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!isFree && hasStripeCustomer && (
        <p className="text-xs text-slate-500 dark:text-slate-500">
          To upgrade, downgrade, or cancel your subscription, click{' '}
          <strong>Manage Billing</strong> above — it opens the Stripe customer portal.
        </p>
      )}

      {/* ── Domain limit note ── */}
      {!isFree && (
        <p className="text-xs text-slate-500 dark:text-slate-500">
          Custom domains included: <strong>{formatLimit(getPlanDetails(plan).maxDomains)}</strong>
          {' '}(1 per client workspace).
        </p>
      )}
    </div>
  );
}

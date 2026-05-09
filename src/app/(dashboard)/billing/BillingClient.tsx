'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreditCard, CheckCircle, AlertTriangle, ExternalLink,
  Loader2, TrendingUp, FlaskConical, Building2, Users, ArrowRight,
  Zap,
} from 'lucide-react';
import { PLANS, getPlan, formatLimit, type PlanId } from '@/lib/plans';
import toast from 'react-hot-toast';

interface BillingInfo {
  plan: string;
  hasStripeCustomer: boolean;
  subscriptionStatus: string;
}

interface UsageStat { used: number; limit: number | null; pct: number; limitLabel: string; }
interface UsageData {
  plan: string;
  planName: string;
  visitors: UsageStat;
  tests: UsageStat;
  clients: UsageStat;
  seats: UsageStat;
}

const PLAN_PRICES: Record<string, { price: string; label: string }> = {
  pro: { price: '$49', label: 'per month' },
  agency: { price: '$149', label: 'per month' },
  scale: { price: '$349', label: 'per month' },
  starter: { price: 'Free', label: 'forever' },
};

const PLAN_FEATURES: Record<string, string[]> = {
  starter: ['1 active test', '1 client', '1,000 visitors/mo', '1 team seat'],
  pro: ['10 active tests', '1 client', '25,000 visitors/mo', '3 team seats', 'AI page builder'],
  agency: ['50 active tests', '10 clients', '100,000 visitors/mo', '10 team seats', 'AI page builder'],
  scale: ['Unlimited tests', 'Unlimited clients', 'Unlimited visitors', 'Unlimited seats', 'AI page builder', 'Priority support'],
};

function MeterBar({ pct, limit }: { pct: number; limit: number | null }) {
  const isUnlimited = limit === null || limit === Infinity || limit > 999_999_999;
  if (isUnlimited) return (
    <div className="flex-1 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
      <div className="h-full bg-green-500 rounded-full" style={{ width: '8%' }} />
    </div>
  );
  const color = pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-red-400' : pct >= 70 ? 'bg-amber-400' : 'bg-green-500';
  return (
    <div className="flex-1 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

const UPGRADE_PLANS: PlanId[] = ['pro', 'agency', 'scale'];

export default function BillingClient({ initialPlan, initialStatus, hasStripeCustomer }: {
  initialPlan: string;
  initialStatus: string;
  hasStripeCustomer: boolean;
}) {
  const router = useRouter();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  const plan = initialPlan as PlanId;
  const planDetails = getPlan(plan);
  const isFree = plan === 'starter';
  const isPastDue = initialStatus === 'past_due';
  const isCanceled = initialStatus === 'canceled';

  useEffect(() => {
    fetch('/api/usage').then(r => r.json()).then(setUsage).catch(() => {});
  }, []);

  async function handleManageBilling() {
    setPortalLoading(true);
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Could not open billing portal');
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setPortalLoading(false);
    }
  }

  async function handleUpgrade(planId: string) {
    setCheckoutLoading(planId);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Checkout failed');
        return;
      }
      window.location.href = data.url;
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setCheckoutLoading(null);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Past due / canceled warning */}
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
                : 'Your plan has been downgraded to Free. Resubscribe below to restore access.'}
            </p>
          </div>
          {hasStripeCustomer && (
            <button
              onClick={handleManageBilling}
              disabled={portalLoading}
              className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-60"
            >
              {portalLoading ? <Loader2 size={12} className="animate-spin" /> : null}
              Manage Billing
            </button>
          )}
        </div>
      )}

      {/* Current Plan Card */}
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
                    <CheckCircle size={10} />
                    Active
                  </span>
                )}
                {isPastDue && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400">
                    Past Due
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {isFree ? 'Free forever' : `${PLAN_PRICES[plan]?.price ?? ''} / month · billed monthly`}
              </p>
            </div>
          </div>

          {!isFree && hasStripeCustomer && (
            <button
              onClick={handleManageBilling}
              disabled={portalLoading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-60"
            >
              {portalLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ExternalLink size={14} />
              )}
              {portalLoading ? 'Opening…' : 'Manage Billing'}
            </button>
          )}
        </div>

        {/* Plan features */}
        <div className="mt-5 grid grid-cols-2 gap-2">
          {(PLAN_FEATURES[plan] ?? PLAN_FEATURES.starter).map(feat => (
            <div key={feat} className="flex items-center gap-2">
              <CheckCircle size={13} className="text-green-500 flex-shrink-0" />
              <span className="text-sm text-slate-600 dark:text-slate-400">{feat}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Usage */}
      {usage && (
        <div className="card p-6">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">This Month's Usage</h3>
          <div className="space-y-4">
            {([
              { icon: TrendingUp, label: 'Visitors / mo', stat: usage.visitors },
              { icon: FlaskConical, label: 'Active Tests', stat: usage.tests },
              { icon: Building2, label: 'Clients', stat: usage.clients },
              { icon: Users, label: 'Team Seats', stat: usage.seats },
            ] as const).map(({ icon: Icon, label, stat }) => {
              const isUnlimited = stat.limit === null || stat.limit > 999_999_999;
              return (
                <div key={label} className="flex items-center gap-3">
                  <Icon size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="text-sm text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">{label}</span>
                  <MeterBar pct={stat.pct} limit={stat.limit} />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300 w-24 text-right tabular-nums whitespace-nowrap">
                    {isUnlimited ? `${stat.used.toLocaleString()} / ∞` : `${stat.used.toLocaleString()} / ${stat.limitLabel}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Upgrade Plans (shown for free plan users) */}
      {isFree && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3 flex items-center gap-2">
            <Zap size={14} className="text-indigo-500" />
            Upgrade your plan
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {UPGRADE_PLANS.map(planId => {
              const p = PLANS[planId];
              const isLoading = checkoutLoading === planId;
              return (
                <div
                  key={planId}
                  className={`card p-5 flex flex-col gap-4 ${planId === 'agency' ? 'ring-2 ring-indigo-500' : ''}`}
                >
                  {planId === 'agency' && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-500 self-start uppercase tracking-wide">Most Popular</span>
                  )}
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{p.name}</p>
                    <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
                      ${p.monthlyPrice}<span className="text-sm font-normal text-slate-500">/mo</span>
                    </p>
                  </div>
                  <ul className="space-y-1.5 flex-1">
                    {(PLAN_FEATURES[planId] ?? []).map(f => (
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

      {/* Paid users: show upgrade note */}
      {!isFree && hasStripeCustomer && (
        <p className="text-xs text-slate-500 dark:text-slate-500">
          To upgrade, downgrade, or cancel, click <strong>Manage Billing</strong> above to open the Stripe customer portal.
        </p>
      )}
    </div>
  );
}

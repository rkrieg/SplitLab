'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { PLANS, type PlanId } from '@/lib/plans';
import { cn } from '@/lib/utils';
import Spinner from '@/components/ui/Spinner';

interface ClaimAccountModalProps {
  open: boolean;
  onClose: () => void;
  onClaimed: (client: { id: string; name: string; slug: string; owner_id: string | null }) => void;
}

export default function ClaimAccountModal({ open, onClose, onClaimed }: ClaimAccountModalProps) {
  const { update } = useSession();
  const router = useRouter();
  const [selectedPlan, setSelectedPlan] = useState<PlanId>('free');
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  async function handleContinue() {
    setLoading(true);
    try {
      const res = await fetch('/api/account/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: selectedPlan }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Could not set up your account');
        return;
      }

      await update();

      if (data.client) {
        onClaimed({
          id: data.client.id,
          name: data.client.name,
          slug: data.client.slug,
          owner_id: data.client.owner_id ?? null,
        });
      }

      if (data.needsCheckout && data.checkoutPlan) {
        const checkoutRes = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: data.checkoutPlan }),
        });
        const checkoutData = await checkoutRes.json();
        if (!checkoutRes.ok || !checkoutData.url) {
          toast.error(checkoutData.error || 'Account created — open Billing to finish upgrading');
          onClose();
          if (data.client?.id) router.push(`/clients/${data.client.id}/pages`);
          return;
        }
        window.location.href = checkoutData.url;
        return;
      }

      toast.success('Your workspace is ready');
      onClose();
      if (data.client?.id) router.push(`/clients/${data.client.id}/pages`);
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !loading && onClose()}>
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Need your own workspace? Set up your account
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 mb-5">
          Keep access to invited clients, and get your own workspace to run tests and choose a plan.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          {PLANS.map((plan) => (
            <button
              key={plan.id}
              type="button"
              onClick={() => setSelectedPlan(plan.id)}
              className={cn(
                'text-left rounded-xl border p-4 transition-colors',
                selectedPlan === plan.id
                  ? 'border-indigo-500 bg-indigo-500/10 ring-1 ring-indigo-500/40'
                  : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{plan.label}</p>
                  <p className="text-lg font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                    {plan.price}
                    {plan.id !== 'free' && <span className="text-xs font-normal text-slate-500">/mo</span>}
                  </p>
                </div>
                {selectedPlan === plan.id && (
                  <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0">
                    <Check size={12} className="text-white" />
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">{plan.sub}</p>
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={loading} className="btn-secondary text-sm">
            Cancel
          </button>
          <button type="button" onClick={handleContinue} disabled={loading} className="btn-primary text-sm">
            {loading ? (
              <><Spinner />Setting up…</>
            ) : selectedPlan === 'free' ? (
              'Continue on Free'
            ) : (
              `Continue with ${PLANS.find((p) => p.id === selectedPlan)?.label}`
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

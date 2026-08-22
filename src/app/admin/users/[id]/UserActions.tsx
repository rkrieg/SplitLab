'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { LogIn, Loader2 } from 'lucide-react';

const PLANS = ['free', 'pro', 'growth', 'agency', 'scale'];

export default function UserActions({
  userId, userEmail, currentPlan,
}: { userId: string; userEmail: string; currentPlan: string }) {
  const { update } = useSession();
  const router = useRouter();
  const [plan, setPlan] = useState(currentPlan);
  const [savingPlan, setSavingPlan] = useState(false);
  const [impersonating, setImpersonating] = useState(false);

  async function impersonate() {
    setImpersonating(true);
    try {
      await update({ impersonateUserId: userId });
      toast.success(`Now viewing as ${userEmail}`);
      router.push('/dashboard');
    } catch {
      toast.error('Could not start impersonation.');
      setImpersonating(false);
    }
  }

  async function savePlan() {
    setSavingPlan(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) throw new Error();
      toast.success(`Plan set to ${plan}`);
      router.refresh();
    } catch {
      toast.error('Could not change plan.');
    } finally {
      setSavingPlan(false);
    }
  }

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      <div className="flex items-center gap-1.5">
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 capitalize focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          onClick={savePlan}
          disabled={savingPlan || plan === currentPlan}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {savingPlan && <Loader2 size={13} className="animate-spin" />}
          Change plan
        </button>
      </div>
      <button
        onClick={impersonate}
        disabled={impersonating}
        className="flex items-center justify-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {impersonating ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
        Log in as user
      </button>
    </div>
  );
}

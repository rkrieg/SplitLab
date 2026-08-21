'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Loader2, Ticket } from 'lucide-react';

type Kind = 'percent' | 'amount' | 'free_months';
type Duration = 'once' | 'repeating' | 'forever';

export default function CouponForm() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('percent');
  const [value, setValue] = useState('20');
  const [durationMode, setDurationMode] = useState<Duration>('once');
  const [durationMonths, setDurationMonths] = useState('3');
  const [code, setCode] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setCreated(null);
    try {
      const body: Record<string, unknown> = { kind, value: Number(value) };
      if (kind === 'free_months') body.durationMonths = Number(value);
      else {
        body.durationMode = durationMode;
        if (durationMode === 'repeating') body.durationMonths = Number(durationMonths);
      }
      if (code.trim()) body.code = code.trim();
      if (maxRedemptions.trim()) body.maxRedemptions = Number(maxRedemptions);

      const res = await fetch('/api/admin/coupons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Failed');
      setCreated(d.code);
      toast.success(`Coupon ${d.code} created`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create coupon');
    } finally {
      setSaving(false);
    }
  }

  const valueLabel = kind === 'percent' ? '% off' : kind === 'amount' ? '$ off' : 'months free';

  return (
    <form onSubmit={submit} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
      <h2 className="text-sm font-semibold flex items-center gap-2"><Ticket size={15} /> Create a coupon code</h2>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Discount type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2">
            <option value="percent">Percent off</option>
            <option value="amount">Amount off ($)</option>
            <option value="free_months">Free months (100% off)</option>
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{valueLabel}</span>
          <input type="number" min="1" value={value} onChange={(e) => setValue(e.target.value)} required
            className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2" />
        </label>
      </div>

      {kind !== 'free_months' && (
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Applies for</span>
            <select value={durationMode} onChange={(e) => setDurationMode(e.target.value as Duration)} className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2">
              <option value="once">One invoice (once)</option>
              <option value="repeating">A number of months</option>
              <option value="forever">Forever</option>
            </select>
          </label>
          {durationMode === 'repeating' && (
            <label className="block">
              <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Number of months</span>
              <input type="number" min="1" max="36" value={durationMonths} onChange={(e) => setDurationMonths(e.target.value)}
                className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2" />
            </label>
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Custom code <span className="text-slate-400">(optional)</span></span>
          <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. LAUNCH20"
            className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2 uppercase" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Max redemptions <span className="text-slate-400">(optional)</span></span>
          <input type="number" min="1" value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} placeholder="unlimited"
            className="w-full text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-2" />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving}
          className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm px-4 py-2 rounded-lg font-medium transition-colors">
          {saving && <Loader2 size={14} className="animate-spin" />} Create coupon
        </button>
        {created && (
          <span className="text-sm text-green-700 dark:text-green-400">
            Created <code className="font-semibold px-1.5 py-0.5 rounded bg-green-500/15">{created}</code> — customers enter it at checkout.
          </span>
        )}
      </div>
    </form>
  );
}

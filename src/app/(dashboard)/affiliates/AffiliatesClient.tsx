'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet, Users, DollarSign, X } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import toast from 'react-hot-toast';
import type { AdminAffiliate } from './page';

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AffiliatesClient({ affiliates }: { affiliates: AdminAffiliate[] }) {
  const router = useRouter();
  const [payoutFor, setPayoutFor] = useState<AdminAffiliate | null>(null);

  const totalOwed = affiliates.reduce((t, a) => t + a.owed_cents, 0);
  const totalPaid = affiliates.reduce((t, a) => t + a.paid_cents, 0);
  const totalPaying = affiliates.reduce((t, a) => t + a.referrals_paying, 0);

  if (affiliates.length === 0) {
    return (
      <div className="text-center py-20 border border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
        <Users size={32} className="mx-auto text-slate-400 mb-3" />
        <p className="text-slate-600 dark:text-slate-300 font-medium">No affiliates yet</p>
        <p className="text-sm text-slate-400 mt-1">
          Affiliates who join via the footer link on your site will appear here.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Summary icon={<Wallet size={18} />} label="Total owed (unpaid)" value={money(totalOwed)} accent />
        <Summary icon={<DollarSign size={18} />} label="Total paid out" value={money(totalPaid)} />
        <Summary icon={<Users size={18} />} label="Active paying referrals" value={String(totalPaying)} />
      </div>

      {/* Table */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="text-left font-medium px-4 py-3">Affiliate</th>
                <th className="text-left font-medium px-4 py-3">Code</th>
                <th className="text-right font-medium px-4 py-3">Referrals</th>
                <th className="text-right font-medium px-4 py-3">Paying</th>
                <th className="text-right font-medium px-4 py-3">Owed</th>
                <th className="text-right font-medium px-4 py-3">Paid</th>
                <th className="text-right font-medium px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {affiliates.map(a => (
                <tr key={a.id} className="text-slate-700 dark:text-slate-200">
                  <td className="px-4 py-3">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-slate-400">{a.payout_email || a.email}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{a.referral_code}</td>
                  <td className="px-4 py-3 text-right">{a.referrals_total}</td>
                  <td className="px-4 py-3 text-right">{a.referrals_paying}</td>
                  <td className="px-4 py-3 text-right font-semibold text-indigo-500">{money(a.owed_cents)}</td>
                  <td className="px-4 py-3 text-right text-slate-400">{money(a.paid_cents)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setPayoutFor(a)}
                      disabled={a.owed_cents <= 0}
                      className="text-xs font-medium px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
                    >
                      Record payout
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {payoutFor && (
        <PayoutModal
          affiliate={payoutFor}
          onClose={() => setPayoutFor(null)}
          onDone={() => { setPayoutFor(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

function Summary({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl p-4 border ${accent
      ? 'bg-indigo-500/10 border-indigo-500/30'
      : 'bg-white dark:bg-slate-800/50 border-slate-200 dark:border-slate-800'}`}>
      <div className={`flex items-center gap-1.5 text-xs mb-2 ${accent ? 'text-indigo-500 dark:text-indigo-300' : 'text-slate-500 dark:text-slate-400'}`}>
        {icon} {label}
      </div>
      <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  );
}

function PayoutModal({ affiliate, onClose, onDone }: {
  affiliate: AdminAffiliate;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/affiliates/${affiliate.id}/payout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Failed to record payout'); return; }
      toast.success(`Recorded ${money(data.amount_cents)} payout to ${affiliate.name}`);
      onDone();
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Record payout</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><X size={18} /></button>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Mark <span className="font-medium text-slate-700 dark:text-slate-200">{money(affiliate.owed_cents)}</span> as
          paid to <span className="font-medium text-slate-700 dark:text-slate-200">{affiliate.name}</span>
          {affiliate.payout_email && <> ({affiliate.payout_email})</>}. This settles all currently-owed commissions.
        </p>
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Reference / note <span className="text-slate-400 font-normal">(optional)</span></label>
        <input
          value={reference}
          onChange={e => setReference(e.target.value)}
          className="input-base mb-5"
          placeholder="PayPal txn ID, date, etc."
          autoFocus
        />
        <div className="flex justify-end gap-3">
          <button onClick={onClose} disabled={saving} className="btn-secondary text-sm">Cancel</button>
          <button onClick={submit} disabled={saving} className="btn-primary text-sm">
            {saving ? <><Spinner />Saving…</> : `Mark ${money(affiliate.owed_cents)} paid`}
          </button>
        </div>
      </div>
    </div>
  );
}

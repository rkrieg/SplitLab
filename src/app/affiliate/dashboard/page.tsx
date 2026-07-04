'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Copy, Check, LogOut, Users, TrendingUp, Wallet, Clock } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import toast from 'react-hot-toast';

interface MeResponse {
  affiliate: { name: string; email: string; referral_code: string; payout_email: string | null };
  referral_link: string;
  commission_rate: number;
  referral_stats: { total: number; pending: number; converted: number; churned: number };
  earnings: { pending_cents: number; paid_cents: number; reversed_cents: number };
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AffiliateDashboard() {
  const router = useRouter();
  const [data, setData] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch('/api/affiliate/me')
      .then(res => {
        if (res.status === 401) { router.replace('/affiliate'); return null; }
        return res.json();
      })
      .then(d => { if (d) setData(d); })
      .catch(() => router.replace('/affiliate'))
      .finally(() => setLoading(false));
  }, [router]);

  async function copyLink() {
    if (!data) return;
    await navigator.clipboard.writeText(data.referral_link);
    setCopied(true);
    toast.success('Referral link copied');
    setTimeout(() => setCopied(false), 2000);
  }

  async function logout() {
    await fetch('/api/affiliate/logout', { method: 'POST' });
    router.push('/affiliate');
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Spinner className="text-indigo-400" />
      </div>
    );
  }
  if (!data) return null;

  const { affiliate, referral_stats: rs, earnings, commission_rate } = data;
  const owed = earnings.pending_cents;
  const lifetime = earnings.pending_cents + earnings.paid_cents;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/"><img src="/splitlab-logo-dark.png" alt="SplitLab" style={{ height: '44px', width: 'auto' }} /></Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400 hidden sm:inline">{affiliate.email}</span>
            <button onClick={logout} className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors">
              <LogOut size={14} /> Log out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold mb-1">Welcome back, {affiliate.name.split(' ')[0]}</h1>
        <p className="text-slate-400 mb-8">You earn {Math.round(commission_rate * 100)}% recurring on every paid referral.</p>

        {/* Referral link */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-8">
          <label className="block text-sm font-medium text-slate-300 mb-2">Your referral link</label>
          <div className="flex gap-2">
            <input readOnly value={data.referral_link}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 text-sm text-slate-300 font-mono truncate" />
            <button onClick={copyLink}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors flex-shrink-0">
              {copied ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy</>}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            Code: <span className="font-mono text-slate-400">{affiliate.referral_code}</span> · Attribution lasts 60 days from click.
          </p>
        </div>

        {/* Earnings */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard icon={<Wallet size={18} />} label="Owed to you" value={money(owed)} accent />
          <StatCard icon={<TrendingUp size={18} />} label="Lifetime earned" value={money(lifetime)} />
          <StatCard icon={<Check size={18} />} label="Already paid out" value={money(earnings.paid_cents)} />
          <StatCard icon={<Users size={18} />} label="Total referrals" value={String(rs.total)} />
        </div>

        {/* Referral breakdown */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Referral breakdown</h2>
          <div className="grid grid-cols-3 gap-4">
            <Breakdown icon={<Check size={16} className="text-green-400" />} label="Paying" value={rs.converted}
              hint="Currently on a paid plan — earning you commission." />
            <Breakdown icon={<Clock size={16} className="text-amber-400" />} label="Free (pending)" value={rs.pending}
              hint="Signed up free. You earn when they upgrade." />
            <Breakdown icon={<Users size={16} className="text-slate-400" />} label="Churned" value={rs.churned}
              hint="Cancelled their paid plan. No further commission." />
          </div>
        </div>

        <p className="text-xs text-slate-500 mt-6">
          Payouts are issued manually to {affiliate.payout_email
            ? <span className="text-slate-400">{affiliate.payout_email}</span>
            : 'your payout email'} once your owed balance reaches the minimum threshold.
          {!affiliate.payout_email && ' Add a payout email so we can pay you.'}
        </p>
      </main>
    </div>
  );
}

function StatCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl p-4 border ${accent ? 'bg-indigo-600/10 border-indigo-600/30' : 'bg-slate-900 border-slate-800'}`}>
      <div className={`flex items-center gap-1.5 text-xs mb-2 ${accent ? 'text-indigo-300' : 'text-slate-400'}`}>
        {icon} {label}
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function Breakdown({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: number; hint: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm text-slate-300 mb-1">{icon} {label}</div>
      <div className="text-2xl font-bold mb-1">{value}</div>
      <p className="text-xs text-slate-500 leading-snug">{hint}</p>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff, ArrowRight, DollarSign, Users, Repeat } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import toast from 'react-hot-toast';

export default function AffiliatePage() {
  const router = useRouter();
  const [mode, setMode] = useState<'join' | 'login'>('join');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [payoutEmail, setPayoutEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const endpoint = mode === 'join' ? '/api/affiliate/signup' : '/api/affiliate/login';
      const body = mode === 'join'
        ? { name, email, password, payout_email: payoutEmail }
        : { email, password };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Something went wrong');
        return;
      }
      router.push('/affiliate/dashboard');
      router.refresh();
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Header */}
      <header className="px-6 py-5 flex items-center justify-between max-w-6xl mx-auto w-full">
        <Link href="/">
          <img src="/splitlab-logo-dark.png" alt="SplitLab" style={{ height: '48px', width: 'auto' }} />
        </Link>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200 transition-colors">← Back to site</Link>
      </header>

      <div className="flex-1 grid lg:grid-cols-2 gap-12 max-w-6xl mx-auto w-full px-6 py-10 items-center">
        {/* Pitch */}
        <div>
          <span className="inline-block text-xs font-semibold uppercase tracking-wide text-indigo-400 mb-3">
            SplitLab Affiliate Program
          </span>
          <h1 className="text-4xl font-bold mb-4 leading-tight">
            Earn <span className="text-indigo-400">20% recurring</span> for every customer you refer.
          </h1>
          <p className="text-slate-400 mb-8 text-lg">
            Share your link. When someone signs up and upgrades to a paid plan, you earn 20% of
            their subscription — every month, for as long as they stay a customer.
          </p>
          <ul className="space-y-4">
            <li className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
                <Repeat size={18} className="text-indigo-400" />
              </div>
              <div>
                <p className="font-medium">Recurring, not one-time</p>
                <p className="text-sm text-slate-400">20% of every payment, month after month.</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
                <Users size={18} className="text-indigo-400" />
              </div>
              <div>
                <p className="font-medium">Free signups still count</p>
                <p className="text-sm text-slate-400">If they start free and upgrade later, you still earn.</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
                <DollarSign size={18} className="text-indigo-400" />
              </div>
              <div>
                <p className="font-medium">Transparent dashboard</p>
                <p className="text-sm text-slate-400">Track referrals, earnings, and payouts in real time.</p>
              </div>
            </li>
          </ul>
        </div>

        {/* Form */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-xl">
          <div className="flex gap-1 p-1 bg-slate-800/60 rounded-lg mb-6">
            <button
              onClick={() => setMode('join')}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                mode === 'join' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Become an affiliate
            </button>
            <button
              onClick={() => setMode('login')}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                mode === 'login' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Log in
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'join' && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Full name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)}
                  className="input-base" placeholder="Jane Doe" required autoComplete="name" />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Email address</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                className="input-base" placeholder="you@example.com" required autoComplete="email" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Password</label>
              <div className="relative">
                <input type={showPassword ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)} className="input-base pr-10"
                  placeholder="••••••••" required minLength={mode === 'join' ? 8 : undefined}
                  autoComplete={mode === 'join' ? 'new-password' : 'current-password'} />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200" tabIndex={-1}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {mode === 'join' && <p className="text-xs text-slate-500 mt-1">At least 8 characters</p>}
            </div>
            {mode === 'join' && (
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">
                  Payout email <span className="text-slate-500 font-normal">(PayPal — optional)</span>
                </label>
                <input type="email" value={payoutEmail} onChange={e => setPayoutEmail(e.target.value)}
                  className="input-base" placeholder="paypal@example.com" autoComplete="email" />
              </div>
            )}
            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5 mt-2">
              {loading ? <><Spinner />Please wait…</> : (
                <>{mode === 'join' ? 'Create affiliate account' : 'Log in'} <ArrowRight size={15} /></>
              )}
            </button>
          </form>

          <p className="text-xs text-slate-500 text-center mt-5">
            By joining you agree to our{' '}
            <Link href="/terms" className="text-indigo-400 hover:text-indigo-300">Terms</Link>. Payouts are
            issued manually once your balance reaches the minimum threshold.
          </p>
        </div>
      </div>
    </div>
  );
}

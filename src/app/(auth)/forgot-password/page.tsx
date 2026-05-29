'use client';

import { useState } from 'react';
import Link from 'next/link';
import Spinner from '@/components/ui/Spinner';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="flex items-center justify-center mb-8">
        <Link href="/">
          <img src="/splitlab-logo-light.png" alt="SplitLab" className="dark:hidden" style={{ height: '90px', width: 'auto' }} />
          <img src="/splitlab-logo-dark.png" alt="SplitLab" className="hidden dark:block" style={{ height: '90px', width: 'auto' }} />
        </Link>
      </div>

      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-8">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-1">Reset your password</h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">
          {sent
            ? "If an account exists with that email, we've sent a reset link."
            : "Enter your email and we'll send you a link to reset your password."}
        </p>

        {sent ? (
          <Link href="/login" className="btn-primary w-full justify-center py-2.5 inline-flex">
            Back to Sign in
          </Link>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-base"
                placeholder="you@agency.com"
                required
                autoComplete="email"
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5 mt-2">
              {loading ? <><Spinner />Sending…</> : 'Send Reset Link'}
            </button>
          </form>
        )}
      </div>

      <p className="text-center text-slate-500 dark:text-slate-400 text-sm mt-6">
        Remember your password?{' '}
        <Link href="/login" className="text-indigo-500 hover:text-indigo-400 font-medium transition-colors">Sign in</Link>
      </p>
    </div>
  );
}

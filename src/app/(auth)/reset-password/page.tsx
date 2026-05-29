'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import Spinner from '@/components/ui/Spinner';
import toast from 'react-hot-toast';

function ResetForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="w-full max-w-md">
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">Invalid Reset Link</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">This password reset link is invalid or has expired.</p>
          <Link href="/forgot-password" className="text-indigo-500 hover:text-indigo-400 font-medium transition-colors">
            Request a new reset link
          </Link>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || 'Failed to reset password');
        return;
      }
      setDone(true);
      toast.success('Password updated successfully');
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
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-1">Choose a new password</h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">
          {done ? 'Your password has been updated.' : 'Enter your new password below.'}
        </p>

        {done ? (
          <Link href="/login" className="btn-primary w-full justify-center py-2.5 inline-flex">
            Sign in
          </Link>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">New Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-base pr-10"
                  placeholder="Min. 8 characters"
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input-base"
                required
              />
            </div>
            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5 mt-2">
              {loading ? <><Spinner />Resetting…</> : 'Reset Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="w-full max-w-md flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <ResetForm />
    </Suspense>
  );
}

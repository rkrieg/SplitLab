'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Eye, EyeOff, CheckCircle, Loader2 } from 'lucide-react';

const PLAN_LABELS: Record<string, string> = {
  pro:    'Pro — $49/mo',
  agency: 'Agency — $149/mo',
  scale:  'Scale — $349/mo',
};

function WelcomeForm() {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const sessionId    = searchParams.get('session_id') ?? '';

  const [loading,     setLoading]     = useState(true);
  const [sessionData, setSessionData] = useState<{
    email: string;
    name:  string;
    plan:  string;
  } | null>(null);
  const [error,           setError]           = useState('');
  const [name,            setName]            = useState('');
  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword,    setShowPassword]    = useState(false);
  const [submitting,      setSubmitting]      = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setError('No checkout session found. Please try again.');
      setLoading(false);
      return;
    }

    fetch(`/api/stripe/session?session_id=${sessionId}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          setError(data.error);
        } else {
          setSessionData(data);
          setName(data.name ?? '');
        }
      })
      .catch(() => setError('Failed to verify payment. Please contact support.'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    setSubmitting(true);
    setError('');

    try {
      const res  = await fetch('/api/stripe/complete-signup', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sessionId, name, password }),
      });
      const data = await res.json();

      if (!res.ok) { setError(data.error || 'Failed to create account'); setSubmitting(false); return; }

      const result = await signIn('credentials', {
        email:    sessionData?.email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError('Account created but sign-in failed. Please go to /login.');
        setSubmitting(false);
      } else {
        const destination = data.defaultClientId
          ? `/clients/${data.defaultClientId}/pages`
          : '/dashboard';
        router.push(destination);
        router.refresh();
      }
    } catch {
      setError('An unexpected error occurred. Please try again.');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-blue-500 rounded-xl flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18"/>
              </svg>
            </div>
            <span className="text-xl font-bold text-white">
              Split<span className="text-blue-400">Lab</span>
            </span>
          </div>
        </div>

        {/* Error state — bad session / already expired */}
        {error && !sessionData ? (
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 text-center">
            <p className="text-red-400 mb-4">{error}</p>
            <a href="/#pricing" className="text-blue-400 hover:underline text-sm">Back to pricing</a>
          </div>
        ) : (
          <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle className="w-5 h-5 text-green-400" />
              <h1 className="text-xl font-semibold text-white">Payment confirmed!</h1>
            </div>
            <p className="text-slate-400 text-sm mb-1">
              {PLAN_LABELS[sessionData?.plan ?? ''] ?? 'Your plan'} is active.
            </p>
            <p className="text-slate-500 text-sm mb-6">
              Set a password to finish creating your account.
            </p>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-sm text-red-400 mb-4">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
                <input
                  type="email"
                  value={sessionData?.email ?? ''}
                  disabled
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-700/50 border border-slate-600 text-slate-400 text-sm cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Full name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  placeholder="Jane Doe"
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-700 border border-slate-600 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    minLength={8}
                    placeholder="••••••••"
                    className="w-full px-3 py-2.5 pr-10 rounded-lg bg-slate-700 border border-slate-600 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-1">At least 8 characters</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Confirm password</label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="••••••••"
                  className="w-full px-3 py-2.5 rounded-lg bg-slate-700 border border-slate-600 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-500 hover:bg-blue-400 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors text-sm mt-2"
              >
                {submitting
                  ? <><Loader2 size={16} className="animate-spin" /> Creating account…</>
                  : 'Create account & go to dashboard'}
              </button>
            </form>
          </div>
        )}

        <p className="text-center text-slate-600 text-xs mt-6">
          Questions?{' '}
          <a href="mailto:support@trysplitlab.com" className="text-slate-500 hover:text-slate-300">
            support@trysplitlab.com
          </a>
        </p>
      </div>
    </div>
  );
}

export default function WelcomePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen bg-slate-950">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    }>
      <WelcomeForm />
    </Suspense>
  );
}

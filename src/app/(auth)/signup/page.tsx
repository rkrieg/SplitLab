'use client';

import { useState, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, Check, Loader2, ArrowRight, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';

const PLANS = [
  {
    id: 'free',
    label: 'Starter',
    price: 'Free',
    sub: 'Perfect for trying SplitLab out',
    features: ['1 active test', '2 variants per test', '1,000 visitors/mo', 'Basic analytics', 'Zero-config tracker.js'],
    cta: 'Get Started Free',
    highlight: false,
  },
  {
    id: 'pro',
    label: 'Pro',
    price: '$49',
    sub: 'For marketers running real tests',
    features: ['10 active tests', 'Unlimited variants', '25,000 visitors/mo', 'CSV export', 'Conversion goals', 'Priority email support'],
    cta: 'Start Pro',
    highlight: false,
  },
  {
    id: 'agency',
    label: 'Agency',
    price: '$149',
    sub: 'For agencies managing multiple clients',
    features: ['50 active tests', 'Up to 10 clients', '100,000 visitors/mo', 'Team seats', 'Custom scripts per variant', 'UTM personalization'],
    cta: 'Start Agency',
    highlight: true,
  },
  {
    id: 'scale',
    label: 'Scale',
    price: '$349',
    sub: 'For high-volume teams and networks',
    features: ['Unlimited tests', 'Unlimited clients', 'Unlimited visitors/mo', 'White-label branding', 'Webhook integrations', 'Priority support'],
    cta: 'Start Scale',
    highlight: false,
  },
];

function SignupFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPlan = searchParams.get('plan') || 'free';

  const [step, setStep] = useState<'plan' | 'account'>(
    PLANS.find(p => p.id === initialPlan && p.id !== 'free') ? 'plan' : 'plan'
  );
  const [selectedPlan, setSelectedPlan] = useState(initialPlan);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  // Account form (free plan only)
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handlePlanContinue() {
    if (selectedPlan === 'free') {
      setStep('account');
    } else {
      // Paid plan → Stripe checkout
      setCheckoutLoading(selectedPlan);
      try {
        const res = await fetch('/api/stripe/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: selectedPlan }),
        });
        const data = await res.json();
        if (!res.ok || !data.url) {
          toast.error(data.error || 'Failed to start checkout. Please try again.');
          return;
        }
        window.location.href = data.url;
      } catch {
        toast.error('Failed to start checkout. Please try again.');
      } finally {
        setCheckoutLoading(null);
      }
    }
  }

  async function handleFreeSignup(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { toast.error('Passwords do not match'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Signup failed'); return; }

      const result = await signIn('credentials', { email, password, redirect: false });
      if (result?.error) {
        toast.success('Account created! Please sign in.');
        router.push('/login');
      } else {
        toast.success('Welcome to SplitLab!');
        router.push('/dashboard');
        router.refresh();
      }
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }

  const planObj = PLANS.find(p => p.id === selectedPlan) || PLANS[0];

  return (
    <div className="w-full max-w-4xl mx-auto px-4">
      {/* Logo */}
      <div className="flex items-center justify-center mb-8">
        <img src="/splitlab-logo-light.png" alt="SplitLab" className="dark:hidden" style={{ height: '90px', width: 'auto' }} />
        <img src="/splitlab-logo-dark.png" alt="SplitLab" className="hidden dark:block" style={{ height: '90px', width: 'auto' }} />
      </div>

      {step === 'plan' && (
        <>
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 mb-2">Choose your plan</h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm">Start free or unlock more with a paid plan. No setup fees. Cancel anytime.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {PLANS.map(plan => (
              <button
                key={plan.id}
                onClick={() => setSelectedPlan(plan.id)}
                className={`relative text-left rounded-2xl border-2 p-5 transition-all focus:outline-none ${
                  selectedPlan === plan.id
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10 shadow-md'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/50 hover:border-slate-300 dark:hover:border-slate-600'
                }`}
              >
                {plan.highlight && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-semibold px-3 py-1 rounded-full bg-indigo-500 text-white whitespace-nowrap">
                    Most Popular
                  </span>
                )}
                {selectedPlan === plan.id && (
                  <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
                    <Check size={11} className="text-white" strokeWidth={3} />
                  </span>
                )}
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">{plan.label}</p>
                <div className="flex items-baseline gap-0.5 mb-1">
                  <span className="text-2xl font-bold text-slate-900 dark:text-slate-100">{plan.price}</span>
                  {plan.id !== 'free' && <span className="text-xs text-slate-400">/mo</span>}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4 leading-snug">{plan.sub}</p>
                <ul className="space-y-1.5">
                  {plan.features.map(f => (
                    <li key={f} className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                      <Check size={12} className="text-green-500 flex-shrink-0 mt-0.5" strokeWidth={2.5} />
                      {f}
                    </li>
                  ))}
                </ul>
              </button>
            ))}
          </div>

          <div className="flex flex-col items-center gap-3">
            <button
              onClick={handlePlanContinue}
              disabled={!!checkoutLoading}
              className="flex items-center gap-2 px-8 py-3 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold text-sm transition-colors shadow-sm"
            >
              {checkoutLoading ? (
                <><Loader2 size={16} className="animate-spin" /> Redirecting to checkout…</>
              ) : selectedPlan === 'free' ? (
                <>{planObj.cta} <ArrowRight size={15} /></>
              ) : (
                <>Continue to checkout <ArrowRight size={15} /></>
              )}
            </button>
            <p className="text-xs text-slate-400">
              Already have an account?{' '}
              <Link href="/login" className="text-indigo-500 hover:text-indigo-400 font-medium">Sign in</Link>
            </p>
          </div>
        </>
      )}

      {step === 'account' && (
        <div className="max-w-md mx-auto">
          <button
            onClick={() => setStep('plan')}
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 mb-6 transition-colors"
          >
            <ArrowLeft size={14} /> Back to plans
          </button>

          <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-8">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/20">
                Free plan
              </span>
            </div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mt-2 mb-1">Create your account</h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">Get started with SplitLab for free — no credit card required.</p>

            <form onSubmit={handleFreeSignup} className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Full name</label>
                <input id="name" type="text" value={name} onChange={e => setName(e.target.value)} className="input-base" placeholder="Jane Doe" required autoComplete="name" />
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Email address</label>
                <input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} className="input-base" placeholder="you@company.com" required autoComplete="email" />
              </div>
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Password</label>
                <div className="relative">
                  <input
                    id="password" type={showPassword ? 'text' : 'password'} value={password}
                    onChange={e => setPassword(e.target.value)} className="input-base pr-10"
                    placeholder="••••••••" required minLength={8} autoComplete="new-password"
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors" tabIndex={-1}>
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">At least 8 characters</p>
              </div>
              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Confirm password</label>
                <div className="relative">
                  <input
                    id="confirmPassword" type={showPassword ? 'text' : 'password'} value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)} className="input-base pr-10"
                    placeholder="••••••••" required minLength={8} autoComplete="new-password"
                  />
                </div>
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5 mt-2">
                {loading ? <><Loader2 size={16} className="animate-spin" /> Creating account…</> : 'Create free account'}
              </button>
            </form>

            <p className="text-center text-slate-400 text-xs mt-5">
              Want more features?{' '}
              <button onClick={() => setStep('plan')} className="text-indigo-500 hover:text-indigo-400 font-medium">See paid plans</button>
            </p>
          </div>

          <p className="text-center text-slate-500 dark:text-slate-400 text-sm mt-6">
            Already have an account?{' '}
            <Link href="/login" className="text-indigo-500 hover:text-indigo-400 font-medium transition-colors">Sign in</Link>
          </p>
        </div>
      )}
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
      </div>
    }>
      <SignupFlow />
    </Suspense>
  );
}

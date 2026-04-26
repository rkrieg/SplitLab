'use client';

import { useState, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Zap, BarChart2, Users, Globe, ArrowRight, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import toast from 'react-hot-toast';

const FEATURES = [
  {
    icon: Zap,
    title: 'Traffic Splitting',
    desc: 'Route visitors across variants with full control over weights — update live without a redeploy.',
  },
  {
    icon: BarChart2,
    title: 'Real-time Analytics',
    desc: 'Track visitors, conversions, CVR, and statistical confidence across every variant automatically.',
  },
  {
    icon: Users,
    title: 'Multi-client Workspace',
    desc: 'Manage every client in one place. Separate pages, tests, and domains per workspace.',
  },
  {
    icon: Globe,
    title: 'Any Domain',
    desc: 'Attach custom domains, verify DNS, and serve your A/B tests instantly — no Vercel dependency.',
  },
];

function LoginPanel() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await signIn('credentials', { email, password, redirect: false });
      if (result?.error) {
        toast.error('Invalid email or password');
      } else {
        router.push('/dashboard');
        router.refresh();
      }
    } catch {
      toast.error('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-8 shadow-xl shadow-slate-200/60 dark:shadow-slate-900/60 w-full max-w-sm">
      <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">Sign in to SplitLab</h2>
      <p className="text-slate-500 dark:text-slate-400 text-sm mb-6">Enter your credentials to access the platform</p>

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

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
            Password
          </label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-base pr-10"
              placeholder="••••••••"
              required
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full justify-center py-2.5 mt-2"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="text-center text-slate-500 dark:text-slate-400 text-xs mt-5">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-[#3D8BDA] hover:text-blue-500 font-medium transition-colors">
          Sign up
        </Link>
      </p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {/* Nav */}
      <nav className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <svg width="140" height="32" viewBox="0 0 220 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="18" cy="24" r="16" fill="#3D8BDA" opacity="0.15"/>
            <circle cx="18" cy="24" r="14" stroke="#3D8BDA" strokeWidth="1.5"/>
            <path d="M20 12L13 26H18L15 36L24 22H19L20 12Z" fill="#3D8BDA"/>
            <text x="42" y="21" fontFamily="system-ui, sans-serif" fontWeight="700" fontSize="24" fill="currentColor" letterSpacing="-0.5" className="text-slate-900 dark:text-white">Split<tspan fill="#3D8BDA" fontWeight="600">Lab</tspan></text>
          </svg>
          <div className="flex items-center gap-3">
            <Link href="/login" className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors">
              Log in
            </Link>
            <Link href="/signup" className="btn-primary py-1.5 px-4 text-sm">
              Get started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <div className="flex-1 max-w-6xl mx-auto px-6 py-16 lg:py-24 w-full">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          {/* Left — copy */}
          <div>
            <div className="inline-flex items-center gap-2 bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900 text-[#3D8BDA] text-xs font-semibold px-3 py-1 rounded-full mb-6">
              <Zap size={12} />
              A/B Testing for agencies
            </div>
            <h1 className="text-4xl lg:text-5xl font-bold text-slate-900 dark:text-slate-50 leading-tight tracking-tight mb-5">
              Run smarter tests.<br />
              <span className="text-[#3D8BDA]">Prove what converts.</span>
            </h1>
            <p className="text-lg text-slate-500 dark:text-slate-400 leading-relaxed mb-8 max-w-lg">
              SplitLab gives agencies a single platform to manage landing pages, split traffic across variants, and track real conversion data — for every client.
            </p>

            <ul className="space-y-3 mb-10">
              {[
                'No-code traffic splitting with live weight control',
                'Statistical confidence & conversion analytics',
                'Manage unlimited clients and domains',
                'AI-powered variant generation (coming soon)',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-slate-600 dark:text-slate-300">
                  <CheckCircle2 size={16} className="text-[#3D8BDA] mt-0.5 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>

            <Link
              href="/signup"
              className="inline-flex items-center gap-2 btn-primary py-3 px-6 text-base font-semibold"
            >
              Start for free <ArrowRight size={16} />
            </Link>
          </div>

          {/* Right — login */}
          <div className="flex justify-center lg:justify-end">
            <LoginPanel />
          </div>
        </div>

        {/* Features */}
        <div className="mt-24 border-t border-slate-200 dark:border-slate-800 pt-16">
          <p className="text-center text-xs font-semibold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-10">
            Everything you need to test and optimise
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {FEATURES.map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-950/40 flex items-center justify-center mb-4">
                  <Icon size={18} className="text-[#3D8BDA]" />
                </div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1.5">{title}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 py-6">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-2">
          <p className="text-xs text-slate-400">© {new Date().getFullYear()} SplitLab. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">Log in</Link>
            <Link href="/signup" className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">Sign up</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

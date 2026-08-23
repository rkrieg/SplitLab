import type { Metadata } from 'next';
import Link from 'next/link';
import { COMPARISONS } from '@/content/comparisons';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export const metadata: Metadata = {
  title: 'Compare SplitLab to Other A/B Testing & Landing Page Tools',
  description: 'Honest comparisons of SplitLab vs Unbounce, VWO, and other A/B testing and landing page optimization tools.',
  alternates: { canonical: `${SITE}/compare` },
};

export default function CompareHub() {
  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="border-b border-slate-100 dark:border-slate-800">
        <div className="max-w-4xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/" className="font-bold text-lg text-[#3D8BDA]">SplitLab</Link>
          <Link href="/signup" className="text-sm font-medium bg-[#3D8BDA] text-white px-3.5 py-1.5 rounded-lg hover:opacity-90">Start free</Link>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-5 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Compare SplitLab</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-2 mb-10">How SplitLab stacks up against other A/B testing and landing page tools.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          {COMPARISONS.map((c) => (
            <Link key={c.slug} href={`/compare/${c.slug}`} className="block rounded-xl border border-slate-200 dark:border-slate-800 p-5 hover:border-[#3D8BDA] transition-colors">
              <h2 className="text-base font-semibold">SplitLab vs {c.competitor}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">{c.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}

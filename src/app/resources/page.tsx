import type { Metadata } from 'next';
import Link from 'next/link';
import { ARTICLES } from '@/content/articles';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export const metadata: Metadata = {
  title: 'Resources — A/B Testing & Landing Page Optimization Guides',
  description: 'Guides and resources on A/B testing, split testing, and landing page conversion optimization from SplitLab.',
  alternates: { canonical: `${SITE}/resources` },
};

export default function ResourcesHub() {
  const articles = [...ARTICLES].sort((a, b) => (a.datePublished < b.datePublished ? 1 : -1));

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="border-b border-slate-100 dark:border-slate-800">
        <div className="max-w-4xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/" className="font-bold text-lg text-[#3D8BDA]">SplitLab</Link>
          <Link href="/signup" className="text-sm font-medium bg-[#3D8BDA] text-white px-3.5 py-1.5 rounded-lg hover:opacity-90">Start free</Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Resources</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-2 mb-10">
          Guides on A/B testing, split testing, and landing page conversion optimization.
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          {articles.map((a) => (
            <Link
              key={a.slug}
              href={`/resources/${a.slug}`}
              className="block rounded-xl border border-slate-200 dark:border-slate-800 p-5 hover:border-[#3D8BDA] transition-colors"
            >
              <span className="text-[11px] uppercase tracking-wide text-[#3D8BDA] font-semibold">{a.category}</span>
              <h2 className="text-base font-semibold mt-1">{a.title}</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1.5">{a.description}</p>
              <span className="text-xs text-slate-400 mt-3 inline-block">{a.readMins} min read</span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}

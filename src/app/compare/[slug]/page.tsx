import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { COMPARISONS, getComparison } from '@/content/comparisons';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export function generateStaticParams() {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const c = getComparison(params.slug);
  if (!c) return {};
  const url = `${SITE}/compare/${c.slug}`;
  return {
    title: c.title,
    description: c.description,
    keywords: c.keywords,
    alternates: { canonical: url },
    openGraph: { type: 'article', url, title: c.title, description: c.description },
  };
}

export default function ComparePage({ params }: { params: { slug: string } }) {
  const c = getComparison(params.slug);
  if (!c) notFound();
  const url = `${SITE}/compare/${c.slug}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'FAQPage', mainEntity: c.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
        { '@type': 'ListItem', position: 2, name: 'Compare', item: `${SITE}/compare` },
        { '@type': 'ListItem', position: 3, name: `SplitLab vs ${c.competitor}`, item: url },
      ] },
    ],
  };

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <header className="border-b border-slate-100 dark:border-slate-800">
        <div className="max-w-3xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/" className="font-bold text-lg text-[#3D8BDA]">SplitLab</Link>
          <Link href="/signup" className="text-sm font-medium bg-[#3D8BDA] text-white px-3.5 py-1.5 rounded-lg hover:opacity-90">Start free</Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 py-10">
        <h1 className="text-3xl font-bold tracking-tight">SplitLab vs {c.competitor}</h1>
        <p className="article-prose mt-4">{c.intro}</p>

        <div className="overflow-x-auto mt-8 rounded-xl border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 dark:border-slate-800 text-left">
                <th className="px-4 py-2.5 font-medium text-slate-500 dark:text-slate-400"></th>
                <th className="px-4 py-2.5 font-semibold text-[#3D8BDA]">SplitLab</th>
                <th className="px-4 py-2.5 font-semibold">{c.competitor}</th>
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.dimension} className="border-b border-slate-50 dark:border-slate-800/50 align-top">
                  <td className="px-4 py-3 font-medium text-slate-700 dark:text-slate-300">{r.dimension}</td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{r.splitlab}</td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{r.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid sm:grid-cols-2 gap-4 mt-8">
          <div className="rounded-xl border border-[#3D8BDA]/40 bg-[#3D8BDA]/5 p-5">
            <h2 className="font-semibold mb-2">Choose SplitLab if…</h2>
            <div className="article-prose"><ul>{c.whenSplitlab.map((w) => <li key={w}>{w}</li>)}</ul></div>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-5">
            <h2 className="font-semibold mb-2">Choose {c.competitor} if…</h2>
            <div className="article-prose"><ul>{c.whenCompetitor.map((w) => <li key={w}>{w}</li>)}</ul></div>
          </div>
        </div>

        <section className="mt-12">
          <h2 className="text-xl font-bold mb-4">FAQ</h2>
          <div className="article-prose space-y-4">
            {c.faqs.map((f) => (<div key={f.q}><h3>{f.q}</h3><p>{f.a}</p></div>))}
          </div>
        </section>

        <p className="text-xs text-slate-400 dark:text-slate-500 mt-8">
          {c.competitor} details reflect our understanding at publication and may change — verify current pricing and features on their site.
        </p>

        <div className="mt-10 rounded-xl border border-slate-200 dark:border-slate-800 p-6 text-center">
          <p className="font-semibold mb-1">Try SplitLab free</p>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Build a page with AI and launch an A/B test on your own domain in minutes.</p>
          <Link href="/signup" className="inline-block text-sm font-medium bg-[#3D8BDA] text-white px-4 py-2 rounded-lg hover:opacity-90">Start free</Link>
        </div>
      </main>
    </div>
  );
}

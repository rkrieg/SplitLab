import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ARTICLES, getArticle } from '@/content/articles';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

export function generateStaticParams() {
  return ARTICLES.map((a) => ({ slug: a.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const a = getArticle(params.slug);
  if (!a) return {};
  const url = `${SITE}/resources/${a.slug}`;
  return {
    title: a.title,
    description: a.description,
    keywords: a.keywords,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      url,
      title: a.title,
      description: a.description,
      publishedTime: a.datePublished,
      modifiedTime: a.dateModified,
    },
    twitter: { card: 'summary_large_image', title: a.title, description: a.description },
  };
}

export default function ArticlePage({ params }: { params: { slug: string } }) {
  const a = getArticle(params.slug);
  if (!a) notFound();

  const url = `${SITE}/resources/${a.slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${url}#article`,
        headline: a.title,
        description: a.description,
        datePublished: a.datePublished,
        dateModified: a.dateModified,
        author: { '@type': 'Organization', name: 'SplitLab', url: SITE },
        publisher: { '@type': 'Organization', name: 'SplitLab', logo: { '@type': 'ImageObject', url: `${SITE}/android-chrome-512x512.png` } },
        mainEntityOfPage: url,
        keywords: a.keywords.join(', '),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
          { '@type': 'ListItem', position: 2, name: 'Resources', item: `${SITE}/resources` },
          { '@type': 'ListItem', position: 3, name: a.title, item: url },
        ],
      },
      ...(a.faqs?.length
        ? [{
            '@type': 'FAQPage',
            mainEntity: a.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
          }]
        : []),
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
        <nav className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          <Link href="/resources" className="hover:underline">Resources</Link> <span className="mx-1">/</span> {a.category}
        </nav>
        <h1 className="text-3xl font-bold tracking-tight mb-2">{a.title}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-8">
          {new Date(a.datePublished).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })} · {a.readMins} min read
        </p>

        <article className="article-prose">
          <a.Body />
        </article>

        {a.faqs?.length ? (
          <section className="mt-12">
            <h2 className="text-xl font-bold mb-4">Frequently asked questions</h2>
            <div className="space-y-4 article-prose">
              {a.faqs.map((f) => (
                <div key={f.q}>
                  <h3>{f.q}</h3>
                  <p>{f.a}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="mt-12 rounded-xl border border-slate-200 dark:border-slate-800 p-6 text-center">
          <p className="font-semibold mb-1">Run this test in SplitLab</p>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Build a page with AI, split traffic on your own domain, and get significance automatically.</p>
          <Link href="/signup" className="inline-block text-sm font-medium bg-[#3D8BDA] text-white px-4 py-2 rounded-lg hover:opacity-90">Start free</Link>
        </div>
      </main>
    </div>
  );
}

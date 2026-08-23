import type { Metadata } from 'next';
import Link from 'next/link';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
const URL = `${SITE}/resources/glossary`;

export const metadata: Metadata = {
  title: 'A/B Testing & CRO Glossary',
  description: 'Plain-English definitions of A/B testing, split testing, conversion rate optimization, and landing page terms.',
  keywords: ['a/b testing glossary', 'what is a/b testing', 'what is split testing', 'statistical significance', 'conversion rate optimization'],
  alternates: { canonical: URL },
};

const TERMS: { term: string; slug: string; def: string }[] = [
  { term: 'A/B testing', slug: 'ab-testing', def: 'A method of comparing two versions of a page or element by showing each to a random half of your traffic at the same time and measuring which produces more conversions. Also called split testing.' },
  { term: 'Split testing', slug: 'split-testing', def: 'Another name for A/B testing — splitting traffic between two or more variants to see which performs best. "Split URL testing" specifically means testing separate URLs rather than on-page changes.' },
  { term: 'Statistical significance', slug: 'statistical-significance', def: 'The likelihood that the difference between your variants is real rather than random chance. A result at 95% confidence means there is only a 5% probability the difference is a fluke. Most teams call a winner at 95%+.' },
  { term: 'Conversion rate', slug: 'conversion-rate', def: 'The percentage of visitors who complete your goal (a form submit, sign-up, or purchase). Calculated as conversions divided by unique visitors, times 100.' },
  { term: 'Conversion rate optimization (CRO)', slug: 'cro', def: 'The practice of systematically increasing the percentage of visitors who convert, usually through A/B testing, landing page improvements, and removing friction from the funnel.' },
  { term: 'Control and variant', slug: 'control-and-variant', def: 'The control (or "A") is your existing version; the variant (or "B", the challenger) is the new version you are testing against it. The control is the baseline you measure improvement from.' },
  { term: 'Sample size', slug: 'sample-size', def: 'The number of visitors (and conversions) a test needs to detect a given difference with confidence. Lower baseline conversion rates and smaller expected lifts require larger samples. Estimate it before you start.' },
  { term: 'Statistical power', slug: 'statistical-power', def: 'The probability that a test will detect a real difference when one exists. Underpowered tests (too little traffic) often miss real winners or report false results.' },
  { term: 'Multivariate testing', slug: 'multivariate-testing', def: 'Testing multiple elements and their combinations at once (e.g., two headlines × two images) to find the best combination. It needs far more traffic than a simple A/B test.' },
  { term: 'Landing page', slug: 'landing-page', def: 'A standalone page built for a single goal — usually the destination for an ad or campaign — designed to convert visitors into leads or customers.' },
];

export default function Glossary() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'DefinedTermSet',
        name: 'A/B Testing & CRO Glossary',
        url: URL,
        hasDefinedTerm: TERMS.map((t) => ({ '@type': 'DefinedTerm', name: t.term, description: t.def, url: `${URL}#${t.slug}` })),
      },
      { '@type': 'FAQPage', mainEntity: TERMS.map((t) => ({ '@type': 'Question', name: `What is ${t.term}?`, acceptedAnswer: { '@type': 'Answer', text: t.def } })) },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
        { '@type': 'ListItem', position: 2, name: 'Resources', item: `${SITE}/resources` },
        { '@type': 'ListItem', position: 3, name: 'Glossary', item: URL },
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
        <nav className="text-xs text-slate-500 dark:text-slate-400 mb-4"><Link href="/resources" className="hover:underline">Resources</Link> <span className="mx-1">/</span> Glossary</nav>
        <h1 className="text-3xl font-bold tracking-tight">A/B Testing &amp; CRO Glossary</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-2 mb-8">Plain-English definitions of the terms behind A/B testing and conversion optimization.</p>
        <dl className="space-y-6">
          {TERMS.map((t) => (
            <div key={t.slug} id={t.slug} className="scroll-mt-20">
              <dt className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t.term}</dt>
              <dd className="text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">{t.def}</dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  );
}

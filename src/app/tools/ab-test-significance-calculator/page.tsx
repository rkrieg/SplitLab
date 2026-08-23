import type { Metadata } from 'next';
import Link from 'next/link';
import Calculator from './Calculator';

const SITE = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
const URL = `${SITE}/tools/ab-test-significance-calculator`;

export const metadata: Metadata = {
  title: 'A/B Test Significance Calculator (Free)',
  description:
    'Free A/B test statistical significance calculator. Enter visitors and conversions for your control and variant to see the confidence level and whether your result is significant.',
  keywords: ['a/b test significance calculator', 'ab test calculator', 'statistical significance calculator', 'conversion rate calculator', 'a/b testing'],
  alternates: { canonical: URL },
  openGraph: { type: 'website', url: URL, title: 'A/B Test Significance Calculator (Free)', description: 'Check if your A/B test result is statistically significant.' },
};

const FAQ = [
  { q: 'What is statistical significance in A/B testing?', a: 'Statistical significance is the probability that the difference between your variants is real and not due to random chance. A result at 95% confidence means there is only a 5% chance the difference is a fluke. Most teams treat 95%+ as the threshold for calling a winner.' },
  { q: 'How does this calculator work?', a: 'It runs a chi-square test on your two variants using conversions and visitors, then converts the result into a confidence percentage. At 95% or higher, the difference is considered statistically significant.' },
  { q: 'Why is my A/B test not significant yet?', a: 'Usually you need more data. Small samples, small differences between variants, or an early read all produce low confidence. Keep the test running across a full business cycle until you reach 95%+.' },
];

export default function CalculatorPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: 'A/B Test Significance Calculator',
        url: URL,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        description: 'Free A/B test statistical significance calculator.',
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE },
          { '@type': 'ListItem', position: 2, name: 'A/B Test Significance Calculator', item: URL },
        ],
      },
      { '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
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
        <h1 className="text-3xl font-bold tracking-tight">A/B Test Significance Calculator</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-2 mb-8">
          Enter the visitors and conversions for your control and variant to see whether your A/B test result is statistically significant (95%+ confidence).
        </p>

        <Calculator />

        <section className="article-prose mt-12">
          <h2>How to read the result</h2>
          <p>
            The calculator runs a chi-square test comparing your two variants and returns a <strong>confidence</strong>
            level. At <strong>95% or higher</strong>, the difference is statistically significant — you can be confident
            the winner is real and not random noise. Below 95%, keep collecting data.
          </p>
          <h2>Before you trust a result</h2>
          <ul>
            <li>Run the test across a <strong>full business cycle</strong> (usually 1–2 weeks), not just a few days.</li>
            <li>Don&apos;t stop the moment a variant looks ahead — early leads frequently reverse.</li>
            <li>Make sure both variants ran <strong>at the same time</strong> with randomly split traffic.</li>
          </ul>
          <p>
            Want this calculated automatically as your test runs? <Link href="/signup">SplitLab</Link> tracks
            significance in real time on your own domain — <Link href="/resources/how-to-ab-test-a-landing-page">see the full guide</Link>.
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-bold mb-4">FAQ</h2>
          <div className="article-prose space-y-4">
            {FAQ.map((f) => (<div key={f.q}><h3>{f.q}</h3><p>{f.a}</p></div>))}
          </div>
        </section>
      </main>
    </div>
  );
}

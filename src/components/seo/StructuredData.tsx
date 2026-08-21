import { PLAN_DETAILS, type PlanId } from '@/lib/plans';

const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

// FAQs double as keyword-rich, extractable content that LLMs and Google rich
// results pull from. Keep answers factual and self-contained.
const FAQ: { q: string; a: string }[] = [
  {
    q: 'What is SplitLab?',
    a: 'SplitLab is an agency-first A/B testing and AI landing-page platform. You can build landing pages with AI, run A/B and split tests on your own custom domains, and optimize conversion rate with real-time analytics and statistical significance testing.',
  },
  {
    q: 'Does SplitLab do A/B testing and split testing?',
    a: 'Yes. SplitLab splits traffic deterministically across variants by weight, tracks pageviews and conversions, and calculates statistical significance (95%+ confidence) so you know which landing page variant wins.',
  },
  {
    q: 'Can I build landing pages with AI in SplitLab?',
    a: 'Yes. SplitLab includes an AI landing-page builder that generates pages from a prompt, an existing URL, or uploaded HTML, and lets you edit them conversationally. Pages can be published as test variants on your own domain.',
  },
  {
    q: 'Is SplitLab good for agencies?',
    a: 'SplitLab is built agency-first: one account manages multiple clients, each with its own workspace, custom domains, tests, and team seats, so agencies can run conversion optimization for many clients from one place.',
  },
  {
    q: 'How much does SplitLab cost?',
    a: 'SplitLab has a free plan and paid plans starting at $49/month (Pro), $99/month (Growth, which adds the AI builder), $149/month (Agency), and $349/month (Scale). Higher plans add more tests, clients, custom domains, AI credits, and team seats.',
  },
];

export default function StructuredData() {
  const offers = (Object.keys(PLAN_DETAILS) as PlanId[])
    .filter((id) => PLAN_DETAILS[id].monthlyPrice != null)
    .map((id) => ({
      '@type': 'Offer',
      name: PLAN_DETAILS[id].name,
      price: String(PLAN_DETAILS[id].monthlyPrice),
      priceCurrency: 'USD',
      category: 'subscription',
    }));

  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: 'SplitLab',
        url: SITE_URL,
        logo: `${SITE_URL}/android-chrome-512x512.png`,
        description: 'Agency-first A/B testing and AI landing-page platform.',
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: 'SplitLab',
        publisher: { '@id': `${SITE_URL}/#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#software`,
        name: 'SplitLab',
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'A/B Testing & Landing Page Optimization',
        operatingSystem: 'Web',
        url: SITE_URL,
        description:
          'A/B testing and AI landing-page platform for building landing pages, running split tests, and optimizing conversion rate — built for agencies.',
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'USD',
          lowPrice: '0',
          highPrice: '349',
          offerCount: String(offers.length + 1),
          offers,
        },
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: FAQ.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}

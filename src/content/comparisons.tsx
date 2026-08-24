export interface Comparison {
  slug: string;
  competitor: string;
  title: string;
  description: string;
  keywords: string[];
  datePublished: string;
  dateModified: string;
  intro: string;
  rows: { dimension: string; splitlab: string; competitor: string }[];
  whenSplitlab: string[];
  whenCompetitor: string[];
  faqs: { q: string; a: string }[];
}

// Competitor descriptions are factual and high-level (positioning, not exact
// prices/feature lists, which change) — verify current specifics on their site.
const unbounce: Comparison = {
  slug: 'splitlab-vs-unbounce',
  competitor: 'Unbounce',
  title: 'SplitLab vs Unbounce: Which Landing Page & A/B Testing Tool?',
  description: 'SplitLab vs Unbounce compared for A/B testing, AI landing pages, agencies, and pricing — so you can pick the right landing page optimization tool.',
  keywords: ['splitlab vs unbounce', 'unbounce alternative', 'landing page builder', 'a/b testing', 'landing page optimization'],
  datePublished: '2026-08-23',
  dateModified: '2026-08-23',
  intro:
    'Unbounce is a well-established landing page builder with drag-and-drop pages, a template library, and A/B testing. SplitLab is an agency-first A/B testing and AI landing-page platform that runs tests on your own custom domains and builds pages with AI. Here is how they compare.',
  rows: [
    { dimension: 'Best for', splitlab: 'Agencies and teams running A/B tests across multiple clients', competitor: 'Marketers building and hosting standalone landing pages' },
    { dimension: 'Landing page building', splitlab: 'AI builder (from a prompt, URL, or uploaded HTML) + hosted HTML variants', competitor: 'Drag-and-drop builder with a large template library' },
    { dimension: 'A/B & split testing', splitlab: 'Deterministic traffic split with statistical significance built in', competitor: 'Built-in A/B testing (plus AI traffic routing on higher tiers)' },
    { dimension: 'Multi-client / agency model', splitlab: 'Native: one account manages many clients, each with its own workspace, domains, and team seats', competitor: 'Possible, but oriented around a single brand/account' },
    { dimension: 'Custom domains', splitlab: 'Serve tests on the client’s own domain', competitor: 'Custom domains supported' },
    { dimension: 'AI usage model', splitlab: 'Usage-based AI credits + prepaid top-ups', competitor: 'AI features bundled by plan' },
  ],
  whenSplitlab: [
    'You run conversion optimization for multiple clients and want them all in one account.',
    'You want to build or rework landing pages with AI and test them on your own domain.',
    'You want statistical significance calculated for you, not guesswork.',
  ],
  whenCompetitor: [
    'You want a mature drag-and-drop editor with a big template gallery.',
    'You are a single brand and prefer an all-in-one hosted page builder.',
  ],
  faqs: [
    { q: 'Is SplitLab a good Unbounce alternative?', a: 'Yes, especially for agencies. SplitLab focuses on A/B testing across multiple clients, building pages with AI, and testing on your own domains, with statistical significance built in. Unbounce is a strong choice if you primarily want a drag-and-drop landing page builder with a large template library.' },
    { q: 'Does SplitLab build landing pages like Unbounce?', a: 'SplitLab builds pages with an AI builder (from a prompt, an existing URL, or uploaded HTML) and can import pages you built elsewhere, rather than a drag-and-drop canvas.' },
  ],
};

const vwo: Comparison = {
  slug: 'splitlab-vs-vwo',
  competitor: 'VWO',
  title: 'SplitLab vs VWO: A/B Testing & CRO Compared',
  description: 'SplitLab vs VWO compared for A/B testing, landing page building, agencies, and complexity — pick the right experimentation tool for your team.',
  keywords: ['splitlab vs vwo', 'vwo alternative', 'a/b testing software', 'conversion rate optimization', 'experimentation platform'],
  datePublished: '2026-08-23',
  dateModified: '2026-08-23',
  intro:
    'VWO is a broad, enterprise-oriented experimentation and CRO platform (A/B and multivariate testing, heatmaps, funnels, and more) that runs on your existing site. SplitLab is a focused, agency-first A/B testing and AI landing-page platform. Here is how they compare.',
  rows: [
    { dimension: 'Best for', splitlab: 'Agencies and teams testing and building landing pages', competitor: 'Larger orgs wanting a full experimentation/CRO suite' },
    { dimension: 'Scope', splitlab: 'Landing page A/B testing + AI page building', competitor: 'Site-wide experimentation, heatmaps, funnels, surveys' },
    { dimension: 'Landing page building', splitlab: 'AI builder + hosted variants', competitor: 'Tests changes on your existing pages (not a page builder)' },
    { dimension: 'Complexity & setup', splitlab: 'Lightweight; a test can be live in minutes', competitor: 'More powerful but heavier to set up and learn' },
    { dimension: 'Agency multi-client', splitlab: 'Native multi-client workspaces', competitor: 'Enterprise account structures' },
    { dimension: 'Pricing model', splitlab: 'Simple plans + usage-based AI credits', competitor: 'Typically enterprise/quote-based at scale' },
  ],
  whenSplitlab: [
    'You mainly test and build landing pages and want to move fast.',
    'You manage multiple clients and want simple, predictable pricing.',
    'You want an AI page builder alongside testing.',
  ],
  whenCompetitor: [
    'You need site-wide experimentation plus heatmaps, funnels, and surveys.',
    'You are an enterprise with a dedicated CRO team and complex requirements.',
  ],
  faqs: [
    { q: 'Is SplitLab a good VWO alternative?', a: 'For teams focused on landing page A/B testing and building pages, SplitLab is a lighter, faster, more affordable alternative. VWO is better suited to enterprises that need a full experimentation suite with heatmaps, funnels, and site-wide testing.' },
    { q: 'Does SplitLab do multivariate testing like VWO?', a: 'SplitLab focuses on A/B and split testing of landing page variants with built-in significance. VWO offers broader multivariate and site-wide experimentation.' },
  ],
};

export const COMPARISONS: Comparison[] = [unbounce, vwo];
export const COMPARISON_LINKS = COMPARISONS.map((c) => ({ slug: c.slug, competitor: c.competitor, title: c.title }));
export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

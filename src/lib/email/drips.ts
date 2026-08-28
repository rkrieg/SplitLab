import { renderEmail } from './lifecycle';

const APP = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';

/** State the cron computes per account-owner user to decide which drips are due. */
export interface DripCtx {
  firstName: string;
  planName: string;          // e.g. 'Growth' (paid) — display only
  hasTest: boolean;
  hasActiveTest: boolean;
  hasVerifiedDomain: boolean;
}

export interface DripStep {
  key: string;
  track: 'free' | 'paid';
  day: number;                       // days since signup this step fires on
  when?: (c: DripCtx) => boolean;    // extra condition
  subject: (c: DripCtx) => string;
  html: (c: DripCtx) => string;
}

const b = (label: string, path: string) => ({ label, url: `${APP}${path}` });
const wrap = (heading: string, bodyHtml: string, button: { label: string; url: string }, preheader?: string) =>
  renderEmail({ heading, bodyHtml, button, preheader, showUnsubscribe: true });

// ─── Series 1: Free → Paid ──────────────────────────────────────────────────
const FREE: DripStep[] = [
  { key: 'free.welcome', track: 'free', day: 0,
    subject: () => "Welcome to SplitLab — let's get your first test live",
    html: (c) => wrap('Welcome to SplitLab',
      `<p>Hi ${c.firstName}, welcome aboard. SplitLab lets you A/B test and build landing pages on your own domains, with the winner calculated for you.</p><p>The single best first step: launch a test. Paste an existing page URL or generate one with AI, add a variant, and you're live.</p>`,
      b('Create your first test', '/dashboard'), 'Two clicks from your first A/B test') },

  { key: 'free.first_test_nudge', track: 'free', day: 2, when: (c) => !c.hasTest,
    subject: () => "You haven't launched a test yet",
    html: (c) => wrap('Your first test takes ~2 minutes',
      `<p>Hi ${c.firstName} — point SplitLab at a page (URL, upload, or an AI-built one), add one variant, and split your traffic. We handle assignment, tracking, and significance.</p>`,
      b('Launch a test', '/dashboard'), 'Here is the fastest path') },

  { key: 'free.ai_builder', track: 'free', day: 4,
    subject: () => 'Build a landing page from a prompt',
    html: () => wrap('The fastest way to a new variant',
      `<p>No design or dev needed — describe the page you want, paste a URL to rework, or drop in HTML, and the AI builder ships a hosted variant you can test immediately.</p>`,
      b('Try the AI builder', '/dashboard'), 'The fastest way to a new variant') },

  { key: 'free.what_paid_unlocks', track: 'free', day: 9,
    subject: () => 'What you unlock on a paid plan',
    html: () => wrap('What paid unlocks',
      `<p>Free is great for a first test. Paid is where it scales: higher visitor limits so your data never stops recording, more monthly AI credits, custom domains for every client, and multi-client workspaces.</p>`,
      b('Compare plans', '/billing'), 'More traffic, AI credits, domains, clients') },

  { key: 'free.offer', track: 'free', day: 13,
    subject: () => 'A little push to go paid',
    html: () => wrap('Ready to scale it up?',
      `<p>If SplitLab's earned a spot in your stack, here's a nudge to upgrade — lock in more traffic, more AI, and your own domains, and keep every test tracking without limits.</p>`,
      b('Upgrade now', '/billing'), 'Upgrade your account') },
];

// ─── Series 2: Paid onboarding → engagement → retention ─────────────────────
const PAID: DripStep[] = [
  { key: 'paid.welcome', track: 'paid', day: 0,
    subject: (c) => `You're on ${c.planName} — here's your fast start`,
    html: (c) => wrap(`Welcome to ${c.planName}`,
      `<p>Welcome to ${c.planName}, ${c.firstName}. Three things get you value fastest: (1) launch a test, (2) connect a custom domain, (3) set your conversion goals.</p>`,
      b('Open your dashboard', '/dashboard'), 'Your fast start') },

  { key: 'paid.first_test', track: 'paid', day: 1, when: (c) => !c.hasActiveTest,
    subject: (c) => `Launch your first test on ${c.planName}`,
    html: () => wrap("Let's get a test live",
      `<p>Pick a page, add a variant (build one with AI in seconds), split the traffic, done. We assign visitors deterministically and track everything.</p>`,
      b('Create a test', '/dashboard'), 'Launch your first test') },

  { key: 'paid.custom_domain', track: 'paid', day: 3, when: (c) => !c.hasVerifiedDomain,
    subject: () => "Serve tests on your client's own domain",
    html: () => wrap('Run tests on the real domain',
      `<p>Tests run best on the real domain. Add a custom domain, drop in the DNS records we give you, and SplitLab serves your variants there — no visible redirects, full tracking.</p>`,
      b('Add a domain', '/domains'), "Serve on your client's domain") },

  { key: 'paid.goals_tracking', track: 'paid', day: 5,
    subject: () => 'Make sure conversions are actually tracked',
    html: () => wrap('Confirm your tracking',
      `<p>The #1 reason A/B data looks off: no conversion goal, or the tracker isn't firing. Set a goal (form submit, button click, or URL reached) and confirm the tracker is detected.</p>`,
      b('Set up goals', '/dashboard'), 'The #1 reason data looks off') },

  { key: 'paid.clarity', track: 'paid', day: 8,
    subject: () => 'See exactly how visitors use your page',
    html: () => wrap('Heatmaps + recordings, per variant',
      `<p>Connect Microsoft Clarity (free) once per client and SplitLab tags every session with the variant — so you get heatmaps and session recordings you can filter to Variant A vs B. It's the "why" behind your numbers.</p>`,
      b('Connect Clarity', '/dashboard'), 'Heatmaps and recordings') },

  { key: 'paid.integrations', track: 'paid', day: 11,
    subject: () => 'Push leads where you already work',
    html: () => wrap('Send leads anywhere',
      `<p>Send form leads into HubSpot, fire every lead to Zapier/Make/your CRM with a global webhook, or get an email on each submission. Set it once per client.</p>`,
      b('Open Integrations', '/dashboard'), 'HubSpot, Zapier, and more') },

  { key: 'paid.first_winner', track: 'paid', day: 14, when: (c) => c.hasActiveTest,
    subject: () => 'You might have a winner',
    html: () => wrap('Time to read your results',
      `<p>Your test has real traffic now. Check the confidence column — at 95%+ you can trust the winner and ship it. Peek at the desktop vs mobile split too; sometimes the winner only wins on one.</p>`,
      b('Check your results', '/dashboard'), 'You might have a winner') },

  { key: 'paid.speed', track: 'paid', day: 18,
    subject: () => 'Why a slow page quietly kills conversions',
    html: () => wrap('Speed is conversion',
      `<p>Every extra second of load costs ~7% of conversions. SplitLab grades each variant's speed (mobile and desktop) automatically — a red score is often the hidden reason a good-looking variant underperforms.</p>`,
      b('Check your speed scores', '/dashboard'), 'Slow pages kill conversions') },

  { key: 'paid.optimization_playbook', track: 'paid', day: 25,
    subject: () => 'How much should you actually be testing?',
    html: () => wrap('A quick optimization playbook',
      `<p>Low-traffic pages → test big, bold swings (hero, offer, CTA), one at a time, run longer. High-traffic pages → test more often and go granular. Aim for enough traffic to hit ~95% confidence within 2–4 weeks per test.</p>`,
      b('Read the playbook', '/resources'), 'How much to test') },

  { key: 'paid.benchmarks', track: 'paid', day: 35,
    subject: () => 'Is your conversion rate any good? Here\'s the benchmark',
    html: () => wrap('Where your numbers stand',
      `<p>Median landing-page conversion is ~6–7% across industries — from ~2–3% (e-commerce) to 10%+ (SaaS trials, lead gen). Here's where your numbers likely sit, and how much headroom testing can unlock.</p>`,
      b('See where you stand', '/resources'), 'Industry CVR benchmarks') },

  { key: 'paid.power_user', track: 'paid', day: 90,
    subject: () => "You're getting real value from SplitLab",
    html: (c) => wrap('90 days in',
      `<p>Ninety days of testing, ${c.firstName} — that's exactly how compounding CRO works. If SplitLab's earned it, a quick review or a referral goes a long way. And if there's something missing, just reply.</p>`,
      b('Refer a friend', '/affiliate'), "You're getting real value") },
];

export const DRIP_STEPS: DripStep[] = [...FREE, ...PAID];

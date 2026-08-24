import type { ReactNode } from 'react';

export interface Article {
  slug: string;
  title: string;         // <h1> + <title>
  description: string;   // meta description + list excerpt
  keywords: string[];
  category: string;
  datePublished: string; // YYYY-MM-DD
  dateModified: string;
  readMins: number;
  faqs?: { q: string; a: string }[];
  Body: () => ReactNode;
}

// ── Articles ────────────────────────────────────────────────────────────────
// Each is hand-written / edited (AI-drafted is fine — the bar is genuinely
// useful, not "undetectable"). Add real substance: examples, data, screenshots.

const howToAbTest: Article = {
  slug: 'how-to-ab-test-a-landing-page',
  title: 'How to A/B Test a Landing Page (Step-by-Step Guide)',
  description:
    'A practical, step-by-step guide to A/B testing a landing page: pick one goal, form a hypothesis, split traffic, run to statistical significance, and ship the winner.',
  keywords: ['how to a/b test a landing page', 'a/b testing', 'split testing', 'landing page optimization', 'conversion rate optimization'],
  category: 'Guides',
  datePublished: '2026-08-22',
  dateModified: '2026-08-22',
  readMins: 7,
  faqs: [
    { q: 'How long should you run an A/B test?', a: 'Run the test until you reach statistical significance (typically 95%+ confidence) and have covered at least one full business cycle — usually 1–2 weeks minimum — so weekday/weekend behavior is represented. Do not stop the moment a variant looks like it is winning; early leads often reverse.' },
    { q: 'How many visitors do you need for an A/B test?', a: 'It depends on your baseline conversion rate and the size of the improvement you want to detect. As a rough guide, detecting a small lift on a ~3% baseline can take a few thousand conversions per variant. Use a sample-size calculator before you start so you know the test can actually reach significance.' },
    { q: 'What should you A/B test first on a landing page?', a: 'Start with the highest-leverage elements: the headline, the primary call-to-action (copy and placement), the hero offer, and form length. These change conversion far more than colors or minor styling.' },
    { q: 'What is a good conversion rate for a landing page?', a: 'It varies widely by industry and traffic source, but many lead-gen landing pages convert in the 2–5% range and strong ones exceed 10%. The number that matters is your own trend line — whether each test moves it up.' },
  ],
  Body: () => (
    <>
      <p className="lead">
        A/B testing a landing page means showing two (or more) versions to different visitors at the same time and
        measuring which one converts better. Done right, it turns &ldquo;I think this headline is stronger&rdquo; into
        a decision backed by data. Here is the exact process.
      </p>

      <div className="callout">
        <strong>TL;DR:</strong> Pick one goal → form a clear hypothesis → change one meaningful thing → split traffic
        evenly → run until you hit statistical significance (95%+) and a full business cycle → ship the winner → repeat.
      </div>

      <h2>1. Choose one conversion goal</h2>
      <p>
        Every test needs a single primary metric: form submissions, button clicks, sign-ups, purchases, or a
        thank-you-page view. If you track five things and one moves, you will fool yourself. Pick the one that maps to
        revenue and make it the goal.
      </p>

      <h2>2. Form a hypothesis</h2>
      <p>
        A good hypothesis is specific and falsifiable: <em>&ldquo;Changing the headline from a feature statement to an
        outcome statement will increase demo requests, because visitors care about the result, not the mechanism.&rdquo;</em>
        This forces you to change something meaningful and gives you a reason to believe it will work.
      </p>

      <h2>3. Change one meaningful thing</h2>
      <p>
        Isolate the variable so you know <em>what</em> caused the change. The elements worth testing first, in order of
        impact:
      </p>
      <ul>
        <li><strong>Headline</strong> — the single biggest lever on most pages.</li>
        <li><strong>Primary CTA</strong> — the copy, and where it sits.</li>
        <li><strong>Hero offer / value proposition</strong>.</li>
        <li><strong>Form length</strong> — fewer fields usually means more submissions.</li>
        <li><strong>Social proof placement</strong> — testimonials, logos, numbers.</li>
      </ul>
      <p>Leave colors and button shades for later; they rarely move the needle compared to the above.</p>

      <h2>4. Split traffic evenly and randomly</h2>
      <p>
        Send 50/50 (or weighted) traffic to each variant, and make the assignment <em>sticky</em> so a returning visitor
        always sees the same version. Both variants must run <em>at the same time</em> — never &ldquo;this week vs. last
        week,&rdquo; because seasonality and traffic sources would contaminate the result.
      </p>

      <h2>5. Run to statistical significance</h2>
      <p>
        This is where most tests go wrong. A variant that is &ldquo;winning&rdquo; on day two is usually just noise.
        Keep running until:
      </p>
      <ul>
        <li>You reach <strong>95%+ statistical confidence</strong> (a chi-square test on conversions vs. unique visitors), and</li>
        <li>The test has run at least <strong>one full business cycle</strong> (typically 1–2 weeks), so weekday and weekend behavior are both represented.</li>
      </ul>
      <p>
        Decide the required sample size <em>before</em> you start — if your traffic can never reach it, the test cannot
        conclude, and you should test a bigger, bolder change instead of a subtle one.
      </p>

      <h2>6. Ship the winner (or learn from the loss)</h2>
      <p>
        If a variant wins with confidence, roll it out to 100% of traffic. If it loses or ties, that is still a result:
        you learned that lever does not matter for this audience. Either way you now know more than you did.
      </p>

      <h2>7. Repeat — testing is a program, not an event</h2>
      <p>
        The compounding gains come from a steady cadence: one test after another, each building on the last. Teams that
        test continuously pull far ahead of teams that run one test a quarter.
      </p>

      <h2>Common mistakes to avoid</h2>
      <ul>
        <li><strong>Stopping early.</strong> Calling a winner before significance is the #1 error.</li>
        <li><strong>Changing several things at once.</strong> You will not know what worked.</li>
        <li><strong>Testing tiny changes on low traffic.</strong> You will never reach significance.</li>
        <li><strong>Ignoring segments.</strong> A variant can win on mobile and lose on desktop — check both.</li>
        <li><strong>Not running long enough.</strong> Always cover a full business cycle.</li>
      </ul>

      <h2>Doing this in SplitLab</h2>
      <p>
        SplitLab handles the mechanics of the above automatically: it splits traffic deterministically by weight on your
        own custom domain, keeps assignments sticky per visitor, tracks pageviews and conversions, and calculates
        statistical significance for you so you know exactly when you have a winner. You can even build the challenger
        variant with AI and publish it as a test in a few minutes.
      </p>
      <p>
        <a href="/signup">Start your first A/B test free →</a>
      </p>
    </>
  ),
};

export const ARTICLES: Article[] = [howToAbTest];

/** Lightweight list (no Body) — safe to import into client components / nav. */
export const ARTICLE_LINKS = ARTICLES.map((a) => ({ slug: a.slug, title: a.title, category: a.category }));

export function getArticle(slug: string): Article | undefined {
  return ARTICLES.find((a) => a.slug === slug);
}

import type { Skill } from './types';
import { findCtas, heroRegion, stripCode } from './check-utils';

/**
 * Distilled from the client's own `landing-page-generator` skill (his
 * favourite — the name is kept identical on purpose so he recognises it).
 *
 * Roughly 60% of that file is already in our base build prompt (section
 * library, hierarchy rules, mobile rules, style options). Only the missing 40%
 * is below: framework-driven section ORDER, risk reversal under CTAs, message
 * match to the traffic source, and the SEO extras we never emitted.
 *
 * Mandatory: this is the definition of "a landing page" for this product, not
 * an optional flavour.
 */

const RISK_REVERSAL_PATTERNS =
  /(no credit card|cancel any\s?time|money[- ]back|free for \d|free trial|no obligation|no commitment|no spam|unsubscribe any\s?time|\d+[- ]day guarantee|risk[- ]free|set up in \d)/i;

export const landingPageGenerator: Skill = {
  id: 'landing_page_generator',
  name: 'Landing Page Generator',
  description:
    'Conversion structure: a copy framework chosen from audience awareness, section order that follows it, risk reversal under every CTA, and message match to the traffic source.',
  useFor: 'Every landing page — lead capture, campaign, demo request, sale.',
  notFor: 'Nothing. It is always on.',
  mandatory: true,

  generateBlock: `## Copy framework and section order (mandatory)
Pick ONE copy framework from the audience's awareness level, then let the section order follow it. State the chosen framework in the schema as "copy_framework".

| Framework | Choose when | Awareness |
|---|---|---|
| PAS (Problem > Agitate > Solve) | They already feel the problem | Problem-aware |
| AIDA (Attention > Interest > Desire > Action) | They need educating first | Unaware |
| BAB (Before > After > Bridge) | They want the transformation, not the explanation | Solution-aware |

Default section order when the brief does not dictate one — drop any section the brief has no real content for rather than padding it:
hero > social proof bar > problem > solution/benefits > how it works > features > testimonials > pricing > FAQ > final CTA.
PAS front-loads the problem section. AIDA front-loads a proof/interest section before the problem. BAB replaces the problem section with a before/after contrast.

## Message match
If the brief names a traffic source (a specific ad, an email, a campaign, a keyword), the H1 must mirror that source's wording. A visitor arriving from "cut payroll admin in half" must read those words, not a synonym.

## Risk reversal
Every CTA gets one short supporting line directly under it that removes friction — "No credit card required", "Cancel anytime", "Free for 14 days", "Set up in 2 minutes". Put it on the hero CTA and the final CTA at minimum, as a "cta_note" field on the section. NEVER invent a guarantee, a trial length, a price or a customer count the brief did not give you — if you have no true friction-remover, omit the line entirely.

## One page, one goal
Every CTA on the page points at the SAME conversion action. Secondary links (phone, legal, an anchor to a section further down) are fine; a second competing offer is not.`,

  buildBlock: `## Conversion structure (mandatory)
- Follow the schema's "copy_framework" if present — the section order and the copy's emotional arc come from it, not from a default template.
- A CTA must appear inside the hero block, and again at the end of the page. Repeat it mid-page on any page longer than about five sections.
- CTA labels are [action verb] + [what they get] — "Start my free trial", "Get the pricing sheet". Never "Submit", never "Learn more" as the primary button.
- Under the hero CTA and the final CTA, render the schema's "cta_note" (or an equivalent true friction-remover already present in the schema) as a small line of supporting text. If the schema has none, render nothing — do not write one yourself.
- Every CTA resolves to the same conversion target.

## SEO extras (mandatory)
- Every <img> carries meaningful alt text describing the image's content, not the filename.
- A <link rel="canonical"> in the <head>.
- If the page has an FAQ section, emit matching FAQPage JSON-LD in a <script type="application/ld+json"> block. Google retired FAQ rich results on 7 May 2026, so this no longer earns a search-result feature — it stays because it is still valid schema, AI search engines and other crawlers still read it, and it costs nothing. Structured data is not executable page logic and is the one script tag allowed.
- The <title> stays 50-60 characters and the meta description 150-160, benefit first.`,

  checks: [
    {
      id: 'cta_present',
      label: 'Page has a call to action',
      run: (html) => {
        const ctas = findCtas(html);
        if (ctas.length === 0) return { passed: false, detail: 'No call-to-action button or link found.' };
        return { passed: true, detail: `${ctas.length} call-to-action${ctas.length === 1 ? '' : 's'} on the page.` };
      },
    },
    {
      id: 'cta_in_hero',
      label: 'CTA in the hero block (approximate — not pixel-measured)',
      run: (html) => {
        const ctas = findCtas(html);
        if (ctas.length === 0) return null;
        const { start, end } = heroRegion(html);
        const inHero = ctas.filter((c) => c.index >= start && c.index < end);
        return inHero.length > 0
          ? { passed: true, detail: `"${inHero[0].text}" sits in the first section of the page.` }
          : { passed: false, detail: 'The first CTA appears after the opening section.' };
      },
    },
    {
      id: 'cta_repeated',
      label: 'CTA repeated further down the page',
      run: (html) => {
        const ctas = findCtas(html);
        if (ctas.length === 0) return null;
        const { end } = heroRegion(html);
        const below = ctas.filter((c) => c.index >= end);
        return below.length > 0
          ? { passed: true, detail: `${below.length} more CTA${below.length === 1 ? '' : 's'} below the opening section.` }
          : { passed: false, detail: 'The only CTA is in the opening section — nothing catches a visitor who scrolls.' };
      },
    },
    {
      id: 'risk_reversal',
      label: 'Risk-reversal line near a CTA',
      run: (html) => {
        const ctas = findCtas(html);
        if (ctas.length === 0) return null;
        const text = stripCode(html).replace(/<[^>]*>/g, ' ');
        const match = RISK_REVERSAL_PATTERNS.exec(text);
        return match
          ? { passed: true, detail: `Friction-remover present: "${match[0]}".` }
          : {
              passed: false,
              detail: 'No risk-reversal line found (this is correct when the brief gave no true guarantee to state).',
            };
      },
    },
    {
      id: 'image_alt_text',
      label: 'Every image has alt text',
      run: (html) => {
        const imgs = Array.from(html.matchAll(/<img\b([^>]*)>/gi)).map((m) => m[1] ?? '');
        if (imgs.length === 0) return null;
        const missing = imgs.filter((a) => !/\balt\s*=\s*["'][^"']+["']/i.test(a)).length;
        return missing === 0
          ? {
              passed: true,
              detail:
                imgs.length === 1
                  ? 'The page\'s one image has alt text.'
                  : `All ${imgs.length} images have alt text.`,
            }
          : { passed: false, detail: `${missing} of ${imgs.length} images have no alt text.` };
      },
    },
    {
      id: 'single_h1',
      label: 'Exactly one H1',
      run: (html) => {
        const count = stripCode(html).match(/<h1\b/gi)?.length ?? 0;
        if (count === 1) return { passed: true, detail: 'One H1, as it should be.' };
        return { passed: false, detail: count === 0 ? 'No H1 on the page.' : `${count} H1 tags — search engines expect one.` };
      },
    },
  ],
};

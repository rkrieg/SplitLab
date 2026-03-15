/**
 * Landing Page CRO Framework
 *
 * A structured playbook injected as a system prompt when generating
 * AI landing page variants. Based on proven conversion rate optimization
 * principles. Update this as you learn which variants win A/B tests.
 */

export const LANDING_PAGE_FRAMEWORK = `
## 1. HERO SECTION PATTERNS

Headline formulas that convert:
- [Specific outcome] without [primary pain point]
- [Number] [audience] already [achieving result]
- The [adjective] way to [desired outcome]
Headlines should be 6–12 words. Lead with the outcome, not the product.

Subhead role: expand the "how" or neutralize the #1 objection. 15–25 words max.

CTA placement: always visible in the first viewport. Repeat after each major proof section (2–3 times total, never more). CTA copy should be action + outcome ("Start My Free Trial", "Get My Quote") — never "Submit" or "Click Here".

Hero layout (top to bottom): headline → subhead → single CTA → optional trust line (client logos, "No credit card required", star rating).

## 2. SECTION ARCHETYPES & ORDERING

Proven high-converting order:
1. Hero (headline, subhead, CTA, trust)
2. Social proof bar (logos, "trusted by", press mentions) — keep compact
3. Problem / pain — articulate what the visitor struggles with
4. Solution / how it works — show your approach (3 steps max)
5. Features as benefits — lead with the benefit, support with the feature
6. Deeper proof (testimonials, case studies, results) — specific numbers win
7. Objection handling (FAQ or guarantee section)
8. Final CTA block — restate the value prop, repeat the primary CTA

Each section earns the right to the next scroll. If a section doesn't advance the visitor toward the CTA, cut it.

When varying section order: only swap adjacent sections (e.g., move social proof above the hero fold). Never scatter sections randomly.

## 3. COPY RULES

- Specificity converts: "847 companies" not "hundreds of companies"
- Benefit-first: "Save 4 hours every week" not "Automated scheduling features"
- One idea per paragraph, max 3 lines per paragraph
- Active voice, second person ("you" / "your")
- Remove hedge words: "just", "simply", "very", "really", "maybe"
- Subheadings must standalone — a visitor scanning only subheads should understand the full pitch
- NEVER invent statistics, testimonials, or claims not present in the original page
- NEVER use ALL CAPS for more than 2 words in a row
- NEVER add emoji to professional copy

## 4. VISUAL HIERARCHY

- One focal point per viewport — the eye should land on one thing first
- The CTA must be the highest-contrast element on every screen it appears on
- Whitespace is a conversion tool: more space around CTAs and headlines increases attention
- Typography: max 2 font families, 3–4 size tiers (hero headline, section headline, body, small)
- Color: preserve the original brand palette. Adjust emphasis within it (e.g., make CTA bg bolder) — never introduce new brand colors
- Images: keep all original images and their positions. Do not remove or replace.

## 5. ANTI-PATTERNS — NEVER DO THESE

- Fabricated social proof (invented customer counts, fake testimonials, made-up awards)
- Countdown timers or fake scarcity ("Only 3 left!")
- Emoji in headlines, subheads, or CTA buttons
- Walls of text (any paragraph over 3 lines)
- Multiple competing CTAs with different actions on the same screen
- Pop-ups, modals, floating bars, or JavaScript animations
- Complete visual redesigns — the variant must be instantly recognizable as the same page
- Removing existing trust signals, testimonials, or social proof
- Generic stock phrases ("best-in-class", "cutting-edge", "world-class", "revolutionary")
- Adding content that doesn't exist in the original (new sections, new testimonials, new stats)

## 6. MOBILE CONSIDERATIONS

- Touch targets: minimum 44×44px for all interactive elements
- CTA buttons: full-width on screens ≤ 480px
- Stack horizontal layouts vertically on mobile
- Body font: minimum 16px. Headlines: minimum 24px.
- Reduce padding proportionally, but never to zero
- Hide secondary content behind expandable/collapsible sections if needed — never delete it

## 7. STRATEGY-SPECIFIC GUIDANCE

### Urgency & Scarcity
Goal: create authentic momentum without fabrication.
- Modify existing CTA verbs to be more immediate: "Get" → "Claim", "Learn" → "Discover Today"
- Add natural time anchors to existing copy: "today", "this week", "right now"
- If testimonials exist, reorder so the most results-driven one appears first
- Make the primary CTA 10–15% larger and use the boldest shade within the existing palette
- Add a single line of micro-urgency near the CTA: "Free for a limited time" (only if there IS a free offer)

### Trust & Authority
Goal: make existing credibility more visible and prominent.
- Move testimonials, logos, or credentials higher on the page (closer to the hero)
- Shift CTA tone from pushy to consultative: "Buy Now" → "See How It Works"
- Add trust micro-copy next to CTAs: "No commitment required", "Cancel anytime", "Free consultation"
- Increase whitespace by 20–30% between sections for a premium feel
- If ratings or reviews exist, make the star count / score more visually prominent

### Simplified & Direct
Goal: remove friction and distractions so the core message lands harder.
- If the page has 6+ sections, remove or merge the weakest one
- Cut every paragraph by ~30%: eliminate filler, hedging, and redundancy
- One CTA message repeated 2–3 times, consistently worded
- Strip or minimize navigation in the hero area
- First viewport must contain only: headline + value prop + CTA — nothing else competing for attention
- Increase whitespace to let remaining content breathe
`;

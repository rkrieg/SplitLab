/**
 * Hardcoded section pattern library for AI page generation.
 *
 * Consumed by the `/api/pages/generate` system prompt — the full list below is
 * listed directly in the prompt as available moves (not mandatory slots), so the
 * model can pick a varied combination per page instead of defaulting to the same
 * ~7 sections every time. See docs/decisions/ai-page-generation-quality.md.
 *
 * This is a closed, hand-curated list — not a knowledge base. Add new patterns
 * here as code, reviewed like any other prompt change.
 */

export interface SectionPattern {
  type: string;
  description: string;
  whenToUse: string;
  /** One-line JSON shape shown to Claude, matching the existing prompt convention. */
  schemaExample: string;
}

export const SECTION_VOCABULARY: SectionPattern[] = [
  {
    type: 'benefits',
    description: 'Outcome-oriented value props — what the customer gets, not what the product does.',
    whenToUse: 'Almost every page. The default workhorse section after the hero.',
    schemaExample: '{ "type": "benefits", "headline": "...", "items": ["...", "..."] }',
  },
  {
    type: 'feature_grid',
    description: 'Icon + short text grid describing concrete product features or capabilities.',
    whenToUse: 'SaaS/product pages where the audience cares about specific functionality, not just outcomes.',
    schemaExample: '{ "type": "feature_grid", "headline": "...", "features": [{ "icon": "...", "title": "...", "description": "..." }] }',
  },
  {
    type: 'social_proof',
    description: 'Customer testimonials with name/quote.',
    whenToUse: 'Almost every page, once there is at least implied customer history.',
    schemaExample: '{ "type": "social_proof", "headline": "...", "testimonials": [{ "name": "...", "quote": "...", "image_prompt": "professional headshot, [gender/ethnicity], warm smile, neutral background, professional photography, high resolution", "image_placement": "card" }] }',
  },
  {
    type: 'case_study',
    description: 'A single in-depth customer story — problem, what they did, the result — deeper than a testimonial quote.',
    whenToUse: 'B2B/SaaS pages where one strong, specific result is more convincing than several short quotes.',
    schemaExample: '{ "type": "case_study", "headline": "...", "customer": "...", "problem": "...", "result": "...", "metric": "..." }',
  },
  {
    type: 'logo_wall',
    description: '"Trusted by" strip of client/customer logos.',
    whenToUse: 'When credibility-by-association matters more than specifics — common right under the hero.',
    schemaExample: '{ "type": "logo_wall", "headline": "...", "logos": ["...", "..."] }',
  },
  {
    type: 'press_mentions',
    description: '"As seen in" media outlet logos, distinct from customer logos.',
    whenToUse: 'When the business has press coverage worth surfacing for credibility.',
    schemaExample: '{ "type": "press_mentions", "outlets": ["...", "..."] }',
  },
  {
    type: 'stats',
    description: 'Big-number metrics bar (customers served, uptime, years in business, etc.).',
    whenToUse: 'When the business has concrete numbers that signal scale or reliability.',
    schemaExample: '{ "type": "stats", "items": [{ "number": "...", "label": "..." }] }',
  },
  {
    type: 'problem_solution',
    description: 'Names the visitor\'s pain point first, agitates it briefly, then introduces the product as the fix. Goes before benefits, not after.',
    whenToUse: 'When the prompt implies a clear pain point the audience already feels (vs. a feature-led pitch).',
    schemaExample: '{ "type": "problem_solution", "problem_headline": "...", "problem_body": "...", "solution_headline": "...", "solution_body": "..." }',
  },
  {
    type: 'before_after',
    description: 'Visual or narrative contrast between life/results before and after using the product.',
    whenToUse: 'Local services, transformation-driven offers (fitness, home services, beauty, coaching).',
    schemaExample: '{ "type": "before_after", "headline": "...", "before": "...", "after": "..." }',
  },
  {
    type: 'process_steps',
    description: 'Numbered "how it works" steps.',
    whenToUse: 'When the offer involves a process the visitor needs to understand before converting (onboarding, service delivery, signup flow).',
    schemaExample: '{ "type": "process_steps", "headline": "...", "steps": [{ "number": 1, "title": "...", "description": "..." }] }',
  },
  {
    type: 'comparison',
    description: 'Feature comparison table — us vs. alternatives, or tier vs. tier. Distinct from pricing, which lists tiers without a head-to-head frame.',
    whenToUse: 'When the prompt mentions competitors, switching, or "why us" framing.',
    schemaExample: '{ "type": "comparison", "headline": "...", "rows": [{ "feature": "...", "us": true, "them": false }] }',
  },
  {
    type: 'pricing',
    description: 'Pricing tiers with features.',
    whenToUse: 'SaaS and most lead_gen offers with transparent pricing.',
    schemaExample: '{ "type": "pricing", "headline": "...", "tiers": [{ "name": "...", "price": "...", "features": ["..."] }] }',
  },
  {
    type: 'guarantee',
    description: 'Risk-reversal block — money-back guarantee, free trial terms, no-commitment language.',
    whenToUse: 'When price or commitment is a likely objection.',
    schemaExample: '{ "type": "guarantee", "headline": "...", "body": "..." }',
  },
  {
    type: 'urgency_banner',
    description: 'Scarcity or time-limited offer strip.',
    whenToUse: 'Only when the prompt explicitly implies a real promotion or limited availability — never fabricate fake urgency.',
    schemaExample: '{ "type": "urgency_banner", "text": "...", "cta_text": "..." }',
  },
  {
    type: 'integrations',
    description: 'Grid of tools/platforms the product connects with.',
    whenToUse: 'SaaS pages where ecosystem fit is a selling point.',
    schemaExample: '{ "type": "integrations", "headline": "...", "tools": ["...", "..."] }',
  },
  {
    type: 'gallery',
    description: 'Image/portfolio grid.',
    whenToUse: 'Local services, agencies, ecommerce — anything where visual proof of work matters more than text.',
    schemaExample: '{ "type": "gallery", "headline": "...", "images": [{ "image_prompt": "..., professional photography, high resolution", "image_placement": "card" }] }',
  },
  {
    type: 'team',
    description: 'Team member bios with name/role/short bio.',
    whenToUse: 'Service businesses, agencies, local businesses where the people are part of the trust signal.',
    schemaExample: '{ "type": "team", "headline": "...", "members": [{ "name": "...", "role": "...", "bio": "...", "image_prompt": "professional headshot, [description], professional photography, high resolution", "image_placement": "card" }] }',
  },
  {
    type: 'video',
    description: 'Video embed with caption — demo, explainer, or testimonial video.',
    whenToUse: 'When the prompt mentions a demo or the offer benefits from a walkthrough.',
    schemaExample: '{ "type": "video", "headline": "...", "video_url": null, "caption": "..." }',
  },
  {
    type: 'faq',
    description: 'Frequently asked questions, accordion-style.',
    whenToUse: 'Almost every page, near the bottom, to handle remaining objections.',
    schemaExample: '{ "type": "faq", "headline": "...", "items": [{ "q": "...", "a": "..." }] }',
  },
  {
    type: 'map_location',
    description: 'Address/map block for a physical location.',
    whenToUse: 'local vertical only — businesses with a physical premise customers visit.',
    schemaExample: '{ "type": "map_location", "address": "...", "hours": "...", "map_embed_url": null }',
  },
  {
    type: 'newsletter_signup',
    description: 'Lightweight single-field email capture, distinct from the full lead `form` section.',
    whenToUse: 'Content/media-driven pages, or as a secondary low-commitment CTA alongside a primary form.',
    schemaExample: '{ "type": "newsletter_signup", "headline": "...", "submit_text": "..." }',
  },
  {
    type: 'form',
    description: 'Full lead capture form.',
    whenToUse: 'lead_gen and local verticals — the primary conversion mechanism.',
    schemaExample: '{ "type": "form", "headline": "...", "fields": ["name", "email", "phone"], "submit_text": "..." }',
  },
  {
    type: 'cta_banner',
    description: 'Standalone, full-width mid-page call-to-action — a visual break before the footer.',
    whenToUse: 'Longer pages that need a second conversion point before the user reaches the footer.',
    schemaExample: '{ "type": "cta_banner", "headline": "...", "cta_text": "...", "cta_url": "#" }',
  },
  {
    type: 'product_showcase',
    description: 'Grid of sellable products — image, name, price, short CTA per item.',
    whenToUse: 'ecommerce — the product-equivalent of feature_grid, but items carry a price and a buy/add-to-cart style CTA.',
    schemaExample: '{ "type": "product_showcase", "headline": "...", "products": [{ "name": "...", "price": "...", "image": null, "cta_text": "...", "image_prompt": "product photo of [product name], clean white background, professional product photography, high resolution", "image_placement": "card" }] }',
  },
  {
    type: 'reviews_ratings',
    description: 'Aggregate star rating plus short reviews, distinct from generic testimonial quotes — reviewer name, star count, optionally a verified-buyer badge.',
    whenToUse: 'ecommerce — shoppers expect star ratings and review counts, not just quotes.',
    schemaExample: '{ "type": "reviews_ratings", "average_rating": 4.8, "review_count": 0, "reviews": [{ "name": "...", "stars": 5, "quote": "...", "image_prompt": "professional headshot, [gender/age], warm smile, neutral background, professional photography, high resolution", "image_placement": "card" }] }',
  },
  {
    type: 'shipping_trust',
    description: 'Row of e-commerce-specific trust icons — free shipping threshold, returns policy, secure checkout, payment methods accepted.',
    whenToUse: 'ecommerce — these specific objections (shipping cost, return risk, payment safety) are unique to buying physical goods online.',
    schemaExample: '{ "type": "shipping_trust", "items": [{ "icon": "...", "label": "..." }] }',
  },
  {
    type: 'ugc_gallery',
    description: 'Customer photo grid — real people using/wearing/displaying the product, distinct from a generic portfolio gallery.',
    whenToUse: 'ecommerce brands where social proof through real customer photos matters (apparel, beauty, home goods).',
    schemaExample: '{ "type": "ugc_gallery", "headline": "...", "images": [{ "image_prompt": "real customer using/wearing [product], candid lifestyle photo, natural light, professional photography, high resolution", "image_placement": "card" }] }',
  },
  {
    type: 'bundle_offer',
    description: '"Buy more, save more" bundle or multi-pack deal block.',
    whenToUse: 'ecommerce — when the prompt implies bundles, multi-packs, or volume discounts.',
    schemaExample: '{ "type": "bundle_offer", "headline": "...", "bundles": [{ "name": "...", "price": "...", "savings": "..." }] }',
  },
  {
    type: 'countdown_timer',
    description: 'Live-feeling countdown for a flash sale or limited drop — more concrete than the static text in urgency_banner.',
    whenToUse: 'ecommerce flash sales or time-boxed promotions explicitly implied by the prompt — never fabricate a fake countdown.',
    schemaExample: '{ "type": "countdown_timer", "headline": "...", "ends_at": null, "cta_text": "..." }',
  },
];

/**
 * Per-vertical bias — which patterns to reach for first. Short hints only, not
 * full prompts. Add a new entry here when a new vertical is introduced; no
 * other prompt changes required.
 */
export const VERTICAL_PRIORITY_HINTS: Record<string, string> = {
  lead_gen: 'Favor: problem_solution, benefits, social_proof, urgency_banner (only if real), form, faq.',
  saas: 'Favor: benefits, feature_grid, integrations, comparison, pricing, case_study, faq.',
  local: 'Favor: hero with strong local trust signal, before_after, gallery, team, map_location, form.',
  ecommerce: 'Favor: product_showcase, reviews_ratings, ugc_gallery, shipping_trust, bundle_offer, countdown_timer (only if a real promotion is implied), faq.',
  real_estate: 'Favor: gallery, stats (listings sold/avg. days on market), social_proof, team, map_location, form.',
  healthcare_wellness: 'Favor: benefits, process_steps, team, social_proof, guarantee, faq, form. Keep claims modest and avoid medical guarantees the business can\'t back.',
  legal: 'Favor: problem_solution, case_study, stats, team, faq, guarantee, form. Tone should read credible and measured, not hard-sell.',
  financial_services: 'Favor: stats, comparison, security/trust signals via guarantee, social_proof, faq, form.',
  education_coaching: 'Favor: process_steps, social_proof, case_study, pricing, faq, form.',
  events_webinars: 'Favor: hero with a clear date/time, process_steps (agenda), social_proof, team, countdown_timer (only if a real date is given), form.',
  hospitality_travel: 'Favor: gallery, social_proof, before_after, stats, faq, form.',
  fitness_beauty: 'Favor: before_after, social_proof, process_steps, pricing, gallery, guarantee, form.',
  sales_info_product: 'Favor: problem_solution, benefits, social_proof, comparison, guarantee, urgency_banner (only if real), pricing, faq, form.',
  nonprofit: 'Favor: problem_solution, stats (impact numbers), social_proof (stories), team, newsletter_signup, form.',
  other: 'No vertical bias — infer entirely from the specific business described in the prompt, and pick freely from the full section vocabulary based on what this business actually needs.',
};

import type { Vertical, BrandSettings, UnsplashImage } from '@/types/page-builder';

interface PromptInput {
  userPrompt: string;
  vertical: Vertical;
  brandSettings?: BrandSettings;
  imageUrls?: UnsplashImage[];
  performanceInsights?: string;
}

const VERTICAL_TEMPLATES: Record<Vertical, string> = {
  legal: `## Vertical: Legal Services

### Section Structure (in order)
1. **Hero**: Bold headline with primary legal service, trust badge area, primary CTA
2. **Problem/Pain**: Address the visitor's legal pain point (injury, arrest, dispute)
3. **Services**: 3-4 practice area cards with icons
4. **Social Proof**: Case results (dollar amounts), client testimonials with first name + last initial
5. **Attorney Profile**: Photo placeholder, credentials, bar admissions, years of experience
6. **Process**: 3-step "How It Works" (Free Consultation → Case Review → We Fight For You)
7. **FAQ**: 4-5 common questions
8. **CTA Section**: "Free Consultation" form (name, phone, email, brief description) + phone number prominently displayed

### CRO Elements
- "No Fee Unless We Win" badge
- Case result numbers ($X recovered)
- "Available 24/7" indicator
- Trust badges: Super Lawyers, Avvo, Bar Association

### Compliance
- Include disclaimer: "The information on this website is for general information purposes only. Nothing on this site should be taken as legal advice for any individual case or situation."
- "Past results do not guarantee future outcomes"
- "Attorney Advertising"`,

  real_estate_financial: `## Vertical: Real Estate / Financial Services

### Section Structure (in order)
1. **Hero**: Property/service headline with location emphasis, search or lead form
2. **Value Proposition**: 3 key benefits with icons (e.g., "Close Faster", "Best Rates", "Local Expert")
3. **Listings/Services**: Featured properties or service cards (use image placeholders)
4. **Market Stats**: Local market data section with large numbers
5. **Testimonials**: Client success stories with property photos or headshots
6. **Process**: Steps to buy/sell/apply (3-4 step visual flow)
7. **About**: Agent/company credentials, transaction volume, years in market
8. **CTA Section**: Lead capture form (name, email, phone, property type dropdown) + "Get Pre-Approved" or "Schedule Viewing"

### CRO Elements
- Urgency indicators ("X homes sold this month")
- Market statistics with large, bold numbers
- "Pre-Approved in Minutes" type messaging
- Neighborhood/area expertise signals

### Compliance
- "Equal Housing Opportunity" logo reference
- NMLS number placeholder if mortgage-related
- "Licensed Real Estate Professional" notation`,

  saas: `## Vertical: SaaS / Technology

### Section Structure (in order)
1. **Hero**: Product headline + subheadline, hero image/screenshot placeholder, primary CTA + secondary CTA
2. **Social Proof Bar**: Logo row of customer companies (use placeholder text like "Trusted by 500+ companies")
3. **Features**: 3-4 feature blocks with icons and benefit-oriented descriptions
4. **How It Works**: 3-step visual flow showing the product journey
5. **Testimonials**: 2-3 customer quotes with name, title, company
6. **Pricing/CTA**: Pricing tease or "Start Free Trial" section
7. **FAQ**: 4-5 common objections answered
8. **Final CTA**: Full-width section with strong closing CTA

### CRO Elements
- "No credit card required" messaging
- Free trial emphasis
- Customer count or usage metrics
- Integration logos or "Works with..." section
- Speed/performance claims with specific numbers

### Compliance
- Privacy policy link in footer
- "Terms of Service" link`,

  local_services: `## Vertical: Local Services (Plumbing, HVAC, Cleaning, etc.)

### Section Structure (in order)
1. **Hero**: Service + location headline ("Expert Plumbing in [City]"), phone number prominently displayed, emergency CTA
2. **Trust Bar**: Licensed, Bonded, Insured badges + years in business + review rating
3. **Services**: 4-6 service cards with icons
4. **Why Choose Us**: 3-4 differentiators (24/7 availability, upfront pricing, satisfaction guarantee)
5. **Reviews**: Google/Yelp-style review cards with star ratings
6. **Service Area**: List of cities/neighborhoods served
7. **About**: Company story, team photo placeholder, license numbers
8. **CTA Section**: "Request a Quote" form (name, phone, service needed dropdown, preferred time) + click-to-call button

### CRO Elements
- Click-to-call phone number (large, repeated)
- "Same Day Service" or "Emergency Available" badges
- Star rating display (4.8/5.0 from X reviews)
- "Upfront Pricing - No Hidden Fees" guarantee
- Service area map reference

### Compliance
- License number display
- "Licensed, Bonded & Insured" statement
- Service area limitations noted`,
};

const BASE_SYSTEM_PROMPT = `You are an expert landing page designer and CRO (Conversion Rate Optimization) specialist. You generate complete, production-ready HTML landing pages optimized for converting ad traffic.

## OUTPUT REQUIREMENTS

1. Output a COMPLETE \`<!DOCTYPE html>\` document with ALL CSS in a single \`<style>\` block in the \`<head>\` — no external CSS files
2. Use Google Fonts via \`<link>\` tags only (no other external dependencies)
3. Add \`data-sl-section="hero|features|testimonials|cta|process|faq|about|services|stats|pricing|footer"\` on each major \`<section>\`
4. Add \`data-sl-editable="true"\` on ALL text elements (headings, paragraphs, list items, button text, spans with text)
5. Responsive design with breakpoints at 768px and 480px
6. NO navigation menu — keep the visitor focused on conversion
7. Include a sticky/fixed CTA element (floating button or bar) for mobile
8. Use semantic HTML5 elements
9. All images use placeholder URLs from the provided image list, with descriptive alt text
10. Include a \`<meta name="viewport" content="width=device-width, initial-scale=1.0">\` tag
11. Keep total HTML under 150KB

## DESIGN PRINCIPLES

- Above-the-fold must contain: headline, value proposition, and primary CTA
- Use high contrast for CTAs (bright color on dark or vice versa)
- White space is important — don't overcrowd sections
- Use a consistent 2-3 color palette throughout
- Typography hierarchy: large headlines, medium subheads, readable body text
- Mobile-first thinking: touch-friendly buttons (min 44px tap targets)
- Form fields should have clear labels and be easy to fill on mobile

## COPY PRINCIPLES

- Lead with the visitor's problem or desired outcome, not the company
- Use specific numbers and results where appropriate
- CTA buttons should be action-oriented and specific (not just "Submit")
- Keep paragraphs short (2-3 sentences max)
- Use bullet points for scannable content`;

export function buildPageGenerationPrompt(input: PromptInput): { system: string; user: string } {
  const { userPrompt, vertical, brandSettings, imageUrls, performanceInsights } = input;

  let system = BASE_SYSTEM_PROMPT;
  system += '\n\n' + VERTICAL_TEMPLATES[vertical];

  if (performanceInsights) {
    system += `\n\n## PERFORMANCE INSIGHTS FROM PAST PAGES\n${performanceInsights}`;
  }

  let user = `## PAGE REQUEST\n\n${userPrompt}`;

  if (brandSettings) {
    user += '\n\n## BRAND SETTINGS\n';
    if (brandSettings.company_name) user += `- Company Name: ${brandSettings.company_name}\n`;
    if (brandSettings.primary_color) user += `- Primary Color: ${brandSettings.primary_color}\n`;
    if (brandSettings.secondary_color) user += `- Secondary Color: ${brandSettings.secondary_color}\n`;
    if (brandSettings.logo_url) user += `- Logo URL: ${brandSettings.logo_url}\n`;
    if (brandSettings.phone) user += `- Phone: ${brandSettings.phone}\n`;
    if (brandSettings.tone) user += `- Tone: ${brandSettings.tone}\n`;
  }

  if (imageUrls && imageUrls.length > 0) {
    user += '\n\n## AVAILABLE IMAGES\nUse these Unsplash image URLs in the page:\n';
    imageUrls.forEach((img, i) => {
      user += `${i + 1}. URL: ${img.url}\n   Alt: ${img.alt}\n   Credit: ${img.credit}\n`;
    });
  }

  user += '\n\nGenerate the complete HTML page now. Output ONLY the HTML — no markdown code fences, no explanation.';

  return { system, user };
}

import type { Vertical, BrandSettings, UnsplashImage } from '@/types/page-builder';

interface PromptInput {
  userPrompt: string;
  vertical: Vertical;
  customVertical?: string;
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

  healthcare: `## Vertical: Healthcare / Medical

### Section Structure (in order)
1. **Hero**: Headline addressing patient need, primary CTA ("Book Appointment" or "Call Now")
2. **Services**: 3-6 service/specialty cards with icons
3. **Why Choose Us**: Board certifications, years of experience, patient-first approach
4. **Testimonials**: Patient reviews (first name only for privacy)
5. **Providers**: Doctor/provider profiles with credentials
6. **Insurance**: "We accept most major insurance plans" section
7. **CTA Section**: Appointment request form (name, phone, email, preferred date, reason for visit)

### CRO Elements
- "Accepting New Patients" badge
- Same-day/next-day appointment availability
- Star ratings from Google/Healthgrades
- Board certification badges

### Compliance
- "This website does not provide medical advice" disclaimer
- HIPAA notice for contact forms
- "Results may vary" for any treatment claims`,

  ecommerce: `## Vertical: E-Commerce / Retail

### Section Structure (in order)
1. **Hero**: Product/brand hero with strong value proposition and primary CTA ("Shop Now")
2. **Social Proof Bar**: "As seen in..." or customer count
3. **Featured Products**: 3-4 product showcase cards with prices
4. **Benefits**: Why buy from us (free shipping, returns, quality guarantee)
5. **Testimonials**: Customer reviews with star ratings and product photos
6. **How It Works**: Order process or subscription flow
7. **FAQ**: Shipping, returns, sizing questions
8. **CTA Section**: Email signup for discount or "Shop Now" with urgency

### CRO Elements
- Limited-time offer or discount code banner
- Free shipping threshold badge
- Money-back guarantee
- "X customers served" social proof

### Compliance
- Return/refund policy link
- Privacy policy link
- Terms of service link`,

  education: `## Vertical: Education / Online Courses

### Section Structure (in order)
1. **Hero**: Transformation-focused headline ("Become a..."), primary CTA ("Enroll Now" or "Start Free")
2. **Problem/Solution**: Address career pain point → your course solves it
3. **Curriculum**: Module/lesson overview with key topics
4. **Instructor**: Profile with credentials and expertise
5. **Testimonials**: Student success stories with outcomes
6. **Pricing**: Course pricing or plan comparison
7. **FAQ**: Duration, prerequisites, certification, refund policy
8. **CTA Section**: Enrollment form or free trial signup

### CRO Elements
- Student count or completion rate
- Certificate/credential offered
- "Start Free" or money-back guarantee
- Countdown timer for enrollment deadline

### Compliance
- No income/outcome guarantees disclaimer
- Refund policy reference`,

  automotive: `## Vertical: Automotive / Dealership

### Section Structure (in order)
1. **Hero**: Headline with current promotion or featured vehicle, primary CTA ("View Inventory" or "Get a Quote")
2. **Featured Vehicles**: 3-4 vehicle cards with photos and starting prices
3. **Why Choose Us**: Competitive pricing, financing options, certified pre-owned
4. **Testimonials**: Customer reviews
5. **Financing**: "Get Pre-Approved" section with benefits
6. **Service**: Mention service department if applicable
7. **CTA Section**: Lead form (name, phone, email, vehicle interest, trade-in)

### CRO Elements
- "Starting at $X/mo" pricing
- "No Credit Check" or "All Credit Welcome" badges
- Current promotions/rebates
- "X Vehicles in Stock" inventory count

### Compliance
- "Prices exclude tax, title, license" disclaimer
- MSRP/pricing disclaimers`,

  hospitality: `## Vertical: Hospitality / Restaurant / Travel

### Section Structure (in order)
1. **Hero**: Stunning visual hero with location/experience headline, primary CTA ("Book Now" or "Reserve a Table")
2. **Experience**: What makes this venue/destination special
3. **Offerings**: Menu highlights, room types, or experiences
4. **Gallery**: Photo showcase section
5. **Reviews**: Guest/diner reviews from TripAdvisor, Google, Yelp
6. **Location**: Map reference, hours, contact info
7. **CTA Section**: Reservation form or booking CTA

### CRO Elements
- Star rating and review count
- "Award-winning" or "Top Rated" badges
- Seasonal specials or limited availability
- "Book Direct & Save" messaging

### Compliance
- Cancellation policy reference
- Allergen/dietary notice for restaurants`,

  fitness: `## Vertical: Fitness / Gym / Wellness

### Section Structure (in order)
1. **Hero**: Transformation-focused headline, primary CTA ("Start Free Trial" or "Join Now")
2. **Programs**: Class types or program cards
3. **Results**: Before/after or member transformation stories
4. **Trainers**: Trainer profiles with certifications
5. **Membership**: Pricing tiers or plan comparison
6. **Testimonials**: Member success stories
7. **FAQ**: Cancellation, class schedule, equipment
8. **CTA Section**: Free trial signup or membership form

### CRO Elements
- "First Class Free" or trial offer
- Member count or transformation count
- "No Long-Term Contracts" badge
- Limited-time membership pricing

### Compliance
- "Results may vary" disclaimer
- Health/liability waiver reference`,

  insurance: `## Vertical: Insurance

### Section Structure (in order)
1. **Hero**: Protection-focused headline, primary CTA ("Get a Free Quote")
2. **Coverage Types**: Insurance product cards (auto, home, life, etc.)
3. **Why Choose Us**: Independent agent, multiple carriers, personalized service
4. **Savings**: Average savings amount, comparison shopping benefit
5. **Testimonials**: Client reviews
6. **Process**: 3-step quote process
7. **FAQ**: Coverage questions, claims process
8. **CTA Section**: Quote request form (name, phone, email, coverage type, zip code)

### CRO Elements
- "Save up to X%" messaging
- "Compare X+ carriers" badge
- "Licensed in X states" trust signal
- "Free, no-obligation quote" emphasis

### Compliance
- State licensing disclosure
- "Coverage subject to terms and conditions" disclaimer`,

  nonprofit: `## Vertical: Nonprofit / Charity

### Section Structure (in order)
1. **Hero**: Mission-driven headline with emotional appeal, primary CTA ("Donate Now")
2. **Impact**: Key statistics showing impact (lives changed, meals served, etc.)
3. **Programs**: Program/initiative cards
4. **Stories**: Beneficiary stories or case studies
5. **Transparency**: How donations are used (pie chart or breakdown)
6. **Ways to Help**: Donate, volunteer, sponsor options
7. **CTA Section**: Donation form or volunteer signup

### CRO Elements
- Impact statistics with large numbers
- "X% goes directly to programs" transparency
- Matching donation campaigns
- Tax-deductible donation badge

### Compliance
- 501(c)(3) status notation
- EIN number
- "Donations are tax-deductible" statement`,

  agency: `## Vertical: Marketing / Creative Agency

### Section Structure (in order)
1. **Hero**: Results-focused headline, primary CTA ("Get a Free Strategy Call")
2. **Services**: Service offering cards (SEO, PPC, web design, etc.)
3. **Case Studies**: Client results with metrics (X% increase, $X revenue)
4. **Process**: How you work with clients (Discovery → Strategy → Execute → Optimize)
5. **Testimonials**: Client testimonials with company names
6. **Team**: Key team members with expertise
7. **CTA Section**: Contact form (name, email, company, budget range, project description)

### CRO Elements
- Client logo bar
- Specific ROI metrics from past work
- "Free audit" or "Free strategy session" offer
- Industry awards or certifications

### Compliance
- Privacy policy link
- Terms of service link`,

  construction: `## Vertical: Construction / Remodeling

### Section Structure (in order)
1. **Hero**: Service headline with location, primary CTA ("Get a Free Estimate")
2. **Services**: Project type cards (kitchen, bathroom, additions, commercial)
3. **Portfolio**: Before/after project photos
4. **Why Choose Us**: Licensed, insured, warranty, years of experience
5. **Process**: Project timeline (Consultation → Design → Build → Walkthrough)
6. **Reviews**: Customer reviews with project types
7. **CTA Section**: Estimate request form (name, phone, email, project type, timeline)

### CRO Elements
- "Licensed & Insured" badge
- "X+ Projects Completed" count
- "Free Estimates" emphasis
- Warranty/guarantee badge
- Before/after photo pairs

### Compliance
- License number display
- "Licensed, Bonded & Insured" statement
- Warranty terms reference`,

  other: `## Vertical: General Business

### Section Structure (in order)
1. **Hero**: Clear value proposition headline, primary CTA
2. **Benefits**: 3-4 key benefits with icons
3. **How It Works**: 3-step process
4. **Social Proof**: Testimonials or client logos
5. **About**: Company story and credentials
6. **FAQ**: 4-5 common questions
7. **CTA Section**: Contact form (name, email, phone, message)

### CRO Elements
- Trust badges or certifications
- Customer/client count
- Guarantee or risk-reversal messaging

### Compliance
- Privacy policy link
- Terms of service link`,
};

const BASE_SYSTEM_PROMPT = `You are an expert landing page designer and CRO (Conversion Rate Optimization) specialist. You generate complete, production-ready HTML landing pages optimized for converting ad traffic.

## OUTPUT REQUIREMENTS

1. Output a COMPLETE \`<!DOCTYPE html>\` document with ALL CSS in a single \`<style>\` block in the \`<head>\` — no external CSS files
2. Use Google Fonts via \`<link>\` tags only (no other external dependencies)
3. Add \`data-sl-section="hero|features|testimonials|cta|process|faq|about|services|stats|pricing|footer"\` on each major \`<section>\`
4. Add \`data-sl-editable="true"\` on ALL text elements (headings, paragraphs, list items, button text, spans with text)
5. Responsive design with breakpoints at 768px and 480px
6. **ABSOLUTELY NO navigation menu or header nav links** — no hamburger menu, no nav bar, no header links. The ONLY clickable elements should be CTA buttons. This is a landing page, not a website — keep the visitor focused on ONE action.
7. Include a sticky/fixed CTA element (floating button or bar) for mobile
8. Use semantic HTML5 elements
9. All images use placeholder URLs from the provided image list, with descriptive alt text
10. Include a \`<meta name="viewport" content="width=device-width, initial-scale=1.0">\` tag
11. Keep total HTML under 150KB

## DESIGN PRINCIPLES

- **Modern, premium aesthetic** — this should look like a $5,000+ custom landing page, not a template
- Above-the-fold must contain: headline, value proposition, and primary CTA
- Use high contrast for CTAs (bright color on dark or vice versa) — CTA buttons should be large (min 48px height, 200px+ width) with bold text
- Generous white space — sections should have 80-120px vertical padding, don't overcrowd
- Use a consistent 2-3 color palette derived from brand settings (if provided)
- Typography: use Google Font pairings (e.g. Inter + DM Sans, Poppins + Open Sans). Headlines 36-56px, subheads 20-24px, body 16-18px, line-height 1.6
- Subtle design touches: soft gradients, subtle shadows (box-shadow), rounded corners (8-16px), section dividers
- Use CSS grid or flexbox for clean layouts — no tables
- Hero section should be visually striking: full-width, min 70vh height, with gradient or image overlay
- Mobile-first: touch-friendly buttons (min 48px tap targets), single-column on mobile
- Form fields: large inputs (48px height), clear labels, rounded corners, visible focus states

## COPY PRINCIPLES

- Lead with the visitor's problem or desired outcome, not the company
- Use specific numbers and results where appropriate
- CTA buttons should be action-oriented and specific (not just "Submit")
- Keep paragraphs short (2-3 sentences max)
- Use bullet points for scannable content`;

export function buildPageGenerationPrompt(input: PromptInput): { system: string; user: string } {
  const { userPrompt, vertical, customVertical, brandSettings, imageUrls, performanceInsights } = input;

  let system = BASE_SYSTEM_PROMPT;

  if (vertical === 'other' && customVertical) {
    system += `\n\n## Vertical: ${customVertical}

### Section Structure (in order)
1. **Hero**: Clear value proposition headline tailored to this specific industry/business, primary CTA
2. **Benefits**: 3-4 key benefits with icons relevant to this business type
3. **How It Works**: 3-step process showing how this business serves its customers
4. **Social Proof**: Testimonials, reviews, or client logos appropriate for this industry
5. **About**: Company story and credentials
6. **FAQ**: 4-5 common questions a customer of this type of business would ask
7. **CTA Section**: Contact form appropriate for this business (e.g., consultation, quote, booking, sign-up)

### CRO Elements
- Trust signals relevant to this industry (certifications, awards, years in business, client count)
- Risk-reversal messaging (guarantees, free trials, no-obligation consultations)
- Urgency or scarcity elements where appropriate

### Important
- Tailor ALL copy, imagery descriptions, section ordering, and CTA language to fit the "${customVertical}" industry specifically
- Do NOT use generic business language — write as if you deeply understand this industry`;
  } else {
    system += '\n\n' + VERTICAL_TEMPLATES[vertical];
  }

  if (performanceInsights) {
    system += `\n\n## PERFORMANCE INSIGHTS FROM PAST PAGES\n${performanceInsights}`;
  }

  let user = `## PAGE REQUEST\n\n${userPrompt}`;

  if (brandSettings) {
    user += '\n\n## BRAND SETTINGS — YOU MUST USE THESE EXACTLY\n';
    if (brandSettings.company_name) user += `- **Company Name: "${brandSettings.company_name}"** — Use this EXACT name everywhere on the page. Do NOT invent a different company name.\n`;
    if (brandSettings.primary_color) user += `- Primary Brand Color: ${brandSettings.primary_color} — Use as the main accent color for CTAs, headings, and highlights\n`;
    if (brandSettings.secondary_color) user += `- Secondary Brand Color: ${brandSettings.secondary_color} — Use for backgrounds, borders, and secondary elements\n`;
    if (brandSettings.logo_url) user += `- Logo URL: ${brandSettings.logo_url} — Use as an <img> tag in the header area\n`;
    if (brandSettings.phone) user += `- Phone Number: ${brandSettings.phone} — Display prominently, use tel: link for click-to-call\n`;
    if (brandSettings.tone) user += `- Tone of Voice: ${brandSettings.tone}\n`;
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

/* ───────────────────────────────────────────────────
 * Stitch integration: design prompt + Claude refinement
 * ─────────────────────────────────────────────────── */

interface StitchPromptInput {
  userPrompt: string;
  vertical: Vertical;
  brandSettings?: BrandSettings;
}

/**
 * Build a design-focused prompt for Stitch (Gemini) to generate the visual design.
 * Stitch is great at visual design but doesn't know about SplitLab conventions.
 */
export function buildStitchDesignPrompt(input: StitchPromptInput): string {
  const { userPrompt, vertical, brandSettings } = input;

  const verticalLabel: Record<Vertical, string> = {
    legal: 'personal injury / legal services law firm',
    real_estate_financial: 'real estate or financial services company',
    saas: 'SaaS / technology product',
    local_services: 'local home services business (plumbing, HVAC, etc.)',
    healthcare: 'healthcare / medical practice or clinic',
    ecommerce: 'e-commerce / online retail brand',
    education: 'education / online course or training program',
    automotive: 'automotive dealership or car services company',
    hospitality: 'hospitality / restaurant / travel business',
    fitness: 'fitness / gym / wellness studio',
    insurance: 'insurance agency or brokerage',
    nonprofit: 'nonprofit organization / charity',
    agency: 'marketing / creative / digital agency',
    construction: 'construction / remodeling / home improvement company',
    other: 'business',
  };

  let prompt = `Design a high-converting landing page for a ${verticalLabel[vertical]}.\n\n`;
  prompt += `Business description: ${userPrompt}\n\n`;

  prompt += `Requirements:\n`;
  prompt += `- This is a LANDING PAGE for paid ad traffic, NOT a full website\n`;
  prompt += `- NO navigation menu or header nav links — the only clickable elements should be CTA buttons\n`;
  prompt += `- Mobile-responsive design with large tap targets (48px+ buttons)\n`;
  prompt += `- Professional, premium aesthetic — this should look like a custom $5,000+ page\n`;
  prompt += `- Include: hero section with strong headline and primary CTA, social proof/testimonials, features/services, how-it-works process, FAQ with accordions, and a contact form or lead capture CTA at the bottom\n`;
  prompt += `- Contact form fields: name, phone, email, and a description/message field\n`;
  prompt += `- Include a sticky mobile CTA button\n`;
  prompt += `- Generous whitespace, modern typography, subtle animations/hover effects\n`;

  if (brandSettings) {
    prompt += `\nBrand settings:\n`;
    if (brandSettings.company_name) prompt += `- Company name: "${brandSettings.company_name}"\n`;
    if (brandSettings.primary_color) prompt += `- Primary color: ${brandSettings.primary_color}\n`;
    if (brandSettings.secondary_color) prompt += `- Secondary color: ${brandSettings.secondary_color}\n`;
    if (brandSettings.phone) prompt += `- Phone number: ${brandSettings.phone}\n`;
    if (brandSettings.tone) prompt += `- Tone: ${brandSettings.tone}\n`;
  }

  return prompt;
}

interface RefinementInput {
  stitchHtml: string;
  vertical: Vertical;
  brandSettings?: BrandSettings;
  imageUrls?: UnsplashImage[];
}

/**
 * Build a Claude prompt to refine Stitch-generated HTML for SplitLab compatibility.
 * Claude's job: add data attributes, swap images, inject compliance, remove nav, inline CSS.
 */
export function buildRefinementPrompt(input: RefinementInput): { system: string; user: string } {
  const { stitchHtml, vertical, brandSettings, imageUrls } = input;

  const system = `You are a landing page optimization specialist. You take a pre-designed HTML landing page and refine it for production use in a conversion-optimized A/B testing platform.

## YOUR TASK

You will receive a beautifully designed HTML page from a design AI. Your job is to refine it while PRESERVING the visual design as much as possible. Do NOT redesign the page — make surgical, targeted changes.

## REQUIRED CHANGES

1. **Remove all navigation**: Delete any <header> with nav links, <nav> elements, hamburger menus, or header link bars. The ONLY clickable elements should be CTA buttons and footer links (privacy/terms).

2. **Inline all CSS**: If the page uses Tailwind CDN (\`cdn.tailwindcss.com\`), convert all Tailwind classes to equivalent inline CSS in a single \`<style>\` block in \`<head>\`. Remove the Tailwind CDN script tag and any tailwind.config script. Keep Google Fonts \`<link>\` tags.

3. **Add SplitLab data attributes**:
   - Add \`data-sl-section="hero|features|testimonials|cta|process|faq|about|services|stats|pricing|footer"\` to each major \`<section>\`
   - Add \`data-sl-editable="true"\` to ALL text elements (h1-h6, p, li, button text, span with text content)

4. **Replace images**: Swap all image URLs (Google-hosted, placeholder, AI-generated) with the provided Unsplash image URLs. Match images to their sections contextually. Use descriptive alt text.

5. **Add compliance copy** for the specific vertical (see below).

6. **Brand enforcement**: If brand settings are provided, ensure the company name, phone number, and colors are used correctly throughout.

7. **Ensure responsive**: Verify media queries exist for 768px and 480px breakpoints. Add them if missing.

8. **Add sticky mobile CTA**: If not already present, add a fixed-bottom CTA bar visible only on mobile (<768px).

9. **Keep total HTML under 150KB**.

## OUTPUT

Output ONLY the complete refined HTML document. No markdown fences, no explanation.`;

  let user = `## ORIGINAL DESIGN HTML\n\n\`\`\`html\n${stitchHtml}\n\`\`\`\n\n`;

  user += `## VERTICAL\n${VERTICAL_TEMPLATES[vertical]}\n\n`;

  if (brandSettings) {
    user += '## BRAND SETTINGS — ENFORCE THESE EXACTLY\n';
    if (brandSettings.company_name) user += `- Company Name: "${brandSettings.company_name}"\n`;
    if (brandSettings.primary_color) user += `- Primary Color: ${brandSettings.primary_color}\n`;
    if (brandSettings.secondary_color) user += `- Secondary Color: ${brandSettings.secondary_color}\n`;
    if (brandSettings.logo_url) user += `- Logo URL: ${brandSettings.logo_url}\n`;
    if (brandSettings.phone) user += `- Phone: ${brandSettings.phone} (use tel: links)\n`;
    if (brandSettings.tone) user += `- Tone: ${brandSettings.tone}\n`;
  }

  if (imageUrls && imageUrls.length > 0) {
    user += '\n## UNSPLASH IMAGES — REPLACE ALL EXISTING IMAGES WITH THESE\n';
    imageUrls.forEach((img, i) => {
      user += `${i + 1}. URL: ${img.url}\n   Alt: ${img.alt}\n   Credit: ${img.credit}\n`;
    });
  }

  user += '\n\nRefine the HTML now. Output ONLY the final HTML — no markdown code fences, no explanation.';

  return { system, user };
}

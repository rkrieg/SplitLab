/**
 * Per-vertical sample prompts shown to users before their first build.
 * Each prompt is CRO-first and content/context-focused — no layout or
 * structure directives (those live in SYSTEM_PROMPT in build/route.ts).
 *
 * [placeholder] fields are highlighted in the UI and filled by the user
 * before submitting. If sent unfilled, SYSTEM_PROMPT instructs Claude to
 * invent a realistic value rather than echo the bracket syntax.
 *
 * Keyed by vertical value from ai-page-verticals.ts.
 */

export const SAMPLE_PROMPTS: Record<string, string> = {
  legal: `Build a conversion-focused landing page for [firm name], a [practice area, e.g. personal injury / family law / criminal defence] law firm based in [city].

The single goal of this page: get a visitor to call now or submit a contact form. Every section earns its place by moving someone closer to that action.

Business details:
- [years in practice] years in practice
- [key result, e.g. $50M+ recovered for clients / 500+ cases won]
- No win, no fee — clients pay nothing unless we win
- Free consultation, same-day callbacks guaranteed

Tone: authoritative but human. The visitor is often stressed and searching in a moment of crisis — the page should feel like a trusted expert, not a faceless institution. Avoid legal jargon. Write headlines that state the outcome the client wants, not the firm's credentials.

Trust signals to weave in: bar association memberships, peer ratings (e.g. AVVO, Super Lawyers), verdict/settlement amounts, client review scores.

The contact form should ask for the minimum needed: name, phone number, one-line description of their situation. Add a visible phone number that is tap-to-call on every section — many visitors will be on mobile and would rather call than fill a form.`,

  healthcare_wellness: `Build a calming, conversion-focused landing page for [practice or brand name], a [type of service, e.g. online therapy practice / wellness clinic / nutrition coaching service] based in [city or "available online"].

The goal of this page: get a visitor to book a free intro call or fill out an intake form. The visitor is often in a vulnerable state — the page must feel safe, private, and judgment-free from the first line.

Business details:
- Services offered: [e.g. individual therapy, couples counselling, anxiety & depression support]
- [licensed / certified] practitioners
- [insurance accepted / sliding scale fees available / HSA eligible]
- [same-week appointments / next-day availability]
- Sessions available [in-person / via video / both]

Tone: warm, reassuring, and human. Never clinical or cold. Use language that normalises seeking help — "you don't have to figure this out alone." Avoid overly medical or corporate language. The visitor needs to feel understood before they'll trust enough to reach out.

Trust signals: practitioner credentials, number of clients helped, testimonials that speak to emotional outcomes ("I finally feel like myself again"), confidentiality statement, insurance or pricing transparency.

The CTA should reduce friction — "Book a Free 15-Min Call" is lower commitment than "Book an Appointment." Repeat it consistently throughout.`,

  saas: `Build a high-converting landing page for [product name], a SaaS product that helps [target user, e.g. remote design teams / e-commerce founders / operations managers] [core outcome, e.g. ship projects faster / reduce customer churn / automate their reporting].

The goal: get a visitor to start a free trial or book a demo. The visitor is evaluating several tools — this page needs to win on clarity, credibility, and specificity. Generic claims lose. Specific outcomes win.

Business details:
- Core problem solved: [describe the pain point in one sentence]
- Key features: [feature 1], [feature 2], [feature 3]
- Integrations: [e.g. Slack, Notion, Salesforce, Stripe]
- Pricing starts at [price]/month, free trial available — no credit card required
- [number] teams / companies already using it
- [key social proof stat, e.g. "saves teams 6 hours per week on average"]

Tone: clear, direct, and confident. Avoid buzzwords like "revolutionary" or "game-changing." Write copy that a busy professional skimming on their phone would immediately understand. Lead with the outcome, follow with the proof, close with the CTA.

The hero headline should name the specific user and the specific outcome — not the product name. Features section should explain benefits, not just list capabilities. Show a pricing section with a clear free tier or trial offer.`,

  lead_gen: `Build a lead generation landing page for [business name], a [type of business, e.g. home renovation company / solar installer / mortgage broker] serving [city / region].

The single goal: capture a qualified lead — name, phone number, and enough context to follow up. The visitor has high intent (they searched for this service) — the page's job is to convert that intent before they hit the back button.

Business details:
- Core service: [what you do]
- Key differentiators: [e.g. licensed & insured, family-owned, 5-star rated, fastest turnaround in the area]
- Social proof: [number] completed projects / [review score] on Google / [years] in business
- Offer: free quote / free estimate / free consultation — no obligation
- Service area: [cities or regions you cover]

Tone: professional, local, and trustworthy. The visitor is evaluating several providers — trust signals (real reviews, credentials, before/after results) are what tips the decision. Be specific: "500 kitchens renovated in Austin" beats "hundreds of happy customers."

The lead form should be visible above the fold and ask for the minimum: name, phone, and a dropdown for the type of service needed. Add urgency where honest — limited slots, current promotion, seasonal demand. Phone number must be tap-to-call and repeated throughout.`,

  local: `Build a warm, trustworthy landing page for [business name], a [type of local business, e.g. plumbing & heating company / electrician / locksmith / cleaning service] serving [city] and surrounding areas.

The goal: get a local resident to call, book online, or fill out a contact form. The visitor wants someone reliable, local, and available — the page should feel like a real person runs it, not a national chain.

Business details:
- Services: [list main services]
- Available: [e.g. 24/7 for emergencies / Mon–Sat 8am–6pm]
- [licensed, bonded, and insured]
- [family-owned since year / years in the community]
- Service area: [specific neighbourhoods, suburbs, or zip codes]
- [Google rating] stars from [number] reviews

Tone: friendly, direct, and community-rooted. Use plain language — no industry jargon. Mention the local area by name to reinforce that this is a neighbourhood business. Lead with availability and reliability, because those are the two things local service customers care about most.

Phone number must be the most prominent element on the page — larger than the headline if possible — and repeated in every section. Many visitors will be in a hurry or dealing with an emergency. Make calling the path of least resistance.`,

  ecommerce: `Build a product landing page for [brand name], a [product type, e.g. premium skincare brand / small-batch coffee company / handmade leather goods maker] targeting [target customer, e.g. health-conscious women 25–40 / specialty coffee enthusiasts / professionals who value craftsmanship].

The goal: get a visitor to make their first purchase or start a subscription. The visitor discovered the brand and is in consideration mode — the page needs to earn trust, communicate quality, and make buying feel easy and risk-free.

Business details:
- Hero product or range: [product name or line]
- Key differentiators: [e.g. organic ingredients / sourced directly from farms / handmade in small batches / ships within 24 hours]
- Price point: [price range]
- Guarantee: [e.g. 30-day money-back / free returns / satisfaction guaranteed]
- Social proof: [number] customers / [review score] stars / [press mention if any]
- Subscription option: [yes/no — if yes, describe the offer]

Tone: [match to brand — e.g. warm and artisan / clean and minimal / bold and energetic]. The copy should make the product feel worth the price. Lead with the emotional outcome of owning or using it, then back it up with specifics (ingredients, process, sourcing). Customer reviews with star ratings are the single highest-converting element on a product page — make them prominent.`,

  real_estate: `Build a lead-generating landing page for [agent or agency name], a [boutique / full-service] real estate [agent / team / agency] specialising in [property type, e.g. luxury homes / first-time buyers / investment properties] in [city or neighbourhood].

The goal: get a visitor to book a consultation, request a home valuation, or fill out a buyer/seller enquiry form. The visitor is making one of the largest financial decisions of their life — the page must project expertise, local knowledge, and trustworthiness above everything else.

Business details:
- Specialisation: [buying / selling / both] — focus on [property type] in [area]
- Track record: [e.g. $180M in sales / 200+ transactions / average X days on market]
- Key differentiator: [e.g. deep neighbourhood expertise / off-market access / investor network / first-time buyer specialists]
- Client satisfaction: [review score] from [number] clients
- Current market insight: [one specific, credible local market fact that demonstrates expertise]

Tone: confident, knowledgeable, and approachable. Avoid generic real estate clichés ("your dream home," "keys to the future"). Speak to the specific concerns of your target client — sellers want maximum price in minimum time, buyers want to not overpay and not miss out. Address those fears directly.

Include a home valuation CTA for sellers and a property search or consultation CTA for buyers. Testimonials should mention specific outcomes ("sold in 8 days, $40K over asking").`,

  financial_services: `Build a trust-first landing page for [firm name], an independent [financial planning firm / wealth management practice / tax advisory] serving [target client, e.g. professionals planning for early retirement / business owners / high-net-worth families] in [city] and nationally via video.

The goal: get a qualified prospect to book a free discovery call. The visitor is evaluating whether to trust you with their financial future — credibility, transparency, and specificity are everything on this page.

Business details:
- Services: [e.g. retirement planning, investment management, tax optimisation, estate planning]
- Fee structure: [fee-only / AUM-based / flat fee] — [fiduciary / not commission-based]
- Credentials: [CFP / CFA / CPA / other designations]
- Who you serve best: [specific client profile — income range, life stage, goals]
- Client outcomes: [e.g. average client retires 4 years earlier / reduced tax burden by average 22%]

Tone: calm, authoritative, and transparent. The visitor is likely skeptical of financial advisors — acknowledge that upfront. Explain exactly how you're paid and why that makes your advice different. Use plain language: "we help you pay less in taxes and retire on your terms" beats "comprehensive wealth management solutions."

The discovery call CTA should feel low-stakes: "No pitch, no pressure — just a conversation about where you are and where you want to be." Include a short FAQ that addresses the two biggest objections: cost and "is this worth it for someone like me?"`,

  education_coaching: `Build a high-converting sales page for [course or program name] by [creator name], a [online course / coaching programme / membership] that teaches [target student, e.g. freelance designers / first-time managers / career changers] how to [specific outcome, e.g. land their first $5K client / get promoted in 90 days / transition into UX design].

The goal: get a visitor to enrol, join the waitlist, or book a discovery call. The visitor is interested but skeptical — they've probably bought courses before that didn't deliver. The page must make the outcome feel real and achievable for someone like them specifically.

Business details:
- Who this is for: [describe the ideal student in one specific sentence]
- The transformation: before state → after state ([where they are now] → [where they'll be after completing the programme])
- What's included: [modules / coaching calls / community / templates / lifetime access]
- Price: [price] or [payment plan]
- Results: [student outcome 1], [student outcome 2] — use real numbers where possible
- Creator credibility: [creator's relevant experience / background / why they can teach this]

Tone: motivating, direct, and honest. Don't oversell — visitors can smell hype. Lead with the outcome, back it up with student results, address the biggest objection ("I've tried things like this before and they didn't work") head-on. A "who this is NOT for" section builds more trust than any testimonial.`,

  events_webinars: `Build an event registration page for [event name], a [conference / summit / workshop / webinar] for [target audience, e.g. startup founders / marketing professionals / independent consultants] taking place [in-person in city / online] on [date or date range].

The goal: get a qualified attendee to register before the event fills up or the early-bird deadline passes. The visitor is interested but may procrastinate — urgency and social proof are the two highest-leverage elements on this page.

Event details:
- Format: [in-person / virtual / hybrid] — [number] hours / [number] days
- Topics / tracks: [main themes or session topics]
- Speakers: [speaker 1 — title/company], [speaker 2 — title/company], [speaker 3 — title/company]
- Expected attendance: [number] attendees
- Ticket tiers: [tier 1 name] at [price], [tier 2 name] at [price]
- Early-bird deadline or limited spots: [deadline or capacity]

Tone: energetic and clear. Lead with what the attendee will walk away with ("Leave knowing exactly how to X"), not just what will happen at the event. Speaker credibility is the #1 conversion driver for professional events — feature names, photos, and one-line credibility markers prominently. Agenda overview should feel packed with value, not vague. Make the registration CTA unmissable and repeat it after the speaker lineup and after the agenda.`,

  hospitality_travel: `Build a booking-focused landing page for [property or brand name], a [boutique hotel / villa / travel experience / tour operator] located in [destination].

The goal: get a visitor to check availability, make a booking enquiry, or click through to the booking engine. The visitor is in dreaming-to-deciding mode — the page needs to make them feel like they can almost already be there.

Property or experience details:
- What makes it special: [unique selling point — location, design, exclusivity, experience]
- Accommodation: [number] [rooms / suites / villas] with [key amenities]
- Standout experiences: [e.g. private beach / rooftop pool / guided excursions / Michelin dining]
- Rate range: from [price] per night / per person
- Ideal guest: [couples / families / solo travellers / luxury seekers / adventure travellers]
- Social proof: [review score] on [TripAdvisor / Google] from [number] guests / [press feature if any]

Tone: [match to property — e.g. refined and evocative for luxury / warm and adventurous for boutique travel]. Write copy that makes the reader feel the place — use sensory language. "Wake up to the sound of the sea with the Amalfi Coast outside your window" does more than "ocean-view rooms available." Photography placeholders should have strong gradient backgrounds that hint at the destination's colour palette.`,

  fitness_beauty: `Build an energy-forward landing page for [studio or brand name], a [boutique fitness studio / beauty salon / wellness brand] located in [city] offering [main services, e.g. reformer Pilates & hot yoga / blowouts & colour / IV therapy & facials].

The goal: get a new visitor to book their first class, appointment, or treatment — ideally with a new client offer that lowers the barrier to that first visit.

Business details:
- Signature offer for new clients: [e.g. first class free / $49 for first month / 20% off first appointment]
- What makes it different: [e.g. small class sizes / results-focused trainers / premium equipment / luxe atmosphere]
- Services / class types: [list 3–5]
- Instructors / practitioners: [number] — [credentials or vibe, e.g. certified, welcoming to all levels]
- Membership from: [price]/month — includes [what's included]
- Community / results: [number] members / [social proof stat, e.g. "92% of members see results in 30 days"]

Tone: [energetic and bold for fitness / clean and luxe for beauty]. The page should make the visitor feel the atmosphere before they walk in. Lead with the transformation or feeling ("You'll leave stronger than you arrived"), not the schedule or facilities. New client offers need to be impossible to miss — make them visually stand out from regular pricing.`,

  sales_info_product: `Build a direct-response sales page for [product name], a [digital course / ebook / template pack / membership / coaching programme] priced at [price or payment plan] that helps [target buyer, e.g. freelancers / side hustlers / small business owners] achieve [specific outcome, e.g. consistently earn $10K/month / build a profitable online store in 30 days].

The goal: get a visitor to buy now or at minimum opt into a waitlist. This is a direct-response page — every element exists to move the visitor toward a purchase decision. Hesitation is the enemy.

Product details:
- The promise: [the specific, measurable outcome a buyer can expect]
- Creator credibility: [creator name] — [relevant achievement that proves they've done what they're teaching]
- What's inside: [key modules, templates, bonuses, community access]
- Social proof: [number] customers / [testimonial result 1] / [testimonial result 2] — use income or outcome numbers where real
- Guarantee: [e.g. 30-day money-back, no questions asked]
- Urgency / scarcity: [cart closes [date] / price increases after [date] / [X] spots remaining]

Tone: direct, energetic, and outcome-obsessed. Every headline should either name the pain, promise the outcome, or overcome an objection. Use real numbers from real students. A "who this is for / who this is NOT for" section is non-negotiable — it builds trust and qualifies buyers. The guarantee should be stated boldly near the CTA, not buried in the footer.`,

  nonprofit: `Build an emotionally resonant landing page for [organisation name], a nonprofit [cause area, e.g. fighting childhood hunger / supporting veterans in transition / protecting ocean ecosystems] operating in [region or nationally].

The goal: get a visitor to make a donation, sign up to volunteer, or join as a recurring supporter. The visitor likely already cares about the cause — the page's job is to make them feel that their specific contribution will make a real, tangible difference.

Organisation details:
- Mission: [one clear sentence — what you do and for whom]
- Impact to date: [key stat 1, e.g. 2.4M meals served], [key stat 2, e.g. 47 partner schools], [key stat 3]
- Where donations go: [breakdown — e.g. 82 cents of every dollar goes directly to programmes]
- Programmes: [programme 1], [programme 2]
- Who you serve: [specific description of the people or cause benefiting]
- Recurring giving ask: [monthly donation amount] feeds / supports / protects [specific tangible outcome]

Tone: warm, human, and urgent without being manipulative. Lead with a specific story or face, not statistics — one real person's outcome moves people more than a million-person statistic. Show exactly where money goes — transparency is the #1 trust driver for nonprofit donors. Donation form should offer preset amounts with a tangible label for each ("$10 feeds a child for a week") plus a custom amount option.`,

  other: `Build a conversion-focused landing page for [business name], a [describe your business in one sentence — what you do and who you do it for] based in [location or "available online"].

The goal of this page: [state the single action you want a visitor to take — e.g. book a consultation / make a purchase / fill out an enquiry form / sign up for a free trial].

Business details:
- What you offer: [your core product or service]
- Who it's for: [describe your ideal customer specifically]
- Why you're different: [your key differentiator — what makes you the right choice over alternatives]
- Proof: [social proof — reviews, clients served, years in business, results achieved]
- Pricing or offer: [price range, free trial, guarantee, or introductory offer]
- Contact preference: [phone / form / booking link / email]

Tone: [describe the tone that fits your brand — e.g. professional and trustworthy / friendly and approachable / bold and energetic / calm and premium].

Share any specific copy, taglines, or brand language you want included, and any sections that are must-haves for your business (testimonials, FAQs, team bios, process walkthrough, pricing table, etc.).`,
};

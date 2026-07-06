import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { jsonrepair } from 'jsonrepair';
import { askAI, isRateLimited, AIResponseTruncatedError } from '@/lib/ai-client';
import { VERTICAL_VALUES } from '@/lib/ai-page-verticals';
import { SECTION_VOCABULARY, VERTICAL_PRIORITY_HINTS } from '@/lib/ai-page-vocabulary';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { extractUrls, scrapeCompetitorUrl } from '@/lib/ai-competitor-scrape';

const SECTION_TYPES_BLOCK = SECTION_VOCABULARY
  .map(s => `- ${s.schemaExample}\n  Use when: ${s.whenToUse}`)
  .join('\n');

const SYSTEM_PROMPT = `You are an AI landing page builder. Your job is to either ask clarifying questions or generate a page schema — never both, never anything else.

## Output rules
- Return JSON only. No explanation, no markdown fences, no extra text.
- Two valid output shapes:

Shape 1 — clarifying questions (only when prompt is too vague):
{"type":"questions","questions":["question 1","question 2","question 3"]}

Shape 2 — page schema (when you have enough to build):
{"type":"schema","schema":{...}}

## When to ask questions vs build immediately
Ask questions ONLY if the prompt is missing ALL of: a goal, specific sections, or business details.
If the user says "surprise me" or "just build it" — generate the best default schema for the vertical. Never ask again.
Maximum 1 round of questions, maximum 3 questions per round.

## Schema structure
{
  "vertical": "<short free-text description of the inferred business type, e.g. 'boutique skincare ecommerce' or 'B2B compliance SaaS'>",
  "hero": {
    "headline": "...",
    "subhead": "...",
    "cta_text": "...",
    "cta_url": "#contact"
  },
  "sections": [ ...section objects... ],
  "footer": {
    "copyright": "...",
    "links": ["Privacy Policy", "Terms of Service"]
  }
}

## Section types (available moves — pick a varied combination per page, not the same 4-5 every time)
${SECTION_TYPES_BLOCK}

## Content rules
- Write real, compelling copy based on the business. No placeholders, no lorem ipsum.
- The user has pre-selected a vertical — treat it as a bias toward certain section types (see the per-vertical hint appended below), not a fixed template. Refine based on the specific prompt.
- Pick 4-7 sections beyond hero/footer. More variety across pages is better than defaulting to the same shape every time.
- JSON validity is non-negotiable. If any copy you write — including phrases quoted or reused from the user's prompt — contains a double-quote character, you MUST escape it as \" inside the JSON string. Never emit a literal unescaped " inside a string value.

## Image prompts — add image_prompt + image_placement to sections that need real photos

For sections that benefit from real photography, add these two fields directly on the section object (or on each item in an array). The build step will generate real DALL-E 3 images from these prompts and inject them into the HTML.

### WHERE to add image_prompt (follow this strictly)
| Section | Rule |
|---|---|
| hero | Always — one image_prompt on the hero object |
| gallery / ugc_gallery | One image_prompt per item — make each item an object { "image_prompt": "...", "image_placement": "card" } |
| team | One image_prompt per member object |
| social_proof testimonials | One image_prompt per testimonial object (headshot) |
| reviews_ratings reviews | One image_prompt per review object (headshot) |
| product_showcase products | One image_prompt per product object (product photo) |
| about / case_study | One image_prompt on the section if a real photo would help |
| nav / stats / pricing / faq / footer / comparison / logo_wall / guarantee / urgency_banner | NEVER |

Maximum 8 total image_prompts across the entire schema. Priority order: hero first, gallery items, team/testimonials, other sections.

### image_placement values (use exactly one)
- "background" — the image covers the full section as a CSS background
- "right-column" — <img> in a two-column layout, image on the right
- "left-column" — <img> in a two-column layout, image on the left
- "full-width" — full-width <img> spanning the section
- "card" — per-item thumbnail in a card grid (team, testimonials, portfolio, products)

### WHAT to write in image_prompt — be hyper-specific
- Pull details from the business (location, niche, product type, industry, style)
- Match tone: luxury → "elegant, high-end, dramatic lighting", startup → "modern, minimal, bright, airy"
- ❌ Too vague: "a team of people" ✅ Specific: "4-person fintech startup team, casual open office, natural window light, diverse, smiling"
- For competitor URL prompts: infer image TYPE from the reference HTML (photo vs illustration vs screenshot) and match the visual style (dark/light, minimal/rich, corporate/playful)
- Always end with: ", professional photography, high resolution"
- For hero images: also include the business setting or environment

### Schema example with image_prompts
{
  "hero": {
    "headline": "...",
    "image_prompt": "luxury dental clinic waiting area, warm lighting, modern design, plants, professional photography, high resolution",
    "image_placement": "right-column"
  },
  "sections": [
    {
      "type": "team",
      "headline": "Meet the Team",
      "members": [
        { "name": "Dr. Sarah Chen", "role": "Lead Dentist", "bio": "...", "image_prompt": "professional headshot, female Asian dentist, white coat, warm smile, clean clinic background, professional photography, high resolution", "image_placement": "card" }
      ]
    }
  ]
}`;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { prompt, vertical, conversation_json, workspace_id } = await request.json();

    if (!workspace_id || typeof workspace_id !== 'string') {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Plan gate — check owner's plan before consuming a rate-limit slot
    if (session.user.role !== 'admin') {
      const ownerPlan = await resolveOwnerPlan(workspace_id);
      if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
        return NextResponse.json(
          { error: 'AI page generation requires an Agency or Scale plan. Please upgrade to use this feature.', limitError: true },
          { status: 403 }
        );
      }
    }

    if (isRateLimited(session.user.id, 3, 60_000) || isRateLimited(session.user.id, 15, 3_600_000)) {
      return NextResponse.json({ error: 'Too many page generation requests. Please wait a moment before starting a new page.' }, { status: 429 });
    }

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    const selectedVertical: string | null = VERTICAL_VALUES.includes(vertical) ? vertical : null;
    const priorityHint = selectedVertical ? VERTICAL_PRIORITY_HINTS[selectedVertical] : null;

    const systemPrompt = selectedVertical
      ? `${SYSTEM_PROMPT}\n\nThe user selected vertical: ${selectedVertical}.${priorityHint ? ` ${priorityHint}` : ''}`
      : SYSTEM_PROMPT;

    const history: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(conversation_json)
      ? conversation_json
      : [];

    // Scrape competitor site if the prompt contains a URL — must complete BEFORE schema generation
    // so the schema reflects the competitor's actual section count and order.
    const urls = extractUrls(prompt);
    const competitorContext = urls.length > 0 ? await scrapeCompetitorUrl(urls[0]) : null;

    if (competitorContext) {
      console.log('[competitor] cssTokens:\n', competitorContext.cssTokens || '(empty)');
      console.log('[competitor] pageContent length:', competitorContext.pageContent?.length ?? 0);
      console.log('[competitor] screenshots count:', competitorContext.screenshots?.length ?? 0);
    }

    const competitorNote = competitorContext
      ? `\n\n## Reference site context — MANDATORY\nThe user wants a page that closely replicates: ${urls[0]}\n\n${competitorContext.cssTokens ? `CSS token analysis:\n${competitorContext.cssTokens}\n\n` : ''}${competitorContext.pageContent ? `Reference site HTML (use to extract real copy, nav links, headlines, CTAs, section structure):\n${competitorContext.pageContent}\n\n` : ''}CRITICAL SCHEMA RULES when a reference site is provided:\n- Read the HTML above and extract the REAL headline text, subheadline, CTA button text, nav links, feature titles, testimonial copy — use the actual words from the site, not invented placeholders\n- Extract EVERY section visible on the reference site and include it in the schema\n- Match the SECTION ORDER exactly from the SECTION ORDER list above\n- Match the section TYPES exactly (if reference has Stats, Testimonials, Pricing, FAQ — include all of them)\n- Do NOT collapse or omit sections — a reference site with 8 sections must produce a schema with 8 sections\n- Replicate the nav link labels exactly as they appear on the reference site\n- Use the reference site's actual CTA button text, not generic "Get Started"`
      : '';

    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      ...history,
      { role: 'user', content: prompt + competitorNote },
    ];

    // Screenshot is NOT passed here — schema generation doesn't need vision. It is returned
    // to the client and forwarded to /build where Claude uses it as a visual reference.
    let text: string;
    try {
      text = await askAI({ system: systemPrompt, messages, maxTokens: 16000 });
    } catch (err) {
      if (err instanceof AIResponseTruncatedError) {
        console.error('[pages/generate] response truncated at maxTokens', {
          outputTokens: err.outputTokens,
          maxTokens: err.maxTokens,
          promptLength: prompt.length,
          vertical: selectedVertical,
        });
        return NextResponse.json(
          { error: 'Your request asked for more content than we can generate in one pass. Try requesting fewer sections or a simpler layout.', truncated: true },
          { status: 500 }
        );
      }
      throw err;
    }

    let parsed: { type: 'questions' | 'schema'; questions?: string[]; schema?: unknown };
    try {
      const raw = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Most common real-world cause: the model echoed a quoted phrase from the
        // user's prompt without escaping the inner quotes. jsonrepair fixes that
        // and other minor near-JSON issues before we give up entirely.
        parsed = JSON.parse(jsonrepair(raw));
      }
    } catch {
      console.error('[pages/generate] invalid JSON from AI', {
        promptLength: prompt.length,
        vertical: selectedVertical,
        rawLength: text.length,
        rawPreview: text.slice(0, 1500),
      });
      return NextResponse.json({ error: 'AI provider returned invalid JSON', raw: text }, { status: 500 });
    }

    if (parsed.type !== 'questions' && parsed.type !== 'schema') {
      return NextResponse.json({ error: 'Unexpected response shape', raw: text }, { status: 500 });
    }

    if (parsed.type === 'schema') {
      const s = parsed.schema as Record<string, unknown>;
      const sections = Array.isArray(s.sections) ? s.sections as Array<{type?: string}> : [];
      console.log('[generate] schema section types:', sections.map(sec => sec.type).join(' → '));
      console.log('[generate] hero headline:', (s.hero as Record<string, unknown>)?.headline);
    }

    return NextResponse.json({
      ...parsed,
      ...(competitorContext?.screenshots?.length ? { competitor_screenshots: competitorContext.screenshots } : {}),
      ...(competitorContext?.cssTokens ? { competitor_css_tokens: competitorContext.cssTokens } : {}),
      ...(competitorContext?.pageContent ? { competitor_page_content: competitorContext.pageContent } : {}),
    });
  } catch (err) {
    console.error('[pages/generate]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

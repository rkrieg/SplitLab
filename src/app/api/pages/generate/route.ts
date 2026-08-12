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
import {
  userWantsCustomOrMinimalPage,
  injectBrandAssetsIntoSchema,
  classifyPageShapeIntent,
  stripUnpromptedSocialProof,
} from '@/lib/ai-brand-assets';
import {
  userAskedForSocialProof,
  isDesignReferenceAsk,
  extractDesignReferenceCopy,
  looksLikeMultiIntent,
} from '@/lib/ai-follow-up-helpers';
import type { AIContent, AIContentBlock, AIMessage } from '@/lib/ai-client';
import {
  REQUIREMENT_EXTRACTION_INSTRUCTION,
  parseModelRequirements,
} from '@/lib/ai-page-requirements';

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
{"type":"schema","schema":{...},"requirements":[...]}

### "requirements" (schema shape only)
${REQUIREMENT_EXTRACTION_INSTRUCTION}

On a brand-new page there is no "before", so never emit "section_changed". Section names available here are "nav", "hero", "footer", and the "type" of any section you put in the schema.

## When to ask questions vs build immediately
Ask questions ONLY if the prompt is missing ALL of: a goal, specific sections, or business details.
If the user says "surprise me", "just build it", "you decide", or "feel free" — generate immediately. Never ask again on those.
If you already asked clarifying questions in a prior turn and the user answered (even vaguely or with "you decide"), BUILD — do not ask another round.
You may ask more than one round only when still genuinely blocked (e.g. no business at all AND no goal). Prefer building with reasonable defaults over interrogation. Maximum 3 questions per round.

## Multi-part first prompts (mandatory)
If the user lists MULTIPLE requirements in one message (numbered/bulleted list, "also", "and then", several section asks), satisfy ALL of them in a single schema. Do not drop secondary asks. Prefer building over asking questions when the brief already lists concrete requirements — clarifying rounds must not erase earlier asks.

## Design / screenshot references
When the user attaches a screenshot/design image and asks to match look/copy (footer, nav, hero, "like this"), read the image(s) and put the visible copy into the matching schema fields (especially footer/nav/hero). Prefer exact visible phrases over invented filler.

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
- **Page shape follows the user — never a fixed section count.** Infer size from the prompt:
  - Minimal / thank-you / confirmation / "dead-end" / "just a hero" / "hero + footer only" → hero (+ optional tiny footer/nav). Zero or almost no mid-page sections. Do NOT pad with fake features/FAQ/testimonials.
  - Focused landing (a few named sections) → only those sections (+ hero/footer as needed).
  - Full offer / marketing LP with no size constraint → typically 3–7 mid-page sections; vary the mix.
- Do NOT invent fake statistics, awards, client logos, "as seen in" bars, or social-proof numbers unless the user provided them or explicitly asked for social proof / testimonials / stats. Prefer omitting proof sections over fabricating them.
- If the user asked for a confirmation / thank-you / dead-end / hero-only page: do NOT add stats, logo walls, testimonials, or mid-page marketing sections they did not request.
- JSON validity is non-negotiable. If any copy you write — including phrases quoted or reused from the user's prompt — contains a double-quote character, you MUST escape it as \" inside the JSON string. Never emit a literal unescaped " inside a string value.

## Visual-first bias — nobody reads landing pages, they skim
Real users skim H1s, glance at images/icons, and scroll. A wall of paragraphs loses them. Do NOT default to text-only sections. When the page has mid-page sections, prefer types that pair copy with a real photo (image+text split, card grid with photos) or an icon over plain paragraph/list blocks — visuals should dominate, not text. Minimal/confirmation pages may be mostly typography on a flat background — that is fine when the user asked for simple.

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
| features / benefits / services / how_it_works | Add ONE image_prompt on the section (or on the lead item) unless the section is purely icon-driven — a supporting photo that illustrates the point beats an icon-only wall |
| nav / stats / pricing / faq / footer / comparison / logo_wall / guarantee / urgency_banner | NEVER |

Default to using image_prompt on every eligible section rather than skipping it — treat "no image" as the exception, not the default. Maximum 10 total image_prompts across the entire schema. Priority order: hero first, gallery items, team/testimonials, features/benefits, other sections.

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
    const { prompt, vertical, conversation_json, workspace_id, image_urls } = await request.json();

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
          { error: 'AI page generation requires a Growth, Agency, or Scale plan. Please upgrade to use this feature.', limitError: true },
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
    let minimalOrCustom = false;
    if (competitorContext) {
      if (userWantsCustomOrMinimalPage(prompt)) {
        minimalOrCustom = true;
      } else {
        minimalOrCustom = (await classifyPageShapeIntent(prompt)) === 'minimal_or_custom';
      }
    }
    if (competitorContext) {
      console.log('[competitor] cssTokens:\n', competitorContext.cssTokens || '(empty)');
      console.log('[competitor] pageContent length:', competitorContext.pageContent?.length ?? 0);
      console.log('[competitor] screenshots count:', competitorContext.screenshots?.length ?? 0);
      console.log('[competitor] logoUrl:', competitorContext.logoUrl);
      console.log('[competitor] hasLogoSvg:', !!competitorContext.logoSvgMarkup);
      console.log('[competitor] minimalOrCustomShape:', minimalOrCustom);
    }

    const logoNote = competitorContext?.logoUrl
      ? `\nREAL LOGO ASSET (mandatory): Use this exact URL as the nav/footer logo <img src> — never paste a screenshot thumbnail or invent a mark:\n${competitorContext.logoUrl}\nPut logo_url / logo_src on nav and footer in the schema.\n`
      : competitorContext?.logoSvgMarkup
        ? `\nREAL LOGO SVG was extracted from the site header/nav. The build step will host it — put logo_url placeholder "INLINE_SVG_LOGO" on nav/footer and do NOT use a screenshot crop as the logo.\n`
        : `\nNo extractable logo <img> or header SVG was found — do NOT use a screenshot crop as a logo. Use text wordmark only, never a full-page screenshot image.\n`;

    const footerNote =
      competitorContext &&
      (competitorContext.footerContact.address ||
        competitorContext.footerContact.email ||
        competitorContext.footerContact.copyright)
        ? `\nFOOTER CONTACT (use these exact strings when the user wants a footer):\n${JSON.stringify(competitorContext.footerContact)}\n`
        : '';

    const referenceImagesNote =
      competitorContext && competitorContext.referenceImageUrls.length > 0
        ? `\nREAL SITE PHOTOS (optional — only when the user wants real headshots/product photos from the site; prefer these exact URLs over inventing image_prompt for those slots):\n${competitorContext.referenceImageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\nPut the URL on the schema field as image_url / photo_url when using one. Do NOT use these as the logo.\n`
        : '';

    const tasteNote = minimalOrCustom
      ? `\nMINIMAL PAGE TASTE:\n- Strong hierarchy: one clear H1, short supporting line, generous whitespace, flat or near-flat background\n- No decorative card chrome, no competing CTAs, no mid-page clutter\n- Type scale slightly calmer than a full marketing LP (still clamp()-based)\n`
      : '';

    const competitorNote = competitorContext
      ? minimalOrCustom
        ? `\n\n## Reference site context — STYLE + ASSETS ONLY (user asked for a custom/minimal page)\nReference URL: ${urls[0]}\nThe user's instruction OVERRIDES full-page cloning. Follow THEIR shape (e.g. confirmation/hero-only, no CTAs) even if the reference site has many sections.\nUse the reference for: colors/fonts (CSS tokens), logo, optional KPIs/stats they mentioned, flat background feel.\nDo NOT copy every section, nav links, or CTAs from the reference unless the user asked for them.\n\n${competitorContext.cssTokens ? `CSS token analysis:\n${competitorContext.cssTokens}\n\n` : ''}${competitorContext.pageContent ? `Reference site HTML (extract logo text, KPI numbers, colors, footer contact — NOT a full section clone):\n${competitorContext.pageContent.slice(0, 20_000)}\n\n` : ''}${logoNote}${footerNote}${referenceImagesNote}${tasteNote}CRITICAL:\n- Page shape follows the USER prompt first\n- If they said no buttons / no CTAs — schema must have none\n- If they gave exact headline copy — use it verbatim\n- Prefer hero (+ optional stats/KPIs + simple footer) when they asked for a simple confirmation page\n- Do NOT invent fake KPIs — only use numbers present in the reference HTML or user prompt`
        : `\n\n## Reference site context — MANDATORY\nThe user wants a page that closely replicates: ${urls[0]}\n\n${competitorContext.cssTokens ? `CSS token analysis:\n${competitorContext.cssTokens}\n\n` : ''}${competitorContext.pageContent ? `Reference site HTML (use to extract real copy, nav links, headlines, CTAs, section structure):\n${competitorContext.pageContent}\n\n` : ''}${logoNote}${footerNote}${referenceImagesNote}CRITICAL SCHEMA RULES when a reference site is provided AND the user did not ask for a minimal/custom shape:\n- Read the HTML above and extract the REAL headline text, subheadline, CTA button text, nav links, feature titles, testimonial copy — use the actual words from the site, not invented placeholders\n- Match the SECTION ORDER and TYPES from the reference unless the user explicitly removed sections\n- Replicate the nav link labels exactly as they appear on the reference site\n- Use the reference site's actual CTA button text, not generic "Get Started"\n- ALWAYS use the REAL LOGO ASSET URL above for nav/footer — never a screenshot thumbnail\n- Do NOT invent fake statistics — use real numbers from the reference HTML or omit`
      : '';

    const attachedImageUrls = Array.isArray(image_urls)
      ? (image_urls as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim().length > 0).slice(0, 3)
      : [];
    const designAsk =
      attachedImageUrls.length > 0 &&
      (isDesignReferenceAsk(prompt) ||
        /\b(screenshot|design|mockup|reference|like this|match this|footer|nav|hero)\b/i.test(prompt));

    let designCopyLines: string[] = [];
    if (designAsk) {
      designCopyLines = await extractDesignReferenceCopy({
        imageUrls: attachedImageUrls,
        prompt,
      });
      console.log('[pages/generate] design-ref OCR', { lines: designCopyLines.length, designAsk });
    }

    const multiNote = looksLikeMultiIntent(prompt)
      ? `\n\nMULTI-PART REQUEST: Cover EVERY distinct ask in this prompt in one schema (all listed sections, copy, and constraints). Do not ask clarifying questions just to defer secondary asks — build now.\n`
      : '';

    const designNote =
      designCopyLines.length > 0
        ? `\n\n## REQUIRED copy from attached design screenshot (use verbatim in matching sections)\n${designCopyLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\nPut these into footer/nav/hero (or the section the user named). Do not invent substitute legal/contact lines when these are present.\n`
        : attachedImageUrls.length > 0
          ? `\n\nThe user attached ${attachedImageUrls.length} image(s) as design/content reference — read them and reflect visible layout/copy in the schema.\n`
          : '';

    const finalUserText = prompt + competitorNote + multiNote + designNote;

    const historyMessages: AIMessage[] = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const lastUserContent: AIContent =
      attachedImageUrls.length > 0
        ? [
            ...attachedImageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
            { type: 'text', text: finalUserText },
          ]
        : finalUserText;

    const messages: AIMessage[] = [
      ...historyMessages,
      { role: 'user', content: lastUserContent },
    ];

    let text: string;
    try {
      text = await askAI({ system: systemPrompt, messages, maxTokens: 128000, label: 'generate' });
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

    // The model's own checklist of what this brief demands, written in the same
    // call that produced the schema. Validated here; the build step merges it
    // with the regex floor and verifies it against the finished HTML.
    const modelRequirements =
      parsed.type === 'schema' ? parseModelRequirements(parsed) : [];

    if (parsed.type === 'schema') {
      let schema = parsed.schema as Record<string, unknown>;
      if (competitorContext?.logoUrl || (competitorContext?.footerContact && Object.keys(competitorContext.footerContact).length > 0)) {
        schema = injectBrandAssetsIntoSchema(schema, {
          logoUrl: competitorContext.logoUrl,
          footer: competitorContext.footerContact,
        });
      }
      const keepProof =
        userAskedForSocialProof(prompt) || (!!competitorContext && !minimalOrCustom);
      schema = stripUnpromptedSocialProof(schema, prompt, keepProof);
      parsed = { ...parsed, schema };
      const s = schema;
      const sections = Array.isArray(s.sections) ? s.sections as Array<{type?: string}> : [];
      console.log('[generate] schema section types:', sections.map(sec => sec.type).join(' → '));
      console.log('[generate] hero headline:', (s.hero as Record<string, unknown>)?.headline);
      console.log('[generate] brand_logo_url:', s.brand_logo_url ?? (s.nav as Record<string, unknown>)?.logo_url);
    }

    return NextResponse.json({
      ...parsed,
      ...(competitorContext?.screenshots?.length ? { competitor_screenshots: competitorContext.screenshots } : {}),
      ...(competitorContext?.cssTokens ? { competitor_css_tokens: competitorContext.cssTokens } : {}),
      ...(competitorContext?.pageContent ? { competitor_page_content: competitorContext.pageContent } : {}),
      ...(competitorContext?.logoUrl ? { competitor_logo_url: competitorContext.logoUrl } : {}),
      ...(competitorContext?.logoSvgMarkup ? { competitor_logo_svg: competitorContext.logoSvgMarkup } : {}),
      ...(competitorContext?.footerContact && Object.keys(competitorContext.footerContact).length > 0
        ? { competitor_footer_contact: competitorContext.footerContact }
        : {}),
      ...(minimalOrCustom ? { user_shape_intent: 'minimal_or_custom' } : {}),
      ...(designCopyLines.length > 0 ? { design_copy_lines: designCopyLines } : {}),
      ...(modelRequirements.length > 0 ? { requirements: modelRequirements } : {}),
    });
  } catch (err) {
    console.error('[pages/generate]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

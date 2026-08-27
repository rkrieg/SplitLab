import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { jsonrepair } from 'jsonrepair';
import { askAIStream, isRateLimited, AIResponseTruncatedError } from '@/lib/ai-client';
import { VERTICAL_VALUES } from '@/lib/ai-page-verticals';
import { assembleSystemPrompt, resolveSkills, skillIds, LOCKED_RULES_GENERATE } from '@/lib/skills';
import { SECTION_VOCABULARY, VERTICAL_PRIORITY_HINTS } from '@/lib/ai-page-vocabulary';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { extractUrls, isEmbedAssetUrl, scrapeCompetitorUrl, describeScrapeGaps } from '@/lib/ai-competitor-scrape';
import { remainingInputChars } from '@/lib/ai-context-budget';
import { classifyAssetSource } from '@/lib/asset-source-resolver';
import {
  injectBrandAssetsIntoSchema,
  classifyPageShapeIntent,
  classifyCompetitorReferenceUrl,
  stripUnpromptedSocialProof,
} from '@/lib/ai-brand-assets';
import {
  extractDesignReferenceCopy,
} from '@/lib/ai-follow-up-helpers';
import type { AIContent, AIContentBlock, AIMessage } from '@/lib/ai-client';
import {
  REQUIREMENT_EXTRACTION_INSTRUCTION,
  parseModelRequirements,
} from '@/lib/ai-page-requirements';
import { buildConversationContext, classifyEditIntent, MAX_ATTACHMENTS } from '@/lib/ai-edit-intent';

/**
 * Ceiling on client-supplied images the schema step both SEES and receives
 * URLs for.
 *
 * Matches the picker's own selection cap, so every image a user was allowed to
 * tick actually reaches the model — a lower number here would drop images the
 * UI had already promised to use.
 *
 * Deliberately NOT MAX_ATTACHMENTS. That constant caps images sent to the
 * classifier calls (intent, OCR, edit routing), and it stays at 3: those calls
 * decide "is this a design reference or a photo to place", which a filename
 * already answers, so paying vision cost times eight call sites buys nothing.
 * Only THIS call — the one that decides what goes in which slot — needs to
 * look at the photographs, so only this one pays for it.
 */
const MAX_LIBRARY_ASSETS = 20;

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

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

## Attached images
You can SEE every attached image. The instruction says what each one is for — a look to copy, a photo/logo to put on the page, a pointer, or mixed. Put a URL on schema image/logo fields ONLY when the user wants that file itself on the page. Never use a screenshot of a page as a logo or content photo. When they asked to match look/copy from a screenshot, read it and put the visible copy into the matching schema fields (especially footer/nav/hero). Prefer exact visible phrases over invented filler.

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

Use ONLY the keys shown above for hero/footer/nav — never add extra keys (e.g. no
footer.address, footer.phone, etc.) unless the brief explicitly requires a field that has no
home in this structure, in which case use the closest matching section type instead of
inventing a top-level key.

## Section types (available moves — pick a varied combination per page, not the same 4-5 every time)
${SECTION_TYPES_BLOCK}

## Escape hatch — when nothing above fits
If part of the brief explicitly describes something visual or interactive that none of the types above can represent (a schematic diagram, a custom map, a flowchart, a bespoke widget) — do NOT force it into the nearest type just because it superficially resembles one (e.g. do not turn a diagram into "stats" cards just because it has labeled facts). Use "custom_block" instead and carry the description verbatim into its "description" field, including any explicit constraints from the brief (e.g. "no external map tiles or APIs"). This is a last resort for content that genuinely has no fit — most sections belong to one of the types above.

## Content rules
- Write real, compelling copy based on the business. No placeholders, no lorem ipsum.
- The user has pre-selected a vertical — treat it as a bias toward certain section types (see the per-vertical hint appended below), not a fixed template. Refine based on the specific prompt.
- **Page shape follows the user — never a fixed section count.** Infer size from the prompt:
  - Minimal / thank-you / confirmation / "dead-end" / "just a hero" / "hero + footer only" → hero (+ optional tiny footer/nav). Zero or almost no mid-page sections. Do NOT pad with fake features/FAQ/testimonials.
  - Focused landing (a few named sections) → only those sections (+ hero/footer as needed).
  - Full offer / marketing LP with no size constraint → typically 3–7 mid-page sections; vary the mix.
- Do NOT invent fake statistics, awards, client logos, "as seen in" bars, or social-proof numbers unless the user provided them or explicitly asked for social proof / testimonials / stats. Prefer omitting proof sections over fabricating them.
- If the user asked for a confirmation / thank-you / dead-end / hero-only page: do NOT add stats, logo walls, testimonials, or mid-page marketing sections they did not request.
- When the prompt/PRD gives exact, verbatim text for legal, compliance, copyright, or footer copy, use it byte-for-byte — never paraphrase, shorten, or invent a replacement. This is especially strict for footer.copyright and any disclaimer/legal text explicitly quoted in the brief.
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
| custom_block | Case-by-case — only if the description explicitly calls for a real photo (not a diagram/illustration, which the build step draws itself) |

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
    const { prompt, vertical, conversation_json, workspace_id, image_urls, asset_library, skills } = await request.json();

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

    // Unknown ids are dropped, not rejected: a stale tab or a page saved under
    // a renamed skill must still generate rather than 400.
    const selectedSkills = resolveSkills(skills);

    // base -> LOCKED -> vertical -> skills. Assembled in one pure function so
    // the order (which IS the override model) cannot drift by hand-editing.
    const systemPrompt = assembleSystemPrompt({
      base: SYSTEM_PROMPT,
      locked: LOCKED_RULES_GENERATE,
      verticalNote: selectedVertical
        ? `The user selected vertical: ${selectedVertical}.${priorityHint ? ` ${priorityHint}` : ''}`
        : null,
      skills: selectedSkills,
      stage: 'generate',
    });

    const history: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(conversation_json)
      ? conversation_json
      : [];

    // Scrape competitor site if the prompt contains a URL — must complete BEFORE schema generation
    // so the schema reflects the competitor's actual section count and order.
    //
    // An asset SOURCE in the brief is not a site to clone. A Drive folder link
    // pasted into a PRD would otherwise be handed to the scraper, which returns
    // Google Drive's own chrome — nav, colors, footer — and that context then
    // steers the schema, exactly the way a Mux embed URL once produced
    // "© Mux, Inc." in a client's footer. Same class of bug, different host.
    const candidateUrls = extractUrls(prompt).filter(
      (u) => !isEmbedAssetUrl(u) && classifyAssetSource(u) === 'webpage',
    );
    // No longer "urls[0] wins by default": which URL (if any) is actually a
    // design reference to clone is a judgement call, not a positional one —
    // see classifyCompetitorReferenceUrl's own comment for why urls[0] used to
    // get scraped even when the brief explicitly said not to clone it.
    const referenceUrl =
      candidateUrls.length > 0 ? await classifyCompetitorReferenceUrl(prompt, candidateUrls) : null;
    const competitorContext = referenceUrl ? await scrapeCompetitorUrl(referenceUrl) : null;
    let minimalOrCustom = false;
    if (competitorContext) {
      // Model-decided, with no keyword fallback either side of it. If the model
      // can't answer, we report an outage — guessing here decides whether the
      // whole page clones a reference site or stays a one-section confirmation,
      // which is far too big a call to make from punctuation.
      const shape = await classifyPageShapeIntent(prompt);
      if (shape === null) {
        return NextResponse.json(
          {
            error:
              'The AI service didn’t respond properly just now — nothing was created. Please try again in a moment.',
          },
          { status: 503 },
        );
      }
      minimalOrCustom = shape === 'minimal_or_custom';
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

    // "optional" is what put a fabricated stock photo on a client's page.
    //
    // These are the reference site's REAL photographs, already extracted. The
    // note used to open with "(optional — only when the user wants real
    // headshots/product photos)", nothing enforced it, and the schema model
    // reasonably read that as permission to skip them. It wrote an image_prompt
    // instead and we paid an image model to invent a lawyer sitting in a fake
    // office — on a page whose whole purpose was to look like that firm's site.
    //
    // Still not a hard requirement, because declining CAN be right: a photo may
    // suit no slot on the page being built. What changed is the default. Use
    // the real one unless there is a reason not to, and generating over the top
    // of a real photo of the actual business is called out as the error it is.
    const referenceImagesNote =
      competitorContext && competitorContext.referenceImageUrls.length > 0
        ? `\n## REAL PHOTOS FROM THE REFERENCE SITE — prefer these over generating any image\nThese ${competitorContext.referenceImageUrls.length} file(s) are the actual photographs on the site being referenced: its real people, its real premises, its real products.\n${competitorContext.referenceImageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\nRules:\n- Before writing ANY image_prompt, check whether one of these fits the slot. A real photo of the actual business always beats a generated stand-in, and generating a fake photo of a business whose real photos you were handed is a visible error the user will spot straight away.\n- When one fits, set "generated_image_url" on that schema node to the EXACT URL and do NOT also write an "image_prompt" for that node — an image_prompt there would draw a fake photo over a real one.\n- Only write image_prompt for slots that NONE of these fit.\n- Do NOT use any of these as the logo, and never alter the URLs.\n`
        : '';

    const tasteNote = minimalOrCustom
      ? `\nMINIMAL PAGE TASTE:\n- Strong hierarchy: one clear H1, short supporting line, generous whitespace, flat or near-flat background\n- No decorative card chrome, no competing CTAs, no mid-page clutter\n- Type scale slightly calmer than a full marketing LP (still clamp()-based)\n`
      : '';

    // Vision attachments cost window whether or not they are the user's own —
    // counted here so the reference budget below is honest about them.
    const attachedImagesForBudget = Array.isArray(image_urls)
      ? Math.min((image_urls as unknown[]).length, MAX_ATTACHMENTS)
      : 0;

    // ── How much of the reference site can this call actually carry? ────────
    //
    // The scraper no longer truncates (it cannot know what else this call has
    // to send). The number that used to live there — 30,000 characters, with
    // no comment and no arithmetic behind it — silently cut a twelve-section
    // site off after about section eight, and the model, believing it had
    // reached the end of the page, invented an FAQ to fill the space. Four
    // real sections were lost that way on one build.
    //
    // The layers are budgeted in priority order, because they are not equally
    // replaceable:
    //   1. palette + gaps — tiny, and nothing else carries exact colour values
    //   2. markdown — the only layer that reliably fits WHOLE, so it is what
    //      guarantees the bottom of the page (footer, final CTA, a second
    //      city) is present at all
    //   3. html — richest, first to be trimmed, and its loss is survivable
    //      because the screenshot shows structure better than markup does
    const scrapeGaps = competitorContext ? describeScrapeGaps(competitorContext.stats) : '';
    const paletteBlock = competitorContext?.palette
      ? `\n\n## The reference site's ACTUAL colours and fonts (measured from its stylesheets)\n${competitorContext.palette}\n`
      : '';
    const referenceBudget = competitorContext
      ? remainingInputChars({
          usedChars:
            prompt.length +
            systemPrompt.length +
            paletteBlock.length +
            (competitorContext.cssTokens?.length ?? 0) +
            history.reduce((n, h) => n + (h.content?.length ?? 0), 0),
          reservedOutputTokens: 128_000,
          images: attachedImagesForBudget,
        })
      : 0;

    let referenceMarkdown = competitorContext?.markdown ?? '';
    let referenceHtml = competitorContext?.pageContent ?? '';
    let referenceTruncated = false;
    if (competitorContext) {
      // Markdown first. If even markdown does not fit, the site is genuinely
      // enormous — trim it, but say so rather than letting the model believe
      // the page ended where our budget did.
      if (referenceMarkdown.length > referenceBudget) {
        referenceMarkdown = referenceMarkdown.slice(0, Math.max(0, referenceBudget));
        referenceHtml = '';
        referenceTruncated = true;
      } else {
        const left = referenceBudget - referenceMarkdown.length;
        if (referenceHtml.length > left) {
          referenceHtml = left > 4_000 ? referenceHtml.slice(0, left) : '';
          referenceTruncated = true;
        }
      }
      console.log('[pages/generate] reference budget', {
        budgetChars: referenceBudget,
        markdownChars: referenceMarkdown.length,
        htmlChars: referenceHtml.length,
        truncated: referenceTruncated,
        of: { markdown: competitorContext.markdown.length, html: competitorContext.pageContent.length },
      });
    }

    // Stated as a fact and handed over, never acted on here. Whether an
    // incomplete read means "build from what you have" or "ask the user which
    // parts of that site matter" is a judgement about the request, and this
    // call can already answer with clarifying questions — so the decision
    // belongs to it, not to a threshold in code.
    const truncationNote = referenceTruncated
      ? `\n\nHOW MUCH OF THE SITE YOU CAN SEE: this reference site is larger than one pass can read in full, so the text below is cut short — there is more page after it that you have NOT been shown. The screenshot shows the whole page, so use it to see what is down there. If what is missing is material to the brief, either build what you can see and say plainly which parts you could not read, or ask the user which sections of that site matter most. Do not silently invent sections to fill the end of the page.\n`
      : '';

    const referenceContentBlock = [
      referenceMarkdown ? `Reference site content (markdown — the complete copy, headings, links and image URLs):\n${referenceMarkdown}` : '',
      referenceHtml ? `Reference site HTML (structure and markup detail):\n${referenceHtml}` : '',
    ].filter(Boolean).join('\n\n');

    const competitorNote = competitorContext
      ? minimalOrCustom
        ? `\n\n## Reference site context — STYLE + ASSETS ONLY (user asked for a custom/minimal page)\nReference URL: ${referenceUrl}\nThe user's instruction OVERRIDES full-page cloning. Follow THEIR shape (e.g. confirmation/hero-only, no CTAs) even if the reference site has many sections.\nUse the reference for: colors/fonts (see the palette below), logo, optional KPIs/stats they mentioned, flat background feel.\nDo NOT copy every section, nav links, or CTAs from the reference unless the user asked for them.\n\n${competitorContext.cssTokens ? `Layout tokens:\n${competitorContext.cssTokens}\n\n` : ''}${paletteBlock}${scrapeGaps ? `\n${scrapeGaps}\n` : ''}${referenceContentBlock ? `${referenceContentBlock}\n\n` : ''}${truncationNote}${logoNote}${footerNote}${referenceImagesNote}${tasteNote}CRITICAL:\n- Page shape follows the USER prompt first\n- If they said no buttons / no CTAs — schema must have none\n- If they gave exact headline copy — use it verbatim\n- Prefer hero (+ optional stats/KPIs + simple footer) when they asked for a simple confirmation page\n- Do NOT invent fake KPIs — only use numbers present in the reference content or user prompt`
        : `\n\n## Reference site context — MANDATORY\nThe user wants a page that closely replicates: ${referenceUrl}\n\n${competitorContext.cssTokens ? `Layout tokens:\n${competitorContext.cssTokens}\n\n` : ''}${paletteBlock}${scrapeGaps ? `\n${scrapeGaps}\n` : ''}${referenceContentBlock ? `${referenceContentBlock}\n\n` : ''}${truncationNote}${logoNote}${footerNote}${referenceImagesNote}CRITICAL SCHEMA RULES when a reference site is provided AND the user did not ask for a minimal/custom shape:\n- Read the reference content above and extract the REAL headline text, subheadline, CTA button text, nav links, feature titles, testimonial copy — use the actual words from the site, not invented placeholders\n- Match the SECTION ORDER and TYPES from the reference unless the user explicitly removed sections. Include EVERY section the reference has, including the ones near the bottom of the page — footers, closing CTAs, review/testimonial strips and community/about blocks are part of the page, not optional extras\n- If the site serves more than one location, market or audience, carry ALL of them into the schema. Dropping one is a content error, not a simplification\n- Do NOT add sections the reference does not have (an FAQ it never wrote, a generic CTA) to pad the page out\n- Replicate the nav link labels exactly as they appear on the reference site\n- Use the reference site's actual CTA button text, not generic "Get Started"\n- ALWAYS use the REAL LOGO ASSET URL above for nav/footer — never a screenshot thumbnail\n- Do NOT invent fake statistics — use real numbers from the reference content or omit`
      : '';

    const attachedImageUrls = Array.isArray(image_urls)
      ? (image_urls as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim().length > 0).slice(0, MAX_ATTACHMENTS)
      : [];
    // What is this person asking for? One model call, same as the edit path —
    // keyword matching decides nothing it can get wrong on its own here either.
    // Runs for every prompt, not just ones with attachments: "cover every ask"
    // (multiNote below) needs this on plain text prompts too.
    const createIntent = prompt.trim()
      ? await classifyEditIntent({
          prompt,
          sectionNames: [],
          imageUrls: attachedImageUrls,
          requirementInstruction: REQUIREMENT_EXTRACTION_INSTRUCTION,
          // The schema call below has always been given the history; this one
          // never was. On a round-2 answer ("you decide", "make it blue") it
          // was classifying a fragment with no idea what page was discussed.
          conversation: buildConversationContext(history),
          label: 'generate:edit-intent',
        })
      : null;
    console.log('[pages/generate] intent', createIntent
      ? {
          designReference: createIntent.designReference,
          reuseReferenceCopy: createIntent.reuseReferenceCopy,
          asks: createIntent.asks.length,
        }
      : 'none (no attachments) or unavailable');

    const reuseReferenceWords = !!createIntent?.reuseReferenceCopy;

    // Only read copy off a screenshot when the user actually asked for its
    // words — otherwise a reference headline gets stamped onto a page whose
    // copy they replaced. No keyword guess when intent is missing.
    let designCopyLines: string[] = [];
    if (attachedImageUrls.length > 0 && reuseReferenceWords) {
      designCopyLines = await extractDesignReferenceCopy({
        imageUrls: attachedImageUrls,
        prompt,
      });
      console.log('[pages/generate] design-ref OCR', { lines: designCopyLines.length });
    }

    const hasMultipleAsks = (createIntent?.asks.length ?? 0) > 1;
    const multiNote = hasMultipleAsks
      ? `\n\nMULTI-PART REQUEST: Cover EVERY distinct ask in this prompt in one schema (all listed sections, copy, and constraints). Do not ask clarifying questions just to defer secondary asks — build now.\n`
      : '';

    // Standing conditions ("keep it dark", "no buttons anywhere", "one page
    // only") qualify the whole build. The classifier separates them from the
    // asks so they never become work items; the create path has to actually
    // receive them, or they are simply dropped on the floor here.
    const createConstraints = createIntent?.constraints ?? [];
    const constraintNote =
      createConstraints.length > 0
        ? `\n\nSTANDING CONDITIONS — these apply to the WHOLE page and must hold in the finished schema. They describe how to build, not extra sections to add:\n${createConstraints
            .map((c) => `- ${c}`)
            .join('\n')}\n`
        : '';

    const attachedNote =
      attachedImageUrls.length > 0
        ? `\n\nThe user attached ${attachedImageUrls.length} image(s). You can SEE each one. The instruction says what they are for — a look to copy, a photo/logo to put on the page, or both. Put a URL on schema image/logo fields ONLY when the instruction wants that file ON the page. Never use a screenshot of a page as a logo or content photo.\n`
        : '';
    const designNote =
      designCopyLines.length > 0
        ? `${attachedNote}\n## REQUIRED copy from attached screenshot (use verbatim in matching sections)\n${designCopyLines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\nPut these into footer/nav/hero (or the section the user named). Each line once — if several attachments are the same screenshot, do not repeat blocks. Do not invent substitute legal/contact lines when these are present.\n`
        : attachedNote;

    // Real client photos pulled from a Drive folder / page link the user gave
    // us, already re-hosted on our storage by /api/pages/[id]/import-assets.
    //
    // NOT sent as vision attachments: those are capped at MAX_ATTACHMENTS (3)
    // in every classifier on this path, so a 20-image folder would lose 17 of
    // them silently. A named URL list has no such cap and is what the schema
    // step actually needs — it places URLs, it does not need to look at them.
    //
    // The instruction targets generated_image_url specifically because that is
    // the one image field with teeth on both ends: generatePageImages() skips
    // DALL-E for any node that already has one (ai-client.ts), and the builder
    // prompt forbids ignoring one (ai-page-builder.ts). Writing a real photo
    // there is therefore what stops an invented image replacing it.
    const libraryAssets = Array.isArray(asset_library)
      ? (asset_library as unknown[])
          .filter((a): a is { url: string; name?: string } =>
            !!a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string')
          .map((a) => ({ url: a.url, name: typeof a.name === 'string' ? a.name : 'image' }))
          .slice(0, MAX_LIBRARY_ASSETS)
      : [];

    // Vision accepts JPEG/PNG/GIF/WebP only. An SVG logo — extremely common in
    // a client asset folder — would make the whole schema call fail, taking the
    // page build down with it. Split rather than drop: viewable files are shown
    // AND listed, the rest are still listed by name and URL so they can be
    // placed, just chosen by filename instead of by sight.
    const VIEWABLE_EXT_RE = /\.(png|jpe?g|webp|gif)(?:\?|#|$)/i;
    const viewableAssets = libraryAssets.filter((a) => VIEWABLE_EXT_RE.test(a.url));
    const unviewableAssets = libraryAssets.filter((a) => !VIEWABLE_EXT_RE.test(a.url));

    if (libraryAssets.length > 0) {
      console.log('[pages/generate] asset library', {
        count: libraryAssets.length,
        viewable: viewableAssets.length,
        unviewable: unviewableAssets.length,
      });
    }

    const assetLibraryNote =
      libraryAssets.length > 0
        ? `\n\n## The client's own images — USE THESE, do not invent replacements\nThese ${libraryAssets.length} file(s) are real photos/logos the user supplied for this page. They are already hosted and safe to embed.\n` +
          (viewableAssets.length > 0
            ? `\nYou can SEE these: the last ${viewableAssets.length} image(s) attached to this message are these files, in exactly this order.\n${viewableAssets
                .map((a, i) => `${i + 1}. ${a.name} — ${a.url}`)
                .join('\n')}\n`
            : '') +
          (unviewableAssets.length > 0
            ? `\nThese you CANNOT see (vector/other format) — judge them by filename alone:\n${unviewableAssets
                .map((a, i) => `${i + 1}. ${a.name} — ${a.url}`)
                .join('\n')}\n`
            : '') +
          `\nRules:\n- For the files you can see, decide where each belongs by LOOKING at it. What the photo actually shows outranks its filename — "IMG_4821.jpg" means nothing, and a file named "hero" may not suit the hero.\n- When one of these fits a slot, set "generated_image_url" on that schema node to the EXACT URL above and do NOT also write an "image_prompt" for that node — an image_prompt there would have us draw a fake photo over a real one.\n- A logo belongs on nav/footer logo_url, never as a content photo. A headshot belongs on a person, not a hero.\n- Only write image_prompt for slots NONE of these files fit.\n- Never alter these URLs, and never reuse the same file for two different slots unless the page genuinely needs it twice.\n- If the user's instruction says where a specific file goes, that beats what you infer from the picture.\n`
        : '';

    const finalUserText = prompt + competitorNote + multiNote + constraintNote + designNote + assetLibraryNote;

    const historyMessages: AIMessage[] = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Library images go AFTER the user's own attachments and in the same order
    // as the numbered list in assetLibraryNote — that ordering is the only way
    // the model can tell which picture belongs to which URL, so both must be
    // built from viewableAssets and nothing else.
    const visionBlocks: AIContentBlock[] = [
      ...attachedImageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
      ...viewableAssets.map((a): AIContentBlock => ({ type: 'image', url: a.url })),
    ];

    const lastUserContent: AIContent =
      visionBlocks.length > 0
        ? [...visionBlocks, { type: 'text', text: finalUserText }]
        : finalUserText;

    const messages: AIMessage[] = [
      ...historyMessages,
      { role: 'user', content: lastUserContent },
    ];

    let text: string;
    try {
      // Streamed, not a single blocking call — competitor scrape + a large
      // schema can take 30-90+ seconds, and a connection with zero bytes
      // moving that long reads as dead to anything watching it (confirmed:
      // 502s from a dev tunnel on this exact call). Streaming keeps bytes
      // moving so the connection stays alive; the chunks themselves are
      // unused here since the JSON is only parsed once complete.
      text = await askAIStream(
        { system: systemPrompt, messages, maxTokens: 128000, label: 'generate' },
        () => {},
      );
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
      // Whether the user asked for stats/testimonials/logo walls is a question
      // about meaning, so the classifier answers it — not a keyword list.
      // Stripping is the destructive action here, so when the classifier is
      // unavailable we keep everything rather than delete sections based on a
      // keyword guess about whether stats were wanted.
      const keepProof = !createIntent
        ? true
        : createIntent.wantsSocialProof || (!!competitorContext && !minimalOrCustom);
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
      // Echoed back so build and the page record use the SERVER's validated
      // list, not whatever the tab happened to have ticked. Always includes the
      // mandatory skill even if the client sent nothing.
      skills: skillIds(selectedSkills),
      ...(competitorContext?.screenshots?.length ? { competitor_screenshots: competitorContext.screenshots } : {}),
      ...(competitorContext?.cssTokens ? { competitor_css_tokens: competitorContext.cssTokens } : {}),
      // The measured colours/fonts. Build needs these more than generate does —
      // it is the call that writes :root — and re-scraping there would double
      // the cost of every build for the same bytes.
      ...(competitorContext?.palette ? { competitor_palette: competitorContext.palette } : {}),
      // Budgeted to what the BUILD call can carry, not to what this one sent.
      // Passing the raw page through would have the client POST a megabyte
      // back to us for a call that cannot use most of it.
      ...(referenceContentBlock ? { competitor_page_content: referenceContentBlock.slice(0, 150_000) } : {}),
      ...(scrapeGaps ? { competitor_scrape_gaps: scrapeGaps } : {}),
      ...(competitorContext?.logoUrl ? { competitor_logo_url: competitorContext.logoUrl } : {}),
      ...(competitorContext?.logoSvgMarkup ? { competitor_logo_svg: competitorContext.logoSvgMarkup } : {}),
      ...(competitorContext?.footerContact && Object.keys(competitorContext.footerContact).length > 0
        ? { competitor_footer_contact: competitorContext.footerContact }
        : {}),
      ...(minimalOrCustom ? { user_shape_intent: 'minimal_or_custom' } : {}),
      ...(designCopyLines.length > 0 ? { design_copy_lines: designCopyLines } : {}),
      // Whether the screenshot's WORDS belong on the page — decided here, not
      // re-guessed by build. Attachment role (look vs photo vs mixed) is NOT
      // forwarded as a boolean; that was the embed-all / embed-none hurdle.
      ...(attachedImageUrls.length > 0 ? { reuse_reference_copy: reuseReferenceWords } : {}),
      // Where the screenshot's copy belongs, decided by the model that read the
      // request. Build places it ONLY here — no section named, no placement.
      ...(designCopyLines.length > 0 && createIntent && createIntent.targetSections.length > 0
        ? { design_copy_sections: createIntent.targetSections }
        : {}),
      ...(modelRequirements.length > 0 ? { requirements: modelRequirements } : {}),
    });
  } catch (err) {
    console.error('[pages/generate]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

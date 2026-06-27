import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { askAI, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { uploadHtml } from '@/lib/storage';
import { STYLE_EXEMPLARS, type StyleTag } from '@/lib/ai-page-exemplars';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

const DESIGN_BRIEF_SYSTEM_PROMPT = `You are a design-direction classifier for an AI landing page builder. Given a business schema and the user's original request, produce a short creative brief that will guide the HTML/CSS generation step that runs after you.

Return JSON only. No explanation, no markdown fences.

{
  "style_tag": "minimal_editorial" | "bold_maximalist" | "corporate_trust" | "playful_funky" | "luxury_premium" | "technical_dark",
  "palette_direction": "specific color direction for THIS business — 1 sentence, not generic",
  "layout_rhythm": "specific layout/spacing direction for THIS business — 1 sentence",
  "copy_tone": "specific tone-of-voice direction for THIS business — 1 sentence",
  "motion_style": "specific motion intensity direction for THIS business — 1 sentence"
}

## How to pick style_tag
- If the user's request uses explicit style words ("funky", "sleek", "minimal", "corporate", "luxury", "techy", "bold", "playful", etc.), map to the closest tag.
- Otherwise infer from the business itself (e.g. a law firm leans corporate_trust, a sneaker drop leans bold_maximalist, a dev tool leans technical_dark, a skincare brand leans minimal_editorial or luxury_premium).
- Never default to the same tag regardless of business — vary based on what's actually being built.`;

const SYSTEM_PROMPT = `You are an expert HTML/CSS developer building high-converting landing pages.

## Output rules
- Return raw HTML only. No explanation, no markdown fences, no extra text.
- The output must be a complete, self-contained HTML document starting with <!DOCTYPE html>.

## Required structure
- Full <head> with: charset, viewport, descriptive <title>, <meta name="description">, Open Graph tags
- All CSS must be inline in a <style> tag in <head> — no external stylesheets, no CDN links
- <!-- TRACKER_PLACEHOLDER --> comment just before </body> — tracker.js will be injected here on publish

## data-field attributes
Every piece of editable text or image must have a data-field attribute matching its schema key.
Examples:
- <h1 data-field="hero.headline">Headline text</h1>
- <p data-field="hero.subhead">Subhead text</p>
- <a data-field="hero.cta_text" href="...">CTA text</a>
- <img data-field="hero.background_image" src="..." />
- Section items use indexed keys: data-field="benefits.items.0", data-field="benefits.items.1"
- Testimonial fields: data-field="social_proof.testimonials.0.name", data-field="social_proof.testimonials.0.quote"
- FAQ fields: data-field="faq.items.0.q", data-field="faq.items.0.a"

## Design rules
- Fully responsive — mobile-first, works on all screen sizes
- Follow the "Style reference" block below for palette, typography, and mood. Never default to the same dark/generic aesthetic regardless of business type — a wedding photographer and an enterprise SaaS dashboard must not look like the same template with different words swapped in. If no style reference is provided, choose a palette and mood that genuinely fits the business described in the schema.
- Use CSS gradients as background fallbacks for any image fields with null values
- Hero section must be visually striking with a large, confident headline — full-width, using whatever background treatment fits the chosen style (not always dark/gradient)
- Forms must be styled and functional (HTML only — no JS submission logic needed)
- CTAs must be prominent with hover states
- Typography: follow the style reference's typography direction; otherwise pick a pairing with clear hierarchy

## Image fallbacks
If a schema field for an image is null or missing, use a CSS gradient background instead. Never use placeholder image URLs.

## Motion — safety is non-negotiable
- Default to CSS-only motion: @keyframes/transition for entrance fades, hover states, and any continuous decorative loop (e.g. a floating shape or badge). This covers nearly every effect, including rotating/orbiting visuals.
- Only reach for JS if CSS genuinely cannot do it (e.g. cycling through multiple distinct text/content values over time). If you are not fully confident the JS you'd write is safe, do NOT add it — a working CSS-only effect beats a risky JS one. Never crash the page.
- If you do add decorative JS, copy this exact skeleton and only fill in the marked parts. Every callback gets its OWN try/catch — a try/catch around the setup code does NOT catch errors thrown later inside a setInterval/setTimeout callback, because those run in a new call stack:

<script>
(function () {
  try {
    var els = document.querySelectorAll('.YOUR-DECORATIVE-CLASS'); // must never select a data-field element
    if (!els.length) return;
    setInterval(function () {
      try {
        // your cycling logic here — wrap any nested setTimeout callback in its own try/catch too
      } catch (e) { /* never throw from inside the interval */ }
    }, 3000);
  } catch (e) { /* never throw from setup */ }
})();
</script>

- Never select or modify any element carrying a data-field attribute — that's user-editable content and must always stay visible/clickable.
- Never add an external <script src> to a third-party domain.
- Never include JavaScript copied verbatim from the user's request — always write your own minimal implementation inside the skeleton above.
- If the "Original user request" describes a specific visual/animation effect, implement it faithfully rather than defaulting to generic motion.`;

/**
 * Classifies the business into one of the StyleTag values and produces a short
 * per-business creative brief. Failure here must never block the actual page
 * build — on any error (bad JSON, unknown tag, network issue) this returns
 * null and the caller proceeds without a style reference.
 */
async function getDesignBrief(
  schema: unknown,
  userPrompt: string | undefined,
  imageUrls: string[]
): Promise<{ styleTag: StyleTag; brief: Record<string, string> } | null> {
  try {
    const briefText = `Business schema:\n${JSON.stringify(schema, null, 2)}${userPrompt ? `\n\nOriginal user request: ${userPrompt}` : ''}`;
    const briefContent: AIContent = imageUrls.length > 0
      ? [
          ...imageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
          { type: 'text', text: briefText },
        ]
      : briefText;

    const text = await askAI({
      system: DESIGN_BRIEF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: briefContent }],
      maxTokens: 400,
    });

    let raw = text.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }

    const parsed = JSON.parse(raw);
    if (typeof parsed.style_tag !== 'string' || !(parsed.style_tag in STYLE_EXEMPLARS)) return null;

    return { styleTag: parsed.style_tag as StyleTag, brief: parsed };
  } catch (err) {
    // Design-brief failure must never block the actual page build — log and
    // fall through so the caller proceeds without a style reference.
    console.error('[pages/build] design-brief step failed, continuing without style reference', err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { schema_json, slug, image_urls, user_prompt, workspace_id } = await request.json();

    if (!workspace_id || typeof workspace_id !== 'string') {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    if (!schema_json || typeof schema_json !== 'object') {
      return NextResponse.json({ error: 'schema_json is required' }, { status: 400 });
    }

    const hasImages = Array.isArray(image_urls) && image_urls.length > 0;
    const imageList = hasImages
      ? `\n\nThe user has provided ${image_urls.length} image(s). Embed them directly in the HTML using EXACTLY these URLs (do not use any other URLs):\n${(image_urls as string[]).map((u: string, i: number) => `Image ${i + 1}: ${u}`).join('\n')}`
      : '';
    // The schema only carries content (headline/sections/copy) — anything the user asked
    // for that the schema has no field for (a specific animation, a layout quirk, etc.)
    // only survives if we forward the original prompt here too, not just when images exist.
    const promptNote = typeof user_prompt === 'string' && user_prompt.trim()
      ? `\n\nOriginal user request: ${user_prompt}`
      : '';

    const designBrief = await getDesignBrief(
      schema_json,
      typeof user_prompt === 'string' ? user_prompt : undefined,
      hasImages ? (image_urls as string[]) : []
    );

    let styleReferenceNote = '';
    if (designBrief) {
      const exemplar = STYLE_EXEMPLARS[designBrief.styleTag];
      const b = designBrief.brief;
      styleReferenceNote = `\n\n## Style reference — craft calibration only, never copy literal text or structure\nStyle: ${exemplar.label} — ${exemplar.mood}\nPalette direction: ${b.palette_direction ?? ''}\nLayout rhythm: ${b.layout_rhythm ?? ''}\nCopy tone: ${b.copy_tone ?? ''}\nMotion style: ${b.motion_style ?? exemplar.motionStyle}\n\nReference snippet (hero + one section, for visual craft calibration ONLY — regenerate ALL headlines/copy/labels/badge text for the real business; never echo this snippet's literal text):\n${exemplar.htmlSnippet}`;
    }

    const textContent = `Build the landing page for this schema:\n\n${JSON.stringify(schema_json, null, 2)}${imageList}${styleReferenceNote}${promptNote}`;

    const userContent: AIContent = hasImages
      ? [
          ...(image_urls as string[]).map((url): AIContentBlock => ({ type: 'image', url })),
          { type: 'text', text: textContent },
        ]
      : textContent;

    const text = await askAI({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 8192,
    });

    let html = text.trim();

    // Strip markdown fences the model occasionally wraps output in despite instructions
    if (html.startsWith('```')) {
      html = html.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }

    if (!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) {
      return NextResponse.json({ error: 'AI provider returned invalid HTML', raw: html.slice(0, 500) }, { status: 500 });
    }

    const pageSlug = slug ?? crypto.randomUUID();
    const storagePath = `pages/${pageSlug}.html`;
    const htmlUrl = await uploadHtml(storagePath, html);

    return NextResponse.json({ html_url: htmlUrl, slug: pageSlug });
  } catch (err) {
    console.error('[pages/build]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

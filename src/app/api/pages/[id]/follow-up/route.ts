import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { askAI, isRateLimited, generatePageImages, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { extractUrls, scrapeCompetitorUrl } from '@/lib/ai-competitor-scrape';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';

const SYSTEM_PROMPT = `You are editing an existing landing page. The user will give you an instruction to modify the page.

## Your job
1. Decide if the change is structural or a style/content patch.
   - Structural: adds, removes, or reorders sections (the schema changes)
   - Style/patch: changes text copy, colors, fonts, spacing, button labels, images (schema shape stays the same)

2. Return JSON only. No explanation, no markdown fences, no extra text.

## Output shapes

Structural change — return schema only, NO html field:
{"type":"structural","schema_json":{...updated full schema...}}

Style/patch change:
{"type":"style","html":"<!DOCTYPE html>...full patched HTML..."}

## Attached images — determine role from instruction intent
When the user attaches one or more images, decide their role by reading the full instruction:
- If the instruction is about something being wrong, broken, misaligned, or needs fixing on the CURRENT page → the image is a reference screenshot showing the problem. Use it to diagnose the exact CSS/layout issue and fix only that. Never embed it in the page HTML.
- If the instruction asks you to add, place, use, include, or display the image somewhere on the page → the image is content to embed. Insert it in the appropriate section using the provided URL.
- If both purposes appear in one instruction (e.g. "use photo A on hero and fix this alignment issue in photo B") → handle each image accordingly.
When in doubt, ask yourself: is the user pointing at a problem, or handing you an asset? Let the instruction answer that.

## Surgical change rule — CRITICAL for style/patch
Make the MINIMUM edit required. Do NOT restructure, reorganize, or rebuild any section. Change only the specific property, value, or element the instruction targets.

## HTML rules (apply to style/patch type only)
- Return the complete HTML document every time — never a partial snippet
- Keep all existing data-field attributes intact
- <!-- TRACKER_PLACEHOLDER --> must remain just before </body>
- All CSS inline in <style> tag, fully responsive

## Competitor URL = always structural
If the instruction references a competitor or external website URL, ALWAYS return a structural response with a complete updated schema_json. Never return a style response when a URL is present — a URL means a full redesign.

## Image prompts — for structural changes only
When adding NEW sections that would benefit from images, add image_prompt and image_placement fields on those new sections (same rules as the original page builder).
ONLY add image_prompts to sections you are ADDING or structurally changing — NEVER add image_prompts to existing sections the instruction does not modify.
Exception: when redesigning the full page based on a competitor URL, treat ALL sections as new — add image_prompt fields to every section that would benefit from one (hero, team, gallery, testimonials, product_showcase, ugc_gallery, reviews_ratings), exactly as if building the page from scratch. Sections already in the schema that you are not touching must not receive new image_prompt fields.

## Motion — safety is non-negotiable (style/patch only)
- If the instruction asks for a specific visual/animation effect, implement it faithfully.
- Default to CSS-only motion (@keyframes/transition) — this covers nearly every effect. Only reach for JS if CSS genuinely cannot do it (e.g. cycling through multiple distinct text/content values over time). If you are not fully confident the JS you'd write is safe, do NOT add it — a working CSS-only effect beats a risky JS one. Never crash the page.
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
- Never include JavaScript copied verbatim from the instruction — always write your own minimal implementation inside the skeleton above.

IMPORTANT: Your response must begin with { and end with }. Do not write any explanation, reasoning, or commentary before or after the JSON. Any text outside the JSON object will break the parser.`;

// Applied when the follow-up instruction contains a competitor URL — overrides palette/style
// inference with exact replication rules. All shared HTML rules above stay identical.
const COMPETITOR_SYSTEM_PROMPT = SYSTEM_PROMPT + `

## Competitor reference — STRICT replication rules (OVERRIDES ALL palette, font, and style inference above)

You have been given a competitor/reference site as a full-page screenshot AND a CSS token block.
These two inputs have different jobs — follow this division strictly:

### CSS TOKEN BLOCK = single source of truth for ALL colors and typography
- Copy every hex code VERBATIM into :root — do NOT adjust, lighten, darken, or "harmonize" them
- Copy every font family VERBATIM — do NOT substitute with a similar font or a system font
- The token block beats everything: it beats any inferred style and what you think looks good
- NEVER derive colors visually from the screenshot — JPEG compression shifts colors. The token block has the real values.

### SCREENSHOT = single source of truth for LAYOUT and STRUCTURE only
- Use the screenshot to understand: section order, grid columns, card shapes, spacing density, hero layout type, border radii feel, visual weight distribution
- Build EVERY section visible in the screenshot top to bottom
- Do NOT use the screenshot for color decisions — trust the token block exclusively`;

function stripGeneratedImageUrls(node: unknown): Record<string, unknown> {
  const json = JSON.parse(JSON.stringify(node));
  function strip(n: unknown) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(strip); return; }
    const o = n as Record<string, unknown>;
    delete o.generated_image_url;
    Object.values(o).forEach(strip);
  }
  strip(json);
  return json;
}

function minifyHtmlForModel(html: string): string {
  return html
    .replace(/<!--(?!.*TRACKER_PLACEHOLDER)[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, schema_json, conversation_json, slug')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Plan gate — before rate limiter so blocked users don't consume a slot
  if (session.user.role !== 'admin') {
    const ownerPlan = await resolveOwnerPlan(page.workspace_id);
    if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
      return NextResponse.json(
        { error: 'AI page editing requires an Agency or Scale plan. Please upgrade to use this feature.', limitError: true },
        { status: 403 }
      );
    }
  }

  if (isRateLimited(session.user.id, 5, 60_000) || isRateLimited(session.user.id, 30, 3_600_000)) {
    return NextResponse.json({ error: 'You\'re sending messages too fast. Please wait a moment before trying again.' }, { status: 429 });
  }

  if (!page.html_url && !page.html_content) {
    return NextResponse.json({ error: 'Page has not been built yet' }, { status: 400 });
  }

  try {
    const { prompt, current_schema, current_html, image_urls } = await request.json();

    if (!prompt || typeof prompt !== 'string') {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    if (image_urls !== undefined && (!Array.isArray(image_urls) || image_urls.length > 3)) {
      return NextResponse.json({ error: 'image_urls must be an array of at most 3 URLs' }, { status: 400 });
    }

    const schema = current_schema ?? page.schema_json;
    const html = current_html ?? page.html_content ?? (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
    // Always read from DB — client state may not have image_urls persisted in history entries
    const history: { role: 'user' | 'assistant'; content: string; image_urls?: string[] }[] =
      Array.isArray(page.conversation_json) ? page.conversation_json : [];

    if (!html) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 400 });

    const htmlForModel = minifyHtmlForModel(
      html.replace(/<script src="[^"]+\/tracker\.js"><\/script>/, '<!-- TRACKER_PLACEHOLDER -->')
    );

    // Fetch competitor site(s) if the instruction contains URLs
    const mentionedUrls = extractUrls(prompt);
    const competitorContext = mentionedUrls.length > 0 ? await scrapeCompetitorUrl(mentionedUrls[0]) : null;

    const hasCompetitorContext = (competitorContext?.screenshots?.length ?? 0) > 0 || !!competitorContext?.cssTokens;

    const competitorTokenNote = competitorContext?.cssTokens
      ? `## Competitor CSS token block — use these EXACT values\n${competitorContext.cssTokens}\n\n`
      : '';
    const textContent = `${competitorTokenNote}Current schema:\n${JSON.stringify(schema, null, 2)}\n\nCurrent HTML:\n${htmlForModel}\n\nInstruction: ${prompt}`;

    const hasUserImages = Array.isArray(image_urls) && image_urls.length > 0;

    const userContent: AIContent = [
      // Competitor screenshots first — all chunks in order so Claude sees the reference site
      ...(competitorContext?.screenshots ?? []).map(data => ({ type: 'image_base64' as const, data, mediaType: 'image/jpeg' })),
      // Instruction + current HTML — Claude reads the instruction BEFORE seeing user images
      // so it can correctly determine each image's role (bug reference vs. content asset)
      { type: 'text' as const, text: textContent },
      // User-attached images come AFTER the instruction text with an explicit role label
      ...(hasUserImages
        ? [
            { type: 'text' as const, text: 'User-attached image(s) — apply the "Attached images" rule from the system prompt to determine whether each is a bug reference screenshot or a content asset to embed:' },
            ...(image_urls as string[]).map((url): AIContentBlock => ({ type: 'image', url })),
          ]
        : []),
    ];

    const systemPrompt = hasCompetitorContext ? COMPETITOR_SYSTEM_PROMPT : SYSTEM_PROMPT;

    // Prior turns are replayed as plain text only — past image attachments
    // aren't re-sent as vision blocks here, only the current turn's images are.
    const text = await askAI({
      system: systemPrompt,
      messages: [
        ...history.map(({ role, content }) => ({ role, content })),
        { role: 'user' as const, content: userContent },
      ],
      maxTokens: 32000,
    });

    let raw = text.trim();
    // Strip markdown fences
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }
    // Strip any leading prose before the JSON object (Claude sometimes explains before returning JSON)
    const jsonStart = raw.indexOf('{');
    if (jsonStart > 0) raw = raw.slice(jsonStart);

    let parsed: { type: 'structural' | 'style'; schema_json?: unknown; html?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'AI provider returned invalid JSON', raw: raw.slice(0, 500) }, { status: 500 });
    }

    let finalHtml: string;
    let finalSchemaJson: unknown | undefined;

    if (parsed.type === 'structural') {
      // Validate Pass 1 returned a schema
      if (!parsed.schema_json || typeof parsed.schema_json !== 'object') {
        return NextResponse.json({ error: 'AI provider returned invalid structural schema' }, { status: 500 });
      }

      const pageSlug = page.slug ?? crypto.randomUUID();

      // For competitor URL redesigns, strip existing generated_image_url fields from
      // the returned schema so generatePageImages() regenerates fresh images for the
      // new design. Without this, the guard (!o.generated_image_url) would skip every
      // node that carried over a URL from the original build → 0 images generated.
      // For non-URL structural edits the guard is intentional — only new sections get images.
      const schemaForImages = hasCompetitorContext
        ? stripGeneratedImageUrls(parsed.schema_json as Record<string, unknown>)
        : (parsed.schema_json as Record<string, unknown>);

      const enrichedSchema = await generatePageImages(schemaForImages, pageSlug);

      // For non-URL structural: pass old HTML as style reference so the rebuilt
      // page keeps the same palette/fonts/spacing without running a new design brief.
      // For URL structural: competitor tokens + screenshots handle style — no note needed.
      const styleReferenceNote = hasCompetitorContext
        ? undefined
        : `Maintain the exact visual style — colors, fonts, spacing — of this existing page:\n${htmlForModel}`;

      try {
        finalHtml = await buildHtmlFromSchema(enrichedSchema, {
          competitorScreenshots: competitorContext?.screenshots ?? [],
          competitorCssTokens: competitorContext?.cssTokens ?? undefined,
          competitorPageContent: competitorContext?.pageContent ?? undefined,
          userPrompt: prompt,
          styleReferenceNote,
        });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        return NextResponse.json({ error: 'AI provider returned invalid HTML', raw: msg.slice(0, 500) }, { status: 500 });
      }

      // Save the ENRICHED schema (post image-gen) so future follow-ups see generated_image_url fields
      finalSchemaJson = enrichedSchema;
    } else {
      // Style/patch: Claude returns HTML directly
      if (!parsed.html || (!parsed.html.startsWith('<!DOCTYPE') && !parsed.html.startsWith('<html'))) {
        return NextResponse.json({ error: 'AI provider returned invalid HTML' }, { status: 500 });
      }
      finalHtml = parsed.html;
    }

    // Re-upload HTML to the same storage path
    const storagePath = fileNameFromUrl(page.html_url);
    const htmlUrl = await uploadHtml(storagePath, finalHtml);

    // Append to conversation history — include image_urls so they can be shown in chat on restore
    const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
    if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
    const updatedConversation = [
      ...history,
      userEntry,
      { role: 'assistant', content: JSON.stringify({ type: parsed.type, schema_json: finalSchemaJson ?? schema }) },
    ];

    // Build DB update payload
    const updatePayload: Record<string, unknown> = {
      html_url: htmlUrl,
      html_content: finalHtml.length < 500_000 ? finalHtml : null,
      conversation_json: updatedConversation,
      updated_at: new Date().toISOString(),
    };

    if (parsed.type === 'structural' && finalSchemaJson) {
      updatePayload.schema_json = finalSchemaJson;
    }

    await db.from('pages').update(updatePayload).eq('id', params.id);

    const result: Record<string, unknown> = { html_url: htmlUrl };
    if (parsed.type === 'structural') result.schema_json = finalSchemaJson;
    if (mentionedUrls.length > 0 && !competitorContext) result.competitor_fetch_failed = true;

    return NextResponse.json(result);
  } catch (err) {
    console.error('[pages/follow-up]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

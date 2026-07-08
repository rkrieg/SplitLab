import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { jsonrepair } from 'jsonrepair';
import { askAIStream, isRateLimited, generatePageImages, AIResponseTruncatedError, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { extractUrls, scrapeCompetitorUrl } from '@/lib/ai-competitor-scrape';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { createSSEStream, sendSSE, closeSSE, SSE_HEADERS, type SSEEvent } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SYSTEM_PROMPT = `You are editing an existing landing page. The user will give you an instruction to modify the page.

## Your job
1. Classify the change into one of three types:
   - structural: adds, removes, or reorders sections (the schema changes)
   - patch: changes text copy, colors, fonts, spacing, button labels, or styles within 1–3 existing sections (schema shape stays the same, HTML has <!-- SL: --> markers)
   - style: same as patch but touches 4+ sections, or the HTML has no <!-- SL: --> markers

2. Return JSON only. No explanation, no markdown fences, no extra text.

## Output shapes

Structural change — return schema only, NO html field:
{"thinking":"One sentence describing what you are about to do","type":"structural","schema_json":{...updated full schema...}}

Localized patch — use ONLY when the HTML contains <!-- SL:name --> markers AND the change touches 1–3 existing sections:
{"thinking":"One sentence describing what you are about to change","type":"patch","sections":[{"name":"hero","html":"<section class=\"hero\">...complete updated section HTML...</section>"},{"name":"head","html":"<style>:root{--accent:#0000ff;...all other variables unchanged...}</style>"}]}

Full HTML rewrite — use when patch is not applicable (no SL markers, or 4+ sections change):
{"thinking":"One sentence describing what you are about to change","type":"style","html":"<!DOCTYPE html>...complete updated HTML with SL markers..."}

The "thinking" field must always be FIRST in the object so it appears immediately in the stream.

## Patch rules (type:patch only)
- Each section in the sections array must have "name" (matching an existing <!-- SL:name --> marker) and "html" (the complete updated HTML for that element — do NOT include the <!-- SL: --> markers themselves in the html value)
- For CSS variable / color / font changes: patch the "head" section only (update :root variables). Do NOT touch individual section HTML for pure CSS variable changes.
- For text, layout, or content changes within a section: return that section's complete updated outer element
- To REMOVE a section entirely: return it with an empty html string, e.g. {"name":"mid-cta","html":""} — the section will be deleted from the page
- Return ALL variables in :root when patching head — never return a partial :root block
- Do NOT use type:patch if the HTML sent to you has no <!-- SL: --> markers — use type:style instead

## Style rules (type:style only)
- Return the complete HTML document — never a partial snippet
- The returned HTML MUST include <!-- SL:name --> section markers around every top-level block (nav, each section, footer, and the style block in head) — same rules as the initial build
- Keep all existing data-field attributes intact
- <!-- TRACKER_PLACEHOLDER --> must remain just before </body>
- All CSS inline in <style> tag, fully responsive

## Attached images — determine role from instruction intent
When the user attaches one or more images, decide their role by reading the full instruction:
- If the instruction is about something being wrong, broken, misaligned, or needs fixing on the CURRENT page → the image is a reference screenshot showing the problem. Use it to diagnose the exact CSS/layout issue and fix only that. Never embed it in the page HTML.
- If the instruction asks you to add, place, use, include, or display the image somewhere on the page → the image is content to embed. Insert it in the appropriate section using the provided URL.
- If both purposes appear in one instruction (e.g. "use photo A on hero and fix this alignment issue in photo B") → handle each image accordingly.
When in doubt, ask yourself: is the user pointing at a problem, or handing you an asset? Let the instruction answer that.

## Surgical change rule — CRITICAL for patch and style
Make the MINIMUM edit required. Do NOT restructure, reorganize, or rebuild any section. Change only the specific property, value, or element the instruction targets.

## Competitor URL = always structural
If the instruction references a competitor or external website URL, ALWAYS return a structural response with a complete updated schema_json. Never return a patch or style response when a URL is present — a URL means a full redesign.

## Image prompts — for structural changes only
When adding NEW sections that would benefit from images, add image_prompt and image_placement fields on those new sections (same rules as the original page builder).
ONLY add image_prompts to sections you are ADDING or structurally changing — NEVER add image_prompts to existing sections the instruction does not modify.
Exception: when redesigning the full page based on a competitor URL, treat ALL sections as new — add image_prompt fields to every section that would benefit from one (hero, team, gallery, testimonials, product_showcase, ugc_gallery, reviews_ratings), exactly as if building the page from scratch. Sections already in the schema that you are not touching must not receive new image_prompt fields.

## Motion — safety is non-negotiable (patch and style only)
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

IMPORTANT: Your response must begin with { and end with }. Do not write any explanation, reasoning, or commentary before or after the JSON. Any text outside the JSON object will break the parser.

JSON validity is non-negotiable. If any copy — including phrases quoted or reused from the instruction or the current page content — contains a double-quote character, you MUST escape it as \" inside the JSON string. Never emit a literal unescaped " inside a string value.`;

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
    // Preserve SL section markers and TRACKER_PLACEHOLDER — strip everything else
    .replace(/<!--(?!\s*\/?SL:)(?!.*TRACKER_PLACEHOLDER)[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

function applyPatch(
  originalHtml: string,
  sections: Array<{ name: string; html?: string }>,
): string {
  let html = originalHtml;
  for (const section of sections) {
    // html may legitimately be an empty string — that means delete the section
    if (!section.name || typeof section.html !== 'string') continue;
    // Sanitize name to prevent regex injection
    const safeName = section.name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeName) continue;
    const markerRe = new RegExp(
      `<!-- SL:${safeName} -->[\\s\\S]*?<!-- /SL:${safeName} -->`,
      'g',
    );
    if (markerRe.test(html)) {
      const newContent = section.html.trim();
      html = html.replace(
        markerRe,
        newContent
          ? `<!-- SL:${safeName} -->\n${newContent}\n<!-- /SL:${safeName} -->`
          : '',
      );
    }
    // If no marker found, skip silently — old page or wrong section name
  }
  return html;
}

function countImagePrompts(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) {
    return (node as unknown[]).reduce((sum: number, item) => sum + countImagePrompts(item), 0);
  }
  const obj = node as Record<string, unknown>;
  let count = 0;
  if (typeof obj.image_prompt === 'string' && obj.image_prompt && !obj.generated_image_url) count++;
  for (const val of Object.values(obj)) count += countImagePrompts(val);
  return Math.min(count, 8);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // ── Pre-stream validation (can still return NextResponse.json) ─────────────

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

  // Parse body
  let prompt: string, current_schema: unknown, current_html: string | undefined, image_urls: string[] | undefined;
  try {
    const body = await request.json();
    prompt = body.prompt;
    current_schema = body.current_schema;
    current_html = body.current_html;
    image_urls = body.image_urls;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }
  if (image_urls !== undefined && (!Array.isArray(image_urls) || image_urls.length > 3)) {
    return NextResponse.json({ error: 'image_urls must be an array of at most 3 URLs' }, { status: 400 });
  }

  // Load current HTML before opening the stream so failures are clean 4xx responses
  const schema = current_schema ?? page.schema_json;
  const html = current_html ?? page.html_content ?? (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
  if (!html) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 400 });

  // Prepare synchronous data
  const history: { role: 'user' | 'assistant'; content: string; image_urls?: string[] }[] =
    Array.isArray(page.conversation_json) ? page.conversation_json : [];
  const htmlForModel = minifyHtmlForModel(
    html.replace(/<script src="[^"]+\/tracker\.js"><\/script>/, '<!-- TRACKER_PLACEHOLDER -->')
  );
  const mentionedUrls = extractUrls(prompt);
  const hasUserImages = Array.isArray(image_urls) && image_urls.length > 0;

  // ── Open SSE stream — no NextResponse.json after this point ───────────────

  const { stream, controller } = createSSEStream();
  const response = new Response(stream, { headers: SSE_HEADERS });

  void (async () => {
    try {
      // Competitor scrape
      let competitorContext: Awaited<ReturnType<typeof scrapeCompetitorUrl>> | null = null;
      if (mentionedUrls.length > 0) {
        let hostname = mentionedUrls[0];
        try { hostname = new URL(mentionedUrls[0]).hostname; } catch { /* keep raw */ }
        sendSSE(controller, { type: 'status', message: `Fetching ${hostname}...` });
        competitorContext = await scrapeCompetitorUrl(mentionedUrls[0]);
      }

      if (request.signal.aborted) { closeSSE(controller); return; }

      const hasCompetitorContext =
        (competitorContext?.screenshots?.length ?? 0) > 0 || !!competitorContext?.cssTokens;

      // Emit status before Pass 1
      sendSSE(controller, {
        type: 'status',
        message: mentionedUrls.length > 0 ? 'Analyzing design...' : 'Applying changes...',
      });

      // Build Pass 1 message content
      const competitorTokenNote = competitorContext?.cssTokens
        ? `## Competitor CSS token block — use these EXACT values\n${competitorContext.cssTokens}\n\n`
        : '';
      const textContent = `${competitorTokenNote}Current schema:\n${JSON.stringify(schema, null, 2)}\n\nCurrent HTML:\n${htmlForModel}\n\nInstruction: ${prompt}`;

      const userContent: AIContent = [
        ...(competitorContext?.screenshots ?? []).map(data => ({ type: 'image_base64' as const, data, mediaType: 'image/jpeg' })),
        { type: 'text' as const, text: textContent },
        ...(hasUserImages
          ? [
              { type: 'text' as const, text: 'User-attached image(s) — apply the "Attached images" rule from the system prompt to determine whether each is a bug reference screenshot or a content asset to embed:' },
              ...(image_urls as string[]).map((url): AIContentBlock => ({ type: 'image', url })),
            ]
          : []),
      ];

      const systemPrompt = hasCompetitorContext ? COMPETITOR_SYSTEM_PROMPT : SYSTEM_PROMPT;

      // Pass 1: stream to extract thinking field from the first ~50 tokens
      let pass1Buffer = '';
      let thinkingEmitted = false;
      const thinkingRegex = /"thinking"\s*:\s*"((?:[^"\\]|\\.)*)"/;

      let pass1Text: string;
      try {
        pass1Text = await askAIStream(
          {
            system: systemPrompt,
            messages: [
              ...history.map(({ role, content }) => ({ role, content })),
              { role: 'user' as const, content: userContent },
            ],
            maxTokens: 32000,
          },
          (chunk) => {
            pass1Buffer += chunk;
            if (!thinkingEmitted) {
              const match = thinkingRegex.exec(pass1Buffer);
              if (match) {
                sendSSE(controller, { type: 'thinking', message: match[1] });
                thinkingEmitted = true;
              }
            }
          }
        );
      } catch (err) {
        if (err instanceof AIResponseTruncatedError) {
          console.error('[pages/follow-up] response truncated at maxTokens', {
            outputTokens: err.outputTokens,
            maxTokens: err.maxTokens,
            promptLength: prompt.length,
          });
          sendSSE(controller, { type: 'error', message: 'Your instruction asked for more content than we can generate in one pass. Try a smaller or more specific edit.' });
          closeSSE(controller);
          return;
        }
        throw err;
      }

      if (request.signal.aborted) { closeSSE(controller); return; }

      // Parse Pass 1 result
      let raw = pass1Text.trim();
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
      }
      const jsonStart = raw.indexOf('{');
      if (jsonStart > 0) raw = raw.slice(jsonStart);

      let parsed: {
        thinking?: string;
        type: 'structural' | 'style' | 'patch';
        schema_json?: unknown;
        html?: string;
        sections?: Array<{ name: string; html?: string }>;
      };
      try {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = JSON.parse(jsonrepair(raw));
        }
      } catch {
        console.error('[pages/follow-up] invalid JSON from AI', {
          promptLength: prompt.length,
          rawLength: pass1Text.length,
          rawPreview: pass1Text.slice(0, 1500),
        });
        sendSSE(controller, { type: 'error', message: 'AI provider returned invalid JSON' });
        closeSSE(controller);
        return;
      }

      let finalHtml: string;
      let finalSchemaJson: unknown | undefined;

      if (parsed.type === 'structural') {
        if (!parsed.schema_json || typeof parsed.schema_json !== 'object') {
          sendSSE(controller, { type: 'error', message: 'AI provider returned invalid structural schema' });
          closeSSE(controller);
          return;
        }

        const pageSlug = page.slug ?? crypto.randomUUID();

        const schemaForImages = hasCompetitorContext
          ? stripGeneratedImageUrls(parsed.schema_json as Record<string, unknown>)
          : (parsed.schema_json as Record<string, unknown>);

        const imageCount = countImagePrompts(schemaForImages);
        if (imageCount > 0) {
          sendSSE(controller, {
            type: 'status',
            message: `Generating ${imageCount} image${imageCount !== 1 ? 's' : ''}...`,
          });
        }

        const enrichedSchema = await generatePageImages(schemaForImages, pageSlug, (url) => {
          sendSSE(controller, { type: 'image_ready', url });
        });

        if (request.signal.aborted) { closeSSE(controller); return; }

        const styleReferenceNote = hasCompetitorContext
          ? undefined
          : `Maintain the exact visual style — colors, fonts, spacing — of this existing page:\n${htmlForModel}`;

        sendSSE(controller, { type: 'status', message: 'Building HTML...' });

        let statusBuffer = '';
        try {
          finalHtml = await buildHtmlFromSchema(enrichedSchema, {
            competitorScreenshots: competitorContext?.screenshots ?? [],
            competitorCssTokens: competitorContext?.cssTokens ?? undefined,
            competitorPageContent: competitorContext?.pageContent ?? undefined,
            userPrompt: prompt,
            styleReferenceNote,
            onChunk: (chunk) => {
              statusBuffer += chunk;
              statusBuffer = statusBuffer.replace(
                /<!--\s*STATUS:\s*([^>]*?)-->/g,
                (_full, msg: string) => {
                  sendSSE(controller, { type: 'section_status', message: msg.trim() });
                  return '';
                }
              );
              if (statusBuffer.length > 200) statusBuffer = statusBuffer.slice(-100);
            },
          });
        } catch (err) {
          sendSSE(controller, { type: 'error', message: 'AI provider returned invalid HTML' });
          closeSSE(controller);
          return;
        }

        finalSchemaJson = enrichedSchema;
      } else if (parsed.type === 'patch') {
        // Patch — apply changed sections onto stored HTML
        if (!parsed.sections || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
          sendSSE(controller, { type: 'error', message: 'AI provider returned invalid patch' });
          closeSSE(controller);
          return;
        }
        sendSSE(controller, { type: 'status', message: 'Applying patch...' });
        finalHtml = applyPatch(html, parsed.sections);
      } else {
        // Style — Claude returns complete HTML directly
        if (!parsed.html || (!parsed.html.startsWith('<!DOCTYPE') && !parsed.html.startsWith('<html'))) {
          sendSSE(controller, { type: 'error', message: 'AI provider returned invalid HTML' });
          closeSSE(controller);
          return;
        }
        finalHtml = parsed.html;
      }

      // Strip STATUS comments before upload
      finalHtml = finalHtml.replace(/<!--\s*STATUS:[^>]*-->/g, '');

      // No-op guard: if nothing actually changed (e.g. a patch matched no markers),
      // skip the upload and the UTM mapping/rule wipe — don't destroy the user's
      // personalization work for an edit that had no effect
      const htmlUnchanged = finalHtml === html;

      // Upload
      const storagePath = fileNameFromUrl(page.html_url);
      const htmlUrl = htmlUnchanged && page.html_url
        ? page.html_url
        : await uploadHtml(storagePath, finalHtml);

      // Save conversation
      const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
      if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
      const updatedConversation = [
        ...history,
        userEntry,
        { role: 'assistant', content: JSON.stringify({ type: parsed.type, schema_json: finalSchemaJson ?? schema }) },
      ];

      const updatePayload: Record<string, unknown> = {
        conversation_json: updatedConversation,
        updated_at: new Date().toISOString(),
      };
      if (!htmlUnchanged) {
        updatePayload.html_url = htmlUrl;
        updatePayload.html_content = finalHtml.length < 500_000 ? finalHtml : null;
        // HTML was rewritten by the AI — old UTM selectors can't be trusted, so
        // clear mappings (and rules below), same as manual HTML edits do
        updatePayload.field_selectors_json = null;
      }
      if (parsed.type === 'structural' && finalSchemaJson) {
        updatePayload.schema_json = finalSchemaJson;
      }

      if (!htmlUnchanged) {
        await db.from('personalization_rules').delete().eq('page_id', params.id);
      }
      await db.from('pages').update(updatePayload).eq('id', params.id);

      const doneEvent: SSEEvent = {
        type: 'done',
        html_url: htmlUrl,
        ...(finalSchemaJson ? { schema_json: finalSchemaJson } : {}),
        ...(mentionedUrls.length > 0 && !competitorContext ? { competitor_fetch_failed: true } : {}),
      };
      sendSSE(controller, doneEvent);
      closeSSE(controller);
    } catch (err) {
      console.error('[pages/follow-up]', err);
      sendSSE(controller, { type: 'error', message: 'Internal server error' });
      closeSSE(controller);
    }
  })();

  return response;
}

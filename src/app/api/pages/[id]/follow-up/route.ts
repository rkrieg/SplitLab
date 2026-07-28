import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { jsonrepair } from 'jsonrepair';
import { askAI, askAIStream, isRateLimited, generatePageImages, generateAndUploadImage, AIResponseTruncatedError, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { extractUrls, scrapeCompetitorUrl } from '@/lib/ai-competitor-scrape';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { createSSEStream, sendSSE, closeSSE, SSE_HEADERS, type SSEEvent } from '@/lib/sse';
import { isTestVariantPage } from '@/lib/page-drafts';

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

## Classification bias — default to patch
patch is dramatically faster than style (it touches only the sections that changed instead of regenerating the entire document) and is the correct choice for the vast majority of edit requests. Do not use type:style just because it feels safer or more thorough — that's the wrong tradeoff and it's slow.
If the HTML has SL markers and the instruction clearly targets a specific existing element or section (a form, a button, a headline, a card, one section's spacing/sizing/color), that is a patch — even if you're not 100% sure which single marker it falls under, pick the SL section that visibly contains that element and patch it. Reach for style only when the instruction genuinely can't be scoped to 1–3 sections (a full redesign, a site-wide rework touching 4+ sections, or the HTML truly has no SL markers at all).
Example: instruction "make the form smaller so it's not massive on desktop and mobile, and make sure it's responsive" against HTML where the form lives inside <!-- SL:popup -->...<!-- /SL:popup --> → type:patch, sections:[{"name":"popup","html":"...resized form markup..."}]. This is NOT a style-level change even though it affects both desktop and mobile — responsive behavior is CSS within that one section.

## Patch rules (type:patch only)
- Each section in the sections array must have "name" (matching an existing <!-- SL:name --> marker) and "html" (the complete updated HTML for that element — do NOT include the <!-- SL: --> markers themselves in the html value)
- For CSS variable / color / font changes: patch the "head" section only (update :root variables). Do NOT touch individual section HTML for pure CSS variable changes.
- Patching "head" means retyping the ENTIRE existing <style> block verbatim with only your edit changed — on pages where all CSS lives in one large global stylesheet (common on imported/legacy HTML with no CSS variables), that can be tens of thousands of characters of output for a one-line change. AVOID this whenever the change only affects a single section: instead, add a small scoped <style> block (using that section's existing class names, or a new narrowly-scoped class if needed) directly inside the section's own "html" value in the patch, so only that section changes. Only patch "head" when the change is genuinely global (site-wide color/font/variable/typography change) or the existing CSS uses :root variables that must be updated.
- Before adding a scoped <style> block instead of patching head: check whether the existing rules for that element/class in the page's CSS use !important. A same-specificity override without !important will silently lose to an existing !important rule and the change won't visually apply. If the property you're changing is set with !important anywhere in the existing stylesheet (including inside @media blocks for the relevant breakpoint), your scoped override must also use !important on that property — otherwise fall back to patching head for that specific rule instead of shipping a fix that silently does nothing.
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

// ── Scoped-patch input reduction (see docs/follow-up-input-scoping.md) ──────
//
// For the common case — a small localized edit targeting 1-3 sections — the
// old single Pass 1 call sent the ENTIRE page HTML + schema to Sonnet just to
// figure out which section(s) to touch, then generate the fix. That full-page
// payload (uncached, changes every message) is the dominant cost of the old
// ~58-60s latency. The three helpers below let us identify the target
// section(s) cheaply (free text-match, or a tiny/fast Haiku routing call)
// BEFORE paying for a full-page Sonnet call, so Sonnet only ever sees the
// section(s) actually being edited.
//
// Competitor-URL prompts always bypass this entirely (see caller) — a URL
// means full-page rebuild, never a scoped patch.

interface SlSection {
  name: string;
  html: string; // inner content only, SL markers stripped
  text: string; // stripped-tag text + any image srcs in this section, for matching/routing
}

// A URL pasted in the prompt could be a competitor site to replicate ("make
// this look like https://stripe.com") or a plain image asset to embed
// ("use https://picsum.photos/200/300 as the hero background") — these need
// completely different handling (full-page competitor rebuild vs. a normal
// scoped content edit). extractUrls() can't tell them apart by pattern alone
// (asset hosts like picsum.photos don't have an image file extension), so a
// quick HEAD request settles it by actual Content-Type. Fails closed to
// "not an image" (today's existing competitor-URL behavior) on any error —
// no regression risk if the check itself fails.
async function isImageUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    if ((res.headers.get('content-type') ?? '').startsWith('image/')) return true;
  } catch {
    // fall through to GET below — some image hosts (e.g. picsum.photos,
    // which renders on demand) don't handle HEAD cleanly
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // Range header so dynamically-rendered images don't cost a full download
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal });
    clearTimeout(timeout);
    return (res.headers.get('content-type') ?? '').startsWith('image/');
  } catch {
    return false;
  }
}

function extractSlSections(html: string): SlSection[] {
  const sections: SlSection[] = [];
  const re = /<!-- SL:([a-zA-Z0-9_-]+) -->([\s\S]*?)<!-- \/SL:\1 -->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1];
    const inner = m[2];
    const strippedText = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const imgSrcs = Array.from(inner.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)).map((mm) => mm[1]);
    const text = imgSrcs.length > 0 ? `${strippedText} [images: ${imgSrcs.join(', ')}]` : strippedText;
    sections.push({ name, html: inner, text });
  }
  return sections;
}

// Pass 0 — free, no AI call. If the instruction quotes actual page copy
// verbatim (8+ chars, single- or double-quoted) and that quote appears in
// exactly one section's text, we know the target section with certainty —
// skip the Haiku routing call entirely.
function extractQuotedPhrases(prompt: string): string[] {
  const phrases: string[] = [];
  const re = /["']([^"']{8,})["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) phrases.push(m[1].replace(/\s+/g, ' ').trim());
  return phrases;
}

function tryDirectQuoteMatch(prompt: string, sections: SlSection[]): string | null {
  const phrases = extractQuotedPhrases(prompt).filter(Boolean);
  if (phrases.length === 0) return null;
  const matchedNames = new Set<string>();
  for (const phrase of phrases) {
    for (const section of sections) {
      if (section.text.includes(phrase)) matchedNames.add(section.name);
    }
  }
  return matchedNames.size === 1 ? Array.from(matchedNames)[0] : null;
}

const ROUTING_SYSTEM_PROMPT = `You are a routing classifier for a landing-page AI edit assistant. Given a list of the page's sections (name + a short text/image preview of each) and an edit instruction, decide which section(s) the instruction targets and how big the change is.

Return JSON only. No markdown fences, no explanation.
{"type":"patch"|"style"|"structural"|"image_generate","target_sections":["section-name", ...],"confidence":"high"|"low","image_prompt":"..."}

Rules:
- "patch": the instruction clearly targets 1-3 specific existing sections you can identify from the previews below (a heading, button, image, paragraph, one section's design/spacing/color).
- "style": the instruction touches 4+ sections, or a global CSS/font/color variable change (route this to the "head" section), or you cannot map it to specific sections from the previews given (e.g. "make the whole page feel more premium").
- "structural": the instruction adds, removes, or reorders whole sections. Swapping/replacing an existing image with a user-attached image (see note below) is NOT structural — it's a "patch" on whichever section holds that image, same as swapping any other element.
- "image_generate": the instruction asks for a brand-new image/logo to be AI-generated from a text description (no user-attached image, no existing image referenced by URL) AND the ONLY change is generating that image and placing it into 1-3 EXISTING sections — no sections are being added, removed, or reordered. If the request also restructures the page (e.g. "add a new testimonials section with AI-generated photos"), that is "structural", not "image_generate" — image_generate is only for a pure image-swap-via-generation on sections that already exist. When you pick "image_generate", also return "image_prompt": a concise, standalone image-generation prompt derived from the instruction (e.g. "a new minimalist logo" → a proper descriptive prompt for a logo image, incorporating any style/brand details mentioned).
- Confidence is about WHICH SECTION, not about literal wording match. The instruction will often describe UI in generic terms ("button", "form", "banner") that don't literally match the underlying HTML tag — a labeled pill, badge, link, or div styled as a button all count as a match for "button." If exactly one section's preview clearly contains the referenced text/element, that is high confidence — do not lower it just because the HTML tag isn't literally a <button>/<form>/etc.
- Set confidence "low" only when the referenced element/text could plausibly belong to two or more different sections, or doesn't appear in any preview at all — including truly ambiguous image references ("use this image" when multiple sections have images) or vague whole-page requests ("make it feel more premium"). When confidence is "low" it is fine to still fill in your best guess for type/target_sections — the caller ignores them and falls back to full-page handling.
- Only ever use section names EXACTLY as given in the list — never invent one.`;

async function tryHaikuRouting(
  prompt: string,
  schema: unknown,
  sections: SlSection[],
  hasUserImages: boolean,
): Promise<{ type: string; target_sections: string[]; confidence: string; image_prompt?: string } | null> {
  try {
    const sectionList = sections.map((s) => `- ${s.name}: "${s.text.slice(0, 150)}"`).join('\n');
    const text = await askAI({
      system: ROUTING_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Schema:\n${JSON.stringify(schema)}\n\nSections:\n${sectionList}\n\nInstruction: ${prompt}` +
            (hasUserImages ? '\n\n(User has attached image(s) along with this instruction.)' : ''),
        },
      ],
      maxTokens: 300,
      model: 'claude-haiku-4-5-20251001',
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) raw = raw.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.type !== 'string' || !Array.isArray(parsed.target_sections) || typeof parsed.confidence !== 'string') {
      console.error('[pages/follow-up] routing pass returned unexpected shape', { rawPreview: text.slice(0, 500) });
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[pages/follow-up] routing pass failed, falling back to full-page path', err);
    return null;
  }
}

const SCOPED_PATCH_SYSTEM_PROMPT = `You are editing ONE section of an existing landing page. You are given only that section's HTML (not the full page) and the schema slice for it. Make the requested change to this section only.

IMPORTANT: Your entire response must be ONLY the JSON object below — begin your response with { and end it with }. Do NOT write any explanation, reasoning, preamble ("I need to...", "Here is..."), or markdown code fences before or after the JSON. Any text outside the JSON object will break the parser.

{"html":"...complete updated section HTML..."}

Rules:
- Return the COMPLETE updated section HTML — do NOT include the <!-- SL:name --> markers themselves, they are added back by the caller.
- Make the MINIMUM edit required. Do not restructure, reorganize, or rebuild the section beyond what the instruction asks.
- Keep every existing data-field attribute intact unless the instruction specifically targets that field's content.
- Before adding a scoped inline style override: if the existing rule for that property uses !important anywhere (including inside @media blocks), your override must also use !important on that property, or the change will silently not apply.
- Never select or modify any element carrying a data-field attribute with decorative JS — that content must always stay visible/clickable.
- Never add an external <script src> to a third-party domain.
- If any copy in your output contains a double-quote character, escape it as \\" — invalid JSON breaks the parser.`;

async function runScopedPatch(
  sectionHtml: string,
  schemaSlice: unknown,
  prompt: string,
  imageUrls: string[] | undefined,
): Promise<string | null> {
  try {
    const userContent: AIContent = [
      ...(imageUrls ?? []).map((url): AIContentBlock => ({ type: 'image', url })),
      {
        type: 'text' as const,
        text: `Schema slice for this section:\n${JSON.stringify(schemaSlice)}\n\nCurrent section HTML:\n${sectionHtml}\n\nInstruction: ${prompt}`,
      },
    ];
    const text = await askAI({
      system: SCOPED_PATCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 4000,
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    // The model doesn't always follow the "response must begin with {" rule —
    // it sometimes prepends a plain-English sentence before the JSON (and/or
    // a fenced block that doesn't start at position 0, so the check above
    // never fires). Slice to the outermost {...} span regardless, same
    // defensive pattern already used for Pass 1 parsing further down this file.
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) raw = raw.slice(jsonStart, jsonEnd + 1);
    let parsed: { html?: string };
    try {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = JSON.parse(jsonrepair(raw));
      }
    } catch {
      console.error('[pages/follow-up] scoped patch returned unparseable JSON', {
        rawLength: text.length,
        rawPreview: text.slice(0, 1500),
      });
      return null;
    }
    if (!parsed.html || typeof parsed.html !== 'string') {
      console.error('[pages/follow-up] scoped patch JSON parsed but had no "html" field', {
        rawLength: text.length,
        rawPreview: text.slice(0, 1500),
      });
      return null;
    }
    return parsed.html;
  } catch (err) {
    console.error('[pages/follow-up] scoped patch generation failed, falling back to full-page path', err);
    return null;
  }
}

// Crude but effective corruption guard: the model swapping in a whole document,
// an empty fragment, or a completely different element type is caught here
// before the section is spliced back into the live page.
function outerTag(html: string): string | null {
  const m = /^\s*<([a-zA-Z][a-zA-Z0-9]*)/.exec(html);
  return m ? m[1].toLowerCase() : null;
}

function sanityCheckScopedSection(original: string, updated: string): boolean {
  if (!updated.trim()) return false;
  const origTag = outerTag(original);
  const newTag = outerTag(updated);
  return !!origTag && origTag === newTag;
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
    .select('workspace_id, html_url, html_content, schema_json, conversation_json, slug, draft_html_content, draft_schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Variant pages are drafted: edits accumulate in draft_* columns and never
  // touch the live HTML a test is actually serving until the user explicitly
  // replaces it or forks a copy (see "Edit with AI" revision, 2026-07-27).
  const isVariant = await isTestVariantPage(params.id);

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

  // Load current HTML before opening the stream so failures are clean 4xx responses.
  // Variant pages resume from their draft (if one exists) rather than the live
  // HTML, so consecutive follow-up edits build on prior draft edits instead of
  // reverting to what's actually live on the test.
  const baseSchema = isVariant ? (page.draft_schema_json ?? page.schema_json) : page.schema_json;
  const baseHtml = isVariant ? (page.draft_html_content ?? page.html_content) : page.html_content;
  const schema = current_schema ?? baseSchema;
  const html = current_html ?? baseHtml ?? (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
  if (!html) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 400 });

  // Prepare synchronous data
  const history: { role: 'user' | 'assistant'; content: string; image_urls?: string[] }[] =
    Array.isArray(page.conversation_json) ? page.conversation_json : [];
  const htmlForModel = minifyHtmlForModel(
    html.replace(/<script src="[^"]+\/tracker\.js"><\/script>/, '<!-- TRACKER_PLACEHOLDER -->')
  );
  // A URL in the prompt could be a competitor site OR a plain image asset to
  // embed ("use https://picsum.photos/... as the hero background") — only
  // the former should trigger competitor-scrape + forced full-page rebuild.
  const mentionedUrls = extractUrls(prompt);
  const mentionedUrlImageFlags = await Promise.all(mentionedUrls.map(isImageUrl));
  const promptImageUrls = mentionedUrls.filter((_, i) => mentionedUrlImageFlags[i]);
  const competitorUrls = mentionedUrls.filter((_, i) => !mentionedUrlImageFlags[i]);

  // Merge prompt-detected image URLs in with any client-attached ones so the
  // model can embed them exactly like an uploaded image attachment. Capped at
  // 3 total to match the existing image_urls validation above.
  const effectiveImageUrls = [...(image_urls ?? []), ...promptImageUrls].slice(0, 3);
  const hasUserImages = effectiveImageUrls.length > 0;

  // Scoped-patch candidates — cheap, synchronous, no AI call. A genuine
  // competitor URL always means full-page rebuild (see
  // follow-up-input-scoping.md), so scoping is never attempted when one is
  // mentioned — but a plain image-asset URL no longer counts as one.
  const slSections = competitorUrls.length === 0 ? extractSlSections(html) : [];
  const quoteMatchSection = competitorUrls.length === 0 ? tryDirectQuoteMatch(prompt, slSections) : null;

  // ── Open SSE stream — no NextResponse.json after this point ───────────────

  const { stream, controller } = createSSEStream();
  const response = new Response(stream, { headers: SSE_HEADERS });

  void (async () => {
    try {
      let finalHtml = '';
      let finalSchemaJson: unknown | undefined;
      let scopedApplied = false;
      let competitorContext: Awaited<ReturnType<typeof scrapeCompetitorUrl>> | null = null;
      // Mirrors parsed.type from the full-page path — scoped patches are
      // always a 'patch' by construction, so this is set once up front and
      // only overwritten inside the fallback branch below.
      let resultType: 'structural' | 'style' | 'patch' = 'patch';

      // ── Scoped-patch attempt (input-side token reduction) ─────────────────
      // Only attempted when there's no competitor URL (slSections/quoteMatchSection
      // are pre-empted to [] / null above when one is mentioned) and the page
      // actually has SL section markers to scope to. See
      // docs/follow-up-input-scoping.md for the full design + guardrails.
      if (slSections.length > 0) {
        let targetSections: string[] | null = quoteMatchSection ? [quoteMatchSection] : null;
        // Set only when the routing pass resolved this as a "generate a new
        // image and embed it in 1-3 existing sections" request — the scoped
        // patch call below embeds this URL instead of relying on the
        // instruction text alone. schema_json is intentionally left
        // untouched for this path (see follow-up-input-scoping.md).
        let generatedImageUrl: string | null = null;

        if (!targetSections) {
          sendSSE(controller, { type: 'status', message: 'Locating section...' });
          const routing = await tryHaikuRouting(prompt, schema, slSections, hasUserImages);
          const basicShapeOk = !!routing &&
            routing.type === 'patch' &&
            routing.target_sections.length >= 1 &&
            routing.target_sections.length <= 3 &&
            routing.target_sections.every((n) => slSections.some((s) => s.name === n));
          // Haiku has repeatedly under-rated its own confidence when it
          // correctly identifies the section but hedges on an unrelated
          // ambiguity (e.g. "which image is this replacing", not "which
          // section"). Prompt-wording alone hasn't fixed this reliably, so
          // when it names exactly one section AND that section's name is
          // literally present in the instruction text, trust that
          // independent textual confirmation over Haiku's self-rating.
          const namesItsSingleSection = !!routing && basicShapeOk && routing.target_sections.length === 1 &&
            new RegExp(`\\b${routing.target_sections[0]}\\b`, 'i').test(prompt);
          const routingQualifies = basicShapeOk && (routing!.confidence === 'high' || namesItsSingleSection);

          const imageGenerateShapeOk = !!routing &&
            routing.type === 'image_generate' &&
            routing.confidence === 'high' &&
            typeof routing.image_prompt === 'string' && routing.image_prompt.trim().length > 0 &&
            routing.target_sections.length >= 1 &&
            routing.target_sections.length <= 3 &&
            routing.target_sections.every((n) => slSections.some((s) => s.name === n));

          if (routingQualifies) {
            targetSections = (routing as { target_sections: string[] }).target_sections;
          } else if (imageGenerateShapeOk) {
            const pageSlugForImage = page.slug ?? crypto.randomUUID();
            sendSSE(controller, { type: 'status', message: 'Generating image...' });
            const generatedUrl = await generateAndUploadImage(routing!.image_prompt!, pageSlugForImage);
            if (generatedUrl) {
              sendSSE(controller, { type: 'image_ready', url: generatedUrl });
              targetSections = routing!.target_sections;
              generatedImageUrl = generatedUrl;
            } else {
              console.error('[pages/follow-up] image_generate routing qualified but image generation failed — falling back to full-page path', { routing });
            }
          } else {
            console.log('[pages/follow-up] routing did not qualify for scoped patch, falling back to full-page path', {
              routing,
              knownSectionNames: slSections.map((s) => s.name),
            });
          }
        }

        if (targetSections && targetSections.length > 0) {
          if (request.signal.aborted) { closeSSE(controller); return; }
          sendSSE(controller, { type: 'status', message: 'Applying patch...' });

          const scopedPrompt = generatedImageUrl
            ? `${prompt}\n\n(A new image has just been generated for this request — it is attached below. Use it as the src/background for the relevant element in this section; do not generate or invent a different image.)`
            : prompt;
          const scopedImageUrls = generatedImageUrl ? [...effectiveImageUrls, generatedImageUrl] : effectiveImageUrls;

          const patchedSections: Array<{ name: string; html: string }> = [];
          let allOk = true;
          for (const name of targetSections) {
            const section = slSections.find((s) => s.name === name);
            if (!section) { allOk = false; break; }
            const schemaSlice = { [name]: (schema as Record<string, unknown> | null | undefined)?.[name] };
            const updated = await runScopedPatch(section.html, schemaSlice, scopedPrompt, scopedImageUrls);
            if (!updated) {
              console.error(`[pages/follow-up] scoped patch returned no html for section "${name}" — falling back to full-page path`);
              allOk = false;
              break;
            }
            if (!sanityCheckScopedSection(section.html, updated)) {
              console.error(`[pages/follow-up] scoped patch failed sanity check for section "${name}" — falling back to full-page path`, {
                originalOuterTag: outerTag(section.html),
                updatedOuterTag: outerTag(updated),
                updatedPreview: updated.slice(0, 300),
              });
              allOk = false;
              break;
            }
            patchedSections.push({ name, html: updated });
          }

          if (allOk && patchedSections.length === targetSections.length) {
            finalHtml = applyPatch(html, patchedSections);
            scopedApplied = true;
          }
        }
      }

      // ── Fallback: today's full-page single-call path, unchanged ──────────
      if (!scopedApplied) {
      if (competitorUrls.length > 0) {
        let hostname = competitorUrls[0];
        try { hostname = new URL(competitorUrls[0]).hostname; } catch { /* keep raw */ }
        sendSSE(controller, { type: 'status', message: `Fetching ${hostname}...` });
        competitorContext = await scrapeCompetitorUrl(competitorUrls[0]);
      }

      if (request.signal.aborted) { closeSSE(controller); return; }

      const hasCompetitorContext =
        (competitorContext?.screenshots?.length ?? 0) > 0 || !!competitorContext?.cssTokens;

      // Emit status before Pass 1
      sendSSE(controller, {
        type: 'status',
        message: competitorUrls.length > 0 ? 'Analyzing design...' : 'Applying changes...',
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
              ...effectiveImageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
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

      resultType = parsed.type;

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
      } // end fallback full-page path (!scopedApplied)

      // Strip STATUS comments before upload
      finalHtml = finalHtml.replace(/<!--\s*STATUS:[^>]*-->/g, '');

      // No-op guard: if nothing actually changed (e.g. a patch matched no markers),
      // skip the upload and the UTM mapping/rule wipe — don't destroy the user's
      // personalization work for an edit that had no effect
      const htmlUnchanged = finalHtml === html;

      // Variant pages write to draft_* columns and never touch the live storage
      // file a test is actually serving — only "Replace Current Variant" uploads
      // to the live path. Non-variant pages behave exactly as before.
      let htmlUrl: string = page.html_url ?? '';
      if (!htmlUnchanged && !isVariant) {
        const storagePath = fileNameFromUrl(page.html_url);
        htmlUrl = await uploadHtml(storagePath, finalHtml);
      }

      // Save conversation
      const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
      if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
      const updatedConversation = [
        ...history,
        userEntry,
        { role: 'assistant', content: JSON.stringify({ type: resultType, schema_json: finalSchemaJson ?? schema }) },
      ];

      const updatePayload: Record<string, unknown> = {
        conversation_json: updatedConversation,
        updated_at: new Date().toISOString(),
      };
      if (!htmlUnchanged) {
        if (isVariant) {
          updatePayload.draft_html_content = finalHtml;
        } else {
          updatePayload.html_url = htmlUrl;
          updatePayload.html_content = finalHtml.length < 500_000 ? finalHtml : null;
          // HTML was rewritten by the AI — old UTM selectors can't be trusted, so
          // clear mappings (and rules below), same as manual HTML edits do
          updatePayload.field_selectors_json = null;
        }
      }
      if (resultType === 'structural' && finalSchemaJson) {
        if (isVariant) {
          updatePayload.draft_schema_json = finalSchemaJson;
        } else {
          updatePayload.schema_json = finalSchemaJson;
        }
      }

      // Live selector/personalization invalidation only applies when live HTML
      // actually changed — variant drafts don't touch live HTML, so nothing to wipe
      // here; that happens instead when the draft is promoted via Replace.
      if (!htmlUnchanged && !isVariant) {
        await db.from('personalization_rules').delete().eq('page_id', params.id);
      }
      await db.from('pages').update(updatePayload).eq('id', params.id);

      const doneEvent: SSEEvent = {
        type: 'done',
        // For variant drafts this is the unchanged live URL — the client only
        // uses it as a cache-busting trigger to refetch /preview, which serves
        // the draft content directly.
        html_url: htmlUrl,
        ...(finalSchemaJson ? { schema_json: finalSchemaJson } : {}),
        ...(competitorUrls.length > 0 && !competitorContext ? { competitor_fetch_failed: true } : {}),
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

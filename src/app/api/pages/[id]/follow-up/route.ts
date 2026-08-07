import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { jsonrepair } from 'jsonrepair';
import { askAI, askAIStream, isRateLimited, generatePageImages, generateAndUploadImage, AIResponseTruncatedError, isPromptTooLongError, userFacingAIErrorMessage, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { extractUrls, scrapeCompetitorUrl } from '@/lib/ai-competitor-scrape';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { createSSEStream, sendSSE, closeSSE, SSE_HEADERS, type SSEEvent } from '@/lib/sse';
import { isTestVariantPage } from '@/lib/page-drafts';
import { extractDataUris, restoreDataUris, restoreDataUrisInValue } from '@/lib/data-uri-strip';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

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

// Crude relative-luminance check on the first background-color/background hex
// found in a section's inline styles — good enough to tell the image-generation
// prompt "this section is dark, don't generate a dark logo that disappears into
// it." Not a full CSS cascade resolution (doesn't look at :root variables or
// external classes), just a same-order-of-magnitude signal for routing.
function detectBackgroundTone(html: string): 'dark' | 'light' | 'unknown' {
  const hexMatches = Array.from(
    html.matchAll(/background(?:-color)?\s*:\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})/g)
  );
  if (hexMatches.length === 0) return 'unknown';
  let hex = hexMatches[0][1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5 ? 'dark' : 'light';
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
    const tone = detectBackgroundTone(inner);
    const toneNote = tone !== 'unknown' ? ` [background: ${tone}]` : '';
    const text = (imgSrcs.length > 0 ? `${strippedText} [images: ${imgSrcs.join(', ')}]` : strippedText) + toneNote;
    sections.push({ name, html: inner, text });
  }
  return sections;
}

// Pass 0 — free, no AI call. If the instruction quotes actual page copy
// verbatim (8+ chars, single- or double-quoted) and that quote appears in
// exactly one section's text, we know the target section with certainty —
// skip the routing call entirely.
function extractQuotedPhrases(prompt: string): string[] {
  const phrases: string[] = [];
  const re = /["']([^"']{8,})["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) phrases.push(m[1].replace(/\s+/g, ' ').trim());
  return phrases;
}

/** Leading verbs that mark an instruction line (not pasted page copy). */
const INSTRUCTION_LINE_START =
  /^(change|rewrite|rephrase|improve|update|make|fix|edit|replace|please|can you|could you|i want|we'd like|we want)\b/i;

/**
 * Copy candidates for routing / surgical edits: quoted phrases PLUS unquoted
 * pasted lines (clients often paste a headline then write "change this…"
 * on the next line without quotes — see production logs).
 */
function extractCopyCandidates(prompt: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string) => {
    const phrase = raw.replace(/\s+/g, ' ').trim();
    if (phrase.length < 8 || seen.has(phrase.toLowerCase())) return;
    seen.add(phrase.toLowerCase());
    out.push(phrase);
  };
  for (const q of extractQuotedPhrases(prompt)) push(q);
  for (const line of prompt.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || INSTRUCTION_LINE_START.test(trimmed)) continue;
    push(trimmed);
  }
  return out;
}

function findUniqueSectionForPhrase(phrase: string, sections: SlSection[]): string | null {
  const matched = sections.filter((s) => s.text.includes(phrase));
  return matched.length === 1 ? matched[0].name : null;
}

function tryDirectQuoteMatch(prompt: string, sections: SlSection[]): string | null {
  const phrases = extractCopyCandidates(prompt);
  if (phrases.length === 0) return null;
  const matchedNames = new Set<string>();
  for (const phrase of phrases) {
    const name = findUniqueSectionForPhrase(phrase, sections);
    if (name) matchedNames.add(name);
  }
  return matchedNames.size === 1 ? Array.from(matchedNames)[0] : null;
}

/** True when the prompt is a copy rewrite, not a layout/structure/image ask. */
function isSimpleTextRewritePrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();
  if (/\b(https?:\/\/|www\.)/i.test(prompt)) return false;
  if (
    /\b(redesign|rebuild|restructure|layout|spacing|padding|margin|font-size|color|colour|background|image|logo|photo|section|add a |remove |delete |reorder|move .+ (above|below|before|after)|button style|css|stylesheet)\b/i.test(
      p,
    )
  ) {
    return false;
  }
  return (
    /\b(change|rewrite|rephrase|improve|update|better|alternative)\b/i.test(p) &&
    /\b(text|copy|headline|heading|title|subhead|sub-head|tagline|wording|this)\b/i.test(p)
  );
}

function replaceUniqueTextInHtml(html: string, oldText: string, newText: string): string | null {
  if (!oldText || !newText || oldText === newText) return null;
  const exactCount = html.split(oldText).length - 1;
  if (exactCount === 1) return html.replace(oldText, newText);
  // Allow flexible whitespace between words (HTML may differ slightly from pasted line).
  const escaped = oldText
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const global = new RegExp(escaped, 'g');
  const matches = html.match(global);
  if (!matches || matches.length !== 1) return null;
  return html.replace(new RegExp(escaped), newText);
}

const SURGICAL_TEXT_SYSTEM_PROMPT = `You rewrite a single piece of landing-page copy. Return JSON only — no markdown fences, no explanation.
{"text":"the new copy here"}

Rules:
- Return ONLY the new plain-text copy in "text" (no HTML tags).
- Keep a similar length and tone unless the instruction asks otherwise.
- Do not wrap the whole string in extra quotation marks unless they are part of the copy itself.`;

/**
 * Cheap path for "paste headline + change this text": rewrite the string in
 * place instead of asking Sonnet to regenerate the whole section HTML (which
 * often returns an inner <div> fragment and fails the outer-tag sanity check).
 */
async function trySurgicalTextEdit(
  prompt: string,
  sections: SlSection[],
): Promise<{ sectionName: string; html: string } | null> {
  if (!isSimpleTextRewritePrompt(prompt)) return null;
  const candidates = extractCopyCandidates(prompt);
  let oldText: string | null = null;
  let section: SlSection | null = null;
  for (const phrase of candidates) {
    const name = findUniqueSectionForPhrase(phrase, sections);
    if (!name) continue;
    const s = sections.find((x) => x.name === name);
    if (!s) continue;
    // Must be uniquely replaceable inside the raw section HTML (not only in
    // stripped text — headlines split across tags can't use this path).
    if (replaceUniqueTextInHtml(s.html, phrase, '\u0001') === null) continue;
    oldText = phrase;
    section = s;
    break;
  }
  if (!oldText || !section) return null;

  try {
    const text = await askAI({
      system: SURGICAL_TEXT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Current copy:\n${oldText}\n\nInstruction:\n${prompt}`,
        },
      ],
      maxTokens: 1000,
      label: 'follow-up:surgical-text',
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) raw = raw.slice(jsonStart, jsonEnd + 1);
    let parsed: { text?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON.parse(jsonrepair(raw));
    }
    const newText = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!newText) {
      console.error('[pages/follow-up] surgical text returned empty text', { rawPreview: text.slice(0, 500) });
      return null;
    }
    const updated = replaceUniqueTextInHtml(section.html, oldText, newText);
    if (!updated) {
      console.error('[pages/follow-up] surgical text could not uniquely replace copy in HTML', {
        section: section.name,
        oldPreview: oldText.slice(0, 120),
      });
      return null;
    }
    if (!sanityCheckScopedSection(section.html, updated)) {
      console.error('[pages/follow-up] surgical text broke outer-tag sanity (unexpected)', {
        section: section.name,
      });
      return null;
    }
    return { sectionName: section.name, html: updated };
  } catch (err) {
    console.error('[pages/follow-up] surgical text rewrite failed', err);
    return null;
  }
}

const ROUTING_SYSTEM_PROMPT = `You are a routing classifier for a landing-page AI edit assistant. Given a list of the page's sections (name + a short text/image preview of each) and an edit instruction, decide which section(s) the instruction targets and how big the change is.

Return JSON only. No markdown fences, no explanation.
{"type":"patch"|"style"|"structural"|"image_generate"|"insert_section"|"remove_section"|"reorder_sections","target_sections":["section-name", ...],"confidence":"high"|"low","image_prompt":"...","anchor_section":"...","position":"before"|"after","new_order":["section-name", ...]}

Rules:
- "patch": the instruction clearly targets 1-3 specific existing sections you can identify from the previews below (a heading, button, image, paragraph, one section's design/spacing/color, or a full redesign/rebuild of ONE existing section).
- "style": the instruction touches 4+ sections, or a global CSS/font/color variable change (route this to the "head" section), or you cannot map it to specific sections from the previews given (e.g. "make the whole page feel more premium").
- "insert_section": the instruction clearly asks to ADD exactly ONE brand-new section, and you can confidently name an existing section to place it relative to. Return "anchor_section" (an existing section name from the list) and "position" ("before" or "after" that anchor). If the instruction doesn't say where, pick the most sensible spot (e.g. right after the section it's most related to, or right before "footer" as a safe default). Do NOT use this for adding more than one new section, or when you can't confidently pick an anchor — use "structural" instead for those.
- "remove_section": the instruction clearly asks to remove exactly ONE existing section entirely. Return that section's name as the single entry in "target_sections". Use "structural" instead if more than one section should be removed, or the target section is ambiguous.
- "reorder_sections": the instruction asks to reorder 2 or more EXISTING sections relative to each other (e.g. "move testimonials above the stats section") without adding/removing anything or changing their content. Return the full new relative order of ONLY the sections that need to move, as "new_order" (an array of existing section names, in the desired new sequence) — e.g. for "move testimonials above stats", new_order:["testimonials","stats"] (testimonials will end up positioned immediately before "stats"). Use "structural" instead if the reorder is tangled up with content changes, or spans 4+ sections, or you're not confident of the exact target section names.
- "structural": the instruction adds, removes, or reorders whole sections in a way that doesn't cleanly fit "insert_section"/"remove_section"/"reorder_sections" above (multiple sections at once, ambiguous placement, or combined with a broader redesign). Swapping/replacing an existing image with a user-attached image (see note below) is NOT structural — it's a "patch" on whichever section holds that image, same as swapping any other element.
- "image_generate": the instruction asks for a brand-new image/logo to be AI-generated from a text description (no user-attached image, no existing image referenced by URL) AND the ONLY change is generating that image and placing it into 1-3 EXISTING sections — no sections are being added, removed, or reordered. Treat any instruction phrased as "create/generate a new X and replace/swap it with the current/existing one" as meaning "replace the CURRENT X with a NEW generated one" — that phrasing is a common but confusing way real users describe swapping in a new asset; never interpret it as "keep the old one unchanged" or "revert to the current one." If the request also restructures the page (e.g. "add a new testimonials section with AI-generated photos"), that is "insert_section" or "structural", not "image_generate" — image_generate is only for a pure image-swap-via-generation on sections that already exist.
  When you pick "image_generate", also return "image_prompt": a complete, standalone image-generation prompt — it is sent directly to an image model with NO other context, so it must stand on its own and must be fully decided, with zero ambiguity.
  **Pick exactly ONE business name.** The schema may mention more than one name-like string (a company name, a product name, a tagline). You MUST resolve this to a single definitive name before writing the prompt — never write "X or Y", never write two candidate names separated by "or"/"/", never hedge. If genuinely unclear, prefer whichever name appears in the nav/header/logo area of the schema over one that only appears in body copy.
  **User-specified details always win.** If the instruction itself states a color, style, icon idea, mood, or any other concrete visual detail (e.g. "make it blue", "minimalist", "use a mountain icon", "keep it playful"), that detail MUST appear in the image_prompt and overrides whatever the schema's palette/style would otherwise suggest. Only fall back to schema-derived colors/style/industry cues to fill in whatever the instruction left unspecified — never let a schema default silently override something the user actually asked for.
  **Logo prompt formula (use this structure, don't freestyle):** "A flat vector logo icon for '<exact single business name>', a <industry/niche in 2-4 words>. <1-2 concrete visual concepts — use the user's own icon/style idea from the instruction if they gave one, otherwise pick something specific to this industry, e.g. an oil derrick silhouette, a coffee bean, a shield — NOT a generic swoosh or abstract blob>. Minimal geometric icon mark, <2-3 colors — the user's specified colors if given, otherwise exact colors from the schema's palette/brand>, flat solid colors only, no gradients, no drop shadows, no photorealism, no 3D rendering, clean vector illustration style, centered composition on a transparent background, generous negative space, high resolution."
  **No readable text in the image, unless unavoidable.** Image models render text poorly (garbled letters, misspellings) — default to an ICON-ONLY mark with no business name lettered into the image at all, since the business name is already rendered as real HTML text next to the logo image in virtually every navbar/footer. Only include the name as image text if the instruction explicitly demands a wordmark/text-based logo, and even then keep it to one short word in large simple lettering.
  You are also given each section's background tone as "[background: dark]" or "[background: light]" in the section list below when detectable — the generated image MUST contrast against the background of the section(s) it's being placed into: for a dark-background section, specify light/white/pale coloring; for a light-background section, specify dark coloring. If tone isn't given, favor a mid-tone/colorful mark that isn't itself near-white or near-black, so it holds up on either background.
  Example: instruction "create a new logo and replace the current one" for a schema whose nav says "American Oil & Gas" (an oil and gas exploration company), targeting a section marked "[background: dark]" → image_prompt: "A flat vector logo icon for 'American Oil & Gas', an oil and gas exploration company. An oil derrick silhouette icon. Minimal geometric icon mark, warm gold and cream tones, flat solid colors only, no gradients, no drop shadows, no photorealism, no 3D rendering, clean vector illustration style, centered composition on a transparent background, generous negative space, high resolution."
  Always include "transparent background" and "high resolution" so it composites cleanly into the section.
- Confidence is about WHICH SECTION, not about literal wording match. The instruction will often describe UI in generic terms ("button", "form", "banner") that don't literally match the underlying HTML tag — a labeled pill, badge, link, or div styled as a button all count as a match for "button." If exactly one section's preview clearly contains the referenced text/element, that is high confidence — do not lower it just because the HTML tag isn't literally a <button>/<form>/etc. The same applies to "insert_section"'s anchor, "remove_section"'s target, and "reorder_sections"' new_order — if you can confidently name the section(s) from the list, that is high confidence, even for a simple, plainly-worded request like "add a pricing section after X" or "remove the calculator."
- Set confidence "low" only when the referenced element/text/section could plausibly belong to two or more different sections, or doesn't appear in any preview at all — including truly ambiguous image references ("use this image" when multiple sections have images) or vague whole-page requests ("make it feel more premium"). When confidence is "low" it is fine to still fill in your best guess for type/target_sections — the caller ignores them and falls back to full-page handling.
- Only ever use section names EXACTLY as given in the list — never invent one.`;

interface RoutingResult {
  type: string;
  target_sections: string[];
  confidence: string;
  image_prompt?: string;
  anchor_section?: string;
  position?: string;
  new_order?: string[];
}

async function tryRoutingCall(
  prompt: string,
  schema: unknown,
  sections: SlSection[],
  hasUserImages: boolean,
): Promise<RoutingResult | null> {
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
      // Sonnet 5 runs adaptive thinking by default, which competes with
      // maxTokens against the same budget as the actual JSON output — 300
      // was sized for Haiku (no thinking overhead) and would truncate a
      // Sonnet response mid-object. Matches the ceiling already used for
      // every other Sonnet call in this file (no extra cost: Anthropic
      // bills actual output tokens generated, not this ceiling).
      maxTokens: 128000,
      // No explicit `model` — defaults to Sonnet (see askAnthropic), same as
      // every other AI call in this file. Was pinned to Haiku; switched to
      // the default model for better routing accuracy/confidence-calibration.
      label: 'follow-up:routing',
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
- NEVER change the section's outermost tag. Whatever tag the input section's outermost element opens with (e.g. <section>, <div>, <article>), your output's outermost element MUST open with that exact same tag — even when redesigning or rebuilding everything inside it. The page's global stylesheet often has rules keyed to that tag name (e.g. "section { padding: 80px 0; }"), so swapping it silently breaks that section's spacing/layout even if the content itself is otherwise correct. You may freely restructure everything inside the outer tag.
- Never leave old and new markup coexisting. If the instruction asks to redesign, rebuild, tighten, or otherwise change a part of the section (e.g. "the nav bar looks off, redesign it"), your output must REPLACE that part entirely — delete every old element it's replacing (old logo, old links, old buttons, old wrapper divs) before/while adding the new ones. Never append new elements next to old ones that do the same job, and never return a section where the same logical item (e.g. the same nav link, the same CTA button) appears twice.
- Sections sometimes contain a visually distinct navigation bar or top logo/header strip nested inside them (e.g. a slim top bar with just a logo, or a <nav> element, sitting above the section's main content) — this can happen because the page has no separate "nav" section of its own. If the instruction does not explicitly mention the nav, logo, header, or top bar (e.g. it only talks about "the hero," "this section's layout," "the headline," "the CTA button" — not the nav/logo/header specifically), you MUST leave that nested nav/logo/header block completely untouched, byte-for-byte, and apply the requested change only to the rest of the section. Only touch the nav/logo/header block if the instruction is clearly about it.
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
  /** Optional corrective note appended on a retry (outer-tag / JSON shape). */
  correctionNote?: string,
): Promise<string | null> {
  try {
    // The image content blocks below only give the model PIXELS — the
    // literal URL string is never otherwise visible to it, so without this
    // it has no way to know what to actually write into an <img src="...">.
    // Every attached image is listed here by index so the model can quote
    // the exact URL string back into the HTML it returns.
    const imageUrlsNote = (imageUrls ?? []).length > 0
      ? `\n\nAttached image URL(s) — use these EXACT strings verbatim in any src attribute, in the order attached:\n${(imageUrls ?? []).map((u, i) => `${i + 1}. ${u}`).join('\n')}`
      : '';
    const correctionBlock = correctionNote ? `\n\n${correctionNote}` : '';
    const userContent: AIContent = [
      ...(imageUrls ?? []).map((url): AIContentBlock => ({ type: 'image', url })),
      {
        type: 'text' as const,
        text: `Schema slice for this section:\n${JSON.stringify(schemaSlice)}\n\nCurrent section HTML:\n${sectionHtml}\n\nInstruction: ${prompt}${imageUrlsNote}${correctionBlock}`,
      },
    ];
    const text = await askAI({
      system: SCOPED_PATCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 128000,
      label: correctionNote ? 'follow-up:scoped-patch-retry' : 'follow-up:scoped-patch',
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
        isRetry: !!correctionNote,
      });
      return null;
    }
    if (!parsed.html || typeof parsed.html !== 'string') {
      console.error('[pages/follow-up] scoped patch JSON parsed but had no "html" field', {
        rawLength: text.length,
        rawPreview: text.slice(0, 1500),
        isRetry: !!correctionNote,
      });
      return null;
    }
    return parsed.html;
  } catch (err) {
    console.error('[pages/follow-up] scoped patch generation failed', err);
    return null;
  }
}

/**
 * Accept a scoped-patch candidate: exact outer-tag match, OR repair by
 * re-wrapping the model's HTML in the original opening tag (section→div case).
 */
function acceptScopedPatchHtml(
  sectionHtml: string,
  candidate: string | null,
  source: 'first-attempt' | 'retry',
): string | null {
  if (!candidate) return null;
  if (sanityCheckScopedSection(sectionHtml, candidate)) return candidate;
  const repaired = repairScopedSectionOuterTag(sectionHtml, candidate);
  if (repaired) {
    console.warn('[pages/follow-up] scoped patch outer-tag repaired', {
      requiredTag: outerTag(sectionHtml),
      gotTag: outerTag(candidate),
      source,
      originalLen: sectionHtml.length,
      candidateLen: candidate.length,
      repairedLen: repaired.length,
    });
    return repaired;
  }
  return null;
}

/**
 * Scoped patch self-heal:
 * 1) generate
 * 2) if outer tag wrong → repair wrapper (keep original <section …>, use model HTML inside)
 * 3) only if repair can't save it → one corrective model retry, then repair again
 */
async function runScopedPatchWithRetry(
  sectionHtml: string,
  schemaSlice: unknown,
  prompt: string,
  imageUrls: string[] | undefined,
): Promise<{ html: string | null; failedSanity: boolean; failedParse: boolean }> {
  const requiredTag = outerTag(sectionHtml);

  const first = await runScopedPatch(sectionHtml, schemaSlice, prompt, imageUrls);
  const firstOk = acceptScopedPatchHtml(sectionHtml, first, 'first-attempt');
  if (firstOk) {
    return { html: firstOk, failedSanity: false, failedParse: false };
  }

  const gotTag = first ? outerTag(first) : null;
  const correction = first
    ? `CRITICAL CORRECTION — your previous answer was rejected.\n` +
      `- You returned HTML whose outermost tag was <${gotTag ?? 'unknown'}>.\n` +
      `- The section's outermost tag MUST remain <${requiredTag}> (same as the input).\n` +
      `- Return the COMPLETE section HTML starting with <${requiredTag} ...>, not an inner fragment (e.g. not a nested <div class="herotop"> alone).\n` +
      `- Response must still be ONLY {"html":"..."} JSON.`
    : `CRITICAL CORRECTION — your previous answer was not valid JSON with an "html" string.\n` +
      `- Respond with ONLY {"html":"...complete section HTML..."}.\n` +
      `- Outermost tag MUST be <${requiredTag}>.`;

  console.warn('[pages/follow-up] scoped patch retrying once after', first ? 'sanity-check/repair failure' : 'parse/empty failure', {
    requiredTag,
    gotTag,
  });

  const second = await runScopedPatch(sectionHtml, schemaSlice, prompt, imageUrls, correction);
  const secondOk = acceptScopedPatchHtml(sectionHtml, second, 'retry');
  if (secondOk) {
    return { html: secondOk, failedSanity: false, failedParse: false };
  }
  if (!first && !second) {
    return { html: null, failedSanity: false, failedParse: true };
  }
  return { html: null, failedSanity: true, failedParse: false };
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

/**
 * Self-heal for the common scoped-patch failure: model returns a solid edit
 * rooted at <div> (or another tag) instead of the original <section>.
 *
 * Keep the original opening tag byte-for-byte (classes, ids, data-*), wrap the
 * model's HTML as the body, close with the original tag name.
 *
 * Rejects full documents and tiny collapsed fragments so we don't "heal"
 * garbage into the page.
 */
function repairScopedSectionOuterTag(original: string, updated: string): string | null {
  const origTag = outerTag(original);
  const newTag = outerTag(updated);
  if (!origTag || !newTag) return null;
  if (origTag === newTag) return updated;

  if (
    newTag === 'html' ||
    newTag === 'head' ||
    newTag === 'body' ||
    /^\s*<!DOCTYPE/i.test(updated)
  ) {
    return null;
  }

  // Opening tag with attributes — do not use a bare <section>.
  const openMatch = new RegExp(`^\\s*(<${origTag}\\b[^>]*>)`, 'i').exec(original);
  if (!openMatch) return null;
  const openTag = openMatch[1];

  const inner = updated.trim();
  // Collapsed junk guard (e.g. only a nested herotop strip). Require the
  // candidate to be a meaningful fraction of the original — absolute floor
  // so tiny originals aren't trivially "repaired" with a short div.
  const origLen = original.trim().length;
  const minLen = Math.max(150, Math.floor(origLen * 0.25));
  if (inner.length < minLen) {
    console.warn('[pages/follow-up] outer-tag repair skipped — candidate too small', {
      requiredTag: origTag,
      gotTag: newTag,
      innerLen: inner.length,
      minLen,
      originalLen: origLen,
    });
    return null;
  }

  const repaired = `${openTag}\n${inner}\n</${origTag}>`;
  if (!sanityCheckScopedSection(original, repaired)) return null;
  return repaired;
}

// ── Scoped structural ops: insert / remove / reorder a section ─────────────
// These handle the three most common "structural" requests (add a section,
// delete a section, move sections around) WITHOUT the expensive full-page
// reclassify-then-rebuild path — see docs/ai-edit-timeout-diagnosis.md.
// remove/reorder never call the AI at all (pure string splicing on the
// existing <!-- SL:name --> markers); insert makes one small, scoped AI call
// for just the new section's HTML. All three fall back to the full-page path
// (return null / not applied) if a target marker can't be confidently found —
// same fallback discipline as the existing scoped-patch mechanism.

// Locates the FULL <!-- SL:name --> ... <!-- /SL:name --> block, markers
// included (unlike extractSlSections(), which returns the stripped inner
// content only) — needed here because these ops move/delete/insert relative
// to the marker comments themselves, not just the content between them.
function findSlBlockBounds(html: string, name: string): [number, number] | null {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeName) return null;
  const re = new RegExp(`<!-- SL:${safeName} -->[\\s\\S]*?<!-- /SL:${safeName} -->`);
  const m = re.exec(html);
  return m ? [m.index, m.index + m[0].length] : null;
}

function removeSlSection(html: string, name: string): string | null {
  const bounds = findSlBlockBounds(html, name);
  if (!bounds) return null;
  const [start, end] = bounds;
  return html.slice(0, start) + html.slice(end);
}

// Re-sequences the named sections to appear, contiguously, in `orderedNames`
// order, starting at the position of whichever of them appears first in the
// original document. Every other section (and everything else in the page)
// is left byte-for-byte untouched. Returns null if any named section's
// marker can't be found — caller falls back to the full-page path.
function reorderSlSections(html: string, orderedNames: string[]): string | null {
  const blocks: Array<{ name: string; start: number; end: number; text: string }> = [];
  for (const name of orderedNames) {
    const bounds = findSlBlockBounds(html, name);
    if (!bounds) return null;
    const [start, end] = bounds;
    blocks.push({ name, start, end, text: html.slice(start, end) });
  }

  const insertAt = Math.min(...blocks.map((b) => b.start));

  // Remove every matched block from the document, rightmost first, so an
  // earlier removal never shifts the index of a removal still pending.
  let result = html;
  const byDocOrderDesc = [...blocks].sort((a, b) => b.start - a.start);
  for (const b of byDocOrderDesc) {
    result = result.slice(0, b.start) + result.slice(b.end);
  }

  // `insertAt` is the leftmost original block's start — nothing before it was
  // ever removed, so it's still a valid split point in `result`.
  const orderedText = orderedNames.map((name) => blocks.find((b) => b.name === name)!.text).join('\n');
  return result.slice(0, insertAt) + orderedText + result.slice(insertAt);
}

function insertSlSectionBlock(
  html: string,
  anchorName: string,
  position: 'before' | 'after',
  wrappedNewBlock: string,
): string | null {
  const bounds = findSlBlockBounds(html, anchorName);
  if (!bounds) return null;
  const [start, end] = bounds;
  return position === 'after'
    ? html.slice(0, end) + '\n' + wrappedNewBlock + html.slice(end)
    : html.slice(0, start) + wrappedNewBlock + '\n' + html.slice(start);
}

function dedupeSectionName(name: string, usedNames: string[]): string {
  if (!usedNames.includes(name)) return name;
  let n = 2;
  while (usedNames.includes(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

// Minimal local copy of schema-from-html's setPathValue — small enough that
// sharing it isn't worth a cross-route import for this one call site.
function setDotPathValue(root: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.').filter(Boolean);
  if (keys.length === 0) return;
  let current: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const existing = current[key];
    if (typeof existing !== 'object' || existing === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

// Builds the schema slice for a brand-new section from its own data-field
// attributes — the same idea as schema-from-html's field extraction, but far
// simpler here since we already have the exact new HTML in hand (no
// text-matching against a larger document needed).
function extractDataFieldsFromHtml(html: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)data-field\s*=\s*["']([^"']+)["']([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase();
    const dotPath = m[3];
    if (tag === 'img') {
      const attrs = m[2] + m[4];
      const srcMatch = /src\s*=\s*["']([^"']*)["']/.exec(attrs);
      setDotPathValue(result, dotPath, srcMatch ? srcMatch[1] : '');
    } else {
      const closeIdx = html.indexOf(`</${tag}>`, tagRe.lastIndex);
      const inner = closeIdx !== -1 ? html.slice(tagRe.lastIndex, closeIdx) : '';
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      setDotPathValue(result, dotPath, text);
    }
  }
  return result;
}

const SCOPED_INSERT_SYSTEM_PROMPT = `You are adding ONE brand-new section to an existing, already-designed landing page. You are given the page's global <style> block (for colors, fonts, spacing, existing CSS classes/variables) and one neighboring section's HTML (for structural/style reference). Do not touch or return anything except the new section.

IMPORTANT: Your entire response must be ONLY the JSON object below — begin your response with { and end it with }. Do NOT write any explanation, reasoning, preamble, or markdown code fences before or after the JSON. Any text outside the JSON object will break the parser.

{"name":"kebab-case-section-name","html":"...complete new section HTML, a single top-level element..."}

Rules:
- Match the page's existing visual design system as closely as possible — reuse existing CSS custom properties/:root variables, existing class names, and existing font/color choices where they fit, rather than inventing an unrelated new look.
- If new CSS is genuinely needed for this section, add a small scoped <style> block inside the section itself (or inline styles) — never modify the page's shared/global stylesheet.
- The new section must be a single top-level element (e.g. one <section>...</section>). Do NOT include <!-- SL:name --> markers yourself — the caller adds those around whatever you return.
- Give every editable text/image element in the new section a data-field attribute, using the dot-path pattern "<name>.<field>" where <name> matches the "name" you return, e.g. data-field="pricing-tiers.title", data-field="pricing-tiers.items.0.price". Repeated items use indexed keys: .items.0, .items.1, ...
- "name" must be a short, unique, kebab-case identifier describing the section (e.g. "pricing-tiers", "faq"), and must not collide with any of the page's existing section names given below.
- Never select or modify any element outside the new section.
- Never add an external <script src> to a third-party domain.
- If any copy in your output contains a double-quote character, escape it as \\" — invalid JSON breaks the parser.`;

async function runScopedInsert(
  anchorSectionHtml: string,
  headSectionHtml: string,
  existingSectionNames: string[],
  prompt: string,
  imageUrls: string[] | undefined,
): Promise<{ name: string; html: string } | null> {
  try {
    // Defensive cap — this is a small, scoped call (writing one section, not
    // rebuilding the page), but a legacy page's global stylesheet can still be
    // enormous; truncate rather than let one page blow up this call's cost.
    const truncatedHead = headSectionHtml.length > 20_000
      ? `${headSectionHtml.slice(0, 20_000)}\n/* ...truncated... */`
      : headSectionHtml;
    const imageUrlsNote = (imageUrls ?? []).length > 0
      ? `\n\nAttached image URL(s) — use these EXACT strings verbatim in any src attribute, in the order attached:\n${(imageUrls ?? []).map((u, i) => `${i + 1}. ${u}`).join('\n')}`
      : '';
    const userContent: AIContent = [
      ...(imageUrls ?? []).map((url): AIContentBlock => ({ type: 'image', url })),
      {
        type: 'text' as const,
        text: `Page's existing section names (the new name must not match any of these): ${existingSectionNames.join(', ')}\n\nPage's global styles:\n${truncatedHead}\n\nNeighboring section HTML (for style/structure reference):\n${anchorSectionHtml}\n\nInstruction: ${prompt}${imageUrlsNote}`,
      },
    ];
    const text = await askAI({
      system: SCOPED_INSERT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 128000,
      label: 'follow-up:scoped-insert',
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) raw = raw.slice(jsonStart, jsonEnd + 1);
    let parsed: { name?: string; html?: string };
    try {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = JSON.parse(jsonrepair(raw));
      }
    } catch {
      console.error('[pages/follow-up] scoped insert returned unparseable JSON', {
        rawLength: text.length,
        rawPreview: text.slice(0, 1500),
      });
      return null;
    }
    if (!parsed.name || typeof parsed.name !== 'string' || !parsed.html || typeof parsed.html !== 'string') {
      console.error('[pages/follow-up] scoped insert JSON missing name/html', { rawPreview: text.slice(0, 1500) });
      return null;
    }
    const safeName = parsed.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safeName || !outerTag(parsed.html)) {
      console.error('[pages/follow-up] scoped insert returned an unusable name or html', { rawPreview: text.slice(0, 500) });
      return null;
    }
    return { name: dedupeSectionName(safeName, existingSectionNames), html: parsed.html };
  } catch (err) {
    console.error('[pages/follow-up] scoped insert generation failed, falling back to full-page path', err);
    return null;
  }
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

  const startedAt = Date.now();

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
        { error: 'AI page editing requires a Growth, Agency, or Scale plan. Please upgrade to use this feature.', limitError: true },
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
  let schema = current_schema ?? baseSchema;
  let html = current_html ?? baseHtml ?? (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
  if (!html) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 400 });

  // Every AI call below (routing, scoped patch/insert, and the full-page
  // fallback) reads `html`/`schema` — schema_json now stores REAL base64 for
  // image fields (so the editor shows real thumbnails), and a handful of
  // embedded images routinely pushes the combined prompt past the model's
  // token ceiling (seen in practice: a 2.2MB page → 2M+ tokens, rejected
  // outright). Swap real image bytes for short placeholders once here, before
  // any AI call or section/string splicing happens, and restore them only
  // once at the very end (see `finalHtmlReal`/`finalSchemaJsonReal` below) —
  // every intermediate operation (splicing, matching, prompting) works
  // identically on placeholders since none of it inspects image byte content.
  const DATA_URI_SPLIT = ' __SL_HTML_SCHEMA_BOUNDARY__ ';
  const combinedForStrip = html + DATA_URI_SPLIT + JSON.stringify(schema ?? null);
  const { html: combinedStripped, map: dataUriMap } = extractDataUris(combinedForStrip);
  const [htmlNoDataUris, schemaStrNoDataUris] = combinedStripped.split(DATA_URI_SPLIT);
  html = htmlNoDataUris;
  schema = JSON.parse(schemaStrNoDataUris);

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
      // Set only when routing already qualified a request for a scoped op
      // (patch/insert/remove/reorder/image_generate) and OUR OWN code then
      // failed to execute it (parse failure, deterministic splice failure,
      // generation failure, etc.) — as opposed to routing legitimately
      // declining to qualify (vague prompt, low confidence, no markers),
      // which must still fall through to the full-page path below unchanged.
      // When set, we short-circuit before the full-page path even starts —
      // retrying as a full-page rebuild would blame the user's wording for
      // a bug that isn't theirs, and can trigger an expensive/oversized call
      // on a page a cheap scoped op was already meant to avoid touching.
      let scopedFailureReason: string | null = null;
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

        // Surgical copy rewrite first — avoids full-section HTML regeneration
        // for "paste headline + change this text" prompts (no images / competitor).
        if (!hasUserImages && !scopedApplied && isSimpleTextRewritePrompt(prompt)) {
          sendSSE(controller, { type: 'status', message: 'Updating text...' });
          const surgical = await trySurgicalTextEdit(prompt, slSections);
          if (surgical) {
            finalHtml = applyPatch(html, [{ name: surgical.sectionName, html: surgical.html }]);
            scopedApplied = true;
            console.log('[pages/follow-up] surgical text edit applied', {
              section: surgical.sectionName,
              promptPreview: prompt.slice(0, 300),
            });
          }
        }

        if (!scopedApplied && !targetSections) {
          sendSSE(controller, { type: 'status', message: 'Locating section...' });
          const routing = await tryRoutingCall(prompt, schema, slSections, hasUserImages);
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

          // Three more scoped ops — see docs/ai-edit-timeout-diagnosis.md.
          // These cover the common "add/remove/reorder a section" requests
          // that used to always fall into the expensive full-page rebuild
          // even though they're just as scoped as a text patch.
          const removeShapeOk = !!routing &&
            routing.type === 'remove_section' &&
            routing.confidence === 'high' &&
            routing.target_sections.length === 1 &&
            slSections.some((s) => s.name === routing.target_sections[0]);

          const reorderShapeOk = !!routing &&
            routing.type === 'reorder_sections' &&
            routing.confidence === 'high' &&
            Array.isArray(routing.new_order) &&
            routing.new_order.length >= 2 &&
            new Set(routing.new_order).size === routing.new_order.length &&
            routing.new_order.every((n) => slSections.some((s) => s.name === n));

          const insertShapeOk = !!routing &&
            routing.type === 'insert_section' &&
            routing.confidence === 'high' &&
            typeof routing.anchor_section === 'string' &&
            slSections.some((s) => s.name === routing.anchor_section) &&
            (routing.position === 'before' || routing.position === 'after');

          console.log('[pages/follow-up] routing decision', {
            promptPreview: prompt.slice(0, 300),
            routing,
            qualifies: routingQualifies || removeShapeOk || reorderShapeOk || insertShapeOk || imageGenerateShapeOk,
          });

          if (routingQualifies) {
            targetSections = (routing as { target_sections: string[] }).target_sections;
          } else if (removeShapeOk) {
            const removeName = routing!.target_sections[0];
            sendSSE(controller, { type: 'status', message: 'Removing section...' });
            const removedHtml = removeSlSection(html, removeName);
            if (removedHtml) {
              finalHtml = removedHtml;
              scopedApplied = true;
              if (schema && typeof schema === 'object' && removeName in (schema as Record<string, unknown>)) {
                const schemaCopy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
                delete schemaCopy[removeName];
                finalSchemaJson = schemaCopy;
              }
            } else {
              console.error(`[pages/follow-up] remove_section could not find marker for "${removeName}" — this is our own bug, not falling back to full-page`);
              scopedFailureReason = 'remove_section_marker_not_found';
            }
          } else if (reorderShapeOk) {
            sendSSE(controller, { type: 'status', message: 'Reordering sections...' });
            const reordered = reorderSlSections(html, routing!.new_order!);
            if (reordered) {
              finalHtml = reordered;
              scopedApplied = true;
            } else {
              console.error('[pages/follow-up] reorder_sections failed to locate all target markers — this is our own bug, not falling back to full-page', { new_order: routing!.new_order });
              scopedFailureReason = 'reorder_sections_marker_not_found';
            }
          } else if (insertShapeOk) {
            if (request.signal.aborted) { closeSSE(controller); return; }
            sendSSE(controller, { type: 'status', message: 'Writing new section...' });
            const anchorName = routing!.anchor_section!;
            const anchorSection = slSections.find((s) => s.name === anchorName)!;
            const headSection = slSections.find((s) => s.name === 'head');
            const usedNames = slSections.map((s) => s.name);
            const inserted = await runScopedInsert(anchorSection.html, headSection?.html ?? '', usedNames, prompt, effectiveImageUrls);
            if (inserted) {
              const wrappedBlock = `<!-- SL:${inserted.name} -->\n${inserted.html.trim()}\n<!-- /SL:${inserted.name} -->`;
              const spliced = insertSlSectionBlock(html, anchorName, routing!.position as 'before' | 'after', wrappedBlock);
              if (spliced) {
                finalHtml = spliced;
                scopedApplied = true;
                const newFields = extractDataFieldsFromHtml(inserted.html);
                if (Object.keys(newFields).length > 0) {
                  const schemaCopy = (schema && typeof schema === 'object'
                    ? JSON.parse(JSON.stringify(schema))
                    : {}) as Record<string, unknown>;
                  schemaCopy[inserted.name] = newFields;
                  finalSchemaJson = schemaCopy;
                }
              } else {
                console.error(`[pages/follow-up] insert_section could not splice new section near anchor "${anchorName}" — this is our own bug, not falling back to full-page`);
                scopedFailureReason = 'insert_section_splice_failed';
              }
            } else {
              console.error('[pages/follow-up] insert_section generation failed — this is our own bug, not falling back to full-page');
              scopedFailureReason = 'insert_section_generation_failed';
            }
          } else if (imageGenerateShapeOk) {
            const pageSlugForImage = page.slug ?? crypto.randomUUID();
            sendSSE(controller, { type: 'status', message: 'Generating image...' });
            const generatedUrl = await generateAndUploadImage(routing!.image_prompt!, pageSlugForImage, 'medium');
            if (generatedUrl) {
              sendSSE(controller, { type: 'image_ready', url: generatedUrl });
              targetSections = routing!.target_sections;
              generatedImageUrl = generatedUrl;
            } else {
              console.error('[pages/follow-up] image_generate routing qualified but image generation failed — this is our own bug, not falling back to full-page', { routing });
              scopedFailureReason = 'image_generate_failed';
            }
          } else {
            console.log('[pages/follow-up] routing did not qualify for scoped patch, falling back to full-page path', {
              routing,
              knownSectionNames: slSections.map((s) => s.name),
            });
          }
        }

        if (!scopedApplied && targetSections && targetSections.length > 0) {
          if (request.signal.aborted) { closeSSE(controller); return; }
          sendSSE(controller, { type: 'status', message: 'Applying patch...' });

          const scopedPrompt = generatedImageUrl
            ? `${prompt}\n\n(A brand-new image has just been generated to satisfy this request — it is attached below, and it is the FINAL, intended replacement. Regardless of how the instruction above orders the words "replace/with/current/new" — real users often phrase this ambiguously (e.g. "create a new X and replace with the current one" is meant as "replace the current X with this new one", NOT "keep the current one" or "revert") — you must make this section visibly display the attached image in place of whatever currently represents it. If the current logo/element is an <img> tag, swap its src to the attached image URL. If it is instead built from inline <svg>/icon markup (common for hand-drawn logo icons), you MUST delete that entire inline SVG/icon markup and replace it with a single <img src="ATTACHED_IMAGE_URL" alt="logo" style="height:<match the icon's original rendered height>; width:auto;"> in its place — do not leave the old SVG/icon untouched alongside or instead of the new image. Do not leave the section unchanged and do not generate or invent a different image URL.)`
            : prompt;
          const scopedImageUrls = generatedImageUrl ? [...effectiveImageUrls, generatedImageUrl] : effectiveImageUrls;

          const patchedSections: Array<{ name: string; html: string }> = [];
          let allOk = true;
          for (const name of targetSections) {
            const section = slSections.find((s) => s.name === name);
            if (!section) {
              console.error(`[pages/follow-up] target section "${name}" vanished before scoped patch — this is our own bug, not falling back to full-page`);
              scopedFailureReason = 'scoped_patch_target_section_missing';
              allOk = false;
              break;
            }
            const schemaSlice = { [name]: (schema as Record<string, unknown> | null | undefined)?.[name] };
            const patchResult = await runScopedPatchWithRetry(section.html, schemaSlice, scopedPrompt, scopedImageUrls);
            const updated = patchResult.html;
            if (!updated) {
              console.error(`[pages/follow-up] scoped patch failed for section "${name}" after retry`, {
                failedSanity: patchResult.failedSanity,
                failedParse: patchResult.failedParse,
                promptPreview: prompt.slice(0, 300),
                originalOuterTag: outerTag(section.html),
              });
              scopedFailureReason = patchResult.failedSanity
                ? 'scoped_patch_sanity_check_failed'
                : 'scoped_patch_empty_result';
              allOk = false;
              break;
            }
            // For the image_generate path specifically: a "successful" patch
            // that doesn't actually contain the new image URL is a silent
            // no-op (the model left the section unchanged, or edited around
            // it without embedding it) — treat that as a failure rather than
            // shipping a response that looks done but visually didn't change.
            if (generatedImageUrl && !updated.includes(generatedImageUrl)) {
              console.error(`[pages/follow-up] image_generate patch for section "${name}" did not embed the generated image URL — this is our own bug, not falling back to full-page`, {
                generatedImageUrl,
                updatedPreview: updated.slice(0, 500),
              });
              scopedFailureReason = 'image_generate_patch_did_not_embed';
              allOk = false;
              break;
            }
            patchedSections.push({ name, html: updated });
          }

          if (allOk && patchedSections.length === targetSections.length) {
            finalHtml = applyPatch(html, patchedSections);
            scopedApplied = true;
            console.log('[pages/follow-up] scoped patch applied successfully', {
              promptPreview: prompt.slice(0, 300),
              sections: targetSections,
            });
          }
        }
      }

      // A scoped op was already qualified (routing/quote-match confidently
      // identified what to do) and OUR OWN code then failed to execute it —
      // stop here instead of silently retrying as an expensive/oversized
      // full-page rebuild that would misattribute the failure to vague
      // wording. See scopedFailureReason assignments above for the exact
      // failure site.
      if (!scopedApplied && scopedFailureReason) {
        console.error(`[pages/follow-up] scoped op qualified but failed (${scopedFailureReason}) — not falling back to full-page`, {
          scopedFailureReason,
          promptLength: prompt.length,
        });
        sendSSE(controller, {
          type: 'error',
          message:
            'We found the right section but couldn\'t apply the edit cleanly. Please try again — quoting the exact text you want changed usually helps.',
        });
        closeSSE(controller);
        return;
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
              {
                type: 'text' as const,
                text: 'User-attached image(s) — apply the "Attached images" rule from the system prompt to determine whether each is a bug reference screenshot or a content asset to embed. If embedding, you MUST use these EXACT URL strings verbatim in any src attribute — the image content below only shows you the pixels, not the URL:\n' +
                  effectiveImageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n'),
              },
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
              // Defensive strip: conversation_json rows written before this fix
              // (or any other future accidental restoration) may still carry real
              // base64 image bytes per turn — stripping again here is a no-op on
              // clean history and a safety net on old/dirty rows either way.
              ...history.map(({ role, content }) => ({ role, content: extractDataUris(content).html })),
              { role: 'user' as const, content: userContent },
            ],
            maxTokens: 128000,
            label: 'follow-up:pass1-classify',
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
        if (isPromptTooLongError(err)) {
          console.error('[pages/follow-up] pass1-classify exceeded model context limit', {
            promptLength: prompt.length,
            htmlLength: htmlForModel.length,
            historyEntries: history.length,
            hasCompetitorContext,
          });
          sendSSE(controller, {
            type: 'error',
            message: hasCompetitorContext
              ? "This page is too large to rebuild alongside a competitor reference in one pass. Try a more specific change, or split the request into smaller edits."
              : 'This page is too large for a full-page edit. Try a more specific change (name the section or quote the text to change), or split the request into smaller edits.',
          });
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
            callerLabel: 'follow-up:structural',
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
          if (isPromptTooLongError(err)) {
            console.error('[pages/follow-up] structural rebuild exceeded model context limit', {
              promptLength: prompt.length,
              htmlLength: htmlForModel.length,
              hasCompetitorContext,
            });
            sendSSE(controller, {
              type: 'error',
              message: hasCompetitorContext
                ? "This page is too large to rebuild alongside a competitor reference in one pass. Try a more specific change, or split the request into smaller edits."
                : 'This page is too large for a full-page edit. Try a more specific change (name the section or quote the text to change), or split the request into smaller edits.',
            });
          } else {
            console.error('[pages/follow-up] structural rebuild failed', err);
            sendSSE(controller, { type: 'error', message: 'AI provider returned invalid HTML' });
          }
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
      // personalization work for an edit that had no effect. Both sides are still
      // placeholder'd here, so the comparison is unaffected by the swap.
      const htmlUnchanged = finalHtml === html;
      // The single line that answers "did Done actually mean something changed" —
      // without this, a technically-successful AI call that didn't apply the
      // requested edit is indistinguishable in logs from one that did.
      console.log('[pages/follow-up] request resolved', {
        promptPreview: prompt.slice(0, 300),
        scopedApplied,
        resultType,
        htmlUnchanged,
      });

      if (htmlUnchanged) {
        sendSSE(controller, {
          type: 'error',
          message:
            'No changes were applied to the page. Try rephrasing your request, or quote the exact text you want changed.',
        });
        closeSSE(controller);
        return;
      }

      // Every AI call and string splice above only ever saw placeholders — swap
      // real image bytes back in now, exactly once, for everything that gets
      // persisted or sent back to the client from this point on.
      const finalHtmlReal = restoreDataUris(finalHtml, dataUriMap);
      const finalSchemaJsonReal = finalSchemaJson
        ? (restoreDataUrisInValue(finalSchemaJson, dataUriMap) as Record<string, unknown>)
        : undefined;

      // Variant pages write to draft_* columns and never touch the live storage
      // file a test is actually serving — only "Replace Current Variant" uploads
      // to the live path. Non-variant pages behave exactly as before.
      let htmlUrl: string = page.html_url ?? '';
      if (!isVariant) {
        const storagePath = fileNameFromUrl(page.html_url);
        htmlUrl = await uploadHtml(storagePath, finalHtmlReal);
      }

      // Save conversation
      const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
      if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
      const updatedConversation = [
        ...history,
        userEntry,
        // Store the placeholder (pre-restore) schema, not finalSchemaJsonReal —
        // conversation_json is only ever replayed back to the AI as text context (see the
        // history.map above and AIBuilderClient, which never renders this raw), so it never
        // needed real image bytes. Storing the restored version here is what let each turn's
        // real base64 images compound in the prompt on every subsequent follow-up.
        { role: 'assistant', content: JSON.stringify({ type: resultType, schema_json: finalSchemaJson ?? schema }) },
      ];

      const updatePayload: Record<string, unknown> = {
        conversation_json: updatedConversation,
        updated_at: new Date().toISOString(),
      };
      if (isVariant) {
        updatePayload.draft_html_content = finalHtmlReal;
      } else {
        updatePayload.html_url = htmlUrl;
        updatePayload.html_content = finalHtmlReal.length < 500_000 ? finalHtmlReal : null;
        // HTML was rewritten by the AI — old UTM selectors can't be trusted, so
        // clear mappings (and rules below), same as manual HTML edits do
        updatePayload.field_selectors_json = null;
      }
      // finalSchemaJson is only ever set when there's an updated schema to
      // persist — the full-page structural rebuild sets it every time, and
      // the new scoped insert/remove ops (which are NOT tagged resultType
      // 'structural', they stay 'patch') set it only when the section
      // actually had schema fields to add/drop. Checking finalSchemaJson
      // directly (rather than gating on resultType) covers both.
      if (finalSchemaJsonReal) {
        if (isVariant) {
          updatePayload.draft_schema_json = finalSchemaJsonReal;
        } else {
          updatePayload.schema_json = finalSchemaJsonReal;
        }
      }

      // Live selector/personalization invalidation only applies when live HTML
      // actually changed — variant drafts don't touch live HTML, so nothing to wipe
      // here; that happens instead when the draft is promoted via Replace.
      if (!isVariant) {
        await db.from('personalization_rules').delete().eq('page_id', params.id);
      }
      await db.from('pages').update(updatePayload).eq('id', params.id);

      const doneEvent: SSEEvent = {
        type: 'done',
        // For variant drafts this is the unchanged live URL — the client only
        // uses it as a cache-busting trigger to refetch /preview, which serves
        // the draft content directly.
        html_url: htmlUrl,
        ...(finalSchemaJsonReal ? { schema_json: finalSchemaJsonReal } : {}),
        ...(competitorUrls.length > 0 && !competitorContext ? { competitor_fetch_failed: true } : {}),
        elapsed_ms: Date.now() - startedAt,
      };
      sendSSE(controller, doneEvent);
      closeSSE(controller);
    } catch (err) {
      console.error('[pages/follow-up]', err);
      sendSSE(controller, { type: 'error', message: userFacingAIErrorMessage(err) });
      closeSSE(controller);
    }
  })();

  return response;
}

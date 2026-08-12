import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { jsonrepair } from 'jsonrepair';
import { askAI, askAIStream, isRateLimited, generatePageImages, generateAndUploadImage, AIResponseTruncatedError, isPromptTooLongError, userFacingAIErrorMessage, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan, resolveWorkspaceOwner } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { checkAiAllowance, type UsageContext } from '@/lib/ai-usage';
import { reportAiOverageUsage } from '@/lib/ai-overage-billing';
import { extractUrls, scrapeCompetitorUrl, fetchLogoAssets, fetchContentImageAssets } from '@/lib/ai-competitor-scrape';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { createSSEStream, sendSSE, closeSSE, SSE_HEADERS, type SSEEvent } from '@/lib/sse';
import { isTestVariantPage } from '@/lib/page-drafts';
import { extractDataUris, restoreDataUris, restoreDataUrisInValue } from '@/lib/data-uri-strip';
import {
  looksLikeMultiIntent,
  planMultiIntentEdit,
  userWantsUsToDecide,
  isScreenshotComplaint,
  isDesignReferenceAsk,
  inferDesignMatchSectionNames,
  verifyScopedPatchIntent,
  classifyAttachedImages,
  allowScopedDespiteCompetitorUrl,
  userWantsSiteContentImage,
  userWantsFullCompetitorRebuild,
  extractDesignReferenceCopy,
} from '@/lib/ai-follow-up-helpers';
import {
  injectBrandAssetsIntoSchema,
  forceEmbedLogoInHtml,
  forceEmbedLogoIntoSections,
  forceEmbedFooterContactInHtml,
  materializeLogoUrl,
  extractPrimaryLogoUrlFromHtml,
  extractInlineLogoSvg,
  sectionHasLogoAsset,
} from '@/lib/ai-brand-assets';
import {
  detectContentReuseIntent,
  extractPrimaryHeadlineFromHtml,
  forcePlaceTextIntoSections,
  resolveSourceSectionName,
  sectionHasText,
  inferTargetSectionNames,
} from '@/lib/ai-content-placement';
import { runNavLogoVisualQaOnce, runPostUploadNavLogoQa } from '@/lib/ai-visual-qa';
import { verifyAndRehostHtmlImages } from '@/lib/ai-asset-integrity';
import {
  findUnrequestedLosses,
  hasLosses,
  describeLosses,
  sectionsContainingAsset,
} from '@/lib/ai-page-preservation';
import {
  extractRequirements,
  enforceRequirements,
  checkRequirements,
  describeUnmet,
  parseModelRequirements,
  mergeRequirements,
  REQUIREMENT_EXTRACTION_INSTRUCTION,
  type PageRequirement,
} from '@/lib/ai-page-requirements';

export const dynamic = 'force-dynamic';
// Large full-page rewrites can run several minutes; raised well past the old
// 300s cutoff (capped by the hosting plan's real limit).
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
- If the instruction asks to keep/make/match a section "like this" / "match this" / "same as this" with a screenshot of the desired look → the image is a DESIGN REFERENCE. Recreate that section's layout, structure, and visible copy from the screenshot in real HTML/CSS. Never paste the screenshot as an <img src> of the whole section. Leaving the section unchanged is a failure.
- If both purposes appear in one instruction (e.g. "use photo A on hero and fix this alignment issue in photo B") → handle each image accordingly.
When in doubt, ask yourself: is the user pointing at a problem, handing you an asset to embed, or showing how something should look? Let the instruction answer that.

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
  // "in this section" is a destination, not a structural redesign ask.
  if (
    /\b(redesign|rebuild|restructure|layout|spacing|padding|margin|font-size|color|colour|background|image|logo|photo|add a |remove |delete |reorder|move .+ (above|below|before|after)|button style|css|stylesheet)\b/i.test(
      p,
    )
  ) {
    return false;
  }
  return (
    /\b(change|rewrite|rephrase|improve|update|better|alternative|nicer|polish|tighten|shorten|clarify|refine)\b/i.test(
      p,
    ) &&
    /\b(text|copy|headline|heading|title|subhead|sub-head|tagline|wording|this|it)\b/i.test(p)
  );
}

/**
 * True when the instruction explicitly asks for a visual/design change
 * (fonts, colors, "premium," "redesign," etc.) — as opposed to a purely
 * content/structure edit ("remove these sections," "make it shorter").
 * Used to keep structural content-only edits from being diverted onto the
 * expensive full-page rebuild path when the user never asked for a new
 * look — see tryStructuralDiffSplice(). Deliberately broad: a false
 * positive here only costs a slower (but correct, unchanged) full rebuild;
 * a false negative would silently skip a redesign the user actually asked
 * for, which is the worse failure mode.
 */
function promptRequestsRestyle(prompt: string): boolean {
  return /\b(premium|luxury|luxurious|modern|sleek|elegant|minimal(?:ist)?|bold|playful|funky|polished|refined|classy|upscale|redesign|restyle|re-?style|rebrand|re-?brand|revamp|refresh(?:ed)?|overhaul|look and feel|visual style|aesthetic|vibe|mood|color scheme|colour scheme|palette|typography|font|fonts|theme)\b/i.test(
    prompt,
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
{"type":"patch"|"style"|"structural"|"image_generate"|"insert_section"|"remove_section"|"reorder_sections","target_sections":["section-name", ...],"confidence":"high"|"low","clarifying_question":"...","image_prompt":"...","anchor_section":"...","position":"before"|"after","new_order":["section-name", ...],"requirements":[...]}

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
- Set confidence "low" when the referenced element/text/section could plausibly belong to two or more different sections, or doesn't appear in any preview at all — including truly ambiguous image references ("use this image" when multiple sections have images) or vague whole-page requests ("make it feel more premium"). When confidence is "low", still fill in your best guess for type/target_sections, AND you MUST also return "clarifying_question": a short plain-English question for the user that names the plausible section options using EXACT section names from the list (e.g. "Did you mean the form in cta-form, or the FAQ in faq?"). The product will ask the user instead of guessing.
- **Never set confidence "low" / clarifying_question when:** (1) the user says "you decide", "feel free", "just do it", "up to you", or similar — pick the best section and use confidence "high"; (2) they attached a screenshot and are complaining that something looks wrong/sloppy/broken/fake — LOOK at the screenshot, decide the fix, confidence "high" on the section that matches the problem (often nav/logo). Do NOT ask "did you mean the logo?" when the rant + screenshot already make that obvious; (3) they attached a screenshot and ask to keep/make/match a named part "like this" (e.g. "keep the footer like this") — that is a design-reference match: confidence "high" on the named section (footer → footer, nav → nav), never clarify.
- **Attached screenshots (vision):** When image(s) are included with the instruction, LOOK at them. Screenshots of a lead form / dropdown questions / "investment range" style fields almost always mean a form section (names like cta-form, form, popup, contact — whatever matches the list), NOT faq. FAQ is for Q&A accordion copy. Prefer the section whose preview/schema looks like a form when the screenshot shows form fields. Screenshots of a visual defect (logo box, broken line, bad spacing) are diagnostic — route to the broken section and fix it; do not clarify. Screenshots of a desired footer/nav/hero look with "like this" / "match this" language are design references — route to that section for a patch that recreates the look.
- Only ever use section names EXACTLY as given in the list — never invent one.

${REQUIREMENT_EXTRACTION_INSTRUCTION}`;

interface RoutingResult {
  type: string;
  target_sections: string[];
  confidence: string;
  clarifying_question?: string;
  image_prompt?: string;
  anchor_section?: string;
  position?: string;
  new_order?: string[];
  /** Model-written checklist; validated by parseModelRequirements before use. */
  requirements?: unknown;
}

function buildDefaultClarifyQuestion(routing: RoutingResult, sections: SlSection[]): string {
  const validGuess = (routing.target_sections ?? []).filter((n) =>
    sections.some((s) => s.name === n),
  );
  const allNames = sections.map((s) => s.name);
  if (validGuess.length > 0) {
    const alternatives = allNames.filter((n) => !validGuess.includes(n)).slice(0, 4);
    const guessLabel = validGuess.map((n) => `"${n}"`).join(' or ');
    const altNote = alternatives.length > 0 ? ` Or did you mean ${alternatives.map((n) => `"${n}"`).join(', ')}?` : '';
    return `I want to make sure I edit the right place. Did you mean the ${guessLabel} section?${altNote} Reply with the section name or describe which part of the page (e.g. the form, the FAQ, the hero).`;
  }
  const listed = allNames.slice(0, 12).map((n) => `"${n}"`).join(', ');
  return `I'm not sure which part of the page to edit. Which section should I change? Available: ${listed}.`;
}

/**
 * Production miss: screenshots of a lead form + "rewrite the questions" still
 * routed to faq with confidence high (routing used to be text-only). Even with
 * vision, force a clarifying question when form-like language + images point at
 * FAQ while a form/cta section exists on the page.
 */
function shouldForceClarifyFaqVsForm(
  prompt: string,
  routing: RoutingResult,
  hasUserImages: boolean,
  sections: SlSection[],
): boolean {
  if (!hasUserImages) return false;
  if (!/\b(question|questions|answer|answers|form|dropdown|select|investment range)\b/i.test(prompt)) {
    return false;
  }
  const targets = routing.target_sections ?? [];
  if (targets.length !== 1) return false;
  if (!/^faq/i.test(targets[0])) return false;
  return sections.some((s) => /cta|form|popup|contact|lead/i.test(s.name));
}

async function tryRoutingCall(
  prompt: string,
  schema: unknown,
  sections: SlSection[],
  imageUrls: string[],
  usage?: UsageContext,
): Promise<RoutingResult | null> {
  try {
    const sectionList = sections.map((s) => `- ${s.name}: "${s.text.slice(0, 150)}"`).join('\n');
    const textPart =
      `Schema:\n${JSON.stringify(schema)}\n\nSections:\n${sectionList}\n\nInstruction: ${prompt}` +
      (imageUrls.length > 0
        ? '\n\nUser attached image(s) above — use them to identify which part of the page they mean (form vs FAQ vs hero, etc.).'
        : '');
    const userContent: AIContent =
      imageUrls.length > 0
        ? [
            ...imageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
            { type: 'text', text: textPart },
          ]
        : textPart;

    const text = await askAI({
      system: ROUTING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
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
      usage: usage ? { ...usage, operation: 'route' } : undefined,
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
  usage?: UsageContext,
): Promise<string | null> {
  try {
    // The image content blocks below only give the model PIXELS — the
    // literal URL string is never otherwise visible to it, so without this
    // it has no way to know what to actually write into an <img src="...">.
    // Design-reference asks must NOT get a blanket "put these URLs in src"
    // note — that causes the model to paste the screenshot as an <img>.
    const isDesignMatchPrompt =
      /DESIGN REFERENCE/i.test(prompt) || isDesignReferenceAsk(prompt);
    const imageUrlsNote = (imageUrls ?? []).length > 0
      ? isDesignMatchPrompt
        ? `\n\nAttached image(s) are for VISION only (design/bug reference). Do NOT put these URL(s) into src attributes unless the instruction explicitly lists them as content-asset embed URLs:\n${(imageUrls ?? []).map((u, i) => `${i + 1}. ${u}`).join('\n')}`
        : `\n\nAttached image URL(s) — use these EXACT strings verbatim in any src attribute, in the order attached:\n${(imageUrls ?? []).map((u, i) => `${i + 1}. ${u}`).join('\n')}`
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
      usage: usage ? { ...usage, operation: 'edit' } : undefined,
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
  usage?: UsageContext,
): Promise<{ html: string | null; failedSanity: boolean; failedParse: boolean }> {
  const requiredTag = outerTag(sectionHtml);

  const first = await runScopedPatch(sectionHtml, schemaSlice, prompt, imageUrls, undefined, usage);
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

  const second = await runScopedPatch(sectionHtml, schemaSlice, prompt, imageUrls, correction, usage);
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

// ── Structural diff+splice — content-only structural edits without a full rebuild ──
//
// The full-page pass1 classify call already decides the CORRECT new schema
// for a "structural" edit (which sections to remove, how remaining sections'
// copy should change) — that decision-making is not the problem. The
// problem is what happens next: today, ANY structural result gets handed to
// buildHtmlFromSchema(), which regenerates the ENTIRE document — a brand new
// <style> block, fonts, and markup for every section, including ones the
// instruction never asked to touch. For a pure content-trim request ("remove
// these sections, shorten the rest"), that's a correctness bug: the page's
// visual design drifts and untouched sections' copy gets subtly reworded,
// neither of which the user asked for.
//
// This diffs the AI's already-decided old-schema vs new-schema and applies
// ONLY the actual delta directly against the existing HTML, reusing the same
// mechanisms already proven safe elsewhere in this file: removeSlSection()
// for removed sections (pure string splice, no AI call) and
// runScopedPatchWithRetry() for changed sections (same call ordinary `patch`
// edits use, with its outer-tag/minimum-edit guardrails). Sections that
// aren't in either list are never sent to the model, so they can't drift.
//
// All-or-nothing: any failure at any step returns null and the caller falls
// straight back to today's unchanged full buildHtmlFromSchema() path — this
// can only ever match or improve on today's behavior, never regress it.

// generatePageImages() writes generated_image_url onto any schema node that
// had an image_prompt (see ai-client.ts) — including on a CHANGED (not just
// added) section, per this file's own SYSTEM_PROMPT rule allowing
// image_prompts on sections being "structurally changing". The scoped-patch
// call only reliably embeds an image URL it's told about explicitly via its
// imageUrls param (same as the image_generate op does) — a URL sitting
// unlabeled inside the schema-slice JSON isn't a strong enough signal.
function collectGeneratedImageUrls(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return (node as unknown[]).flatMap(collectGeneratedImageUrls);
  const obj = node as Record<string, unknown>;
  const urls: string[] = [];
  if (typeof obj.generated_image_url === 'string' && obj.generated_image_url) urls.push(obj.generated_image_url);
  for (const val of Object.values(obj)) urls.push(...collectGeneratedImageUrls(val));
  return urls;
}

async function tryStructuralDiffSplice(
  originalHtml: string,
  oldSchema: unknown,
  newSchema: Record<string, unknown>,
  slSections: SlSection[],
  prompt: string,
  imageUrls: string[],
  usage?: UsageContext,
): Promise<string | null> {
  if (!oldSchema || typeof oldSchema !== 'object') return null;
  if (promptRequestsRestyle(prompt)) return null;

  const oldObj = oldSchema as Record<string, unknown>;
  const oldKeys = Object.keys(oldObj);
  const newKeys = Object.keys(newSchema);

  const removedKeys = oldKeys.filter((k) => !newKeys.includes(k));
  const addedKeys = newKeys.filter((k) => !oldKeys.includes(k));
  const changedKeys = newKeys.filter(
    (k) => oldKeys.includes(k) && JSON.stringify(oldObj[k]) !== JSON.stringify(newSchema[k]),
  );

  // New sections need real generation (design, layout, images) — not a
  // content diff. Let those keep using the full rebuild path.
  if (addedKeys.length > 0) return null;
  // Nothing to apply via this path (shouldn't normally happen for a
  // genuine structural result, but don't silently no-op if it does).
  if (removedKeys.length === 0 && changedKeys.length === 0) return null;
  // Sanity ceiling, not a real constraint for normal pages — a genuine
  // "trim the whole page" request (the motivating case for this function)
  // can legitimately shorten most of a page's sections at once; each one is
  // still an independently-scoped, safe patch. This only guards against a
  // pathological page with an unreasonable number of sections.
  if (changedKeys.length > 20) return null;
  if (!removedKeys.every((k) => slSections.some((s) => s.name === k))) return null;
  if (!changedKeys.every((k) => slSections.some((s) => s.name === k))) return null;

  let current = originalHtml;
  for (const key of removedKeys) {
    const removed = removeSlSection(current, key);
    if (!removed) {
      console.error(`[pages/follow-up] structural diff+splice: could not find marker for removed section "${key}", falling back to full rebuild`);
      return null;
    }
    current = removed;
  }

  const patchedSections: Array<{ name: string; html: string }> = [];
  for (const key of changedKeys) {
    const section = slSections.find((s) => s.name === key)!;
    const schemaSlice = { [key]: newSchema[key] };
    const generatedUrlsForSection = collectGeneratedImageUrls(newSchema[key]);
    const patchImageUrls = generatedUrlsForSection.length > 0
      ? [...imageUrls, ...generatedUrlsForSection]
      : imageUrls;
    const result = await runScopedPatchWithRetry(section.html, schemaSlice, prompt, patchImageUrls, usage);
    if (!result.html) {
      console.error(`[pages/follow-up] structural diff+splice: scoped patch failed for changed section "${key}", falling back to full rebuild`, {
        failedSanity: result.failedSanity,
        failedParse: result.failedParse,
      });
      return null;
    }
    patchedSections.push({ name: key, html: result.html });
  }

  const spliced = patchedSections.length > 0 ? applyPatch(current, patchedSections) : current;
  console.log('[pages/follow-up] structural edit applied via diff+splice (style preserved)', {
    promptPreview: prompt.slice(0, 300),
    removedKeys,
    changedKeys,
  });
  return spliced;
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

  // AI usage on this edit is metered against the account owner (credits/overage).
  const { ownerId: aiOwnerId, plan: aiOwnerPlan } = await resolveWorkspaceOwner(page.workspace_id);
  const usageCtx: UsageContext = {
    ownerId: aiOwnerId,
    workspaceId: page.workspace_id,
    pageId: params.id,
    operation: 'edit',
  };

  // Soft-cap gate (admins bypass). Runs before the SSE stream opens, so a
  // blocked request returns clean JSON the editor can turn into an upsell.
  // TEMP TEST (renny): also enforce for this one admin id so the cap can be
  // verified end-to-end on staging. REVERT to `session.user.role !== 'admin'`.
  if (session.user.role !== 'admin' || session.user.id === 'ec6fdf83-10b1-458e-a7c4-a8708c19a74f') {
    const gate = await checkAiAllowance(aiOwnerId, aiOwnerPlan);
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: gate.reason === 'over_cap'
            ? 'You\'ve reached your AI overage spend cap. Raise it in Billing to continue.'
            : 'You\'re out of AI credits for this month. Enable overage in Billing to continue.',
          softCap: true,
          reason: gate.reason,
          usage: gate.summary,
          overage: gate.overage,
        },
        { status: 402 },
      );
    }
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
  // once at the very end (see `finalHtmlPersisted`/`finalSchemaJsonReal` below) —
  // every intermediate operation (splicing, matching, prompting) works
  // identically on placeholders since none of it inspects image byte content.
  const DATA_URI_SPLIT = ' __SL_HTML_SCHEMA_BOUNDARY__ ';
  const combinedForStrip = html + DATA_URI_SPLIT + JSON.stringify(schema ?? null);
  const { html: combinedStripped, map: dataUriMap } = extractDataUris(combinedForStrip);
  const [htmlNoDataUris, schemaStrNoDataUris] = combinedStripped.split(DATA_URI_SPLIT);
  html = htmlNoDataUris;
  schema = JSON.parse(schemaStrNoDataUris);

  // Snapshot of the page as it stood before this edit, used at the end to catch
  // content the edit destroyed without being asked to (a nav-color request has
  // no business deleting the logo).
  const originalHtmlForPreservation = html;
  const preEditLogoUrl = extractPrimaryLogoUrlFromHtml(html);

  // Prepare synchronous data
  const history: { role: 'user' | 'assistant'; content: string; image_urls?: string[]; clarify?: boolean }[] =
    Array.isArray(page.conversation_json) ? page.conversation_json : [];
  // If our own last turn was a clarifying question, this message is the
  // user's ANSWER to it — never ask another clarifying question back to
  // back. Whatever they say next (even "you decide" / "that's what I want
  // you to analyze") is authoritative: proceed with the routing's own best
  // guess, or fall through to the full-page path, which has this entire
  // exchange in its conversation history to reason from.
  const lastAssistantWasClarify =
    history.length > 0 &&
    history[history.length - 1]?.role === 'assistant' &&
    history[history.length - 1]?.clarify === true;
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

  // "Use the real/actual logo [from this URL]" — narrow intent, deliberately
  // requiring the word "logo" paired with real/actual/exact/same/correct so
  // it doesn't misfire on an ordinary "make it look like <url>, and shrink
  // the logo" competitor-rebuild request. Handled below as a scoped asset
  // swap instead of the usual full-page competitor rebuild, which has no way
  // to obtain the real logo file — it only ever sees a lossy screenshot or
  // generates a brand-new (fake) one, which was the actual client complaint
  // this exists to fix.
  // "Use the logo from this URL" / "real logo" / soft "use the logo" — not only
  // the narrow real|actual phrasing. Still requires a non-image URL in the prompt.
  const isLogoSwapAttempt = competitorUrls.length > 0 && (
    /\b(real|actual|exact|same|correct)\s+logo\b/i.test(prompt) ||
    /\b(use|keep|with|from)\b[\s\S]{0,40}\blogo\b/i.test(prompt) ||
    /\blogo\b[\s\S]{0,40}\b(from|on)\b/i.test(prompt)
  );
  // Local edit that happens to include a URL → keep scoped path (avoid huge rebuild).
  // Redesign/clone language still forces full competitor rebuild.
  const isScopedDespiteUrl =
    competitorUrls.length > 0 && !isLogoSwapAttempt && allowScopedDespiteCompetitorUrl(prompt);
  const isContentImageSwapAttempt =
    competitorUrls.length > 0 && userWantsSiteContentImage(prompt) && !isLogoSwapAttempt;

  // Scoped-patch candidates — cheap, synchronous, no AI call. A genuine
  // competitor redesign URL always means full-page rebuild (see
  // follow-up-input-scoping.md), so scoping is never attempted when one is
  // mentioned — except logo/content-image swaps and incidental-URL local edits.
  const allowScopedWithCompetitorUrl =
    isLogoSwapAttempt || isScopedDespiteUrl || isContentImageSwapAttempt;
  let slSections =
    competitorUrls.length === 0 || allowScopedWithCompetitorUrl ? extractSlSections(html) : [];
  const quoteMatchSection =
    competitorUrls.length === 0 || allowScopedWithCompetitorUrl
      ? tryDirectQuoteMatch(prompt, slSections)
      : null;

  // The router already reads the instruction, the screenshots and every
  // section, so it writes the verification checklist in the same call — the
  // model interprets the ask, deterministic code still does the checking.
  // Regex extraction stays as the floor, so a skipped or malformed routing
  // call can only mean fewer model-written checks, never fewer guarantees.
  let modelRequirements: PageRequirement[] = [];
  const captureModelRequirements = (routing: RoutingResult | null) => {
    if (!routing?.requirements) return;
    const parsed = parseModelRequirements(routing, {
      knownSections: slSections.map((s) => s.name),
    });
    if (parsed.length > 0) modelRequirements = parsed;
  };

  // ── Open SSE stream — no NextResponse.json after this point ───────────────

  const { stream, controller } = createSSEStream();
  const response = new Response(stream, { headers: SSE_HEADERS });

  void (async () => {
    try {
      let finalHtml = '';
      let finalSchemaJson: unknown | undefined;
      let scopedApplied = false;
      let partialMessage: string | null = null;
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
      // Per-image roles (bug screenshot vs content asset vs design reference).
      // Default = treat all as both vision + embed candidates; classification may narrow embed list.
      let routingImageUrls = effectiveImageUrls;
      let embedImageUrls = effectiveImageUrls;
      let designReferenceUrls: string[] = [];
      let designCopyLines: string[] = [];
      let imageRolesClassified = false;
      /** Set when a logo-swap applied a real hosted URL — used by visual QA. */
      let logoSwapAppliedUrl: string | null = null;

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

        // ── Real-logo swap ────────────────────────────────────────────────
        // See isLogoSwapAttempt comment above for the intent match. This must
        // run before anything else in this block (and short-circuit on its
        // own failure via scopedFailureReason) — otherwise a failed fetch
        // would fall through to the generic routing call below, which has no
        // idea a real logo was supposed to be used and could silently head
        // down the image_generate path, reproducing the exact fake-logo bug
        // this exists to fix.
        if (!scopedApplied && !targetSections && isLogoSwapAttempt) {
          if (request.signal.aborted) { closeSSE(controller); return; }
          sendSSE(controller, { type: 'status', message: 'Fetching logo...' });
          const assets = await fetchLogoAssets(competitorUrls[0]);
          const pageSlugForLogo = page.slug ?? crypto.randomUUID();
          let realLogoUrl = await materializeLogoUrl({
            pageSlug: pageSlugForLogo,
            logoUrl: assets.logoUrl && (await isImageUrl(assets.logoUrl)) ? assets.logoUrl : null,
            logoSvg: assets.logoSvgMarkup,
          });
          // If materialize only had SVG and upload failed, still allow inline SVG embed via force path
          const inlineSvgFallback = !realLogoUrl ? assets.logoSvgMarkup : null;

          if (!realLogoUrl && !inlineSvgFallback) {
            console.error('[pages/follow-up] real logo swap: could not find/verify a logo on the referenced page', {
              url: competitorUrls[0],
            });
            sendSSE(controller, {
              type: 'error',
              message: "We couldn't find a usable logo image on that page. Try attaching the logo file directly instead.",
            });
            closeSSE(controller);
            return;
          }

          const navSection = slSections.find((s) => s.name === 'nav') ?? slSections.find((s) => /nav|header/i.test(s.name));
          let logoTargetName: string | null = navSection?.name ?? null;
          if (!logoTargetName) {
            const routing = await tryRoutingCall(prompt, schema, slSections, [], usageCtx);
            captureModelRequirements(routing);
            if (
              routing &&
              routing.target_sections.length === 1 &&
              slSections.some((s) => s.name === routing.target_sections[0])
            ) {
              logoTargetName = routing.target_sections[0];
            }
          }

          if (!logoTargetName) {
            console.error('[pages/follow-up] real logo swap: could not identify a target section', {
              knownSectionNames: slSections.map((s) => s.name),
            });
            scopedFailureReason = 'logo_swap_no_target_section';
          } else if (realLogoUrl) {
            const logoSection = slSections.find((s) => s.name === logoTargetName)!;
            const logoPrompt =
              `${prompt}\n\n(The real logo image has just been fetched directly from the referenced site — it is attached below and is the FINAL, intended logo. Replace whatever currently represents the logo (an <img> tag, or inline <svg>/icon markup) with a single <img src="${realLogoUrl}" alt="logo" style="height:<match the current logo's rendered height>; width:auto;"> in its place. Do not invent or generate a different image. Do not leave the old logo markup in place alongside the new one. Do not add any background color/box behind the image — it must sit directly on the section's existing background so it blends in.)`;
            sendSSE(controller, { type: 'status', message: 'Applying real logo...' });
            const patchResult = await runScopedPatchWithRetry(
              logoSection.html,
              { [logoTargetName]: (schema as Record<string, unknown> | null | undefined)?.[logoTargetName] },
              logoPrompt,
              [realLogoUrl],
              usageCtx,
            );
            if (patchResult.html && patchResult.html.includes(realLogoUrl)) {
              finalHtml = applyPatch(html, [{ name: logoTargetName, html: patchResult.html }]);
              scopedApplied = true;
              logoSwapAppliedUrl = realLogoUrl;
              console.log('[pages/follow-up] real logo swap applied', { section: logoTargetName, realLogoUrl });
            } else {
              // Deterministic fallback
              const forced = forceEmbedLogoInHtml(
                applyPatch(html, [{ name: logoTargetName, html: patchResult.html ?? logoSection.html }]),
                realLogoUrl,
                null,
              );
              if (forced.includes(realLogoUrl)) {
                finalHtml = forced;
                scopedApplied = true;
                logoSwapAppliedUrl = realLogoUrl;
              } else {
                console.error('[pages/follow-up] real logo swap: scoped patch failed to embed the fetched logo', {
                  section: logoTargetName,
                  failedSanity: patchResult.failedSanity,
                  failedParse: patchResult.failedParse,
                });
                scopedFailureReason = 'logo_swap_patch_failed';
              }
            }
          } else if (inlineSvgFallback) {
            finalHtml = forceEmbedLogoInHtml(html, null, inlineSvgFallback);
            scopedApplied = finalHtml !== html;
            if (!scopedApplied) scopedFailureReason = 'logo_swap_svg_embed_failed';
            else console.log('[pages/follow-up] real logo SVG embedded inline', { section: logoTargetName });
          }

          // If they also asked to place the logo in other sections (footer,
          // hero, …), deterministically put the SAME asset there — never invent.
          if (scopedApplied) {
            const place = detectContentReuseIntent(
              prompt,
              slSections.map((s) => s.name),
            );
            if (place?.kind === 'logo') {
              const url = logoSwapAppliedUrl ?? realLogoUrl;
              const svg = url ? null : inlineSvgFallback;
              const targets = (place.targets.length > 0
                ? place.targets
                : inferTargetSectionNames(prompt, slSections.map((s) => s.name))
              ).filter((n) => n !== logoTargetName);
              if (targets.length > 0) {
                finalHtml = forceEmbedLogoIntoSections(finalHtml, targets, url, svg);
                const missing = targets.filter((n) => !sectionHasLogoAsset(finalHtml, n, url, svg));
                if (missing.length > 0) {
                  console.error('[pages/follow-up] logo swap: placement embed failed', { missing });
                  scopedFailureReason = 'logo_swap_placement_embed_failed';
                  scopedApplied = false;
                } else {
                  console.log('[pages/follow-up] real logo also embedded in sections', {
                    targets,
                    url: url?.slice(0, 120),
                  });
                }
              }
            }
          }
        }

        // ── Reuse existing page content into named section(s) ─────────────
        // Logo, text, or image — one path. Never invent assets; fail closed.
        if (!scopedApplied && !scopedFailureReason) {
          const reuse = detectContentReuseIntent(
            prompt,
            slSections.map((s) => s.name),
          );
          if (reuse) {
            if (request.signal.aborted) { closeSSE(controller); return; }

            let targets = reuse.targets;
            if (targets.length === 0) {
              const routing = await tryRoutingCall(prompt, schema, slSections, [], usageCtx);
              captureModelRequirements(routing);
              if (
                routing &&
                routing.target_sections.length >= 1 &&
                routing.target_sections.every((n) => slSections.some((s) => s.name === n))
              ) {
                targets = routing.target_sections.slice(0, 3);
              }
            }

            if (targets.length === 0) {
              console.error('[pages/follow-up] content reuse: no target section', { kind: reuse.kind });
              scopedFailureReason = 'content_reuse_no_target';
            } else if (reuse.kind === 'logo') {
              let existingLogoUrl = extractPrimaryLogoUrlFromHtml(html);
              let existingSvg = !existingLogoUrl ? extractInlineLogoSvg(html) : null;
              // Prefer page logo; else a user-attached image URL (still a real asset).
              if (!existingLogoUrl && effectiveImageUrls.length > 0) {
                existingLogoUrl = effectiveImageUrls[0];
              }
              if (!existingLogoUrl && !existingSvg && competitorUrls.length > 0) {
                sendSSE(controller, { type: 'status', message: 'Fetching logo...' });
                const assets = await fetchLogoAssets(competitorUrls[0]);
                const pageSlugForLogo = page.slug ?? crypto.randomUUID();
                existingLogoUrl = await materializeLogoUrl({
                  pageSlug: pageSlugForLogo,
                  logoUrl: assets.logoUrl && (await isImageUrl(assets.logoUrl)) ? assets.logoUrl : null,
                  logoSvg: assets.logoSvgMarkup,
                });
                if (!existingLogoUrl) existingSvg = assets.logoSvgMarkup;
              }
              if (!existingLogoUrl && !existingSvg) {
                // Don't toast an error for a simple "logo in footer" — fall through
                // so routing/AI can still try; forceEmbed may catch after.
                console.warn('[pages/follow-up] content reuse: no logo asset yet — falling through');
              } else {
              sendSSE(controller, {
                type: 'status',
                message: `Placing logo in ${targets.join(', ')}...`,
              });
              let next = forceEmbedLogoIntoSections(html, targets, existingLogoUrl, existingSvg);
              let missing = targets.filter(
                (n) => !sectionHasLogoAsset(next, n, existingLogoUrl, existingSvg),
              );
              if (missing.length > 0 && existingLogoUrl) {
                const patched: Array<{ name: string; html: string }> = [];
                for (const name of missing) {
                  const section = slSections.find((s) => s.name === name);
                  if (!section) continue;
                  const logoPrompt =
                    `${prompt}\n\n(Use this EXACT logo URL in "${name}" — already on the page. <img src="${existingLogoUrl}" alt="logo">. Do NOT invent a URL.)`;
                  const patchResult = await runScopedPatchWithRetry(
                    section.html,
                    { [name]: (schema as Record<string, unknown> | null | undefined)?.[name] },
                    logoPrompt,
                    [existingLogoUrl],
                    usageCtx,
                  );
                  if (patchResult.html) patched.push({ name, html: patchResult.html });
                }
                if (patched.length > 0) next = applyPatch(html, patched);
                next = forceEmbedLogoIntoSections(next, targets, existingLogoUrl, null);
                missing = targets.filter((n) => !sectionHasLogoAsset(next, n, existingLogoUrl, null));
              }
              if (missing.length === 0) {
                finalHtml = next;
                scopedApplied = true;
                logoSwapAppliedUrl = existingLogoUrl;
                console.log('[pages/follow-up] content reuse: logo placed', { targets });
              } else {
                // Still force what we can; prefer partial success over user-facing error.
                finalHtml = next;
                scopedApplied = next !== html;
                logoSwapAppliedUrl = existingLogoUrl;
                console.warn('[pages/follow-up] content reuse: logo partial', { missing, targets });
              }
              }
            } else if (reuse.kind === 'text') {
              let text = reuse.textPayload;
              if (!text && reuse.sourceSectionHint) {
                const srcName = resolveSourceSectionName(
                  reuse.sourceSectionHint,
                  slSections.map((s) => s.name),
                );
                const src = srcName ? slSections.find((s) => s.name === srcName) : null;
                text = src ? extractPrimaryHeadlineFromHtml(src.html) : null;
              }
              if (!text) {
                sendSSE(controller, {
                  type: 'error',
                  message:
                    'Quote the exact text to place, or say which section to copy from (e.g. "copy the hero headline to the footer").',
                });
                closeSSE(controller);
                return;
              }
              sendSSE(controller, {
                type: 'status',
                message: `Placing text in ${targets.join(', ')}...`,
              });
              const next = forcePlaceTextIntoSections(html, targets, text);
              const missing = targets.filter((n) => !sectionHasText(next, n, text!));
              if (missing.length === 0) {
                finalHtml = next;
                scopedApplied = true;
                console.log('[pages/follow-up] content reuse: text placed', {
                  targets,
                  textPreview: text.slice(0, 80),
                });
              } else {
                scopedFailureReason = 'content_reuse_text_failed';
              }
            } else if (reuse.kind === 'image') {
              const existingImg = extractPrimaryLogoUrlFromHtml(html);
              if (!existingImg && effectiveImageUrls.length === 0) {
                sendSSE(controller, {
                  type: 'error',
                  message:
                    'Attach the image to place, or make sure a working image is already on the page.',
                });
                closeSSE(controller);
                return;
              }
              const imgUrl = effectiveImageUrls[0] ?? existingImg!;
              sendSSE(controller, {
                type: 'status',
                message: `Placing image in ${targets.join(', ')}...`,
              });
              const next = forceEmbedLogoIntoSections(html, targets, imgUrl, null);
              const missing = targets.filter((n) => !sectionHasLogoAsset(next, n, imgUrl, null));
              if (missing.length === 0) {
                finalHtml = next;
                scopedApplied = true;
                console.log('[pages/follow-up] content reuse: image placed', { targets });
              } else {
                scopedFailureReason = 'content_reuse_image_failed';
              }
            }
          }
        }

        // Once-only nav/logo visual QA after a successful logo swap when the
        // user attached reference/bug screenshots. Fail-closed — never undoes
        // a good swap; never blocks Done.
        if (scopedApplied && isLogoSwapAttempt && hasUserImages) {
          sendSSE(controller, { type: 'status', message: 'Checking full page look…' });
          const qa = await runNavLogoVisualQaOnce({
            html: finalHtml,
            prompt,
            expectedLogoUrl: logoSwapAppliedUrl,
            imageUrls: effectiveImageUrls,
            logoIntent: true,
            usage: usageCtx,
            label: 'follow-up:visual-qa',
          });
          if (qa.appliedFix) {
            finalHtml = qa.html;
            console.log('[pages/follow-up] visual-qa applied above-fold fix', { issues: qa.issues });
          } else if (qa.ran) {
            console.log('[pages/follow-up] visual-qa ok / no fix', { issues: qa.issues });
          }
        }

        // "Use their headshot / product photo from this URL" — fail-closed fetch,
        // scoped embed (same family as logo swap; never invent a photo).
        if (!scopedApplied && !scopedFailureReason && isContentImageSwapAttempt) {
          if (request.signal.aborted) { closeSSE(controller); return; }
          sendSSE(controller, { type: 'status', message: 'Fetching photo from site...' });
          const photos = await fetchContentImageAssets(competitorUrls[0]);
          if (photos.length === 0) {
            sendSSE(controller, {
              type: 'error',
              message:
                "We couldn't find a usable headshot/product photo on that page. Try attaching the image file directly instead.",
            });
            closeSSE(controller);
            return;
          }
          const photoUrl = photos[0];
          const routing = await tryRoutingCall(prompt, schema, slSections, [photoUrl], usageCtx);
          captureModelRequirements(routing);
          const targetName =
            routing &&
            routing.type === 'patch' &&
            routing.target_sections.length >= 1 &&
            routing.target_sections.every((n) => slSections.some((s) => s.name === n))
              ? routing.target_sections[0]
              : (slSections.find((s) => /hero|team|about|testimonial/i.test(s.name))?.name ?? null);
          if (!targetName) {
            scopedFailureReason = 'content_image_no_target_section';
          } else {
            const section = slSections.find((s) => s.name === targetName)!;
            const photoPrompt =
              `${prompt}\n\n(A real photo was fetched from the referenced site — attached below. Embed it with src="${photoUrl}" exactly. Do not invent a different image URL. Prefer replacing an existing <img> in this section; if none, add one that fits the layout.)`;
            const patchResult = await runScopedPatchWithRetry(
              section.html,
              { [targetName]: (schema as Record<string, unknown> | null | undefined)?.[targetName] },
              photoPrompt,
              [photoUrl],
              usageCtx,
            );
            if (patchResult.html && patchResult.html.includes(photoUrl)) {
              finalHtml = applyPatch(html, [{ name: targetName, html: patchResult.html }]);
              scopedApplied = true;
              console.log('[pages/follow-up] content image swap applied', { section: targetName, photoUrl: photoUrl.slice(0, 120) });
            } else {
              scopedFailureReason = 'content_image_patch_failed';
            }
          }
        }

        // Surgical copy rewrite first — avoids full-section HTML regeneration
        // for "paste headline + change this text" prompts (no images / competitor).
        if (!hasUserImages && !scopedApplied && !scopedFailureReason && isSimpleTextRewritePrompt(prompt)) {
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

        // Per-image roles: bug screenshots vs content assets (before planner/routing)
        if (hasUserImages && !scopedApplied && !scopedFailureReason) {
          const classified = await classifyAttachedImages({
            prompt,
            imageUrls: effectiveImageUrls,
            usage: usageCtx,
          });
          if (classified === 'clarify') {
            const question =
              'You attached more than one image — which are bug screenshots to fix, which should I place on the page, and which are design references to match (e.g. "make the footer look like this")? Reply briefly.';
            const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
            if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
            const updatedConversation = [
              ...history,
              userEntry,
              { role: 'assistant', content: question, clarify: true },
            ];
            await db
              .from('pages')
              .update({
                conversation_json: updatedConversation,
                updated_at: new Date().toISOString(),
              })
              .eq('id', params.id);
            sendSSE(controller, { type: 'clarify', message: question });
            closeSSE(controller);
            return;
          }
          const bugs = classified.filter((c) => c.role === 'bug_reference').map((c) => c.url);
          const assets = classified.filter((c) => c.role === 'content_asset').map((c) => c.url);
          designReferenceUrls = classified.filter((c) => c.role === 'design_reference').map((c) => c.url);
          routingImageUrls = effectiveImageUrls; // vision for section targeting uses all
          // Never embed bug or design-reference screenshots as <img src>
          embedImageUrls = assets.length > 0 ? assets : [];
          imageRolesClassified = true;
          console.log('[pages/follow-up] attached image roles', {
            bugs: bugs.length,
            assets: assets.length,
            designRefs: designReferenceUrls.length,
          });

          if (designReferenceUrls.length > 0 || isDesignReferenceAsk(prompt)) {
            const ocrUrls =
              designReferenceUrls.length > 0 ? designReferenceUrls : effectiveImageUrls.slice(0, 2);
            sendSSE(controller, { type: 'status', message: 'Reading design reference…' });
            designCopyLines = await extractDesignReferenceCopy({
              imageUrls: ocrUrls,
              prompt,
              usage: usageCtx,
            });
            console.log('[pages/follow-up] design-ref OCR lines', {
              count: designCopyLines.length,
              preview: designCopyLines.slice(0, 4),
            });
          }

          // Design-match with a named section (e.g. "keep the footer like this")
          // → pin targets before routing so we don't under-confidence or no-op.
          if (!targetSections && designReferenceUrls.length > 0) {
            const hinted = inferDesignMatchSectionNames(
              prompt,
              slSections.map((s) => s.name),
            );
            if (hinted.length >= 1 && hinted.length <= 3) {
              targetSections = hinted;
              console.log('[pages/follow-up] design-reference section pin', {
                hinted,
                promptPreview: prompt.slice(0, 200),
              });
            }
          }
        }

        // Multi-intent planner — only when the prompt looks like several
        // distinct asks. Single clear edits skip this (stay fast).
        if (!scopedApplied && !scopedFailureReason && looksLikeMultiIntent(prompt)) {
          const forceDecidePlan =
            lastAssistantWasClarify ||
            userWantsUsToDecide(prompt) ||
            isScreenshotComplaint(prompt, hasUserImages) ||
            isDesignReferenceAsk(prompt) ||
            designReferenceUrls.length > 0;
          sendSSE(controller, { type: 'status', message: 'Planning edits...' });
          const plan = await planMultiIntentEdit({
            prompt,
            sectionNames: slSections.map((s) => s.name),
            sectionPreviews: slSections.map((s) => ({ name: s.name, text: s.text })),
            imageUrls: routingImageUrls,
            forceDecide: forceDecidePlan,
            usage: usageCtx,
          });
          console.log('[pages/follow-up] multi-intent plan', {
            promptPreview: prompt.slice(0, 300),
            plan:
              plan.mode === 'execute'
                ? { mode: plan.mode, steps: plan.steps.map((s) => ({ op: s.op, targets: s.target_sections, preview: s.instruction.slice(0, 80) })) }
                : plan,
          });

          if (plan.mode === 'clarify' && !forceDecidePlan) {
            const question = plan.question;
            const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
            if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
            const updatedConversation = [
              ...history,
              userEntry,
              { role: 'assistant', content: question, clarify: true },
            ];
            await db
              .from('pages')
              .update({
                conversation_json: updatedConversation,
                updated_at: new Date().toISOString(),
              })
              .eq('id', params.id);
            sendSSE(controller, { type: 'clarify', message: question });
            closeSSE(controller);
            return;
          }

          if (plan.mode === 'execute') {
            let workingHtml = html;
            const stepFailures: string[] = [];
            const stepOks: string[] = [];

            for (let i = 0; i < plan.steps.length; i++) {
              const step = plan.steps[i];
              if (request.signal.aborted) { closeSSE(controller); return; }
              sendSSE(controller, {
                type: 'status',
                message: `Step ${i + 1}/${plan.steps.length}: ${step.instruction.slice(0, 60)}${step.instruction.length > 60 ? '…' : ''}`,
              });

              const liveSections = extractSlSections(workingHtml);
              let stepTargets = step.target_sections.filter((n) => liveSections.some((s) => s.name === n));

              if (step.op === 'remove_section' && stepTargets.length === 1) {
                const removed = removeSlSection(workingHtml, stepTargets[0]);
                if (removed) {
                  workingHtml = removed;
                  stepOks.push(stepTargets[0]);
                  if (schema && typeof schema === 'object' && stepTargets[0] in (schema as Record<string, unknown>)) {
                    const schemaCopy = (finalSchemaJson && typeof finalSchemaJson === 'object'
                      ? JSON.parse(JSON.stringify(finalSchemaJson))
                      : JSON.parse(JSON.stringify(schema))) as Record<string, unknown>;
                    delete schemaCopy[stepTargets[0]];
                    finalSchemaJson = schemaCopy;
                  }
                } else {
                  stepFailures.push(`remove ${stepTargets[0]}`);
                }
                continue;
              }

              if (stepTargets.length === 0) {
                const stepRouting = await tryRoutingCall(
                  step.instruction,
                  schema,
                  liveSections,
                  routingImageUrls,
                  usageCtx,
                );
                if (
                  stepRouting &&
                  stepRouting.type === 'patch' &&
                  stepRouting.target_sections?.length >= 1 &&
                  stepRouting.target_sections.every((n) => liveSections.some((s) => s.name === n))
                ) {
                  stepTargets = stepRouting.target_sections.slice(0, 3);
                } else if (
                  stepRouting?.type === 'remove_section' &&
                  stepRouting.target_sections?.length === 1 &&
                  liveSections.some((s) => s.name === stepRouting.target_sections[0])
                ) {
                  const removed = removeSlSection(workingHtml, stepRouting.target_sections[0]);
                  if (removed) {
                    workingHtml = removed;
                    stepOks.push(stepRouting.target_sections[0]);
                  } else {
                    stepFailures.push(`remove ${stepRouting.target_sections[0]}`);
                  }
                  continue;
                } else if (step.op === 'structural') {
                  // Leave structural steps to the full-page path by aborting
                  // the multi-step plan so we don't half-apply then rebuild.
                  stepFailures.push('structural_needs_full_page');
                  break;
                }
              }

              if (stepTargets.length === 0) {
                stepFailures.push(`unrouted:${step.instruction.slice(0, 40)}`);
                continue;
              }

              const patched: Array<{ name: string; html: string }> = [];
              let stepOk = true;
              const stepDesignNote =
                designReferenceUrls.length > 0 || isDesignReferenceAsk(step.instruction) || isDesignReferenceAsk(prompt)
                  ? `\n\n(DESIGN REFERENCE — CRITICAL: Attached images may show how this section should look. Recreate layout/structure/copy from the screenshot in real HTML. Do NOT leave unchanged. Do NOT embed design-reference screenshot URLs as <img src> for the whole section.)`
                  : '';
              for (const name of stepTargets) {
                const section = liveSections.find((s) => s.name === name);
                if (!section) {
                  stepOk = false;
                  stepFailures.push(`missing:${name}`);
                  break;
                }
                const schemaSlice = { [name]: (schema as Record<string, unknown> | null | undefined)?.[name] };
                let patchResult = await runScopedPatchWithRetry(
                  section.html,
                  schemaSlice,
                  step.instruction + stepDesignNote,
                  routingImageUrls,
                  usageCtx,
                );
                // One automatic retry for flaky scoped patches before recording failure
                if (!patchResult.html) {
                  sendSSE(controller, {
                    type: 'status',
                    message: `Retrying step ${i + 1}/${plan.steps.length}…`,
                  });
                  patchResult = await runScopedPatchWithRetry(
                    section.html,
                    schemaSlice,
                    step.instruction,
                    routingImageUrls,
                    usageCtx,
                  );
                }
                if (!patchResult.html) {
                  stepOk = false;
                  stepFailures.push(`patch_fail:${name}`);
                  break;
                }
                const verify = verifyScopedPatchIntent({
                  prompt:
                    isDesignReferenceAsk(prompt) || designReferenceUrls.length > 0
                      ? `${prompt}\n${step.instruction}`
                      : step.instruction,
                  sectionName: name,
                  beforeHtml: section.html,
                  afterHtml: patchResult.html,
                });
                if (!verify.ok) {
                  console.error('[pages/follow-up] multi-intent step failed verify', { name, reason: verify.reason });
                  stepOk = false;
                  stepFailures.push(verify.reason ?? `verify_fail:${name}`);
                  break;
                }
                patched.push({ name, html: patchResult.html });
              }

              if (stepOk && patched.length > 0) {
                workingHtml = applyPatch(workingHtml, patched);
                stepOks.push(...patched.map((p) => p.name));
              }
            }

            if (stepOks.length > 0 && stepFailures.length === 0) {
              finalHtml = workingHtml;
              scopedApplied = true;
              console.log('[pages/follow-up] multi-intent plan applied', { stepOks });
            } else if (stepOks.length > 0 && stepFailures.length > 0) {
              // Auto-retry failed steps before accepting a partial outcome.
              sendSSE(controller, { type: 'status', message: 'Finishing remaining edits…' });
              const failedInstructions = plan.steps.filter((s) => {
                // Re-run steps whose targets aren't in stepOks / still pending
                const targets = s.target_sections;
                if (targets.length === 0) return true;
                return targets.some((t) => !stepOks.includes(t));
              });
              const retryFailures: string[] = [];
              for (const step of failedInstructions) {
                const liveSections = extractSlSections(workingHtml);
                let stepTargets = step.target_sections.filter((n) => liveSections.some((s) => s.name === n));
                if (stepTargets.length === 0) {
                  const stepRouting = await tryRoutingCall(
                    step.instruction,
                    schema,
                    liveSections,
                    routingImageUrls,
                    usageCtx,
                  );
                  if (
                    stepRouting?.type === 'patch' &&
                    stepRouting.target_sections?.length >= 1 &&
                    stepRouting.target_sections.every((n) => liveSections.some((s) => s.name === n))
                  ) {
                    stepTargets = stepRouting.target_sections.slice(0, 3);
                  }
                }
                if (stepTargets.length === 0) {
                  retryFailures.push(`unrouted:${step.instruction.slice(0, 40)}`);
                  continue;
                }
                let stepOk = true;
                const patched: Array<{ name: string; html: string }> = [];
                for (const name of stepTargets) {
                  if (stepOks.includes(name)) continue;
                  const section = liveSections.find((s) => s.name === name);
                  if (!section) {
                    stepOk = false;
                    retryFailures.push(`missing:${name}`);
                    break;
                  }
                  const schemaSlice = {
                    [name]: (schema as Record<string, unknown> | null | undefined)?.[name],
                  };
                  const patchResult = await runScopedPatchWithRetry(
                    section.html,
                    schemaSlice,
                    step.instruction +
                      '\n\n(RETRY — previous attempt failed. Apply this edit completely.)',
                    routingImageUrls,
                    usageCtx,
                  );
                  if (!patchResult.html) {
                    stepOk = false;
                    retryFailures.push(`patch_fail:${name}`);
                    break;
                  }
                  const verify = verifyScopedPatchIntent({
                    prompt: step.instruction,
                    sectionName: name,
                    beforeHtml: section.html,
                    afterHtml: patchResult.html,
                    requiredPhrases:
                      designCopyLines.length > 0 &&
                      (isDesignReferenceAsk(prompt) || designReferenceUrls.length > 0)
                        ? designCopyLines
                        : null,
                  });
                  if (!verify.ok) {
                    stepOk = false;
                    retryFailures.push(verify.reason ?? `verify_fail:${name}`);
                    break;
                  }
                  patched.push({ name, html: patchResult.html });
                }
                if (stepOk && patched.length > 0) {
                  workingHtml = applyPatch(workingHtml, patched);
                  stepOks.push(...patched.map((p) => p.name));
                }
              }

              if (retryFailures.length === 0) {
                finalHtml = workingHtml;
                scopedApplied = true;
                console.log('[pages/follow-up] multi-intent completed after retry', { stepOks });
              } else {
                // Still unfinished after retry — keep progress, continue into
                // normal path for leftovers instead of "partial Done" toast.
                finalHtml = workingHtml;
                html = workingHtml;
                slSections = extractSlSections(workingHtml);
                console.warn('[pages/follow-up] multi-intent unfinished after retry — continuing', {
                  stepOks,
                  retryFailures,
                });
              }
            } else if (stepFailures.includes('structural_needs_full_page')) {
              console.log('[pages/follow-up] multi-intent deferred to full-page (structural step)');
              // fall through — don't set scopedApplied
            } else {
              scopedFailureReason = 'multi_intent_all_steps_failed';
            }
          }
          // mode === 'single' → fall through to normal routing
        }

        // A logo-swap attempt above already qualified as a scoped op and
        // either succeeded (scopedApplied) or hard-failed (scopedFailureReason)
        // — never let the generic routing call below re-evaluate the same
        // instruction from scratch, since it doesn't know a real logo was
        // fetched and could route it into image_generate (an AI-fabricated
        // logo), silently reproducing the bug this branch exists to prevent.
        if (!scopedApplied && !targetSections && !scopedFailureReason) {
          sendSSE(controller, { type: 'status', message: 'Locating section...' });
          const routing = await tryRoutingCall(prompt, schema, slSections, routingImageUrls, usageCtx);
          captureModelRequirements(routing);
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
          // Declared early so forceDecide can relax confidence for proceed-anyway.
          const forceDecideEarly =
            lastAssistantWasClarify ||
            userWantsUsToDecide(prompt) ||
            isScreenshotComplaint(prompt, hasUserImages) ||
            isDesignReferenceAsk(prompt) ||
            designReferenceUrls.length > 0 ||
            // Soft copy polish ("make the text nicer") — decide a section and act,
            // don't ask clarifying questions or error-toast for a normal edit.
            (/\b(nicer|polish|improve|better|tighten|refine|clarify|shorten)\b/i.test(prompt) &&
              /\b(text|copy|headline|heading|wording|this|here)\b/i.test(prompt));
          const routingQualifies = basicShapeOk && (
            routing!.confidence === 'high' ||
            namesItsSingleSection ||
            forceDecideEarly
          );

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
            (routing.confidence === 'high' || forceDecideEarly) &&
            routing.target_sections.length === 1 &&
            slSections.some((s) => s.name === routing.target_sections[0]);

          const reorderShapeOk = !!routing &&
            routing.type === 'reorder_sections' &&
            (routing.confidence === 'high' || forceDecideEarly) &&
            Array.isArray(routing.new_order) &&
            routing.new_order.length >= 2 &&
            new Set(routing.new_order).size === routing.new_order.length &&
            routing.new_order.every((n) => slSections.some((s) => s.name === n));

          const insertShapeOk = !!routing &&
            routing.type === 'insert_section' &&
            (routing.confidence === 'high' || forceDecideEarly) &&
            typeof routing.anchor_section === 'string' &&
            slSections.some((s) => s.name === routing.anchor_section) &&
            (routing.position === 'before' || routing.position === 'after');

          const anyScopedPath =
            routingQualifies || removeShapeOk || reorderShapeOk || insertShapeOk || imageGenerateShapeOk;

          console.log('[pages/follow-up] routing decision', {
            promptPreview: prompt.slice(0, 300),
            routing,
            qualifies: anyScopedPath,
            hasUserImages,
          });

          const forceFaqVsFormClarify =
            !!routing && shouldForceClarifyFaqVsForm(prompt, routing, hasUserImages, slSections);

          // Clarifying "which section?" only makes sense for ops that target
          // a specific, namable section — "structural"/"style" are broad,
          // often-analytical requests (e.g. "remove the lower-value
          // sections") where the ambiguity isn't a fact only the user has,
          // it's a judgment call the full-page path (with complete page
          // content) is meant to make itself. Never ask about those — let
          // them fall straight through to the full-page path below.
          const narrowScopedType =
            !!routing && ['patch', 'remove_section', 'insert_section', 'reorder_sections', 'image_generate'].includes(routing.type);

          // Decide-and-act: never clarify when the user deferred, or when a
          // screenshot complaint already shows the defect (production over-ask).
          const forceDecide = forceDecideEarly;

          // Unsure which section → ask the user instead of guessing or
          // falling into an expensive/oversized full-page rebuild. Never ask
          // twice in a row — if we already asked last turn, the user's reply
          // is the answer (even a non-specific one), not a new prompt to
          // re-evaluate. Also never ask when forceDecide.
          const routingUnsure =
            !!routing &&
            !forceDecide &&
            narrowScopedType &&
            ((routing.confidence === 'low' && !namesItsSingleSection && !anyScopedPath) ||
              forceFaqVsFormClarify);

          if (routingUnsure) {
            const formLike = slSections
              .filter((s) => /cta|form|popup|contact|lead/i.test(s.name))
              .map((s) => s.name);
            const questionFromModel =
              typeof routing!.clarifying_question === 'string' && routing!.clarifying_question.trim()
                ? routing!.clarifying_question.trim()
                : null;
            const question =
              questionFromModel ||
              (forceFaqVsFormClarify && formLike.length > 0
                ? `Your screenshots look like a form. Did you mean the "${formLike[0]}" section (the form), or "${routing!.target_sections[0]}" (FAQ)? Reply with the section name.`
                : buildDefaultClarifyQuestion(routing!, slSections));
            console.log('[pages/follow-up] routing unsure — asking user to clarify', {
              promptPreview: prompt.slice(0, 300),
              routing,
              forceFaqVsFormClarify,
              question,
            });
            const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
            if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
            const updatedConversation = [
              ...history,
              userEntry,
              { role: 'assistant', content: question, clarify: true },
            ];
            await db
              .from('pages')
              .update({
                conversation_json: updatedConversation,
                updated_at: new Date().toISOString(),
              })
              .eq('id', params.id);
            sendSSE(controller, { type: 'clarify', message: question });
            closeSSE(controller);
            return;
          }

          if (routingQualifies) {
            targetSections = (routing as { target_sections: string[] }).target_sections;
            // If we skipped FAQ-vs-form clarify because forceDecide, prefer the form.
            if (forceFaqVsFormClarify && forceDecide) {
              const formLike = slSections.find((s) => /cta|form|popup|contact|lead/i.test(s.name));
              if (formLike) {
                console.log('[pages/follow-up] forceDecide remapped faq→form', {
                  from: targetSections,
                  to: formLike.name,
                });
                targetSections = [formLike.name];
              }
            }
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
            const inserted = await runScopedInsert(anchorSection.html, headSection?.html ?? '', usedNames, prompt, routingImageUrls);
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
          const designNote =
            designReferenceUrls.length > 0 || isDesignReferenceAsk(prompt)
              ? `\n\n(DESIGN REFERENCE — CRITICAL: One or more attached images show how THIS section should look. Recreate the visible layout, structure, spacing, and readable copy from the screenshot in real HTML/CSS inside this section. OCR/transcribe visible text from the reference when present. Do NOT leave the section unchanged even if it looks vaguely similar. Do NOT embed the design-reference screenshot URL as an <img src> for the whole section. Existing page logo <img> URLs already in the section may be kept if they match the brand mark; otherwise rebuild the mark with inline SVG or keep the closest existing logo asset. This overrides the usual "minimum surgical edit" bias — matching the reference is the job.)` +
                (designCopyLines.length > 0
                  ? `\n\nREQUIRED visible copy from the design reference — each of these strings MUST appear verbatim in the section HTML:\n` +
                    designCopyLines.map((l, i) => `${i + 1}. ${l}`).join('\n')
                  : '')
              : '';
          const embedNote =
            hasUserImages &&
            (embedImageUrls.length !== routingImageUrls.length || designReferenceUrls.length > 0)
              ? `\n\n(Image roles: ONLY embed these content-asset URL(s) into src attributes: ${embedImageUrls.length ? embedImageUrls.join(', ') : '(none)'}. Bug-reference images are for diagnosing defects — never put those URLs in src. Design-reference images are for matching layout/copy — recreate in HTML, never put those screenshot URLs in src.)`
              : '';
          const scopedPromptFinal = scopedPrompt + designNote + embedNote;
          // Vision: all images. URL list for embedding prefers assets; include generated URL last.
          const scopedImageUrls = generatedImageUrl
            ? Array.from(new Set([...(embedImageUrls.length ? embedImageUrls : routingImageUrls), generatedImageUrl]))
            : (embedImageUrls.length ? Array.from(new Set([...embedImageUrls, ...routingImageUrls])) : routingImageUrls);

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
            let patchResult = await runScopedPatchWithRetry(section.html, schemaSlice, scopedPromptFinal, scopedImageUrls, usageCtx);
            let updated = patchResult.html;
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
            let verify = verifyScopedPatchIntent({
              prompt,
              sectionName: name,
              beforeHtml: section.html,
              afterHtml: updated,
              requiredSubstring: generatedImageUrl,
              requiredPhrases: designCopyLines.length > 0 ? designCopyLines : null,
            });
            // Design-match miss: one forced rewrite with the missing OCR lines.
            if (
              !verify.ok &&
              verify.reason.includes('design_copy') &&
              designCopyLines.length > 0
            ) {
              const missing = designCopyLines.filter((l) => !updated!.includes(l));
              sendSSE(controller, { type: 'status', message: 'Matching design copy…' });
              const retryPrompt =
                scopedPromptFinal +
                `\n\nCRITICAL RETRY — previous HTML was missing design-reference copy. You MUST include ALL of these strings verbatim:\n` +
                missing.map((l, i) => `${i + 1}. ${l}`).join('\n');
              patchResult = await runScopedPatchWithRetry(
                section.html,
                schemaSlice,
                retryPrompt,
                scopedImageUrls,
                usageCtx,
              );
              if (patchResult.html) {
                updated = patchResult.html;
                verify = verifyScopedPatchIntent({
                  prompt,
                  sectionName: name,
                  beforeHtml: section.html,
                  afterHtml: updated,
                  requiredSubstring: generatedImageUrl,
                  requiredPhrases: designCopyLines,
                });
              }
            }
            if (!verify.ok) {
              console.error('[pages/follow-up] scoped patch failed intent verify', {
                section: name,
                reason: verify.reason,
                promptPreview: prompt.slice(0, 300),
              });
              scopedFailureReason = verify.reason;
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
      // Classify attachments if we skipped the scoped path (e.g. competitor URL)
      if (hasUserImages && !imageRolesClassified) {
        const classified = await classifyAttachedImages({
          prompt,
          imageUrls: effectiveImageUrls,
          usage: usageCtx,
        });
        if (classified === 'clarify') {
          const question =
            'You attached more than one image — which are bug screenshots to fix, which should I place on the page, and which are design references to match (e.g. "make the footer look like this")? Reply briefly.';
          const userEntry: Record<string, unknown> = { role: 'user', content: prompt };
          if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
          const updatedConversation = [
            ...history,
            userEntry,
            { role: 'assistant', content: question, clarify: true },
          ];
          await db
            .from('pages')
            .update({
              conversation_json: updatedConversation,
              updated_at: new Date().toISOString(),
            })
            .eq('id', params.id);
          sendSSE(controller, { type: 'clarify', message: question });
          closeSSE(controller);
          return;
        }
        const assets = classified.filter((c) => c.role === 'content_asset').map((c) => c.url);
        designReferenceUrls = classified.filter((c) => c.role === 'design_reference').map((c) => c.url);
        routingImageUrls = effectiveImageUrls;
        embedImageUrls = assets.length > 0 ? assets : [];
        imageRolesClassified = true;
      }

      // Only scrape/rebuild from a URL when the user asked for a redesign/clone.
      // Incidental URLs on local edits skip scrape (keeps huge-page path rare).
      const shouldScrapeCompetitor =
        competitorUrls.length > 0 &&
        (userWantsFullCompetitorRebuild(prompt) ||
          (!isScopedDespiteUrl && !isContentImageSwapAttempt));

      if (shouldScrapeCompetitor) {
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
                text:
                  (designReferenceUrls.length > 0
                    ? 'DESIGN REFERENCE image(s) attached — recreate the shown layout/structure/copy in real HTML for the targeted section(s). Do NOT embed these screenshot URL(s) as <img src> for the whole section:\n' +
                      designReferenceUrls.map((u, i) => `${i + 1}. ${u}`).join('\n') +
                      '\nLeaving the page unchanged is a failure.\n'
                    : '') +
                  (embedImageUrls.length > 0 && embedImageUrls.length !== routingImageUrls.length
                    ? 'User-attached image(s): ONLY these URL(s) may be used in src attributes (content assets):\n' +
                      embedImageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n') +
                      '\nOther attached images that are bug-reference screenshots — diagnose from them but NEVER put those URLs in src.\n'
                    : embedImageUrls.length === 0 &&
                        routingImageUrls.length > 0 &&
                        designReferenceUrls.length === 0
                      ? 'User-attached image(s) are bug-reference screenshots for diagnosis — do NOT embed their URLs in src attributes.\n'
                      : embedImageUrls.length === 0 && designReferenceUrls.length > 0
                        ? ''
                        : 'User-attached image(s) — apply the "Attached images" rule from the system prompt to determine whether each is a bug reference screenshot, a design reference to match, or a content asset to embed. If embedding, you MUST use these EXACT URL strings verbatim in any src attribute — the image content below only shows you the pixels, not the URL:\n' +
                          routingImageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n') +
                          '\n') +
                  (embedImageUrls.length > 0 && embedImageUrls.length === routingImageUrls.length
                    ? 'If embedding, you MUST use these EXACT URL strings verbatim in any src attribute:\n' +
                      embedImageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')
                    : ''),
              },
              ...routingImageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
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
            usage: { ...usageCtx, operation: 'build' },
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

        const materializedLogoUrl = await materializeLogoUrl({
          pageSlug,
          logoUrl: competitorContext?.logoUrl,
          logoSvg: competitorContext?.logoSvgMarkup,
        });

        let schemaForImages = hasCompetitorContext
          ? stripGeneratedImageUrls(parsed.schema_json as Record<string, unknown>)
          : (parsed.schema_json as Record<string, unknown>);

        if (materializedLogoUrl || competitorContext?.logoUrl || (competitorContext?.footerContact && Object.keys(competitorContext.footerContact).length > 0)) {
          schemaForImages = injectBrandAssetsIntoSchema(schemaForImages, {
            logoUrl: materializedLogoUrl ?? competitorContext?.logoUrl,
            footer: competitorContext?.footerContact,
          });
        }

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

        // Content-only structural edits (remove/shorten sections, no
        // redesign intent) — apply the AI's already-decided schema diff
        // directly against the existing HTML instead of a full rebuild, so
        // untouched sections and the page's visual style can't drift. Falls
        // back to the full rebuild below on any failure.
        sendSSE(controller, { type: 'status', message: 'Applying changes...' });
        const diffSplicedHtml = !hasCompetitorContext
          ? await tryStructuralDiffSplice(html, schema, enrichedSchema, slSections, prompt, routingImageUrls, usageCtx)
          : null;

        if (diffSplicedHtml) {
          finalHtml = diffSplicedHtml;
        } else {
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
            realLogoUrl: materializedLogoUrl ?? undefined,
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
          if (materializedLogoUrl || competitorContext?.logoSvgMarkup) {
            finalHtml = forceEmbedLogoInHtml(
              finalHtml,
              materializedLogoUrl,
              materializedLogoUrl ? null : competitorContext?.logoSvgMarkup ?? null,
            );
          }
          if (competitorContext?.footerContact) {
            finalHtml = forceEmbedFooterContactInHtml(finalHtml, competitorContext.footerContact);
          }
          // Live pixel QA runs after upload (see below) — avoids double work here.
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
        } // end full-rebuild fallback (diff+splice not eligible/failed)

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

      // Fail-closed: content-reuse asks must leave the exact asset in targets.
      if (finalHtml) {
        const reuseFinal = detectContentReuseIntent(
          prompt,
          extractSlSections(finalHtml).map((s) => s.name),
        );
        if (reuseFinal && reuseFinal.targets.length > 0) {
          if (reuseFinal.kind === 'logo') {
            const workingLogo =
              logoSwapAppliedUrl ??
              extractPrimaryLogoUrlFromHtml(finalHtml) ??
              extractPrimaryLogoUrlFromHtml(html);
            if (workingLogo) {
              finalHtml = forceEmbedLogoIntoSections(finalHtml, reuseFinal.targets, workingLogo, null);
              // Prefer shipping a working logo somewhere over blocking the user
              // with an error toast for a simple "put logo in footer" ask.
              logoSwapAppliedUrl = workingLogo;
            }
          } else if (reuseFinal.kind === 'text') {
            let text = reuseFinal.textPayload;
            if (!text && reuseFinal.sourceSectionHint) {
              const srcName = resolveSourceSectionName(
                reuseFinal.sourceSectionHint,
                extractSlSections(html).map((s) => s.name),
              );
              const srcSec = srcName
                ? extractSlSections(html).find((s) => s.name === srcName)
                : null;
              text = srcSec ? extractPrimaryHeadlineFromHtml(srcSec.html) : null;
            }
            if (text) {
              finalHtml = forcePlaceTextIntoSections(finalHtml, reuseFinal.targets, text);
            }
          }
        }
      }

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
        const designMatch =
          designReferenceUrls.length > 0 || isDesignReferenceAsk(prompt);
        sendSSE(controller, {
          type: 'error',
          message: designMatch
            ? 'Could not match the attached design reference to the page. Try naming the section again (e.g. “make the footer look like this”) or attach a clearer crop of just that section.'
            : 'No changes were applied to the page. Try rephrasing your request, or quote the exact text you want changed.',
        });
        closeSSE(controller);
        return;
      }

      // Every AI call and string splice above only ever saw placeholders — swap
      // real image bytes back in now, exactly once, for everything that gets
      // persisted or sent back to the client from this point on.
      let finalHtmlPersisted = restoreDataUris(finalHtml, dataUriMap);
      const finalSchemaJsonReal = finalSchemaJson
        ? (restoreDataUrisInValue(finalSchemaJson, dataUriMap) as Record<string, unknown>)
        : undefined;

      // Any external <img> — ours or one the model wrote — is fetched, verified
      // and re-hosted so an edit can't ship a URL that 404s in the browser.
      const assetScan = await verifyAndRehostHtmlImages({
        pageSlug: params.id,
        html: finalHtmlPersisted,
      });
      finalHtmlPersisted = assetScan.html;
      if (assetScan.rehosted.length > 0 || assetScan.broken.length > 0) {
        console.log('[pages/follow-up] asset integrity', {
          rehosted: assetScan.rehosted.length,
          broken: assetScan.broken,
        });
      }

      // Requirements: what the user actually asked for, checked against what we
      // built. Deterministic fixes are applied here; anything still unmet
      // downgrades the toast instead of claiming Done.
      const editRequirementAssets = [
        typeof finalSchemaJsonReal?.brand_logo_url === 'string'
          ? (finalSchemaJsonReal.brand_logo_url as string)
          : null,
        competitorContext?.logoUrl ?? null,
      ].filter((u): u is string => !!u && finalHtmlPersisted.includes(u));

      const requirements = mergeRequirements(
        modelRequirements,
        extractRequirements({
          prompt,
          assetUrls: editRequirementAssets,
          designCopyLines,
        }),
      );
      if (requirements.length > 0) {
        const enforced = enforceRequirements(finalHtmlPersisted, requirements);
        finalHtmlPersisted = enforced.html;
        if (enforced.applied.length > 0) {
          console.log('[pages/follow-up] requirements enforced', enforced.applied);
        }
        const unmet = describeUnmet(
          checkRequirements(finalHtmlPersisted, requirements, {
            beforeHtml: originalHtmlForPreservation,
          }),
        );
        if (unmet) {
          console.warn('[pages/follow-up] unmet requirements', { unmet, prompt: prompt.slice(0, 200) });
          partialMessage = partialMessage
            ? `${partialMessage} Still not applied: ${unmet}.`
            : `Still not applied: ${unmet}.`;
        }
      }
      if (assetScan.broken.length > 0) {
        const note = `${assetScan.broken.length} image URL(s) could not be loaded and were left as-is.`;
        partialMessage = partialMessage ? `${partialMessage} ${note}` : note;
      }

      // Collateral damage guard: an edit about colors has no business deleting
      // the logo. Compare against the pre-edit page and put back what vanished
      // without being asked for. Skipped entirely when the user said "remove".
      const losses = findUnrequestedLosses({
        beforeHtml: originalHtmlForPreservation,
        afterHtml: finalHtmlPersisted,
        prompt,
      });
      if (hasLosses(losses)) {
        console.warn('[pages/follow-up] unrequested losses', {
          images: losses.images.length,
          sections: losses.sections,
          headings: losses.headings.length,
          prompt: prompt.slice(0, 200),
        });

        // Brand marks are restorable deterministically — we know where they go.
        const lostLogo = losses.images.find(
          (u) => /logo|brand|wordmark/i.test(u) || u === preEditLogoUrl,
        );
        let restoredLogo = false;
        if (lostLogo) {
          // Put it back where the user had it — assuming nav/footer would move
          // a hero logo somewhere they never asked for.
          const slNames = Array.from(
            finalHtmlPersisted.matchAll(/<!--\s*SL:([a-z0-9_-]+)\s*-->/gi),
          ).map((m) => m[1]);
          const original = sectionsContainingAsset(originalHtmlForPreservation, lostLogo);
          const targets = original.filter((n) => slNames.includes(n));
          if (targets.length === 0) {
            targets.push(...slNames.filter((n) => /nav|header|footer/i.test(n)));
          }
          if (targets.length === 0) targets.push('nav', 'footer');
          const restored = forceEmbedLogoIntoSections(finalHtmlPersisted, targets, lostLogo, null);
          if (restored !== finalHtmlPersisted) {
            finalHtmlPersisted = restored;
            restoredLogo = true;
            console.log('[pages/follow-up] restored logo removed without request', {
              targets,
              logo: lostLogo.slice(0, 120),
            });
          }
        }

        // Anything we could not put back is reported rather than hidden.
        const remaining = findUnrequestedLosses({
          beforeHtml: originalHtmlForPreservation,
          afterHtml: finalHtmlPersisted,
          prompt,
        });
        const lossNote = describeLosses(remaining);
        if (lossNote) {
          const note = `Heads up: ${lossNote}.`;
          partialMessage = partialMessage ? `${partialMessage} ${note}` : note;
        } else if (restoredLogo) {
          console.log('[pages/follow-up] all unrequested losses repaired');
        }
      }

      // Variant pages write to draft_* columns and never touch the live storage
      // file a test is actually serving — only "Replace Current Variant" uploads
      // to the live path. Non-variant pages behave exactly as before.
      let htmlUrl: string = page.html_url ?? '';
      if (!isVariant) {
        const storagePath = fileNameFromUrl(page.html_url);
        htmlUrl = await uploadHtml(storagePath, finalHtmlPersisted);

        // Live nav/logo QA after upload when we have reference shots + logo intent.
        // Fail-closed: screenshot failure → HTML fallback or skip; never blocks Done.
        const liveQaShots = competitorContext?.screenshots?.slice(0, 2) ?? [];
        const liveLogo =
          typeof finalSchemaJsonReal?.brand_logo_url === 'string'
            ? (finalSchemaJsonReal.brand_logo_url as string)
            : competitorContext?.logoUrl ?? null;
        if (
          liveQaShots.length > 0 ||
          hasUserImages
        ) {
          sendSSE(controller, { type: 'status', message: 'Checking full page look…' });
          const qa = await runPostUploadNavLogoQa({
            html: finalHtmlPersisted,
            publicHtmlUrl: htmlUrl,
            prompt,
            expectedLogoUrl: liveLogo,
            imageUrls: hasUserImages ? effectiveImageUrls : [],
            competitorScreenshots: liveQaShots,
            logoIntent: !!(liveLogo || competitorContext?.logoSvgMarkup || /\blogo\b/i.test(prompt)),
            usage: usageCtx,
            label: 'follow-up:live-visual-qa',
          });
          console.log('[pages/follow-up] live visual-qa', {
            mode: qa.mode,
            appliedFix: qa.appliedFix,
            issues: qa.issues,
          });
          if (qa.appliedFix) {
            finalHtmlPersisted = qa.html;
            htmlUrl = await uploadHtml(storagePath, finalHtmlPersisted);
          }
        }
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
        updatePayload.draft_html_content = finalHtmlPersisted;
      } else {
        updatePayload.html_url = htmlUrl;
        updatePayload.html_content = finalHtmlPersisted.length < 500_000 ? finalHtmlPersisted : null;
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

      // Report any accrued overage to Stripe (no-op unless overage is enabled
      // and a metered price is configured). Fire-and-forget.
      void reportAiOverageUsage(aiOwnerId);

      const doneEvent: SSEEvent = {
        type: 'done',
        // For variant drafts this is the unchanged live URL — the client only
        // uses it as a cache-busting trigger to refetch /preview, which serves
        // the draft content directly.
        html_url: htmlUrl,
        ...(finalSchemaJsonReal ? { schema_json: finalSchemaJsonReal } : {}),
        ...(competitorUrls.length > 0 && !competitorContext ? { competitor_fetch_failed: true } : {}),
        elapsed_ms: Date.now() - startedAt,
        ...(partialMessage ? { partial_message: partialMessage } : {}),
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

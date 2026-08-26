import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { jsonrepair } from 'jsonrepair';
import { askAI, askAIStream, isRateLimited, generatePageImages, generateAndUploadImage, AIResponseTruncatedError, isPromptTooLongError, userFacingAIErrorMessage, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import { remainingInputChars } from '@/lib/ai-context-budget';
import { repairSlMarkers, markerCoverage, markerQuality } from '@/lib/ai-sl-markers';
import { analyzePageLayout, countLayoutElements } from '@/lib/ai-page-layout';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan, resolveWorkspaceOwner } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { checkAiAllowance, type UsageContext } from '@/lib/ai-usage';
import { reportAiOverageUsage } from '@/lib/ai-overage-billing';
import { extractUrls, isEmbedAssetUrl, scrapeCompetitorUrl, fetchLogoAssets, fetchContentImageAssets } from '@/lib/ai-competitor-scrape';
import { classifyAssetSource } from '@/lib/asset-source-resolver';
import { buildHtmlFromSchema } from '@/lib/ai-page-builder';
import { resolveSkills } from '@/lib/skills';
import { loadPageSkills } from '@/lib/skills/persistence';
import { isStyleTag } from '@/lib/ai-page-exemplars';
import { buildFontFollowUpBlock } from '@/lib/ai-page-fonts';
import { createSSEStream, sendSSE, closeSSE, SSE_HEADERS, type SSEEvent } from '@/lib/sse';
import { isTestVariantPage, getLinkedVariant } from '@/lib/page-drafts';
import { rescanVariantHtml } from '@/lib/services/scan';
import { extractDataUris, restoreDataUris, restoreDataUrisInValue } from '@/lib/data-uri-strip';
import {
  planMultiIntentEdit,
  verifyScopedPatchIntent,
  verifyAskApplied,
  judgeUnrequestedLoss,
  extractDesignReferenceCopy,
  placeRestoredImagesIntelligently,
} from '@/lib/ai-follow-up-helpers';
import {
  injectBrandAssetsIntoSchema,
  forceEmbedLogoInHtml,
  forceEmbedLogoIntoSections,
  forceEmbedFooterContactInHtml,
  materializeLogoUrl,
  extractPrimaryLogoUrlFromHtml,
  extractLogoUrlFromSection,
  extractInlineLogoSvg,
  sectionHasLogoAsset,
  classifyCompetitorReferenceUrl,
} from '@/lib/ai-brand-assets';
import {
  extractPrimaryHeadlineFromHtml,
  extractPrimaryImageFromSection,
  forcePlaceTextIntoSections,
  resolveSourceSectionName,
  sectionHasText,
} from '@/lib/ai-content-placement';
import {
  buildConversationContext,
  classifyEditIntent,
  imageRolesFromIntent,
  MAX_ATTACHMENTS,
  MAX_EARLIER_ATTACHMENTS,
  attachedImagesInstructionNote,
  resolveEditRegion,
  resolveInsertPlacement,
  resolveSectionOrder,
  resolveSectionsForAsk,
  type AttachmentRole,
  type EarlierAttachment,
} from '@/lib/ai-edit-intent';
import { ensureClickToEditFields } from '@/lib/ai-data-field-stamp';
import { verifyAndRehostHtmlImages, applyRehostMap } from '@/lib/ai-asset-integrity';
import { measureAssetPlacement, describeAssetPlacement } from '@/lib/asset-placement';
import {
  findUnrequestedLosses,
  hasLosses,
  describeLosses,
  restoreDamagedSections,
  restoreLostImagesInPlace,
  splitLossesByRegion,
  sectionsContainingAsset,
  snapshotPageFacts,
  type PageLosses,
} from '@/lib/ai-page-preservation';
import {
  assetRequirements,
  enforceRequirements,
  checkRequirements,
  describeUnmet,
  retryInstructionFor,
  parseModelRequirements,
  mergeRequirements,
  REQUIREMENT_EXTRACTION_INSTRUCTION,
  type PageRequirement,
} from '@/lib/ai-page-requirements';

/**
 * Ceiling on the link-imported asset list shown to the model, counting both
 * this turn's imports and ones carried forward from earlier turns.
 *
 * Same number the create path uses (generate/route.ts), so a folder that
 * survived intact into the first build does not get trimmed on the first edit.
 */
const MAX_LIBRARY_ASSETS = 20;

export const dynamic = 'force-dynamic';
// Large full-page rewrites can run several minutes; raised well past the old
// 300s cutoff (capped by the hosting plan's real limit).
export const maxDuration = 800;

const FONT_FOLLOWUP_BLOCK = buildFontFollowUpBlock();

/**
 * The sentence(s) the editing model wrote for the user, cleaned for a chat
 * bubble. Returns null when the model wrote nothing usable, which is the
 * caller's cue to fall back to the fixed copy.
 *
 * Line breaks are LOAD-BEARING and must survive: the contract asks for one
 * line per thing the user asked for, so a message about three asks is three
 * lines. Collapsing all whitespace (the obvious way to normalise) would run
 * them into one paragraph and undo that. Spaces within a line are still
 * normalised, blank lines dropped, and the whole thing capped — at 8 lines,
 * since MAX asks per message is 6 plus room for a couldn't-do line or two,
 * and at a length that fits a chat bubble.
 *
 * Shared by the region rewrite and the full-page rewrite so both paths speak
 * to the user through exactly one implementation.
 */
function normalizeEditorMessage(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
          .split(/\r?\n/)
          .map((line) => line.replace(/[ \t]+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 8)
          .join('\n')
      : '';
  return raw.length >= 3 ? raw.slice(0, 1200) : null;
}

const SYSTEM_PROMPT = `You are editing an existing landing page. The user will give you an instruction to modify the page.

## Your job
1. Classify the change into one of three types:
   - structural: adds, removes, or reorders sections (the schema changes)
   - patch: changes text copy, colors, fonts, spacing, button labels, or styles within 1–3 existing sections (schema shape stays the same, HTML has <!-- SL: --> markers)
   - style: same as patch but touches 4+ sections, or the HTML has no <!-- SL: --> markers

2. Return JSON only. No explanation, no markdown fences, no extra text.

## Output shapes

Structural change — return schema only, NO html field:
{"thinking":"One sentence describing what you are about to do","message":"...what you changed, for the user...","type":"structural","schema_json":{...updated full schema...}}

Localized patch — use ONLY when the HTML contains <!-- SL:name --> markers AND the change touches 1–3 existing sections:
{"thinking":"One sentence describing what you are about to change","message":"...what you changed, for the user...","type":"patch","sections":[{"name":"hero","html":"<section class=\"hero\">...complete updated section HTML...</section>"},{"name":"head","html":"<style>:root{--accent:#0000ff;...all other variables unchanged...}</style>"}]}

Full HTML rewrite — use when patch is not applicable (no SL markers, or 4+ sections change):
{"thinking":"One sentence describing what you are about to change","message":"...what you changed, for the user...","type":"style","html":"<!DOCTYPE html>...complete updated HTML with SL markers..."}

The "thinking" field must always be FIRST in the object so it appears immediately in the stream.

## "message" — always required
This is the only thing the user reads in the chat once the edit lands. Without it they get a fixed line we wrote in advance ("Done! The page has been updated.") no matter what you did, so write it every time.

"thinking" and "message" are NOT the same field. "thinking" is a live status shown while you work — what you are about to do. "message" is what the user is left with afterwards: past tense, describing the result.

Put "message" SECOND, right after "thinking" and before the payload. A full rewrite can be very long, and a field at the end of it can be cut off before it arrives.

ONE LINE PER THING THE USER ASKED FOR — separate lines with \\n. One ask, one line. Three asks, three lines.

Count ASKS, not edits. This matters most here, because this path rewrites large parts of the page at once: "redesign the whole page" is ONE ask, so it gets ONE line describing the result — never a list of every section you rewrote. But "redesign the page and make the logo bigger" is TWO asks and gets two lines.

Plain language, past tense, naming what changed on THEIR page:
"Redesigned the page around the layout in your reference — new hero, tighter spacing, and a single accent colour throughout.\\nMade the logo about 30% larger."

Say what did NOT happen, in its own line, whenever part of the request could not be carried out — a thing you could not find, an image you could not read, an ask the page has no room for. A silently dropped ask is the worst outcome here, because the user reads a confident message and believes all of it landed.

Not "Done", not "I have updated the page as requested", not a list of the rules you followed. Never mention section names as internal identifiers if the user would not recognise them, never mention data-field, markers, or JSON. Keep it to one short line each — this is a chat reply, not a report.

## Classification bias — default to patch
patch is dramatically faster than style (it touches only the sections that changed instead of regenerating the entire document) and is the correct choice for the vast majority of edit requests. Do not use type:style just because it feels safer or more thorough — that's the wrong tradeoff and it's slow.
If the HTML has SL markers and the instruction clearly targets a specific existing element or section (a form, a button, a headline, a card, one section's spacing/sizing/color), that is a patch — even if you're not 100% sure which single marker it falls under, pick the SL section that visibly contains that element and patch it. Reach for style only when the instruction genuinely can't be scoped to 1–3 sections (a full redesign, a site-wide rework touching 4+ sections, or the HTML truly has no SL markers at all).
Example: instruction "make the form smaller so it's not massive on desktop and mobile, and make sure it's responsive" against HTML where the form lives inside <!-- SL:popup -->...<!-- /SL:popup --> → type:patch, sections:[{"name":"popup","html":"...resized form markup..."}]. This is NOT a style-level change even though it affects both desktop and mobile — responsive behavior is CSS within that one section.

## Structural rules (type:structural only) — CRITICAL
Every key in schema_json that is not part of what the instruction asked you to change must be
copied through byte-for-byte identical to the current schema shown to you — same value, same
nesting, same order. Do not regenerate, reword, rephrase, "clean up," or invent a new value for
any field outside the actual edit, even ones you are simply passing through. This applies to
every section, not just the one(s) the instruction is about — a request that only concerns the
hero must leave footer, nav, testimonials, and every other key exactly as given.
If you cannot recall or reconstruct a field's exact original value with full confidence, copy it
verbatim from the "Current schema" block above rather than writing a plausible-looking
replacement — a paraphrased or invented value in an untouched field is a bug, even if it reads
fine on its own.
Watch for cross-contamination: a vendor/provider name, domain, or id sitting in one field (e.g.
a video field's "mux" id or a "player.mux.com" URL) must never leak into an unrelated untouched
field elsewhere in the schema (e.g. footer.copyright becoming "© Mux, Inc.") — that field's
correct value is whatever was already there, not something inspired by nearby text.

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

${FONT_FOLLOWUP_BLOCK}

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

// isSimpleTextRewritePrompt (deleted): a keyword test that decided a request was
// "just a copy rewrite" and took a shortcut path. It marked the edit applied
// after handling only the text, so "change the headline to X and make it bigger"
// silently shipped without the resize. The classifier decides this now — see
// surgicalEligible at the call site.

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

// Used only when classifyEditIntent() decides a message is a pure question
// (is_question: true, asks: []) — no page change happens on this turn, so this
// call must never claim we already did or will automatically do something we
// don't actually support. Keep this list accurate as features ship; an AI that
// confidently promises a capability we don't have is worse than one that says
// "not yet, but I can note it for later."
const FOLLOW_UP_QUESTION_SYSTEM = `You are the chat assistant for SplitLab's AI landing-page builder, answering a question about the product — not editing the page on this turn. Reply in plain text, short paragraphs or a tight list when it genuinely helps scanability, no heavy markdown headers. Be warm and direct, like a helpful teammate, not a formal support script.

You are always given the current page's real HTML below — read it. When asked to judge or review something ("is our FAQ good?", "is the hero good enough?"), answer concretely from the ACTUAL content and structure you can see in that HTML: the real copy, whether a section exists, how it's built (e.g. accordion markup vs a flat list), CTA text and placement. Never say "I don't have access" or ask for a screenshot just to answer a content/structure question — you already have the markup, so use it.

What you genuinely cannot judge from HTML alone is anything purely visual/rendered — actual spacing, overlap, whether a font loaded, colors as displayed. If the question depends on that and no image is attached, say so plainly and specifically ("I can see the FAQ has 6 questions in an accordion — can't tell from the markup whether the spacing looks cramped though, a screenshot would confirm that") rather than refusing to answer at all.

If an image is attached, you CAN see it too — usually a screenshot of the user's own current page. Look at it and give a concrete critique of what you see (layout balance, broken characters/icons rendering as boxes, copy wrapping awkwardly, visual hierarchy) on top of what the HTML tells you. Never claim you cannot see an attached image.

What this builder can actually do right now, so you never overpromise:
- Edit any existing section: restyle, recolor, resize, rewrite copy, fix spacing/alignment, replace an image.
- Add brand-new sections, remove sections, reorder sections.
- Match a look from an attached screenshot or a reference site (design_reference), and fetch a real logo or content photos from a given site URL.
- Generate real photography for sections via AI image generation.
- Import the client's own images from a link — a public Google Drive folder, an S3/public bucket, a direct image URL, or any web page — using the link button next to the chat box. The files are re-hosted by SplitLab and can then be placed on the page. Never tell a user you have no way to pull from Google Drive or a bucket; you do.
- Use images imported earlier in this same conversation. If the user supplied files on a previous turn, they are listed for you by filename and URL and are still usable — do not claim they are gone or ask for a re-upload.
- Every form submission on a live page is automatically captured into SplitLab's own Leads for that test — no setup needed. Workspace-level integrations (HubSpot, email notification, or a webhook to a third-party URL) can be turned on per test in the workspace's Integrations settings, and any lead captured there gets forwarded automatically.
- What it CANNOT do yet: wire an arbitrary custom submission endpoint directly into the page's own code from a chat instruction (forms don't POST anywhere on their own — delivery goes through the Leads/Integrations path above instead). No built-in confirmation-email-on-submit beyond what the email integration sends.

If asked something outside this list, say so plainly rather than guessing. If the message is just a greeting or small talk, respond warmly and briefly, and you may offer to help with something concrete — but don't invent unrequested tasks.`;

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
  // No keyword gate: the caller decides eligibility from the classifier. This
  // path is self-limiting anyway — it only proceeds when the prompt contains
  // copy that literally exists in exactly one section, which is a fact about
  // the page rather than a guess about the wording.
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
      // Sized for Haiku, which had no thinking overhead. Every call here runs
      // on Sonnet 5, whose adaptive thinking is billed against this same
      // ceiling BEFORE the answer starts — so a small budget can be spent
      // entirely on thinking and truncate the response. Truncation here fails
      // silently (see the catch below), so the loss is invisible. Costs
      // nothing: Anthropic bills output actually generated, not this ceiling.
      maxTokens: 32000,
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
- "style": the instruction touches 4+ unrelated sections, or a global CSS/font/color variable change (route this to the "head" section), or you cannot map it to specific sections from the previews given (e.g. "make the whole page feel more premium"). Recoloring logos "everywhere" / "all logos" is NOT style/head — it is a "patch" on every section that currently shows a logo (typically nav, footer, and hero).
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
  routing: RoutingResult,
  hasUserImages: boolean,
  intentSections: string[],
): boolean {
  if (!hasUserImages) return false;
  const targets = routing.target_sections ?? [];
  if (targets.length !== 1) return false;
  // Section NAMES are facts about the page, not a guess about the user's words.
  if (!/^faq/i.test(targets[0])) return false;
  // The keyword list that used to sit here ("question", "form", "dropdown"…)
  // is gone. The real signal is two model passes disagreeing about where this
  // belongs: the router says FAQ, the classifier says somewhere else. That is
  // genuine ambiguity, and worth one question.
  return intentSections.length > 0 && !intentSections.includes(targets[0]);
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
  imageRoleByUrl?: Map<string, AttachmentRole>,
): Promise<string | null> {
  try {
    const imageUrlsNote = attachedImagesInstructionNote(imageUrls ?? [], imageRoleByUrl);
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
  imageRoleByUrl?: Map<string, AttachmentRole>,
): Promise<{ html: string | null; failedSanity: boolean; failedParse: boolean }> {
  const requiredTag = outerTag(sectionHtml);

  const first = await runScopedPatch(sectionHtml, schemaSlice, prompt, imageUrls, undefined, usage, imageRoleByUrl);
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

  const second = await runScopedPatch(sectionHtml, schemaSlice, prompt, imageUrls, correction, usage, imageRoleByUrl);
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

{"name":"kebab-case-section-name","html":"...complete new section HTML, a single top-level element...","image_prompts":[{"slot":"SL_IMG_1","prompt":"..."}]}

Rules:
- Match the page's existing visual design system as closely as possible — reuse existing CSS custom properties/:root variables, existing class names, and existing font/color choices where they fit, rather than inventing an unrelated new look.
- If new CSS is genuinely needed for this section, add a small scoped <style> block inside the section itself (or inline styles) — never modify the page's shared/global stylesheet.
- The new section must be a single top-level element (e.g. one <section>...</section>). Do NOT include <!-- SL:name --> markers yourself — the caller adds those around whatever you return.
- Give every editable text/image element in the new section a data-field attribute, using the dot-path pattern "<name>.<field>" where <name> matches the "name" you return, e.g. data-field="pricing-tiers.title", data-field="pricing-tiers.items.0.price". Repeated items use indexed keys: .items.0, .items.1, ...
- "name" must be a short, unique, kebab-case identifier describing the section (e.g. "pricing-tiers", "faq"), and must not collide with any of the page's existing section names given below.
- Never select or modify any element outside the new section.
- Never add an external <script src> to a third-party domain.
- IMAGES: if the section needs photos, do NOT leave empty boxes and do NOT invent an image URL. Put src="SL_IMG_1", src="SL_IMG_2", … on those <img> tags and add one entry per slot to "image_prompts" — the caller generates each image and swaps the real URL in. A section built from a reference screenshot of a photo gallery MUST use these slots; shipping captioned empty rectangles is a failure. Max 6 slots.
- Each "prompt" is sent to an image model with NO other context, so it must stand alone and be fully specific (subject, setting, lighting, style). Never reference "the attached image" or "the same style as above".
- Attached images are SHOWN to you so you can understand the ask. Embed an attached URL in src ONLY when the user wants that picture itself on the page. Never embed a screenshot of the page as content.
- If any copy in your output contains a double-quote character, escape it as \\" — invalid JSON breaks the parser.`;

async function runScopedInsert(
  anchorSectionHtml: string,
  headSectionHtml: string,
  existingSectionNames: string[],
  prompt: string,
  imageUrls: string[] | undefined,
  /** Storage prefix for any images this section needs generated. */
  pageSlug: string | null,
  imageRoleByUrl?: Map<string, AttachmentRole>,
): Promise<{ name: string; html: string } | null> {
  try {
    // Defensive cap — this is a small, scoped call (writing one section, not
    // rebuilding the page), but a legacy page's global stylesheet can still be
    // enormous; truncate rather than let one page blow up this call's cost.
    const truncatedHead = headSectionHtml.length > 20_000
      ? `${headSectionHtml.slice(0, 20_000)}\n/* ...truncated... */`
      : headSectionHtml;
    const imageUrlsNote = attachedImagesInstructionNote(imageUrls ?? [], imageRoleByUrl);
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
    let parsed: { name?: string; html?: string; image_prompts?: unknown };
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
    // Fill the SL_IMG_n slots with real generated images.
    //
    // Without this a new section could only ever contain empty image boxes: the
    // full-page builder has always been able to say "generate a photo here",
    // and this path never could. A user who asked for a section like a
    // photo-gallery screenshot got six captioned blank rectangles, because the
    // model correctly refused to paste the reference screenshot in as content
    // and had no other way to produce a picture.
    let html = parsed.html;
    const slots = Array.isArray(parsed.image_prompts) ? parsed.image_prompts.slice(0, 6) : [];
    if (slots.length > 0 && pageSlug) {
      const generated = await Promise.all(
        slots.map(async (entry) => {
          const rec = entry as Record<string, unknown>;
          const slot = typeof rec.slot === 'string' ? rec.slot.trim() : '';
          const imagePrompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : '';
          if (!slot || !imagePrompt || !html.includes(slot)) return null;
          const url = await generateAndUploadImage(imagePrompt, pageSlug, 'high');
          return url ? { slot, url } : null;
        }),
      );
      for (const hit of generated) {
        if (!hit) continue;
        html = html.split(hit.slot).join(hit.url);
      }
      const unfilled = slots.filter((entry) => {
        const slot = (entry as Record<string, unknown>).slot;
        return typeof slot === 'string' && html.includes(slot);
      }).length;
      console.log('[pages/follow-up] scoped insert images', {
        requested: slots.length,
        filled: generated.filter(Boolean).length,
        unfilled,
      });
      // Never ship a literal SL_IMG_1 as a src — drop those <img> tags so the
      // section degrades to a clean layout instead of a broken-image icon.
      if (unfilled > 0) {
        html = html.replace(/<img\b[^>]*\bsrc=["']SL_IMG_\d+["'][^>]*>/gi, '');
      }
    }

    return { name: dedupeSectionName(safeName, existingSectionNames), html };
  } catch (err) {
    console.error('[pages/follow-up] scoped insert generation failed, falling back to full-page path', err);
    return null;
  }
}

// ── Region rewrite — the general hand, for anything the fast verbs can't do ──
//
// Every other scoped operation here is a fixed verb: patch one section, insert
// one, remove one, move some. The model's vocabulary is not fixed, so a request
// outside that list ("swap these two", "split this section in half", "merge
// these", "wrap these in a container", "turn these three into tabs") had
// nowhere to go — and the executor did not stop, it degraded to the nearest
// verb it owned, rewriting a single section in place and reporting success.
//
// This verb takes a contiguous RUN of sections and replaces it with whatever
// the model returns for that run: any number of sections, in any order, with
// any names. That expresses every structural change there is, so no new verb is
// ever needed. It stays safe for the same reason the narrow verbs are safe —
// everything outside the run is untouched byte-for-byte, and the caller's loss
// checks still run over the result.
/**
 * Room reserved for the rewrite reply. Shared with the context budget below:
 * whatever the answer may need, the question cannot also spend.
 */
const REGION_REWRITE_MAX_TOKENS = 128_000;

/**
 * How many sections one requirement-retry pass may re-patch. Each is a
 * sequential model call inside an already-open SSE response, so this is a
 * latency budget, not a quality knob: better to fix the first few and name the
 * rest than to hang the stream until a proxy kills it.
 */
const REQUIREMENT_RETRY_SECTION_CAP = 3;

const SCOPED_REGION_SYSTEM_PROMPT = `You are rewriting ONE CONTIGUOUS RUN of sections of an existing, already-designed landing page. You are given the page's global <style> block (for colors, fonts, spacing, existing CSS classes/variables) and the current HTML of every section in the run. Nothing outside the run exists for you — do not refer to it, do not return it.

IMPORTANT: Your entire response must be ONLY the JSON object below — begin your response with { and end it with }. Do NOT write any explanation, reasoning, preamble, or markdown code fences before or after the JSON. Any text outside the JSON object will break the parser.

{"message":"...one sentence to the user...","sections":[{"name":"kebab-case-section-name","html":"...complete section HTML, a single top-level element..."}],"deleted":["section-name-to-remove"],"image_prompts":[{"slot":"SL_IMG_1","prompt":"..."}]}

## "message" — always required
This is the only thing the user reads. Without it they get a fixed line we wrote in advance ("Done! The page has been updated.") no matter what you did, so write it every time, even on a routine edit.

ONE LINE PER THING THE USER ASKED FOR — separate lines with \\n. One ask, one line. Three asks, three lines. A single message often asks for several things at once ("make the logo bigger, remove the FAQ, and make the hero button red"), and squeezing those into one sentence means some of them go unreported: the user then has no idea which of their asks actually happened.

Count ASKS, not edits. One ask that required you to touch six sections is still ONE line — the user asked for one thing, so describe the one result, not the six places you touched it. Report an edit you made that was not asked for only when it was needed to carry out an ask.

Plain language, past tense, naming what changed on THEIR page:
"Made the footer logo about 30% larger.\\nRemoved the FAQ section.\\nChanged the hero button to red."

Say what did NOT happen, in its own line, whenever part of the request could not be carried out — a thing you could not find, an image you could not read, an ask the page has no room for. A silently dropped ask is the worst outcome here, because the user reads a confident message and believes all of it landed: "I couldn't find a testimonials section to remove." Same for anything you changed that was not literally asked for because the ask required it — say so.

Not "Done", not "I have updated the section as requested", not a list of the rules you followed. Never mention section names as internal identifiers if the user would not recognise them, never mention data-field, markers, or JSON. Keep it to one short line each — this is a chat reply, not a report.

## Silence means KEEP
Return in "sections" ONLY the sections you changed or added. Any section in the run you do not mention is kept exactly as it is — you do not need to repeat it, and leaving it out never removes it.

To REMOVE a section, put its name in "deleted". That is the only way a section comes off the page. Never rely on omitting it.

If you are reordering, list every section of the run in "sections" in the new order (unchanged ones can keep their current HTML verbatim) — order is only read from what you return.

## When you genuinely cannot tell what was asked
Instead of the object above, reply with ONLY:

{"question":"...one short question, in plain language..."}

This is YOUR call and yours alone — nothing else in this system decides whether the user gets asked. Use it when the instruction has two or more real readings and picking the wrong one would destroy or replace work the user did not want touched: "make this bigger" with three candidates in the run, "put it here" with no way to tell which element "it" is, an attached screenshot whose relevance you cannot place.

Do NOT ask when:
- you can see what is meant, even roughly — a reasonable edit beats a question
- the ask is vague about STYLE rather than TARGET ("make it feel more premium", "cleaner", "more modern"). Vague taste is your judgement to exercise, not an ambiguity. Decide and build.
- the user already answered a question of ours, told you to decide, or said not to ask
- you would only be asking permission ("shall I change the heading too?") — just make the smallest correct edit

Name real things from the page in the question ("the pricing heading, or the one above the form?"), never internal identifiers. One question, no preamble, no list of options longer than two or three.

## When there is genuinely nothing to change
Instead of the object above, reply with ONLY:

{"no_change":"...one short sentence saying why nothing was changed..."}

Use this when you understood the request and deliberately decided no edit is needed — the page already reads that way, the change was already made in an earlier turn, or the thing you were asked to copy cannot be read in the attached image. Write the sentence for the USER, in plain language, naming what is already there ("The hero already carries that subheadline: 'Deduct up to 80%…'"). If the reason is that you cannot read the image, say that plainly instead.

An empty "sections" array is NOT how you say this. {"sections":[]} tells the system your rewrite failed, and the user is then told we could not work out what they meant — which is false, and blames them for your decision. If you are changing nothing, say so here.

Rules for the sections object:
- You may return sections rewritten, brand new ones (splitting or adding), or the whole run reordered. Merging two sections into one means returning the merged section AND listing the absorbed name in "deleted".
- KEEP A SECTION'S EXISTING NAME whenever that section survives in recognisable form, even if you moved it or restyled it. Only invent a new kebab-case name for a section that genuinely did not exist before. Names must be unique.
- Do NOT include <!-- SL:name --> markers yourself — the caller wraps each section you return.
- Change ONLY what the instruction asks for. Every section in this run is being replaced by what you return, so anything you fail to carry across is destroyed: copy, images, links and layout you were not asked to touch must come back unchanged.
- Preserve every data-field attribute on content you carry across — they drive the page's click-to-edit, and dropping one silently takes away the user's ability to edit that text. Give any genuinely new element a data-field too, using "<name>.<field>" dot-paths matching the section's name.
- Match the page's existing visual design system — reuse the existing CSS custom properties/:root variables, class names, fonts and colors rather than inventing a new look. If new CSS is genuinely needed, add a small scoped <style> block inside the section itself; never modify the page's shared stylesheet.
- Each section must be a single top-level element (e.g. one <section>...</section>).
- Never add an external <script src> to a third-party domain.
- IMAGES: keep existing page image URLs exactly as they are unless the instruction asks to change them. Attached images are SHOWN to you so you can understand the ask — a crop of the page ("this section", an arrow, "here"), a design to match, a bug, or a photo/logo to put ON the page. Read the instruction to tell which. Embed an attached URL in src ONLY when the user wants that picture itself on the page (a logo, a headshot, a product photo). Never embed a screenshot of the page, a mock, or a "this is the bit I mean" crop — those are pointers or looks to copy, not assets. If the instruction requires a NEW photo that does not exist yet, put src="SL_IMG_1" (etc) and add image_prompts; the caller generates those. Max 6 slots. Each prompt must stand alone and must never say "the attached image".
- If any copy in your output contains a double-quote character, escape it as \\" — invalid JSON breaks the parser.`;

/**
 * Why a rewrite could not act.
 *
 * All three used to collapse into `null`, and the caller said the same thing
 * every time: "Name the section and what should change." That is useful advice
 * for exactly one of them. For a payload that was too large it is misleading —
 * renaming sections does nothing — and for a provider blip it is wrong. Losing
 * the reason turns a specific, fixable failure into a vague one.
 */
/**
 * ── DECISION: who writes the words the user reads ────────────────────────────
 *
 * The model's own words for everything the model actually said. Canned text
 * ONLY where the model never spoke.
 *
 * Everything a user read used to be written here, in advance: one fixed
 * "Done! The page has been updated." for every success, and three fixed
 * sentences for every failure. The model did the thinking and we did all the
 * talking, which is why the product read like a script instead of an
 * assistant — and why a deliberate no-op came out as "I couldn't work out what
 * to change. Name the section", blaming the user's wording for a decision the
 * model had made on purpose.
 *
 * So the rewrite contract now carries a required `message` (see
 * SCOPED_REGION_SYSTEM_PROMPT), plus `no_change` and `question` — three ways
 * for it to speak, covering every outcome it can reach. Those are shown
 * verbatim.
 *
 * This function is the deliberate exception, and it stays hardcoded because
 * there is nothing else it COULD be. Its three reasons are the cases where no
 * model text exists to show:
 *   • 'provider'  — the reply was unparseable, or the call threw. No words.
 *   • 'too_long'  — the request never reached the model. No words.
 *   • 'unusable'  — the reply was malformed past rescuing. No words.
 * A well-formed reply that changed nothing is NOT here: it returns `no_change`
 * and the model's own sentence goes out instead.
 *
 * The only way to make these three "intelligent" is a second AI call to
 * narrate the failure. Rejected on purpose: it spends money and adds latency
 * exactly on a turn that has already failed, and these three sentences are
 * specific and actionable as written. Do not add that call without a reason
 * better than "it would sound smarter".
 */
/**
 * What the user is told, per reason.
 *
 * One message used to cover all three, and it was "Name the section and what
 * should change." That is good advice for exactly one of them. Told to someone
 * whose request was simply too large for one call, it sends them to rename
 * sections that were never the problem — they retry the same thing, it fails
 * the same way, and the product looks broken rather than busy.
 */
function regionFailureMessage(reason: RegionFailReason): string {
  switch (reason) {
    case 'too_long':
      // Name the cause, not just the remedy. "Try one at a time" on its own
      // reads like the request was badly worded, so people rephrase it and hit
      // the same wall. Saying the page is long makes the retry obvious and
      // makes it clear nothing about their wording was wrong.
      return "This page is too large to change several sections at once. Ask for one change at a time and each will go through — your page hasn't been altered.";
    case 'provider':
      return 'Something went wrong while applying that — the AI service returned a bad response. Please try again.';
    case 'unusable':
      return "I couldn't work out what to change. Name the section (nav, hero, footer, …) and what should happen to it.";
  }
}

type RegionFailReason =
  /** The call exceeded the model's context window. Ask for less at once. */
  | 'too_long'
  /** The provider errored, or returned something unparseable. Retrying helps. */
  | 'provider'
  /** It ran fine and produced nothing usable. The instruction is the problem. */
  | 'unusable';

/** Byte range covering a whole run of sections, first marker to last marker. */
function findSlRegionBounds(html: string, startName: string, endName: string): [number, number] | null {
  const startBounds = findSlBlockBounds(html, startName);
  const endBounds = findSlBlockBounds(html, endName);
  if (!startBounds || !endBounds) return null;
  const from = Math.min(startBounds[0], endBounds[0]);
  const to = Math.max(startBounds[1], endBounds[1]);
  return to > from ? [from, to] : null;
}

async function runRegionRewrite(opts: {
  regionHtml: string;
  headSectionHtml: string;
  /** Section names elsewhere on the page — new names must not collide. */
  outsideNames: string[];
  /**
   * Everything OUTSIDE the run — the rest of the page as read-only context,
   * plus an index of the images it contains.
   *
   * "Put the image of the hero section here as well" is unanswerable without
   * this: when the run is just the about section, the hero's HTML was never in
   * the payload, so the hero's image URL did not exist as far as this call was
   * concerned. The only URL it could see was the user's attached screenshot —
   * so it embedded the screenshot, and a crop of the page became the photo.
   *
   * Showing the page is a fact, not a decision, and it is safe now: under
   * "silence keeps" nothing here can be destroyed by being seen.
   */
  outsideAssets?: string;
  prompt: string;
  imageUrls?: string[];
  pageSlug: string | null;
  /**
   * The user is answering a question we already asked, or told us to decide.
   * Asking again would loop. This is the ONLY thing that suppresses a question,
   * and it is a fact about the conversation, not a judgement about the ask.
   */
  noQuestions?: boolean;
  /**
   * The step that picks WHICH sections to send said it could not tell, so the
   * whole page was sent instead. Passed on as a fact, not acted on here: this
   * call can see the page and the ask, so it is the one that should decide
   * whether that means "ask the user" or "I can see it, get on with it".
   */
  regionUnresolved?: boolean;
  /** Recent turns — context only, never re-done. */
  conversation?: string;
  imageRoleByUrl?: Map<string, AttachmentRole>;
}): Promise<
  | {
      kind: 'sections';
      sections: Array<{ name: string; html: string }>;
      /** Names the model explicitly asked to remove. Omission never deletes. */
      deleted: string[];
      /** The model's own one-line account of what it did. Null if it wrote none. */
      message: string | null;
    }
  | { kind: 'question'; question: string }
  /**
   * The model understood the ask and deliberately changed nothing — the page
   * already reads that way, or it could not read what it was asked to copy.
   * NOT a failure: the reason is written for the user and shown verbatim.
   */
  | { kind: 'no_change'; reason: string }
  | { kind: 'failed'; reason: RegionFailReason }
> {
  try {
    const truncatedHead = opts.headSectionHtml.length > 20_000
      ? `${opts.headSectionHtml.slice(0, 20_000)}\n/* ...truncated... */`
      : opts.headSectionHtml;
    const imageUrlsNote = attachedImagesInstructionNote(opts.imageUrls ?? [], opts.imageRoleByUrl);
    const userContent: AIContent = [
      ...(opts.imageUrls ?? []).map((url): AIContentBlock => ({ type: 'image', url })),
      {
        type: 'text' as const,
        text: `${opts.conversation ? `${opts.conversation}\n\n` : ''}Section names used elsewhere on the page (any NEW name must not match these): ${opts.outsideNames.join(', ') || '(none)'}\n${opts.outsideAssets ? `\n${opts.outsideAssets}\n` : ''}\nPage's global styles:\n${truncatedHead}\n\nThe run of sections to rewrite, in page order, with their markers:\n${opts.regionHtml}\n\nInstruction: ${opts.prompt}${imageUrlsNote}${
          opts.noQuestions
            ? '\n\n(This message is the user answering a question we already asked, or telling us to decide for them. Do NOT reply with {"question"} — make your best call and rewrite the sections.)'
            : opts.regionUnresolved
              ? '\n\n(Note: an earlier step could not work out which part of the page this instruction is about, so you have been given EVERY section rather than a narrow run. If you can see what is meant, change just those sections and say nothing about the others — unmentioned sections are kept. If you also cannot tell which part they mean, reply with {"question"} rather than guessing.)'
              : ''
        }`,
      },
    ];
    // Streamed, not a single blocking call — a broad edit can run several
    // minutes with zero bytes on the wire until the whole response is ready,
    // and a connection that quiet gets killed by network infra in between
    // (confirmed live: repeated ECONNRESET/"terminated" on this exact call).
    // Streaming keeps bytes moving so the connection reads as alive. The
    // chunks themselves are unused — this call's output is JSON parsed only
    // once complete, never shown to the user raw — so a dropped stream is
    // free to restart from scratch like any other transient retry.
    const text = await askAIStream(
      {
        system: SCOPED_REGION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        maxTokens: REGION_REWRITE_MAX_TOKENS,
        label: 'follow-up:region-rewrite',
      },
      () => {},
    );
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) raw = raw.slice(jsonStart, jsonEnd + 1);
    let parsed: {
      sections?: unknown;
      deleted?: unknown;
      image_prompts?: unknown;
      question?: unknown;
      no_change?: unknown;
      message?: unknown;
    };
    try {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = JSON.parse(jsonrepair(raw));
      }
    } catch {
      console.error('[pages/follow-up] region rewrite returned unparseable JSON', {
        rawLength: text.length,
        rawPreview: text.slice(0, 1500),
      });
      return { kind: 'failed', reason: 'provider' };
    }
    // The model chose to ask instead of guessing. Checked BEFORE the sections
    // check so a question is never mistaken for a failed rewrite. Code does not
    // second-guess it: if it asked, the user gets asked.
    if (typeof parsed.question === 'string' && parsed.question.trim()) {
      const question = parsed.question.trim().slice(0, 500);
      console.log('[pages/follow-up] region rewrite asked the user a question', { question });
      return { kind: 'question', question };
    }
    const message = normalizeEditorMessage(parsed.message);

    // "I understood, and nothing needs changing." Checked with the question
    // above, before anything reads `sections` — a deliberate no-op is an
    // answer, not a broken rewrite.
    if (typeof parsed.no_change === 'string' && parsed.no_change.trim()) {
      const reason = parsed.no_change.trim().slice(0, 500);
      console.log('[pages/follow-up] region rewrite reported nothing to change', { reason });
      return { kind: 'no_change', reason };
    }
    const deleted = Array.isArray(parsed.deleted)
      ? parsed.deleted.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
      : [];
    if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
      // Deleting is a real edit on its own — "remove the pricing section" needs
      // no rewritten HTML at all.
      if (deleted.length > 0) return { kind: 'sections', sections: [], deleted, message };
      // A well-formed {"sections":[]} is the model saying it changed nothing.
      // This used to collapse into 'unusable', whose message is "I couldn't
      // work out what to change. Name the section…" — telling the user their
      // wording was the problem when the classifier had already resolved the
      // section, the ask and its requirements, and the rewrite had simply
      // decided there was nothing to do. Reported honestly instead, with the
      // caveat that a model which took this route rather than "no_change"
      // never told us WHY, so the sentence has to stay generic.
      if (Array.isArray(parsed.sections)) {
        console.warn('[pages/follow-up] region rewrite returned an empty sections array — reading as no-change', {
          rawPreview: text.slice(0, 300),
          hasMessage: message !== null,
        });
        // Its own sentence if it wrote one — the fixed line is only for a reply
        // that contained no words at all, where there is nothing to show.
        return {
          kind: 'no_change',
          reason: message ?? "I looked at that and didn't find anything to change on the page.",
        };
      }
      console.error('[pages/follow-up] region rewrite returned no sections', { rawPreview: text.slice(0, 1500) });
      return { kind: 'failed', reason: 'unusable' };
    }

    const taken = [...opts.outsideNames];
    const out: Array<{ name: string; html: string }> = [];
    for (const entry of parsed.sections.slice(0, 12)) {
      const rec = entry as Record<string, unknown>;
      const rawName = typeof rec.name === 'string' ? rec.name : '';
      const sectionHtml = typeof rec.html === 'string' ? rec.html : '';
      const safeName = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!safeName || !sectionHtml.trim() || !outerTag(sectionHtml)) {
        console.error('[pages/follow-up] region rewrite skipped an unusable section', { rawName });
        continue;
      }
      const name = dedupeSectionName(safeName, taken);
      taken.push(name);
      out.push({ name, html: sectionHtml });
    }
    if (out.length === 0 && deleted.length === 0) {
      console.error('[pages/follow-up] region rewrite produced nothing usable');
      return { kind: 'failed', reason: 'unusable' };
    }

    // Same image-slot contract as the insert path, so a rewrite that genuinely
    // needs a new photo can produce one instead of an empty box.
    const slots = Array.isArray(parsed.image_prompts) ? parsed.image_prompts.slice(0, 6) : [];
    if (slots.length > 0 && opts.pageSlug) {
      const generated = await Promise.all(
        slots.map(async (entry) => {
          const rec = entry as Record<string, unknown>;
          const slot = typeof rec.slot === 'string' ? rec.slot.trim() : '';
          const imagePrompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : '';
          if (!slot || !imagePrompt || !out.some((s) => s.html.includes(slot))) return null;
          const url = await generateAndUploadImage(imagePrompt, opts.pageSlug!, 'high');
          return url ? { slot, url } : null;
        }),
      );
      for (const hit of generated) {
        if (!hit) continue;
        for (const s of out) s.html = s.html.split(hit.slot).join(hit.url);
      }
      const unfilled = slots.filter((entry) => {
        const slot = (entry as Record<string, unknown>).slot;
        return typeof slot === 'string' && out.some((s) => s.html.includes(slot));
      }).length;
      console.log('[pages/follow-up] region rewrite images', {
        requested: slots.length,
        filled: generated.filter(Boolean).length,
        unfilled,
      });
      if (unfilled > 0) {
        for (const s of out) {
          s.html = s.html.replace(/<img\b[^>]*\bsrc=["']SL_IMG_\d+["'][^>]*>/gi, '');
        }
      }
    }

    return { kind: 'sections', sections: out, deleted, message };
  } catch (err) {
    const reason: RegionFailReason = isPromptTooLongError(err)
      ? 'too_long'
      : 'provider';
    console.error('[pages/follow-up] region rewrite failed', { reason, err });
    return { kind: 'failed', reason };
  }
}

/**
 * Resolve a region for one instruction, rewrite it, splice it back, and keep
 * the schema in step. Shared by both edit paths — a single-instruction message
 * and a multi-step plan get the same general hand, because "which path did the
 * message take" says nothing about whether the change is expressible.
 *
 * Three outcomes, and they are not interchangeable:
 *   • {kind:'applied'} — the edit landed.
 *   • {kind:'question'} — the MODEL decided it needs to ask the user something.
 *     Not a failure. Callers must surface the question, not retry around it.
 *   • null — it could not act. Callers must record a failure; reporting success
 *     for work that did not happen is the whole bug class.
 */
async function applyRegionRewriteToHtml(opts: {
  html: string;
  instruction: string;
  imageUrls?: string[];
  pageSlug: string | null;
  schema: unknown;
  usage?: UsageContext;
  /** See runRegionRewrite — conversation fact, not a judgement about the ask. */
  noQuestions?: boolean;
  /** Recent turns, so the instruction's "it"/"that"/"also" can be resolved. */
  conversation?: string;
  /**
   * Sections the classifier already worked out this message is about.
   *
   * It had the answer all along — "use the footer's logo in the nav, and the
   * hero's image in the about section" classified cleanly as [nav, about] —
   * and nothing passed it here, so the run was picked from the raw sentence
   * and came back as just `nav`. The about section was never sent, and the
   * model was blamed for skipping an ask it had never been shown.
   */
  focusSections?: string[];
  imageRoleByUrl?: Map<string, AttachmentRole>;
}): Promise<
  | {
      kind: 'applied';
      html: string;
      schema: Record<string, unknown>;
      wrote: string[];
      /**
       * Every section name the rewrite OWNED this turn — the ones it was given
       * plus the ones it produced. Bytes outside these are untouched by the
       * splice, so the damage guard can tell provable damage from the model
       * doing its job. See splitLossesByRegion.
       */
      region: string[];
      /**
       * The model's own account of the edit, shown to the user instead of the
       * fixed "Done! The page has been updated." Null when it wrote none.
       */
      message: string | null;
    }
  | { kind: 'question'; question: string }
  /** Understood, and deliberately nothing to do. See runRegionRewrite. */
  | { kind: 'no_change'; reason: string }
  | { kind: 'failed'; reason: RegionFailReason }
> {
  const live = extractSlSections(opts.html);
  const body = live.filter((s) => s.name !== 'head');
  if (body.length === 0) return { kind: 'failed', reason: 'unusable' };

  // ── Which sections does the model get to REWRITE? ────────────────────────
  //
  // This used to be one contiguous strip of the page, and that single fact
  // caused the worst failure of the night: a message asking for two things in
  // different parts of the page ("the footer's logo on the nav, and the hero's
  // image in the about section") got a strip covering `nav` alone. The about
  // section was never in the payload, so the second ask could not happen — and
  // it looked like the model ignoring an instruction.
  //
  // Sections do not have to be neighbours. Each one has its own markers and is
  // addressable on its own, so the editable set can be scattered. The strip was
  // never a model limitation, only a consequence of splicing one byte range.
  const bodyChars = body.reduce((n, sec) => n + sec.html.length, 0);
  const contextBudget = remainingInputChars({
    usedChars:
      (live.find((sec) => sec.name === 'head')?.html.length ?? 0) +
      (opts.conversation?.length ?? 0) +
      opts.instruction.length,
    reservedOutputTokens: REGION_REWRITE_MAX_TOKENS,
    images: (opts.imageUrls ?? []).length,
  });

  // The classifier's answer first — it read the message and named the sections.
  const focus = (opts.focusSections ?? []).filter((n) => body.some((sec) => sec.name === n));

  // A page that fits gets sent whole: nothing is hidden, every ask is reachable,
  // and we skip a round trip. A page that does not fit has to be triaged, and
  // that is what the resolver is genuinely for.
  let editableNames: string[];
  let regionUnresolved = false;
  if (bodyChars <= contextBudget) {
    // The page fits whole, but "fits" is not "wide open" — the classifier
    // already named which sections this message is about (`focus`), and a
    // narrow ask (align the footer) must not hand the model every other
    // section as editable just because there was room to. Everything else
    // still reaches the model as read-only context below, so nothing named
    // by a later ask goes unseen — it just can't be silently rewritten.
    // Fall back to the whole page only when the classifier found nothing to
    // scope to, same as the over-budget branch below.
    editableNames = focus.length > 0 ? focus : body.map((sec) => sec.name);
  } else {
    const region = await resolveEditRegion({
      instruction: opts.instruction,
      sectionOutline: body.map((sec) => ({ name: sec.name, text: sec.text })),
      imageUrls: opts.imageUrls,
      conversation: opts.conversation,
      usage: opts.usage,
      label: 'follow-up:resolve-region',
    });
    const names = body.map((sec) => sec.name);
    const startAt = region?.start ? names.indexOf(region.start) : -1;
    const endAt = region?.end ? names.indexOf(region.end) : -1;
    const fromResolver =
      startAt >= 0 && endAt >= 0
        ? names.slice(Math.min(startAt, endAt), Math.max(startAt, endAt) + 1)
        : startAt >= 0
          ? [names[startAt]]
          : [];
    // Union, not either-or: the classifier's sections and the resolver's run
    // are two reads of the same message and dropping either one loses an ask.
    editableNames = Array.from(new Set([...focus, ...fromResolver]));
    // Nothing placed it and the page is too big to just send everything.
    regionUnresolved = editableNames.length === 0;
    if (editableNames.length === 0) editableNames = names;
  }

  // Page order, always — the model reads the run top to bottom.
  const editableSet = new Set(editableNames);
  const editableBlocks = body.filter((sec) => editableSet.has(sec.name));
  const regionHtml = editableBlocks
    .map((sec) => `<!-- SL:${sec.name} -->\n${sec.html.trim()}\n<!-- /SL:${sec.name} -->`)
    .join('\n');
  const insideNames = editableBlocks.map((sec) => sec.name);
  console.log('[pages/follow-up] editable scope', {
    editable: insideNames,
    ofSections: body.length,
    bodyChars,
    budgetChars: contextBudget,
    unresolved: regionUnresolved,
  });

  const outsideNames = live.map((s) => s.name).filter((n) => !insideNames.includes(n));

  // What pictures already exist elsewhere on the page, so "use the image that
  // is already in the hero" can be carried out with the real URL instead of
  // whatever URL happens to be to hand.
  const outsideAssetLines: string[] = [];
  for (const sec of live) {
    if (insideNames.includes(sec.name) || sec.name === 'head') continue;
    const urls = new Set<string>();
    for (const m of Array.from(sec.html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi))) {
      if (/^https?:\/\//i.test(m[1])) urls.add(m[1]);
    }
    for (const m of Array.from(
      sec.html.matchAll(/background(?:-image)?\s*:\s*[^;"']*url\(["']?(https?:\/\/[^"')]+)["']?\)/gi),
    )) {
      urls.add(m[1]);
    }
    if (urls.size > 0) outsideAssetLines.push(`- ${sec.name}: ${Array.from(urls).slice(0, 4).join(', ')}`);
  }
  const assetInventory =
    outsideAssetLines.length > 0
      ? 'Images already on the page, by section (use one of these EXACT URLs when the instruction says to reuse a picture that is already on the page — never substitute an attached screenshot for one):\n' +
        outsideAssetLines.slice(0, 12).join('\n')
      : '';

  // ── The rest of the page, as READ-ONLY context ────────────────────────────
  //
  // The rewrite used to receive its run and nothing else, so anything the
  // instruction referred to elsewhere on the page simply did not exist for it.
  // "Use the image that's already in the hero" was unanswerable while editing
  // the about section, and it reached for the only URL it had — the user's
  // attached screenshot — and embedded a picture of the page onto the page.
  //
  // Two things used to make sending more input a bad trade, and only one is
  // still true:
  //   • blast radius — GONE. Under "silence keeps", a section the model does
  //     not mention is carried over as its original bytes, so showing it costs
  //     nothing in risk. This was the real objection and it no longer holds.
  //   • size — still real. Tokens cost money and an oversized call is the
  //     `full_page_too_long` failure. So there is a budget, and past it the
  //     sections degrade to their visible text rather than dropping out.
  //
  // Read-only is stated plainly below: this is here to be UNDERSTOOD, and the
  // run remains the only thing that may be rewritten.
  // The budget is arithmetic, not a guess: the window, minus the room the
  // reply needs, minus everything this call already has to send. A fixed
  // number would be a guess about somebody else's page — too small starves a
  // small page of context it could easily have afforded, too large kills a
  // big one.
  const outsideSections = live.filter((s) => !insideNames.includes(s.name) && s.name !== 'head');
  const fullSize = outsideSections.reduce((n, s) => n + s.html.length, 0);
  const budget = remainingInputChars({
    usedChars:
      regionHtml.length +
      (live.find((s) => s.name === 'head')?.html.length ?? 0) +
      (opts.conversation?.length ?? 0) +
      opts.instruction.length,
    reservedOutputTokens: REGION_REWRITE_MAX_TOKENS,
    images: (opts.imageUrls ?? []).length,
  });
  const withinBudget = fullSize <= budget;
  const outsideBody = outsideSections
    .map((s) =>
      withinBudget
        ? s.html
        : `<!-- SL:${s.name} --> (summary) ${s.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
    )
    .join('\n');
  console.log('[pages/follow-up] region context', {
    outsideSections: outsideSections.length,
    outsideChars: fullSize,
    budgetChars: budget,
    mode: withinBudget ? 'full-html' : 'summarised',
  });

  const outsideAssets =
    [
      outsideSections.length > 0
        ? `THE REST OF THE PAGE — READ ONLY. You are not rewriting any of this and must not return any of it. It is here so you can see what the page already has: existing images and their URLs, the copy, the classes and the styling to stay consistent with.${
            withinBudget ? '' : ' (Shortened to visible text — this page is large.)'
          }\n${outsideBody}`
        : '',
      assetInventory,
    ]
      .filter(Boolean)
      .join('\n\n') || undefined;

  const result = await runRegionRewrite({
    regionHtml,
    outsideAssets,
    headSectionHtml: live.find((s) => s.name === 'head')?.html ?? '',
    outsideNames,
    prompt: opts.instruction,
    imageUrls: opts.imageUrls,
    pageSlug: opts.pageSlug,
    noQuestions: opts.noQuestions,
    regionUnresolved,
    conversation: opts.conversation,
    imageRoleByUrl: opts.imageRoleByUrl,
  });
  if (result.kind === 'failed') return result;
  // Pass the model's question straight through. Wrapping it in a retry or
  // downgrading it to null would be code overruling the one call that read
  // both the page and the ask.
  if (result.kind === 'question') return result;
  // Same rule for "nothing to change": the call that read the page and the ask
  // is the one entitled to that verdict. Re-running it as a failure would put
  // back the wrong-and-blaming error this replaced.
  if (result.kind === 'no_change') return result;
  const rewritten = result.sections;
  const deleted = result.deleted;
  if (rewritten.length === 0 && deleted.length === 0) return { kind: 'failed', reason: 'unusable' };

  // ── Rebuild the run: silence keeps, only "deleted" removes ────────────────
  //
  // This used to replace the whole run with whatever came back, so a section
  // the model simply did not mention was destroyed. Handed the whole page
  // (which happens whenever nothing could place the ask), a model that
  // sensibly returned just the two sections it changed wiped everything else —
  // a user lost their stats and gallery sections that way, live.
  //
  // Now a section leaves the page only when the model NAMES it. Forgetting to
  // mention something can no longer delete it, and deleting is still fully
  // expressible. Order comes from what was returned, so reordering still works.
  // ── Splice each section into its OWN byte range ───────────────────────────
  //
  // The version before this one replaced everything between the first and last
  // marked section with the marked sections joined together. That is only safe
  // if the page is nothing BUT marked sections — and it is not. A real page
  // here had markers on three sections out of ten, so a nav+footer edit wiped
  // every unmarked thing between them: the entire about section, 4 images, 20
  // headings, 60 click-to-edit fields. The damage guard caught it and restored
  // the page, but the turn was lost and the cause was this splice.
  //
  // Editing one section must touch that section's bytes and nothing else. So
  // each change is applied to its own range, highest offset first so earlier
  // offsets stay valid. Anything between sections — marked or not — is never
  // in a range and therefore cannot be touched.
  const rewrittenByName = new Map(rewritten.map((sec) => [sec.name, sec.html]));
  const removed = new Set(deleted);
  const block = (name: string, htmlBody: string) =>
    `<!-- SL:${name} -->\n${htmlBody.trim()}\n<!-- /SL:${name} -->`;

  let spliced = opts.html;

  // Deletions and replacements, both keyed to a single section's own bounds.
  const edits: Array<{ from: number; to: number; text: string }> = [];
  for (const name of Array.from(removed)) {
    const at = findSlBlockBounds(spliced, name);
    if (at) edits.push({ from: at[0], to: at[1], text: '' });
  }
  for (const sec of rewritten) {
    if (removed.has(sec.name)) continue;
    const at = findSlBlockBounds(spliced, sec.name);
    if (at) edits.push({ from: at[0], to: at[1], text: block(sec.name, sec.html) });
  }
  // Descending, so applying one edit cannot move the next one's offsets.
  edits.sort((a, b) => b.from - a.from);
  for (const e of edits) spliced = spliced.slice(0, e.from) + e.text + spliced.slice(e.to);

  // Sections the page did not have go after the last one that survived.
  const brandNew = rewritten.filter(
    (sec) => !removed.has(sec.name) && !findSlBlockBounds(opts.html, sec.name),
  );
  if (brandNew.length > 0) {
    const survivors = body.filter((sec) => !removed.has(sec.name)).map((sec) => sec.name);
    const anchor = survivors.length > 0 ? survivors[survivors.length - 1] : null;
    const at = anchor ? findSlBlockBounds(spliced, anchor) : null;
    const addition = brandNew.map((sec) => block(sec.name, sec.html)).join('\n');
    spliced = at
      ? `${spliced.slice(0, at[1])}\n${addition}${spliced.slice(at[1])}`
      : `${spliced}\n${addition}`;
  }

  // Reordering is a different operation: the bytes have to MOVE, which no
  // in-place replacement can express. Only attempt it when the marked sections
  // sit next to each other with nothing but whitespace between them — moving
  // them otherwise would drag unmarked content out of position, which is the
  // exact failure this splice was rewritten to stop.
  const modelOrder = rewritten.map((sec) => sec.name);
  const survivorNames = body.filter((sec) => !removed.has(sec.name)).map((sec) => sec.name);
  const looksLikeReorder =
    modelOrder.length > 1 &&
    modelOrder.length === survivorNames.length &&
    survivorNames.every((n) => modelOrder.includes(n)) &&
    modelOrder.join('|') !== survivorNames.join('|');
  let reordered = false;
  if (looksLikeReorder) {
    const span = findSlRegionBounds(spliced, survivorNames[0], survivorNames[survivorNames.length - 1]);
    if (span) {
      const inner = spliced.slice(span[0], span[1]);
      const blocksOnly = survivorNames.reduce((acc, n) => {
        const at = findSlBlockBounds(acc, n);
        return at ? acc.slice(0, at[0]) + acc.slice(at[1]) : acc;
      }, inner);
      if (blocksOnly.trim() === '') {
        const ordered = modelOrder
          .map((n) => {
            const at = findSlBlockBounds(spliced, n);
            return at ? spliced.slice(at[0], at[1]) : null;
          })
          .filter((b): b is string => b !== null);
        if (ordered.length === modelOrder.length) {
          spliced = spliced.slice(0, span[0]) + ordered.join('\n') + spliced.slice(span[1]);
          reordered = true;
        }
      } else {
        console.warn('[pages/follow-up] reorder skipped — unmarked content sits between sections', {
          order: modelOrder,
        });
      }
    }
  }

  const kept = body.filter((sec) => !removed.has(sec.name) && !rewrittenByName.has(sec.name));
  console.log('[pages/follow-up] section splice', {
    changed: rewritten.map((sec) => sec.name),
    keptUntouched: kept.map((sec) => sec.name),
    added: brandNew.map((sec) => sec.name),
    deleted,
    reordered,
  });

  // The run has to come back out as the sections we just wrote. A splice that
  // lost a marker would leave the page silently short of a section.
  const wrote = rewritten.map((s) => s.name).filter((n) => !removed.has(n));
  const afterNames = extractSlSections(spliced).map((s) => s.name);
  if (!wrote.every((n) => afterNames.includes(n))) {
    console.error('[pages/follow-up] region splice did not survive re-extraction', { wrote, afterNames });
    return { kind: 'failed', reason: 'unusable' };
  }

  // Schema follows the sections: names that left the page lose their entry,
  // names that arrived get one built from their own data-field attributes.
  const schemaCopy = (opts.schema && typeof opts.schema === 'object'
    ? JSON.parse(JSON.stringify(opts.schema))
    : {}) as Record<string, unknown>;
  for (const gone of insideNames.filter((n) => !wrote.includes(n))) delete schemaCopy[gone];
  for (const s of rewritten) {
    const fields = extractDataFieldsFromHtml(s.html);
    if (Object.keys(fields).length > 0) schemaCopy[s.name] = fields;
  }

  console.log('[pages/follow-up] region rewritten', {
    // unresolved:true means nothing placed the ask on a page too big to send
    // whole. Rare is fine; common means the resolver prompt needs work.
    unresolved: regionUnresolved,
    editable: insideNames,
    wrote,
  });
  return {
    kind: 'applied',
    html: spliced,
    schema: schemaCopy,
    wrote,
    region: Array.from(new Set([...insideNames, ...wrote])),
    message: result.message,
  };
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

  // Skills the page was BUILT with, so an edit obeys the same rules the
  // original build did. Loaded in its own query on purpose — see
  // skills/persistence.ts; folding these columns into the SELECT above would
  // make this route 404 everywhere until migration 062 is applied.
  //
  // Only the full-rebuild path uses them (a structural follow-up regenerates
  // the whole document). Surgical edits splice into HTML that already embodies
  // the skills, so re-stating them there would be prompt weight for nothing.
  const savedSkillState = await loadPageSkills(params.id);
  const savedSkills = resolveSkills(savedSkillState.skills);
  const savedStyle = isStyleTag(savedSkillState.style) ? savedSkillState.style : null;

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
  let asset_library: { url: string; name?: string }[] | undefined;
  try {
    const body = await request.json();
    prompt = body.prompt;
    current_schema = body.current_schema;
    current_html = body.current_html;
    image_urls = body.image_urls;
    asset_library = body.asset_library;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  // What the USER typed, frozen before the asset-library block below appends to
  // `prompt`. Every conversation_json write stores this, not the mutated value:
  // the augmented text was going into history verbatim, so reopening a page
  // showed the raw "## Real assets the user supplied..." block sitting inside
  // the user's own chat bubble. The asset list now rides along as structured
  // `asset_library` on the same entry, which replays cleanly and reads as
  // nothing at all.
  const rawPrompt = prompt;
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

  // Put back any <!-- SL:name --> markers this page has lost, in memory,
  // before anything reads it. A section without markers still renders and is
  // entirely uneditable: asked to change it, the system answers "that section
  // isn't part of what I can edit right now" — which is true, and which the
  // user has no way to fix.
  //
  // Deliberately NOT saved on its own. It rides along with the edit and is
  // stored only if that edit succeeds, so a mistaken repair can never land by
  // itself on a page nobody asked us to touch.
  {
    const fix = repairSlMarkers(html, schema);
    if (fix.repaired.length > 0 || fix.skipped.length > 0) {
      console.log('[pages/follow-up] section markers repaired in memory', {
        repaired: fix.repaired,
        structural: fix.structural,
        skipped: fix.skipped,
      });
    }
    html = fix.html;

    // If anything is STILL unreachable after repair, say so here rather than
    // letting the turn end in "I couldn't work out what to change" — that
    // message blamed the user's wording for a block we never showed the model.
    const coverage = markerCoverage(html);
    if (coverage.unmarked.length > 0) {
      console.error('[pages/follow-up] blocks this edit cannot reach', {
        blocks: coverage.blocks,
        marked: coverage.marked,
        unmarked: coverage.unmarked,
      });
    }

    // Measured, never acted on here. Both of these describe how the page was
    // PREPARED, and the fix for either one is to re-cut its boxes — which is
    // safe only at prep, since the schema, every click-to-edit field and the
    // whole chat history are keyed to the section names this page already has.
    // Re-cutting them mid-conversation would break a page that is live on a
    // test. Logged so a page that arrives here in a bad state is visible at the
    // time of the edit rather than inferred from a screenshot days later.
    const quality = markerQuality(html);
    if (!quality.ok) {
      console.error('[pages/follow-up] section map this edit has to work with is poor', {
        emptyBoxes: quality.empty,
        dominant: quality.dominant,
      });
    }
  }

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
  const history: {
    role: 'user' | 'assistant';
    content: string;
    image_urls?: string[];
    // Link-imported files (Drive folder / bucket / page scrape) from an earlier
    // turn. Stored separately from image_urls because they take the other lane
    // in — see the asset library block below.
    asset_library?: { url: string; name?: string }[];
    clarify?: boolean;
  }[] = Array.isArray(page.conversation_json) ? page.conversation_json : [];
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
  // Video/media embed CDN URLs (e.g. a Mux/Vimeo/YouTube embed link) are never a
  // "clone this site" competitor reference — exclude them the same way generate/route.ts does.
  // Asset sources (Drive folder/file, a bucket listing) are excluded for the
  // same reason as embed CDNs: they are where the pictures live, never a design
  // to copy. Scraping one returns the host's own marketing chrome.
  //
  // Shape alone stops here — it can only rule OUT urls that definitely are not
  // a competitor (an image, an embed, a Drive/bucket link). It cannot rule one
  // IN: a shape-shaped "webpage" URL is just as often an asset folder, a docs
  // page, or a site the prompt explicitly says NOT to clone. Same bug class
  // that hit generate/route.ts (see classifyCompetitorReferenceUrl) — a URL
  // surviving this filter used to become THE competitor reference by default.
  const shapeQualifiedUrls = mentionedUrls.filter(
    (u, i) => !mentionedUrlImageFlags[i] && !isEmbedAssetUrl(u) && classifyAssetSource(u) === 'webpage',
  );
  const classifiedReferenceUrl =
    shapeQualifiedUrls.length > 0
      ? await classifyCompetitorReferenceUrl(prompt, shapeQualifiedUrls)
      : null;
  const competitorUrls = classifiedReferenceUrl ? [classifiedReferenceUrl] : [];

  // Merge prompt-detected image URLs in with any client-attached ones so the
  // model can embed them exactly like an uploaded image attachment. Capped at
  // 3 total to match the existing image_urls validation above.
  // Same cap the classifier uses, from the same constant — see MAX_ATTACHMENTS.
  const currentTurnImageUrls = [...(image_urls ?? []), ...promptImageUrls].slice(0, MAX_ATTACHMENTS);

  // ── Pictures from earlier turns, offered back to the classifier ───────────
  //
  // conversation_json has stored these URLs all along (they are permanent
  // public Storage URLs from upload-chat-image), and not one model call ever
  // received them: a past attachment reached the model only as the TEXT
  // "[attached 1 image(s)]". So "add the subheadline from the image" was
  // answered by a model told a picture existed and shown none. It asked for a
  // re-attach — correct, given its input — and the next turn then hit
  // lastAssistantWasClarify, which forces noQuestions, leaving it unable to
  // ask and still unable to see. That turn died as "I couldn't work out what
  // to change". Two turns lost to an input we were already holding.
  //
  // Deliberately NOT a "look back N turns" rule, and deliberately not gated on
  // the message matching some phrase like "the image above". Which picture a
  // message means is a judgement about the message — exactly the judgement
  // this file hands to the model everywhere else — and any regex or distance
  // test is the keyword gate this design removed. The model is shown the
  // pictures and names the ones it needs (intent.earlierImages).
  //
  // The one bound is cost, which is arithmetic rather than judgement: every
  // vision attachment spends ~IMAGE_TOKENS of the same window the page HTML
  // has to fit into. Filled most-recent-first so the cap sheds the images
  // least likely to be the one meant.
  const earlierAttachmentPool: EarlierAttachment[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (earlierAttachmentPool.length >= MAX_EARLIER_ATTACHMENTS) break;
    const entry = history[i];
    if (!entry || entry.role !== 'user' || !Array.isArray(entry.image_urls)) continue;
    const note =
      typeof entry.content === 'string' ? entry.content.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    for (let j = entry.image_urls.length - 1; j >= 0; j--) {
      if (earlierAttachmentPool.length >= MAX_EARLIER_ATTACHMENTS) break;
      const url = entry.image_urls[j];
      // Rows written by older builds (or a client that optimistically stored a
      // blob: preview) can hold something that is not a fetchable URL. A
      // vision block pointing at one fails the whole classification call, so
      // anything that isn't http(s) never enters the pool.
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      if (currentTurnImageUrls.includes(url)) continue;
      if (earlierAttachmentPool.some((a) => a.url === url)) continue;
      earlierAttachmentPool.push({ url, note });
    }
  }
  // Oldest first, so E-numbers read down the conversation the way it happened.
  earlierAttachmentPool.reverse();

  // ── What is this person asking for? ───────────────────────────────────────
  // One model call decides routing. If it fails: ask the user once (no infinite
  // clarify loop). Keyword regex is only used when they said "you decide" or
  // this message answers our previous clarify.
  // Everything the models below need in order to resolve what this message
  // REFERS to. Held by the route since forever and handed to exactly one call
  // (the full-page rebuild), while the path that runs on almost every edit was
  // given the bare sentence. "make it bigger" is unanswerable without this.
  //
  // Two versions, because the annotation on each past turn states whether that
  // turn's picture is actually in front of the model, and the two calls are
  // shown different sets: the classifier sees the whole offered pool, while
  // everything after it sees only what the classifier chose to reuse. One
  // shared string would tell one of them a picture is "shown to you" when it
  // is not — which is the very lie this fix exists to remove.
  const conversationForIntent = buildConversationContext(history, {
    availableImageUrls: new Set([
      ...currentTurnImageUrls,
      ...earlierAttachmentPool.map((a) => a.url),
    ]),
  });

  const priorUserUrls = history
    .filter((h) => h.role === 'user' && typeof h.content === 'string')
    .flatMap((h) => extractUrls(h.content));
  const intentSectionsSnapshot = extractSlSections(html);
  const intent = await classifyEditIntent({
    prompt,
    sectionNames: intentSectionsSnapshot.map((s) => s.name),
    // What each section CONTAINS, not just its name — this is what lets
    // "remove this" + a screenshot resolve to a real section instead of
    // silently returning no target and changing nothing.
    sectionOutline: intentSectionsSnapshot.map((s) => ({ name: s.name, text: s.text })),
    imageUrls: currentTurnImageUrls,
    // Offered, not applied — the model names which of these this message is
    // pointing back at, and only those are carried into the edit below.
    earlierImages: earlierAttachmentPool,
    earlierUrls: priorUserUrls,
    embeddableAssetUrls: [
      ...(preEditLogoUrl ? [preEditLogoUrl] : []),
      ...currentTurnImageUrls,
      ...earlierAttachmentPool.map((a) => a.url),
    ],
    requirementInstruction: REQUIREMENT_EXTRACTION_INSTRUCTION,
    conversation: conversationForIntent,
    usage: usageCtx,
    label: 'follow-up:edit-intent',
  });
  console.log('[pages/follow-up] intent', intent
    ? {
        designReference: intent.designReference,
        reuseReferenceCopy: intent.reuseReferenceCopy,
        bugReport: intent.bugReport,
        asks: intent.asks.length,
        targetSections: intent.targetSections,
        fullRebuild: intent.fullRebuild,
        sourceUrl: intent.sourceUrl ? intent.sourceUrl.slice(0, 80) : null,
        requirements: intent.requirements.length,
        isQuestion: intent.isQuestion,
        attachmentRoles: intent.attachmentRoles,
      }
    : 'unavailable', {
      currentTurnImages: currentTurnImageUrls.length,
      earlierImagesOffered: earlierAttachmentPool.length,
      earlierImagesReused: intent?.earlierImages.map((e) => e.role) ?? [],
    });

  // This turn's attachments, plus any earlier one the classifier says this
  // message is actually about. Order matters and is fixed: the current
  // message's own images stay first, because attachmentRoles and every ask's
  // imageIndexes are positional over exactly those. Reused ones append after
  // and are matched by URL instead (see imageRolesFromIntent).
  //
  // Identical to currentTurnImageUrls whenever nothing is reused — which is
  // most turns, and every turn on a conversation with no earlier attachments.
  // So the no-reuse path is byte-for-byte the old behaviour.
  const effectiveImageUrls = Array.from(
    new Set([...currentTurnImageUrls, ...(intent?.earlierImages ?? []).map((e) => e.url)]),
  );
  const hasUserImages = effectiveImageUrls.length > 0;

  // Now that the reuse decision is made, the transcript can state honestly
  // which past attachments the calls below can actually see.
  const conversationContext = buildConversationContext(history, {
    availableImageUrls: new Set(effectiveImageUrls),
  });

  // Per-URL role the classifier already worked out ("content_asset" = embed
  // exactly, "locator"/"design_reference"/"bug_report" = never embed the file
  // itself). Built once here and handed to every HTML-writing call below so
  // none of them has to re-guess "embed or reference?" from the raw URL list
  // alone — that re-guess is what embedded a "here's where I mean" screenshot
  // as literal page content.
  const roleByUrl = new Map<string, AttachmentRole>(
    intent
      ? imageRolesFromIntent(intent, effectiveImageUrls).map((r) => [
          r.url,
          r.role === 'bug_reference' ? 'bug_report' : r.role,
        ])
      : [],
  );

  // ── Real assets the user imported from a link ────────────────────────────
  //
  // Appended to `prompt` itself, and deliberately AFTER intent classification
  // so a list of URLs cannot skew what the classifier thinks was asked for.
  // Every branch below — patch, structural, insert_section, image_generate —
  // builds its own call off `prompt`, so this single injection reaches all of
  // them without touching each one.
  //
  // Carried as text, not as image attachments: attachments here are routed
  // per-image by role (imageRolesFromIntent picks attachedAssets[0] for a logo
  // swap, and so on), that routing is positional and built for a handful of
  // images, and image_urls is hard-capped at MAX_ATTACHMENTS. A named URL list
  // sidesteps all of it, so an imported folder is not silently trimmed to 3.
  //
  // Carried across turns, not just this one. The pool of earlier IMAGE
  // ATTACHMENTS above already does this for chat uploads, and the two lanes
  // looked equivalent — but every persistence site writes `image_urls` and
  // only `image_urls`, so a linked import lived for exactly one request. Import
  // four photos from a Drive folder, then say "put the second one in the hero"
  // on the next turn, and the model had never heard of them: no names, no URLs,
  // nothing. It correctly answered that it couldn't, which read as the import
  // having failed. Routing the library around the MAX_ATTACHMENTS cap also
  // routed it around the memory, which was never the intent.
  //
  // Replayed as text only — no vision blocks — for the same reason the current
  // turn's library is text: an imported folder is up to 20 files, and putting
  // that many pictures through vision on every subsequent turn would eat the
  // window the page HTML needs. Names and URLs are enough to place a file.
  const normalizeLibrary = (raw: unknown): { url: string; name: string }[] =>
    Array.isArray(raw)
      ? raw
          .filter((a): a is { url: string; name?: string } =>
            !!a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string' &&
            /^https?:\/\//i.test((a as { url: string }).url))
          .map((a) => ({ url: a.url, name: typeof a.name === 'string' && a.name ? a.name : 'image' }))
      : [];

  // This turn's imports first, then older ones most-recent-first, so the cap
  // sheds the files least likely to be the ones meant.
  const seenLibraryUrls = new Set<string>();
  const libraryAssets: { url: string; name: string }[] = [];
  const pushLibrary = (assets: { url: string; name: string }[]) => {
    for (const a of assets) {
      if (libraryAssets.length >= MAX_LIBRARY_ASSETS) return;
      if (seenLibraryUrls.has(a.url)) continue;
      seenLibraryUrls.add(a.url);
      libraryAssets.push(a);
    }
  };
  pushLibrary(normalizeLibrary(asset_library));
  const currentTurnLibraryCount = libraryAssets.length;
  for (let i = history.length - 1; i >= 0 && libraryAssets.length < MAX_LIBRARY_ASSETS; i--) {
    const entry = history[i];
    if (!entry || entry.role !== 'user') continue;
    pushLibrary(normalizeLibrary(entry.asset_library));
  }

  if (libraryAssets.length > 0) {
    prompt = `${prompt}\n\n## Real assets the user supplied for this page (already hosted, safe to embed)\nThese were imported from a link the user gave — this turn or earlier in this conversation. They are still available and still theirs to use.\n${libraryAssets
      .map((a, i) => `${i + 1}. ${a.name} — ${a.url}`)
      .join('\n')}\n\nWhen this edit needs one of these, use the EXACT URL above in src and do NOT generate a new image for that slot. Pick by filename and by what the instruction asks for. A logo file belongs in nav/footer, a headshot on a person. Only generate an image when NONE of these fit.\n`;
    console.log('[pages/follow-up] asset library', {
      count: libraryAssets.length,
      thisTurn: currentTurnLibraryCount,
      carried: libraryAssets.length - currentTurnLibraryCount,
    });
  }

  // Intent failed (timeout / truncate / bad JSON). That is OUR outage, not a
  // badly-worded request — so say so and let them retry, instead of asking the
  // user to re-explain a perfectly clear message (and instead of regex-routing,
  // which was the second brain this whole design removes). Nothing is written
  // to the conversation: a system failure is not a turn in their chat.
  if (!intent) {
    const { stream, controller } = createSSEStream();
    const response = new Response(stream, { headers: SSE_HEADERS });
    void (async () => {
      try {
        console.error('[pages/follow-up] intent unavailable — reporting AI outage, no regex fallback');
        sendSSE(controller, {
          type: 'error',
          message:
            'The AI service didn’t respond properly just now — nothing on your page was changed. Please try that again in a moment.',
        });
      } catch (err) {
        console.error('[pages/follow-up] intent-failure reporting failed', err);
        sendSSE(controller, { type: 'error', message: userFacingAIErrorMessage(err) });
      } finally {
        closeSSE(controller);
      }
    })();
    return response;
  }

  // Attached images (a screenshot of the current page, a reference) must reach
  // this call the same way they reach classifyEditIntent — missed once
  // already: the first version sent only the text prompt, so an attached hero
  // screenshot was invisible and the model correctly (but uselessly) said it
  // couldn't see it.
  //
  // The current page's own HTML is also handed over as text, always — this is
  // the same `htmlForModel` every other full-page AI call in this route
  // already uses, no extra fetch/render involved. It's what lets a question
  // like "is our FAQ good?" get a real, specific answer (actual questions,
  // whether it's an accordion, etc.) without requiring a screenshot or a live
  // Puppeteer re-render of the page — the disabled `runPostUploadNavLogoQa`
  // path (see the comment ~5658 below) is exactly the render-and-screenshot
  // approach that broke production once already, so this stays text-only on
  // purpose. HTML alone can't catch purely visual/rendering bugs (overlap, a
  // font not loading) — the system prompt tells the model to say so rather
  // than guess.
  //
  // Shared by two call sites: a standalone question (below) and a question
  // riding alongside a real edit via `intent.questionAside` (near the final
  // `doneEvent`, appended as a note instead of replacing the edit result).
  const answerFollowUpQuestion = async (questionText: string): Promise<string> => {
    const fullQuestionText = `Current page HTML:\n${htmlForModel}\n\nUser question: ${questionText}`;
    const questionContent: AIContent = effectiveImageUrls.length > 0
      ? [
          ...effectiveImageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
          { type: 'text', text: fullQuestionText },
        ]
      : fullQuestionText;
    const answer = await askAI({
      system: FOLLOW_UP_QUESTION_SYSTEM,
      messages: [{ role: 'user', content: questionContent }],
      // Sized for Haiku, which had no thinking overhead. Every call here runs
      // on Sonnet 5, whose adaptive thinking is billed against this same
      // ceiling BEFORE the answer starts — so a small budget can be spent
      // entirely on thinking and truncate the response. Truncation here fails
      // silently (see the catch below), so the loss is invisible. Costs
      // nothing: Anthropic bills output actually generated, not this ceiling.
      maxTokens: 128000,
      label: 'follow-up:answer-question',
      usage: usageCtx,
    });
    return answer.trim().slice(0, 6000) || "I'm not sure how to answer that — could you rephrase?";
  };

  // Pure question ("hi how are you", "can you connect this to my CRM?", "what
  // can you do here?") — no concrete change was asked for, so the entire
  // edit/patch/requirements pipeline below must not run. Answer conversationally
  // and stop, exactly like the existing clarify path stops before touching the
  // page — except this is never persisted as `clarify: true`, since that flag
  // means "we asked a section-ambiguity question" and forces noQuestions on the
  // NEXT turn's edit; a plain Q&A exchange must not suppress a genuine
  // clarifying question on whatever the user asks next.
  if (intent.isQuestion && intent.asks.length === 0) {
    const { stream, controller } = createSSEStream();
    const response = new Response(stream, { headers: SSE_HEADERS });
    void (async () => {
      try {
        const reply = await answerFollowUpQuestion(prompt);
        const userEntry: Record<string, unknown> = { role: 'user', content: rawPrompt };
        if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
        // Only THIS turn's imports. The merged list above also holds files carried
        // forward from older entries; re-storing those would copy the whole library
        // onto every turn and grow conversation_json without bound.
        if (currentTurnLibraryCount > 0) userEntry.asset_library = libraryAssets.slice(0, currentTurnLibraryCount);
        await db
          .from('pages')
          .update({
            conversation_json: [...history, userEntry, { role: 'assistant', content: reply }],
            updated_at: new Date().toISOString(),
          })
          .eq('id', params.id);
        sendSSE(controller, { type: 'clarify', message: reply });
      } catch (err) {
        console.error('[pages/follow-up] question-answer call failed', err);
        sendSSE(controller, { type: 'error', message: userFacingAIErrorMessage(err) });
      } finally {
        closeSSE(controller);
      }
    })();
    return response;
  }

  /** The page should look like an attachment/reference. */
  const wantsDesignMatch = intent.designReference;
  /** The reference's visible words are content to reproduce, not just a style. */
  const wantsReferenceWords = intent.reuseReferenceCopy;
  /** Several distinct asks in one message — the case where asks get dropped. */
  const hasMultipleAsks = intent.asks.length > 1;
  /** An attachment shows something wrong on OUR page, not a design to copy. */
  const wantsBugFix = intent.bugReport;
  /** Sections the classifier says this message is about; [] when it can't tell. */
  const intentSections = intent.targetSections;
  /**
   * Content reuse: intent.content_reuse only (including null). No keyword fill.
   */
  const resolveContentReuse = (_askText: string, sectionNames: string[]) => {
    if (!intent.contentReuse) return null;
    return {
      ...intent.contentReuse,
      targets: intent.contentReuse.targets.filter((t) => sectionNames.includes(t)),
    };
  };
  /** Proceed on the best guess instead of asking a clarifying question. */
  const wantsUsToDecide = intent.proceedAnyway;

  /**
   * Attach the message's standing conditions to one step's instruction.
   *
   * Steps are executed in isolation with only their own instruction, so
   * "keep the dark theme we have" reached exactly one of them. A later step
   * that recreates a section from a light-themed screenshot then had nothing
   * telling it the theme was off limits. Conditions qualify every step.
   */
  const withConstraints = (instruction: string): string => {
    const parts: string[] = [instruction];
    if (intent.constraints.length > 0) {
      parts.push(
        `(Standing conditions from the user — these apply to this edit and must not be broken:\n${intent.constraints
          .map((c) => `- ${c}`)
          .join('\n')}\nThey describe what to PRESERVE; they are not new work.)`,
      );
    }
    // A multi-part message is split into steps that each run alone, so a step
    // like "align them horizontally" arrived with no antecedent for "them" —
    // the thing it refers to was named in a DIFFERENT step. Carrying the
    // original message as read-only context is not a decision, it is the
    // information needed to read the instruction correctly.
    if (intent.asks.length > 1 && instruction.trim() !== prompt.trim()) {
      parts.push(
        `(The user's full message, for CONTEXT ONLY — do not carry out its other parts here, a separate step handles each one. Use it to resolve what words like "them", "it" or "this" refer to:\n"""\n${prompt}\n"""\n)`,
      );
    }
    return parts.join('\n\n');
  };

  // "get the logo from the website i gave you" — only when intent says so.
  //
  // Guarded on hasUserImages, NOT promptImageUrls. promptImageUrls only counts
  // image URLs TYPED INTO the message; an uploaded attachment lives in
  // image_urls and used to score zero here. So "add those sections to the page"
  // with a screenshot attached reached back into history, grabbed an old site
  // URL, tried to scrape photos off it, and dead-ended the whole turn with
  // "We couldn't find a usable headshot/product photo on that page" — about a
  // site the user never mentioned. When they hand us an image, that image is
  // the source; never go fetch a different one.
  //
  // Link-imported photos count as "they handed us an image" for exactly the
  // reason above, and did not used to: they travel in `asset_library`, not in
  // image_urls, so `hasUserImages` scored them zero. Paste a Drive folder,
  // then say "use the red car as the footer background", and this block went
  // hunting through history for a website instead of using the four photos
  // sitting in front of it.
  if (competitorUrls.length === 0 && !hasUserImages && libraryAssets.length === 0) {
    const inherited =
      intent.usesEarlierSource && (intent.assetSource || intent.fullRebuild)
        ? intent.sourceUrl
        : null;
    // Same test the current-turn filter runs (see `competitorUrls` above). A
    // URL arriving from history skipped it entirely, so a Drive folder that
    // was correctly refused as a design reference on the turn it was pasted
    // came back in as one on the next turn — and the scrape branches below are
    // fetch-or-die, so scraping a folder listing for a headshot ended the turn
    // with an error and the page untouched. isImageUrl alone never caught it:
    // a folder link is not a direct image.
    const inheritedKind = inherited ? classifyAssetSource(inherited) : null;
    if (inheritedKind && inheritedKind !== 'webpage') {
      console.log('[pages/follow-up] not inheriting asset-source URL as a competitor site', {
        url: inherited,
        kind: inheritedKind,
      });
    } else if (inherited && !(await isImageUrl(inherited))) {
      competitorUrls.push(inherited);
      console.log('[pages/follow-up] inherited source URL from history', { url: inherited });
    }
  }

  // Logo / content-image / scoped-despite-URL: intent fields only.
  //
  // LIVE GATE — these three still pick a path and then execute it, and both
  // scrape branches are fetch-or-die (a failed fetch ends the turn with an
  // error and no edit). Note `competitorUrls` may hold a URL INHERITED from an
  // earlier turn, so "make the logo bigger" with a link pasted three messages
  // ago can trigger a scrape of a site this message never mentioned, and end
  // in "We couldn't find a usable logo image on that page" with the page
  // unchanged. If that shows up in the logs, the fix is to fall through to the
  // region rewrite on a failed fetch, not to widen assetSource.
  const isLogoSwapAttempt = competitorUrls.length > 0 && intent.assetSource === 'logo';
  const isScopedDespiteUrl =
    competitorUrls.length > 0 && !isLogoSwapAttempt && !intent.fullRebuild;
  const isContentImageSwapAttempt =
    competitorUrls.length > 0 &&
    !isLogoSwapAttempt &&
    intent.assetSource === 'content_images';

  // Scoped-patch candidates — cheap, synchronous, no AI call. A genuine
  // competitor redesign URL always means full-page rebuild (see
  // follow-up-input-scoping.md), so scoping is never attempted when one is
  // mentioned — except logo/content-image swaps and incidental-URL local edits.
  const allowScopedWithCompetitorUrl =
    isLogoSwapAttempt || isScopedDespiteUrl || isContentImageSwapAttempt;
  let slSections =
    competitorUrls.length === 0 || allowScopedWithCompetitorUrl ? extractSlSections(html) : [];
  // Exact-quote shortcut: the user quoted copy that exists in exactly one
  // section. Counting matches is a fact, not a judgement — but it must never
  // PRE-EMPT the model. When an image is attached, or the classifier resolved
  // sections of its own, the model has context this lookup cannot see (the
  // screenshot may point somewhere else entirely), so its answer wins.
  const quoteMatchSection =
    !hasUserImages && (competitorUrls.length === 0 || allowScopedWithCompetitorUrl)
      ? tryDirectQuoteMatch(prompt, slSections)
      : null;

  // The checklist comes from the model that read the request (intent pass, and
  // the router later refines it) — deterministic code still does every check.
  // Seeded from the intent pass so an edit that never reaches routing (scoped
  // paths, multi-ask plans) is still verified against what was asked.
  let modelRequirements: PageRequirement[] = intent.requirements;
  const captureModelRequirements = (routing: RoutingResult | null) => {
    if (!routing?.requirements) return;
    const parsed = parseModelRequirements(routing, {
      knownSections: slSections.map((s) => s.name),
      // Asset checks may only name URLs that can actually end up in the HTML:
      // the logo already on the page and this turn's attachments. A source URL
      // the model read off the brand's site is re-hosted before embedding, so
      // checking it would report a visible logo as a dropped ask forever.
      embeddableAssetUrls: [
        ...(preEditLogoUrl ? [preEditLogoUrl] : []),
        ...effectiveImageUrls,
      ],
    });
    if (parsed.length > 0) modelRequirements = mergeRequirements(modelRequirements, parsed);
  };

  // ── Open SSE stream — no NextResponse.json after this point ───────────────

  const { stream, controller } = createSSEStream();
  const response = new Response(stream, { headers: SSE_HEADERS });

  void (async () => {
    try {
      let finalHtml = '';
      let finalSchemaJson: unknown | undefined;
      let scopedApplied = false;
      /**
       * ONLY for an ask that is not on the finished page. The client turns this
       * into "Partly done (not fully finished)" plus a retry toast.
       */
      let partialMessage: string | null = null;
      /**
       * Something is off with the PAGE, but everything asked for was done.
       * Kept apart from partialMessage on purpose: only an unfinished ASK may
       * say "Partly done", or the user re-sends work that already landed.
       *
       * Everything here rides the `notes` field of the done event and keeps the
       * "Done!" headline. This used to be emitted as `warning`, which was never
       * in SSEEvent and never read by the client — the false "Partly done" was
       * fixed and the real caveat was dropped on the floor with it.
       */
      const pageNotes: string[] = [];
      const addNote = (note: string) => {
        if (!pageNotes.includes(note)) pageNotes.push(note);
      };
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
      let scrapeAttempted = false;
      // Mirrors parsed.type from the full-page path — scoped patches are
      // always a 'patch' by construction, so this is set once up front and
      // only overwritten inside the fallback branch below.
      let resultType: 'structural' | 'style' | 'patch' = 'patch';
      // Per-image vision: every attachment is shown. Instruction decides
      // whether a URL goes in src — code must not split embed-all vs embed-none.
      let routingImageUrls = effectiveImageUrls;
      let designReferenceUrls: string[] = [];
      let designCopyLines: string[] = [];
      let imageRolesClassified = false;
      /** Set when a logo-swap applied a real hosted URL — used by visual QA. */
      let logoSwapAppliedUrl: string | null = null;
      /** Logo already fetched+embedded this turn — don't scrape/swap again. */
      let logoSwapCompleted = false;
      /**
       * True once we handed the ask to the region rewrite as the PRIMARY
       * executor. The menu dispatcher below must not then run — that is the
       * hurdle. If the rewrite could not act, we tell the user so rather than
       * pressing the nearest button and calling it Done.
       */
      let regionAttempted = false;
      /**
       * Sections a region rewrite owned this turn, or null if no rewrite ran.
       *
       * The damage guard uses this to stop policing the model's own work. A
       * rewrite is GIVEN a run of sections and told to change them; losing an
       * image there is usually the edit succeeding (a picture put where one
       * already was replaces it). Outside the run, nothing was supposed to
       * change at all, so a loss there is provable damage. Same guard, applied
       * only where it can be right.
       */
      let rewrittenRegion: string[] | null = null;
      /**
       * Why the primary rewrite missed, if it did. Kept so the user is told
       * the thing that is actually true of their turn rather than one generic
       * sentence that fits only one of the three cases.
       */
      let regionFailReason: RegionFailReason = 'unusable';
      /**
       * The rewrite understood the ask and deliberately changed nothing (the
       * page already reads that way, an earlier turn already did it, an image
       * it was asked to copy from is unreadable). Held apart from
       * regionFailReason because the two are opposite messages: this one has to
       * say what IS true of the page, never "name the section and what should
       * happen to it" — which reads as "your wording was the problem" on a turn
       * where the classifier resolved the section, the ask and its
       * requirements perfectly well.
       */
      let noChangeReason: string | null = null;
      /**
       * What the model says it did, in its own words — the sentence the user
       * actually reads on success. Null whenever no model authored one (the
       * full-page rebuild path, deterministic splices), and the client then
       * falls back to the fixed "Done! The page has been updated."
       */
      let editorMessage: string | null = null;

      /**
       * End the turn with "understood, nothing to change" instead of an error.
       *
       * Stored as an ordinary assistant turn — never `clarify: true`, which
       * means "we asked a section-ambiguity question" and forces noQuestions on
       * the next turn. A no-op verdict must not gag a genuine question about
       * whatever the user says next ("no, it really isn't there").
       */
      const reportNoChange = async (reason: string) => {
        const userEntry: Record<string, unknown> = { role: 'user', content: rawPrompt };
        if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
        // Only THIS turn's imports. The merged list above also holds files carried
        // forward from older entries; re-storing those would copy the whole library
        // onto every turn and grow conversation_json without bound.
        if (currentTurnLibraryCount > 0) userEntry.asset_library = libraryAssets.slice(0, currentTurnLibraryCount);
        await db
          .from('pages')
          .update({
            conversation_json: [...history, userEntry, { role: 'assistant', content: reason }],
            updated_at: new Date().toISOString(),
          })
          .eq('id', params.id);
        console.log('[pages/follow-up] nothing to change', { reason });
        sendSSE(controller, { type: 'clarify', message: reason });
        closeSSE(controller);
      };

      /**
       * The one general path, reachable from every narrow dead end.
       *
       * Everything above this line is a NARROW verb — copy a logo, place text,
       * patch a named section, swap a photo. Each one can only express the
       * meanings its own vocabulary covers, and each one used to answer "I can't
       * express that" by sending the user an error and ending the turn. That is
       * the code deciding the request is impossible when all that happened is
       * that OUR list was too short.
       *
       * The region rewrite has no vocabulary: it takes the instruction as typed,
       * picks a run of sections, and returns new HTML for that run. So a narrow
       * verb failing is never a reason to stop — it is a reason to hand the ask
       * to the general path. Only when the general path also declines does the
       * user hear "no".
       *
       * Returns true when it applied something. Callers that get false should
       * report the failure they already had.
       *
       * STATUS: mostly superseded. The region rewrite is now the PRIMARY
       * executor (see the block below), so most of the eleven call sites this
       * was wired into sit inside the leftover dispatcher and no longer run.
       * The ones after that block — scopedFailureReason, the full-page
       * recoveries, html_unchanged — are still live and still worth having.
       *
       * Keep this even as the dead call sites are removed: the fullRebuild and
       * no-markers doors still reach code that can dead-end.
       */
      const tryGeneralFallback = async (reason: string, baseHtml: string): Promise<boolean> => {
        console.warn('[pages/follow-up] narrow path could not act — handing to region rewrite', {
          reason,
          prompt: prompt.slice(0, 160),
        });
        sendSSE(controller, { type: 'status', message: 'Rewriting that part of the page...' });
        let result: Awaited<ReturnType<typeof applyRegionRewriteToHtml>> | null = null;
        try {
          result = await applyRegionRewriteToHtml({
            html: baseHtml,
            instruction: withConstraints(prompt),
            imageUrls: routingImageUrls.length > 0 ? routingImageUrls : undefined,
            imageRoleByUrl: roleByUrl,
            pageSlug: page.slug ?? null,
            schema: finalSchemaJson ?? schema,
            usage: usageCtx,
            // This is already a recovery from a narrow path that failed. The
            // user is owed either an edit or the error we already have — not a
            // question arriving after we half-tried something else.
            conversation: conversationContext,
            // The classifier already named the sections this message is about.
            // Not passing them here is how a two-part ask lost its second half.
            focusSections: intent.targetSections,
            noQuestions: true,
          });
        } catch (err) {
          console.error('[pages/follow-up] region fallback threw', { reason, err });
          return false;
        }
        if (result && result.kind === 'no_change') {
          // Not applied, so this still returns false — but the caller must not
          // then report the narrow path's own failure over the top of a real
          // answer about the page.
          noChangeReason = result.reason;
          console.log('[pages/follow-up] region fallback reported nothing to change', { reason });
          return false;
        }
        if (!result || result.kind === 'failed') {
          console.error('[pages/follow-up] region fallback could not act either', {
            reason,
            regionReason: result?.reason ?? 'threw',
          });
          return false;
        }
        if (result.kind === 'question') {
          // noQuestions was set, so this should not happen. Treat it as "could
          // not act" rather than dropping a question on the user mid-recovery.
          console.warn('[pages/follow-up] region fallback asked despite noQuestions', { reason });
          return false;
        }
        finalHtml = result.html;
        finalSchemaJson = result.schema;
        rewrittenRegion = result.region;
        editorMessage = result.message;
        scopedApplied = true;
        scopedFailureReason = null;
        resultType = 'patch';
        console.log('[pages/follow-up] region rewrite recovered a narrow failure', {
          reason,
          wrote: result.wrote,
        });
        return true;
      };

      // ── Scoped-patch attempt (input-side token reduction) ─────────────────
      // Only attempted when there's no competitor URL (slSections/quoteMatchSection
      // are pre-empted to [] / null above when one is mentioned) and the page
      // actually has SL section markers to scope to. See
      // docs/follow-up-input-scoping.md for the full design + guardrails.
      if (slSections.length > 0) {
        // WHERE the edit belongs, according to the classifier. The quote lookup
        // only counted string matches, so when both have an answer the model's
        // wins.
        //
        // This is a hint, not a decision. It used to initialise targetSections
        // directly, and every downstream branch reads `!targetSections` as "no
        // one has claimed this turn yet" — including the routing call, the ONLY
        // place that can answer "add a section / remove one / reorder / generate
        // an image" rather than "edit an existing one". So the moment the
        // classifier could name a section (which it does for most messages, and
        // is instructed to do), routing was skipped and the system had exactly
        // one verb left: patch. "Add a section like this image" was executed as
        // "edit the hero", and the new content landed nested inside the hero's
        // flex row instead of beside it. Knowing where something goes must never
        // decide what we do to it.
        let pinnedSections: string[] | null =
          intentSections.length > 0
            ? intentSections.slice(0, 3)
            : quoteMatchSection
              ? [quoteMatchSection]
              : null;
        /** Set only once an op has been decided — by routing, or by a scoped path. */
        let targetSections: string[] | null = null;
        // Set only when the routing pass resolved this as a "generate a new
        // image and embed it in 1-3 existing sections" request — the scoped
        // patch call below embeds this URL instead of relying on the
        // instruction text alone. schema_json is intentionally left
        // untouched for this path (see follow-up-input-scoping.md).
        let generatedImageUrl: string | null = null;

        // PRIMARY executor. Sonnet already understands mixed prompts and
        // images. Our job is to give it the instruction and splice what it
        // returns — not to force a menu (op / attachment_roles / routing.type)
        // and execute the nearest button. Fetch-from-URL is mechanics: the
        // model cannot download a file, so we fetch first and hand it the URL.
        if (!scopedApplied && !intent.fullRebuild) {
          regionAttempted = true;
          let rewriteInstruction = withConstraints(prompt);

          if (isLogoSwapAttempt && !logoSwapCompleted) {
            if (request.signal.aborted) { closeSSE(controller); return; }
            sendSSE(controller, { type: 'status', message: 'Fetching logo...' });
            const assets = await fetchLogoAssets(competitorUrls[0]);
            const pageSlugForLogo = page.slug ?? crypto.randomUUID();
            const realLogoUrl = await materializeLogoUrl({
              pageSlug: pageSlugForLogo,
              logoUrl: assets.logoUrl && (await isImageUrl(assets.logoUrl)) ? assets.logoUrl : null,
              logoSvg: assets.logoSvgMarkup,
            });
            const inlineSvgFallback = !realLogoUrl ? assets.logoSvgMarkup : null;
            if (!realLogoUrl && !inlineSvgFallback) {
              sendSSE(controller, {
                type: 'error',
                message: "We couldn't find a usable logo image on that page. Try attaching the logo file directly instead.",
              });
              closeSSE(controller);
              return;
            }
            if (realLogoUrl) {
              routingImageUrls = Array.from(new Set([...routingImageUrls, realLogoUrl]));
              logoSwapAppliedUrl = realLogoUrl;
              rewriteInstruction += `\n\n(A logo file was fetched from the referenced site. Hosted URL:\n${realLogoUrl}\nUse this exact URL in src if the instruction is about a logo. Do not invent a different URL.)`;
            } else if (inlineSvgFallback) {
              rewriteInstruction +=
                '\n\n(The referenced site\'s logo is inline SVG. Recreate that mark in the HTML if the instruction is about a logo; do not invent a raster URL.)';
            }
            logoSwapCompleted = true;
          }

          if (isContentImageSwapAttempt) {
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
            routingImageUrls = Array.from(new Set([...routingImageUrls, photos[0]]));
            rewriteInstruction += `\n\n(A photo was fetched from the referenced site. Hosted URL:\n${photos[0]}\nUse this exact URL in src if the instruction is about placing that photo.)`;
          }

          if (request.signal.aborted) { closeSSE(controller); return; }
          sendSSE(controller, { type: 'status', message: 'Rewriting that part of the page...' });
          let result: Awaited<ReturnType<typeof applyRegionRewriteToHtml>> | null = null;
          try {
            result = await applyRegionRewriteToHtml({
              html,
              instruction: rewriteInstruction,
              imageUrls: routingImageUrls.length > 0 ? routingImageUrls : undefined,
              imageRoleByUrl: roleByUrl,
              pageSlug: page.slug ?? null,
              schema: finalSchemaJson ?? schema,
              usage: usageCtx,
              // The only suppressor, and it is a fact about the conversation:
              // they are answering us, or they told us to decide. Whether the
              // ask itself is clear enough is the model's call, never ours.
              conversation: conversationContext,
              // The classifier already named the sections this message is about.
              // Not passing them here is how a two-part ask lost its second half.
              focusSections: intent.targetSections,
              noQuestions: lastAssistantWasClarify || wantsUsToDecide,
            });
          } catch (err) {
            console.error('[pages/follow-up] primary region rewrite threw', err);
          }
          // The model decided it needs to ask. Surface it verbatim and stop —
          // this is not a failure and must not be retried around.
          if (result && result.kind === 'question') {
            const userEntry: Record<string, unknown> = { role: 'user', content: rawPrompt };
            if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
            // Only THIS turn's imports. The merged list above also holds files carried
            // forward from older entries; re-storing those would copy the whole library
            // onto every turn and grow conversation_json without bound.
            if (currentTurnLibraryCount > 0) userEntry.asset_library = libraryAssets.slice(0, currentTurnLibraryCount);
            await db
              .from('pages')
              .update({
                conversation_json: [
                  ...history,
                  userEntry,
                  // clarify:true is what makes the NEXT turn set noQuestions,
                  // so the model cannot be asked to ask twice in a row.
                  { role: 'assistant', content: result.question, clarify: true },
                ],
                updated_at: new Date().toISOString(),
              })
              .eq('id', params.id);
            sendSSE(controller, { type: 'clarify', message: result.question });
            closeSSE(controller);
            return;
          }
          // Understood, nothing to do. The page is untouched and that is the
          // correct outcome, so this must not fall through to the miss report
          // below — the user is owed the reason, not "I couldn't work out what
          // to change". Stored as an ordinary assistant turn (never
          // clarify:true, which would gag the NEXT turn's question) so a reply
          // of "no, it really isn't there" is handled normally.
          if (result && result.kind === 'no_change') {
            await reportNoChange(result.reason);
            return;
          }
          if (result && result.kind === 'applied') {
            finalHtml = result.html;
            finalSchemaJson = result.schema;
            rewrittenRegion = result.region;
            editorMessage = result.message;
            scopedApplied = true;
            console.log('[pages/follow-up] primary region rewrite applied', {
              wrote: result.wrote,
              message: result.message,
            });
          } else {
            // Carry WHY out to the message. A thrown call never reached the
            // model at all, which is the same class of problem as a provider
            // error, so it is reported as one.
            regionFailReason = result?.kind === 'failed' ? result.reason : 'provider';
            console.warn('[pages/follow-up] primary region rewrite could not act', {
              reason: regionFailReason,
            });
          }
        }

        // ══ LEFTOVER MENU DISPATCHER — MOSTLY UNREACHABLE ══════════════════
        //
        // Everything from here to the matching close (~1700 lines, ending at
        // the "end leftover menu dispatcher" marker) runs ONLY when
        // `regionAttempted` is false. `regionAttempted` is set true directly
        // above whenever `!scopedApplied && !intent.fullRebuild`, so in
        // practice this block is reachable through exactly two doors:
        //
        //   1. `intent.fullRebuild === true` — the classifier says redo the
        //      whole page, so there is no "region" to rewrite.
        //   2. `slSections.length === 0` at the top of the enclosing block —
        //      the page has no <!-- SL:name --> markers, so there is nothing
        //      to resolve a region against. NOTE this is also reached when a
        //      competitor URL is present and the turn is not a logo swap /
        //      content-image swap / scoped-despite-URL edit: slSections is
        //      forced to [] in that case. That second half is a code decision,
        //      not a page property.
        //
        // A normal edit on a normal AI-built page reaches NONE of this. That
        // is deliberate — the menu is the hurdle. But it means these features
        // are effectively switched off, and nothing else re-implements them:
        //
        //   • the multi-step planner (planEditSteps + the retry loop)
        //   • the two OLD clarifying-question exits (plan.mode === 'clarify'
        //     and the routing pass's clarifying_question). Questions are NOT
        //     lost: the region rewrite can now return {"question"} on its own
        //     judgement and the primary path surfaces it. That is the right
        //     shape — the call that read both the page and the ask is the one
        //     that decides whether to ask. Do not revive these two.
        //   • the content-reuse branches (logo/text/image) and the
        //     source-section image reader
        //   • the routing pass (routing.type) and its image_generate path
        //   • every tryGeneralFallback wiring point except the ones after this
        //     block. The contract assertions in
        //     scripts/verify-ai-follow-up-helpers.mjs still pass because they
        //     grep this file — grep cannot tell live code from dead code.
        //
        // Must not run after a rewrite MISS — that is how a nearest-button
        // "Done" used to ship. On a miss we error out below instead.
        //
        // If you delete this block, delete these with it: routing/plan clarify
        // handling, content_reuse.kind, and the dead helpers in
        // ai-content-placement.ts / ai-follow-up-helpers.ts that only this
        // path ever wanted.
        if (!scopedApplied && !regionAttempted) {
        // ── Real-logo swap ────────────────────────────────────────────────
        // See isLogoSwapAttempt comment above for the intent match. This must
        // run before anything else in this block (and short-circuit on its
        // own failure via scopedFailureReason) — otherwise a failed fetch
        // would fall through to the generic routing call below, which has no
        // idea a real logo was supposed to be used and could silently head
        // down the image_generate path, reproducing the exact fake-logo bug
        // this exists to fix.
        if (!scopedApplied && !targetSections && isLogoSwapAttempt && !logoSwapCompleted) {
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

          // The section the user actually named wins. "the logo on nav is wrong"
          // must not touch the footer's logo — that is their page, not ours.
          const namedLogoSection = intentSections.find((n) => slSections.some((s) => s.name === n));
          const navSection = slSections.find((s) => s.name === 'nav') ?? slSections.find((s) => /nav|header/i.test(s.name));
          let logoTargetName: string | null = namedLogoSection ?? navSection?.name ?? null;
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
              // Deterministic fallback, SCOPED to the target section. The
              // whole-page variant used to run here, so a "fix the nav logo" ask
              // rewrote the footer's logo markup too — and when the new asset
              // didn't load, it took a working footer logo down with it.
              const forced = forceEmbedLogoIntoSections(
                applyPatch(html, [{ name: logoTargetName, html: patchResult.html ?? logoSection.html }]),
                [logoTargetName],
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
            finalHtml = forceEmbedLogoIntoSections(html, [logoTargetName], null, inlineSvgFallback);
            scopedApplied = finalHtml !== html;
            if (!scopedApplied) scopedFailureReason = 'logo_swap_svg_embed_failed';
            else console.log('[pages/follow-up] real logo SVG embedded inline', { section: logoTargetName });
          }

          // If they also asked to place the logo in other sections (footer,
          // hero, …), deterministically put the SAME asset there — never invent.
          if (scopedApplied) {
            const place = resolveContentReuse(prompt, slSections.map((s) => s.name));
            if (place?.kind === 'logo') {
              const url = logoSwapAppliedUrl ?? realLogoUrl;
              const svg = url ? null : inlineSvgFallback;
              const placementTargets =
                place.targets.length > 0
                  ? place.targets
                  : await resolveSectionsForAsk({
                      instruction: prompt,
                      sectionOutline: slSections.map((s) => ({ name: s.name, text: s.text })),
                      usage: usageCtx,
                      label: 'follow-up:resolve-logo-placement',
                    });
              const targets = placementTargets.filter((n) => n !== logoTargetName);
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
          const reuse = resolveContentReuse(prompt, slSections.map((s) => s.name));
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
              // Misclassified reuse (e.g. "footer logo size") — fall through to
              // normal scoped/style patch instead of a hard error toast.
              console.warn('[pages/follow-up] content reuse: no target section — falling through', {
                kind: reuse.kind,
              });
            } else if (reuse.kind === 'logo') {
              // Source section wins when named ("same as footer"). Never default
              // to nav-first primary — that re-pastes the wrong asset onto itself.
              let existingLogoUrl: string | null = null;
              let existingSvg: string | null = null;
              const sourceHint = reuse.sourceSectionHint;
              if (sourceHint) {
                const srcName = resolveSourceSectionName(
                  sourceHint,
                  slSections.map((s) => s.name),
                );
                if (srcName) {
                  existingLogoUrl = extractLogoUrlFromSection(html, srcName);
                  targets = targets.filter(
                    (n) => n !== srcName && !n.toLowerCase().includes(sourceHint.toLowerCase()),
                  );
                  console.log('[pages/follow-up] content reuse: logo from section', {
                    source: srcName,
                    url: existingLogoUrl?.slice(0, 120) ?? null,
                    targets,
                  });
                }
              }
              if (!existingLogoUrl && !sourceHint) {
                existingLogoUrl = extractPrimaryLogoUrlFromHtml(html);
                existingSvg = !existingLogoUrl ? extractInlineLogoSvg(html) : null;
              }
              // Prefer page logo; else a user-attached image URL (still a real asset).
              if (!existingLogoUrl && !sourceHint && effectiveImageUrls.length > 0) {
                existingLogoUrl = effectiveImageUrls[0];
              }
              if (!existingLogoUrl && !existingSvg && !sourceHint && competitorUrls.length > 0) {
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
              if (targets.length === 0) {
                // "footer logo" misread as source-only — fall through to style/size patch.
                console.warn('[pages/follow-up] content reuse: logo has source but no dest — falling through', {
                  sourceHint,
                });
              } else if (!existingLogoUrl && !existingSvg) {
                // Named source with nothing to copy — don't fall back to nav primary.
                console.warn('[pages/follow-up] content reuse: no logo in source — falling through', {
                  sourceHint,
                });
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
                // Already had the source asset on every target → real success.
                // Nav-primary no-op used to claim Done while HTML never changed.
                finalHtml = next;
                scopedApplied = true;
                logoSwapAppliedUrl = existingLogoUrl;
                console.log('[pages/follow-up] content reuse: logo placed', {
                  targets,
                  sourceHint,
                  changed: next !== html,
                });
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
                // We could not find the copy to move — that is our reader being
                // narrow, not the request being impossible. Let the general path
                // read the page and do it.
                if (!(await tryGeneralFallback('content_reuse_text_no_payload', html))) {
                  sendSSE(controller, {
                    type: 'error',
                    message:
                      'Quote the exact text to place, or say which section to copy from (e.g. "copy the hero headline to the footer").',
                  });
                  closeSSE(controller);
                  return;
                }
                text = null;
              }
              if (text) {
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
              } else if (!(await tryGeneralFallback('content_reuse_text_failed', html))) {
                scopedFailureReason = 'content_reuse_text_failed';
              }
              }
            } else if (reuse.kind === 'image') {
              // Reuse means COPY WHAT IS ALREADY THERE. Two things were wrong
              // here and they compounded into the worst possible result for
              // "put the image of the hero section here as well":
              //
              // 1. sourceSectionHint was never read — unlike the logo branch
              //    right above, which honours it. "the hero's image" fell back
              //    to extractPrimaryLogoUrlFromHtml: the page LOGO, not the
              //    photo the user pointed at.
              // 2. An attachment outranked the page. But the attachment in that
              //    message was a screenshot showing WHICH section they meant by
              //    "here" — so we pasted a picture of their own page into their
              //    page, and wiped the real photo that was there.
              //
              // The source is whatever the classifier says it is; an attachment
              // is only the asset when the classifier called it a content_asset.
              let existingImg: string | null = null;
              let continueAfterImageReuse = false;
              const imgSourceHint = reuse.sourceSectionHint;
              if (imgSourceHint) {
                const srcName = resolveSourceSectionName(
                  imgSourceHint,
                  slSections.map((s) => s.name),
                );
                if (srcName) {
                  existingImg =
                    extractPrimaryImageFromSection(html, srcName) ??
                    extractLogoUrlFromSection(html, srcName);
                  targets = targets.filter((n) => n !== srcName);
                  console.log('[pages/follow-up] content reuse: image from section', {
                    source: srcName,
                    url: existingImg?.slice(0, 120) ?? null,
                    targets,
                  });
                }
              }
              // Only an attachment the classifier called a content_asset is an
              // asset. A design reference or a "this is the bit I mean"
              // screenshot must never be embedded onto the page.
              const attachedAssets = imageRolesFromIntent(intent, effectiveImageUrls)
                .filter((r) => r.role === 'content_asset')
                .map((r) => r.url);
              if (!existingImg && !imgSourceHint) {
                existingImg = extractPrimaryLogoUrlFromHtml(html);
              }
              if (targets.length === 0) {
                console.warn('[pages/follow-up] content reuse: image has source but no dest — falling through', {
                  sourceHint: imgSourceHint,
                });
                continueAfterImageReuse = true;
              } else if (!existingImg && attachedAssets.length === 0) {
                // Our image reader found nothing to copy. The general path reads
                // the whole region and may well find it.
                if (!(await tryGeneralFallback('content_reuse_image_no_source', html))) {
                  sendSSE(controller, {
                    type: 'error',
                    message: imgSourceHint
                      ? `I couldn't find an image in the ${imgSourceHint} section to copy. Attach the image you want placed, or name the section it's actually in.`
                      : 'Attach the image to place, or make sure a working image is already on the page.',
                  });
                  closeSSE(controller);
                  return;
                }
                continueAfterImageReuse = true;
              }
              if (!continueAfterImageReuse) {
              const imgUrl = existingImg ?? attachedAssets[0];
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
              } else if (!(await tryGeneralFallback('content_reuse_image_failed', html))) {
                scopedFailureReason = 'content_reuse_image_failed';
              }
              }
            }
          }
        }

        // Logo swap is one ask. If the same prompt also asked for other work
        // (left-align, redesign the footer, …), keep going on the updated HTML
        // instead of calling the whole turn Done and skipping those asks.
        if (scopedApplied && isLogoSwapAttempt) {
          logoSwapCompleted = true;
          html = finalHtml;
          slSections = extractSlSections(html);
          if (hasMultipleAsks) {
            scopedApplied = false;
            console.log('[pages/follow-up] logo swap done — continuing remaining asks');
          }
        }

        // DISABLED runNavLogoVisualQaOnce (follow-up:visual-qa).
        // Same reason as the post-upload pass below: ApiFlash captured an S3
        // error page, QA rewrote real sections from that, stripped data-field,
        // and hung the turn for minutes. Intent classification already decides
        // what the user asked for; do not run a pixel rewrite until capture is
        // proven to be our page.

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
        //
        // Gated on the CLASSIFIER, not a keyword test. A regex here decided the
        // request was a plain text swap and marked the edit done — so "change the
        // headline to X and make it bigger" silently shipped with only the text
        // changed. One ask, no reuse/design/asset work, is the only safe case.
        const surgicalEligible =
          intent.asks.length <= 1 &&
          !intent.designReference &&
          !intent.bugReport &&
          !intent.fullRebuild &&
          !intent.contentReuse &&
          !intent.assetSource;
        if (!hasUserImages && !scopedApplied && !scopedFailureReason && surgicalEligible) {
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

        // Per-image roles from intent only (intent is required above).
        if (hasUserImages && !scopedApplied && !scopedFailureReason) {
          const classified = imageRolesFromIntent(intent, effectiveImageUrls);
          console.log('[pages/follow-up] attached image roles from intent', {
            roles: classified.map((c) => c.role),
            designReference: intent.designReference,
          });
          const bugs = classified.filter((c) => c.role === 'bug_reference').map((c) => c.url);
          const assets = classified.filter((c) => c.role === 'content_asset').map((c) => c.url);
          designReferenceUrls = classified.filter((c) => c.role === 'design_reference').map((c) => c.url);
          routingImageUrls = effectiveImageUrls;
          imageRolesClassified = true;
          console.log('[pages/follow-up] attached image roles', {
            bugs: bugs.length,
            assets: assets.length,
            designRefs: designReferenceUrls.length,
          });

          // Only read the words off a reference when they are content to
          // reproduce. For a style-only reference those lines become "required
          // copy" that the page was never meant to contain, and a rewrite that
          // omits them gets thrown away.
          if (wantsReferenceWords && hasUserImages) {
            const ocrUrls = effectiveImageUrls.slice(0, MAX_ATTACHMENTS);
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

          // Classifier-resolved sections pin before routing so "everywhere" /
          // "the top bar" don't need the user to type the internal SL name.
          // Multi-ask leaves this unset so the planner can split targets.
          //
          // These write pinnedSections, NOT targetSections, and that distinction
          // is the whole point. Setting targetSections here skipped the routing
          // call below outright — and routing is the only place that can answer
          // "is this an add / a removal / a reorder / an image to generate?".
          // So attaching a screenshot silently reduced the system to one verb:
          // edit an existing section. "Add a section like this image" had no
          // route to adding, and was carried out as an edit of whichever section
          // got pinned. A hint about WHERE must never decide WHAT.
          if (!targetSections && !hasMultipleAsks && intentSections.length > 0) {
            pinnedSections = intentSections.slice(0, 6);
            console.log('[pages/follow-up] intent section hint', {
              pinnedSections,
              promptPreview: prompt.slice(0, 200),
            });
          } else if (!targetSections && (designReferenceUrls.length > 0 || wantsDesignMatch)) {
            const hinted =
              intentSections.length > 0
                ? intentSections
                : await resolveSectionsForAsk({
                    instruction: prompt,
                    sectionOutline: slSections.map((s) => ({ name: s.name, text: s.text })),
                    imageUrls: routingImageUrls,
                    usage: usageCtx,
                    label: 'follow-up:resolve-design-sections',
                  });
            if (hinted.length >= 1 && hinted.length <= 6) {
              pinnedSections = hinted;
              console.log('[pages/follow-up] design-reference section hint', {
                hinted,
                promptPreview: prompt.slice(0, 200),
              });
            }
          }
        }

        // Multi-intent planner — only when the prompt looks like several
        // distinct asks. Single clear edits skip this (stay fast).
        // Also entered for a SINGLE structural ask. The step executor is the
        // only path that can create, delete or move a section; a lone "add a
        // section like this image" that skipped it had nowhere to go but the
        // patch path, which can only rewrite something that already exists.
        const hasStructuralAsk = intent.asks.some((a) => a.op !== 'edit');
        // UNREACHABLE on a normal edit — see the dispatcher banner above.
        // The multi-step planner and its retry loop no longer run: the whole
        // message goes to the region rewrite as one instruction and the model
        // reads the parts itself. What is genuinely lost here is not
        // comprehension but per-ask VERIFICATION — the planner checked each
        // ask landed. Losing that is why "align them horizontally" could fail
        // silently. Re-add per-ask checking after the rewrite, not here.
        if (!scopedApplied && !scopedFailureReason && (hasMultipleAsks || hasStructuralAsk)) {
          const forceDecidePlan =
            lastAssistantWasClarify ||
            wantsUsToDecide ||
            wantsBugFix ||
            wantsDesignMatch ||
            designReferenceUrls.length > 0;
          sendSSE(controller, { type: 'status', message: 'Planning edits...' });
          const plan = await planMultiIntentEdit({
            prompt,
            sectionNames: slSections.map((s) => s.name),
            sectionPreviews: slSections.map((s) => ({ name: s.name, text: s.text })),
            imageUrls: routingImageUrls,
            forceDecide: forceDecidePlan,
            usage: usageCtx,
            seedAsks: intent && intent.asks.length >= 2 ? intent.asks : undefined,
            constraints: intent.constraints,
            designMatch: wantsDesignMatch,
          });
          console.log('[pages/follow-up] multi-intent plan', {
            promptPreview: prompt.slice(0, 300),
            plan:
              plan.mode === 'execute'
                ? { mode: plan.mode, steps: plan.steps.map((s) => ({ op: s.op, targets: s.target_sections, preview: s.instruction.slice(0, 80) })) }
                : plan,
          });

          // UNREACHABLE on a normal edit — this is the planner's clarify exit,
          // inside the leftover dispatcher. It is no longer the only way a
          // question reaches the user: the region rewrite can now return
          // {"question"} itself, and the primary path surfaces it. See the
          // "When you genuinely cannot tell what was asked" section of
          // SCOPED_REGION_SYSTEM_PROMPT.
          if (plan.mode === 'clarify' && !forceDecidePlan) {
            const question = plan.question;
            const userEntry: Record<string, unknown> = { role: 'user', content: rawPrompt };
            if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
            // Only THIS turn's imports. The merged list above also holds files carried
            // forward from older entries; re-storing those would copy the whole library
            // onto every turn and grow conversation_json without bound.
            if (currentTurnLibraryCount > 0) userEntry.asset_library = libraryAssets.slice(0, currentTurnLibraryCount);
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
            /** Sections that were edited but fell short of the reference wording. */
            const softShortfalls: string[] = [];

            /**
             * The general hand. Anything the fast verbs cannot express goes
             * here rather than degrading into "edit one section" — that silent
             * downgrade is what made "move the footer to the bottom" come back
             * done with the footer still in the middle of the page.
             *
             * Returns the section names it wrote, or null if it could not act
             * (caller records a failure — it must never report success).
             */
            const applyRegionRewrite = async (
              instruction: string,
              images: string[] | undefined,
            ): Promise<string[] | null> => {
              const result = await applyRegionRewriteToHtml({
                html: workingHtml,
                instruction: withConstraints(instruction),
                imageUrls: images,
                imageRoleByUrl: roleByUrl,
                pageSlug: page.slug ?? null,
                schema: finalSchemaJson ?? schema,
                usage: usageCtx,
                // One step of a multi-step plan. Stopping the whole plan
                // half-applied to ask about step 3 leaves the page in a state
                // the user never asked for. The planner's own clarify exit
                // runs before any step executes — that is where a question
                // belongs on this path.
                conversation: conversationContext,
                // The classifier already named the sections this message is about.
                // Not passing them here is how a two-part ask lost its second half.
                focusSections: intent.targetSections,
                noQuestions: true,
              });
              // A step that deliberately changed nothing did NOT apply, so it
              // still returns null and the plan records it as unapplied —
              // returning [] here would claim a step succeeded and let "Done"
              // ship for work that never happened. The reason is kept so the
              // turn's final message can say what is actually true of the page
              // instead of blaming the user's wording.
              if (result.kind === 'no_change') {
                noChangeReason = result.reason;
                return null;
              }
              if (result.kind === 'question' || result.kind === 'failed') return null;
              workingHtml = result.html;
              finalSchemaJson = result.schema;
              // Steps accumulate, so the owned set is the union across steps.
              rewrittenRegion = Array.from(new Set([...(rewrittenRegion ?? []), ...result.region]));
              return result.wrote;
            };

            for (let i = 0; i < plan.steps.length; i++) {
              const step = plan.steps[i];
              if (request.signal.aborted) { closeSSE(controller); return; }
              sendSSE(controller, {
                type: 'status',
                message: `Step ${i + 1}/${plan.steps.length}: ${step.instruction.slice(0, 60)}${step.instruction.length > 60 ? '…' : ''}`,
              });

              const liveSections = extractSlSections(workingHtml);
              // Only the references this ask actually points at. Handing every
              // step every attachment is how "make the footer like this and the
              // nav like that" showed the footer both screenshots.
              const stepImages = step.image_urls ?? routingImageUrls;

              // Creating sections is handled before any target resolution: an
              // "add" step has no existing target, and resolving one would turn
              // it back into a patch — which is exactly how "add a section like
              // this image" ended up rewritten INTO the hero, nested inside its
              // flex row. Anchor only; the new block goes beside it, not in it.
              if (step.op === 'insert_section') {
                // WHERE it goes is a decision, and the classifier is told to
                // leave `sections` empty on an add — so most adds arrive here
                // with no anchor. Taking one from code ("the last section,
                // after it") put every unplaced addition BELOW the footer and
                // pushed the footer into the middle of the page.
                let anchorName =
                  step.target_sections.find((n) => liveSections.some((s) => s.name === n)) ?? null;
                let anchorPosition: 'before' | 'after' = 'after';
                if (!anchorName) {
                  const placement = await resolveInsertPlacement({
                    instruction: step.instruction,
                    sectionOutline: liveSections
                      .filter((s) => s.name !== 'head')
                      .map((s) => ({ name: s.name, text: s.text })),
                    imageUrls: stepImages,
                    usage: usageCtx,
                    label: 'follow-up:resolve-insert-placement',
                  });
                  if (placement) {
                    anchorName = placement.anchor;
                    anchorPosition = placement.position;
                  } else {
                    // Decider unreachable — still place it, but before the
                    // closing section rather than after it. Appending past the
                    // last block is the one placement that is wrong on nearly
                    // every page.
                    anchorName = liveSections.filter((s) => s.name !== 'head').slice(-1)[0]?.name ?? null;
                    anchorPosition = 'before';
                    console.warn('[pages/follow-up] insert placement undecided — placing before the closing section', {
                      anchor: anchorName,
                    });
                  }
                }
                if (!anchorName) {
                  const wrote = await applyRegionRewrite(step.instruction, stepImages);
                  if (wrote) {
                    stepOks.push(...wrote.slice(0, 1));
                  } else {
                    stepFailures.push(`insert_no_anchor:${step.instruction.slice(0, 40)}`);
                  }
                  continue;
                }
                console.log('[pages/follow-up] insert placement', {
                  anchor: anchorName,
                  position: anchorPosition,
                  fromStep: step.target_sections.length > 0,
                });
                // Honour the requested count. Building one and calling it done
                // is how "add 2 sections" silently delivered half the ask.
                const wanted = Math.min(Math.max(step.count ?? 1, 1), 4);
                let addedHere = 0;
                let anchorForNext: string = anchorName;
                let positionForNext: 'before' | 'after' = anchorPosition;
                for (let n = 0; n < wanted; n++) {
                  if (request.signal.aborted) { closeSSE(controller); return; }
                  if (wanted > 1) {
                    sendSSE(controller, {
                      type: 'status',
                      message: `Writing new section ${n + 1}/${wanted}…`,
                    });
                  }
                  const nowSections = extractSlSections(workingHtml);
                  const anchorSection = nowSections.find((s) => s.name === anchorForNext);
                  if (!anchorSection) break;
                  const headSection = nowSections.find((s) => s.name === 'head');
                  const inserted = await runScopedInsert(
                    anchorSection.html,
                    headSection?.html ?? '',
                    nowSections.map((s) => s.name),
                    withConstraints(
                      wanted > 1
                        ? `${step.instruction}\n\n(This is new section ${n + 1} of ${wanted}. Make it distinct from the ones already on the page — do not repeat a section that already exists.)`
                        : step.instruction,
                    ),
                    stepImages,
                    page.slug ?? null,
                    roleByUrl,
                  );
                  if (!inserted) break;
                  const wrappedBlock = `<!-- SL:${inserted.name} -->\n${inserted.html.trim()}\n<!-- /SL:${inserted.name} -->`;
                  const spliced = insertSlSectionBlock(workingHtml, anchorForNext, positionForNext, wrappedBlock);
                  if (!spliced) break;
                  workingHtml = spliced;
                  addedHere++;
                  // Stack the next one after this one so a multi-section add
                  // reads top-to-bottom instead of in reverse — and so a group
                  // placed "before the footer" stays before the footer.
                  anchorForNext = inserted.name;
                  positionForNext = 'after';
                  const newFields = extractDataFieldsFromHtml(inserted.html);
                  if (Object.keys(newFields).length > 0) {
                    const schemaCopy = (finalSchemaJson && typeof finalSchemaJson === 'object'
                      ? JSON.parse(JSON.stringify(finalSchemaJson))
                      : schema && typeof schema === 'object'
                        ? JSON.parse(JSON.stringify(schema))
                        : {}) as Record<string, unknown>;
                    schemaCopy[inserted.name] = newFields;
                    finalSchemaJson = schemaCopy;
                  }
                  stepOks.push(inserted.name);
                }
                if (addedHere < wanted) {
                  stepFailures.push(`insert_incomplete:${addedHere}/${wanted}`);
                }
                continue;
              }

              // Moving a section is also handled before target resolution. A
              // reorder step whose target resolves would otherwise fall through
              // to the scoped-patch loop and "apply" by rewriting that section's
              // own HTML — which cannot move it. That is how "footer should
              // always be at the bottom" came back done, with the footer still
              // sitting in the middle of the page.
              if (step.op === 'reorder_sections') {
                const bodySections = liveSections.filter((s) => s.name !== 'head');
                const newOrder = await resolveSectionOrder({
                  instruction: step.instruction,
                  sectionOutline: bodySections.map((s) => ({ name: s.name, text: s.text })),
                  imageUrls: stepImages,
                  usage: usageCtx,
                  label: 'follow-up:resolve-section-order',
                });
                if (newOrder.length === 0) {
                  const wrote = await applyRegionRewrite(step.instruction, stepImages);
                  if (wrote) {
                    stepOks.push(...wrote.slice(0, 1));
                  } else {
                    stepFailures.push(`reorder_undecided:${step.instruction.slice(0, 40)}`);
                  }
                  continue;
                }
                const currentOrder = bodySections.map((s) => s.name);
                if (newOrder.join('>') === currentOrder.join('>')) {
                  console.log('[pages/follow-up] reorder resolved to the existing order — nothing to move');
                  stepOks.push(...newOrder.slice(0, 1));
                  continue;
                }
                const reordered = reorderSlSections(workingHtml, newOrder);
                if (!reordered) {
                  const wrote = await applyRegionRewrite(step.instruction, stepImages);
                  if (wrote) {
                    stepOks.push(...wrote.slice(0, 1));
                  } else {
                    stepFailures.push(`reorder_failed:${step.instruction.slice(0, 40)}`);
                  }
                  continue;
                }
                // "Done" has to mean the sections moved. Re-read them from the
                // spliced document and require the order we asked for — a
                // splice that quietly dropped or misplaced a block must not be
                // reported as a completed move.
                const resultOrder = extractSlSections(reordered)
                  .filter((s) => s.name !== 'head')
                  .map((s) => s.name);
                if (resultOrder.join('>') !== newOrder.join('>')) {
                  console.error('[pages/follow-up] reorder splice did not produce the decided order', {
                    wanted: newOrder,
                    got: resultOrder,
                  });
                  stepFailures.push(`reorder_verify_failed:${step.instruction.slice(0, 40)}`);
                  continue;
                }
                console.log('[pages/follow-up] sections reordered', { from: currentOrder, to: newOrder });
                workingHtml = reordered;
                stepOks.push(...newOrder.slice(0, 1));
                continue;
              }

              let stepTargets = step.target_sections.filter((n) => liveSections.some((s) => s.name === n));
              if (stepTargets.length === 0) {
                stepTargets = (
                  await resolveSectionsForAsk({
                    instruction: step.instruction,
                    sectionOutline: liveSections.map((s) => ({ name: s.name, text: s.text })),
                    imageUrls: stepImages,
                    usage: usageCtx,
                    label: 'follow-up:resolve-step-sections',
                  })
                ).filter((n) => liveSections.some((s) => s.name === n));
              }

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
                  stepImages,
                  usageCtx,
                );
                if (
                  stepRouting &&
                  (stepRouting.type === 'patch' || stepRouting.type === 'style') &&
                  stepRouting.target_sections?.length >= 1 &&
                  stepRouting.target_sections.every((n) => liveSections.some((s) => s.name === n))
                ) {
                  stepTargets = stepRouting.target_sections.slice(0, 6);
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
                }
              }

              // Nothing the narrow verbs could take. Hand it to the general
              // one rather than dropping it or forcing it through the only
              // remaining path ("edit one section"), which is how requests the
              // model understood perfectly came back done but unchanged.
              if (stepTargets.length === 0 || step.op === 'structural') {
                const wrote = await applyRegionRewrite(step.instruction, stepImages);
                if (wrote) {
                  stepOks.push(...wrote.slice(0, 1));
                  continue;
                }
                if (step.op === 'structural') {
                  // Still unexpressible scoped — let the full-page path have it
                  // rather than half-applying this plan and then rebuilding.
                  stepFailures.push('structural_needs_full_page');
                  break;
                }
                stepFailures.push(`unrouted:${step.instruction.slice(0, 40)}`);
                continue;
              }

              const patched: Array<{ name: string; html: string }> = [];
              // The planner saw the message AND the screenshots — it says
              // whether THIS step means "recreate from the image". A keyword
              // test here sent "make the logo white" down the recreate path.
              const stepIsDesignMatch = step.design_match;
              const stepDesignNote = stepIsDesignMatch
                  ? `\n\n(DESIGN REFERENCE — CRITICAL: Attached images may show how this section should look. Recreate layout/structure/copy from the screenshot in real HTML. Do NOT leave unchanged. Do NOT embed design-reference screenshot URLs as <img src> for the whole section.)`
                  : '';
              for (const name of stepTargets) {
                const section = liveSections.find((s) => s.name === name);
                if (!section) {
                  stepFailures.push(`missing:${name}`);
                  continue;
                }
                const schemaSlice = { [name]: (schema as Record<string, unknown> | null | undefined)?.[name] };
                let patchResult = await runScopedPatchWithRetry(
                  section.html,
                  schemaSlice,
                  withConstraints(step.instruction + stepDesignNote),
                  stepImages,
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
                    withConstraints(step.instruction),
                    stepImages,
                    usageCtx,
                  );
                }
                if (!patchResult.html) {
                  stepFailures.push(`patch_fail:${name}`);
                  continue;
                }
                const verify = verifyScopedPatchIntent({
                  prompt: step.instruction,
                  sectionName: name,
                  beforeHtml: section.html,
                  afterHtml: patchResult.html,
                  intentTargetSections: stepTargets,
                  removalIntent: intent.removalIntent,
                  designMatch: stepIsDesignMatch,
                });
                if (!verify.ok && verify.severity === 'hard') {
                  console.error('[pages/follow-up] multi-intent step failed verify', { name, reason: verify.reason });
                  stepFailures.push(verify.reason ?? `verify_fail:${name}`);
                  continue;
                }
                if (!verify.ok) {
                  // Soft shortfall: the section WAS rewritten, it just didn't
                  // carry enough of the reference wording. Keep the edit and say
                  // so — discarding it is how a real change became "no changes
                  // were applied to the page".
                  console.warn('[pages/follow-up] multi-intent step soft shortfall — keeping edit', {
                    name,
                    reason: verify.reason,
                  });
                  softShortfalls.push(name);
                }
                // The deterministic checks above only prove the HTML moved.
                // "Make the footer logo slightly bigger" changed bytes, left the
                // logo the same size, and was reported as Done — so ask whether
                // the thing requested actually happened. A "no" routes into the
                // existing retry rather than being announced as success.
                const outcome = await verifyAskApplied({
                  instruction: step.instruction,
                  sectionName: name,
                  beforeHtml: section.html,
                  afterHtml: patchResult.html,
                  usage: usageCtx,
                });
                if (!outcome.applied) {
                  console.warn('[pages/follow-up] step did not apply the ask', {
                    name,
                    reason: outcome.reason,
                    instruction: step.instruction.slice(0, 120),
                  });
                  stepFailures.push(`not_applied:${name}`);
                  continue;
                }
                patched.push({ name, html: patchResult.html });
              }

              if (patched.length > 0) {
                workingHtml = applyPatch(workingHtml, patched);
                stepOks.push(...patched.map((p) => p.name));
              }
            }

            if (stepOks.length > 0 && stepFailures.length === 0) {
              finalHtml = workingHtml;
              scopedApplied = true;
              // Every step applied (stepFailures is empty here) — the only doubt
              // is how closely the result matches a reference screenshot. That
              // is a note, not an unfinished ask; routing it through
              // partialMessage made a fully-applied plan announce itself as
              // "Partly done" over a sentence that began "Applied, though…".
              if (softShortfalls.length > 0) {
                const parts = Array.from(new Set(softShortfalls)).join(', ');
                addNote(`The ${parts} may not match the screenshot exactly — tell me what's off.`);
              }
              console.log('[pages/follow-up] multi-intent plan applied', { stepOks, softShortfalls });
            } else if (stepOks.length > 0 && stepFailures.length > 0) {
              // Auto-retry failed steps before accepting a partial outcome.
              sendSSE(controller, { type: 'status', message: 'Finishing remaining edits…' });
              const failedInstructions = plan.steps.filter((s) => {
                // Only a patch step can be retried through the patch path.
                // An insert/remove/reorder step names no target it "owns"
                // (an insert's new section did not exist when the plan was
                // written), so the target test below counts every one of them
                // as failed — even the ones that worked — and re-runs them as
                // edits. That turns "add a section like this image" into
                // "rewrite the hero to look like this image", which is exactly
                // how new content ended up nested inside the hero.
                if (s.op !== 'patch') return false;
                const targets = s.target_sections;
                if (targets.length === 0) return true;
                return targets.some((t) => !stepOks.includes(t));
              });
              const retryFailures: string[] = [];
              for (const step of failedInstructions) {
                const liveSections = extractSlSections(workingHtml);
                const stepImages = step.image_urls ?? routingImageUrls;
                let stepTargets = step.target_sections.filter((n) => liveSections.some((s) => s.name === n));
                if (stepTargets.length === 0) {
                  stepTargets = (
                    await resolveSectionsForAsk({
                      instruction: step.instruction,
                      sectionOutline: liveSections.map((s) => ({ name: s.name, text: s.text })),
                      imageUrls: stepImages,
                      usage: usageCtx,
                      label: 'follow-up:resolve-step-sections-retry',
                    })
                  ).filter((n) => liveSections.some((s) => s.name === n));
                }
                if (stepTargets.length === 0) {
                  const stepRouting = await tryRoutingCall(
                    step.instruction,
                    schema,
                    liveSections,
                    stepImages,
                    usageCtx,
                  );
                  if (
                    (stepRouting?.type === 'patch' || stepRouting?.type === 'style') &&
                    stepRouting.target_sections?.length >= 1 &&
                    stepRouting.target_sections.every((n) => liveSections.some((s) => s.name === n))
                  ) {
                    stepTargets = stepRouting.target_sections.slice(0, 6);
                  }
                }
                if (stepTargets.length === 0) {
                  retryFailures.push(`unrouted:${step.instruction.slice(0, 40)}`);
                  continue;
                }
                // Planner-decided, same as the first pass.
                const stepIsDesignMatch = step.design_match;
                const patched: Array<{ name: string; html: string }> = [];
                for (const name of stepTargets) {
                  if (stepOks.includes(name)) continue;
                  const section = liveSections.find((s) => s.name === name);
                  if (!section) {
                    retryFailures.push(`missing:${name}`);
                    continue;
                  }
                  const schemaSlice = {
                    [name]: (schema as Record<string, unknown> | null | undefined)?.[name],
                  };
                  const patchResult = await runScopedPatchWithRetry(
                    section.html,
                    schemaSlice,
                    withConstraints(
                      step.instruction +
                        '\n\n(RETRY — previous attempt failed. Apply this edit completely.)',
                    ),
                    routingImageUrls,
                    usageCtx,
                  );
                  if (!patchResult.html) {
                    retryFailures.push(`patch_fail:${name}`);
                    continue;
                  }
                  const verify = verifyScopedPatchIntent({
                    prompt: step.instruction,
                    sectionName: name,
                    beforeHtml: section.html,
                    afterHtml: patchResult.html,
                    requiredPhrases:
                      designCopyLines.length > 0 && stepIsDesignMatch ? designCopyLines : null,
                    intentTargetSections: stepTargets,
                    removalIntent: intent.removalIntent,
                    designMatch: stepIsDesignMatch,
                  });
                  if (!verify.ok && verify.severity === 'hard') {
                    retryFailures.push(verify.reason ?? `verify_fail:${name}`);
                    continue;
                  }
                  if (!verify.ok) {
                    console.warn('[pages/follow-up] retry step soft shortfall — keeping edit', {
                      name,
                      reason: verify.reason,
                    });
                    softShortfalls.push(name);
                  }
                  patched.push({ name, html: patchResult.html });
                }
                if (patched.length > 0) {
                  workingHtml = applyPatch(workingHtml, patched);
                  stepOks.push(...patched.map((p) => p.name));
                }
              }

              // Keep every successful step. A leftover miss must not rebuild
              // the page (that wipes the wins) or toast the whole turn as one error.
              finalHtml = workingHtml;
              scopedApplied = true;
              if (retryFailures.length > 0) {
                const miss = retryFailures[0].replace(/_/g, ' ');
                partialMessage = partialMessage
                  ? `${partialMessage} Some parts still need a follow-up.`
                  : `Applied part of that request. Some parts still need a follow-up (${miss}).`;
                console.warn('[pages/follow-up] multi-intent partial after retry — keeping wins', {
                  stepOks,
                  retryFailures,
                });
              } else {
                console.log('[pages/follow-up] multi-intent completed after retry', { stepOks });
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
        // After a successful logo swap we only reach here when the prompt
        // still has leftover asks (footer / alignment) — routing may handle
        // those, but image_generate stays forbidden.
        if (!scopedApplied && !targetSections && !scopedFailureReason) {
          sendSSE(controller, { type: 'status', message: 'Locating section...' });
          const routing = await tryRoutingCall(prompt, schema, slSections, routingImageUrls, usageCtx);
          captureModelRequirements(routing);
          const basicShapeOk = !!routing &&
            (routing.type === 'patch' || routing.type === 'style') &&
            routing.target_sections.length >= 1 &&
            routing.target_sections.length <= 6 &&
            routing.target_sections.every((n) => slSections.some((s) => s.name === n));
          // Haiku has repeatedly under-rated its own confidence when it
          // correctly identifies the section but hedges on an unrelated
          // ambiguity (e.g. "which image is this replacing", not "which
          // section"). Prompt-wording alone hasn't fixed this reliably, so
          // when it names exactly one section AND that section's name is
          // literally present in the instruction text, trust that
          // independent textual confirmation over Haiku's self-rating.
          // Classifier-resolved sections count the same as typing the name.
          // Corroboration for a hedging router: the classifier independently
          // resolved this same section. Was also matched against the raw prompt
          // text by regex — dropped, since "the section name appears in your
          // wording" is exactly the keyword reasoning being removed.
          const namesItsSingleSection = !!routing && basicShapeOk && routing.target_sections.length === 1 &&
            intentSections.includes(routing.target_sections[0]);
          // Declared early so forceDecide can relax confidence for proceed-anyway.
          // The "soft copy polish" keyword pair that used to sit here is gone —
          // the classifier already tells us when the user deferred to us
          // (proceedAnyway) or handed us a reference, and a word like "better"
          // was never evidence of anything.
          const forceDecideEarly =
            lastAssistantWasClarify ||
            wantsUsToDecide ||
            wantsBugFix ||
            wantsDesignMatch ||
            designReferenceUrls.length > 0;
          const routingQualifies = basicShapeOk && (
            routing!.confidence === 'high' ||
            namesItsSingleSection ||
            forceDecideEarly
          );

          const imageGenerateShapeOk = !!routing &&
            !logoSwapCompleted &&
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
            !!routing && shouldForceClarifyFaqVsForm(routing, hasUserImages, intentSections);

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

          // UNREACHABLE on a normal edit — clarify exit #2 of 2. See exit #1
          // at plan.mode === 'clarify' above for why, and for the fix if the
          // product wants to ask questions again.
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
            const userEntry: Record<string, unknown> = { role: 'user', content: rawPrompt };
            if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
            // Only THIS turn's imports. The merged list above also holds files carried
            // forward from older entries; re-storing those would copy the whole library
            // onto every turn and grow conversation_json without bound.
            if (currentTurnLibraryCount > 0) userEntry.asset_library = libraryAssets.slice(0, currentTurnLibraryCount);
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
            const routed = (routing as { target_sections: string[] }).target_sections;
            const inferred =
              intentSections.length > 0
                ? intentSections.slice(0, 6)
                : await resolveSectionsForAsk({
                    instruction: prompt,
                    sectionOutline: slSections.map((s) => ({ name: s.name, text: s.text })),
                    imageUrls: routingImageUrls,
                    usage: usageCtx,
                    label: 'follow-up:resolve-target-sections',
                  });
            // Classifier / "everywhere" beats a style→head dump.
            targetSections = inferred.length > 0 ? inferred : routed;
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
            const inserted = await runScopedInsert(anchorSection.html, headSection?.html ?? '', usedNames, withConstraints(prompt), routingImageUrls, page.slug ?? null, roleByUrl);
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
            const generatedUrl = await generateAndUploadImage(routing!.image_prompt!, pageSlugForImage, 'high');
            if (generatedUrl) {
              sendSSE(controller, { type: 'image_ready', url: generatedUrl });
              targetSections = routing!.target_sections;
              generatedImageUrl = generatedUrl;
            } else {
              console.error('[pages/follow-up] image_generate routing qualified but image generation failed — this is our own bug, not falling back to full-page', { routing });
              scopedFailureReason = 'image_generate_failed';
            }
          } else if (pinnedSections && pinnedSections.length > 0 && !narrowScopedType) {
            // Routing couldn't shape an op, but the classifier did read the
            // message and name a place. Patch there rather than rebuilding the
            // whole page — this is what the section hint is FOR ("the top bar",
            // "everywhere"), now that it informs the decision instead of
            // pre-empting it. Skipped when routing did name a narrow op, since
            // that op (insert/remove/reorder) is a better answer than a patch.
            targetSections = pinnedSections.slice(0, 6);
            console.log('[pages/follow-up] routing unusable — patching classifier-named sections', {
              targetSections,
              routingType: routing?.type ?? null,
            });
          } else {
            // Before paying for a full-page rebuild, try the general hand.
            // "Split this section in two", "swap these", "merge these" are
            // single, plainly-worded instructions that no narrow verb can
            // express — routing correctly declines them, and the only thing
            // left used to be regenerating the whole page, which is the slow
            // path that drops images and click-to-edit handles. A region
            // rewrite expresses the same change without putting the rest of
            // the page at risk.
            sendSSE(controller, { type: 'status', message: 'Rewriting that part of the page...' });
            const regionResult = await applyRegionRewriteToHtml({
              html,
              instruction: withConstraints(prompt),
              imageUrls: routingImageUrls,
              imageRoleByUrl: roleByUrl,
              pageSlug: page.slug ?? null,
              schema: finalSchemaJson ?? schema,
              usage: usageCtx,
              conversation: conversationContext,
              // The classifier already named the sections this message is about.
              // Not passing them here is how a two-part ask lost its second half.
              focusSections: intent.targetSections,
              noQuestions: lastAssistantWasClarify || wantsUsToDecide,
            });
            // Single-instruction turn, nothing applied yet — a question here is
            // as legitimate as it is on the primary path.
            if (regionResult && regionResult.kind === 'question') {
              const userEntry: Record<string, unknown> = { role: 'user', content: rawPrompt };
              if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
              // Only THIS turn's imports. The merged list above also holds files carried
              // forward from older entries; re-storing those would copy the whole library
              // onto every turn and grow conversation_json without bound.
              if (currentTurnLibraryCount > 0) userEntry.asset_library = libraryAssets.slice(0, currentTurnLibraryCount);
              await db
                .from('pages')
                .update({
                  conversation_json: [
                    ...history,
                    userEntry,
                    { role: 'assistant', content: regionResult.question, clarify: true },
                  ],
                  updated_at: new Date().toISOString(),
                })
                .eq('id', params.id);
              sendSSE(controller, { type: 'clarify', message: regionResult.question });
              closeSSE(controller);
              return;
            }
            if (regionResult.kind === 'applied') {
              finalHtml = regionResult.html;
              finalSchemaJson = regionResult.schema;
              rewrittenRegion = regionResult.region;
              editorMessage = regionResult.message;
              scopedApplied = true;
            } else {
              console.log('[pages/follow-up] routing did not qualify and no region resolved, falling back to full-page path', {
                routing,
                knownSectionNames: slSections.map((s) => s.name),
              });
            }
          }
        }

        if (!scopedApplied && targetSections && targetSections.length > 0) {
          if (request.signal.aborted) { closeSSE(controller); return; }
          sendSSE(controller, { type: 'status', message: 'Applying patch...' });

          const scopedPrompt = generatedImageUrl
            ? `${prompt}\n\n(A brand-new image has just been generated to satisfy this request — it is attached below, and it is the FINAL, intended replacement. Regardless of how the instruction above orders the words "replace/with/current/new" — real users often phrase this ambiguously (e.g. "create a new X and replace with the current one" is meant as "replace the current X with this new one", NOT "keep the current one" or "revert") — you must make this section visibly display the attached image in place of whatever currently represents it. If the current logo/element is an <img> tag, swap its src to the attached image URL. If it is instead built from inline <svg>/icon markup (common for hand-drawn logo icons), you MUST delete that entire inline SVG/icon markup and replace it with a single <img src="ATTACHED_IMAGE_URL" alt="logo" style="height:<match the icon's original rendered height>; width:auto;"> in its place — do not leave the old SVG/icon untouched alongside or instead of the new image. Do not leave the section unchanged and do not generate or invent a different image URL.)`
            : prompt;
          const designNote =
            designCopyLines.length > 0
              ? `\n\nREQUIRED visible copy from an attached screenshot — each of these strings MUST appear verbatim in the section HTML:\n` +
                designCopyLines.map((l, i) => `${i + 1}. ${l}`).join('\n')
              : '';
          const embedNote = attachedImagesInstructionNote(routingImageUrls, roleByUrl);
          const scopedPromptFinal = scopedPrompt + designNote + embedNote;
          // Vision + URL list: every attachment. Instruction decides which go in src.
          const scopedImageUrls = generatedImageUrl
            ? Array.from(new Set([...routingImageUrls, generatedImageUrl]))
            : routingImageUrls;

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
            let patchResult = await runScopedPatchWithRetry(section.html, schemaSlice, scopedPromptFinal, scopedImageUrls, usageCtx, roleByUrl);
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
              intentTargetSections: intentSections.length > 0 ? intentSections : targetSections,
              removalIntent: intent.removalIntent,
              designMatch: wantsDesignMatch || designReferenceUrls.length > 0,
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
                  intentTargetSections: intentSections.length > 0 ? intentSections : targetSections,
                  removalIntent: intent.removalIntent,
                  designMatch: wantsDesignMatch || designReferenceUrls.length > 0,
                });
              }
            }
            if (!verify.ok && verify.severity === 'hard') {
              console.error('[pages/follow-up] scoped patch failed intent verify', {
                section: name,
                reason: verify.reason,
                promptPreview: prompt.slice(0, 300),
              });
              scopedFailureReason = verify.reason;
              allOk = false;
              break;
            }
            if (!verify.ok) {
              // The rewrite happened; it just carries less of the reference
              // wording than we'd like — even after the forced retry above. Ship
              // it and name the gap rather than throwing the edit away.
              console.warn('[pages/follow-up] scoped patch soft shortfall — keeping edit', {
                section: name,
                reason: verify.reason,
              });
              // The rewrite IS on the page — a note, not an unfinished ask.
              addNote(`The ${name} was rewritten but may not match the screenshot's wording exactly.`);
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
        } // ══ end leftover menu dispatcher (unreachable unless fullRebuild or
          //    no SL markers — see the banner where this block opens) ════════

      }

      // Region rewrite was the job. It did not land. Do not press a menu
      // button or regenerate the whole page — that is the hurdle.
      //
      // Trade-off recorded on purpose: this replaced a full-page-rebuild retry.
      //
      // Misses should be rare, and NOT because the model is unreliable at the
      // task. ai-client already retries the transient failures itself
      // (429/500/502/503/504/529, AI_TRANSIENT_MAX_ATTEMPTS), so overload and
      // rate limiting never reach here. What is left:
      //   • the reply hit maxTokens mid-JSON and jsonrepair could not save it —
      //     the one real risk, and it scales with region size, so it is
      //     coupled to the whole-body fallback in applyRegionRewriteToHtml
      //   • the model renamed a section, so the splice-survival check rejects
      //     an otherwise fine rewrite
      // Both are edge cases. Telling the user to try again is the right answer
      // for an edge case. If the logs say otherwise, retry
      // applyRegionRewriteToHtml once here — do not reopen the dispatcher.
      if (!scopedApplied && regionAttempted) {
        // A recovery attempt may have come back with "nothing to change" —
        // that is an answer about the page, and it outranks the earlier
        // failure it was recovering from.
        if (noChangeReason) {
          await reportNoChange(noChangeReason);
          return;
        }
        console.error('[pages/follow-up] primary region rewrite missed — not dispatching a menu', {
          reason: regionFailReason,
        });
        sendSSE(controller, {
          type: 'error',
          message: regionFailureMessage(regionFailReason),
        });
        closeSSE(controller);
        return;
      }

      // A scoped op was already qualified (routing/quote-match confidently
      // identified what to do) and OUR OWN code then failed to execute it —
      // stop here instead of silently retrying as an expensive/oversized
      // full-page rebuild that would misattribute the failure to vague
      // wording. See scopedFailureReason assignments above for the exact
      // failure site.
      if (!scopedApplied && scopedFailureReason && !logoSwapCompleted &&
          !(await tryGeneralFallback(scopedFailureReason, html))) {
        // The recovery ran and reported there was nothing to change — say that
        // rather than the narrow path's "couldn't apply the edit cleanly".
        if (noChangeReason) {
          await reportNoChange(noChangeReason);
          return;
        }
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

      // Logo already landed. Do not fall into a full-page competitor rebuild
      // (that's the multi-minute path). Persist the logo work; leftover asks
      // were handled above when routing/multi-intent could, otherwise named.
      if (!scopedApplied && logoSwapCompleted) {
        scopedApplied = true;
        if (!finalHtml) finalHtml = html;
        if (scopedFailureReason) {
          partialMessage = partialMessage
            ? partialMessage
            : 'Logo is in. Some other parts of that request still need a follow-up.';
          scopedFailureReason = null;
        }
      }

      // ── Fallback: today's full-page single-call path, unchanged ──────────
      if (!scopedApplied) {
      // Classify attachments if we skipped the scoped path (e.g. competitor URL)
      if (hasUserImages && !imageRolesClassified) {
        const classified = imageRolesFromIntent(intent, effectiveImageUrls);
        designReferenceUrls = classified.filter((c) => c.role === 'design_reference').map((c) => c.url);
        routingImageUrls = effectiveImageUrls;
        imageRolesClassified = true;
      }

      // Only scrape/rebuild from a URL when the user asked for a redesign/clone.
      // Incidental URLs on local edits skip scrape (keeps huge-page path rare).
      const shouldScrapeCompetitor =
        competitorUrls.length > 0 &&
        !logoSwapCompleted &&
        (intent.fullRebuild || (!isScopedDespiteUrl && !isContentImageSwapAttempt));

      if (shouldScrapeCompetitor) {
        scrapeAttempted = true;
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
                text: attachedImagesInstructionNote(routingImageUrls, roleByUrl).trim(),
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

      // Empty when the region rewrite recovered a too-long failure — the guard
      // below skips every reader of it in that case.
      let pass1Text = '';
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
            // A dropped stream restarts the answer from the top — the partial
            // JSON collected so far would corrupt the thinking match.
            onStreamRestart: () => {
              pass1Buffer = '';
            },
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
          // "Too big for one pass" is the one failure the region rewrite is
          // structurally better at: it sends a run of sections, not the page.
          // Telling the user to split the request themselves, while holding a
          // path that already splits it, is the code being the hurdle.
          if (!(await tryGeneralFallback('full_page_too_long', html))) {
            sendSSE(controller, {
              type: 'error',
              message: hasCompetitorContext
                ? "This page is too large to rebuild alongside a competitor reference in one pass. Try a more specific change, or split the request into smaller edits."
                : 'This page is too large for a full-page edit. Try a more specific change (name the section or quote the text to change), or split the request into smaller edits.',
            });
            closeSSE(controller);
            return;
          }
        } else {
        throw err;
        }
      }

      // The region rewrite already did the work for the too-long case above.
      // Everything from here to the end of this block is the full-page attempt,
      // and re-running it would undo what just succeeded.
      if (!scopedApplied) {
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
        message?: string;
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
        if (!(await tryGeneralFallback('full_page_invalid_json', html))) {
          sendSSE(controller, { type: 'error', message: 'AI provider returned invalid JSON' });
          closeSSE(controller);
          return;
        }
        parsed = { type: 'patch', sections: [] };
      }

      resultType = parsed.type;

      // The full-page rewrite speaks for itself, same as the region rewrite.
      // `??` rather than `=`: when the region rewrite already ran and recovered
      // this turn (`scopedApplied`), ITS sentence describes the work the user
      // actually got, and `parsed` here may be the invalid-JSON sentinel. A
      // plain assignment would overwrite a real message with nothing.
      editorMessage = editorMessage ?? normalizeEditorMessage(parsed.message);

      let structuralRecovered = false;
      if (scopedApplied) {
        // The region rewrite already recovered this turn (unparseable pass-1
        // output, above). Running a branch off the sentinel `parsed` would fire
        // a second rewrite over the first one's result.
        console.log('[pages/follow-up] full-page path already recovered by region rewrite');
      } else if (parsed.type === 'structural') {
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
            imageUrls: routingImageUrls,
            styleReferenceNote,
            skills: savedSkills,
            styleTag: savedStyle,
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
          const tooLong = isPromptTooLongError(err);
          console.error(
            tooLong
              ? '[pages/follow-up] structural rebuild exceeded model context limit'
              : '[pages/follow-up] structural rebuild failed',
            { promptLength: prompt.length, htmlLength: htmlForModel.length, hasCompetitorContext, err },
          );
          // A full rebuild failing is not the ask failing. The region rewrite
          // works on a run of sections, so it survives both the size limit and
          // a rebuild that came back unusable.
          if (
            !(await tryGeneralFallback(
              tooLong ? 'structural_rebuild_too_long' : 'structural_rebuild_failed',
              html,
            ))
          ) {
            sendSSE(controller, {
              type: 'error',
              message: tooLong
                ? hasCompetitorContext
                  ? 'This page is too large to rebuild alongside a competitor reference in one pass. Try a more specific change, or split the request into smaller edits.'
                  : 'This page is too large for a full-page edit. Try a more specific change (name the section or quote the text to change), or split the request into smaller edits.'
                : 'AI provider returned invalid HTML',
            });
            closeSSE(controller);
            return;
          }
          structuralRecovered = true;
        }
        } // end full-rebuild fallback (diff+splice not eligible/failed)

        // The region rewrite already produced a schema in step with the HTML it
        // wrote. Overwriting it with the failed rebuild's schema would leave the
        // page and its click-to-edit map describing different documents.
        if (!structuralRecovered) finalSchemaJson = enrichedSchema;
      } else if (parsed.type === 'patch') {
        // Patch — apply changed sections onto stored HTML
        if (!parsed.sections || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
          if (!(await tryGeneralFallback('full_page_invalid_patch', html))) {
            sendSSE(controller, { type: 'error', message: 'AI provider returned invalid patch' });
            closeSSE(controller);
            return;
          }
        } else {
        sendSSE(controller, { type: 'status', message: 'Applying patch...' });
        finalHtml = applyPatch(html, parsed.sections);
        }
      } else {
        // Style — Claude returns complete HTML directly
        if (!parsed.html || (!parsed.html.startsWith('<!DOCTYPE') && !parsed.html.startsWith('<html'))) {
          if (!(await tryGeneralFallback('full_page_invalid_html', html))) {
            sendSSE(controller, { type: 'error', message: 'AI provider returned invalid HTML' });
            closeSSE(controller);
            return;
          }
        } else {
        finalHtml = parsed.html;
        }
      }
      } // end region-recovered guard
      } // end fallback full-page path (!scopedApplied)

      // Strip STATUS comments before upload
      finalHtml = finalHtml.replace(/<!--\s*STATUS:[^>]*-->/g, '');

      // Fail-closed: content-reuse asks must leave the exact asset in targets.
      if (finalHtml) {
        const reuseFinal = resolveContentReuse(prompt, extractSlSections(finalHtml).map((s) => s.name));
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
      let htmlUnchanged = finalHtml === html;

      // A silent no-op is not an answer. The model had the page and the ask and
      // handed back byte-identical HTML — "remove this" with a screenshot died
      // here twice in staging. Retry once against the section the classifier
      // resolved, telling it plainly that its last attempt changed nothing.
      // Only reachable now that the classifier receives the section outline and
      // can actually resolve a demonstrative like "this strip" to a section.
      if (htmlUnchanged) {
        const retryTargets = Array.from(
          new Set([...intent.targetSections, ...intent.asks.flatMap((a) => a.sections)]),
        ).slice(0, 2);
        if (retryTargets.length > 0) {
          const liveSections = extractSlSections(html);
          const patched: { name: string; html: string }[] = [];
          for (const name of retryTargets) {
            const section = liveSections.find((s) => s.name === name);
            if (!section) continue;
            const askText =
              intent.asks.find((a) => a.sections.includes(name))?.instruction ?? prompt;
            sendSSE(controller, { type: 'status', message: 'Retrying that change…' });
            const retry = await runScopedPatchWithRetry(
              section.html,
              { [name]: (schema as Record<string, unknown> | null | undefined)?.[name] },
              `${askText}\n\n(RETRY — your previous attempt returned this section completely unchanged, which means the edit was not applied. The user is pointing at something real in this section${hasUserImages ? ' (see the attached image)' : ''}. Identify it and apply the change now. Keep every data-field attribute so the text stays click-to-editable.)`,
              routingImageUrls,
              usageCtx,
            );
            if (retry.html && retry.html !== section.html) {
              patched.push({ name, html: retry.html });
            }
          }
          if (patched.length > 0) {
            finalHtml = applyPatch(html, patched);
            htmlUnchanged = finalHtml === html;
            scopedApplied = true;
            console.log('[pages/follow-up] no-op retry applied', {
              sections: patched.map((p) => p.name),
            });
          } else {
            console.warn('[pages/follow-up] no-op retry still produced no change', { retryTargets });
          }
        }
      }

      // The single line that answers "did Done actually mean something changed" —
      // without this, a technically-successful AI call that didn't apply the
      // requested edit is indistinguishable in logs from one that did.
      console.log('[pages/follow-up] request resolved', {
        promptPreview: prompt.slice(0, 300),
        scopedApplied,
        resultType,
        htmlUnchanged,
      });

      // Last stop before telling the user no. Every path above ran and the page
      // is byte-identical, which means nothing we tried could express the ask —
      // exactly the case the general path exists for. Try it before giving up;
      // "I couldn't apply that" should be the last thing we say, not the first.
      if (htmlUnchanged && (await tryGeneralFallback('html_unchanged', html))) {
        htmlUnchanged = finalHtml === html;
      }

      if (htmlUnchanged) {
        // Byte-identical because the model decided the page already says what
        // was asked for — not because we failed to understand it.
        if (noChangeReason) {
          await reportNoChange(noChangeReason);
          return;
        }
        const designMatch =
          !hasMultipleAsks && (designReferenceUrls.length > 0 || wantsDesignMatch);
        // Name EVERY ask that failed, not just the one whose wording happened to
        // match a keyword. A two-part message that fails both used to get a
        // single line worded for one of them, hiding the other failure entirely.
        const failedAsks = intent.asks
          .map((a) => a.instruction.trim())
          .filter((s) => s.length > 0)
          .slice(0, 4);
        const askList =
          failedAsks.length > 1
            ? ` None of these applied: ${failedAsks.map((a, i) => `(${i + 1}) ${a}`).join(' ')}`
            : '';
        // Say what we DID understand — "rephrase" is useless when the real
        // problem is that we couldn't tell which part of the page they meant.
        const noTargetResolved =
          intent.targetSections.length === 0 && intent.asks.every((a) => a.sections.length === 0);
        const guidance = noTargetResolved
          ? hasUserImages
            ? 'I couldn’t tell which part of the page that image is showing. Name the section (nav, hero, footer, …) along with it and I’ll apply it.'
            : 'I couldn’t tell which part of the page you meant. Name the section (nav, hero, footer, …) and what should change.'
          : designMatch
            ? 'Could not match the attached design reference to the page. Try attaching a clearer crop of just that section.'
            : 'The edit came back identical to the current page. Give me the exact change you want — a value (“nav background #0f2540”) or the exact text to replace.';
        sendSSE(controller, {
          type: 'error',
          message: `I couldn’t apply that.${askList} ${guidance}`,
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

      // ── The page as it was, addressed the way the page is addressed NOW ───
      //
      // Everything below compares the edited page against the page as it stood
      // before the edit, to catch content the model dropped. That comparison is
      // made on image URLs — and the re-host above just REWROTE image URLs on
      // one side of it.
      //
      // So an image nobody touched appeared in "before" as
      //   image-service.unbounce.com/https%3A%2F%2F…46afbae4
      // and in "after" as
      //   …supabase.co/storage/…/abc123.png
      // and the diff, seeing the first string missing, called it deleted.
      //
      // Confirmed live, on a request that only changed a headline: 6 phantom
      // "lost" images, one repair model call each (~90s apiece, 514s total),
      // and — because those images had never actually gone anywhere — the
      // repair added a SECOND copy of each. Duplicate logo rows on the page,
      // caused entirely by the guard meant to protect it.
      //
      // findUnrequestedLosses does try to survive this by comparing filename
      // tails, but that assumes a URL ends in a filename. These end in the
      // whole original link with its slashes percent-encoded, so the "tail" is
      // the entire blob and never matches anything. The guard was silently
      // inert for exactly the pages that needed it.
      //
      // Applying the same map to the before-copy makes both sides speak the
      // same addresses, so a re-host is invisible to the diff and only real
      // losses survive. Preferred over reordering the two steps: sixteen call
      // sites downstream read this baseline, several of them looking assets up
      // BY URL in it (restoreLostImagesInPlace, sectionsContainingAsset,
      // placeRestoredImagesIntelligently), and those must resolve against the
      // same addresses the edited page now uses or a genuine restore would
      // fail to find its own image.
      //
      // Ideally nothing is left to re-host by this point — from-html,
      // schema-from-html and rebuild-flow all run the same scan first. This
      // stays for what they cannot cover: an external image the user pastes
      // mid-edit, or one the model writes itself.
      const preservationBaseline =
        Object.keys(assetScan.rehostedMap).length > 0
          ? applyRehostMap(originalHtmlForPreservation, assetScan.rehostedMap)
          : originalHtmlForPreservation;

      // Requirements: what the user actually asked for, checked against what we
      // built. Deterministic fixes are applied here; anything still unmet
      // downgrades the toast instead of claiming Done.
      const editRequirementAssets = [
        typeof finalSchemaJsonReal?.brand_logo_url === 'string'
          ? (finalSchemaJsonReal.brand_logo_url as string)
          : null,
        competitorContext?.logoUrl ?? null,
      ].filter((u): u is string => !!u && finalHtmlPersisted.includes(u));

      // The model that read the request wrote the checks; the only thing code
      // adds is "an asset we ourselves embedded is present". No prompt-derived
      // guessing — that is what invented required copy nobody asked for.
      const requirements = mergeRequirements(
        modelRequirements,
        assetRequirements(editRequirementAssets),
      );
      if (requirements.length > 0) {
        const enforced = enforceRequirements(finalHtmlPersisted, requirements);
        finalHtmlPersisted = enforced.html;
        if (enforced.applied.length > 0) {
          console.log('[pages/follow-up] requirements enforced', enforced.applied);
        }
        let results = checkRequirements(finalHtmlPersisted, requirements, {
          beforeHtml: preservationBaseline,
        });

        // FIX IT, don't just announce it.
        //
        // This is the last and most reliable check in the turn: the model wrote
        // its own checklist from the request, and this catches what every
        // earlier retry missed (runScopedPatchWithRetry, the no-op retry, the
        // multi-step retry pass). It was also the ONLY check with no retry at
        // all — it printed "Still not applied: 2 skills removed from skills
        // section" and gave up, and the user was told to re-ask for something we
        // had already diagnosed precisely enough to describe in a sentence.
        //
        // retryInstructionFor() was written and unit-tested for exactly this and
        // never called by any route — a safety net built and left unplugged.
        //
        // Safety, in order:
        //  • one pass only, so a stubborn requirement cannot loop the turn
        //  • the candidate is kept ONLY if it fixes something and breaks nothing
        //    that was already passing (compared by index — same requirements
        //    array both times, so labels can't collide)
        //  • on any other outcome the pre-retry page stands and we report as
        //    before, so this can never leave the page worse than not trying
        //  • runs BEFORE the loss guard below, so anything it damages is still
        //    caught, repaired, or rejected there
        if (results.some((r) => !r.passed) && !request.signal.aborted) {
          // Deleting is not a patch. It happens by splicing out the marker block
          // (removeSlSection / the planner's remove op / the full-page `deleted`
          // list) and normally succeeds, in which case section_absent PASSES and
          // there is nothing to retry. Reaching here means the delete already
          // failed — and a scoped patch cannot finish the job, because
          // runScopedPatchWithRetry requires the outer tag back intact. So the
          // call would be spent and discarded every time. Reported as unmet.
          const retryable = results.filter((r) => !r.passed && r.requirement.kind !== 'section_absent');
          const fixInstruction = retryInstructionFor(retryable);
          const failedSections = Array.from(
            new Set(retryable.flatMap((r) => r.requirement.sections ?? [])),
          );
          const availableSections = extractSlSections(finalHtmlPersisted);
          // Requirements that name no section (a page-wide "no CTA", a verbatim
          // string) fall back to what this turn was about — never the whole page.
          // Capped: one model call per section, and mergeRequirements allows 16
          // requirements, so an uncapped list is 16 sequential calls inside a
          // streaming response — minutes of hang, then a proxy idle-timeout kills
          // the turn and the user loses an edit that had already been applied.
          const retryTargets = (failedSections.length > 0 ? failedSections : intent.targetSections)
            .filter((name) => availableSections.some((s) => s.name === name))
            .slice(0, REQUIREMENT_RETRY_SECTION_CAP);

          if (fixInstruction && retryTargets.length > 0) {
            sendSSE(controller, { type: 'status', message: 'Finishing what\'s left…' });
            const retryPrompt =
              `${prompt}\n\nCRITICAL — your previous attempt left these parts of the request undone. ` +
              `Apply them now, and change NOTHING else in this section:\n${fixInstruction}\n\n` +
              `Keep every data-field attribute so the text stays click-to-editable.`;
            const repatched: Array<{ name: string; html: string }> = [];
            for (const name of retryTargets) {
              if (request.signal.aborted) break;
              const section = availableSections.find((s) => s.name === name);
              if (!section) continue;
              // Real image bytes are back in the HTML by this point (line ~4875).
              // Sending a base64 blob to the model would cost a fortune and can
              // blow the context on its own — swap placeholders back in for the
              // call, then put the bytes back into what comes out.
              const { html: sectionForModel, map: sectionUris } = extractDataUris(section.html);
              const schemaSlice = { [name]: (schema as Record<string, unknown> | null | undefined)?.[name] };
              const attempt = await runScopedPatchWithRetry(
                sectionForModel,
                schemaSlice,
                retryPrompt,
                undefined,
                usageCtx,
              );
              if (attempt.html && attempt.html !== sectionForModel) {
                repatched.push({ name, html: restoreDataUris(attempt.html, sectionUris) });
              }
            }

            if (repatched.length > 0) {
              const candidate = applyPatch(finalHtmlPersisted, repatched);
              const candidateResults = checkRequirements(candidate, requirements, {
                beforeHtml: preservationBaseline,
              });
              const failedBefore = results.map((r) => !r.passed);
              const failedAfter = candidateResults.map((r) => !r.passed);
              const regressed = failedAfter.some((bad, i) => bad && !failedBefore[i]);
              const fixed = failedBefore.filter((bad, i) => bad && !failedAfter[i]).length;
              // verifyAndRehostHtmlImages already ran above, so any image URL the
              // retry invents ships unverified and can 404 on the live page. The
              // one URL a retry legitimately ADDS is the asset a requirement is
              // demanding be present — anything else means it did more than it was
              // told, and the whole candidate goes in the bin.
              const allowedNewAssets = new Set(
                requirements.map((r) => r.value).filter((v): v is string => !!v),
              );
              const externalImgSrcs = (h: string) =>
                Array.from(h.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)).map((m) => m[1]);
              const knownAssets = new Set(externalImgSrcs(finalHtmlPersisted));
              const inventedAssets = externalImgSrcs(candidate).filter(
                (url) => !knownAssets.has(url) && !allowedNewAssets.has(url),
              );
              if (!regressed && fixed > 0 && inventedAssets.length === 0) {
                finalHtmlPersisted = candidate;
                results = candidateResults;
                console.log('[pages/follow-up] requirement retry landed', {
                  sections: repatched.map((r) => r.name),
                  fixed,
                  stillFailing: failedAfter.filter(Boolean).length,
                });
              } else {
                console.warn('[pages/follow-up] requirement retry discarded — kept pre-retry page', {
                  sections: repatched.map((r) => r.name),
                  regressed,
                  fixed,
                  inventedAssets,
                });
              }
            } else {
              console.warn('[pages/follow-up] requirement retry produced no change', { retryTargets });
            }
          } else {
            console.warn('[pages/follow-up] unmet requirements with nowhere to retry', {
              failedSections,
              targetSections: intent.targetSections,
            });
          }
        }

        const unmet = describeUnmet(results);
        if (unmet) {
          console.warn('[pages/follow-up] unmet requirements', { unmet, prompt: prompt.slice(0, 200) });
        }
        // text_present only proves the model's OWN phrasing of the ask didn't
        // survive verbatim, not that content was dropped — a retry already ran
        // above, so surfacing a leftover wording mismatch to the user reads as
        // "you ignored me" on a turn that did the work. Structural misses
        // (asset, CTA, section) still get reported since those are real.
        const userFacingUnmet = describeUnmet(results.filter((r) => r.requirement.kind !== 'text_present'));
        if (userFacingUnmet) {
          partialMessage = partialMessage
            ? `${partialMessage} Still not applied: ${userFacingUnmet}.`
            : `Still not applied: ${userFacingUnmet}.`;
        }
      }
      // A URL that did not respond is a warning about the page, not a part of
      // the request that failed. Gluing it onto partialMessage made a turn that
      // did everything asked report "Partly done (not fully finished)" — the
      // user reads that as "you ignored me" and re-sends work already done.
      if (assetScan.broken.length > 0) {
        addNote(
          `${assetScan.broken.length} image URL(s) on the page did not load and were left as they were.`,
        );
        console.warn('[pages/follow-up] broken image URLs', { count: assetScan.broken.length });
      }

      // Re-stamp click-to-edit BEFORE measuring damage. This used to run after
      // the loss check, so a rewrite that dropped data-field attributes was
      // reported to the user as "14 items stopped being click-to-edit" even
      // when the very next line put them back — an alarming message about
      // damage that no longer existed by the time the page was saved.
      {
        const schemaForEarlyStamp = finalSchemaJsonReal ?? (schema as Record<string, unknown> | null);
        const beforeEarlyStamp = finalHtmlPersisted;
        finalHtmlPersisted = ensureClickToEditFields(finalHtmlPersisted, schemaForEarlyStamp);
        if (finalHtmlPersisted !== beforeEarlyStamp) {
          console.log('[pages/follow-up] stamped missing data-field attributes before loss check');
        }
      }

      // Collateral damage guard: an edit about colors has no business deleting
      // the logo. Compare against the pre-edit page and put back what vanished
      // without being asked for. Skipped entirely when the user said "remove".
      //
      // WHY this layer has to exist at all: when a rewrite covers several
      // sections in one completion (a broad "make the whole page responsive"
      // easily reaches 6+ sections, tens of thousands of output tokens,
      // minutes of generation), the model has to faithfully reproduce every
      // untouched element in that same output while also making the change it
      // was actually asked for — and it can silently drop something small it
      // wasn't focused on, like one unrelated <img>. That is a model
      // limitation, not something narrower prompts or better instructions can
      // guarantee away; smaller calls lower the odds, they don't zero them
      // out. So the guarantee has to live here: we can't stop the model from
      // occasionally dropping something, but we can make sure a drop never
      // costs the user their whole edit.
      const losses = findUnrequestedLosses({
        beforeHtml: preservationBaseline,
        afterHtml: finalHtmlPersisted,
        prompt,
        removalIntent: intent.removalIntent,
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
        // Don't undo an intentional swap ("nav logo same as footer") or a
        // reuse path that just embedded a different working URL.
        const skipLogoRestore =
          intent.intentionalAssetReplace ||
          (Boolean(logoSwapAppliedUrl) && lostLogo !== logoSwapAppliedUrl);
        if (lostLogo && !skipLogoRestore) {
          // Put it back where the user had it — assuming nav/footer would move
          // a hero logo somewhere they never asked for.
          const slNames = Array.from(
            finalHtmlPersisted.matchAll(/<!--\s*SL:([a-z0-9_-]+)\s*-->/gi),
          ).map((m) => m[1]);
          const original = sectionsContainingAsset(preservationBaseline, lostLogo);
          const targets = original.filter((n) => slNames.includes(n));
          if (targets.length === 0) {
            targets.push(...slNames.filter((n) => /nav|header|footer/i.test(n)));
          }
          if (targets.length === 0) targets.push('nav', 'footer');
          const restored = forceEmbedLogoIntoSections(finalHtmlPersisted, targets, lostLogo, null);
          if (restored !== finalHtmlPersisted) {
            // forceEmbedLogoIntoSections writes a bare <img>, with no
            // data-field — it has no idea what the schema called this leaf.
            // Left alone, the very fix for "logo disappeared" turns into a
            // NEW loss ("logo is no longer click-to-edit") that the guard
            // below has no way to tell apart from real damage, and the whole
            // edit — every section this turn legitimately touched — gets
            // thrown away over an attribute our own repair forgot to carry.
            // stampSchemaDataFields matches by exact URL, so it reattaches
            // the logo's ORIGINAL path rather than inventing a new one.
            finalHtmlPersisted = ensureClickToEditFields(
              restored,
              finalSchemaJsonReal ?? (schema as Record<string, unknown> | null),
            );
            restoredLogo = true;
            console.log('[pages/follow-up] restored logo removed without request', {
              targets,
              logo: lostLogo.slice(0, 120),
            });
          }
        } else if (lostLogo && skipLogoRestore) {
          console.log('[pages/follow-up] skip logo restore (intentional replace)', {
            lost: lostLogo.slice(0, 120),
            applied: logoSwapAppliedUrl?.slice(0, 120) ?? null,
          });
        }

        // Anything we could not put back is reported rather than hidden.
        const allRemaining = findUnrequestedLosses({
          beforeHtml: preservationBaseline,
          afterHtml: finalHtmlPersisted,
          prompt,
          removalIntent: intent.removalIntent,
        });

        // ── The guard stops at the edge of the model's own work ─────────────
        //
        // A region rewrite is HANDED a run of sections and told to change them.
        // Inside that run, a missing image is almost always the edit working:
        // "put the hero image here as well" replaces the picture that was
        // there. Reported from client testing — the rewrite did exactly that,
        // the guard called the replaced photo damage, and the whole edit was
        // thrown away in front of a client.
        //
        // Outside the run nothing was supposed to change at all: those bytes
        // are copied across by the splice untouched. So a loss out there is
        // provable damage and still worth stopping.
        //
        // Note what this is NOT: it does not ask whether a loss was reasonable,
        // only WHERE it happened. That keeps the judgement with the model and
        // the bookkeeping with the code. When no rewrite ran (full-page rebuild
        // regenerates the whole document) there is no such edge, and the guard
        // covers everything exactly as before.
        //
        // "Presumed intended" is only safe for the swap case the comment above
        // describes. A prompt with no image content in it at all ("make it
        // responsive, less padding") gives the model no reason to touch a
        // picture — a dropped one there is just as unrequested as one outside
        // the run, and skipping judgement on it silently ships a page missing
        // real content. Confirmed live: 3 trust-badge images vanished this way
        // and were never even considered for repair. So the exemption only
        // applies when the message actually says it's swapping an asset;
        // otherwise an in-region image loss goes back through the same
        // judge + repair path as everything else. Headings/sections/fields
        // inside the run keep the blanket exemption — condensing two headings
        // into one is common and legitimate, and re-litigating that is the
        // false positive this guard was already burned by once.
        const assetLossIsIntended = intent.intentionalAssetReplace || !!logoSwapAppliedUrl;
        const regionSplit = rewrittenRegion
          ? splitLossesByRegion(allRemaining, preservationBaseline, rewrittenRegion)
          : null;
        const remaining: PageLosses = regionSplit
          ? {
              ...regionSplit.outside,
              images: assetLossIsIntended
                ? regionSplit.outside.images
                : [...regionSplit.outside.images, ...regionSplit.inside.images],
            }
          : allRemaining;
        if (regionSplit && hasLosses(regionSplit.inside)) {
          console.log('[pages/follow-up] losses inside the rewritten region are the edit, not damage', {
            region: rewrittenRegion,
            images: assetLossIsIntended ? regionSplit.inside.images.length : 0,
            imagesReconsidered: assetLossIsIntended ? 0 : regionSplit.inside.images.length,
            headings: regionSplit.inside.headings.length,
            sections: regionSplit.inside.sections,
          });
        }
        // Destruction is rejected, not narrated.
        //
        // Until now this path only ever REPORTED what an edit destroyed and
        // saved the page anyway, while the scoped path treats the same damage
        // as a hard failure and throws the edit away. Same damage, two
        // verdicts, and the one that shipped chose to keep it: a user asked to
        // make a footer logo slightly bigger and got back a page missing 6
        // images and 4 headings, with an apologetic note attached. A page the
        // user did not ask us to gut is not a result worth keeping — restore
        // the pre-edit HTML and say so plainly, so their work survives and they
        // can retry.
        //
        // Code measured what vanished; the MODEL decides whether that is a fair
        // consequence of the request. Counting was the first version of this
        // guard and it was the same mistake in new clothing: "make the hero
        // shorter and punchier" legitimately merges two headings into one, a
        // counter sees a heading missing, and a good edit gets reverted with
        // "I've left your page exactly as it was". A count cannot tell
        // condensing from deleting; only reading the request can.
        //
        // The cheap, certain cases are still settled without a call: an
        // explicit removal, a full rebuild, or a deliberate asset swap all make
        // the loss intended by definition. (assetLossIsIntended computed above,
        // before remaining — it decides whether an in-region image gets folded
        // back in as a real loss.)
        const lossObviouslyIntended =
          intent.removalIntent ||
          intent.fullRebuild ||
          (assetLossIsIntended &&
            remaining.sections.length === 0 &&
            remaining.headings.length === 0 &&
            remaining.editableFields.length === 0);

        // Sections this turn was about, and where each vanished image used to
        // live. Both are plain facts we already hold, and the judge cannot
        // answer without them: "a photo went missing" and "the photo in the
        // section you told me to change went missing" are opposite verdicts.
        const requestedSections = Array.from(
          new Set([...intent.targetSections, ...intent.asks.flatMap((a) => a.sections)]),
        );
        const imageOrigins = remaining.images.slice(0, 8).map((url) => ({
          url,
          sections: sectionsContainingAsset(preservationBaseline, url),
        }));

        // A data-field name is bookkeeping for the click-to-edit UI, not
        // content — losing one while every image/heading/section survives
        // means the text or picture is still on the page, just not editable
        // under its old handle. That is a real regression worth fixing, but
        // it is not in the same league as a missing image, and must not by
        // itself carry the same all-or-nothing penalty (reject the whole
        // edit) that real content loss does.
        const isEditableFieldOnlyLoss = (l: PageLosses) =>
          l.images.length === 0 &&
          l.headings.length === 0 &&
          l.sections.length === 0 &&
          l.editableFields.length > 0;

        let destructive = false;
        let lossSummary: string | null = null;
        if (!lossObviouslyIntended && !isEditableFieldOnlyLoss(remaining)) {
          const judged = await judgeUnrequestedLoss({
            prompt,
            losses: remaining,
            imageSections: imageOrigins,
            requestedSections,
            // What the page has NOW, so a reworded heading reads as a rewrite
            // rather than a deletion. Losses are exact-string matches, so
            // without this nearly every copy edit looks like destruction.
            headingsAfter: snapshotPageFacts(finalHtmlPersisted).headings,
            usage: usageCtx,
          });
          destructive = !judged.intended;
          lossSummary = judged.summary;
          console.log('[pages/follow-up] loss judgement', {
            intended: judged.intended,
            images: remaining.images.length,
            headings: remaining.headings.length,
            sections: remaining.sections,
            editableFields: remaining.editableFields.length,
          });
        }

        // Repair before revert.
        //
        // "Reject the whole edit" was the only answer here, and on its own it
        // punishes the user for our mistake: they asked to put an image in the
        // hero, we did it, dropped an unrelated team photo on the way past, and
        // handed back their original page. The change they wanted is gone
        // because of damage they never caused.
        //
        // The damaged sections have a known-good version one edit back. Splice
        // it in and the requested change stands. Sections the request was ABOUT
        // are never restored — that would undo the ask and still say Done.
        let effectiveLosses = remaining;
        if (destructive) {
          const repair = restoreDamagedSections({
            beforeHtml: preservationBaseline,
            afterHtml: finalHtmlPersisted,
            losses: remaining,
            protectedSections: requestedSections,
          });

          // The section-level repair above only ever touches sections the
          // request was NOT about (protectedSections), on purpose — reverting
          // a section the model was legitimately rewriting would undo real
          // work along with the damage. That leaves exactly the case the logo
          // fix above exists for, generalized past "logo": an image dropped
          // from a section the request WAS about. Put just that image back,
          // at image granularity, rather than reverting the section around
          // it. Runs on whatever restoreDamagedSections didn't already fix.
          const stillMissingImages = remaining.images.filter((u) => !repair.html.includes(u));
          const imageRepair =
            stillMissingImages.length > 0
              ? restoreLostImagesInPlace({
                  beforeHtml: preservationBaseline,
                  afterHtml: repair.html,
                  images: stillMissingImages,
                })
              : { html: repair.html, restored: [] as string[] };
          // The splice above guarantees a restored image can never break the
          // page (max-width-capped), but "never breaks" and "looks right"
          // are different bars — it lands at a generic spot with no idea
          // what its neighbours look like. One more pass lets the model fit
          // JUST that image's position/size to its own section; the result
          // is verified before being trusted (verifyImagePlacementEdit), so
          // a section that fails verification — or a call that fails
          // outright — keeps the deterministic version exactly as it was.
          const placement =
            imageRepair.restored.length > 0
              ? await placeRestoredImagesIntelligently({
                  html: imageRepair.html,
                  beforeHtml: preservationBaseline,
                  images: imageRepair.restored,
                  usage: usageCtx,
                })
              : { html: imageRepair.html, placed: [] as string[] };

          const repairedHtml =
            imageRepair.restored.length > 0
              ? ensureClickToEditFields(
                  placement.html,
                  finalSchemaJsonReal ?? (schema as Record<string, unknown> | null),
                )
              : placement.html;

          if (repair.restored.length > 0 || imageRepair.restored.length > 0) {
            // A full re-diff against the pristine original, same as the very
            // first check — which means it also brings back every loss the
            // first pass already excused as "inside the rewritten region,
            // the edit's own doing" (splitLossesByRegion above). Left
            // un-split, those already-forgiven losses reappear here as if
            // they were new, and a repair that had genuinely fixed
            // everything it owed the user got rejected anyway over damage
            // that was never damage — confirmed live: 3 images already
            // cleared as in-region came back at this step and, combined with
            // one unrelated leftover, were enough to tip the second judge
            // into "not intended" and discard a repair that had already
            // restored the logo and both other images correctly. Applies the
            // same asset-swap-aware fold as the first pass, for the same
            // reason: an in-region image is only presumed-intended when the
            // message actually said it was swapping one.
            const afterRepairAll = findUnrequestedLosses({
              beforeHtml: preservationBaseline,
              afterHtml: repairedHtml,
              prompt,
              removalIntent: intent.removalIntent,
            });
            const afterRepairSplit = rewrittenRegion
              ? splitLossesByRegion(afterRepairAll, preservationBaseline, rewrittenRegion)
              : null;
            const afterRepair: PageLosses = afterRepairSplit
              ? {
                  ...afterRepairSplit.outside,
                  images: assetLossIsIntended
                    ? afterRepairSplit.outside.images
                    : [...afterRepairSplit.outside.images, ...afterRepairSplit.inside.images],
                }
              : afterRepairAll;
            // Clean ⇒ keep. Still lossy ⇒ the judge decides again on what is
            // actually left, not on the damage we already undid.
            let stillDestructive = hasLosses(afterRepair);
            if (stillDestructive && !isEditableFieldOnlyLoss(afterRepair)) {
              const rejudged = await judgeUnrequestedLoss({
                prompt,
                losses: afterRepair,
                imageSections: afterRepair.images.slice(0, 8).map((url) => ({
                  url,
                  sections: sectionsContainingAsset(preservationBaseline, url),
                })),
                requestedSections,
                headingsAfter: snapshotPageFacts(repairedHtml).headings,
                usage: usageCtx,
              });
              stillDestructive = !rejudged.intended;
              if (stillDestructive) lossSummary = rejudged.summary;
            } else if (stillDestructive) {
              stillDestructive = false;
            }
            console.log('[pages/follow-up] collateral repair', {
              restoredSections: repair.restored,
              restoredImages: imageRepair.restored,
              intelligentlyPlaced: placement.placed,
              protectedSections: requestedSections,
              stillDestructive,
            });
            if (!stillDestructive) {
              finalHtmlPersisted = repairedHtml;
              effectiveLosses = afterRepair;
              destructive = false;
            }
          }
        }

        if (destructive) {
          console.error('[pages/follow-up] rejecting destructive edit — restoring pre-edit page', {
            images: remaining.images.length,
            headings: remaining.headings.length,
            sections: remaining.sections,
            editableFields: remaining.editableFields.length,
            prompt: prompt.slice(0, 200),
          });
          // The judge's summary is a whole sentence ("the team photo was removed,
          // even though the request was only to add a hero image"). Dropping it
          // into the middle of another sentence shipped this to a real user:
          // "That edit would also have removed An image and the team.members.0
          // .generated_image_url field were removed, even though ..., which isn't
          // part of what you asked for". Use it as the sentence it is.
          const damage = lossSummary
            ? lossSummary.trim().replace(/[.\s]*$/, '.')
            : `That edit would also have removed ${describeLosses(remaining)}, ` +
              `which isn't part of what you asked for.`;
          sendSSE(controller, {
            type: 'error',
            message:
              `${damage} I've left your page exactly as it was — try the change on its own, ` +
              `or tell me it's fine to lose those and I'll go ahead.`,
          });
          closeSSE(controller);
          return;
        }

        // Reaching this line means the loss was CLEARED — either the judge read
        // the request and ruled the loss intended, or it was intended by
        // definition (removal / rebuild / asset swap), or repair undid it. Every
        // destructive outcome returned above.
        //
        // So this used to contradict itself out loud. "Change these headings to
        // something better" reworded two headings; losses are exact-string
        // matches, so the old strings counted as gone; the judge correctly said
        // intended (which is why the edit was kept); and then this line reported
        // "2 headings disappeared without being asked for" under a headline
        // saying the work wasn't finished. The count was never corrected because
        // effectiveLosses is only reassigned inside the repair branch — a
        // straight "intended" verdict left the raw count to be printed verbatim.
        //
        // A cleared loss has nothing honest to say to the user. It stays in the
        // logs, where the number is still worth having.
        const lossNote = describeLosses(effectiveLosses);
        if (lossNote) {
          console.log('[pages/follow-up] losses cleared as intended — not reported', {
            summary: lossNote,
            judgedIntended: !lossObviouslyIntended,
            obviouslyIntended: lossObviouslyIntended,
          });
        } else if (restoredLogo) {
          console.log('[pages/follow-up] all unrequested losses repaired');
        }
      }

      // Click-to-edit only hooks [data-field]. Schema match + structural fill
      // so screenshot copy (not in schema) still becomes editable.
      const schemaForStamp = finalSchemaJsonReal ?? (schema as Record<string, unknown> | null);
      const beforeStamp = finalHtmlPersisted;
      finalHtmlPersisted = ensureClickToEditFields(finalHtmlPersisted, schemaForStamp);
      if (finalHtmlPersisted !== beforeStamp) {
        console.log('[pages/follow-up] stamped missing data-field attributes for click-to-edit');
      }

      // Variant pages write to draft_* columns and never touch the live storage
      // file a test is actually serving — only "Replace Current Variant" uploads
      // to the live path. Non-variant pages behave exactly as before.
      let htmlUrl: string = page.html_url ?? '';
      if (!isVariant) {
        const storagePath = fileNameFromUrl(page.html_url);
        htmlUrl = await uploadHtml(storagePath, finalHtmlPersisted);

        // DISABLED runPostUploadNavLogoQa (follow-up:live-visual-qa).
        // Live capture of our uploaded HTML returned an S3 NoSuchBucket error
        // page (~14KB). QA treated that as the built page, rewrote nav/hero,
        // dropped data-field (click-to-edit died), and still said Done. Also
        // the 5–6 minute "Checking full page look…" hang. Intent is now
        // model-classified; this pass is optional and currently harmful.
        // Re-enable only when: (1) skip captures that are error pages / not
        // our HTML, (2) rewrites keep data-field + SL markers.
      }

      // Save conversation.
      //
      // Reconstructed to match the client's own composition exactly (see
      // sendFollowUp), so reopening the page shows what the user actually read
      // rather than an approximation of it.
      // Photos imported from a link ON THIS TURN, checked against the HTML
      // we are about to persist. Scoped to this turn deliberately: the library
      // above also holds files carried forward from earlier turns, and a file
      // the user imported four turns ago and never asked to place would
      // otherwise generate the same complaint on every message since.
      //
      // A note, never a block. Declining to place a photo is often correct —
      // the edit may have had nothing to do with imagery. What was wrong was
      // saying nothing, which left "imported four, used none" looking like a
      // broken fetch.
      if (currentTurnLibraryCount > 0) {
        const placement = measureAssetPlacement(
          libraryAssets.slice(0, currentTurnLibraryCount),
          finalHtmlPersisted,
        );
        console.log('[pages/follow-up] asset library placement', {
          imported: placement.imported,
          placed: placement.placed,
          unused: placement.unusedNames,
        });
        const placementNote = describeAssetPlacement(placement);
        if (placementNote) addNote(placementNote);
      }

      const doneHeadline = editorMessage ?? 'Done! The page has been updated.';
      const assistantReply = partialMessage
        ? `Partly done (not fully finished). ${partialMessage}${pageNotes.length > 0 ? ` ${pageNotes.join(' ')}` : ''}`
        : `${doneHeadline}${pageNotes.length > 0 ? ` ${pageNotes.join(' ')}` : ''}`;
      const userEntry: Record<string, unknown> = { role: 'user', content: rawPrompt };
      if (Array.isArray(image_urls) && image_urls.length > 0) userEntry.image_urls = image_urls;
      // Only THIS turn's imports. The merged list above also holds files carried
      // forward from older entries; re-storing those would copy the whole library
      // onto every turn and grow conversation_json without bound.
      if (currentTurnLibraryCount > 0) userEntry.asset_library = libraryAssets.slice(0, currentTurnLibraryCount);
      const updatedConversation = [
        ...history,
        userEntry,
        // WHAT THE USER WAS TOLD — the same sentence the client just rendered.
        //
        // This used to store JSON.stringify({type, schema_json}): a dump of the
        // page schema where the reply belonged. Nothing ever parsed it back
        // (one writer, zero readers), and it cost the product its whole chat
        // history — on reload every assistant turn had to be replaced with
        // canned text because there were no words to show, so a page reopened
        // as a wall of "Done! The page has been updated." with the real
        // answers gone. The schema itself was never at risk: pages.schema_json
        // / draft_schema_json is its home, and this was only ever a duplicate.
        //
        // Replayed to the model as context too, which is a second gain — a
        // sentence saying what changed beats a stale schema dump, and is a
        // fraction of the tokens.
        {
          role: 'assistant',
          content: assistantReply,
          // Which sections this turn actually touched. The next message is
          // often a correction — "no, use the hero's image" — that names the
          // WHAT but not the WHERE, because the where was settled a turn ago
          // (sometimes by a screenshot that no longer exists). This is our own
          // record of what we did, so the where survives without replaying old
          // attachments at the model.
          sections: rewrittenRegion ?? intent.targetSections,
        },
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

      if (isVariant) {
        const linkedVariant = await getLinkedVariant(params.id);
        if (linkedVariant) {
          await rescanVariantHtml(linkedVariant.test_id, linkedVariant.id, linkedVariant.name, finalHtmlPersisted);
        }
      }

      // Report any accrued overage to Stripe (no-op unless overage is enabled
      // and a metered price is configured). Fire-and-forget.
      void reportAiOverageUsage(aiOwnerId);

      // ── Did this edit add markup the page has nowhere to put? ─────────────
      //
      // On a coordinate-layout page every element is placed by a left/top rule
      // in the head stylesheet, which no scoped edit can see or write. Anything
      // NEW has no rule, so it does not flow after the existing content — it
      // lands on top of it. That is how a redesigned hero ended up overlapping
      // the hero it replaced while we reported "Done!" twice.
      //
      // Not blocked, because the edit is done and saved and blocking it here
      // would throw away work the user asked for. Said out loud instead, on the
      // `notes` channel — which keeps the "Done!" headline and adds the caveat,
      // rather than the false "Partly done" that a partial_message would give.
      // The real fix for these pages is upstream: prep now tells the user their
      // page cannot be restructured BEFORE they type anything (see
      // ai-page-layout.ts and schema-from-html).
      const editedLayout = analyzePageLayout(originalHtmlForPreservation);
      if (editedLayout.kind === 'coordinate') {
        // Both sides have to be the same KIND of html to be counted against each
        // other. `originalHtmlForPreservation` holds image placeholders and
        // finalHtmlPersisted holds the real bytes back — and an inline
        // `data:image/svg+xml,<svg…>` puts tags into the string on one side only,
        // which would read as elements this edit had added. Restoring the
        // original costs one string pass, and only on the rare coordinate page.
        const added =
          countLayoutElements(finalHtmlPersisted) -
          countLayoutElements(restoreDataUris(originalHtmlForPreservation, dataUriMap));
        console.log('[pages/follow-up] coordinate-layout page edited', {
          addedLayoutElements: added,
          reasons: editedLayout.reasons,
        });
        if (added > 0) {
          addNote(
            `Heads-up: this page positions every element at fixed pixel coordinates in its stylesheet, ` +
            `and this edit added ${added} new element${added === 1 ? '' : 's'} that the stylesheet has no ` +
            `position for — they may sit on top of the original content instead of flowing after it. ` +
            `Check the preview. Restructuring a page like this isn't reliable; it needs rebuilding first.`,
          );
        }
      }

      // A question rode alongside this turn's edit ("what do you think about
      // the hero? also remove the FAQ") — the edit above already ran normally;
      // this only answers the leftover question so it isn't silently dropped.
      // Best-effort: a failure here must not undo or block the edit that
      // already succeeded, so it degrades to no note rather than an error.
      if (intent.questionAside) {
        try {
          const asideAnswer = await answerFollowUpQuestion(intent.questionAside);
          addNote(asideAnswer);
        } catch (err) {
          console.error('[pages/follow-up] question_aside answer failed', err);
        }
      }

      const doneEvent: SSEEvent = {
        type: 'done',
        // For variant drafts this is the unchanged live URL — the client only
        // uses it as a cache-busting trigger to refetch /preview, which serves
        // the draft content directly.
        html_url: htmlUrl,
        ...(finalSchemaJsonReal ? { schema_json: finalSchemaJsonReal } : {}),
        ...(scrapeAttempted && !competitorContext ? { competitor_fetch_failed: true } : {}),
        elapsed_ms: Date.now() - startedAt,
        // The model's own sentence, when a model wrote one. Omitted (not
        // blanked) on the paths where none did, so the client's fixed copy
        // still covers them — see SSEEvent.message.
        ...(editorMessage ? { message: editorMessage } : {}),
        ...(partialMessage ? { partial_message: partialMessage } : {}),
        ...(pageNotes.length > 0 ? { notes: pageNotes.join(' ') } : {}),
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

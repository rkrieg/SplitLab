/**
 * Follow-up edit helpers: clarify policy, multi-intent planning, post-patch verify.
 * Pure functions are unit-testable via scripts/verify-ai-follow-up-helpers.mjs
 * (mirrored logic) — keep behavior in sync when changing these.
 */

import { askAI, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import type { UsageContext } from '@/lib/ai-usage';
import { inferTargetSectionNames } from '@/lib/ai-content-placement';

export interface PlanStep {
  /** Narrow instruction for this step only */
  instruction: string;
  /** Preferred SL section names (exact), empty if unknown */
  target_sections: string[];
  /** Hint for routing — patch is the default */
  op: 'patch' | 'remove_section' | 'insert_section' | 'structural' | 'image_generate';
}

export type EditPlan =
  | { mode: 'single' }
  | { mode: 'clarify'; question: string }
  | { mode: 'execute'; steps: PlanStep[] };

/** User is deferring judgment to the model — do not clarify; decide and act. */
export function userWantsUsToDecide(prompt: string): boolean {
  return /\b(you decide|your (call|choice|judgment)|feel free|up to you|i('m| am) (fine|ok|okay) (with )?whatever|surprise me|just (do|pick|choose|decide)|pick (one|for me)|whichever (you|makes)|don'?t ask|no (more )?questions)\b/i.test(
    prompt,
  );
}

/**
 * Screenshot + complaint about something visibly wrong — the image is the
 * answer. Asking "did you mean the logo?" when they already ranted about the
 * logo is the over-clarify failure from production logs.
 */
export function isScreenshotComplaint(prompt: string, hasUserImages: boolean): boolean {
  if (!hasUserImages) return false;
  // Design-match asks ("keep the footer like this") are NOT complaints — they
  // hand a reference to recreate, not a defect on the current page.
  if (isDesignReferenceAsk(prompt)) return false;
  return /\b(look(s|ing)? (at )?(this|that|it)|can you (not )?see|this is (ridiculous|absurd|sloppy|wrong|broken|weird)|it looks|doesn'?t (even )?(blend|match|look)|fake logo|line breaks|dark around|background.*(wrong|weird|not)|not (even )?the same)\b/i.test(
    prompt,
  );
}

/**
 * User attached (or will attach) an image as a style/layout/copy REFERENCE to
 * match — e.g. "keep the footer like this", "make the nav match this screenshot".
 * Distinct from bug screenshots (fix defect) and content assets (embed URL).
 */
export function isDesignReferenceAsk(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  if (
    /\b((keep|make|update|change|redo|rebuild|redesign|restyle|replace)\b.{0,80}\b(like this|like that|like the (image|screenshot|photo|reference)|to (match|look like) this)|(look|looks|looking) like this|match this|match that|same as this|exactly like this|copy this|based on this|use this as (a )?(reference|template|style|design)|style (it |this )?after this|from this (image|screenshot|photo|reference))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(footer|nav(?:bar)?|header|hero|logo|section|form|cta)\b/i.test(t) &&
    /\b(like this|like that|match this|match that|same as (this|that)|as shown|as in (the )?(image|screenshot|photo))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * When the prompt names a page part, map to existing SL section names so
 * design-match edits can skip ambiguous routing.
 */
export function inferDesignMatchSectionNames(prompt: string, sectionNames: string[]): string[] {
  return inferTargetSectionNames(prompt, sectionNames).slice(0, 3);
}

/**
 * Cheap heuristic: multiple distinct edit intents in one message.
 * False → skip planner AI call (keep single-ask path fast).
 */
export function looksLikeMultiIntent(prompt: string): boolean {
  const t = prompt.trim();
  if (t.length < 40) return false;

  // Numbered / bulleted list of asks
  if (/(?:^|\n)\s*(?:\d+[\.)]|[-*•])\s+\S+/m.test(t) && (t.match(/(?:^|\n)\s*(?:\d+[\.)]|[-*•])\s+/gm) ?? []).length >= 2) {
    return true;
  }

  // Explicit separators between asks ("also", "and also", casual "and the footer")
  if (/\b(?:also|plus|then|after that|and also|as well as|while you'?re at it)\b/i.test(t) && t.length > 50) {
    return true;
  }

  // Soft: "fix X and … the Y" / "change the logo and the footer"
  if (
    /\b(and|,)\s+(the\s+)?(logo|nav|hero|footer|form|faq|headline|button|cta)\b/i.test(t) &&
    uniqueSectionCount(t) >= 2 &&
    t.length > 45
  ) {
    return true;
  }

  // "X + Y + Z" style short multi-asks
  if ((t.match(/\s\+\s/g) ?? []).length >= 1 && /\b(logo|hero|form|nav|footer|headline|button|image)\b/i.test(t)) {
    return true;
  }

  // Multiple section nouns paired with different action verbs
  const sectionHits = (t.match(/\b(logo|nav(?:bar)?|hero|footer|form|faq|pricing|headline|button|cta|section)\b/gi) ?? []);
  const uniqueSections = new Set(sectionHits.map((s) => s.toLowerCase()));
  const actionHits = (t.match(/\b(change|update|fix|remove|delete|rewrite|replace|swap|add|move|center|shrink|make|use|paste|embed|get\s+rid)\b/gi) ?? []);
  if (uniqueSections.size >= 2 && actionHits.length >= 2 && t.length > 80) {
    return true;
  }

  // Longer prompts naming 2+ page parts — cheap planner beats a wrong fat patch
  if (uniqueSections.size >= 2 && t.length > 120) {
    return true;
  }

  // "…on the hero…, …on the footer…" style multi-target (Renny dead-end page)
  if (
    uniqueSections.size >= 2 &&
    /\b(get\s+rid|remove|delete|shrink|no buttons?|dead-?end|keep it (nice and )?simple)\b/i.test(t) &&
    t.length > 80
  ) {
    return true;
  }

  return false;
}

/**
 * User clearly wants the page redesigned/cloned from a referenced URL.
 * When true, competitor scrape + full rebuild stays the correct path.
 */
export function userWantsFullCompetitorRebuild(prompt: string): boolean {
  return /\b((look|looks|looking) like|replicate|clone|copy (this|the) (site|page)|same as|exactly like|redesign|rebuild|match (this|the|their) (site|page|design|layout)|make (it|this|the page) (look |be )?(like|similar)|based on (this |the )?(site|page|url|link|website)|(from|using) (this |the )?(site|page|url|link) as (a )?(reference|template))\b/i.test(
    prompt,
  );
}

/**
 * Non-image URL is present but the ask is a local copy/section edit — keep the
 * cheap scoped path instead of forcing a full competitor rebuild.
 * False when redesign/clone language is present (see userWantsFullCompetitorRebuild).
 */
export function allowScopedDespiteCompetitorUrl(prompt: string): boolean {
  if (userWantsFullCompetitorRebuild(prompt)) return false;
  const withoutUrls = prompt
    .replace(/https?:\/\/[^\s"'<>)]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Bare URL (or almost) → treat as reference rebuild, not a scoped tweak
  if (withoutUrls.length < 16) return false;
  if (
    /\b(change|rewrite|rephrase|update|fix|replace|swap|shrink|center|remove|delete|get\s+rid|make)\b/i.test(
      withoutUrls,
    ) &&
    /\b(headline|heading|title|text|copy|button|cta|footer|hero|nav|logo|form|section|wording|subhead|padding|spacing)\b/i.test(
      withoutUrls,
    )
  ) {
    return true;
  }
  if (/["'“][^"'”\n]{6,}["'”]/.test(prompt)) return true;
  return false;
}

/** User wants a real photo/headshot/product image from a referenced site (not logo). */
export function userWantsSiteContentImage(prompt: string): boolean {
  return /\b((real|actual|their|the)\s+(headshot|photo|picture|product(\s+photo)?)|headshot from|product (photo|image) from|use (their|the|this) (photo|headshot|product|picture)|photo from (the |this )?(site|page|url)|team (photo|headshot)|product shot)\b/i.test(
    prompt,
  );
}

/** User explicitly asked for stats / social proof / testimonials / awards. */
export function userAskedForSocialProof(prompt: string): boolean {
  return /\b(stats?|statistics|social proof|testimonials?|reviews?|as seen( in)?|awards?|logo.?wall|trusted by|case stud(?:y|ies)|proof points?|metrics?|kpi)\b/i.test(
    prompt,
  );
}

function uniqueSectionCount(t: string): number {
  const sectionHits = t.match(/\b(logo|nav(?:bar)?|hero|footer|form|faq|pricing|headline|button|cta|section)\b/gi) ?? [];
  return new Set(sectionHits.map((s) => s.toLowerCase())).size;
}

/** Pull quoted strings the user wants applied / referenced. */
export function extractVerifyQuotes(prompt: string): string[] {
  const out: string[] = [];
  const re = /"([^"\n]{6,200})"|'([^'\n]{6,200})'|“([^”\n]{6,200})”/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const q = (m[1] || m[2] || m[3] || '').trim();
    if (q.length >= 6) out.push(q);
  }
  return out;
}

/**
 * After a scoped patch: reject silent wrong-section / no-op style wins when
 * the instruction clearly required specific copy to appear (or disappear).
 */
export function verifyScopedPatchIntent(opts: {
  prompt: string;
  sectionName: string;
  beforeHtml: string;
  afterHtml: string;
  /** When true, require the new asset URL to be present */
  requiredSubstring?: string | null;
  /** Design-reference OCR lines that must appear in the patched HTML */
  requiredPhrases?: string[] | null;
}): { ok: true } | { ok: false; reason: string } {
  const { prompt, sectionName, beforeHtml, afterHtml, requiredSubstring, requiredPhrases } = opts;

  if (requiredSubstring && !afterHtml.includes(requiredSubstring)) {
    return { ok: false, reason: `patched_${sectionName}_missing_required_asset` };
  }

  // No visual/content change at all → caller usually catches htmlUnchanged at
  // page level; still flag section-level no-ops when quotes must land here.
  // Design-reference asks MUST rewrite the section to match the screenshot —
  // identical HTML is always a failure (not a soft pass).
  if (beforeHtml === afterHtml) {
    const quotes = extractVerifyQuotes(prompt);
    if (
      quotes.length > 0 ||
      requiredSubstring ||
      isDesignReferenceAsk(prompt) ||
      (requiredPhrases && requiredPhrases.length > 0)
    ) {
      return { ok: false, reason: `patched_${sectionName}_unchanged` };
    }
  }

  const phrases = (requiredPhrases ?? []).map((p) => p.trim()).filter((p) => p.length >= 6);
  if (phrases.length > 0) {
    const hits = phrases.filter((p) => afterHtml.includes(p));
    // Require a clear majority of OCR'd lines — partial visual match is not Done.
    const need = Math.max(1, Math.ceil(phrases.length * 0.6));
    if (hits.length < need) {
      return {
        ok: false,
        reason: `patched_${sectionName}_missing_design_copy`,
      };
    }
  }

  const quotes = extractVerifyQuotes(prompt);
  // If the user quoted new copy and the instruction looks like a rewrite/
  // replace toward that copy, require at least one quote in the patched HTML
  // when the quote was already present in this section before OR no other
  // section context — for multi-section patches we only enforce when the
  // before HTML already contained a similar phrase or the prompt names this section.
  const namesThisSection = new RegExp(`\\b${escapeRegExp(sectionName)}\\b`, 'i').test(prompt);
  const rewriteIntent = /\b(change|rewrite|replace|update|say|should say|make it say|use this|to:)\b/i.test(prompt);

  if (rewriteIntent && quotes.length > 0) {
    const anyQuoteInAfter = quotes.some((q) => afterHtml.includes(q));
    const anyQuoteInBefore = quotes.some((q) => beforeHtml.includes(q));
    // Quote already lived here and still does after a "change" that might be
    // style-only — OK. Quote must appear after if instruction wants new copy
    // and this section is named or already held related text.
    if (!anyQuoteInAfter) {
      // Soft: only fail when this section was explicitly named OR the old
      // section contained one of the quotes (surgical target).
      if (namesThisSection || anyQuoteInBefore) {
        // If before already had the quote and after still does — fine (already handled).
        // Missing entirely after a named rewrite → fail.
        return { ok: false, reason: `patched_${sectionName}_missing_quoted_copy` };
      }
    }
  }

  // Remove intent: quoted or clearly named UI chrome must leave this section
  // when the prompt says remove/get rid and names this section or the string
  // was only in this section's before HTML.
  const removeIntent = /\b(remove|delete|get rid of|take (out|off)|strip)\b/i.test(prompt);
  if (removeIntent && quotes.length > 0 && namesThisSection) {
    const stillPresent = quotes.filter((q) => afterHtml.includes(q) && beforeHtml.includes(q));
    if (stillPresent.length > 0 && stillPresent.length === quotes.length) {
      // All quoted bits still there after a remove on this named section
      return { ok: false, reason: `patched_${sectionName}_remove_did_not_apply` };
    }
  }

  return { ok: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PLANNER_SYSTEM = `You plan landing-page AI edits. Split a user message into ordered atomic edit steps when it contains multiple distinct intents. Return JSON only.

{"mode":"execute"|"clarify"|"single","steps":[{"instruction":"...","target_sections":["hero"],"op":"patch"}],"clarifying_question":null}

Rules:
- mode "single": one clear intent (or already atomic) — return mode single and empty steps. The product will use the fast existing path.
- mode "execute": 2+ distinct intents — fill steps in order. Each step's instruction must be self-contained (copy the relevant detail from the user message). target_sections use EXACT names from the provided list when obvious; else [].
- mode "clarify": ONLY when you truly cannot proceed without knowing which section — and NEVER when the user said "you decide" / "feel free" / "just do it", NEVER when they attached a screenshot and are complaining about a visible defect (decide the fix yourself).
- Prefer execute over clarify. Prefer single when one patch covering 1-3 sections is enough (e.g. "center everything in the footer").
- op is usually "patch". Use "remove_section" only to delete a whole SL section. Use "structural" for "strip the page down to hero+footer" style trims. Use "image_generate" only for brand-new AI image creation.
- Max 5 steps. Do not invent work the user did not ask for.`;

/**
 * Multi-intent planner. Call only when looksLikeMultiIntent is true
 * (keeps normal edits to one routing call).
 */
export async function planMultiIntentEdit(opts: {
  prompt: string;
  sectionNames: string[];
  sectionPreviews: Array<{ name: string; text: string }>;
  imageUrls: string[];
  forceDecide: boolean;
  usage?: UsageContext;
}): Promise<EditPlan> {
  const { prompt, sectionNames, sectionPreviews, imageUrls, forceDecide, usage } = opts;

  if (forceDecide || userWantsUsToDecide(prompt)) {
    // Still try to split if multi-intent; never return clarify.
  }

  try {
    const list = sectionPreviews
      .map((s) => `- ${s.name}: "${s.text.slice(0, 120)}"`)
      .join('\n');
    const textPart =
      `Available sections:\n${list}\n\nKnown names: ${sectionNames.join(', ')}\n\nUser instruction:\n${prompt}` +
      (forceDecide || userWantsUsToDecide(prompt)
        ? '\n\n(User deferred to you — mode must be execute or single, never clarify.)'
        : '') +
      (imageUrls.length > 0
        ? '\n\nUser attached image(s) — use them to understand intent; do not clarify for screenshot complaints.'
        : '');

    const userContent: AIContent =
      imageUrls.length > 0
        ? [
            ...imageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
            { type: 'text', text: textPart },
          ]
        : textPart;

    const text = await askAI({
      system: PLANNER_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 4000,
      label: 'follow-up:multi-intent-plan',
      usage: usage ? { ...usage, operation: 'route' } : undefined,
    });

    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) raw = raw.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(raw) as {
      mode?: string;
      steps?: Array<{ instruction?: string; target_sections?: string[]; op?: string }>;
      clarifying_question?: string | null;
    };

    if (parsed.mode === 'clarify') {
      if (forceDecide || userWantsUsToDecide(prompt) || isScreenshotComplaint(prompt, imageUrls.length > 0)) {
        return { mode: 'single' };
      }
      const q =
        typeof parsed.clarifying_question === 'string' && parsed.clarifying_question.trim()
          ? parsed.clarifying_question.trim()
          : 'Which part of the page should I edit first?';
      return { mode: 'clarify', question: q };
    }

    if (parsed.mode === 'execute' && Array.isArray(parsed.steps) && parsed.steps.length >= 2) {
      const steps: PlanStep[] = [];
      for (const s of parsed.steps.slice(0, 5)) {
        if (!s || typeof s.instruction !== 'string' || !s.instruction.trim()) continue;
        const targets = Array.isArray(s.target_sections)
          ? s.target_sections.filter((n) => typeof n === 'string' && sectionNames.includes(n))
          : [];
        const op =
          s.op === 'remove_section' || s.op === 'insert_section' || s.op === 'structural' || s.op === 'image_generate'
            ? s.op
            : 'patch';
        steps.push({ instruction: s.instruction.trim(), target_sections: targets, op });
      }
      if (steps.length >= 2) return { mode: 'execute', steps };
    }

    return { mode: 'single' };
  } catch (err) {
    console.error('[ai-follow-up-helpers] planMultiIntentEdit failed — treating as single', err);
    return { mode: 'single' };
  }
}

export type AttachedImageRole = 'bug_reference' | 'content_asset' | 'design_reference';

export interface ClassifiedAttachedImage {
  url: string;
  role: AttachedImageRole;
}

function parseAttachedImageRole(raw: string | undefined): AttachedImageRole {
  if (raw === 'content_asset') return 'content_asset';
  if (raw === 'design_reference' || raw === 'style_reference') return 'design_reference';
  return 'bug_reference';
}

/**
 * Label each user-attached image: bug screenshot, content to embed, or design
 * reference to recreate (layout/copy/style). Fail-safe: single image +
 * like-this language → design; complaint → bug; place/use → asset;
 * ambiguous multi-image → clarify.
 */
export async function classifyAttachedImages(opts: {
  prompt: string;
  imageUrls: string[];
  usage?: UsageContext;
}): Promise<ClassifiedAttachedImage[] | 'clarify'> {
  const { prompt, imageUrls, usage } = opts;
  if (imageUrls.length === 0) return [];

  if (imageUrls.length === 1) {
    // Design match before complaint/embed — "keep the footer like this" must
    // never be treated as a non-actionable bug diagnosis.
    if (isDesignReferenceAsk(prompt)) {
      return [{ url: imageUrls[0], role: 'design_reference' }];
    }
    if (isScreenshotComplaint(prompt, true)) {
      return [{ url: imageUrls[0], role: 'bug_reference' }];
    }
    if (/\b(use|add|place|put|embed|insert|as (the )?(hero|background|image|photo))\b/i.test(prompt)) {
      return [{ url: imageUrls[0], role: 'content_asset' }];
    }
    // Default single attachment with edit language → treat as bug reference (safer than embedding)
    if (/\b(fix|wrong|broken|sloppy|align|spacing|logo)\b/i.test(prompt)) {
      return [{ url: imageUrls[0], role: 'bug_reference' }];
    }
  }

  try {
    const text = await askAI({
      system:
        'Classify each attached image for a landing-page editor. Return JSON only:\n' +
        '{"images":[{"index":0,"role":"bug_reference"|"content_asset"|"design_reference"}]}\n' +
        'bug_reference = screenshot of a defect on the CURRENT page (do not embed in HTML).\n' +
        'content_asset = photo/logo the user wants placed on the page (embed URL in src).\n' +
        'design_reference = screenshot/mock of how a section SHOULD look (footer/nav/hero/etc) — recreate that layout and copy in HTML; do NOT embed the screenshot URL as an <img src>.\n' +
        'Prefer design_reference when the instruction says "like this", "match this", "keep … like this", or "same as this" with a section screenshot.\n' +
        'Indexes are 0-based in attachment order. Classify every image.',
      messages: [
        {
          role: 'user',
          content: [
            ...imageUrls.map((url): AIContentBlock => ({ type: 'image', url })),
            {
              type: 'text',
              text: `Instruction: ${prompt}\n\nThere are ${imageUrls.length} attached image(s) in order.`,
            },
          ],
        },
      ],
      maxTokens: 800,
      label: 'follow-up:image-role-classify',
      usage: usage ? { ...usage, operation: 'route' } : undefined,
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const parsed = JSON.parse(raw) as {
      images?: Array<{ index?: number; role?: string }>;
    };
    if (!Array.isArray(parsed.images) || parsed.images.length === 0) {
      if (imageUrls.length > 1) return 'clarify';
      return [
        {
          url: imageUrls[0],
          role: isDesignReferenceAsk(prompt) ? 'design_reference' : 'bug_reference',
        },
      ];
    }
    const out: ClassifiedAttachedImage[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const row = parsed.images.find((x) => x.index === i) ?? parsed.images[i];
      let role = parseAttachedImageRole(row?.role);
      // Prompt-level design ask wins over a timid bug_reference classification
      if (imageUrls.length === 1 && isDesignReferenceAsk(prompt) && role === 'bug_reference') {
        role = 'design_reference';
      }
      out.push({ url: imageUrls[i], role });
    }
    return out;
  } catch (err) {
    console.error('[classifyAttachedImages] failed', err);
    if (imageUrls.length > 1) return 'clarify';
    return [
      {
        url: imageUrls[0],
        role: isDesignReferenceAsk(prompt) ? 'design_reference' : 'bug_reference',
      },
    ];
  }
}

/**
 * Vision OCR of design-reference screenshot(s): return the main readable
 * lines the patched section must include. Fail-closed → [] on error.
 */
export async function extractDesignReferenceCopy(opts: {
  imageUrls: string[];
  prompt: string;
  usage?: UsageContext;
}): Promise<string[]> {
  const { imageUrls, prompt, usage } = opts;
  if (imageUrls.length === 0) return [];
  try {
    const text = await askAI({
      system:
        'You read design-reference screenshots for a landing-page editor. Return JSON only:\n' +
        '{"lines":["exact visible phrase 1","exact visible phrase 2",...]}\n' +
        'Include every clear readable line of body/legal/contact/headline copy (not tiny UI chrome). ' +
        'Preserve exact wording/capitalization. Max 12 lines. Skip pure logo wordmarks if they are image-only.',
      messages: [
        {
          role: 'user',
          content: [
            ...imageUrls.slice(0, 3).map((url): AIContentBlock => ({ type: 'image', url })),
            {
              type: 'text',
              text: `User instruction: ${prompt.slice(0, 500)}\n\nExtract the visible copy lines from the design reference image(s).`,
            },
          ],
        },
      ],
      maxTokens: 1200,
      label: 'follow-up:design-ref-ocr',
      usage: usage ? { ...usage, operation: 'route' } : undefined,
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const parsed = JSON.parse(raw) as { lines?: unknown };
    if (!Array.isArray(parsed.lines)) return [];
    const out: string[] = [];
    for (const line of parsed.lines) {
      if (typeof line !== 'string') continue;
      const t = line.replace(/\s+/g, ' ').trim();
      if (t.length >= 6 && t.length <= 280) out.push(t);
      if (out.length >= 12) break;
    }
    return out;
  } catch (err) {
    console.error('[extractDesignReferenceCopy] failed', err);
    return [];
  }
}

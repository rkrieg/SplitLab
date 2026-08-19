/**
 * Follow-up edit helpers: clarify policy, multi-intent planning, post-patch verify.
 * Pure functions are unit-testable via scripts/verify-ai-follow-up-helpers.mjs
 * (mirrored logic) — keep behavior in sync when changing these.
 */

import { askAI, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import type { UsageContext } from '@/lib/ai-usage';
import { inferTargetSectionNames, dedupeDesignCopyLines } from '@/lib/ai-content-placement';
import { MAX_ATTACHMENTS } from '@/lib/ai-edit-intent';
import {
  sectionsContainingAsset,
  getSlSection,
  replaceSlSection,
  verifyImagePlacementEdit,
} from '@/lib/ai-page-preservation';

export interface PlanStep {
  /** Narrow instruction for this step only */
  instruction: string;
  /** Preferred SL section names (exact), empty if unknown */
  target_sections: string[];
  /** Hint for routing — patch is the default */
  op: 'patch' | 'remove_section' | 'insert_section' | 'reorder_sections' | 'structural' | 'image_generate';
  /**
   * How many new sections an 'insert_section' step creates. The insert path
   * built exactly one regardless of the request, so "add 2 sections like this"
   * silently produced one and reported Done.
   */
  count?: number;
  /**
   * This step means "recreate this section to look like the attachment".
   * Decided by the planner that read the message and saw the images — a keyword
   * test here used to send "make the logo white" down the recreate-from-
   * screenshot path and rebuild a section nobody asked to touch.
   */
  design_match: boolean;
  /**
   * Images that belong to THIS step. Undefined means "use whatever the caller
   * would have used anyway" — every step used to receive every attachment, so
   * a two-screenshot message handed both references to both steps.
   */
  image_urls?: string[];
}

export type EditPlan =
  | { mode: 'single' }
  | { mode: 'clarify'; question: string }
  | { mode: 'execute'; steps: PlanStep[] };

/**
 * DEAD — no live callers. Kept only so the verify suites still compile.
 *
 * It existed to suppress a clarifying question when the user said "you decide".
 * The clarify path itself is now unreachable (see the leftover-dispatcher note
 * in follow-up/route.ts), so there is nothing left to suppress. Deleting it is
 * safe; it is left in place only to make the sweep's history readable.
 *
 * Do NOT wire this back in. Whether to ask a question is the classifier's
 * answer, not a regex's.
 */
export function userWantsUsToDecide(prompt: string): boolean {
  return /\b(you decide|your (call|choice|judgment)|feel free|up to you|i('m| am) (fine|ok|okay) (with )?whatever|surprise me|just (do|pick|choose|decide)|pick (one|for me)|whichever (you|makes)|don'?t ask|no (more )?questions)\b/i.test(
    prompt,
  );
}

/**
 * DEAD — no live callers. Kept only so the verify suites still compile.
 *
 * Screenshot + complaint about something visibly wrong — the image is the
 * answer. Asking "did you mean the logo?" when they already ranted about the
 * logo is the over-clarify failure from production logs.
 *
 * Superseded twice over: the classifier now reads the screenshot itself, and
 * the clarify path this guarded no longer runs. Do not revive — a regex
 * deciding "is this a complaint" is the exact bug class the sweep removed.
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
 * The prompt points at a source URL the user supplied in an EARLIER turn, or
 * complains the sourced logo is wrong — "get the logo from the website i gave
 * you", "it was in the first prompt", "still not using the correct logo".
 *
 * Logo/asset sourcing only ever looked at URLs in the current message, so these
 * asks dead-ended in a clarifying question ("I don't see a website URL…") about
 * something the user had already provided. Deliberately narrow: back-reference
 * or defect language only, never a bare "use the same logo" (that is an on-page
 * reuse ask, and inheriting a URL there would trigger a needless scrape).
 */
export function referencesEarlierSource(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  return [
    /\b(website|site|url|link|page)\b[\s\S]{0,40}\b(i|we)\s+(gave|sent|shared|provided|posted|mentioned)\b/i,
    /\b(i|we)\s+(gave|sent|shared|provided|posted|mentioned)\b[\s\S]{0,40}\b(website|site|url|link)\b/i,
    /\b(the|that)\s+(website|site|url|link)\b[\s\S]{0,25}\b(above|earlier|before|already|previously)\b/i,
    /\b(first|earlier|previous|original)\s+(prompt|message|request)\b/i,
    /\b(wrong|incorrect)\s+logo\b/i,
    /\bnot\s+(using|showing|the)\b[\s\S]{0,20}\b(correct|right|real|actual)\s+logo\b/i,
    /\blogo\b[^.]{0,30}\b(is\s+not|isn'?t|is)\s+(the\s+)?(correct|right|wrong)\b/i,
    /\b(correct|right|real|actual)\s+logo\b[^.]{0,25}\b(from|on)\s+(the\s+)?(site|website|url|link|page)\b/i,
  ].some((re) => re.test(t));
}

/**
 * DEAD — its only remaining caller is isScreenshotComplaint above, which is
 * itself dead. Nothing on a live request path reaches this.
 *
 * It used to answer "is this attachment a look to copy?" from wording, and that
 * answer then switched the executor between embed-all and embed-none. That
 * split is gone: every attachment is now shown to the model and the
 * instruction decides which URLs land in src
 * (`attachedImagesInstructionNote` in ai-edit-intent.ts).
 *
 * Do not revive. Reintroducing this reintroduces "my design screenshot became
 * the logo" and its mirror, "the photo I attached was never placed".
 */
export function isDesignReferenceAsk(prompt: string, hasAttachments = false): boolean {
  const t = prompt.trim();
  if (!t) return false;

  // An attached image is itself most of the signal. Requiring one of the exact
  // phrases below meant "also match the footer with screenshot" — an attachment,
  // a named section and the word screenshot — took the generic edit path, got no
  // design targeting, and ended in "no changes were applied".
  if (hasAttachments) {
    const MATCH_VERB =
      /\b(match|matching|copy|copied|replicate|recreate|mirror|mimic|follow|same|like|similar|as shown|according to)\b/i;
    const REFERENT = /\b(screenshot|screen\s?shot|image|photo|picture|design|mockup|reference|attachment|this|that|it)\b/i;
    if (MATCH_VERB.test(t) && REFERENT.test(t)) return true;
    if (/\bsimilar\s+to\s+(the\s+)?(screenshot|image|photo|this|that)\b/i.test(t)) return true;
    // "the logo colors are not properly copied" — a defect stated against the
    // attachment is still an ask to make the page look like the attachment.
    if (
      /\b(footer|nav(?:bar)?|header|hero|logo|section|form|cta|colou?rs?|font|spacing|layout)\b/i.test(t) &&
      /\b(not|isn'?t|aren'?t|wrong|off|incorrect|proper(?:ly)?|fix|adjust|correct)\b/i.test(t)
    ) {
      return true;
    }
  }
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
 * DEAD — no live callers.
 *
 * "Skip ambiguous routing" was the whole problem: a regex named the section,
 * routing never ran, and the only verb left was patch. WHERE the edit belongs
 * is now `resolveEditRegion`'s answer, and it is asked on every turn.
 */
export function inferDesignMatchSectionNames(prompt: string, sectionNames: string[]): string[] {
  return inferTargetSectionNames(prompt, sectionNames).slice(0, 3);
}

/**
 * DEAD — no live callers.
 *
 * Cheap heuristic: multiple distinct edit intents in one message.
 * False → skip planner AI call (keep single-ask path fast).
 *
 * The planner it gated is itself unreachable now (see the leftover-dispatcher
 * note in follow-up/route.ts) — the whole message goes to the region rewrite
 * in one piece and the model reads all the parts itself. Counting asks is
 * `intent.asks.length` when anything still needs it.
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
 * Did the edit actually DO what was asked?
 *
 * verifyScopedPatchIntent below can only check things code can measure: did the
 * bytes change, is the required asset present, did click-to-edit survive. That
 * leaves a real gap — "increase the footer logo size slightly" came back with
 * different HTML and an unchanged logo, passed every deterministic check, and
 * was reported to the user as Done. No regex can settle whether a logo got
 * bigger, and the space of things users ask for is unbounded, so this is a
 * model call: it sees the instruction and the before/after HTML and answers one
 * question.
 *
 * It grades an edit it did not write, on a question with a checkable answer —
 * not "is this good?" but "did this happen?". Anything other than a clear "no"
 * is treated as applied: a flaky check must never throw away a real edit.
 */
export async function verifyAskApplied(opts: {
  instruction: string;
  sectionName: string;
  beforeHtml: string;
  afterHtml: string;
  usage?: UsageContext;
}): Promise<{ applied: boolean; reason: string | null }> {
  const cap = (s: string) => (s.length > 50000 ? `${s.slice(0, 50000)}\n<!-- truncated -->` : s);
  try {
    const text = await askAI({
      system:
        'You check whether a requested edit was actually carried out on one section of a landing page. ' +
        'You are given the instruction, the section BEFORE, and the section AFTER. ' +
        'Return JSON only: {"applied":true|false,"reason":"<short reason when false>"}. ' +
        'applied=true when the AFTER html reflects what was asked, even partially or imperfectly. ' +
        'applied=false ONLY when the specific thing asked for plainly did not happen — e.g. the ask was ' +
        'to make a logo bigger and no size/width/height/scale on the logo changed, or the ask was to ' +
        'align items horizontally and the layout direction is unchanged. ' +
        'Unrelated changes elsewhere in the section do not make it applied. ' +
        'If you cannot tell, answer applied=true — a wrong "false" discards work the user wanted.',
      messages: [
        {
          role: 'user',
          content:
            `INSTRUCTION:\n${opts.instruction}\n\n` +
            `SECTION "${opts.sectionName}" BEFORE:\n${cap(opts.beforeHtml)}\n\n` +
            `SECTION "${opts.sectionName}" AFTER:\n${cap(opts.afterHtml)}`,
        },
      ],
      maxTokens: 300,
      label: 'follow-up:verify-ask-applied',
      usage: opts.usage ? { ...opts.usage, operation: 'route' } : undefined,
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { applied: true, reason: null };
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { applied?: unknown; reason?: unknown };
    if (parsed.applied === false) {
      return {
        applied: false,
        reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null,
      };
    }
    return { applied: true, reason: null };
  } catch (err) {
    // Unavailable check ≠ failed edit. Log it and let the edit stand.
    console.warn('[follow-up] verifyAskApplied unavailable — treating step as applied', err);
    return { applied: true, reason: null };
  }
}

/**
 * Was what disappeared a fair consequence of the request, or collateral damage?
 *
 * Counting what vanished is arithmetic and code does it well. Deciding whether
 * the user would MIND is a judgement, and the first version of this guard made
 * that call by counting: fewer headings than before ⇒ destruction ⇒ throw the
 * edit away. But "make the hero shorter and punchier" merging two headings into
 * one and "the edit ate your headings" are identical to a counter. That guard
 * would have reverted a good edit and told the user their page was left exactly
 * as it was — code overruling a sensible model decision, which is the whole
 * class of bug this system is meant to be rid of.
 *
 * So: code measures, the model judges. Anything other than a clear "this was
 * not asked for" is treated as intended — a guard that fires on a good edit is
 * worse than one that misses a bad one, because the user loses real work.
 */
export async function judgeUnrequestedLoss(opts: {
  prompt: string;
  losses: { images: string[]; sections: string[]; headings: string[]; editableFields: string[] };
  /**
   * Headings the page has NOW. Losses are computed by exact string match, so a
   * heading that was merely REWORDED is reported as deleted — which is most
   * copy edits. Without the current list the judge sees "the headline is gone"
   * and cannot tell a rewrite from a deletion.
   */
  headingsAfter?: string[];
  /**
   * Which section each lost image was in before the edit.
   *
   * Without this the judge was handed the string "1 image(s)" and nothing else,
   * and was expected to rule on it. It could not tell "the photo in the very
   * section you asked me to change" from "a photo somewhere else on the page" —
   * which is the whole question. It guessed, and a correct edit was thrown away.
   * Facts the model needs to answer are not optional context.
   */
  imageSections?: Array<{ url: string; sections: string[] }>;
  /**
   * Sections this edit was about, per the classifier. A loss inside one of them
   * is the normal shape of a successful edit; a loss outside them is the shape
   * of collateral damage. Stating which is which is not a decision — the judge
   * still rules.
   */
  requestedSections?: string[];
  usage?: UsageContext;
}): Promise<{ intended: boolean; summary: string | null }> {
  const { losses } = opts;
  const imageLine = (url: string): string => {
    const where = opts.imageSections?.find((x) => x.url === url)?.sections ?? [];
    const name = url.split('?')[0].split('/').pop() || url;
    const wasIn = where.length > 0 ? ` — was in section: ${where.join(', ')}` : '';
    const inScope =
      where.length > 0 && (opts.requestedSections ?? []).some((s) => where.includes(s))
        ? ' [INSIDE the section this edit was about]'
        : '';
    return `  - ${name}${wasIn}${inScope}`;
  };
  const described = [
    losses.images.length > 0
      ? `${losses.images.length} image(s):\n${losses.images.slice(0, 8).map(imageLine).join('\n')}`
      : null,
    losses.sections.length > 0 ? `section(s): ${losses.sections.join(', ')}` : null,
    losses.headings.length > 0
      ? `heading text no longer present: ${losses.headings.slice(0, 8).map((h) => `"${h}"`).join(' | ')}`
      : null,
    losses.editableFields.length > 0
      ? `${losses.editableFields.length} editable field(s): ${losses.editableFields.slice(0, 8).join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const nowNote =
    losses.headings.length > 0 && (opts.headingsAfter ?? []).length > 0
      ? `\n\nHEADINGS ON THE PAGE NOW:\n${(opts.headingsAfter ?? [])
          .slice(0, 12)
          .map((h) => `"${h}"`)
          .join(' | ')}\n(Compare the two lists: a heading whose wording simply changed is a REWRITE, not a deletion.)`
      : '';

  try {
    const text = await askAI({
      system:
        'A landing-page edit was carried out and some things are no longer on the page. ' +
        'Decide whether their disappearance is a reasonable consequence of what the user asked for, ' +
        'or damage they did not ask for and would object to. ' +
        'Return JSON only: {"intended":true|false,"summary":"<what was lost, in plain words, when false>"}. ' +
        'The summary is shown to the user verbatim as a standalone sentence, so write ONE complete ' +
        'sentence starting with a capital letter — it is not pasted into any other sentence. ' +
        'Name things the way they appear on the page ("the team member photo", "the pricing headline"); ' +
        'never quote internal identifiers like team.members.0.generated_image_url. ' +
        'Losses are detected by exact text match, so a heading that was REWORDED is reported as missing ' +
        'even though it is still there in new words — that is a rewrite, and rewrites are intended. ' +
        'intended=true when the loss follows naturally from the request — rewriting or condensing copy ' +
        'changes headings, a redesign replaces images, tightening a section merges elements, ' +
        'an explicit removal deletes things. ' +
        'A lost image marked [INSIDE the section this edit was about] is intended ONLY when the request ' +
        'actually says something about a picture, photo, logo or image for that area — putting one where ' +
        'one already was replaces it, and that is the edit working, not failing. The [INSIDE...] marker by ' +
        'itself proves nothing: if the request never mentions any image at all — it is about layout, ' +
        'spacing, color, responsiveness, wording, anything that is not a picture — a dropped image there ' +
        'is NOT explained by the edit, even though it sits in a section the edit was touching. Treat it ' +
        'exactly like a loss anywhere else on the page: intended=false. Say intended=true for an in-region ' +
        'image only when the request gives an actual image-related reason for it to be gone. ' +
        'intended=false ONLY when the loss is unrelated to what was asked — e.g. they asked to resize a logo ' +
        'and unrelated photos and headings vanished from elsewhere, OR an in-region image vanished with no ' +
        'image-related ask to explain it. ' +
        'When unsure, answer intended=true: wrongly calling a good edit "damage" throws away work the user wanted.',
      messages: [
        {
          role: 'user',
          content:
            `USER ASKED:\n${opts.prompt}\n\n` +
            ((opts.requestedSections ?? []).length > 0
              ? `THE EDIT WAS ABOUT THESE SECTIONS: ${opts.requestedSections!.join(', ')}\n\n`
              : '') +
            `NO LONGER ON THE PAGE:\n${described}${nowNote}`,
        },
      ],
      maxTokens: 300,
      label: 'follow-up:judge-loss',
      usage: opts.usage ? { ...opts.usage, operation: 'route' } : undefined,
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return { intended: true, summary: null };
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { intended?: unknown; summary?: unknown };
    if (parsed.intended === false) {
      return {
        intended: false,
        summary:
          typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : null,
      };
    }
    return { intended: true, summary: null };
  } catch (err) {
    // Can't ask ⇒ don't overrule. Keeping a possibly-imperfect edit beats
    // silently reverting a good one.
    console.warn('[follow-up] judgeUnrequestedLoss unavailable — treating loss as intended', err);
    return { intended: true, summary: null };
  }
}

/**
 * Fit a just-restored image into its section naturally, instead of leaving
 * it exactly where the deterministic repair mechanically dropped it (start
 * of the first container, capped at max-width so it can never break the
 * page — but not necessarily sized or placed like the section actually
 * wants). Runs AFTER that repair, per restored image, and can only ever
 * improve on it: the model's answer is verified (verifyImagePlacementEdit —
 * same src, every data-field and image the section had before is still
 * there, nothing shrank suspiciously) before it is trusted. A section that
 * fails verification, or a call that fails outright, keeps its
 * deterministic placement exactly as it was — this never makes things
 * worse than the caller's fallback.
 */
export async function placeRestoredImagesIntelligently(opts: {
  /** The page AFTER the deterministic restoreLostImagesInPlace repair already ran. */
  html: string;
  /** The page as it stood before the edit — context on how the section used to look. */
  beforeHtml: string;
  /** URLs restoreLostImagesInPlace just put back. */
  images: string[];
  usage?: UsageContext;
}): Promise<{ html: string; placed: string[] }> {
  let html = opts.html;
  const placed: string[] = [];

  for (const url of opts.images) {
    const owner = sectionsContainingAsset(html, url)[0];
    if (!owner) continue;
    const live = getSlSection(html, owner);
    if (!live) continue;
    const original = sectionsContainingAsset(opts.beforeHtml, url).includes(owner)
      ? getSlSection(opts.beforeHtml, owner)
      : null;

    try {
      const text = await askAI({
        system:
          'A section of a landing page just had one image mechanically reinserted after being ' +
          'accidentally dropped by an earlier edit. It is visible and cannot break the page (capped at ' +
          "max-width:100%), but it landed at a generic spot — the start of the section's first container " +
          '— and may look out of place: oversized relative to its neighbours, in the wrong spot in a ' +
          'row/column, or not matching the section\'s visual rhythm. ' +
          'Reposition and/or resize ONLY that one image (inline style only) so it fits naturally — match ' +
          'the size/shape of sibling images in the same section when there are any (e.g. a row of small ' +
          'logos/badges should all be the same size). ' +
          'Do not change the image\'s src or data-field attribute. Do not add, remove, or reword anything ' +
          'else in the section — no other tag, attribute, class or text may change. ' +
          'Return ONLY the corrected section HTML — no SL markers, no explanation, no code fence.',
        messages: [
          {
            role: 'user',
            content:
              (original
                ? `HOW THIS SECTION ORIGINALLY LOOKED (context on sizing/position only — its exact markup no longer applies, the section has since changed):\n${original.inner}\n\n`
                : '') +
              `THE SECTION NOW, WITH THE IMAGE MECHANICALLY REINSERTED:\n${live.inner}\n\n` +
              `THE IMAGE TO FIT IN: ${url}`,
          },
        ],
        maxTokens: 8000,
        label: 'follow-up:place-restored-image',
        usage: opts.usage ? { ...opts.usage, operation: 'route' } : undefined,
      });
      let raw = text.trim();
      if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
      if (!verifyImagePlacementEdit({ before: live.inner, after: raw, mustKeepSrc: url })) {
        console.warn('[follow-up] placeRestoredImagesIntelligently rejected model output — keeping deterministic placement', {
          section: owner,
          url: url.slice(0, 120),
        });
        continue;
      }
      html = replaceSlSection(html, owner, raw);
      placed.push(url);
    } catch (err) {
      console.warn('[follow-up] placeRestoredImagesIntelligently unavailable — keeping deterministic placement', err);
    }
  }

  return { html, placed };
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
  /**
   * Sections the intent classifier resolved this ask to target. When given,
   * this is what "did the user name this section" means — NOT a fresh keyword
   * guess. Without it, a vague-but-classifier-resolved ask like "make the logo
   * white everywhere it's used" (→ nav, footer) passed an identical-HTML patch
   * as "ok" because no literal "nav" or "footer" appeared in the prompt text.
   */
  /**
   * REQUIRED. The classifier's resolved sections for this ask — an empty array
   * is a valid answer ("it could not tell"). Required rather than optional so
   * there is no code path where this falls back to word-matching the prompt.
   */
  intentTargetSections: string[];
  /**
   * Classifier (or caller) already decided this step is a design-reference
   * match. When set, do not re-run isDesignReferenceAsk on the prompt — a
   * multi-ask that includes "like this" must not treat the logo-color step as
   * a design-match no-op.
   */
  designMatch?: boolean;
  /** Classifier's read on whether the user is deliberately deleting content. */
  removalIntent?: boolean;
}): { ok: true } | { ok: false; reason: string; severity: 'hard' | 'soft' } {
  const { prompt, sectionName, beforeHtml, afterHtml, requiredSubstring, requiredPhrases, intentTargetSections } = opts;
  const treatAsDesignMatch = opts.designMatch ?? false;

  if (requiredSubstring && !afterHtml.includes(requiredSubstring)) {
    return {
      ok: false,
      reason: `patched_${sectionName}_missing_required_asset`,
      severity: 'hard',
    };
  }

  // No visual/content change at all → caller usually catches htmlUnchanged at
  // page level; still flag section-level no-ops when quotes must land here.
  // Design-reference asks MUST rewrite the section to match the screenshot —
  // identical HTML is always a failure (not a soft pass).
  if (beforeHtml === afterHtml) {
    const quotes = extractVerifyQuotes(prompt);
    // The user naming this section ("make the navbar text bigger") is itself a
    // requirement: an identical section means the ask was not carried out, even
    // for style-only edits with nothing quotable to check for. The list is the
    // classifier's — authoritative even when EMPTY, since "resolved no section"
    // is an answer, not a reason to start keyword-guessing.
    const userNamedThisSection = intentTargetSections.includes(sectionName);
    if (
      quotes.length > 0 ||
      requiredSubstring ||
      treatAsDesignMatch ||
      userNamedThisSection ||
      (requiredPhrases && requiredPhrases.length > 0)
    ) {
      return { ok: false, reason: `patched_${sectionName}_unchanged`, severity: 'hard' };
    }
  }

  // Click-to-edit handles must survive. The preview's inline editor is driven
  // entirely by [data-field], so a rewrite that drops them silently takes away
  // the user's ability to edit that text by hand — invisible damage, and now
  // that soft misses are kept rather than discarded, nothing else would catch
  // it. Skipped when the user is deliberately removing content.
  if (!opts.removalIntent) {
    const lostFields = dataFieldNames(beforeHtml).filter(
      (f) => !dataFieldNames(afterHtml).includes(f),
    );
    if (lostFields.length > 0) {
      return {
        ok: false,
        reason: `patched_${sectionName}_lost_editable_fields:${lostFields.slice(0, 3).join(',')}`,
        severity: 'hard',
      };
    }
  }

  const phrases = (requiredPhrases ?? []).map((p) => p.trim()).filter((p) => p.length >= 6);
  if (phrases.length > 0) {
    // Compare as normalized text, not raw HTML substrings: OCR punctuation,
    // casing, entities and tag boundaries made this test fail on rewrites that
    // did carry the copy across, and the caller then threw the whole edit away.
    const haystack = normalizeForPhraseMatch(afterHtml);
    const hits = phrases.filter((p) => haystack.includes(normalizeForPhraseMatch(p)));
    // Require a clear majority of OCR'd lines — partial visual match is not Done.
    const need = Math.max(1, Math.ceil(phrases.length * 0.6));
    if (hits.length < need) {
      return {
        ok: false,
        reason: `patched_${sectionName}_missing_design_copy`,
        // SOFT: the section really was rewritten (beforeHtml !== afterHtml by
        // now), it just doesn't carry enough of the screenshot's wording. That
        // is a quality shortfall to report, not a reason to discard the edit and
        // tell the user nothing happened.
        severity: 'soft',
      };
    }
  }

  const quotes = extractVerifyQuotes(prompt);
  // If the user quoted new copy and the instruction looks like a rewrite/
  // replace toward that copy, require at least one quote in the patched HTML
  // when the quote was already present in this section before OR no other
  // section context — for multi-section patches we only enforce when the
  // before HTML already contained a similar phrase or the prompt names this section.
  // Classifier-resolved. No prompt-matching fallback exists any more.
  const namesThisSection = intentTargetSections.includes(sectionName);
  // A quoted phrase in the instruction is itself the rewrite signal — the verb
  // list ("change", "rewrite", "say"…) added nothing but false negatives for
  // any phrasing it hadn't anticipated.
  const rewriteIntent = quotes.length > 0;

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
        return {
          ok: false,
          reason: `patched_${sectionName}_missing_quoted_copy`,
          severity: 'hard',
        };
      }
    }
  }

  // Remove intent: quoted or clearly named UI chrome must leave this section
  // when the prompt says remove/get rid and names this section or the string
  // was only in this section's before HTML.
  // Classifier-decided; the keyword list here missed every phrasing it had not
  // been taught ("kill the strip", "that shouldn't be there").
  const removeIntent = opts.removalIntent === true;
  if (removeIntent && quotes.length > 0 && namesThisSection) {
    const stillPresent = quotes.filter((q) => afterHtml.includes(q) && beforeHtml.includes(q));
    if (stillPresent.length > 0 && stillPresent.length === quotes.length) {
      // All quoted bits still there after a remove on this named section
      return {
        ok: false,
        reason: `patched_${sectionName}_remove_did_not_apply`,
        severity: 'hard',
      };
    }
  }

  return { ok: true };
}

/** data-field names in a chunk of HTML — the page's click-to-edit handles. */
function dataFieldNames(html: string): string[] {
  const out: string[] = [];
  for (const m of Array.from(html.matchAll(/\bdata-field=["']([^"']+)["']/gi))) {
    const f = m[1].trim();
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** Text-level comparison: strip tags/entities, collapse space, ignore case. */
function normalizeForPhraseMatch(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PLANNER_SYSTEM = `You plan landing-page AI edits. Split a user message into ordered atomic edit steps when it contains multiple distinct intents. Return JSON only.

{"mode":"execute"|"clarify"|"single","steps":[{"instruction":"...","target_sections":["hero"],"op":"patch","count":1,"design_match":false}],"clarifying_question":null}

"design_match": true when THIS step means "make this section look like the attached screenshot" (recreate its layout/structure from the image). False for a targeted tweak that merely mentions something visible — recolouring or resizing a logo, changing a font, editing copy — where recreating the section from a screenshot would destroy work the user wants kept. Judge each step on its own: in "make the footer logo slightly bigger and add a section like this image", only the ADD step is design_match true.

"count": for op "insert_section", how many new sections this step creates ("add 2 sections like this" → 2). 1 otherwise.

Rules:
- mode "single": one clear intent (or already atomic) — return mode single and empty steps. The product will use the fast existing path.
- mode "execute": 2+ distinct intents — fill steps in order. Each step's instruction must be self-contained (copy the relevant detail from the user message). target_sections use EXACT names from the provided list when obvious; else [].
- mode "clarify": ONLY when you truly cannot proceed without knowing which section — and NEVER when the user said "you decide" / "feel free" / "just do it", NEVER when they attached a screenshot and are complaining about a visible defect (decide the fix yourself).
- Prefer execute over clarify. Prefer single when one patch covering 1-3 sections is enough (e.g. "center everything in the footer").
- op is usually "patch". Use "insert_section" when the step CREATES a section that is not on the page yet ("add a section like this image", "add an FAQ under the hero") — for that op "target_sections" is the ANCHOR it should sit next to, or [] if the user did not say where; never name a section just to fill the field, because naming one makes us edit that section and the new content ends up nested inside it. Use "remove_section" only to delete a whole SL section. Use "reorder_sections" when the step MOVES existing sections without changing what is inside them ("footer should be at the bottom", "put testimonials above pricing") — moving a section is not something an edit to that section can do, so never describe a move as a "patch". Use "structural" for "strip the page down to hero+footer" style trims. Use "image_generate" only for brand-new AI image creation.
- Constraints are not steps. "keep the dark theme", "don't touch the nav", "same fonts" describe HOW the other steps must be done — never emit a step whose only job is to leave something as it is. Such a step correctly changes nothing and is then reported to the user as a failed edit.
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
  /** Classifier-split asks — prefer these over a second planner call. */
  seedAsks?: Array<{
    instruction: string;
    sections: string[];
    op?: 'edit' | 'add' | 'remove' | 'reorder';
    count?: number;
    designMatch?: boolean;
    imageIndexes?: number[];
  }>;
  /** Standing conditions that qualify every step ("keep the dark theme"). */
  constraints?: string[];
  /** Classifier's read on whether this message is a "look like this" ask. */
  designMatch?: boolean;
}): Promise<EditPlan> {
  const { prompt, sectionNames, sectionPreviews, imageUrls, forceDecide, usage } = opts;

  const seeded: PlanStep[] = (opts.seedAsks ?? [])
    .filter((a) => a && typeof a.instruction === 'string' && a.instruction.trim())
    .slice(0, 5)
    .map((a) => {
      // Classifier-resolved sections only. An empty list is honest ("it could
      // not tell") and the caller resolves it with another model call — a
      // keyword guess here landed edits in whatever section a word matched.
      const named = (a.sections ?? []).filter((n) => sectionNames.includes(n));
      // The ask's own op, not a hardcoded 'patch'. Seeding every step as a
      // patch meant that whenever the classifier split a message into 2+ asks,
      // "add a section" could only ever be carried out as "edit a section" —
      // the planner, the one component that can assign insert/remove/reorder,
      // is skipped entirely on the seeded path.
      const op: PlanStep['op'] =
        a.op === 'add'
          ? 'insert_section'
          : a.op === 'remove'
            ? 'remove_section'
            : a.op === 'reorder'
              ? // Its own op, not 'structural'. A "structural" step whose target
                // section resolves goes straight down the scoped-patch path, and
                // rewriting a section's HTML can never move that section — which
                // is how "footer should always be at the bottom" reported success
                // with the footer still stuck in the middle of the page.
                'reorder_sections'
              : 'patch';
      return {
        instruction: a.instruction.trim(),
        target_sections: named,
        op,
        count: a.count ?? 1,
        // Per-ask, never the message-level flag. Blanket-applying it told
        // every step of a multi-ask edit to recreate its section from the
        // attachment, which is how a "make the logo slightly bigger" step
        // rebuilt a footer out of a property-gallery screenshot.
        design_match: a.designMatch === true,
        // Only this ask's own references. Undefined (not []) when the
        // classifier didn't single any out, so the caller keeps today's
        // behaviour of passing everything rather than passing nothing.
        image_urls:
          (a.imageIndexes ?? []).length > 0
            ? (a.imageIndexes ?? []).map((i) => imageUrls[i]).filter((u): u is string => !!u)
            : undefined,
      };
    });
  // A single structural ask ("add a section like this image") also goes down
  // the step executor, because that is the only path that can insert, remove or
  // reorder. Returning 'single' for it sends it to the patch path, where the
  // only available verb is "edit an existing section".
  if (seeded.length >= 2 || (seeded.length === 1 && seeded[0].op !== 'patch')) {
    return { mode: 'execute', steps: seeded };
  }

  try {
    const list = sectionPreviews
      .map((s) => `- ${s.name}: "${s.text.slice(0, 120)}"`)
      .join('\n');
    const textPart =
      `Available sections:\n${list}\n\nKnown names: ${sectionNames.join(', ')}\n\nUser instruction:\n${prompt}` +
      ((opts.constraints ?? []).length > 0
        ? `\n\nStanding conditions on every step (these are NOT steps — do not emit a step for them):\n${(opts.constraints ?? []).map((c) => `- ${c}`).join('\n')}`
        : '') +
      (forceDecide
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
      steps?: Array<{ instruction?: string; target_sections?: string[]; op?: string; design_match?: boolean; count?: number }>;
      clarifying_question?: string | null;
    };

    if (parsed.mode === 'clarify') {
      if (forceDecide) {
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
          s.op === 'remove_section' ||
          s.op === 'insert_section' ||
          s.op === 'reorder_sections' ||
          s.op === 'structural' ||
          s.op === 'image_generate'
            ? s.op
            : 'patch';
        steps.push({
          instruction: s.instruction.trim(),
          // Planner-resolved only. Empty means "it could not tell" — the caller
          // asks the model again rather than keyword-matching a section here.
          target_sections: targets,
          op,
          count:
            op === 'insert_section' && typeof s.count === 'number'
              ? Math.min(Math.max(Math.floor(s.count), 1), 4)
              : 1,
          design_match: s.design_match === true,
        });
      }
      if (steps.length >= 2) return { mode: 'execute', steps };
    }

    return { mode: 'single' };
  } catch (err) {
    console.error('[ai-follow-up-helpers] planMultiIntentEdit failed — treating as single', err);
    return { mode: 'single' };
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
        'Preserve exact wording/capitalization. Max 12 UNIQUE lines. Skip pure logo wordmarks if they are image-only.\n' +
        'If two or more images are the SAME screenshot (or near-duplicates / extra crops of one shot), extract the copy ONCE. Never list the same sentence twice.',
      messages: [
        {
          role: 'user',
          content: [
            ...imageUrls.slice(0, MAX_ATTACHMENTS).map((url): AIContentBlock => ({ type: 'image', url })),
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
    return dedupeDesignCopyLines(out);
  } catch (err) {
    console.error('[extractDesignReferenceCopy] failed', err);
    return [];
  }
}

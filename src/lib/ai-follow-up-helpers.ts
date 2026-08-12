/**
 * Follow-up edit helpers: clarify policy, multi-intent planning, post-patch verify.
 * Pure functions are unit-testable via scripts/verify-ai-follow-up-helpers.mjs
 * (mirrored logic) — keep behavior in sync when changing these.
 */

import { askAI, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import type { UsageContext } from '@/lib/ai-usage';

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
  return /\b(look(s|ing)? (at )?(this|that|it)|can you (not )?see|this is (ridiculous|absurd|sloppy|wrong|broken|weird)|it looks|doesn'?t (even )?(blend|match|look)|fake logo|line breaks|dark around|background.*(wrong|weird|not)|not (even )?the same)\b/i.test(
    prompt,
  );
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

  // Explicit separators between asks
  if (/\b(?:also|plus|then|after that|and also|as well as)\b/i.test(t) && t.length > 60) {
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
}): { ok: true } | { ok: false; reason: string } {
  const { prompt, sectionName, beforeHtml, afterHtml, requiredSubstring } = opts;

  if (requiredSubstring && !afterHtml.includes(requiredSubstring)) {
    return { ok: false, reason: `patched_${sectionName}_missing_required_asset` };
  }

  // No visual/content change at all → caller usually catches htmlUnchanged at
  // page level; still flag section-level no-ops when quotes must land here.
  if (beforeHtml === afterHtml) {
    const quotes = extractVerifyQuotes(prompt);
    if (quotes.length > 0 || requiredSubstring) {
      return { ok: false, reason: `patched_${sectionName}_unchanged` };
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

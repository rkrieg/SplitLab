/**
 * Narrow post-build / post-logo-swap visual QA.
 * Nav/logo defects only — one diagnose call, at most one fix. Fail-closed:
 * any error leaves HTML unchanged. Never invents logos or rebuilds the page.
 *
 * Prefer LIVE result screenshot (ApiFlash top-of-page) when available; fall
 * back to HTML + reference screenshots. If live capture fails → skip live path
 * (caller may still run HTML fallback or proceed to Done).
 */

import { askAI, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import type { UsageContext } from '@/lib/ai-usage';
import { userWantsLogoFromReference } from '@/lib/ai-brand-assets';
import { capturePageTopScreenshot } from '@/lib/ai-competitor-scrape';

export interface NavLogoQaResult {
  ok: boolean;
  issues: string[];
  fix_instruction: string | null;
}

export interface NavLogoQaInput {
  /** Built page HTML (full document or fragment with SL markers) */
  html: string;
  /** User create/edit prompt */
  prompt?: string | null;
  /** Expected real logo URL if we have one */
  expectedLogoUrl?: string | null;
  /** User-attached image URLs (https) */
  imageUrls?: string[];
  /** Competitor ApiFlash screenshots (jpeg base64, no data: prefix) */
  competitorScreenshots?: string[];
  /**
   * Live screenshot of OUR built page (top viewport, jpeg base64).
   * When present, vision compares pixels (result vs reference) — stronger signal.
   */
  resultScreenshot?: string | null;
  /** True when this pass follows a logo swap / logo embed */
  logoIntent?: boolean;
  usage?: UsageContext;
  label?: string;
}

const QA_SYSTEM = `You review ONLY the navigation/logo area of a landing page for defects.
Return JSON only:
{"ok":true|false,"issues":["..."],"fix_instruction":null|"one concrete instruction to fix the nav HTML"}

Rules:
- Scope: logo mark, nav logo sizing, dark/opaque boxes behind the logo, screenshot-thumb used as logo, missing logo when expectedLogoUrl is provided, broken layout of the logo row ONLY.
- If a RESULT screenshot (our built page) is provided, judge primarily from PIXELS in the nav/logo band — compare to REFERENCE screenshots when present.
- If only NAV HTML + reference is provided (no result shot), inspect the HTML for the same defect classes.
- ok=true when nav/logo looks acceptable. Prefer ok=true when unsure.
- ok=false only for clear, high-confidence defects.
- fix_instruction must be a single actionable HTML edit for the nav section (not a full page redesign). Mention exact expectedLogoUrl if provided.
- Never invent a new logo asset URL. Never ask to redesign the whole page.
- Max 3 issues. No markdown fences.`;

/**
 * Gate: only run when we have something to look at AND logo/nav intent.
 */
export function shouldRunNavLogoVisualQa(opts: {
  prompt?: string | null;
  imageUrls?: string[];
  competitorScreenshots?: string[];
  resultScreenshot?: string | null;
  logoIntent?: boolean;
  expectedLogoUrl?: string | null;
}): boolean {
  const hasExternalRef =
    (opts.imageUrls?.length ?? 0) > 0 || (opts.competitorScreenshots?.length ?? 0) > 0;
  const hasResult = !!opts.resultScreenshot;
  if (!hasExternalRef && !hasResult) return false;
  if (opts.logoIntent) return true;
  if (opts.expectedLogoUrl) return true;
  if (opts.prompt && userWantsLogoFromReference(opts.prompt)) return true;
  if (
    opts.prompt &&
    /\b(nav|navbar|header)\b/i.test(opts.prompt) &&
    /\b(logo|look|fix|wrong|sloppy)\b/i.test(opts.prompt)
  ) {
    return true;
  }
  return hasExternalRef && !!opts.expectedLogoUrl;
}

export function extractNavSectionHtml(html: string): {
  sectionHtml: string;
  replace: (nextSectionHtml: string) => string;
} | null {
  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  if (slNav) {
    const inner = slNav[1];
    return {
      sectionHtml: inner.trim().length > 0 ? inner : slNav[0],
      replace: (next) =>
        html.slice(0, slNav.index) +
        `<!-- SL:nav -->${next}<!-- /SL:nav -->` +
        html.slice(slNav.index + slNav[0].length),
    };
  }
  const headerOrNav = /<(header|nav)\b[^>]*>[\s\S]*?<\/\1>/i.exec(html);
  if (headerOrNav) {
    return {
      sectionHtml: headerOrNav[0],
      replace: (next) =>
        html.slice(0, headerOrNav.index) + next + html.slice(headerOrNav.index + headerOrNav[0].length),
    };
  }
  return null;
}

function parseQaJson(text: string): NavLogoQaResult | null {
  let raw = text.trim();
  if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      issues?: unknown;
      fix_instruction?: unknown;
    };
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((x): x is string => typeof x === 'string').slice(0, 3)
      : [];
    const fix =
      typeof parsed.fix_instruction === 'string' && parsed.fix_instruction.trim()
        ? parsed.fix_instruction.trim()
        : null;
    const ok = parsed.ok === true || (parsed.ok !== false && !fix);
    return { ok, issues, fix_instruction: ok ? null : fix };
  } catch {
    return null;
  }
}

/**
 * One vision call. Fail-closed → { ok: true } on any failure (skip fix).
 */
export async function runNavLogoVisualQa(input: NavLogoQaInput): Promise<NavLogoQaResult> {
  if (
    !shouldRunNavLogoVisualQa({
      prompt: input.prompt,
      imageUrls: input.imageUrls,
      competitorScreenshots: input.competitorScreenshots,
      resultScreenshot: input.resultScreenshot,
      logoIntent: input.logoIntent,
      expectedLogoUrl: input.expectedLogoUrl,
    })
  ) {
    return { ok: true, issues: [], fix_instruction: null };
  }

  const nav = extractNavSectionHtml(input.html);
  if (!nav) {
    return { ok: true, issues: [], fix_instruction: null };
  }

  const refShots = (input.competitorScreenshots ?? []).slice(0, 2);
  const urls = (input.imageUrls ?? []).slice(0, 2);
  const resultShot = input.resultScreenshot?.trim() || null;

  if (refShots.length === 0 && urls.length === 0 && !resultShot) {
    return { ok: true, issues: [], fix_instruction: null };
  }

  const textPart =
    `User prompt (context):\n${(input.prompt ?? '').slice(0, 1500)}\n\n` +
    (input.expectedLogoUrl
      ? `expectedLogoUrl (must be used as logo <img src> if a logo is shown):\n${input.expectedLogoUrl}\n\n`
      : 'No expectedLogoUrl provided.\n\n') +
    (resultShot
      ? 'Images below: REFERENCE screenshot(s) first (brand target), then OUR RESULT (top of the page we just built). Compare nav/logo pixels.\n\n'
      : 'No live result screenshot — review NAV HTML against reference image(s).\n\n') +
    `NAV/HEADER HTML:\n${nav.sectionHtml.slice(0, 12_000)}\n`;

  const blocks: AIContentBlock[] = [];
  if (refShots.length > 0) {
    blocks.push({ type: 'text', text: 'REFERENCE screenshot(s) of the target brand:' });
    for (const data of refShots) {
      blocks.push({ type: 'image_base64', data, mediaType: 'image/jpeg' });
    }
  }
  for (const url of urls) {
    blocks.push({ type: 'image', url });
  }
  if (resultShot) {
    blocks.push({ type: 'text', text: 'OUR RESULT — top of the page we built (judge nav/logo from this):' });
    blocks.push({ type: 'image_base64', data: resultShot, mediaType: 'image/jpeg' });
  }
  blocks.push({ type: 'text', text: textPart });

  try {
    const text = await askAI({
      system: QA_SYSTEM,
      messages: [{ role: 'user', content: blocks }],
      maxTokens: 800,
      label: input.label ?? 'visual-qa:nav-logo',
      usage: input.usage ? { ...input.usage, operation: 'route' } : undefined,
    });
    const parsed = parseQaJson(text);
    if (!parsed) {
      console.warn('[visual-qa] parse failed — treating as ok (fail-closed)');
      return { ok: true, issues: [], fix_instruction: null };
    }
    console.log('[visual-qa] result', {
      ok: parsed.ok,
      issues: parsed.issues,
      hasFix: !!parsed.fix_instruction,
      hadLiveResult: !!resultShot,
    });
    return parsed;
  } catch (err) {
    console.error('[visual-qa] diagnose failed — skip', err);
    return { ok: true, issues: [], fix_instruction: null };
  }
}

const FIX_SYSTEM = `You fix ONLY a landing-page nav/header HTML fragment for logo defects.
Return JSON only: {"html":"<complete section HTML>"}
Rules:
- Keep the same outermost tag as the input (nav/header/div).
- Apply the fix instruction. Do not redesign the whole page.
- If an expected logo URL is given, use it exactly as <img src>.
- No dark/opaque background box behind the logo — transparent / sits on the nav background.
- No markdown fences.`;

/**
 * Apply one nav/logo fix from a QA instruction. Fail-closed: returns original html on failure.
 */
export async function applyNavLogoVisualFix(opts: {
  html: string;
  fixInstruction: string;
  expectedLogoUrl?: string | null;
  imageUrls?: string[];
  usage?: UsageContext;
  label?: string;
}): Promise<{ html: string; applied: boolean }> {
  const nav = extractNavSectionHtml(opts.html);
  if (!nav) return { html: opts.html, applied: false };

  const textPart =
    `Fix instruction:\n${opts.fixInstruction}\n\n` +
    (opts.expectedLogoUrl ? `expectedLogoUrl:\n${opts.expectedLogoUrl}\n\n` : '') +
    `Current section HTML:\n${nav.sectionHtml.slice(0, 12_000)}`;

  const urls = (opts.imageUrls ?? []).slice(0, 2);
  const userContent: AIContent =
    urls.length > 0
      ? [...urls.map((url): AIContentBlock => ({ type: 'image', url })), { type: 'text', text: textPart }]
      : textPart;

  try {
    const text = await askAI({
      system: FIX_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 8000,
      label: opts.label ?? 'visual-qa:nav-logo-fix',
      usage: opts.usage ? { ...opts.usage, operation: 'build' } : undefined,
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const parsed = JSON.parse(raw) as { html?: string };
    const next = typeof parsed.html === 'string' ? parsed.html.trim() : '';
    if (!next || next.length < 20) return { html: opts.html, applied: false };

    const origTag = /^\s*<([a-zA-Z][a-zA-Z0-9]*)/.exec(nav.sectionHtml)?.[1]?.toLowerCase();
    const newTag = /^\s*<([a-zA-Z][a-zA-Z0-9]*)/.exec(next)?.[1]?.toLowerCase();
    if (origTag && newTag && origTag !== newTag) {
      if (!/^<!--/.test(nav.sectionHtml.trim())) {
        console.warn('[visual-qa] fix outer-tag mismatch — skip', { origTag, newTag });
        return { html: opts.html, applied: false };
      }
    }

    if (
      opts.expectedLogoUrl &&
      !next.includes(opts.expectedLogoUrl) &&
      nav.sectionHtml.includes(opts.expectedLogoUrl)
    ) {
      console.warn('[visual-qa] fix dropped expectedLogoUrl — skip');
      return { html: opts.html, applied: false };
    }

    const updated = nav.replace(next);
    if (updated === opts.html) return { html: opts.html, applied: false };
    return { html: updated, applied: true };
  } catch (err) {
    console.error('[visual-qa] fix failed — skip', err);
    return { html: opts.html, applied: false };
  }
}

/**
 * Once-only: diagnose → optional one fix. Never throws; never blocks Done.
 */
export async function runNavLogoVisualQaOnce(input: NavLogoQaInput): Promise<{
  html: string;
  ran: boolean;
  appliedFix: boolean;
  issues: string[];
  usedLiveResult: boolean;
}> {
  if (
    !shouldRunNavLogoVisualQa({
      prompt: input.prompt,
      imageUrls: input.imageUrls,
      competitorScreenshots: input.competitorScreenshots,
      resultScreenshot: input.resultScreenshot,
      logoIntent: input.logoIntent,
      expectedLogoUrl: input.expectedLogoUrl,
    })
  ) {
    return { html: input.html, ran: false, appliedFix: false, issues: [], usedLiveResult: false };
  }

  const qa = await runNavLogoVisualQa(input);
  if (qa.ok || !qa.fix_instruction) {
    return {
      html: input.html,
      ran: true,
      appliedFix: false,
      issues: qa.issues,
      usedLiveResult: !!input.resultScreenshot,
    };
  }

  const fixed = await applyNavLogoVisualFix({
    html: input.html,
    fixInstruction: qa.fix_instruction,
    expectedLogoUrl: input.expectedLogoUrl,
    imageUrls: input.imageUrls,
    usage: input.usage,
    label: `${input.label ?? 'visual-qa'}:fix`,
  });

  return {
    html: fixed.html,
    ran: true,
    appliedFix: fixed.applied,
    issues: qa.issues,
    usedLiveResult: !!input.resultScreenshot,
  };
}

/**
 * Post-upload live QA: screenshot the public HTML URL (top viewport), compare to
 * reference, one nav fix max. If screenshot fails → HTML-only fallback when
 * references exist; never throws; never blocks Done.
 */
export async function runPostUploadNavLogoQa(opts: {
  html: string;
  publicHtmlUrl: string;
  prompt?: string | null;
  expectedLogoUrl?: string | null;
  imageUrls?: string[];
  competitorScreenshots?: string[];
  logoIntent?: boolean;
  usage?: UsageContext;
  label?: string;
  /** Brief delay so storage CDN can serve the just-uploaded file */
  settleMs?: number;
}): Promise<{
  html: string;
  appliedFix: boolean;
  issues: string[];
  mode: 'live' | 'html_fallback' | 'skipped';
}> {
  const hasExternalRef =
    (opts.imageUrls?.length ?? 0) > 0 || (opts.competitorScreenshots?.length ?? 0) > 0;
  const canAttemptLive =
    opts.logoIntent || !!opts.expectedLogoUrl || hasExternalRef ||
    !!(opts.prompt && userWantsLogoFromReference(opts.prompt));

  if (!canAttemptLive) {
    return { html: opts.html, appliedFix: false, issues: [], mode: 'skipped' };
  }

  // Need either external refs or logo intent to bother with a live shot
  if (!hasExternalRef && !opts.logoIntent && !opts.expectedLogoUrl) {
    return { html: opts.html, appliedFix: false, issues: [], mode: 'skipped' };
  }

  const settle = opts.settleMs ?? 1500;
  if (settle > 0) {
    await new Promise((r) => setTimeout(r, settle));
  }

  const live = await capturePageTopScreenshot(opts.publicHtmlUrl);
  if (live) {
    const qa = await runNavLogoVisualQaOnce({
      html: opts.html,
      prompt: opts.prompt,
      expectedLogoUrl: opts.expectedLogoUrl,
      imageUrls: opts.imageUrls,
      competitorScreenshots: opts.competitorScreenshots,
      resultScreenshot: live,
      logoIntent: opts.logoIntent ?? true,
      usage: opts.usage,
      label: opts.label ?? 'visual-qa:live',
    });
    return {
      html: qa.html,
      appliedFix: qa.appliedFix,
      issues: qa.issues,
      mode: 'live',
    };
  }

  // Screenshot failed — HTML + reference fallback only when we have external refs
  if (!hasExternalRef) {
    console.warn('[visual-qa] live screenshot unavailable and no reference images — skip');
    return { html: opts.html, appliedFix: false, issues: [], mode: 'skipped' };
  }

  console.warn('[visual-qa] live screenshot unavailable — HTML fallback');
  const fallback = await runNavLogoVisualQaOnce({
    html: opts.html,
    prompt: opts.prompt,
    expectedLogoUrl: opts.expectedLogoUrl,
    imageUrls: opts.imageUrls,
    competitorScreenshots: opts.competitorScreenshots,
    logoIntent: opts.logoIntent ?? true,
    usage: opts.usage,
    label: `${opts.label ?? 'visual-qa'}:html-fallback`,
  });
  return {
    html: fallback.html,
    appliedFix: fallback.appliedFix,
    issues: fallback.issues,
    mode: fallback.ran ? 'html_fallback' : 'skipped',
  };
}

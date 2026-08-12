/**
 * Post-build / post-edit WHOLE-SCROLL visual QA (fail-closed).
 *
 * Flow: screenshot the built page (1–3 chunks) → one diagnose call → automatic
 * fixes on named SL sections only (max 4). Never a blind full-HTML rewrite.
 * Capture/QA failure → skip → Done unchanged.
 */

import { askAI, type AIContent, type AIContentBlock } from '@/lib/ai-client';
import type { UsageContext } from '@/lib/ai-usage';
import { userWantsLogoFromReference } from '@/lib/ai-brand-assets';
import {
  capturePageScrollScreenshots,
} from '@/lib/ai-competitor-scrape';

const MAX_SECTION_FIXES = 2;
const MAX_SECTION_HTML_CHARS = 10_000;

/**
 * Kill switch for live visual QA (ApiFlash of OUR page → vision → section rewrite).
 *
 * Off because a capture of an S3 NoSuchBucket error page was treated as the
 * built page: QA rewrote nav/hero, stripped data-field (click-to-edit died),
 * and hung on "Checking full page look…". Intent/routing is now model-
 * classified; this pixel pass is optional polish and currently harmful.
 * Call sites in build + follow-up are also commented out. Flip this AND
 * restore those call sites only after captures are proven to be our HTML
 * and rewrites keep data-field + SL markers.
 */
const LIVE_VISUAL_QA_ENABLED = false;

export interface VisualQaResult {
  ok: boolean;
  issues: string[];
  /** @deprecated use fixes */
  fix_instruction: string | null;
  fixes: Array<{ section: string; fix_instruction: string }>;
}

/** @deprecated alias */
export type NavLogoQaResult = VisualQaResult;

export interface VisualQaInput {
  html: string;
  prompt?: string | null;
  expectedLogoUrl?: string | null;
  imageUrls?: string[];
  competitorScreenshots?: string[];
  /** Single result shot (legacy) */
  resultScreenshot?: string | null;
  /** Whole-scroll chunks of OUR built page */
  resultScreenshots?: string[];
  logoIntent?: boolean;
  usage?: UsageContext;
  label?: string;
}

/** @deprecated alias */
export type NavLogoQaInput = VisualQaInput;

const QA_SYSTEM = `You are a landing-page visual QA reviewer for the FULL page the user will scroll.

Compare REFERENCE screenshot(s) (brand target) to OUR RESULT screenshot chunk(s) of the page we built, plus section HTML summaries.

Return JSON only:
{
  "ok": true|false,
  "issues": ["short issue", ...],
  "fixes": [{"section":"<exact SL section name>","fix_instruction":"one concrete HTML edit for that section only"}]
}

Rules:
- Review the whole scroll: nav/logo, hero, mid sections, footer — spacing, clutter, CTAs, logo defects, broken layout.
- fixes[].section MUST be one of the provided available section names (exact match).
- Max ${MAX_SECTION_FIXES} fixes. Only clearly broken sections. Prefer ok=true when unsure.
- Do NOT request a full-page redesign or rewrite of every section. Targeted section fixes only.
- If expectedLogoUrl is provided and the logo is wrong/missing/boxed, include a nav (or header) fix using that EXACT URL.
- Never invent new logo/image URLs.
- Max 5 issues. No markdown fences. Empty fixes when ok=true.`;

const FIX_SYSTEM = `You fix ONE landing-page section HTML fragment for visual defects.
Return JSON only: {"html":"<complete section HTML>"}
Rules:
- Keep the same outermost tag as the input.
- Apply the fix instruction only. Do not redesign other sections.
- If an expected logo URL is given and this is nav/header, use it exactly as <img src>.
- No dark/opaque box behind logos.
- No markdown fences.`;

export function listSlSectionNames(html: string): string[] {
  const names: string[] = [];
  const re = /<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const n = m[1].toLowerCase();
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

export function shouldRunNavLogoVisualQa(opts: {
  prompt?: string | null;
  imageUrls?: string[];
  competitorScreenshots?: string[];
  resultScreenshot?: string | null;
  resultScreenshots?: string[];
  logoIntent?: boolean;
  expectedLogoUrl?: string | null;
}): boolean {
  if (!LIVE_VISUAL_QA_ENABLED) return false;
  const hasExternalRef =
    (opts.imageUrls?.length ?? 0) > 0 || (opts.competitorScreenshots?.length ?? 0) > 0;
  const hasResult =
    !!opts.resultScreenshot || (opts.resultScreenshots?.length ?? 0) > 0;
  if (!hasExternalRef && !hasResult) return false;
  if (hasExternalRef) return true;
  if (opts.logoIntent) return true;
  if (opts.expectedLogoUrl) return true;
  if (opts.prompt && userWantsLogoFromReference(opts.prompt)) return true;
  if (
    opts.prompt &&
    /\b(nav|navbar|header|hero|footer|look like|replicate|clone)\b/i.test(opts.prompt)
  ) {
    return true;
  }
  return hasResult && (!!opts.expectedLogoUrl || !!opts.logoIntent);
}

export function extractNavSectionHtml(html: string): {
  sectionHtml: string;
  replace: (nextSectionHtml: string) => string;
} | null {
  return extractNamedSection(html, 'nav') ?? extractSlOrTagSection(html, 'nav', ['header', 'nav']);
}

export function extractHeroSectionHtml(html: string): {
  sectionHtml: string;
  replace: (nextSectionHtml: string) => string;
} | null {
  const sl = extractNamedSection(html, 'hero');
  if (sl) return sl;
  const heroLike =
    /<(section|div)\b[^>]*(?:id|class)\s*=\s*["'][^"']*\bhero\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/i.exec(
      html,
    );
  if (heroLike) {
    return {
      sectionHtml: heroLike[0],
      replace: (next) =>
        html.slice(0, heroLike.index) + next + html.slice(heroLike.index + heroLike[0].length),
    };
  }
  return null;
}

export function extractNamedSection(
  html: string,
  name: string,
): { sectionHtml: string; replace: (next: string) => string } | null {
  const re = new RegExp(
    `<!--\\s*SL:${escapeRegExp(name)}\\s*-->([\\s\\S]*?)<!--\\s*/SL:${escapeRegExp(name)}\\s*-->`,
    'i',
  );
  const m = re.exec(html);
  if (!m) return null;
  const inner = m[1];
  return {
    sectionHtml: inner.trim().length > 0 ? inner : m[0],
    replace: (next) =>
      html.slice(0, m.index) +
      `<!-- SL:${name} -->${next}<!-- /SL:${name} -->` +
      html.slice(m.index + m[0].length),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSlOrTagSection(
  html: string,
  slName: string,
  tags: string[],
): { sectionHtml: string; replace: (next: string) => string } | null {
  const sl = extractNamedSection(html, slName);
  if (sl) return sl;
  for (const tag of tags) {
    const re = new RegExp(`<(${tag})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'i');
    const m = re.exec(html);
    if (m) {
      return {
        sectionHtml: m[0],
        replace: (next) => html.slice(0, m.index) + next + html.slice(m.index + m[0].length),
      };
    }
  }
  return null;
}

function resolveSectionExtractor(
  html: string,
  section: string,
): { sectionHtml: string; replace: (next: string) => string } | null {
  const key = section.toLowerCase();
  if (key === 'nav' || key === 'header') return extractNavSectionHtml(html);
  if (key === 'hero') return extractHeroSectionHtml(html);
  if (key === 'footer') {
    return extractNamedSection(html, 'footer') ?? extractSlOrTagSection(html, 'footer', ['footer']);
  }
  return extractNamedSection(html, key);
}

function parseQaJson(text: string, allowedSections: string[]): VisualQaResult | null {
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
      fixes?: unknown;
    };
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((x): x is string => typeof x === 'string').slice(0, 5)
      : [];

    const allowed = new Set(allowedSections.map((s) => s.toLowerCase()));
    // Always allow common names even if markers missing
    for (const n of ['nav', 'hero', 'footer', 'header']) allowed.add(n);

    const fixes: Array<{ section: string; fix_instruction: string }> = [];
    if (Array.isArray(parsed.fixes)) {
      for (const row of parsed.fixes) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const section =
          typeof r.section === 'string' ? r.section.trim().toLowerCase() : '';
        const instr =
          typeof r.fix_instruction === 'string' ? r.fix_instruction.trim() : '';
        if (!section || !instr) continue;
        if (!allowed.has(section)) continue;
        if (fixes.some((f) => f.section === section)) continue;
        fixes.push({ section, fix_instruction: instr });
        if (fixes.length >= MAX_SECTION_FIXES) break;
      }
    }
    if (
      fixes.length === 0 &&
      typeof parsed.fix_instruction === 'string' &&
      parsed.fix_instruction.trim()
    ) {
      fixes.push({ section: 'nav', fix_instruction: parsed.fix_instruction.trim() });
    }

    const ok = parsed.ok === true || (parsed.ok !== false && fixes.length === 0);
    return {
      ok,
      issues,
      fix_instruction: fixes[0]?.fix_instruction ?? null,
      fixes: ok ? [] : fixes,
    };
  } catch {
    return null;
  }
}

function sectionPreviewBlock(html: string, names: string[]): string {
  const parts: string[] = [];
  for (const name of names.slice(0, 12)) {
    const ex = resolveSectionExtractor(html, name);
    if (!ex) continue;
    parts.push(
      `## SL:${name} (${ex.sectionHtml.length} chars)\n${ex.sectionHtml.slice(0, MAX_SECTION_HTML_CHARS)}\n`,
    );
  }
  return parts.join('\n');
}

/**
 * One vision diagnose. Fail-closed → ok=true on failure.
 */
export async function runNavLogoVisualQa(input: VisualQaInput): Promise<VisualQaResult> {
  if (!LIVE_VISUAL_QA_ENABLED) {
    return { ok: true, issues: [], fix_instruction: null, fixes: [] };
  }
  if (
    !shouldRunNavLogoVisualQa({
      prompt: input.prompt,
      imageUrls: input.imageUrls,
      competitorScreenshots: input.competitorScreenshots,
      resultScreenshot: input.resultScreenshot,
      resultScreenshots: input.resultScreenshots,
      logoIntent: input.logoIntent,
      expectedLogoUrl: input.expectedLogoUrl,
    })
  ) {
    return { ok: true, issues: [], fix_instruction: null, fixes: [] };
  }

  const sectionNames = listSlSectionNames(input.html);
  if (sectionNames.length === 0 && !extractNavSectionHtml(input.html) && !extractHeroSectionHtml(input.html)) {
    return { ok: true, issues: [], fix_instruction: null, fixes: [] };
  }

  const refShots = (input.competitorScreenshots ?? []).slice(0, 2);
  const urls = (input.imageUrls ?? []).slice(0, 2);
  const resultShots = [
    ...(input.resultScreenshots ?? []),
    ...(input.resultScreenshot ? [input.resultScreenshot] : []),
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);

  if (refShots.length === 0 && urls.length === 0 && resultShots.length === 0) {
    return { ok: true, issues: [], fix_instruction: null, fixes: [] };
  }

  const namesForPrompt =
    sectionNames.length > 0 ? sectionNames : ['nav', 'hero', 'footer'];

  const textPart =
    `User prompt (context):\n${(input.prompt ?? '').slice(0, 1500)}\n\n` +
    `Available section names (use EXACTLY these in fixes[].section):\n${namesForPrompt.join(', ')}\n\n` +
    (input.expectedLogoUrl
      ? `expectedLogoUrl:\n${input.expectedLogoUrl}\n\n`
      : '') +
    (resultShots.length > 0
      ? `OUR RESULT has ${resultShots.length} screenshot chunk(s) covering the page scroll (top→bottom).\n\n`
      : 'No live result screenshots — review section HTML vs reference.\n\n') +
    sectionPreviewBlock(input.html, namesForPrompt);

  const blocks: AIContentBlock[] = [];
  if (refShots.length > 0) {
    blocks.push({ type: 'text', text: 'REFERENCE screenshot(s):' });
    for (const data of refShots) {
      blocks.push({ type: 'image_base64', data, mediaType: 'image/jpeg' });
    }
  }
  for (const url of urls) {
    blocks.push({ type: 'image', url });
  }
  if (resultShots.length > 0) {
    blocks.push({
      type: 'text',
      text: 'OUR RESULT — page we built (chunks top → bottom). Judge the whole scroll:',
    });
    for (const data of resultShots) {
      blocks.push({ type: 'image_base64', data, mediaType: 'image/jpeg' });
    }
  }
  blocks.push({ type: 'text', text: textPart });

  try {
    const text = await askAI({
      system: QA_SYSTEM,
      messages: [{ role: 'user', content: blocks }],
      maxTokens: 1600,
      label: input.label ?? 'visual-qa:whole-scroll',
      usage: input.usage ? { ...input.usage, operation: 'route' } : undefined,
    });
    const parsed = parseQaJson(text, namesForPrompt);
    if (!parsed) {
      console.warn('[visual-qa] parse failed — treating as ok (fail-closed)');
      return { ok: true, issues: [], fix_instruction: null, fixes: [] };
    }
    console.log('[visual-qa] result', {
      ok: parsed.ok,
      issues: parsed.issues,
      fixes: parsed.fixes.map((f) => f.section),
      resultChunks: resultShots.length,
    });
    return parsed;
  } catch (err) {
    console.error('[visual-qa] diagnose failed — skip', err);
    return { ok: true, issues: [], fix_instruction: null, fixes: [] };
  }
}

export async function applySectionVisualFix(opts: {
  html: string;
  section: string;
  fixInstruction: string;
  expectedLogoUrl?: string | null;
  imageUrls?: string[];
  usage?: UsageContext;
  label?: string;
}): Promise<{ html: string; applied: boolean }> {
  if (!LIVE_VISUAL_QA_ENABLED) return { html: opts.html, applied: false };
  const extracted = resolveSectionExtractor(opts.html, opts.section);
  if (!extracted) return { html: opts.html, applied: false };

  const textPart =
    `Section: ${opts.section}\nFix instruction:\n${opts.fixInstruction}\n\n` +
    (opts.expectedLogoUrl ? `expectedLogoUrl:\n${opts.expectedLogoUrl}\n\n` : '') +
    `Current section HTML:\n${extracted.sectionHtml.slice(0, 14_000)}`;

  const urls = (opts.imageUrls ?? []).slice(0, 2);
  const userContent: AIContent =
    urls.length > 0
      ? [...urls.map((url): AIContentBlock => ({ type: 'image', url })), { type: 'text', text: textPart }]
      : textPart;

  try {
    const text = await askAI({
      system: FIX_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 12_000,
      label: opts.label ?? `visual-qa:fix-${opts.section}`,
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

    const origTag = /^\s*<([a-zA-Z][a-zA-Z0-9]*)/.exec(extracted.sectionHtml)?.[1]?.toLowerCase();
    const newTag = /^\s*<([a-zA-Z][a-zA-Z0-9]*)/.exec(next)?.[1]?.toLowerCase();
    if (origTag && newTag && origTag !== newTag) {
      if (!/^<!--/.test(extracted.sectionHtml.trim())) {
        console.warn('[visual-qa] fix outer-tag mismatch — skip', {
          section: opts.section,
          origTag,
          newTag,
        });
        return { html: opts.html, applied: false };
      }
    }

    const isNav = /^(nav|header)$/i.test(opts.section);
    if (
      isNav &&
      opts.expectedLogoUrl &&
      !next.includes(opts.expectedLogoUrl) &&
      extracted.sectionHtml.includes(opts.expectedLogoUrl)
    ) {
      console.warn('[visual-qa] fix dropped expectedLogoUrl — skip');
      return { html: opts.html, applied: false };
    }

    const updated = extracted.replace(next);
    if (updated === opts.html) return { html: opts.html, applied: false };
    return { html: updated, applied: true };
  } catch (err) {
    console.error('[visual-qa] fix failed — skip', err);
    return { html: opts.html, applied: false };
  }
}

export async function applyNavLogoVisualFix(opts: {
  html: string;
  fixInstruction: string;
  expectedLogoUrl?: string | null;
  imageUrls?: string[];
  usage?: UsageContext;
  label?: string;
}): Promise<{ html: string; applied: boolean }> {
  return applySectionVisualFix({
    html: opts.html,
    section: 'nav',
    fixInstruction: opts.fixInstruction,
    expectedLogoUrl: opts.expectedLogoUrl,
    imageUrls: opts.imageUrls,
    usage: opts.usage,
    label: opts.label,
  });
}

/**
 * Once-only: diagnose → auto-fix up to MAX_SECTION_FIXES named sections.
 */
export async function runNavLogoVisualQaOnce(input: VisualQaInput): Promise<{
  html: string;
  ran: boolean;
  appliedFix: boolean;
  issues: string[];
  usedLiveResult: boolean;
}> {
  if (!LIVE_VISUAL_QA_ENABLED) {
    return { html: input.html, ran: false, appliedFix: false, issues: [], usedLiveResult: false };
  }
  const resultShots = [
    ...(input.resultScreenshots ?? []),
    ...(input.resultScreenshot ? [input.resultScreenshot] : []),
  ];
  if (
    !shouldRunNavLogoVisualQa({
      prompt: input.prompt,
      imageUrls: input.imageUrls,
      competitorScreenshots: input.competitorScreenshots,
      resultScreenshot: input.resultScreenshot,
      resultScreenshots: resultShots,
      logoIntent: input.logoIntent,
      expectedLogoUrl: input.expectedLogoUrl,
    })
  ) {
    return { html: input.html, ran: false, appliedFix: false, issues: [], usedLiveResult: false };
  }

  const qa = await runNavLogoVisualQa({ ...input, resultScreenshots: resultShots });
  if (qa.ok || qa.fixes.length === 0) {
    return {
      html: input.html,
      ran: true,
      appliedFix: false,
      issues: qa.issues,
      usedLiveResult: resultShots.length > 0,
    };
  }

  let html = input.html;
  let anyApplied = false;
  const seen = new Set<string>();
  for (const fix of qa.fixes) {
    if (seen.has(fix.section)) continue;
    seen.add(fix.section);
    const fixed = await applySectionVisualFix({
      html,
      section: fix.section,
      fixInstruction: fix.fix_instruction,
      expectedLogoUrl: input.expectedLogoUrl,
      imageUrls: input.imageUrls,
      usage: input.usage,
      label: `${input.label ?? 'visual-qa'}:fix-${fix.section}`,
    });
    if (fixed.applied) {
      html = fixed.html;
      anyApplied = true;
    }
  }

  return {
    html,
    ran: true,
    appliedFix: anyApplied,
    issues: qa.issues,
    usedLiveResult: resultShots.length > 0,
  };
}

/**
 * Post-upload whole-scroll QA. Auto-fixes broken sections; never blocks Done.
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
  settleMs?: number;
}): Promise<{
  html: string;
  appliedFix: boolean;
  issues: string[];
  mode: 'live' | 'html_fallback' | 'skipped';
}> {
  if (!LIVE_VISUAL_QA_ENABLED) {
    return { html: opts.html, appliedFix: false, issues: [], mode: 'skipped' };
  }
  const hasExternalRef =
    (opts.imageUrls?.length ?? 0) > 0 || (opts.competitorScreenshots?.length ?? 0) > 0;
  const canAttemptLive =
    hasExternalRef ||
    opts.logoIntent ||
    !!opts.expectedLogoUrl ||
    !!(opts.prompt && userWantsLogoFromReference(opts.prompt)) ||
    !!(opts.prompt && /\b(look like|replicate|clone|exactly like)\b/i.test(opts.prompt));

  if (!canAttemptLive) {
    return { html: opts.html, appliedFix: false, issues: [], mode: 'skipped' };
  }

  const settle = opts.settleMs ?? 1500;
  if (settle > 0) {
    await new Promise((r) => setTimeout(r, settle));
  }

  const liveChunks = await capturePageScrollScreenshots(opts.publicHtmlUrl);
  if (liveChunks.length > 0) {
    const qa = await runNavLogoVisualQaOnce({
      html: opts.html,
      prompt: opts.prompt,
      expectedLogoUrl: opts.expectedLogoUrl,
      imageUrls: opts.imageUrls,
      competitorScreenshots: opts.competitorScreenshots,
      resultScreenshots: liveChunks,
      logoIntent: opts.logoIntent ?? hasExternalRef,
      usage: opts.usage,
      label: opts.label ?? 'visual-qa:live-scroll',
    });
    return {
      html: qa.html,
      appliedFix: qa.appliedFix,
      issues: qa.issues,
      mode: 'live',
    };
  }

  if (!hasExternalRef) {
    console.warn('[visual-qa] live screenshots unavailable and no reference — skip');
    return { html: opts.html, appliedFix: false, issues: [], mode: 'skipped' };
  }

  console.warn('[visual-qa] live screenshots unavailable — HTML fallback');
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

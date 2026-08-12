/**
 * Brand assets + shape intent from reference URLs.
 * Used by generate/build (create) and follow-up (edit) so "use the logo" works
 * without requiring the narrow "real/actual logo" phrasing.
 */

import { askAI } from '@/lib/ai-client';
import { uploadImage } from '@/lib/storage';

/** User wants a custom/minimal page — not a full clone of the reference URL. */
export function userWantsCustomOrMinimalPage(prompt: string): boolean {
  return /\b(pretty much just|just (look|be|the)|only (the )?(hero|footer)|hero (section )?only|thank[- ]?you|confirmation|confirmed|dead-?end|no buttons|no (calls? to action|ctas?)|nothing else|that'?s (pretty much|about) it|keep it (nice and )?simple|flat background|success page|receipt page|booked call)\b/i.test(
    prompt,
  );
}

/**
 * User wants the site's real logo asset from a URL / screenshot reference.
 * Broader than the old "real|actual logo" edit-only regex.
 */
export function userWantsLogoFromReference(prompt: string): boolean {
  return /\b((real|actual|exact|same|correct)\s+logo|use (the |their |this )?logo|logo from|with (the )?logo|keep (the )?logo|same logo|focused capital.*logo|logo.*from (this|the|that))\b/i.test(
    prompt,
  );
}

/** Edit path: URL present + any logo-from-site intent (not only real/actual). */
export function isLogoSwapFromUrlIntent(prompt: string, hasCompetitorUrl: boolean): boolean {
  if (!hasCompetitorUrl) return false;
  return userWantsLogoFromReference(prompt) || /\blogo\b/i.test(prompt);
}

/**
 * AI classify when regex is unsure. Prefer user custom/minimal over full clone
 * when unclear — cloning a whole LP against a confirmation prompt is the worse failure.
 */
export async function classifyPageShapeIntent(
  prompt: string,
): Promise<'minimal_or_custom' | 'full_reference'> {
  if (userWantsCustomOrMinimalPage(prompt)) return 'minimal_or_custom';
  try {
    const text = await askAI({
      system:
        'Classify landing-page build intent. Return JSON only: {"shape":"minimal_or_custom"|"full_reference"}.\n' +
        'minimal_or_custom = confirmation/thank-you/hero-only/dead-end/no CTAs/custom text that should NOT clone every section of a reference URL.\n' +
        'full_reference = user wants the page to closely match/replicate the linked site structure.\n' +
        'If both a URL and custom copy appear, prefer minimal_or_custom unless they clearly asked to copy the whole page.',
      messages: [{ role: 'user', content: prompt.slice(0, 4000) }],
      maxTokens: 200,
      label: 'generate:shape-classify',
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const parsed = JSON.parse(raw) as { shape?: string };
    if (parsed.shape === 'full_reference') return 'full_reference';
    if (parsed.shape === 'minimal_or_custom') return 'minimal_or_custom';
  } catch (err) {
    console.error('[classifyPageShapeIntent] failed — defaulting carefully', err);
  }
  // On classify failure: short URL-only / explicit clone phrasing → full; longer custom copy → minimal
  if (/\b(look like|replicate|clone|same as|exactly like|copy (this|the) (site|page))\b/i.test(prompt)) {
    return 'full_reference';
  }
  return /\bhttps?:\/\//i.test(prompt) && prompt.length > 100 ? 'minimal_or_custom' : 'full_reference';
}

export interface FooterContact {
  address?: string;
  email?: string;
  copyright?: string;
  phone?: string;
}

export function extractFooterContact(html: string): FooterContact {
  const out: FooterContact = {};
  const footerMatch = /<footer\b[\s\S]*?<\/footer>/i.exec(html);
  const scope = footerMatch?.[0] ?? html.slice(-12_000);

  const emailMatch = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.exec(scope);
  if (emailMatch) out.email = emailMatch[0];

  const copyrightMatch = /©[^<\n]{3,120}/.exec(scope);
  if (copyrightMatch) out.copyright = copyrightMatch[0].trim();

  const addressMatch =
    /\d{1,6}\s+[A-Za-z0-9 .'-]+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)\.?[^<\n]{0,80}/i.exec(
      scope,
    );
  if (addressMatch) out.address = addressMatch[0].replace(/\s+/g, ' ').trim();

  const phoneMatch = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.exec(scope);
  if (phoneMatch) out.phone = phoneMatch[0];

  return out;
}

const MAX_INLINE_LOGO_SVG_CHARS = 40_000;

/**
 * Extract an inline SVG logo from header/nav when there is no <img> logo URL.
 * Returns normalized "<svg…></svg>" markup or null. Fail-closed: never invents a mark.
 */
export function extractInlineLogoSvg(rawHtml: string): string | null {
  const headerMatch = /<header\b[\s\S]*?<\/header>/i.exec(rawHtml);
  const navMatch = /<nav\b[\s\S]*?<\/nav>/i.exec(rawHtml);
  const scopes: string[] = [];
  if (headerMatch) scopes.push(headerMatch[0]);
  if (navMatch) scopes.push(navMatch[0]);
  if (scopes.length === 0) scopes.push(rawHtml.slice(0, 25_000));

  const candidates: { svg: string; score: number; index: number }[] = [];

  for (const scope of scopes) {
    let m: RegExpExecArray | null;
    const re = /<svg\b[\s\S]*?<\/svg>/gi;
    while ((m = re.exec(scope))) {
      const svg = m[0];
      if (svg.length < 40 || svg.length > MAX_INLINE_LOGO_SVG_CHARS) continue;
      if ((svg.match(/<path\b/gi) ?? []).length > 80) continue;
      let score = 0;
      if (/logo/i.test(svg)) score += 3;
      if (/aria-label\s*=\s*["'][^"']*logo/i.test(svg)) score += 2;
      if (/class\s*=\s*["'][^"']*logo/i.test(svg)) score += 2;
      if (headerMatch && scope === headerMatch[0]) score += 1;
      if (navMatch && scope === navMatch[0]) score += 1;
      if (svg.length < 8_000) score += 1;
      if (score === 0) continue;
      candidates.push({ svg, score, index: m.index });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0].svg.replace(/\s+/g, ' ').trim();
}

/**
 * Prefer existing logo URL; else upload inline SVG to storage and return public URL.
 * Returns null if neither is available (callers must not invent a logo).
 */
export async function materializeLogoUrl(opts: {
  pageSlug: string;
  logoUrl?: string | null;
  logoSvg?: string | null;
}): Promise<string | null> {
  if (opts.logoUrl && /^https?:\/\//i.test(opts.logoUrl)) return opts.logoUrl;
  const svg = opts.logoSvg?.trim();
  if (!svg || !/^<svg\b/i.test(svg)) return null;
  try {
    const buffer = Buffer.from(svg, 'utf8');
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const url = await uploadImage(opts.pageSlug, ab, 'image/svg+xml', 'svg');
    console.log('[materializeLogoUrl] uploaded inline SVG logo', {
      pageSlug: opts.pageSlug,
      url: url.slice(0, 120),
    });
    return url;
  } catch (err) {
    console.error('[materializeLogoUrl] SVG upload failed', err);
    return null;
  }
}

/** Put real logo URL + footer facts onto the schema so build doesn't invent them. */
export function injectBrandAssetsIntoSchema(
  schema: Record<string, unknown>,
  opts: { logoUrl?: string | null; footer?: FooterContact | null },
): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const { logoUrl, footer } = opts;

  if (logoUrl) {
    const ensureLogo = (node: unknown) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const o = node as Record<string, unknown>;
      o.logo_url = logoUrl;
      o.logo_src = logoUrl;
      delete o.image_prompt;
    };
    if (copy.nav) ensureLogo(copy.nav);
    else copy.nav = { logo_url: logoUrl, logo_src: logoUrl };
    if (copy.footer) ensureLogo(copy.footer);
    copy.brand_logo_url = logoUrl;
  }

  if (footer && copy.footer && typeof copy.footer === 'object') {
    const f = copy.footer as Record<string, unknown>;
    if (footer.address) f.address = footer.address;
    if (footer.email) f.email = footer.email;
    if (footer.copyright) f.copyright = footer.copyright;
    if (footer.phone) f.phone = footer.phone;
    if (footer.address || footer.email) {
      const bits = [footer.address, footer.email, footer.phone].filter(Boolean);
      if (!f.links || !Array.isArray(f.links) || (f.links as unknown[]).length === 0) {
        f.links = bits;
      }
    }
  } else if (footer && (footer.address || footer.email || footer.copyright)) {
    copy.footer = {
      ...(typeof copy.footer === 'object' && copy.footer ? copy.footer : {}),
      ...footer,
      ...(logoUrl ? { logo_url: logoUrl, logo_src: logoUrl } : {}),
    };
  }

  return copy;
}

function logoMarkupForEmbed(logoUrl: string | null, logoSvg: string | null): string | null {
  if (logoUrl) {
    return `<img src="${logoUrl}" alt="logo" style="height:40px;width:auto;display:block;background:transparent;" />`;
  }
  if (logoSvg && /^<svg\b/i.test(logoSvg)) {
    let svg = logoSvg;
    if (!/\bstyle=/i.test(svg)) {
      svg = svg.replace(/^<svg\b/i, '<svg style="height:40px;width:auto;display:block"');
    }
    return svg;
  }
  return null;
}

/**
 * Deterministic: ensure the real logo appears in nav/header HTML.
 * Prefers hosted logoUrl; can inject inline SVG markup when upload was unavailable.
 *
 * No-op when neither URL nor SVG is available — we never invent a logo asset.
 */
export function forceEmbedLogoInHtml(
  html: string,
  logoUrl: string | null,
  logoSvg: string | null = null,
): string {
  const markup = logoMarkupForEmbed(logoUrl, logoSvg);
  if (!markup) return html;
  if (logoUrl && html.includes(logoUrl)) return html;
  if (!logoUrl && logoSvg && html.includes('<svg') && html.includes(logoSvg.slice(0, Math.min(80, logoSvg.length)))) {
    return html;
  }

  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  if (slNav) {
    let inner = slNav[1];
    if (/<img\b/i.test(inner)) {
      inner = inner.replace(/<img\b[^>]*>/i, markup);
    } else if (/<svg\b[\s\S]*?<\/svg>/i.test(inner)) {
      inner = inner.replace(/<svg\b[\s\S]*?<\/svg>/i, markup);
    } else if (/<a\b[^>]*>/i.test(inner)) {
      inner = inner.replace(/(<a\b[^>]*>)([\s\S]*?)(<\/a>)/i, `$1${markup}$3`);
    } else {
      inner = markup + inner;
    }
    return html.slice(0, slNav.index) + `<!-- SL:nav -->${inner}<!-- /SL:nav -->` + html.slice(slNav.index + slNav[0].length);
  }

  const headerOrNav = /<(header|nav)\b[^>]*>[\s\S]*?<\/\1>/i.exec(html);
  if (headerOrNav) {
    let block = headerOrNav[0];
    if (/<img\b/i.test(block)) {
      block = block.replace(/<img\b[^>]*>/i, markup);
    } else if (/<svg\b[\s\S]*?<\/svg>/i.test(block)) {
      block = block.replace(/<svg\b[\s\S]*?<\/svg>/i, markup);
    } else {
      block = block.replace(/<(header|nav)\b[^>]*>/i, (open) => `${open}${markup}`);
    }
    return html.slice(0, headerOrNav.index) + block + html.slice(headerOrNav.index + headerOrNav[0].length);
  }

  return html;
}

/** Ensure footer shows known contact lines when we extracted them. */
export function forceEmbedFooterContactInHtml(html: string, footer: FooterContact): string {
  const lines = [footer.address, footer.email, footer.copyright].filter(Boolean) as string[];
  if (lines.length === 0) return html;
  const missing = lines.filter((l) => !html.includes(l));
  if (missing.length === 0) return html;

  const block = missing.map((l) => `<p style="margin:4px 0;opacity:.75;font-size:13px;">${escapeHtml(l)}</p>`).join('');

  const slFooter = /<!--\s*SL:footer\s*-->([\s\S]*?)<!--\s*\/SL:footer\s*-->/i.exec(html);
  if (slFooter) {
    const inner = slFooter[1] + block;
    return (
      html.slice(0, slFooter.index) +
      `<!-- SL:footer -->${inner}<!-- /SL:footer -->` +
      html.slice(slFooter.index + slFooter[0].length)
    );
  }

  const footerEl = /<footer\b[^>]*>[\s\S]*?<\/footer>/i.exec(html);
  if (footerEl) {
    const updated = footerEl[0].replace(/<\/footer>/i, `${block}</footer>`);
    return html.slice(0, footerEl.index) + updated + html.slice(footerEl.index + footerEl[0].length);
  }

  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Remove unprompted social-proof schema blocks (stats / logo walls / as-seen).
 * Fail-closed: only strips when the user did NOT ask for proof. Never invents.
 * Does not remove testimonials/reviews (those are often structural asks).
 */
export function stripUnpromptedSocialProof(
  schema: Record<string, unknown>,
  prompt: string,
  userAskedForProof: boolean,
): Record<string, unknown> {
  if (userAskedForProof) return schema;
  // If the prompt itself contains concrete numbers the user supplied, keep stats
  if (/\b\d{1,3}(?:,\d{3})*(?:\+)?\s*%|\b\d+\+?\s*(clients|customers|companies|reviews|stars)\b/i.test(prompt)) {
    return schema;
  }
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const dropTypes = new Set(['stats', 'logo_wall', 'as_seen_in', 'awards', 'social_proof_bar']);
  if (Array.isArray(copy.sections)) {
    copy.sections = (copy.sections as Array<Record<string, unknown>>).filter((sec) => {
      const t = typeof sec.type === 'string' ? sec.type.toLowerCase() : '';
      return !dropTypes.has(t);
    });
  }
  // Hero badge / invented metric fields
  if (copy.hero && typeof copy.hero === 'object') {
    const hero = copy.hero as Record<string, unknown>;
    for (const key of ['stats', 'metrics', 'social_proof', 'as_seen_in', 'awards']) {
      delete hero[key];
    }
  }
  return copy;
}

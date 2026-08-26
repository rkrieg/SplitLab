/**
 * Brand assets + shape intent from reference URLs.
 * Used by generate/build (create) and follow-up (edit) so "use the logo" works
 * without requiring the narrow "real/actual logo" phrasing.
 */

import { askAI } from '@/lib/ai-client';
import { materializeAsset, materializeSvgMarkup } from '@/lib/ai-asset-integrity';
import { detectContentReuseIntent, inferTargetSectionNames } from '@/lib/ai-content-placement';

/**
 * DEAD — no live callers. `ai-page-builder.ts` still imports it but never calls
 * it; the import is left as a marker and can be deleted with this function.
 *
 * Page shape is decided once by the schema pass (`minimal_shape`) and forwarded
 * through build. This regex disagreed with that decision whenever the user
 * phrased "just a confirmation page" in a way it had not been taught, and the
 * later of the two answers won — so the same request built two different pages
 * depending on which branch read it last.
 */
export function userWantsCustomOrMinimalPage(prompt: string): boolean {
  return /\b(pretty much just|just (look|be|the)|only (the )?(hero|footer)|hero (section )?only|thank[- ]?you|confirmation|confirmed|dead-?end|no buttons|no (calls? to action|ctas?)|nothing else|that'?s (pretty much|about) it|keep it (nice and )?simple|flat background|success page|receipt page|booked call)\b/i.test(
    prompt,
  );
}

/**
 * DEAD, twice over. Its only callers live in `ai-visual-qa.ts`, and that whole
 * module is switched off at `LIVE_VISUAL_QA_ENABLED = false`, with its call
 * sites in build + follow-up commented out.
 *
 * User wants the site's real logo asset from a URL / screenshot reference.
 * Broader than the old "real|actual logo" edit-only regex — and still not broad
 * enough, which is the point. `intent.assetSource` is the model's answer to the
 * same question and needs no new alternation per phrasing.
 *
 * If visual QA is ever switched back on, wire those two call sites to
 * `intent.assetSource === 'logo'` instead of reviving this.
 */
export function userWantsLogoFromReference(prompt: string): boolean {
  return /\b((real|actual|exact|same|correct)\s+logo|use (the |their |this )?logo|logo from|with (the )?logo|keep (the )?logo|same logo|focused capital.*logo|logo.*from (this|the|that))\b/i.test(
    prompt,
  );
}


/**
 * Which (if any) of the webpage URLs in a create-path brief the user actually
 * wants scraped as a design reference to clone from.
 *
 * Replaces "any surviving URL is a competitor" (generate/route.ts used to take
 * urls[0] unconditionally). That blind rule had no way to tell "clone this
 * site's design" from "here's our own asset folder, don't copy the site it
 * lives on" — a brief that says "do not clone simplesale.com" still got
 * simplesale.com scraped, because the sentence never reached the code that
 * decided to scrape. No keyword fallback here either, same reason as
 * classifyPageShapeIntent below: guessing which URL a paragraph meant from
 * punctuation is exactly the failure mode this replaces.
 *
 * Fails closed: null on any classification failure means "scrape nothing",
 * not "fall back to urls[0]" — a missed reference costs a worse-looking page,
 * a wrong one costs a page styled off a stranger's site.
 */
export async function classifyCompetitorReferenceUrl(
  prompt: string,
  urls: string[],
): Promise<string | null> {
  if (urls.length === 0) return null;
  try {
    const text = await askAI({
      system:
        'A landing-page brief mentions one or more URLs. Decide if ANY of them is a site the user wants scraped and used as a DESIGN reference to clone/match (colors, layout, structure).\n' +
        'Return JSON only: {"referenceUrl": "<one of the given URLs>"} or {"referenceUrl": null}.\n' +
        'Pick a URL only when the brief clearly wants that site\'s design copied or closely matched.\n' +
        'Return null when: the URLs are just asset links (images/logos to embed, a folder of files to use), the brief explicitly says NOT to clone/copy that site, or a URL is only named as inspiration/context with no instruction to replicate it.',
      messages: [
        {
          role: 'user',
          content: `URLs found in the brief:\n${urls.map((u) => `- ${u}`).join('\n')}\n\nBrief:\n${prompt.slice(0, 6000)}`,
        },
      ],
      maxTokens: 32000,
      label: 'generate:competitor-url-classify',
    });
    let raw = text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    const parsed = JSON.parse(raw) as { referenceUrl?: string | null };
    if (typeof parsed.referenceUrl === 'string' && urls.includes(parsed.referenceUrl)) {
      return parsed.referenceUrl;
    }
    return null;
  } catch (err) {
    console.error('[classifyCompetitorReferenceUrl] failed — treating as no reference', err);
    return null;
  }
}

/**
 * AI classify when regex is unsure. Prefer user custom/minimal over full clone
 * when unclear — cloning a whole LP against a confirmation prompt is the worse failure.
 */
export async function classifyPageShapeIntent(
  prompt: string,
): Promise<'minimal_or_custom' | 'full_reference' | null> {
  // No keyword short-circuit and no keyword fallback. The model decides, or
  // nobody does: null means "could not classify", and the caller reports an
  // outage rather than guessing the page's entire shape from punctuation.
  try {
    const text = await askAI({
      system:
        'Classify landing-page build intent. Return JSON only: {"shape":"minimal_or_custom"|"full_reference"}.\n' +
        'minimal_or_custom = confirmation/thank-you/hero-only/dead-end/no CTAs/custom text that should NOT clone every section of a reference URL.\n' +
        'full_reference = user wants the page to closely match/replicate the linked site structure.\n' +
        'If both a URL and custom copy appear, prefer minimal_or_custom unless they clearly asked to copy the whole page.',
      messages: [{ role: 'user', content: prompt.slice(0, 4000) }],
      // Sized for Haiku, which had no thinking overhead. Every call here runs
      // on Sonnet 5, whose adaptive thinking is billed against this same
      // ceiling BEFORE the answer starts — so a small budget can be spent
      // entirely on thinking and truncate the response. Truncation here fails
      // silently (see the catch below), so the loss is invisible. Costs
      // nothing: Anthropic bills output actually generated, not this ceiling.
      maxTokens: 32000,
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
    console.error('[classifyPageShapeIntent] failed — caller must report, not guess', err);
    return null;
  }
  // Reached only when the model answered with neither valid shape.
  console.error('[classifyPageShapeIntent] unusable shape in response — caller must report');
  return null;
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
 * Return a logo URL that is proven to load: remote candidates are fetched,
 * content-type checked and re-hosted on our storage before we ever put them in
 * an <img src>. Hotlinking a client's CDN used to pass every string check while
 * rendering a broken image, so an unverifiable URL now falls through to the
 * inline-SVG path instead of being embedded on trust.
 *
 * Returns null if nothing verifiable is available (callers must not invent a logo).
 */
export async function materializeLogoUrl(opts: {
  pageSlug: string;
  logoUrl?: string | null;
  logoSvg?: string | null;
}): Promise<string | null> {
  if (opts.logoUrl && /^https?:\/\//i.test(opts.logoUrl)) {
    const asset = await materializeAsset({ pageSlug: opts.pageSlug, url: opts.logoUrl });
    if (asset.ok) {
      console.log('[materializeLogoUrl] verified logo asset', {
        pageSlug: opts.pageSlug,
        reused: asset.reused,
        contentType: asset.contentType,
        bytes: asset.bytes,
        url: asset.url.slice(0, 120),
      });
      return asset.url;
    }
    console.error('[materializeLogoUrl] logo URL failed verification', {
      pageSlug: opts.pageSlug,
      reason: asset.reason,
      status: asset.status,
      contentType: asset.contentType,
      url: opts.logoUrl.slice(0, 120),
    });
  }

  const svg = opts.logoSvg?.trim();
  if (!svg || !/^<svg\b/i.test(svg)) return null;
  const hosted = await materializeSvgMarkup({ pageSlug: opts.pageSlug, svg });
  if (hosted) {
    console.log('[materializeLogoUrl] uploaded inline SVG logo', {
      pageSlug: opts.pageSlug,
      url: hosted.slice(0, 120),
    });
  } else {
    console.error('[materializeLogoUrl] SVG upload failed', { pageSlug: opts.pageSlug });
  }
  return hosted;
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
    // max-width guards against a wide wordmark stretching a flex row; the
    // transparent background keeps it from rendering as a boxed sticker.
    return `<img src="${logoUrl}" alt="logo" style="height:40px;width:auto;max-width:200px;object-fit:contain;display:block;background:transparent;" />`;
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
 * DEAD — no live callers, and it delegates to detectContentReuseIntent, which
 * is itself dead. Kept only for tests that check logo placement language.
 */
export function userWantsLogoPlacedInSection(prompt: string): boolean {
  const intent = detectContentReuseIntent(prompt, ['nav', 'hero', 'footer', 'about']);
  return intent?.kind === 'logo';
}

/** DEAD — no live callers. Its delegate `inferTargetSectionNames` is dead too. */
export function inferLogoPlacementSectionNames(prompt: string, sectionNames: string[]): string[] {
  return inferTargetSectionNames(prompt, sectionNames);
}

/**
 * Logo URL inside a named SL section (or matching &lt;footer&gt;/&lt;nav&gt;).
 * Used when the user says "same logo as the footer" — never assume nav-first.
 */
export function extractLogoUrlFromSection(html: string, sectionName: string): string | null {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sl = new RegExp(
    `<!--\\s*SL:${escaped}\\s*-->([\\s\\S]*?)<!--\\s*\\/SL:${escaped}\\s*-->`,
    'i',
  ).exec(html);
  let scope = sl?.[1] ?? null;
  if (!scope) {
    if (/footer/i.test(sectionName)) {
      scope = /<footer\b[^>]*>[\s\S]*?<\/footer>/i.exec(html)?.[0] ?? null;
    } else if (/nav|header/i.test(sectionName)) {
      scope =
        /<nav\b[^>]*>[\s\S]*?<\/nav>/i.exec(html)?.[0] ??
        /<header\b[^>]*>[\s\S]*?<\/header>/i.exec(html)?.[0] ??
        null;
    }
  }
  if (!scope) return null;
  return pickLogoUrlFromScope(scope);
}

function pickLogoUrlFromScope(scope: string): string | null {
  const imgs = Array.from(scope.matchAll(/<img\b[^>]*>/gi));
  const ranked: { src: string; score: number }[] = [];
  for (const m of imgs) {
    const tag = m[0];
    const srcM = /\bsrc=["']([^"']+)["']/i.exec(tag);
    if (!srcM) continue;
    const src = srcM[1].trim();
    if (!/^https?:\/\//i.test(src)) continue;
    if (/placeholder|spacer|pixel|1x1|blank\./i.test(src)) continue;
    let score = 1;
    if (/logo|brand|wordmark/i.test(tag) || /logo|brand|wordmark/i.test(src)) score += 5;
    if (/supabase|storage|trysplitlab|focusedcapital/i.test(src)) score += 1;
    ranked.push({ src, score });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0].src;
}

/**
 * Prefer the working nav/header logo <img src> already on the page.
 * Fail-closed: never invents a URL.
 * For "copy footer logo to nav", use extractLogoUrlFromSection instead.
 */
export function extractPrimaryLogoUrlFromHtml(html: string): string | null {
  const preferScopes: string[] = [];
  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  if (slNav) preferScopes.push(slNav[1]);
  const headerMatch = /<header\b[\s\S]*?<\/header>/i.exec(html);
  const navMatch = /<nav\b[\s\S]*?<\/nav>/i.exec(html);
  if (headerMatch) preferScopes.push(headerMatch[0]);
  if (navMatch) preferScopes.push(navMatch[0]);
  preferScopes.push(html.slice(0, 40_000));

  for (const scope of preferScopes) {
    const found = pickLogoUrlFromScope(scope);
    if (found) return found;
  }
  return null;
}

function sectionContainsLogoAsset(
  sectionHtml: string,
  logoUrl: string | null,
  logoSvg: string | null,
): boolean {
  if (logoUrl && sectionHtml.includes(logoUrl)) return true;
  if (logoSvg) {
    const needle = logoSvg.slice(0, Math.min(80, logoSvg.length));
    if (needle && sectionHtml.includes(needle)) return true;
  }
  return false;
}

/** True when a named SL section contains the working logo URL/SVG. */
export function sectionHasLogoAsset(
  html: string,
  sectionName: string,
  logoUrl: string | null,
  logoSvg: string | null = null,
): boolean {
  const re = new RegExp(
    `<!--\\s*SL:${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->([\\s\\S]*?)<!--\\s*\\/SL:${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->`,
    'i',
  );
  const sl = re.exec(html);
  if (sl) return sectionContainsLogoAsset(sl[1], logoUrl, logoSvg);
  if (/footer/i.test(sectionName)) {
    const fe = /<footer\b[^>]*>[\s\S]*?<\/footer>/i.exec(html);
    if (fe) return sectionContainsLogoAsset(fe[0], logoUrl, logoSvg);
  }
  return false;
}

/**
 * Place markup just inside the section's first block-level wrapper.
 *
 * Prepending to the raw section body instead put the asset *outside* the div
 * that carries the background/padding/max-width, so a 40px logo rendered on the
 * page background as a full-width white band above the real footer.
 */
function injectIntoFirstContainer(inner: string, markup: string): string {
  const container = /<(div|section|header|nav|footer|aside|main|ul)\b[^>]*>/i.exec(inner);
  if (container && container.index !== undefined) {
    const at = container.index + container[0].length;
    return inner.slice(0, at) + markup + inner.slice(at);
  }
  return markup + inner;
}

function injectLogoMarkupIntoBlock(inner: string, markup: string): string {
  if (/<img\b/i.test(inner)) {
    return inner.replace(/<img\b[^>]*>/i, markup);
  }
  if (/<svg\b[\s\S]*?<\/svg>/i.test(inner)) {
    return inner.replace(/<svg\b[\s\S]*?<\/svg>/i, markup);
  }
  if (/<a\b[^>]*>/i.test(inner)) {
    return inner.replace(/(<a\b[^>]*>)([\s\S]*?)(<\/a>)/i, `$1${markup}$3`);
  }
  return injectIntoFirstContainer(inner, markup);
}

/** Put the working logo into the footer section (or <footer> fallback). Internal — use forceEmbedLogoInSection / IntoSections. */
function embedLogoInFooterBlock(
  html: string,
  logoUrl: string | null,
  logoSvg: string | null = null,
): string {
  const markup = logoMarkupForEmbed(logoUrl, logoSvg);
  if (!markup) return html;

  const slRe = /<!--\s*SL:footer\s*-->([\s\S]*?)<!--\s*\/SL:footer\s*-->/i;
  const footerSl = slRe.exec(html);
  let withSl = html;
  if (footerSl) {
    if (!sectionContainsLogoAsset(footerSl[1], logoUrl, logoSvg)) {
      const inner = injectLogoMarkupIntoBlock(footerSl[1], markup);
      withSl =
        html.slice(0, footerSl.index) +
        `<!-- SL:footer -->${inner}<!-- /SL:footer -->` +
        html.slice(footerSl.index + footerSl[0].length);
    }
  }

  const checkSl = slRe.exec(withSl);
  if (checkSl && sectionContainsLogoAsset(checkSl[1], logoUrl, logoSvg)) {
    return withSl;
  }

  const footerEl = /<footer\b[^>]*>[\s\S]*?<\/footer>/i.exec(withSl);
  if (footerEl) {
    if (sectionContainsLogoAsset(footerEl[0], logoUrl, logoSvg)) return withSl;
    let block = footerEl[0];
    if (/<img\b/i.test(block)) {
      block = block.replace(/<img\b[^>]*>/i, markup);
    } else if (/<svg\b[\s\S]*?<\/svg>/i.test(block)) {
      block = block.replace(/<svg\b[\s\S]*?<\/svg>/i, markup);
    } else {
      // Inside the footer's own wrapper — not between <footer> and it, which
      // rendered the logo on the body background as a stray white strip.
      block = block.replace(/(<footer\b[^>]*>)([\s\S]*)(<\/footer>)/i, (_m, open, body, close) =>
        `${open}${injectIntoFirstContainer(body, markup)}${close}`,
      );
    }
    return withSl.slice(0, footerEl.index) + block + withSl.slice(footerEl.index + footerEl[0].length);
  }

  return withSl;
}

/**
 * Deterministic: ensure the real logo appears inside a named SL section.
 * Only no-ops when THAT section already contains the asset — so a nav logo
 * does not skip embedding into footer/hero/etc.
 */
export function forceEmbedLogoInSection(
  html: string,
  sectionName: string,
  logoUrl: string | null,
  logoSvg: string | null = null,
): string {
  const markup = logoMarkupForEmbed(logoUrl, logoSvg);
  if (!markup) return html;

  const re = new RegExp(
    `<!--\\s*SL:${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->([\\s\\S]*?)<!--\\s*\\/SL:${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->`,
    'i',
  );
  const sl = re.exec(html);
  if (!sl) {
    if (/footer/i.test(sectionName)) {
      return embedLogoInFooterBlock(html, logoUrl, logoSvg);
    }
    return html;
  }
  if (sectionContainsLogoAsset(sl[1], logoUrl, logoSvg)) return html;

  const inner = injectLogoMarkupIntoBlock(sl[1], markup);
  return (
    html.slice(0, sl.index) +
    `<!-- SL:${sectionName} -->${inner}<!-- /SL:${sectionName} -->` +
    html.slice(sl.index + sl[0].length)
  );
}

/** Embed working logo into every listed SL section. Expands "footer" to all *footer* SL names. */
export function forceEmbedLogoIntoSections(
  html: string,
  sectionNames: string[],
  logoUrl: string | null,
  logoSvg: string | null = null,
): string {
  let out = html;
  const names = [...sectionNames];
  if (names.some((n) => /footer/i.test(n))) {
    for (const m of Array.from(out.matchAll(/<!--\s*SL:([a-z0-9_-]*footer[a-z0-9_-]*)\s*-->/gi))) {
      if (!names.includes(m[1])) names.push(m[1]);
    }
  }
  for (const name of names) {
    out = forceEmbedLogoInSection(out, name, logoUrl, logoSvg);
  }
  return out;
}

/**
 * Deterministic: ensure the real logo appears in nav/header HTML.
 * Prefers hosted logoUrl; can inject inline SVG markup when upload was unavailable.
 *
 * No-op when neither URL nor SVG is available — we never invent a logo asset.
 * Early-return only when nav/header already has the asset (not merely somewhere on the page).
 */
export function forceEmbedLogoInHtml(
  html: string,
  logoUrl: string | null,
  logoSvg: string | null = null,
): string {
  const markup = logoMarkupForEmbed(logoUrl, logoSvg);
  if (!markup) return html;

  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  if (slNav) {
    if (sectionContainsLogoAsset(slNav[1], logoUrl, logoSvg)) return html;
    const inner = injectLogoMarkupIntoBlock(slNav[1], markup);
    return html.slice(0, slNav.index) + `<!-- SL:nav -->${inner}<!-- /SL:nav -->` + html.slice(slNav.index + slNav[0].length);
  }

  const headerOrNav = /<(header|nav)\b[^>]*>[\s\S]*?<\/\1>/i.exec(html);
  if (headerOrNav) {
    if (sectionContainsLogoAsset(headerOrNav[0], logoUrl, logoSvg)) return html;
    let block = headerOrNav[0];
    if (/<img\b/i.test(block)) {
      block = block.replace(/<img\b[^>]*>/i, markup);
    } else if (/<svg\b[\s\S]*?<\/svg>/i.test(block)) {
      block = block.replace(/<svg\b[\s\S]*?<\/svg>/i, markup);
    } else {
      block = block.replace(
        /(<(?:header|nav)\b[^>]*>)([\s\S]*)(<\/(?:header|nav)>)/i,
        (_m, open, body, close) => `${open}${injectIntoFirstContainer(body, markup)}${close}`,
      );
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
  // userAskedForProof is the model's answer (intent.wantsSocialProof), and its
  // definition already covers "numbers the user supplied themselves". The regex
  // that used to double-check the prompt for digits here was a second opinion
  // formed from punctuation.
  if (userAskedForProof) return schema;
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

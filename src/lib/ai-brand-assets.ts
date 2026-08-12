/**
 * Brand assets + shape intent from reference URLs.
 * Used by generate/build (create) and follow-up (edit) so "use the logo" works
 * without requiring the narrow "real/actual logo" phrasing.
 */

/** User wants a custom/minimal page — not a full clone of the reference URL. */
export function userWantsCustomOrMinimalPage(prompt: string): boolean {
  return /\b(pretty much just|just (look|be|the)|only (the )?(hero|footer)|hero (section )?only|thank[- ]?you|confirmation|confirmed|dead-?end|no buttons|no (calls? to action|ctas?)|nothing else|that'?s (pretty much|about) it|keep it (nice and )?simple|flat background|success page)\b/i.test(
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

  // US-style street address heuristic
  const addressMatch =
    /\d{1,6}\s+[A-Za-z0-9 .'-]+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct)\.?[^<\n]{0,80}/i.exec(
      scope,
    );
  if (addressMatch) out.address = addressMatch[0].replace(/\s+/g, ' ').trim();

  const phoneMatch = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.exec(scope);
  if (phoneMatch) out.phone = phoneMatch[0];

  return out;
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
      // Discourage AI image generation for the logo when we have the real file
      delete o.image_prompt;
    };
    if (copy.nav) ensureLogo(copy.nav);
    else copy.nav = { logo_url: logoUrl, logo_src: logoUrl };
    if (copy.footer) ensureLogo(copy.footer);
    // Also stamp top-level for builders that look there
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

/**
 * Deterministic: ensure the real logo URL appears in nav/header HTML.
 * Model often pastes a screenshot thumb instead — this corrects after build.
 *
 * No-op when logoUrl is missing (e.g. site had only an inline SVG wordmark
 * with no fetchable <img>/icon — see extractLogoUrl LIMIT). We never invent
 * a logo asset; callers must treat a null scrape logo as "could not fetch."
 */
export function forceEmbedLogoInHtml(html: string, logoUrl: string): string {
  if (!logoUrl || html.includes(logoUrl)) return html;

  const logoImg = `<img src="${logoUrl}" alt="logo" style="height:40px;width:auto;display:block;background:transparent;" />`;

  // Prefer SL nav section
  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  if (slNav) {
    let inner = slNav[1];
    if (/<img\b/i.test(inner)) {
      inner = inner.replace(/<img\b[^>]*>/i, logoImg);
    } else if (/<a\b[^>]*>/i.test(inner)) {
      inner = inner.replace(/(<a\b[^>]*>)([\s\S]*?)(<\/a>)/i, `$1${logoImg}$3`);
    } else {
      inner = logoImg + inner;
    }
    return html.slice(0, slNav.index) + `<!-- SL:nav -->${inner}<!-- /SL:nav -->` + html.slice(slNav.index + slNav[0].length);
  }

  // Fallback: first header/nav img
  const headerOrNav = /<(header|nav)\b[^>]*>[\s\S]*?<\/\1>/i.exec(html);
  if (headerOrNav) {
    let block = headerOrNav[0];
    if (/<img\b/i.test(block)) {
      block = block.replace(/<img\b[^>]*>/i, logoImg);
    } else {
      block = block.replace(/<(header|nav)\b[^>]*>/i, (open) => `${open}${logoImg}`);
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

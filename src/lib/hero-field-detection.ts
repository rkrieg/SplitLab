// UTM Personalization V2 — hero auto-field-mapping, AI-generated-page tier.
// See docs/utm-personalization-v2-automation.md ("Hero auto-field-mapping design").
//
// AI-generated pages already carry data-field="hero.*" attributes in their
// stored HTML (baked in by ai-page-builder.ts at generation time — see
// ai-page-builder.ts:291-294). Detection here is just parsing those existing
// attributes into selectors; no AI/LLM call needed for this tier.
//
// Raw/uploaded HTML has no such markup — that's the harder tier (AI
// identifies elements, injects an id if missing) and is not implemented here.

export type HeroFieldSelectors = Record<string, { selector: string; type: 'text' | 'image'; label: string }>;

// Single source of truth for which hero fields exist. Both detection tiers
// (this file's attribute parser, and the not-yet-built raw-HTML AI
// identification/injection tier) must read from this list rather than
// hardcoding keys, so adding a 5th field later (e.g. a second CTA, a badge/
// chip) is a one-line change here — no logic elsewhere needs to change.
// `type` is the field's intended type; tier 1 still cross-checks it against
// the actual tag name (belt-and-suspenders), but the raw-HTML tier's AI
// prompt will need this declared up front since there's no markup to infer
// it from until after injection.
export const HERO_FIELD_CONFIG: Record<string, { label: string; type: 'text' | 'image' }> = {
  headline: { label: 'Headline', type: 'text' },
  subhead: { label: 'Subheadline', type: 'text' },
  cta_text: { label: 'CTA Text', type: 'text' },
  background_image: { label: 'Background Image', type: 'image' },
};

export const HERO_FIELD_KEYS = Object.keys(HERO_FIELD_CONFIG);

// Matches any opening tag carrying data-field="hero.<key>", capturing the
// tag name (to infer text vs. image) and the field key.
const TAG_WITH_HERO_FIELD_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-field=["']hero\.([a-zA-Z_]+)["'][^>]*>/g;

/**
 * Parses stored HTML for existing data-field="hero.*" attributes and
 * returns a selector map in the same shape as manual field_selectors_json.
 * Returns null if no hero fields were found (e.g. raw/uploaded HTML with no
 * such markup, or a page with no hero section at all) — callers should
 * treat that as "detection found nothing," not an error.
 */
export function detectHeroFieldsFromHtml(html: string): HeroFieldSelectors | null {
  const result: HeroFieldSelectors = {};
  let match: RegExpExecArray | null;

  TAG_WITH_HERO_FIELD_RE.lastIndex = 0;
  while ((match = TAG_WITH_HERO_FIELD_RE.exec(html)) !== null) {
    const [, tagName, fieldKey] = match;
    if (!HERO_FIELD_KEYS.includes(fieldKey)) continue;

    const dotKey = `hero.${fieldKey}`;
    if (result[dotKey]) continue; // first occurrence wins if markup is ever duplicated

    result[dotKey] = {
      selector: `[data-field="hero.${fieldKey}"]`,
      type: tagName.toLowerCase() === 'img' ? 'image' : HERO_FIELD_CONFIG[fieldKey].type,
      label: HERO_FIELD_CONFIG[fieldKey].label,
    };
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Hero-container detection (2026-07-30, "hero section revamp" scope
// expansion). Distinct from the field-level detection above: this returns
// the whole hero container's outer HTML so it can be replaced wholesale by
// an AI-generated layout/content rewrite, rather than swapped field-by-field.
//
// Primary signal: the `<!-- SL:hero -->...<!-- /SL:hero -->` section marker
// that ai-page-builder.ts's system prompt requires around every top-level
// section (named after its first CSS class — see ai-page-builder.ts:378-397).
// This is more robust than matching on `class="hero"` directly: the comment
// boundaries can't be confused by a nested `</section>` inside the hero
// block, and they survive even if the section's class list ever changes.
//
// Fallback: raw `<section class="hero">...</section>` matching, for pages
// generated before the SL marker convention existed, or on the rare chance
// the LLM dropped the marker but still wrote the class.
//
// Neither signal is guaranteed — both depend on LLM prompt compliance, not
// code-enforced structure. Raw/uploaded HTML pages have no reliable marker
// at all; this is an explicit, tracked gap (see "Bug found this session" /
// scope-expansion notes in docs/utm-personalization-v2-automation.md) —
// callers must treat a null return as "unsupported for this page," not
// silently skip it.
const SL_HERO_MARKER_RE = /<!--\s*SL:hero\s*-->([\s\S]*?)<!--\s*\/SL:hero\s*-->/i;
const HERO_SECTION_RE = /<section\b[^>]*\bclass=(["'])(?:(?!\1).)*\bhero\b(?:(?!\1).)*\1[^>]*>[\s\S]*?<\/section>/i;

/**
 * Extracts the outer HTML of the page's hero section from AI-generated page
 * HTML. Tries the `SL:hero` marker first, falls back to a `class="hero"`
 * regex. Returns null if neither is found — raw/uploaded HTML pages, or
 * AI-generated pages with no hero section, both fall through to this case.
 */
export function detectHeroContainerFromHtml(html: string): string | null {
  const markerMatch = SL_HERO_MARKER_RE.exec(html);
  if (markerMatch) return markerMatch[1].trim();

  const classMatch = HERO_SECTION_RE.exec(html);
  return classMatch ? classMatch[0] : null;
}

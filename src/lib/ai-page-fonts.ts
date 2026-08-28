/**
 * Curated font library for AI page generation.
 *
 * All fonts are loaded via Google Fonts CDN — no self-hosting required.
 * Claude picks one headline font + one body font based on business context.
 * The @import URL is copied verbatim into the generated page's <style> tag.
 *
 * To add a new font: add an entry here — the system prompt is built
 * dynamically from this object via buildFontLibraryBlock(), so no other
 * file needs to change.
 */

export interface FontEntry {
  /** Google Fonts @import URL — copied verbatim into generated HTML */
  url: string;
  /** Available weights as CSS font-weight values */
  weights: string;
  /** Business types this font is best suited for */
  useFor: string;
  /**
   * Average glyph advance as a fraction of font-size, measured in Chrome at
   * this font's heaviest listed weight with letter-spacing: normal.
   *
   * Feeds the hero H1's `--h1-fit`, which lets CSS solve for the font size at
   * which the headline fills its column (see ai-page-builder.ts). The spread is
   * huge — Syne is 0.73, Cormorant 0.37 — so a single "sans is ~0.46" guess
   * under-sizes some headlines by 20% and overflows others. Casing moves the
   * number as much as the family does, hence three values.
   *
   * ADDING A FONT: measure it, do not estimate. Render the three sample strings
   * at 100px in the target weight and divide rendered width by character count.
   */
  metrics: { prose: number; title: number; caps: number };
}

export interface FontLibrary {
  headline: Record<string, FontEntry>;
  body: Record<string, FontEntry>;
  mono: Record<string, FontEntry>;
}

export const FONT_LIBRARY: FontLibrary = {
  headline: {
    'Playfair Display': {
      url: 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,600;1,700&display=swap',
      weights: '600, 700',
      useFor: 'law firms, finance, real estate, professional services, insurance — authoritative and established',
      metrics: { prose: 0.424, title: 0.436, caps: 0.549 },
    },
    'Cormorant Garamond': {
      url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,700;1,300;1,400&display=swap',
      weights: '300, 400, 700',
      useFor: 'luxury goods, high fashion, fine jewellery, premium hospitality, perfume — ultra-refined and delicate',
      metrics: { prose: 0.366, title: 0.389, caps: 0.529 },
    },
    'Fraunces': {
      url: 'https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,700;1,400;1,700&display=swap',
      weights: '400, 700',
      useFor: 'lifestyle brands, wellness, boutique retail, food & beverage, coffee, organic products — warm and editorial',
      metrics: { prose: 0.463, title: 0.479, caps: 0.597 },
    },
    'Syne': {
      url: 'https://fonts.googleapis.com/css2?family=Syne:wght@700;800&display=swap',
      weights: '700, 800',
      useFor: 'creative agencies, bold startups, portfolio sites, design studios, music — expressive and modern',
      metrics: { prose: 0.706, title: 0.73, caps: 0.924 },
    },
    'Space Grotesk': {
      url: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&display=swap',
      weights: '500, 600, 700',
      useFor: 'SaaS, dev tools, fintech, AI products, technical B2B — precise and modern without being cold',
      metrics: { prose: 0.46, title: 0.468, caps: 0.51 },
    },
    'Bebas Neue': {
      url: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
      weights: '400',
      useFor: 'gyms, fitness, streetwear, sports brands, supplements, events — condensed high-impact display only',
      metrics: { prose: 0.319, title: 0.319, caps: 0.319 },
    },
    'Poppins': {
      url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@600;700;800&display=swap',
      weights: '600, 700, 800',
      useFor: 'consumer apps, food delivery, e-learning, playful SaaS, children products — friendly and approachable',
      metrics: { prose: 0.482, title: 0.491, caps: 0.55 },
    },
    'Bricolage Grotesque': {
      url: 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700;800&display=swap',
      weights: '400, 600, 700, 800',
      useFor: 'modern startups, product launches, creative tech, newsletter brands — expressive yet clean',
      metrics: { prose: 0.456, title: 0.469, caps: 0.537 },
    },
  },
  body: {
    'Inter': {
      url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
      weights: '400, 500, 600',
      useFor: 'pairs with everything — the default choice when unsure',
      metrics: { prose: 0.445, title: 0.459, caps: 0.562 },
    },
    'DM Sans': {
      url: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap',
      weights: '400, 500',
      useFor: 'pairs with editorial serifs (Fraunces, Cormorant) — softer and more approachable than Inter',
      metrics: { prose: 0.433, title: 0.444, caps: 0.515 },
    },
    'Manrope': {
      url: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600&display=swap',
      weights: '400, 500, 600',
      useFor: 'warmer alternative to Inter — pairs well with geometric or grotesk headlines like Space Grotesk or Syne',
      metrics: { prose: 0.436, title: 0.447, caps: 0.515 },
    },
    'Poppins': {
      url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500&display=swap',
      weights: '400, 500',
      useFor: 'use only when headline is also Poppins — creates a clean single-family page',
      metrics: { prose: 0.482, title: 0.491, caps: 0.55 },
    },
  },
  mono: {
    'JetBrains Mono': {
      url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap',
      weights: '400, 700',
      useFor: 'technical/dev tool pages only — use for code snippets, terminal motifs, version badges',
      metrics: { prose: 0.6, title: 0.6, caps: 0.6 },
    },
  },
};

/**
 * Serializes FONT_LIBRARY into a prompt-ready block that Claude reads to
 * pick fonts and copy the correct @import URL into generated HTML.
 */
/**
 * Every font in the library with its measured width factors, as a table the
 * model reads when setting `--h1-fit` on the hero H1. Generated from
 * FONT_LIBRARY so a new font's metrics reach the prompt automatically instead
 * of drifting from a hand-maintained copy.
 */
export function buildFontMetricsTable(): string {
  const rows = (['headline', 'body', 'mono'] as const)
    .flatMap((group) => Object.entries(FONT_LIBRARY[group]).map(([name, f]) => ({ name, f })))
    // A font can appear in more than one group (Poppins is both) — list it once.
    .filter(({ name }, i, arr) => arr.findIndex((x) => x.name === name) === i)
    .map(({ name, f }) => {
      const m = f.metrics;
      return `| ${name.padEnd(19)} | ${m.prose.toFixed(3)}         | ${m.title.toFixed(3)}      | ${m.caps.toFixed(3)}    |`;
    })
    .join('\n');

  return `| headline font       | sentence case | Title Case | ALL CAPS |
|---------------------|---------------|------------|----------|
${rows}`;
}

export function buildFontLibraryBlock(): string {
  const headlineRows = Object.entries(FONT_LIBRARY.headline)
    .map(([name, f]) => `  - ${name} (weights: ${f.weights})\n    Best for: ${f.useFor}\n    @import: ${f.url}`)
    .join('\n');

  const bodyRows = Object.entries(FONT_LIBRARY.body)
    .map(([name, f]) => `  - ${name} (weights: ${f.weights})\n    Best for: ${f.useFor}\n    @import: ${f.url}`)
    .join('\n');

  const monoRows = Object.entries(FONT_LIBRARY.mono)
    .map(([name, f]) => `  - ${name} (weights: ${f.weights})\n    Best for: ${f.useFor}\n    @import: ${f.url}`)
    .join('\n');

  return `## Font library — mandatory
Pick exactly ONE headline font and ONE body font that best fits the business type described in the schema.
If the page has code snippets, terminal motifs, or a dev-tool aesthetic, also add the mono font.

Rules:
- Copy the chosen font's @import URL(s) verbatim as the FIRST line(s) inside your <style> tag
- You may combine multiple @import URLs into one request by appending &family=... parameters — but copying each URL separately also works
- Set --font-headline and --font-body as CSS custom properties in :root
- Never use any font not listed here — UNLESS the user's original request explicitly names a specific font (e.g. "use Montserrat", "headline in Helvetica"). In that case use exactly that font for the role they named instead of the library, building the correct Google Fonts @import URL for it yourself (fall back to the closest library font only if the named font is not on Google Fonts). This exception applies per role — a font named for headlines only overrides the headline pick, not the body pick.
- Never use system-ui or Arial as a headline font, unless the user explicitly asked for that exact font

### Headline fonts (pick one)
${headlineRows}

### Body fonts (pick one)
${bodyRows}

### Mono font (only for technical/dev-tool pages)
${monoRows}`;
}

/**
 * Font guidance for the follow-up/edit route (changing fonts on an existing
 * page), as opposed to buildFontLibraryBlock() which is for building a page
 * from scratch. Covers both cases the edit route sees:
 *   - the user names a specific font ("use Roboto")
 *   - the user leaves it to the model ("pick a good font combination")
 */
export function buildFontFollowUpBlock(): string {
  const headlineNames = Object.keys(FONT_LIBRARY.headline).join(', ');
  const bodyNames = Object.keys(FONT_LIBRARY.body).join(', ');

  return `## Font changes (patch and style)
- If the instruction names a specific font (e.g. "use Roboto", "change the headline font to Montserrat", "body text in Helvetica") — use exactly that Google Font. Build the correct Google Fonts @import URL for it yourself and add it as the FIRST line inside the <style> block (alongside any @import already there for the role you did not change). Do not substitute a similar-looking font from the library below.
- If the instruction leaves the choice to you ("pick a font combination", "give it a font that fits", "any combination is fine") — pick one headline font and one body font from this library, matched to the page's existing business context: ${headlineNames} (headline) / ${bodyNames} (body). Copy that font's @import URL verbatim.
- Either way: set --font-headline and/or --font-body as CSS custom properties in :root (whichever role changed), and update every element that references them — do not leave the old @import in place unused, and do not leave elements hardcoded to the old family name outside the variable.
- Headline and body should stay visually distinct families unless the instruction explicitly asks for a single-font page.
- Never use system-ui or Arial as a headline font unless the instruction explicitly asked for that exact font.`;
}

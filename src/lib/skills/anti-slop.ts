import type { Skill } from './types';
import { attrValue, distinctCssValues, sectionNameAt, stripCode, styleText } from './check-utils';

/**
 * Distilled from the client's `frontend-design` SKILL.md and
 * `design-principles.md`.
 *
 * Our base prompt already bans generic output in the abstract ("never produce
 * generic output"). That sentence does nothing. This skill names the specific
 * patterns, because a named ban is checkable and an abstract one is not.
 *
 * Only the five patterns we do NOT already ban are here, plus the two positive
 * rules (one signature element, varied radii/shadows) that stop a page from
 * reading as a template with the words swapped.
 */

const DIAGRAM_HINT = /\b(diagram|schematic|flow|flowchart|map|blueprint|architecture|timeline|process|workflow|floorplan|floor-plan|graph|layout-plan)\b/i;

/** Whether a complex SVG is a deliberate diagram rather than decoration. */
function isDiagram(svg: string, sectionName: string | null): boolean {
  if (sectionName && DIAGRAM_HINT.test(sectionName)) return true;
  const openTag = /<svg\b([^>]*)>/i.exec(svg)?.[1] ?? '';
  const naming = [
    attrValue(openTag, 'class') ?? '',
    attrValue(openTag, 'id') ?? '',
    attrValue(openTag, 'aria-label') ?? '',
    attrValue(openTag, 'role') ?? '',
  ].join(' ');
  if (DIAGRAM_HINT.test(naming)) return true;
  // A drawing with its own <title>/<desc> or labelled text nodes is annotated
  // content, not an ornament.
  return /<title\b/i.test(svg) || /<desc\b/i.test(svg);
}

export const antiSlop: Skill = {
  id: 'anti_slop',
  name: 'Anti-Slop',
  description:
    'Bans the specific visual patterns that read as machine-made, and forces one deliberate signature element instead of decoration everywhere.',
  useFor: 'Any page where "it looks AI-generated" is the complaint. Brand, design-led and premium pages especially.',
  notFor:
    'A strict brand-guideline rebuild or a competitor clone, where matching the reference exactly matters more than a distinctive point of view.',
  defaultOn: true,

  generateBlock: `## Section variety
Do not reach for hero > three-column feature grid > testimonials > CTA by default. It is the most-generated landing page shape in existence. Consider instead, when the content supports it: a single-column editorial narrative, a comparison table, a stacked case study, a full-bleed product demo. Pick the three-column grid because it fits the content, not because it is first to mind.

## No decoration-by-content
No invented statistics, no decorative numbers, no "Our values"/"Why choose us" sections nobody asked for, no testimonial section without real testimonials. If a section feels thin, that is a layout problem — solve it with scale and whitespace, not with filler.`,

  buildBlock: `## Anti-slop — banned patterns (do not produce these)
1. **No gradient orbs.** A blurred circular gradient blob floating behind the hero as a stand-in for "AI" or "technology" is the single most over-used signifier in tech design. If the concept needs a visual, use a real one.
2. **No rounded card + left-border accent stripe + pastel icon.** That exact combination is the most-generated card in the world. Reach for a different container: a full-bleed panel, a numbered sequence, a framed cell, an overlapping pair, a bordered table row, or no container at all.
3. **No icon-per-bullet lists.** A pastel circle with a tiny symbol on every list item adds noise, not clarity. Use icons only where the icon carries real signal. Plain lists read faster.
4. **No SVG-drawn product illustrations.** Do not hand-draw a phone, a laptop, a dashboard, a person or a product in SVG or CSS shapes. It always reads as a diagram, never as a product. Use a real supplied image, a generated photo, or leave the space to typography.
5. **No decorative charts.** A chart with invented numbers is not design, it is fabrication. Charts appear only when the data is real and supplied.
6. **No aggressive gradient backgrounds.** Purple-to-blue, sunset and conic-rainbow washes are out. A background with visual interest means a solid brand colour, a single-hue gradient under ~10 degrees of hue variance, a subtle texture, or a full-bleed photograph.

## Anti-slop — required
- **One signature element.** Choose the single thing this page will be remembered by — a typographic treatment, an oversized number, a full-bleed opening image, a distinctive divider — and let it be the only loud moment. Everything else stays quiet and disciplined.
- **Vary the geometry.** Do not reuse one border-radius and one box-shadow across the entire page. At least two distinct radius values and two distinct shadow depths, used to mean different things (an elevated surface is not a flat one).
- **text-wrap: balance on headlines, text-wrap: pretty on paragraphs.** Both, every page. It is one line of CSS and it is the difference between typeset and typed.
- **Before you finish, remove one accessory.** Re-read the page and delete the single least necessary decorative element. If deleting it costs nothing, it should never have been there.`,

  checks: [
    {
      id: 'text_wrap',
      label: 'Modern text-wrap on headlines',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const balance = /text-wrap\s*:\s*balance/i.test(css);
        const pretty = /text-wrap\s*:\s*pretty/i.test(css);
        if (balance && pretty) return { passed: true, detail: 'Both text-wrap: balance and text-wrap: pretty are used.' };
        if (balance || pretty)
          return { passed: true, detail: `text-wrap: ${balance ? 'balance' : 'pretty'} is used (the other is missing).` };
        return { passed: false, detail: 'Neither text-wrap: balance nor text-wrap: pretty appears in the CSS.' };
      },
    },
    {
      id: 'radius_variety',
      label: 'More than one corner radius',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const values = distinctCssValues(css, 'border-radius');
        if (values.length === 0) return { passed: true, detail: 'Hard edges throughout — a deliberate choice, not a repeated default.' };
        return values.length >= 2
          ? { passed: true, detail: `${values.length} distinct corner radii.` }
          : { passed: false, detail: `One radius (${values[0]}) reused across the whole page.` };
      },
    },
    {
      id: 'shadow_variety',
      label: 'More than one shadow depth',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const values = distinctCssValues(css, 'box-shadow');
        if (values.length === 0) return { passed: true, detail: 'No shadows — a flat page is a valid choice.' };
        return values.length >= 2
          ? { passed: true, detail: `${values.length} distinct shadow depths.` }
          : { passed: false, detail: 'A single shadow value reused page-wide.' };
      },
    },
    {
      id: 'no_gradient_orb',
      label: 'No decorative gradient orb',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        // Only flags the full signature: a circle, blurred, filled with a
        // gradient. A rounded avatar or a plain blurred backdrop is not this.
        const blocks = css.split('}');
        const hit = blocks.find(
          (b) =>
            /border-radius\s*:\s*(50%|9999px|999px)/i.test(b) &&
            /filter\s*:\s*[^;]*blur\(/i.test(b) &&
            /(linear|radial|conic)-gradient/i.test(b),
        );
        return hit
          ? { passed: false, detail: 'A blurred circular gradient blob is used as decoration.' }
          : { passed: true, detail: 'No blurred gradient blobs.' };
      },
    },
    {
      id: 'no_rainbow_gradient',
      label: 'No rainbow / conic gradient background',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const hit = /conic-gradient/i.test(css);
        return hit
          ? { passed: false, detail: 'A conic (rainbow) gradient is present.' }
          : { passed: true, detail: 'No rainbow or conic gradient backgrounds.' };
      },
    },
    {
      id: 'no_svg_product_art',
      label: 'No hand-drawn SVG illustration standing in for a product',
      run: (html) => {
        const body = stripCode(html);
        // Icons are small. An inline <svg> carrying many drawing primitives is
        // someone illustrating, not someone placing an icon.
        const svgs = Array.from(body.matchAll(/<svg\b[\s\S]*?<\/svg>/gi));
        if (svgs.length === 0) return null;
        const illustrations = svgs.filter((m) => {
          const svg = m[0];
          if ((svg.match(/<(path|rect|circle|ellipse|polygon|polyline|line)\b/gi)?.length ?? 0) < 12)
            return false;
          // A diagram is not slop, and the base prompt explicitly ORDERS one to
          // be drawn as inline SVG for CUSTOM_BLOCK sections describing a
          // diagram/schematic/map. Without this exemption we instruct the model
          // to draw it and then mark the result wrong on the very scorecard
          // this feature exists to make trustworthy. Judged by the section the
          // SVG sits in, plus the SVG's own naming, since those are the only
          // signals of intent present in the markup.
          return !isDiagram(svg, sectionNameAt(body, m.index ?? 0));
        });
        return illustrations.length === 0
          ? {
              passed: true,
              detail: `${svgs.length} inline SVG${svgs.length === 1 ? '' : 's'}, all icon-sized or part of a real diagram.`,
            }
          : {
              passed: false,
              detail: `${illustrations.length} inline SVG${illustrations.length === 1 ? ' is' : 's are'} complex enough to be a drawn illustration.`,
            };
      },
    },
  ],
};

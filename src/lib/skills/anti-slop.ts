import type { Skill } from './types';
import {
  attrValue,
  directChildTags,
  distinctCssValues,
  gridTrackCount,
  heroRegion,
  sectionNameAt,
  stripCode,
  styleText,
} from './check-utils';

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

/**
 * Selectors that would put `text-wrap: balance` on the hero H1 — either by
 * targeting it directly (`.hero h1`, `.hero-copy h1`) or by styling every h1
 * on the page (`h1`, `h1,h2`), which the hero's H1 inherits too.
 *
 * Balance equalises line lengths, so it moves a word to the next line even
 * when it still fits on the current one. In a hero that reads as a broken
 * phrase ("It's Not About / the Injury"), so it is banned there specifically.
 */
function balancedHeroH1Selectors(css: string): string[] {
  const out: string[] = [];
  // Strip comments so a commented-out rule never trips the check.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const RULE = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = RULE.exec(clean))) {
    const selector = m[1].trim();
    const body = m[2];
    if (!/text-wrap\s*:\s*balance/i.test(body)) continue;
    // At-rule preludes (@media, @supports) carry no selector of their own.
    if (selector.startsWith('@')) continue;
    const hitsHeroH1 = selector.split(',').some((partRaw) => {
      const part = partRaw.trim();
      if (!part) return false;
      // Ends in h1 (or an h1 with pseudo/class suffix) — `h1`, `.hero h1`,
      // `.hero-copy > h1`, `h1.title`.
      const targetsH1 = /(^|[\s>+~])h1(\b|[.:#[])/i.test(part) || /^h1(\b|[.:#[])/i.test(part);
      if (!targetsH1) return false;
      // A bare/global h1 rule reaches the hero H1 as well.
      const scoped = /[.#][\w-]+/.test(part.replace(/h1[\w.:#[\]()-]*\s*$/i, ''));
      if (!scoped) return true;
      return /hero|banner|masthead|above-?fold|opening/i.test(part);
    });
    if (hitsHeroH1) out.push(selector.replace(/\s+/g, ' '));
  }
  return out.filter((sel, i) => out.indexOf(sel) === i);
}



/**
 * Whether a max-height cap is large enough that the image it bounds could be
 * the hero's subject. Anything smaller is an ornament — a badge, a logo, a row
 * of rating stars — which is letterboxed on purpose. A cap we cannot resolve
 * (calc, a custom property) is treated as too uncertain to flag.
 */
function subjectSizedCap(body: string): boolean {
  const m = /max-height\s*:\s*([^;}]+)/i.exec(body);
  if (!m) return false;
  const value = m[1].trim();
  if (/none|calc\(|var\(|min\(|max\(|clamp\(/i.test(value)) return false;
  const num = /^(-?[\d.]+)\s*([a-z%]*)$/i.exec(value);
  if (!num) return false;
  const size = parseFloat(num[1]);
  if (!Number.isFinite(size)) return false;
  switch (num[2].toLowerCase()) {
    case 'px':
      return size >= 240;
    case 'vh':
    case 'svh':
    case 'dvh':
    case 'vmin':
      return size >= 30;
    case 'rem':
    case 'em':
      return size >= 15;
    case '%':
      return size >= 50;
    default:
      return false;
  }
}

/**
 * Hero subject images that are left hovering with nothing beneath them.
 *
 * A cutout (a person or product on a removed background) has no rectangular
 * edge of its own, so it needs something to stand on. The generated failure is
 * always the same shape: the hero media <img> is letterboxed inside a taller
 * box with `object-fit: contain` plus a height cap, and nothing in the CSS
 * grounds it — no panel behind it, no contact shadow under it. An accent-
 * coloured radial gradient BEHIND the subject does not count: that is a
 * backlight, and it makes the float worse rather than better.
 *
 * We cannot tell from the markup whether an image is a cutout, so the check is
 * deliberately narrow: it only fires when the letterboxing AND the absence of
 * every grounding device coincide, which is what a floating cutout looks like
 * and what a framed photograph never does.
 */
function ungroundedHeroImages(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const RULE = /([^{}]+)\{([^{}]*)\}/g;
  const rules: { selector: string; body: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = RULE.exec(clean))) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    rules.push({ selector, body: m[2] });
  }

  const HERO = /hero|banner|masthead|above-?fold|opening/i;
  /** A dark, low-alpha fill reads as a shadow; a bright one reads as a glow. */
  const DARK_FILL = /rgba?\(\s*(?:0\s*,\s*0\s*,\s*0|[0-2]?\d\s*,\s*[0-2]?\d\s*,\s*[0-2]?\d)\b/i;

  const out: string[] = [];
  for (const rule of rules) {
    if (!HERO.test(rule.selector)) continue;
    if (!/object-fit\s*:\s*contain/i.test(rule.body)) continue;
    // A height cap on a contained image is what creates the empty box — but
    // only a cap big enough to hold a person. A 44px award badge or a 32px
    // client logo is letterboxed by design and is not what this check is for.
    if (!subjectSizedCap(rule.body)) continue;

    const parts = rule.selector.split(',').map((s2) => s2.trim());
    const imgPart = parts.find((part) => /(^|[\s>+~])img(\b|[.:#[])/i.test(part) || /^img(\b|[.:#[])/i.test(part));
    if (!imgPart) continue;
    // Named as an ornament rather than the hero's subject.
    if (/\b(logo|badge|icon|star|rating|review|avatar|seal|award|crest|flag|chip|trust)/i.test(imgPart)) continue;

    // The block that would carry the grounding device: the img's own container.
    const container = imgPart.replace(/(^|[\s>+~])img[\w.:#[\]()-]*\s*$/i, '$1').trim().replace(/[>+~]\s*$/, '').trim();
    if (!container) continue;

    const grounded = rules.some((other) => {
      const targetsContainer = other.selector
        .split(',')
        .map((s2) => s2.trim())
        .some((part) => part === container || part.startsWith(`${container}::`) || part.startsWith(`${container}:`));
      if (!targetsContainer) return false;
      // A panel or frame behind the subject.
      if (/border-radius\s*:|background(-color|-image)?\s*:\s*(?!none\b|transparent\b)[^;}]+/i.test(other.body)) {
        // A radial glow in an accent colour is not a panel — ignore it here.
        if (!/radial-gradient/i.test(other.body) || DARK_FILL.test(other.body)) return true;
      }
      // A contact shadow under it.
      if (/box-shadow\s*:\s*(?!none\b)/i.test(other.body)) return true;
      if (/radial-gradient/i.test(other.body) && DARK_FILL.test(other.body)) return true;
      return false;
    });
    if (!grounded) out.push(imgPart.replace(/\s+/g, ' '));
  }
  return out.filter((sel, i) => out.indexOf(sel) === i);
}

/**
 * Sentences in a hero headline, ignoring the abbreviations that would otherwise
 * split one sentence in two ("J.D.", "U.S.", "Inc."). A fragment only counts as
 * its own sentence when it carries at least two words, so "Stop guessing. Start
 * winning." reads as two sentences while a stray initial does not.
 */
function headlineSentences(text: string): string[] {
  const DOT = '\u0000';
  const guarded = text
    // Initialisms: J.D., U.S., U.S.A. — neutralise every dot in the run.
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (run) => run.replace(/\./g, DOT))
    // Common title/suffix abbreviations.
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Jr|Sr|St|Inc|Ltd|Co|vs|etc|No|Est)\./gi, `$1${DOT}`);
  return guarded
    .split(/(?<=[.!?])["'\u201d\u2019]?\s+/)
    .map((part) => part.split(DOT).join('.').trim())
    .filter((part) => part.split(/\s+/).filter(Boolean).length >= 2);
}

/**
 * Grid rows whose direct children outnumber their column tracks.
 *
 * Grid auto-placement puts the overflow children on the next row starting at
 * COLUMN 1. On the common "icon/number + text" row — `grid-template-columns:
 * 46px 1fr` with children .dot, h3, p — that drops the paragraph into the 46px
 * track, so it renders at icon width with one word per line. It reads as a
 * responsive bug but it is a placement bug, and it survives review because it
 * looks fine until the viewport narrows.
 *
 * Deliberately conservative — it only reports a class when ALL of these hold,
 * so a deliberate multi-row grid is never flagged:
 *  - the track count is statically knowable (no repeat(auto-fit), no var())
 *  - the first track is narrow-fixed (<= 80px) or `auto`, i.e. the icon shape
 *  - nothing in the CSS places children explicitly for that class
 *  - an element with that class really does carry more children than tracks
 */
function gridOverflowRows(html: string, css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders: string[] = [];
  const RULE = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = RULE.exec(clean))) {
    const selector = m[1].trim();
    const body = m[2];
    if (selector.startsWith('@')) continue;
    const cols = /grid-template-columns\s*:\s*([^;]+)/i.exec(body)?.[1];
    if (!cols) continue;
    // A column-flowing grid places items down, not across — the trap does not apply.
    if (/grid-auto-flow\s*:\s*column/i.test(body)) continue;
    const tracks = gridTrackCount(cols);
    if (!tracks || tracks < 2) continue;

    // Only the icon/number + content shape: a narrow fixed or auto first track.
    // Read it off the expanded list so repeat(2, auto) is judged on `auto`,
    // not on the literal string "repeat(2,".
    const expandedCols = cols.replace(/repeat\(\s*(\d+)\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)/gi, (_a, n, t) =>
      Array.from({ length: Number(n) }, () => String(t).trim()).join(' '),
    );
    const firstTrack = (expandedCols.trim().match(/^[^\s]+/) ?? [''])[0];
    const px = /^(\d+(?:\.\d+)?)px$/i.exec(firstTrack);
    const narrowFirst = firstTrack.toLowerCase() === 'auto' || (px !== null && Number(px[1]) <= 80);
    if (!narrowFirst) continue;

    // Single-class selectors only — compound/descendant selectors are ambiguous
    // about which element actually carries the children.
    const cls = /^\.([\w-]+)$/.exec(selector)?.[1];
    if (!cls) continue;
    // Explicit placement anywhere for this class means the author took control.
    if (new RegExp(`\\.${cls}\\b[^{}]*\\{[^{}]*grid-(column|area|row)\\s*:`, 'i').test(clean)) continue;

    // Whole-token class match. \b is not enough: `\bpa\b` also matches inside
    // class="pa-list", which reported a wrapper's children against .pa's tracks.
    const OPEN = /<([a-zA-Z][\w-]*)([^>]*)>/g;
    let el: RegExpExecArray | null;
    while ((el = OPEN.exec(html))) {
      const classAttr = attrValue(el[2], 'class');
      if (!classAttr || !classAttr.split(/\s+/).includes(cls)) continue;
      const { children, balanced } = directChildTags(html, el.index + el[0].length, el[1]);
      if (!balanced) continue;
      // An exact multiple of the track count is a deliberate multi-row grid
      // (three icon+text pairs in a 2-track grid). Only a remainder means a
      // child landed in the wrong column.
      if (children.length > tracks && children.length % tracks !== 0) {
        offenders.push(`.${cls} (${tracks} columns, ${children.length} children: ${children.join(', ')})`);
        break;
      }
    }
  }
  return offenders.filter((v, i, a) => a.indexOf(v) === i);
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
- **text-wrap: balance on section headings (h2/h3), text-wrap: pretty on paragraphs.** Both, every page. It is one line of CSS and it is the difference between typeset and typed. ONE EXCEPTION, and it is mandatory: the hero H1 must NEVER get \`text-wrap: balance\`. Balance equalises line lengths by pulling words down off a line that still had room, which breaks a headline as "It's Not About / the Injury" instead of "It's Not About the Injury." The hero H1 gets \`text-wrap: pretty\` (or nothing at all) so each line fills its measure and wraps only at a real sentence or clause boundary. Make sure any global \`h1 { ... }\` rule you write does not put balance on the hero H1 by inheritance.
- **Before you finish, remove one accessory.** Re-read the page and delete the single least necessary decorative element. If deleting it costs nothing, it should never have been there.`,

  checks: [
    {
      id: 'text_wrap',
      label: 'Modern text-wrap on headings',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const balance = /text-wrap\s*:\s*balance/i.test(css);
        const pretty = /text-wrap\s*:\s*pretty/i.test(css);
        if (!balance && !pretty)
          return { passed: false, detail: 'Neither text-wrap: balance nor text-wrap: pretty appears in the CSS.' };
        return {
          passed: true,
          detail: `text-wrap: ${balance && pretty ? 'balance and pretty are' : `${balance ? 'balance' : 'pretty'} is`} used.`,
        };
      },
    },
    {
      id: 'hero_h1_no_balance',
      label: 'Hero H1 fills its lines (no text-wrap: balance)',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const offenders = balancedHeroH1Selectors(css);
        if (offenders.length === 0)
          return { passed: true, detail: 'No text-wrap: balance reaches the hero H1.' };
        return {
          passed: false,
          detail: `text-wrap: balance applies to the hero H1 via ${offenders
            .map((sel) => `\`${sel}\``)
            .join(', ')} — it pulls words onto the next line while the current one still has room. Use text-wrap: pretty (or omit it) on the hero H1.`,
        };
      },
    },
    {
      id: 'hero_h1_sentence_lines',
      label: 'Multi-sentence hero headline gives each sentence its own line',
      run: (html) => {
        const clean = stripCode(html);
        const { start, end } = heroRegion(clean);
        const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(clean.slice(start, end))?.[1];
        if (!h1) return null;
        const text = h1.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const sentences = headlineSentences(text);
        if (sentences.length < 2)
          return { passed: true, detail: 'Single-sentence headline — nothing to split.' };
        // Each sentence needs its own block-level wrapper so a line break can
        // only ever land between sentences, never mid-phrase.
        const wrappers = h1.match(/<span\b[^>]*>/gi) ?? [];
        const lineWrappers = wrappers.filter((tag) =>
          /class\s*=\s*["'][^"']*\b(hl-line|headline-line|h1-line|line)\b/i.test(tag),
        );
        if (lineWrappers.length >= sentences.length)
          return { passed: true, detail: `${sentences.length} sentences, each in its own line span.` };
        return {
          passed: false,
          detail: `The hero H1 holds ${sentences.length} sentences but ${
            lineWrappers.length === 0 ? 'no' : `only ${lineWrappers.length}`
          } line span(s). Wrap each sentence in <span class="hl-line"> with display:block so a break lands between sentences, not mid-phrase.`,
        };
      },
    },
    {
      id: 'grid_row_child_overflow',
      label: 'Icon/number grid rows place their text in the content column',
      run: (html) => {
        // styleText must read the ORIGINAL html — stripCode removes <style> blocks.
        const css = styleText(html);
        if (!css) return null;
        const offenders = gridOverflowRows(stripCode(html), css);
        if (offenders.length === 0)
          return { passed: true, detail: 'No grid row has more children than columns.' };
        return {
          passed: false,
          detail: `${offenders.join('; ')} — grid auto-placement wraps the extra child onto the next row in COLUMN 1, so that text renders at the icon column's width (one word per line). Wrap the content in a single child, or set grid-column: 2 on it.`,
        };
      },
    },
    {
      id: 'hero_image_grounded',
      label: 'Hero subject image is grounded, not floating',
      run: (html) => {
        const css = styleText(html);
        if (!css) return null;
        const offenders = ungroundedHeroImages(css);
        if (offenders.length === 0)
          return { passed: true, detail: 'No hero image is left letterboxed with nothing beneath it.' };
        return {
          passed: false,
          detail: `${offenders
            .map((sel) => `\`${sel}\``)
            .join(', ')} letterboxes the hero subject with object-fit: contain inside a capped box, and nothing in the CSS grounds it — no panel behind it, no contact shadow under it. A cutout treated this way floats in mid-air. Anchor it to the section floor (align-items: end on the grid, align-self: stretch on the media column) and give it one grounding device: a panel behind it, or a dark blurred ellipse at its base. An accent-coloured glow behind the subject is a backlight, not a shadow.`,
        };
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

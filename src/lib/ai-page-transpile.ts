/**
 * Turn a coordinate-positioned page into the same page in normal flow.
 *
 * WHY THIS EXISTS
 *
 * A coordinate page (Unbounce `lp-pom-*`, Instapage, Muse, Figma export) states
 * its layout as `position: absolute; left; top` on a fixed-height canvas. Nothing
 * is in flow, so editing the markup does nothing useful: a new section has
 * nowhere to go and lands on top of what is already there. That is the bug this
 * module exists to fix — a real page's hero ended up stacked on itself.
 *
 * WHY IT IS CODE AND NOT A MODEL CALL
 *
 * The first version of the rebuild handed a model the page's words and colours
 * and asked it to build a page. It built its own page: different layout, a
 * palette it invented, four images and a video quietly missing. Asking a model to
 * "recreate this" is asking it to make choices, and there are no choices to make
 * here — the answers are already written down in the page's own stylesheet.
 * `rgba(191,146,35,1)` is not a judgement call.
 *
 * So this is a transpiler. It copies values and rewrites structure:
 *
 *   copied verbatim   colours, background images, overlays, fonts, sizes,
 *                     weights, letter spacing, radii, borders, shadows, text,
 *                     image/iframe URLs
 *   rewritten         position/left/top/width/height, which become sections,
 *                     flex rows and proportional columns
 *   dropped           exporter ids and classes, the fixed-height canvas
 *
 * Because everything is copied rather than generated, the result can be checked
 * by exact equality afterwards rather than by a fuzzy similarity score — see
 * {@link transpileCoordinatePage}'s `copied` counts.
 *
 * WHAT IS GENUINELY LOST
 *
 * JavaScript behaviour. Exporter scripts drive sticky bars, lightboxes,
 * carousels and form validation by targeting the very per-element ids we have to
 * drop — keeping the ids would keep the page un-editable, which defeats the whole
 * exercise. Static appearance carries over; those widgets stop working. The user
 * is told this in the rebuild note rather than left to discover it.
 */

import { pixels, DESKTOP_VIEWPORT_PX } from './ai-page-layout';
import { renderNodeFacts } from './ai-page-browser';

/**
 * Real computed-style facts for one rendered page, keyed by each element's
 * `data-sl-i` index (see buildTaggedHtml) — `document.body`'s own facts sit
 * under the reserved index -1. Replaces the old StyleFacts/resolveDeclarations
 * cascade approximation: every value here came out of an actual browser's
 * getComputedStyle, not a guess.
 */
type Facts = Map<number, Record<string, string>>;

// ── Tunables ────────────────────────────────────────────────────────────────

/** Fallback content width when the page's own canvas width can't be read. */
const DEFAULT_CANVAS_PX = 1200;

/** Vertical overlap, as a share of the shorter element, to count as one row. */
const ROW_OVERLAP = 0.5;

/** Slack, in px, when deciding whether two boxes clear each other sideways. */
const SIDE_TOLERANCE = 8;

/** Columns in the proportional grid. Widths snap to `flex-grow` in these units. */
const GRID_UNITS = 12;

/** An element this tall and this wide with no content in it is page furniture. */
const FURNITURE_HEIGHT_SHARE = 0.8;

/**
 * Caps on the whitespace copied out of coordinates.
 *
 * A coordinate page's gaps are the distance between two boxes, and that distance
 * is only meaningful while everything that used to sit in it still exists. It
 * does not: a script-injected booking widget left a 382px hole, and two footer
 * columns 699px apart became a 699px flex gap that pushed the row off the page.
 * Real spacing is well under these numbers, so the cap only ever trims a hole.
 */
const MAX_ROW_GAP_PX = 120;
const MAX_COLUMN_GAP_PX = 80;

/** Subtrees whose contents are never page content. */
const OPAQUE_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/**
 * A second `<html>`/`<head>`/`<body>` mid-document, from a page builder's
 * "Custom HTML" block where someone pasted a whole standalone page instead of
 * a fragment. A real browser ignores these — the HTML5 parser treats a stray
 * `<head>`/`<body>` start tag as a no-op once the real one has already opened,
 * and there is no matching end tag for it either. Treating the OPENING tag as
 * an ordinary element (the old behaviour, via OPAQUE_TAGS) skipped its entire
 * subtree as if it were a `<style>` block — which silently deleted a real
 * checklist widget's content on a real page. Ignoring the tag itself instead
 * (matching browser behaviour) lets whatever is between the stray tags parse
 * as ordinary body content, exactly like a real browser would show it.
 */
const IGNORED_STRUCTURAL_TAGS = new Set(['html', 'head', 'body']);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Tags that carry meaning on their own, so the element itself is re-emitted. */
const SEMANTIC_TAGS = new Set([
  'a', 'button', 'img', 'iframe', 'video', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 'b', 'i', 'span', 'br',
  'form', 'input', 'textarea', 'select', 'option', 'label', 'table', 'thead',
  'tbody', 'tr', 'td', 'th', 'picture', 'source', 'svg',
]);

/**
 * Style properties that describe appearance and are copied straight across.
 *
 * Everything absent from this list is either positional (rewritten) or an
 * exporter artefact. `width`/`height` are deliberately NOT here: a pixel width
 * is the thing that stops a section from being re-arranged.
 */
const KEEP_PROPS = [
  'color', 'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'background-blend-mode',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align',
  'text-transform', 'text-decoration', 'text-shadow', 'white-space',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius',
  'box-shadow', 'opacity', 'list-style', 'list-style-type',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'object-fit', 'object-position', 'fill', 'stroke',
];

/**
 * Layout properties copied only for elements that were ALREADY in flow.
 *
 * An uploaded page is rarely all coordinates. This one nails its Unbounce boxes to
 * pixel positions, and inside two of them sit hand-written blocks that lay
 * themselves out with `display: grid` — a two-column card panel, a testimonial
 * row. Dropping these properties turned every one of those into a single stacked
 * column, which is why the rebuilt page ran twice the height of the original.
 *
 * Safe to copy precisely because these elements are not what the rebuild rewrites:
 * flex and grid ARE markup-driven layout, the kind the edit path handles happily
 * (see ai-page-layout.ts on why Elementor pages patch fine). Anything
 * coordinate-placed is excluded — its geometry becomes sections and rows instead.
 * `width` stays out either way; a fixed pixel width is what stops a column from
 * being re-arranged.
 */
/**
 * `margin-left`/`margin-right` (and the `margin` shorthand, which carries
 * them too) are deliberately NOT here. `margin: 0 auto` — the standard way to
 * centre a fixed/max-width block — has no `auto` left by the time a browser
 * reports it: getComputedStyle always resolves it to the exact pixel gap
 * needed to centre THAT element inside ITS ORIGINAL parent's width. Copying
 * that pixel snapshot into a new column sized to the element's own content
 * (which is what centering it in flow now looks like — see the `justify-
 * content` a lone narrow row item already gets) crushed a real page's
 * ~600px-wide paragraph down to ~40px of usable width, wrapping it one word
 * per line. Horizontal placement within a row is the row/column flex
 * system's job now, not a leftover margin computed for a container that no
 * longer exists. `margin-top`/`margin-bottom` stay — vertical spacing is
 * rarely `auto` and stays meaningful regardless of container width.
 */
const FLOW_PROPS = [
  'display', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content',
  'align-content', 'gap', 'row-gap', 'column-gap', 'grid-template-columns',
  'grid-template-rows', 'grid-auto-flow', 'grid-column', 'grid-row', 'place-items',
  'max-width', 'margin-top', 'margin-bottom', 'aspect-ratio',
];

/** Attributes worth keeping on a copied element. Ids and classes are not. */
const KEEP_ATTRS = new Set([
  'href', 'src', 'srcset', 'sizes', 'alt', 'title', 'target', 'rel', 'type',
  'name', 'value', 'placeholder', 'required', 'checked', 'selected', 'for',
  'action', 'method', 'loading', 'allow', 'allowfullscreen', 'frameborder',
  'colspan', 'rowspan', 'datetime', 'aria-label', 'aria-hidden', 'role',
]);

// ── Result ──────────────────────────────────────────────────────────────────

export interface TranspiledSection {
  /** `<!-- SL:name -->` marker name. Unique, slug-safe. */
  name: string;
  /** Rows of columns, in reading order. */
  rows: number;
  /** Heading text this section was named after, when it had one. */
  heading?: string;
}

export interface TranspileResult {
  html: string;
  sections: TranspiledSection[];
  /**
   * What was carried across, for the caller to verify by exact equality.
   * These are the values copied out of the source, not a guess at similarity.
   */
  copied: {
    texts: string[];
    images: string[];
    embeds: string[];
    fonts: string[];
  };
  /** Elements the source itself hid at desktop width, and so were not copied. */
  hidden: number;
  /** Things worth telling the user, in plain language. */
  warnings: string[];
}

// ── A very small DOM ────────────────────────────────────────────────────────

interface Node {
  tag: string;
  attrs: string;
  /** Byte range of the whole element, including its tags. */
  start: number;
  end: number;
  /** Byte range of the element's contents. */
  innerStart: number;
  innerEnd: number;
  children: Node[];
  parent: Node | null;
  /** This element's key into Facts — assigned in document order by parseBody. */
  idx: number;
}

/**
 * Parse the body into an element tree.
 *
 * Deliberately forgiving: unclosed tags are closed by their parent's close, and
 * anything unparseable is skipped rather than thrown. Exporter HTML is machine
 * written and well formed; user-pasted HTML is not, and a rebuild that throws is
 * worse than one that misses a decorative div.
 */
function parseBody(html: string): Node {
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const from = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const closeIdx = html.toLowerCase().lastIndexOf('</body>');
  const to = closeIdx > from ? closeIdx : html.length;

  const root: Node = {
    tag: 'body', attrs: bodyOpen?.[0] ?? '', start: from, end: to,
    innerStart: from, innerEnd: to, children: [], parent: null, idx: -1,
  };
  // -1 is reserved for document.body's own facts (see ai-page-browser.ts),
  // so real elements start numbering at 0.
  let nextIdx = 0;

  let cursor: Node = root;
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;
  tagRe.lastIndex = from;

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) && m.index < to) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosed = m[4] === '/';

    if (OPAQUE_TAGS.has(tag)) {
      if (!closing) {
        // Jump the whole subtree; its contents are not page content.
        const close = html.toLowerCase().indexOf(`</${tag}>`, tagRe.lastIndex);
        tagRe.lastIndex = close === -1 ? tagRe.lastIndex : close + tag.length + 3;
      }
      continue;
    }

    // A stray <html>/<head>/<body> mid-document — see IGNORED_STRUCTURAL_TAGS.
    // Neither the open nor the close tag does anything; whatever sits between
    // them keeps parsing as ordinary content of whatever the real cursor is.
    if (IGNORED_STRUCTURAL_TAGS.has(tag)) continue;

    // An inline icon is a leaf, not a subtree: its `<path>`/`<circle>` children
    // carry meaning in attributes (`d`, `points`, `fill`) that the wrapper-collapse
    // and appearance-CSS machinery below has no idea how to read, so parsing them
    // as ordinary nodes silently ate every icon on the page — a `<path>` has no
    // text and no appearance of its own by this file's rules, so it collapsed like
    // any other empty wrapper, taking its geometry with it. The element is kept
    // whole instead and copied out verbatim in {@link copySubtree}.
    if (tag === 'svg' && !closing) {
      const close = html.toLowerCase().indexOf('</svg>', tagRe.lastIndex);
      const end = selfClosed || close === -1 ? tagRe.lastIndex : close + 6;
      const node: Node = {
        tag, attrs,
        start: m.index, end,
        innerStart: tagRe.lastIndex, innerEnd: selfClosed || close === -1 ? tagRe.lastIndex : close,
        children: [], parent: cursor, idx: nextIdx++,
      };
      cursor.children.push(node);
      tagRe.lastIndex = end;
      continue;
    }

    if (closing) {
      // Close the nearest matching ancestor; anything left open inside it is
      // closed implicitly, which is what a browser would do.
      let n: Node | null = cursor;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) {
        n.innerEnd = m.index;
        n.end = tagRe.lastIndex;
        cursor = n.parent;
      }
      continue;
    }

    const node: Node = {
      tag, attrs,
      start: m.index, end: tagRe.lastIndex,
      innerStart: tagRe.lastIndex, innerEnd: tagRe.lastIndex,
      children: [], parent: cursor, idx: nextIdx++,
    };
    cursor.children.push(node);
    if (!selfClosed && !VOID_TAGS.has(tag)) cursor = node;
  }

  // Anything still open ran to the end of the body.
  for (let n: Node | null = cursor; n && n.parent; n = n.parent) {
    n.innerEnd = to;
    n.end = to;
  }
  return root;
}

/**
 * Stamp a `data-sl-i="N"` attribute onto every parsed element, right after
 * its tag name, so a real browser's DOM can be matched back to this tree by
 * index. Root/body is skipped — its facts come back under the reserved
 * index -1 (see ai-page-browser.ts), since the source html's own `<body>`
 * open tag may not even exist (a bare fragment) and does not need marking.
 */
function buildTaggedHtml(html: string, root: Node): string {
  const inserts: Array<{ pos: number; idx: number }> = [];
  const collect = (node: Node) => {
    if (node.parent !== null) inserts.push({ pos: node.start + 1 + node.tag.length, idx: node.idx });
    for (const child of node.children) collect(child);
  };
  collect(root);
  inserts.sort((a, b) => b.pos - a.pos); // splice back-to-front so earlier positions never shift

  let out = html;
  for (const { pos, idx } of inserts) {
    out = out.slice(0, pos) + ` data-sl-i="${idx}"` + out.slice(pos);
  }
  return out;
}

interface RenderedPage {
  root: Node;
  facts: Facts;
}

/**
 * One page's parse tree plus its real, browser-computed style facts.
 *
 * Cached by exact HTML string so the several independent walks a rebuild does
 * over the SAME source (transpile, expected-content, appearance) — and every
 * repair pass re-checking the same source — reuse one render instead of
 * opening a new browser tab each time. Bounded so a long-running process
 * serving many different pages cannot grow this without limit.
 */
const renderCache = new Map<string, Promise<RenderedPage>>();

async function renderPage(html: string): Promise<RenderedPage> {
  let hit = renderCache.get(html);
  if (!hit) {
    hit = (async () => {
      const root = parseBody(html);
      const tagged = buildTaggedHtml(html, root);
      const facts = await renderNodeFacts(tagged, DESKTOP_VIEWPORT_PX);
      return { root, facts };
    })();
    renderCache.set(html, hit);
    if (renderCache.size > 8) {
      const oldest = renderCache.keys().next().value;
      if (oldest !== undefined) renderCache.delete(oldest);
    }
  }
  return hit;
}

// ── Geometry ────────────────────────────────────────────────────────────────

interface Boxed {
  node: Node;
  decls: Record<string, string>;
  left: number;
  top: number;
  width: number | null;
  height: number | null;
}

/**
 * Is this element hidden at desktop width in a way that means "leave it out"?
 *
 * Read straight off the browser's real, post-JS computed style — the same
 * lazy-reveal pattern that made an unconditional `display:none` untrustworthy
 * (real content, hidden in the unconditional stylesheet, revealed by the
 * exporter's own runtime JS) is exactly what letting the browser actually RUN
 * that JS before reading this fixes. If it is still `display:none` after the
 * page has fully loaded and settled, it is genuinely not shown.
 */
function isHidden(facts: Facts, node: Node): boolean {
  const decls = facts.get(node.idx);
  if (!decls) return false;
  const d = (decls.display ?? '').trim().toLowerCase();
  if (d === 'none') return true;
  const v = (decls.visibility ?? '').trim().toLowerCase();
  return v === 'hidden';
}

function positionOf(decls: Record<string, string>): string {
  return (decls.position ?? '').trim().toLowerCase();
}

/**
 * A positioned box with nothing of its own to show — no real height, no
 * background, not a media tag — exists only to anchor whatever is nested
 * inside it, not to represent a piece of content or a band member itself.
 * See the callers for why this matters: treating one as an atomic item tied
 * everything nested inside it to that one wrapper's single coordinate.
 */
function isPureWrapper(decls: Record<string, string>, tag: string): boolean {
  const ownHeight = pixels(decls.height);
  // getComputedStyle never omits background-image — an element with none
  // still reports the literal string "none", which is truthy, so a bare
  // `!!decls['background-image']` treated every element as "has an image."
  const paintsOwnBackground =
    /url\(/i.test(decls['background-image'] ?? '') ||
    (!!decls['background-color'] && !isTransparent(decls['background-color']));
  return (!ownHeight || ownHeight === 0) && !paintsOwnBackground &&
    tag !== 'img' && tag !== 'iframe' && tag !== 'video' && tag !== 'svg';
}

/**
 * A box's real extent, when its own declared height says nothing useful.
 *
 * A real page's `<form>` is routinely a zero-height anchor — `#lp-pom-form-
 * 843 { top: 107px; height: 0px }` — with every field and the submit button
 * positioned absolutely relative to IT, each with real coordinates of its
 * own. Believing the declared 0 made the gap to whatever comes after the
 * form look like hundreds of pixels of empty space (the next row's top minus
 * 107, not minus where the form's fields actually end), and that stray gap
 * got copied straight into the output. The bottom edge of the form's own
 * direct children — the only ones whose `top` is relative to the form itself
 * — is a real measurement of where the form actually ends, not a guess.
 */
function effectiveHeight(node: Node, facts: Facts, declaredHeight: number | null): number | null {
  if (declaredHeight) return declaredHeight;
  const maxBottom = positionedDescendantBottom(node, facts, 0);
  return maxBottom > 0 ? maxBottom : declaredHeight;
}

/**
 * The lowest bottom edge among `node`'s positioned descendants, in `node`'s
 * own coordinate space — looking past any number of nested flow wrappers,
 * not just direct children.
 *
 * A real Unbounce form nests its actual fields two flow divs deep (`<form>`
 * → `.fields` → `.lp-pom-form-field-step` → each real field, `position:
 * absolute`): every field the ONLY real content in an ancestor chain of
 * plain, unstyled divs whose own computed height is legitimately 0 — CSS
 * removes an absolutely-positioned child from flow entirely, so a wrapper
 * holding nothing else naturally collapses to zero height regardless of how
 * much visible content it holds. Checking only direct children (the
 * original version of this function) took that literal, correct-for-what-
 * it-is zero at face value and never looked past it, so a wrapper twice
 * pure-wrapper-deep from its real content measured as if it held nothing at
 * all — the gap this feeds into copyChildren's field-to-field spacing then
 * measured from that top-of-nothing, computed a wildly wrong gap, and got
 * silently rejected as "too large to be real," a real ~16px submit-button
 * gap ending up as none. Recursing through pure wrappers, and carrying each
 * one's own real top forward, is what still finds the real fields (and
 * reports their bottom edge relative to the OUTER node, not just the
 * immediate parent that stopped short of them).
 */
function positionedDescendantBottom(node: Node, facts: Facts, offsetTop: number): number {
  let maxBottom = 0;
  for (const child of node.children) {
    const decls = styleOf(facts, child);
    if (isHidden(facts, child)) continue;
    const pos = positionOf(decls);
    if (pos === 'absolute' || pos === 'fixed') {
      const top = realTop(decls);
      if (top === null) continue;
      const bottom = offsetTop + top + (pixels(decls.height) ?? 0);
      if (bottom > maxBottom) maxBottom = bottom;
      continue;
    }
    if (isPureWrapper(decls, child.tag)) {
      const childTop = realTop(decls) ?? 0;
      const nested = positionedDescendantBottom(child, facts, offsetTop + childTop);
      if (nested > maxBottom) maxBottom = nested;
    }
  }
  return maxBottom;
}

/**
 * Is this node itself semantic, or sitting inside one?
 *
 * The "don't pull independent boxes out of a semantic element" guards below
 * all used to check only the IMMEDIATE parent's tag. That protects a `<form>`
 * whose fields are its direct children, but a real hand-coded form nests its
 * inputs inside a few plain `<div>` wrappers first (`<form><div class="fields">
 * <div class="lp-pom-form-field-step">...`) — one layer of plain `<div>` and
 * the immediate-parent check no longer sees the `<form>` at all, so each
 * `<input>` got pulled out on its own and re-sorted by page coordinate
 * instead of staying in the form in document order. The submit button, last
 * in source order but not distinguished by any coordinate of its own, ended
 * up separated from the form entirely. Checking every ancestor, not just the
 * nearest one, is what actually answers "is this still that element's own
 * content."
 */
function hasSemanticAncestor(node: Node): boolean {
  for (let p: Node | null = node.parent; p; p = p.parent) {
    if (SEMANTIC_TAGS.has(p.tag)) return true;
  }
  return false;
}

/** Every declaration a real browser computed for one element. */
function styleOf(facts: Facts, node: Node): Record<string, string> {
  return facts.get(node.idx) ?? {};
}

/**
 * An element's real left/top offset from its DOM parent, as actually
 * painted — see ai-page-browser.ts's `--sl-left`/`--sl-top`, measured off
 * getBoundingClientRect so a runtime reposition (the "has-axis" multi-step
 * form engine repositioning its own container after load, the trigger case)
 * is reflected here even when the `left`/`top` CSS properties still report
 * the exported stylesheet's original, no-longer-true value. Falls back to
 * the CSS properties only for facts read before this was added (there are
 * none left in this codebase, but a saved/cached Facts map from disk would
 * have none either).
 */
function realLeft(decls: Record<string, string>): number {
  return pixels(decls['--sl-left']) ?? pixels(decls.left) ?? 0;
}
function realTop(decls: Record<string, string>): number | null {
  return pixels(decls['--sl-top']) ?? pixels(decls.top);
}

/** Does this subtree hold anything a visitor would see? */
function hasContent(html: string, node: Node, facts: Facts): boolean {
  if (node.tag === 'img' || node.tag === 'iframe' || node.tag === 'video' || node.tag === 'svg') return true;
  const inner = html.slice(node.innerStart, node.innerEnd);
  if (/<(?:img|iframe|video|svg|input|button|select|textarea)\b/i.test(inner)) return true;
  if (textOf(inner).length > 0) return true;
  const decls = styleOf(facts, node);
  if (decls['--sl-icon-glyph']) return true; // icon-font glyph, see ai-page-browser.ts
  return /url\(/i.test(decls['background-image'] ?? '');
}

/** Visible text of an HTML fragment, whitespace collapsed. */
function textOf(fragment: string): string {
  return fragment
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The page's content width.
 *
 * Taken from the widest thing the page actually lays out, because exporters
 * state it explicitly (a 1010px or 1326px canvas) and that number is what every
 * column proportion is measured against.
 */
function canvasWidth(html: string, root: Node, facts: Facts): number {
  let widest = 0;
  const visit = (n: Node, depth: number) => {
    if (depth > 6) return;
    const w = pixels(styleOf(facts, n).width);
    if (w && w > widest && w <= 2600) widest = w;
    for (const c of n.children) visit(c, depth + 1);
  };
  visit(root, 0);
  return widest >= 600 ? widest : DEFAULT_CANVAS_PX;
}

/**
 * Split the page into background bands.
 *
 * The common exporter shape is a stack of in-flow (`position: relative`) block
 * divs that paint nothing but a background and a height, with all the real
 * content in an absolutely positioned overlay above them. So the bands are found
 * by walking those blocks in document order and accumulating their heights —
 * band N owns page rows [offset, offset + height).
 *
 * Hidden blocks contribute no height, because they occupy none.
 */
interface Band {
  top: number;
  height: number;
  decls: Record<string, string>;
  items: Boxed[];
}

function findBands(root: Node, facts: Facts, canvas: number): Band[] {
  // The background layer is a RUN of stacked full-width strips, so every sibling
  // group on the page is scored and the tallest run wins. Taking the first run
  // found instead put the whole page in one section: exporters emit the strips at
  // the very end of the document, after the content overlay, and a lone relative
  // div inside the overlay matched first.
  let best: Array<{ decls: Record<string, string>; height: number }> = [];
  let bestScore = 0;

  const consider = (parent: Node) => {
    const group: Array<{ decls: Record<string, string>; height: number }> = [];
    let total = 0;
    for (const child of parent.children) {
      const decls = styleOf(facts, child);
      if (isHidden(facts, child)) continue;
      const pos = positionOf(decls);
      if (pos === 'absolute' || pos === 'fixed') continue;
      const h = pixels(decls.height) ?? pixels(decls['min-height']);
      if (!h || h <= 40) continue;
      const w = (decls.width ?? '').trim();
      const full = !w || w === '100%' || w === 'auto' || (pixels(w) ?? 0) >= canvas * 0.9;
      if (!full) continue;
      group.push({ decls, height: h });
      total += h;
    }
    if (group.length >= 2 && total > bestScore) {
      bestScore = total;
      best = group;
    }
    for (const child of parent.children) consider(child);
  };
  consider(root);

  let offset = 0;
  return best.map((g) => {
    const band: Band = { top: offset, height: g.height, decls: g.decls, items: [] };
    offset += g.height;
    return band;
  });
}

/**
 * Fallback banding for exporters that paint backgrounds on absolute full-width
 * divs instead of in-flow blocks: every full-width absolute element that has a
 * background and no content of its own starts a band at its own `top`.
 */
function findBandsFromOverlays(items: Boxed[], width: number): Band[] {
  const bands: Band[] = [];
  for (const it of items) {
    const w = it.width ?? 0;
    const paints =
      !!it.decls['background-image'] ||
      !!it.decls['background-color'] ||
      !!it.decls.background;
    if (paints && w >= width * 0.9 && it.height && it.height > 40) {
      bands.push({ top: it.top, height: it.height, decls: it.decls, items: [] });
    }
  }
  return bands.sort((a, b) => a.top - b.top);
}

/** Is anything inside this subtree placed by coordinates? */
function hasPositionedDescendant(node: Node, facts: Facts): boolean {
  for (const child of node.children) {
    const pos = positionOf(styleOf(facts, child));
    if (pos === 'absolute' || pos === 'fixed') return true;
    if (hasPositionedDescendant(child, facts)) return true;
  }
  return false;
}

/** Absolutely positioned elements, not descending into one another. */
function topLevelItems(html: string, root: Node, facts: Facts): {
  items: Boxed[];
  hidden: number;
} {
  const items: Boxed[] = [];
  let hidden = 0;
  // Where the last item found sat, so content with no coordinates of its own can
  // be placed after it instead of being lost.
  let lastTop = 0;

  const visit = (n: Node, offsetLeft: number, offsetTop: number) => {
    for (const child of n.children) {
      const decls = styleOf(facts, child);
      if (isHidden(facts, child)) {
        // A media query that holds at desktop hides this. Exporters keep a whole
        // second copy of the page for mobile, so copying hidden subtrees would
        // duplicate every heading rather than reproduce the page.
        hidden++;
        continue;
      }
      const pos = positionOf(decls);
      // See the identical guard in childItems: a positioned child of a
      // semantic element (e.g. a label `<span>` pixel-placed inside its
      // `<a>`) is still that element's own content, not an independent box —
      // checked all the way up, not just the immediate parent, so a plain
      // `<div>` layer between a `<form>` and its `<input>`s does not let the
      // guard stop applying (see hasSemanticAncestor).
      if ((pos === 'absolute' || pos === 'fixed') && (SEMANTIC_TAGS.has(n.tag) || hasSemanticAncestor(n))) continue;
      if (pos === 'absolute' || pos === 'fixed') {
        // A real content box paints or measures something of its own. A pure
        // positioning wrapper — zero height, nothing drawn directly on it,
        // every pixel of it coming from what's nested inside — is not a band
        // member itself; it is a hook the REAL content hangs off. Stopping
        // here and filing it as one item under whichever band its top:0
        // happened to land in put the page's entire content, every section,
        // under band 0's background: a real Unbounce page ties everything to
        // one such id-less absolute wrapper, so every button, headline and
        // photo shared its single coordinate instead of each keeping its own.
        // Recursing into it instead lets each element inside be found and
        // banded by ITS OWN top, same as if the wrapper were not there. Not
        // done when the wrapper is itself semantic (a zero-height `<form>`,
        // say) — that element's own children belong in ITS document order,
        // not sorted back out by coordinate.
        if (isPureWrapper(decls, child.tag) && !SEMANTIC_TAGS.has(child.tag)) {
          // The wrapper's own top AND left need the identical carry-forward:
          // every child's own `top`/`left` is relative to THIS wrapper, not to
          // whatever the wrapper itself sits inside. Substituting instead of
          // accumulating (the bug this replaced) put two elements that don't
          // vertically overlap at all on the real page into the same row
          // whenever they sat inside two DIFFERENT unwrapped wrappers with
          // different real offsets — each one's `top` read as if it were
          // already relative to the shared ancestor, when it was only
          // relative to its own immediate, now-discarded parent. Accumulating
          // both axes is what still carries a real offset through two nested
          // unwrapped wrappers, not just one.
          const childTop = realTop(decls);
          if (childTop !== null) lastTop = offsetTop + childTop;
          visit(child, offsetLeft + realLeft(decls), offsetTop + (childTop ?? 0));
          continue;
        }
        const childTop = realTop(decls);
        lastTop = childTop !== null ? offsetTop + childTop : lastTop;
        items.push({
          node: child,
          decls,
          left: offsetLeft + realLeft(decls),
          top: lastTop,
          width: pixels(decls.width),
          height: effectiveHeight(child, facts, pixels(decls.height)),
        });
        continue; // nested items belong to this one, handled on the way out
      }

      // Content with no coordinates at all.
      //
      // Almost everything on a coordinate page is positioned, but not quite
      // everything — a video wrapper or a hand-written block can sit in the markup
      // with no rule of its own, and walking straight past it dropped the embed
      // inside it entirely. It has no position to read, so it takes the last one
      // seen: document order puts it where it belongs, in the same band as its
      // neighbour.
      //
      // Not filtered by height any more. That used to mean "an explicit height
      // means this is one of the background strips findBands already turns
      // into bands" — a real distinction when height came from hand-parsed CSS
      // (undeclared height read as nothing at all). A real browser's computed
      // height is never empty — every rendered element resolves to a real
      // pixel number — so the same check now excluded almost everything: a
      // whole hand-written "Custom HTML" block (grid of cards, its own CSS,
      // no coordinates of its own) has a real rendered height like anything
      // else, and got skipped whole, silently dropping every card in it. The
      // signal that check was actually protecting against — a bare background
      // strip with no content of its own — is already covered by `hasContent`
      // below; nothing more is needed.
      if (
        pos !== 'relative' &&
        !SEMANTIC_TAGS.has(n.tag) && !hasSemanticAncestor(n) &&
        // A positioned descendant normally means "look inside for a more
        // precise box instead of this whole ambiguous container" — but a
        // semantic element's insides are never independently extracted
        // anyway (the guards above see to that), so the descendant check
        // only matters for a plain wrapper. Without this, a <form> with even
        // one absolutely-positioned button inside it (the submit button, on
        // a real page) failed this check, fell through to recursion instead
        // of being captured whole, and then had nothing left to capture from
        // inside it — the entire form, every field, vanished.
        (SEMANTIC_TAGS.has(child.tag) || !hasPositionedDescendant(child, facts)) &&
        hasContent(html, child, facts)
      ) {
        items.push({
          node: child, decls, left: offsetLeft, top: lastTop,
          width: pixels(decls.width), height: effectiveHeight(child, facts, pixels(decls.height)),
        });
        continue;
      }
      visit(child, offsetLeft, offsetTop);
    }
  };
  visit(root, 0, 0);
  return { items, hidden };
}

/**
 * Nested absolutely positioned children of one item, empty ones left out —
 * plus flow content that sits beside them with no coordinates of its own.
 *
 * Dropping the empty positioned ones here rather than after rows are built is
 * what lets a wrapper holding one real child collapse: an exporter box
 * routinely pairs its content with a sibling colour-overlay div that has
 * nothing in it, and counting that sibling left a one-column row nested inside
 * a one-column row.
 *
 * The flow fallback exists because that same single-child collapse has a sharp
 * edge: a hand-coded block dropped into a coordinate page mixes one positioned
 * element with plain flow siblings (a heading built with `position: absolute`
 * beside a `<table>` that is not), and without this branch the table simply
 * never became a candidate at all — not filtered out, never looked at, because
 * this function only ever walked past non-positioned nodes on its way to find
 * an absolute one. With exactly one positioned child found, the caller's
 * single-child unwrap treated it as the box's entire content and discarded the
 * table outright: six product-comparison photos, gone, with nothing in the
 * verifier's independent walk to catch it either, since {@link expectedContent}
 * does not re-derive this box's internal layout, only whether a URL or run of
 * text made it into the output at all — and here none of the table's images
 * did. Mirrors the identical fallback in {@link topLevelItems}.
 */
function childItems(html: string, node: Node, facts: Facts): Boxed[] {
  const out: Boxed[] = [];
  let lastTop = 0;
  const visit = (n: Node, offsetLeft: number, offsetTop: number) => {
    for (const child of n.children) {
      const decls = styleOf(facts, child);
      if (isHidden(facts, child)) continue;
      const pos = positionOf(decls);
      // A semantic element's children are not independent boxes even when
      // ABSOLUTELY POSITIONED — a real page's CTA gave its own inner `<span>`
      // a pixel-precise `position: absolute` for label placement, and this
      // branch, having no such guard, pulled that span out as its own item,
      // dropping the `<a href>` it belonged to entirely: the button rendered
      // with the right text but was no longer a link. The flow-fallback
      // branch below already refuses to do this for non-positioned children
      // (see its comment) — a child that happens to be positioned needs the
      // exact same protection, not an exemption from it.
      if ((pos === 'absolute' || pos === 'fixed') && (SEMANTIC_TAGS.has(n.tag) || hasSemanticAncestor(n))) continue;
      if (pos === 'absolute' || pos === 'fixed') {
        // See isPureWrapper and the identical branch in topLevelItems: a
        // positioning-only wrapper nested at THIS depth has the same problem
        // — its own coordinate is not where its content belongs. Not done
        // when the wrapper itself is semantic, same reasoning as topLevelItems.
        if (isPureWrapper(decls, child.tag) && !SEMANTIC_TAGS.has(child.tag)) {
          // See the identical fix in topLevelItems: without this, flow
          // content inside the wrapper inherited a stale position from
          // whatever unrelated absolute sibling came before the wrapper
          // itself, not the wrapper's own real position. And see the
          // identical LEFT+TOP accumulation there too — a card's own padding
          // routinely lands on the positioning wrapper around its
          // form/content, not on the semantic element itself, and unwrapping
          // the wrapper must carry its real offset forward (on both axes)
          // instead of discarding it.
          const childTop = realTop(decls);
          if (childTop !== null) lastTop = offsetTop + childTop;
          visit(child, offsetLeft + realLeft(decls), offsetTop + (childTop ?? 0));
          continue;
        }
        const childTop = realTop(decls);
        lastTop = childTop !== null ? offsetTop + childTop : lastTop;
        if (hasContent(html, child, facts)) {
          out.push({
            node: child, decls,
            left: offsetLeft + realLeft(decls),
            top: lastTop,
            width: pixels(decls.width),
            height: effectiveHeight(child, facts, pixels(decls.height)),
          });
        }
        continue;
      }
      if (
        // A semantic element's children are not independent boxes — an
        // `<option>` beside its `<select>` instead of inside it is not a
        // dropdown, a `<th>` pulled out of its `<tr>` is not a table cell, and
        // a `<span>` promoted out of its `<a>` is not a link. Reaching this
        // deep into one and treating its children as flow candidates is what
        // unwrapped a real CTA down to bare label text and a real table down
        // to six stray images with no `<table>` around them. `n` (not `child`)
        // is checked because the question is what CONTAINS these children, not
        // what they are: an ordinary structural `<div>` may still hold a
        // `<table>` worth capturing whole — see the branch below. Checked up
        // the whole ancestor chain, not just `n` itself — see
        // hasSemanticAncestor.
        !SEMANTIC_TAGS.has(n.tag) && !hasSemanticAncestor(n) &&
        // Unlike topLevelItems, `relative` is not excluded here: at THIS depth
        // there is no band strip to confuse it with — findBands only ever runs
        // once, over the whole document, before any item reaches childItems. A
        // `.fl-table { position: relative; left: 20% }` on a real page is just
        // a table nudged sideways.
        //
        // Not filtered by height either, for the same reason as the identical
        // fallback in topLevelItems — a real browser's computed height is
        // never empty, so this used to reject nearly every real flow block
        // (a hand-written "Custom HTML" grid of cards, in this case) instead
        // of only the bare background strips it was meant to catch, which
        // `hasContent` below already excludes on its own.
        //
        // Also skipped outright for a semantic child — see the identical note
        // in topLevelItems: a <form> with one positioned button inside it
        // otherwise failed this check and lost every field it had.
        (SEMANTIC_TAGS.has(child.tag) || !hasPositionedDescendant(child, facts)) &&
        hasContent(html, child, facts)
      ) {
        out.push({
          node: child, decls, left: offsetLeft, top: lastTop,
          width: pixels(decls.width), height: effectiveHeight(child, facts, pixels(decls.height)),
        });
        continue;
      }
      visit(child, offsetLeft, offsetTop);
    }
  };
  visit(node, 0, 0);
  return out;
}

/**
 * Group boxes that sit beside each other into rows.
 *
 * Two boxes are in one row when their vertical ranges overlap by more than half
 * the shorter one's height. That is arithmetic, not interpretation: same input,
 * same rows, every time.
 */
function groupRows(items: Boxed[]): Boxed[][] {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: Boxed[][] = [];

  for (const it of sorted) {
    const h = it.height ?? 0;
    const bottom = it.top + h;
    const row = rows[rows.length - 1];
    if (row) {
      // Compare against the row's extent so a tall element keeps collecting the
      // short ones stacked beside it.
      const rTop = Math.min(...row.map((r) => r.top));
      const rBottom = Math.max(...row.map((r) => r.top + (r.height ?? 0)));
      const overlap = Math.min(bottom, rBottom) - Math.max(it.top, rTop);
      const shorter = Math.min(h || 1, rBottom - rTop || 1);
      // Beside, not merely near: the box must overlap the row vertically AND
      // clear every box already in it horizontally. Vertical overlap alone put a
      // subheading in a column next to its own headline, because exporter text
      // boxes are tall enough that the one below starts inside the one above.
      const clearsSideways = row.every((r) => {
        const rRight = r.left + (r.width ?? Infinity);
        const itRight = it.left + (it.width ?? Infinity);
        return itRight <= r.left + SIDE_TOLERANCE || it.left >= rRight - SIDE_TOLERANCE;
      });
      if (overlap > shorter * ROW_OVERLAP && clearsSideways) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }

  for (const row of rows) row.sort((a, b) => a.left - b.left);
  return rows;
}

// ── Style sheet generation ──────────────────────────────────────────────────

/**
 * Collects appearance declarations into deduplicated classes.
 *
 * Two elements that looked identical in the source share one class in the
 * output, which is what makes the result readable enough to edit by hand.
 */
class StyleBook {
  private byDecl = new Map<string, string>();
  private order: Array<{ name: string; css: string }> = [];

  /** A class name for these declarations, or '' when there is nothing to say. */
  classFor(decls: Record<string, string>): string {
    const css = appearanceCss(decls);
    if (!css) return '';
    const existing = this.byDecl.get(css);
    if (existing) return existing;
    const name = `sl-s${this.order.length + 1}`;
    this.byDecl.set(css, name);
    this.order.push({ name, css });
    return name;
  }

  stylesheet(): string {
    return this.order.map((r) => `.${r.name} { ${r.css} }`).join('\n');
  }
}

/**
 * Appearance-only CSS for one element, in a fixed property order.
 *
 * The `background` shorthand needs care: an exporter routinely sets
 * `background: rgba(27,34,104,0.32)` for a colour and `background-image:
 * url(...)` separately. Emitting the shorthand after the image would reset the
 * image to none and lose the photo, so a shorthand holding only a colour is
 * rewritten to `background-color`.
 */
function appearanceCss(decls: Record<string, string>): string {
  const parts: string[] = [];
  const bg = (decls.background ?? '').trim();
  const bgColor = (decls['background-color'] ?? '').trim();
  const bgImage = (decls['background-image'] ?? '').trim();

  const colorOnly = bg && !/url\(|gradient\(/i.test(bg);
  const resolvedColor = bgColor || (colorOnly ? bg : '');
  if (resolvedColor && !isTransparent(resolvedColor)) {
    parts.push(`background-color: ${resolvedColor}`);
  }
  if (bg && !colorOnly) parts.push(`background: ${bg}`);
  if (bgImage && bgImage !== 'none') parts.push(`background-image: ${bgImage}`);

  for (const prop of KEEP_PROPS) {
    if (prop === 'background-color' || prop === 'background-image') continue;
    const raw = decls[prop];
    if (!raw) continue;
    const value = raw.replace(/\s*!important\s*$/i, '').trim();
    if (!value || value === 'none' && prop.startsWith('border')) continue;
    if (!usableValue(value)) continue;
    // Declarations that change nothing. Worth dropping rather than copying,
    // because an element whose only style is `border-radius: 0px` reads as
    // "has appearance" and survives as a wrapper div that does nothing.
    if ((prop === 'padding' || prop === 'border-radius') && /^0(?:px)?$/.test(value)) continue;

    // A line height shorter than the text it wraps is not a line height — it is a
    // box height that ended up in the wrong property, and copying it overlaps
    // every line onto the one above. Seen on a real page as `font-size: 36px;
    // line-height: 22px`.
    if (prop === 'line-height') {
      const lh = pixels(value);
      const fs = pixels(decls['font-size']);
      if (lh !== null && fs !== null && lh < fs) continue;
    }
    parts.push(`${prop}: ${value}`);
  }

  const placed = positionOf(decls) === 'absolute' || positionOf(decls) === 'fixed';
  if (!placed) {
    for (const prop of FLOW_PROPS) {
      const raw = decls[prop];
      if (!raw) continue;
      const value = raw.replace(/\s*!important\s*$/i, '').trim();
      if (!value || !usableValue(value)) continue;
      // `display: none` can only arrive here on an element the hidden check
      // already let through (a `visibility` variant, say). Copying it would hide
      // content the content check has just confirmed is present.
      if (prop === 'display' && value.toLowerCase() === 'none') continue;
      if (prop.startsWith('margin') && /^0(?:px)?$/.test(value)) continue;
      parts.push(`${prop}: ${value}`);
    }
  }
  return parts.join('; ');
}

/**
 * Is this a value a browser could actually use?
 *
 * Page builders emit broken CSS: a real export carried `border-color: #undefined;
 * border-width: undefinedpx` on every button. A browser ignores those, so they do
 * no visual harm, but copying them across makes the rebuilt stylesheet look like
 * the bug is ours and hides real problems in the noise.
 */
function usableValue(value: string): boolean {
  // No word boundary after the name: the real export wrote `undefinedpx`, and
  // `\bundefined\b` does not match that at all — which is how three of them
  // survived the first version of this filter.
  return !/undefined|NaN/.test(value);
}

/**
 * Does this band put anything on the screen by itself?
 *
 * Used to decide whether a strip with no content in it is worth a section. A
 * photo or a colour is; plain white on a white page is not.
 */
function bandPaints(decls: Record<string, string>): boolean {
  if (/url\(/i.test(decls['background-image'] ?? '')) return true;
  const colour = (decls['background-color'] ?? decls.background ?? '').trim();
  if (!colour || isTransparent(colour)) return false;
  const v = colour.toLowerCase().replace(/\s+/g, '');
  return !(v === '#fff' || v === '#ffffff' || v === 'white' || v === 'rgb(255,255,255)' ||
    v === 'rgba(255,255,255,1)');
}

function isTransparent(value: string): boolean {
  const v = value.toLowerCase().replace(/\s+/g, '');
  return v === 'transparent' || /rgba\([^)]*,0(?:\.0+)?\)$/.test(v);
}

// ── Content copying ─────────────────────────────────────────────────────────

interface Copied {
  texts: string[];
  images: string[];
  embeds: string[];
  /**
   * Original element id → the section it ended up in.
   *
   * Exporter pages link to their own elements (`href="#lp-pom-box-840"` for a
   * "jump to the form" button). Those ids are dropped, so every such link would
   * be dead. The map lets them be re-pointed at the section instead, which is
   * the behaviour the visitor expects and survives editing.
   */
  anchors: Map<string, string>;
  /** Section currently being copied, for `anchors`. */
  section: string;
}

/**
 * Text sitting directly inside an element, not inside one of its children.
 *
 * This is the unit the appearance check keys on, so it is also the unit a repair
 * is applied to: the element that owns the text is the element whose style has to
 * be stated explicitly.
 */
function directText(html: string, node: Node): string {
  if (node.children.length === 0) return textOf(html.slice(node.innerStart, node.innerEnd));
  const parts: string[] = [];
  let cursor = node.innerStart;
  for (const child of node.children) {
    const between = textOf(html.slice(cursor, child.start));
    if (between) parts.push(between);
    cursor = child.end;
  }
  const tail = textOf(html.slice(cursor, node.innerEnd));
  if (tail) parts.push(tail);
  return parts.join(' ');
}

/**
 * Overlay whatever the appearance check demanded for this element's own text.
 *
 * Stated on the element rather than left to inheritance, because a value that was
 * inherited in the source may have nothing to inherit from in the rebuild — the
 * ancestor that carried it can be a wrapper that no longer exists.
 */
function withForcedStyles(
  html: string,
  node: Node,
  decls: Record<string, string>,
  force: ReadonlyMap<string, Record<string, string>> | undefined,
): Record<string, string> {
  if (!force || force.size === 0) return decls;
  const own = directText(html, node);
  if (!own) return decls;
  const forced = force.get(own);
  return forced ? { ...decls, ...forced } : decls;
}

/**
 * Re-emit an element subtree with exporter identity stripped and appearance kept.
 *
 * Text and URLs are sliced out of the source string, never retyped — that is the
 * entire reason images and copy cannot go missing the way they did when a model
 * wrote this step.
 */
function copySubtree(
  html: string,
  node: Node,
  facts: Facts,
  book: StyleBook,
  copied: Copied,
  emitSelf: boolean,
  force: ReadonlyMap<string, Record<string, string>> | undefined,
): string {
  if (isHidden(facts, node)) return '';

  // An icon's meaning is in its markup (path data, gradients, viewBox), not in
  // the appearance-CSS model the rest of this function copies through — parsing
  // its children as ordinary nodes silently drops them (see parseBody). The
  // element is self-contained, so it is copied out exactly as written.
  if (node.tag === 'svg') return html.slice(node.start, node.end);

  let decls = withForcedStyles(html, node, styleOf(facts, node), force);
  // A <select>'s vertical padding is native dropdown chrome, not page CSS (see
  // the identical reasoning in boxOf below) — untrustworthy regardless of its
  // value, so it is dropped rather than copied into the generated class. Left
  // /right survives: both a select and its sibling text inputs reported the
  // same 11px, which is real page CSS, not browser chrome. sizeRescueStyle
  // restores the element's real rendered height in its place.
  if (node.tag === 'select') decls = withoutSelectVerticalPadding(decls);

  const ownId = attrValue(node.attrs, 'id');
  if (ownId && copied.section) copied.anchors.set(ownId, copied.section);

  const inner = node.children.length > 0
    ? copyChildren(html, node, facts, book, copied, force)
    : escapeText(html.slice(node.innerStart, node.innerEnd));

  if (!emitSelf) return inner;

  // A wrapper (div, section, header…) carries no meaning of its own, so the old
  // rule was to drop it and keep its children. That deleted every card on the
  // page: the panel's background, border, radius and padding lived on the wrapper,
  // and its children were left standing on the section background — a real page
  // ended up with #CBD5E1 checklist text on white, i.e. invisible. It also broke
  // inheritance, since `.card { color: #fff }` reaches an unstyled <p> only while
  // the card is still there. So a wrapper survives exactly when it has appearance
  // to contribute; the purely structural ones still collapse.
  if (!SEMANTIC_TAGS.has(node.tag)) {
    if (!inner.trim()) return '';
    const wrapCls = book.classFor(decls);
    if (wrapCls) return `<div class="${wrapCls}">${inner}</div>`;
    // No appearance of its own, but more than one child: it is the thing that
    // groups them, and a grid or flex parent counts its children. Collapsing it
    // would promote its children into the grid above and rearrange the section.
    const elementChildren = node.children.length;
    if (elementChildren > 1) return `<div>${inner}</div>`;
    return inner;
  }

  if (node.tag === 'img') {
    const src = imageSrc(node.attrs);
    // A 1×1 placeholder with no real source behind it is a spacer, not a picture.
    // The length test keeps genuinely inline images (icons, small logos), which
    // are far longer than the 62-character transparent GIF exporters use.
    if (!src || (src.startsWith('data:') && src.length < 512)) return '';
    copied.images.push(src);
    const alt = (attrValue(node.attrs, 'alt') ?? '').replace(/"/g, '&quot;');
    const imgCls = book.classFor(decls);
    return `<img src="${src}" alt="${alt}"${imgCls ? ` class="${imgCls}"` : ''}>`;
  }
  if (node.tag === 'iframe') {
    const src = attrValue(node.attrs, 'src');
    if (src) copied.embeds.push(src);
  }

  // An icon-font glyph draws through a `content:` rule keyed to its ORIGINAL
  // class name in the linked stylesheet (externalStyleLinks kept the link
  // itself already) — a generated appearance class has no such rule, so the
  // icon silently stops rendering unless the source class survives too.
  const iconClass = decls['--sl-icon-glyph'] ? (attrValue(node.attrs, 'class') ?? '').trim() : '';
  const cls = [iconClass, book.classFor(decls)].filter(Boolean).join(' ');
  // A clickable leaf sized entirely by explicit width/height and zero padding
  // (a real Unbounce button: `width:442px; height:57px`, no padding at all)
  // collapses to just wrapping its text once width/height are dropped, same
  // as every other element — the right choice for a section or a card, whose
  // size should come from its content, but wrong here: there is no content-
  // driven fallback size for this element at all, so it needs its own real
  // dimensions restored, not a class the layout system already handles.
  const sizeRescue = sizeRescueStyle(node.tag, decls);
  const open = `<${node.tag}${keptAttrs(node.attrs)}${cls ? ` class="${cls}"` : ''}${sizeRescue}>`;
  if (VOID_TAGS.has(node.tag)) return open;
  return `${open}${inner}</${node.tag}>`;
}

/** See the call site in copySubtree. */
function withoutSelectVerticalPadding(decls: Record<string, string>): Record<string, string> {
  if (!decls.padding && !decls['padding-top'] && !decls['padding-bottom']) return decls;
  const next = { ...decls };
  delete next.padding;
  delete next['padding-top'];
  delete next['padding-bottom'];
  return next;
}

/** See the call site in copySubtree. */
function sizeRescueStyle(tag: string, decls: Record<string, string>): string {
  if (tag === 'button' || tag === 'a' || tag === 'input') {
    // A clickable leaf sized entirely by explicit width/height and zero
    // padding (a real Unbounce button: `width:442px; height:57px`, no padding
    // at all) collapses to just wrapping its text once width/height are
    // dropped — the right choice for a section or a card, whose size should
    // come from its content, but wrong here: there is no content-driven
    // fallback size for this element at all, so it needs its own real
    // dimensions restored, not a class the layout system already handles.
    const paddingProps = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
    const hasNoPadding = paddingProps.every((p) => !pixels(decls[p]));
    const w = pixels(decls.width);
    const h = pixels(decls.height);
    if (hasNoPadding && w && h) {
      // `display` was never copied onto this element (see the FLOW_PROPS
      // "placed" skip in appearanceCss) — it was coordinate-placed in the
      // source, so its own display never mattered there. It matters now: an
      // <a>/<button> is inline by default, and an inline element ignores
      // width/height entirely, so the rescue above would have no visible
      // effect at all without this. flex + centering replaces the source's
      // usual trick for this exact shape — a label `<span>` made `position:
      // absolute; top: 50%` to centre itself inside its parent — which
      // relied on the parent being a positioning context we no longer make
      // it. Flex reproduces the same centred result without needing position
      // at all. `inline-flex`, not `flex`: the column wrapping this button
      // centres it with `text-align: center`, which only ever affects
      // INLINE-level boxes — plain `flex` makes the button a block-level box
      // that property has no power over at all, so the button itself kept
      // its internal centering but stopped being centered within its own
      // column, sitting flush left instead. inline-flex keeps both.
      return ` style="width: ${w}px; height: ${h}px; display: inline-flex; align-items: center; justify-content: center"`;
    }
  }

  if (tag === 'select') {
    // Padding can't rescue a select's height the way it does for button/a/
    // input above — its vertical padding was already dropped upstream as
    // untrustworthy native chrome, not a real "zero" that check would catch.
    // Its real rendered width and height are trustworthy though (same source
    // as every other element's), and restoring them reproduces the source's
    // box without forcing centered text, which a select doesn't use — a real
    // value renders left-aligned against its (real, kept) left padding.
    const w = pixels(decls.width);
    const h = pixels(decls.height);
    const style = [w ? `width: ${w}px` : '', h ? `height: ${h}px` : ''].filter(Boolean).join('; ');
    return style ? ` style="${style}"` : '';
  }

  if (tag === 'input' || tag === 'textarea') {
    // Unlike a <div>, a form control does not stretch to fill its container
    // by default — it is an intrinsically-sized element (the browser's own
    // ~20-character default), not a block whose width auto-fills available
    // space. Without this it renders far narrower than the field row the
    // source page actually laid it out at, stuck to the left with empty
    // space beside it. Width-only, and unconditional (not gated on "zero
    // padding" the way button/a are above): the field's own real, non-zero
    // padding already sizes its height correctly; only its width has no
    // content-driven fallback. Real measured fact, not a guess.
    const w = pixels(decls.width);
    return w ? ` style="width: ${w}px"` : '';
  }

  return '';
}

/** Children of an element, with the text between them preserved in order. */
function copyChildren(
  html: string,
  node: Node,
  facts: Facts,
  book: StyleBook,
  copied: Copied,
  force: ReadonlyMap<string, Record<string, string>> | undefined,
): string {
  let out = '';
  let cursor = node.innerStart;
  // A field inside a <form> (or similar semantic content) is coordinate-
  // placed in the source same as everything else, but never gets picked up
  // by the row/column system — SEMANTIC_TAGS keeps a `<form>`'s children in
  // its own document order on purpose (see the guards in topLevelItems and
  // childItems), so it copies through here in plain flow instead, with real
  // per-field top/left never read for placement. What it does NOT lose is
  // the record of that real top — used here only for the GAP between one
  // field and the next, restoring the vertical rhythm a page-builder form
  // authors entirely through coordinates and would otherwise render with
  // every field jammed against the one above it.
  //
  // Only trusted for a child that is itself genuinely `position: absolute` —
  // real coordinate-placed content, a field or a submit button, never plain
  // inline text. The old `pixels(decls.top)` acted as that filter for free,
  // since a non-positioned child's `top` CSS property is just "auto" and
  // failed to parse — realTop has no such gap, it reports a real number for
  // ANY rendered element, including a nested `<span>` sitting in ordinary
  // text flow. Using it unconditionally here (needed for the fix below) fed
  // this loop the real vertical offset between two wrapped LINES of the same
  // paragraph as if it were a real field-to-field gap, landing inside the
  // 4–80px "plausible" bounds below and splitting one line of body copy into
  // two, a `<div style="margin-top">` inserted mid-sentence.
  let prevBottom: number | null = null;
  for (const child of node.children) {
    const between = html.slice(cursor, child.start);
    if (textOf(between)) out += escapeText(between);

    const childDecls = styleOf(facts, child);
    const childPositioned = positionOf(childDecls) === 'absolute' || positionOf(childDecls) === 'fixed';
    const childRealTop = realTop(childDecls);
    const childTop = childPositioned ? childRealTop : null;
    let piece = copySubtree(html, child, facts, book, copied, true, force);
    if (piece.trim() && childTop !== null && prevBottom !== null) {
      const gap = Math.round(childTop - prevBottom);
      // Sane bounds: a real field-to-field gap on a real page, not a
      // side-by-side sibling whose top only coincidentally differs, and not
      // a stray huge gap from an unrelated pair of elements.
      if (gap >= 4 && gap <= 80) {
        piece = `<div style="margin-top: ${gap}px">${piece}</div>`;
      }
    }
    // What the NEXT positioned sibling's gap gets measured against. A
    // positioned child's own bottom edge, same as always — but a form's
    // real fields typically sit two flow wrappers below `node` (`.fields`,
    // a "step" div), each with a legitimately-zero own height (an
    // absolutely-positioned child contributes nothing to its parent's flow
    // height), so stopping at that zero broke the chain exactly like the
    // stale-`top` bug this replaced: the wrapper's real content bottom is
    // still there, just one or two effectiveHeight lookups further in — see
    // positionedDescendantBottom.
    if (childPositioned && childRealTop !== null) {
      prevBottom = childRealTop + (pixels(childDecls.height) ?? 0);
    } else if (!childPositioned && childRealTop !== null && isPureWrapper(childDecls, child.tag)) {
      const effective = effectiveHeight(child, facts, pixels(childDecls.height));
      if (effective) prevBottom = childRealTop + effective;
    }
    out += piece;
    cursor = child.end;
  }
  const tail = html.slice(cursor, node.innerEnd);
  if (textOf(tail)) out += escapeText(tail);

  const text = textOf(out);
  if (text) copied.texts.push(text);
  return out;
}

/** Source text, comments and stray markup removed, entities left alone. */
function escapeText(fragment: string): string {
  return fragment.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * The real URL of an image, looking past a lazy-loading placeholder.
 *
 * Exporters ship `<img src="data:image/gif;base64,…1x1…"
 * data-src-desktop-1x="https://…/photo.png">` and swap the two in at runtime. The
 * placeholder is the only thing in `src`, so a rebuild that trusts `src` copies
 * fourteen 1×1 GIFs and calls it a page — and a verifier that also trusts `src`
 * agrees with it, which is how this went unnoticed. Both call this instead.
 *
 * Candidates are scored rather than matched by name, since the attribute is
 * spelled differently by every exporter (`data-src`, `data-original`,
 * `data-lazy-src`, `data-echo`). Desktop and 1x are preferred because the page is
 * resolved at desktop width; a mobile source is a different image.
 */
export function imageSrc(attrs: string): string | null {
  const src = attrValue(attrs, 'src');
  if (src && !src.startsWith('data:')) return src;

  let best: string | null = null;
  let bestScore = -Infinity;
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) {
    const name = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? '').trim();
    if (name === 'src' || !name.startsWith('data-')) continue;
    if (!/^(?:https?:)?\/\/|^\//.test(value)) continue;
    if (!/\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i.test(value)) continue;

    let score = 0;
    if (name.includes('desktop')) score += 3;
    if (name.includes('mobile') || name.includes('phone')) score -= 4;
    if (name.includes('1x')) score += 2;
    if (name.includes('2x') || name.includes('3x')) score -= 1;
    if (name === 'data-src' || name === 'data-original') score += 1;
    if (score > bestScore) { bestScore = score; best = value; }
  }
  return best ?? src ?? null;
}

/** The attributes worth keeping, re-serialised. Ids and classes are dropped. */
function keptAttrs(attrs: string): string {
  let out = '';
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) {
    const name = m[1].toLowerCase();
    if (!KEEP_ATTRS.has(name)) continue;
    const value = m[2] ?? m[3] ?? m[4];
    out += value === undefined ? ` ${name}` : ` ${name}="${value.replace(/"/g, '&quot;')}"`;
  }
  return out;
}

// ── Emission ────────────────────────────────────────────────────────────────

/** `flex-grow` units for a box, from its share of the row's total width. */
function gridUnits(width: number | null, rowWidth: number): number {
  if (!width || rowWidth <= 0) return GRID_UNITS;
  const units = Math.round((width / rowWidth) * GRID_UNITS);
  return Math.min(GRID_UNITS, Math.max(1, units));
}

function slug(text: string, taken: Set<string>, fallback: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 4)
    .join('-');
  let name = base || fallback;
  if (taken.has(name)) {
    for (let n = 2; ; n++) {
      if (!taken.has(`${name}-${n}`)) { name = `${name}-${n}`; break; }
    }
  }
  taken.add(name);
  return name;
}

/** First heading text inside a band, for naming the section. */
function headingOf(html: string, items: Boxed[]): string | undefined {
  for (const it of items) {
    const inner = html.slice(it.node.start, it.node.end);
    const m = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(inner);
    const text = m ? textOf(m[1]) : '';
    if (text) return text;
  }
  for (const it of items) {
    const text = textOf(html.slice(it.node.innerStart, it.node.innerEnd));
    if (text.length >= 3) return text;
  }
  return undefined;
}

/** Google Fonts stylesheet links from the source head, kept as-is. */
/**
 * External `<link rel="stylesheet">` tags from the source head, kept as-is —
 * not just Google Fonts. An icon font (Tabler, Font Awesome…) is exactly this
 * shape: a CDN stylesheet plus a class name (`ti ti-check`) with no text of
 * its own, the glyph drawn by a `content:` rule this transpiler has no way to
 * re-derive. Dropping the link would silently blank every icon that depends
 * on it — copying it costs nothing and needs no cascade to interpret, it is
 * whatever the source page already trusted to draw those icons.
 */
function externalStyleLinks(html: string): { html: string; families: string[] } {
  const links: string[] = [];
  const families = new Set<string>();
  const re = /<link\b[^>]*rel\s*=\s*"stylesheet"[^>]*href\s*=\s*"(https?:\/\/[^"]*)"[^>]*>|<link\b[^>]*href\s*=\s*"(https?:\/\/[^"]*)"[^>]*rel\s*=\s*"stylesheet"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    links.push(m[0]);
    const href = m[1] ?? m[2] ?? '';
    if (/fonts\.(?:googleapis|gstatic)\.com/i.test(href)) {
      const famRe = /family=([^&:]+)/g;
      let f: RegExpExecArray | null;
      while ((f = famRe.exec(href))) {
        families.add(decodeURIComponent(f[1]).replace(/\+/g, ' '));
      }
    }
  }
  return { html: links.join('\n'), families: Array.from(families) };
}

/**
 * The layout stylesheet. This is the whole of the new geometry — six rules,
 * no pixel positions, and a single breakpoint that stacks rows on small screens.
 */
function layoutCss(canvas: number): string {
  return `/* Layout: sections in normal flow, rows of proportional columns. */
.sl-band { position: relative; background-size: cover; background-position: center; background-repeat: no-repeat; }
.sl-wrap { max-width: ${canvas}px; margin: 0 auto; padding: 0 24px; box-sizing: border-box; }
.sl-row { display: flex; flex-wrap: wrap; align-items: flex-start; }
.sl-col { flex: 1 1 0; min-width: 0; }
.sl-col > img, .sl-col > iframe, .sl-col img { max-width: 100%; height: auto; }
.sl-col iframe { width: 100%; aspect-ratio: 16 / 9; height: auto; }
${Array.from({ length: GRID_UNITS }, (_, i) => `.sl-g${i + 1} { flex-grow: ${i + 1}; }`).join('\n')}
@media (max-width: 768px) {
  .sl-row { flex-direction: column; }
  .sl-col { width: 100%; }
}`;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Rebuild a coordinate page as flow markup.
 *
 * Returns the new document plus the exact list of what was copied, so the caller
 * can assert that nothing was lost instead of scoring how similar it looks.
 */
export async function transpileCoordinatePage(
  html: string,
  force?: ReadonlyMap<string, Record<string, string>>,
): Promise<TranspileResult> {
  return build(html, force);
}

async function build(
  html: string,
  force: ReadonlyMap<string, Record<string, string>> | undefined,
): Promise<TranspileResult> {
  const { root, facts } = await renderPage(html);
  const canvas = canvasWidth(html, root, facts);
  const book = new StyleBook();
  const copied: Copied = {
    texts: [], images: [], embeds: [], anchors: new Map(), section: '',
  };
  const warnings: string[] = [];

  const { items, hidden } = topLevelItems(html, root, facts);

  let bands = findBands(root, facts, canvas);
  if (bands.length === 0) bands = findBandsFromOverlays(items, canvas);
  if (bands.length === 0) {
    // Nothing paints a background: treat the page as one section so the content
    // still survives in flow. Rare, but losing the page would be worse.
    const pageHeight = Math.max(...items.map((i) => i.top + (i.height ?? 0)), 1);
    bands = [{ top: 0, height: pageHeight, decls: {}, items: [] }];
    warnings.push('No background sections were found, so the page became one section.');
  }

  const pageHeight = bands[bands.length - 1].top + bands[bands.length - 1].height;

  // Assign each item to the band its top edge falls in. Items are placed by page
  // coordinates and bands tile the page, so this is a lookup, not a guess.
  for (const it of items) {
    const isFurniture =
      !hasContent(html, it.node, facts) &&
      (it.height ?? 0) >= pageHeight * FURNITURE_HEIGHT_SHARE;
    if (isFurniture) continue; // page-wide overlay; bands carry their own background
    if (!hasContent(html, it.node, facts)) continue;

    let band = bands[0];
    for (const b of bands) {
      if (it.top >= b.top && it.top < b.top + b.height) { band = b; break; }
      if (it.top >= b.top) band = b;
    }
    band.items.push(it);
  }

  const taken = new Set<string>();
  const sections: TranspiledSection[] = [];
  const bodyParts: string[] = [];

  bands.forEach((band, index) => {
    if (band.items.length === 0 && !bandPaints(band.decls)) return;

    const heading = headingOf(html, band.items);
    const name = slug(heading ?? '', taken, `section-${index + 1}`);
    const rows = groupRows(band.items);

    // Vertical rhythm comes from the real gaps: the space above the first row and
    // below the last become the section's padding, the space between rows its gaps.
    const firstTop = rows.length > 0 ? Math.min(...rows[0].map((r) => r.top)) : band.top;
    const lastBottom = rows.length > 0
      ? Math.max(...rows[rows.length - 1].map((r) => r.top + (r.height ?? 0)))
      : band.top;
    const padTop = Math.max(0, Math.round(firstTop - band.top));
    const padBottom = Math.max(0, Math.round(band.top + band.height - lastBottom));

    copied.section = name;
    const built = emitRows(html, band.items, canvas, facts, book, copied, force);
    const empty = !built.html.trim();
    if (empty && !bandPaints(band.decls)) return;

    const bandCls = book.classFor(band.decls);
    // A strip that only paints a colour or a photo is still part of the design —
    // the navy divider between two white sections is not decoration to discard.
    // It keeps its height so the page's vertical rhythm survives, as min-height so
    // it can still grow when something is added to it.
    const pad = [
      empty ? `min-height: ${Math.round(band.height)}px` : '',
      !empty && padTop > 0 ? `padding-top: ${padTop}px` : '',
      !empty && padBottom > 0 ? `padding-bottom: ${padBottom}px` : '',
    ].filter(Boolean).join('; ');

    bodyParts.push(
      `<!-- SL:${name} -->\n` +
      `<section id="${name}" class="sl-band${bandCls ? ` ${bandCls}` : ''}"${pad ? ` style="${pad}"` : ''}>\n` +
      `  <div class="sl-wrap">\n${indent(built.html, 4)}\n  </div>\n` +
      `</section>\n` +
      `<!-- /SL:${name} -->`,
    );
    sections.push({ name, rows: built.rows, heading });
  });

  const fonts = externalStyleLinks(html);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? 'Landing page';

  if (hidden > 0) {
    warnings.push(
      `${hidden} element${hidden === 1 ? '' : 's'} the original hid on desktop were left out.`,
    );
  }
  if (/<script\b/i.test(html)) {
    // See the note at the top of this file: exporter scripts drive their widgets
    // through the per-element ids the rebuild has to drop.
    warnings.push(
      'Interactive extras from the original page builder (sliders, pop-ups, sticky bars, ' +
      'its own form validation) will not carry over.',
    );
  }

  const document =
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${title}</title>\n` +
    (fonts.html ? `${fonts.html}\n` : '') +
    `<style>\n${baseCss(facts)}\n\n${layoutCss(canvas)}\n\n${book.stylesheet()}\n</style>\n` +
    `</head>\n<body>\n${bodyParts.join('\n\n')}\n</body>\n</html>\n`;

  return {
    html: rewriteAnchors(document, copied.anchors, new Set(sections.map((s) => s.name))),
    sections,
    copied: {
      texts: copied.texts,
      images: copied.images,
      embeds: copied.embeds,
      fonts: fonts.families,
    },
    hidden,
    warnings,
  };
}

// ── Verification ────────────────────────────────────────────────────────────

export interface ExpectedContent {
  /** `src` of every image the source shows at desktop width. */
  images: string[];
  /** `src` of every iframe/video embed the source shows. */
  embeds: string[];
  /** Every run of visible text, whitespace collapsed. */
  texts: string[];
  /** Raw markup of every inline `<svg>` icon the source shows. */
  icons: string[];
  /** `name="…"` of every non-hidden form field the source shows. */
  formFields: string[];
}

/**
 * What a faithful rebuild of this page must contain.
 *
 * Walks the source independently of the transpiler and skips only what the source
 * itself hides at desktop width — exporters keep a second, hidden copy of the
 * whole page for small screens, and a rebuild that included it would show every
 * heading twice rather than reproduce the page.
 */
export async function expectedContent(html: string): Promise<ExpectedContent> {
  const { root, facts } = await renderPage(html);
  const images: string[] = [];
  const embeds: string[] = [];
  const texts: string[] = [];
  const icons: string[] = [];
  const formFields: string[] = [];

  const visit = (node: Node) => {
    for (const child of node.children) {
      if (isHidden(facts, child)) continue;
      if (child.tag === 'img') {
        const src = imageSrc(child.attrs);
        if (src && !src.startsWith('data:')) images.push(src);
      } else if (child.tag === 'iframe' || child.tag === 'video') {
        const src = attrValue(child.attrs, 'src');
        if (src) embeds.push(src);
      } else if (child.tag === 'svg') {
        icons.push(html.slice(child.start, child.end));
      } else if (child.tag === 'input' || child.tag === 'select' || child.tag === 'textarea') {
        // A hidden input carries no content a visitor would ever see (CSRF
        // tokens, utm params) — only the fields someone actually fills in.
        const type = (attrValue(child.attrs, 'type') ?? '').toLowerCase();
        const name = attrValue(child.attrs, 'name');
        if (type !== 'hidden' && name) formFields.push(`name="${name}"`);
      }
      visit(child);
    }
    let cursor = node.innerStart;
    for (const child of node.children) {
      const between = textOf(html.slice(cursor, child.start));
      if (between) texts.push(between);
      cursor = child.end;
    }
    const tail = textOf(html.slice(cursor, node.innerEnd));
    if (tail) texts.push(tail);
  };
  visit(root);

  return {
    images: Array.from(new Set(images)),
    embeds: Array.from(new Set(embeds)),
    texts: Array.from(new Set(texts)),
    icons: Array.from(new Set(icons)),
    formFields: Array.from(new Set(formFields)),
  };
}

export interface TranspileCheck {
  ok: boolean;
  missingImages: string[];
  missingEmbeds: string[];
  missingTexts: string[];
  missingIcons: string[];
  missingFormFields: string[];
  expected: ExpectedContent;
}

/**
 * Did the rebuild keep everything?
 *
 * This is an equality check, not a similarity score, and that is only possible
 * because the transpiler copies rather than writes. The version of the rebuild
 * that asked a model to recreate the page had to settle for "85% of the text
 * survived" and could not check images at all — which is how a page shipped
 * missing four images and a video.
 */
export async function checkTranspile(sourceHtml: string, outHtml: string): Promise<TranspileCheck> {
  const expected = await expectedContent(sourceHtml);
  const outText = textOf(outHtml);

  const missingImages = expected.images.filter((u) => !outHtml.includes(u));
  const missingEmbeds = expected.embeds.filter((u) => !outHtml.includes(u));
  const missingTexts = expected.texts.filter((t) => !outText.includes(t));
  // Icons are copied out byte-for-byte (see copySubtree), but indent() then
  // re-pads every line of whatever row/col wrapper the icon lands inside —
  // including the icon's own internal newlines, since indent() has no idea
  // some of those newlines are part of an atomic, already-copied element
  // rather than a boundary it created. That only changes insignificant
  // inter-tag whitespace (never meaningful outside `<pre>`), so the check
  // has to be whitespace-normalized here too, or a perfectly-copied icon
  // reads as lost the moment it sits more than one wrapper deep.
  const outMarkup = canonicalizeMarkup(outHtml);
  const missingIcons = expected.icons.filter((svg) => !outMarkup.includes(canonicalizeMarkup(svg)));
  const missingFormFields = expected.formFields.filter((f) => !outHtml.includes(f));

  return {
    ok: missingImages.length === 0 && missingEmbeds.length === 0 && missingTexts.length === 0 &&
      missingIcons.length === 0 && missingFormFields.length === 0,
    missingImages,
    missingEmbeds,
    missingTexts,
    missingIcons,
    missingFormFields,
    expected,
  };
}

// ── Appearance verification ─────────────────────────────────────────────────

/**
 * The properties that decide whether a piece of text LOOKS like the original.
 *
 * Deliberately short. These five are what the eye reads first, they are all
 * inherited, and every one of them is copied rather than computed — so a
 * difference between source and rebuild is a bug in the copying, not a judgement
 * call about design.
 *
 * `line-height` is absent on purpose: the rebuild overrides bad ones (see
 * appearanceCss) and flow layout legitimately changes it.
 */
const COMPARED_PROPS = [
  'color', 'font-family', 'font-size', 'font-weight', 'text-transform',
] as const;

/**
 * Everything that makes a box LOOK like a box, read off the nearest ancestor
 * that is visually one. `width`/`height` are here too, even though the rest
 * of this file deliberately never copies them onto sections (a section's
 * width should come from its content, not a stale pixel snapshot) — a leaf
 * clickable element (a button, a link) is the one case where that reasoning
 * does not apply: it has no content-driven fallback size, so its real
 * dimensions ARE part of what "looks the same" means for it.
 */
const BOX_PROPS = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-radius',
  'border-width', 'border-color', 'border-style', 'width', 'height',
] as const;

type TextStyle = Partial<Record<(typeof COMPARED_PROPS)[number], string>> & {
  /**
   * The nearest real background colour this text visually sits on — not one of
   * COMPARED_PROPS because it isn't the text's own declaration, it's whichever
   * ancestor (including itself) actually painted a colour, since background
   * does not inherit in CSS. Text-only comparison missed this entirely: a card
   * that lost its navy background and turned white reported zero mismatches,
   * because every compared property (colour, font, size) was still on the text
   * itself and unchanged — only the box behind it was wrong.
   */
  bg?: string;
  /**
   * Same idea, for shape: the nearest ancestor with real padding or a real
   * border-radius (a button, a card) rather than the text's own element,
   * which is routinely a bare `<span>` with none of its own. A button whose
   * source sizing came entirely from padding, once dropped, silently
   * collapsed to hug its label with no mismatch ever reported — nothing
   * about the text itself (colour, font) changed, only the box around it.
   */
  box?: Partial<Record<(typeof BOX_PROPS)[number], string>>;
};

/**
 * Canonicalise a computed value so two equivalent renderings compare equal.
 *
 * Both sides being compared here came out of the SAME browser's
 * getComputedStyle, so they are normally already identical strings — this is
 * a safety net for the rare formatting difference (e.g. `rgba(x,x,x,1)` vs
 * `rgb(x,x,x)`), not a cascade to resolve. There is no `var(--x)` to
 * substitute any more: getComputedStyle already resolved every custom
 * property before these facts ever reached this file.
 */
function normaliseValue(value: string): string {
  const v = value.replace(/\s*!important\s*$/i, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const n = rgb[1].split(/[,/]/).map((p) => p.trim()).filter(Boolean);
    if (n.length >= 3) {
      const a = n[3];
      const opaque = a === undefined || a === '1' || a === '1.0' || a === '100%';
      return opaque ? `rgb(${n[0]},${n[1]},${n[2]})` : `rgba(${n[0]},${n[1]},${n[2]},${a})`;
    }
  }
  return v;
}

/**
 * How every run of text on a page is styled — read straight off the real
 * computed style of the element that owns it, inheritance already applied by
 * the browser.
 *
 * Keyed by the text itself, which is what lets a source page and its rebuild be
 * compared at all: the markup around a headline changes completely, the headline
 * does not. Text that appears twice with two different styles is dropped from the
 * map rather than guessed at — an ambiguous key would "repair" one of them wrongly.
 */
export async function resolveTextAppearance(html: string): Promise<Map<string, TextStyle>> {
  const { root, facts } = await renderPage(html);
  const found = new Map<string, TextStyle | null>();

  const record = (text: string, style: TextStyle) => {
    if (text.length < 2) return;
    const existing = found.get(text);
    if (existing === null) return;
    if (existing === undefined) { found.set(text, style); return; }
    for (const prop of COMPARED_PROPS) {
      if (existing[prop] !== style[prop]) { found.set(text, null); return; }
    }
    if (existing.bg !== style.bg) { found.set(text, null); return; }
    for (const prop of BOX_PROPS) {
      if (existing.box?.[prop] !== style.box?.[prop]) { found.set(text, null); return; }
    }
  };

  const styleOfNode = (node: Node): TextStyle => {
    const decls = node.parent === null ? (facts.get(-1) ?? {}) : styleOf(facts, node);
    const style: TextStyle = {};
    for (const prop of COMPARED_PROPS) {
      const raw = decls[prop];
      if (raw && usableValue(raw)) style[prop] = normaliseValue(raw);
    }
    return style;
  };

  /** The nearest real (non-transparent) background colour painted behind this node. */
  const backgroundOf = (node: Node): string => {
    for (let n: Node | null = node; n; n = n.parent) {
      const decls = n.parent === null ? (facts.get(-1) ?? {}) : styleOf(facts, n);
      const raw = decls['background-color'];
      if (raw && usableValue(raw) && !isTransparent(raw)) return normaliseValue(raw);
    }
    return '';
  };

  /** width/height are only meaningful for a leaf with no content-driven size. */
  const SIZED_LEAF_TAGS = new Set(['a', 'button', 'input']);

  /** The nearest ancestor (including this node) shaped like a real box. */
  const boxOf = (node: Node): TextStyle['box'] => {
    // A <select>'s own <option> list is rendered by the OS/browser, not by
    // any CSS on the page — comparing its "computed" padding/size compares
    // two different browsers' native dropdown chrome, not the source page.
    for (let a: Node | null = node; a; a = a.parent) {
      if (a.tag === 'option' || a.tag === 'select') return undefined;
    }
    for (let n: Node | null = node; n; n = n.parent) {
      const decls = n.parent === null ? (facts.get(-1) ?? {}) : styleOf(facts, n);
      const hasRealPadding = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
        .some((p) => (pixels(decls[p]) ?? 0) > 0);
      const hasRealRadius = (pixels(decls['border-radius']) ?? 0) > 0;
      if (!hasRealPadding && !hasRealRadius) continue;
      const box: Partial<Record<(typeof BOX_PROPS)[number], string>> = {};
      for (const prop of BOX_PROPS) {
        // A section/card's width legitimately differs from the source's fixed
        // pixel canvas once it is in flow — that is the rebuild working as
        // designed, not a fault. Only a clickable leaf has no content-driven
        // fallback size, so only there is comparing the raw number meaningful.
        if ((prop === 'width' || prop === 'height') && !SIZED_LEAF_TAGS.has(n.tag)) continue;
        const raw = decls[prop];
        if (raw && usableValue(raw)) box[prop] = normaliseValue(raw);
      }
      return box;
    }
    return undefined;
  };

  const visit = (node: Node) => {
    const own = { ...styleOfNode(node), bg: backgroundOf(node), box: boxOf(node) };
    let cursor = node.innerStart;
    for (const child of node.children) {
      const between = textOf(html.slice(cursor, child.start));
      if (between) record(between, own);
      cursor = child.end;
    }
    const tail = textOf(html.slice(cursor, node.innerEnd));
    if (tail) record(tail, own);

    for (const child of node.children) {
      if (isHidden(facts, child)) continue;
      visit(child);
    }
  };
  visit(root);

  const out = new Map<string, TextStyle>();
  found.forEach((style, text) => { if (style) out.set(text, style); });
  return out;
}

export interface AppearanceMismatch {
  text: string;
  prop: string;
  expected: string;
  actual: string;
}

export interface AppearanceCheck {
  ok: boolean;
  mismatches: AppearanceMismatch[];
  /** Runs of text compared on both sides. */
  compared: number;
}

/**
 * Does the rebuild LOOK like the source?
 *
 * The content check ({@link checkTranspile}) asks whether the words are present,
 * and a page can pass it while being unreadable: one over-matched stylesheet rule
 * repainted every heading on a real page as 12px grey small print, all 115 texts
 * intact, check green. This is the check that was missing. It resolves each run of
 * text on both sides — real computed style, inheritance included — and compares.
 *
 * Text the rebuild does not contain at all is not reported here — that is the
 * content check's job, and reporting it twice would bury the styling faults.
 */
export async function checkAppearance(sourceHtml: string, outHtml: string): Promise<AppearanceCheck> {
  const [source, out] = await Promise.all([
    resolveTextAppearance(sourceHtml),
    resolveTextAppearance(outHtml),
  ]);
  const mismatches: AppearanceMismatch[] = [];
  let compared = 0;

  source.forEach((want, text) => {
    const got = out.get(text);
    if (!got) return;
    compared++;
    for (const prop of COMPARED_PROPS) {
      const expected = want[prop];
      const actual = got[prop];
      if (expected === undefined) continue;
      if (expected !== actual) {
        mismatches.push({ text, prop, expected, actual: actual ?? '(unset)' });
      }
    }
    for (const prop of BOX_PROPS) {
      const expected = want.box?.[prop];
      if (expected === undefined) continue;
      const actual = got.box?.[prop];
      if (expected !== actual) {
        mismatches.push({ text, prop: `box.${prop}`, expected, actual: actual ?? '(unset)' });
      }
    }
    // Reported as a 'background-color' mismatch (a real KEEP_PROP, not the
    // internal 'bg' field) so the same repair loop that fixes colour/font
    // mismatches can force it back onto the text's own element too.
    if (want.bg && want.bg !== got.bg) {
      mismatches.push({ text, prop: 'background-color', expected: want.bg, actual: got.bg || '(unset)' });
    }
  });

  return { ok: mismatches.length === 0, mismatches, compared };
}

/**
 * Rebuild a coordinate page, then fix what the appearance check finds.
 *
 * A mismatch is not a reason to throw the page away. The check knows which run of
 * text is wrong and what it should have been — it resolved both sides to find out
 * — so the answer is to state the value explicitly on that element and build
 * again. Rejecting instead would leave the user with an untouched coordinate page
 * and a chat that cannot edit it, which is not an outcome, it is a dead end.
 *
 * Two repair passes: the first fixes the elements found, the second catches
 * anything the first shifted. Whatever remains is reported, not hidden.
 */
export async function rebuildCoordinatePage(html: string): Promise<{
  result: TranspileResult;
  appearance: AppearanceCheck;
  repairPasses: number;
}> {
  let result = await transpileCoordinatePage(html);
  let appearance = await checkAppearance(html, result.html);
  let passes = 0;

  const force = new Map<string, Record<string, string>>();
  while (!appearance.ok && passes < 2) {
    for (const m of appearance.mismatches) {
      // background-color and every `box.*` mismatch are reported as a proxy
      // for "the BOX around this text is wrong" (see checkAppearance), not
      // the text's own declaration — forcing one as an inline style on the
      // text itself paints/sizes only that text run's own line-wrapped shape,
      // which looks like a stray highlight or a squashed label, not a
      // corrected box. There is no single element here to safely restyle —
      // the box that should carry it may not even exist as one element any
      // more — so these stay reported mismatches for a human to look at, not
      // an auto-repair.
      if (m.prop === 'background-color' || m.prop.startsWith('box.')) continue;
      const entry = force.get(m.text) ?? {};
      entry[m.prop] = m.expected;
      force.set(m.text, entry);
    }
    passes++;
    result = await transpileCoordinatePage(html, force);
    appearance = await checkAppearance(html, result.html);
  }

  if (!appearance.ok) {
    result.warnings.push(
      `${appearance.mismatches.length} text style${appearance.mismatches.length === 1 ? '' : 's'} ` +
      'could not be matched exactly to the original.',
    );
  }
  return { result, appearance, repairPasses: passes };
}

/**
 * Rows of columns for one set of sibling boxes, used for a section's contents and
 * for nested groups alike.
 *
 * Three kinds of exporter noise are dropped here rather than passed on, because
 * markup nobody can read is markup nobody can edit — which is the point of the
 * rebuild:
 *
 *  - a chain of wrappers each holding exactly one positioned child collapses to
 *    the child, with the wrappers' appearance merged onto it;
 *  - a column whose contents came out empty is not emitted at all;
 *  - a row left with no columns is not emitted either.
 */
function emitRows(
  html: string,
  items: Boxed[],
  containerWidth: number,
  facts: Facts,
  book: StyleBook,
  copied: Copied,
  force: ReadonlyMap<string, Record<string, string>> | undefined,
): { html: string; rows: number } {
  const rows = groupRows(items);
  const out: string[] = [];
  let emitted = 0;
  // The natural (independently-computed) column units/gap of the previous
  // row, offered to this row below if it looks like the same pattern
  // repeated. See the note below on why a row cannot simply trust its own.
  let prevRowUnits: number[] | null = null;
  let prevRowGap: number | null = null;

  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    const gapAbove = prev
      ? Math.max(0, Math.round(
          Math.min(...row.map((r) => r.top)) -
          Math.max(...prev.map((r) => r.top + (r.height ?? 0))),
        ))
      : 0;
    const rowWidth = row.length > 1
      ? Math.max(...row.map((r) => r.left + (r.width ?? 0))) -
        Math.min(...row.map((r) => r.left))
      : containerWidth;
    const freshGap = row.length > 1 ? Math.min(columnGap(row), MAX_COLUMN_GAP_PX) : 0;

    // A number ("200+") and its label ("Projects Funded") are two separate
    // coordinate boxes on a real page — they don't vertically overlap, so
    // they land in two different rows here, each computing its OWN column
    // widths and gaps from its OWN (very different) text lengths: "200+" is
    // short, "Project Level Ltv Current Average" is not, so the two rows'
    // columns do not land in the same place even though they are visually
    // meant to be one pair per column. Same column count immediately below
    // the row that established the pattern is treated as that same repeated
    // pattern and reuses its column proportions AND gap instead of computing
    // its own — both, not just one, or the columns still drift apart across
    // a wide row even with matching proportions.
    const reusePattern = row.length > 1 && prev && prev.length === row.length && prevRowUnits !== null;
    const freshUnits = row.length > 1 ? row.map((box) => gridUnits(box.width, rowWidth)) : null;
    const rowUnits = reusePattern ? prevRowUnits : freshUnits;
    const gap = reusePattern && prevRowGap !== null ? prevRowGap : freshGap;
    prevRowUnits = freshUnits;
    prevRowGap = freshGap;

    // A row with exactly one box (a badge, a logo, a single button) is not
    // "this box IS the row" — `.sl-col { flex: 1 1 0 }` fills 100% of the row
    // width regardless of grid units when there is nothing beside it to share
    // space with, so forcing sl-g12 stretched every standalone narrow element
    // full-width. Real left/width from the source say whether it was actually
    // meant to fill the row or just sit somewhere in it — not a guess, the
    // numbers are already known.
    //
    // The real left offset itself is used directly as a margin, not bucketed
    // into flex-start/flex-end/center by how close it is to either edge. That
    // bucketing was its own guess — "close enough to an edge" decided by an
    // arbitrary tolerance — and it was wrong for exactly the shape of content
    // that doesn't sit near either edge: a right-column address block (real
    // left far past the middle, real right gap far short of it too) landed
    // dead center instead of at its own real offset. A margin equal to the
    // real gap reproduces any of the three cases as a special value of the
    // same number instead of needing to be told which bucket they're in.
    const single = row.length === 1 ? row[0] : null;
    const singleNarrow = single !== null && single.width !== null && single.width < containerWidth * 0.92;
    const singleMarginLeft = singleNarrow && single ? Math.max(0, Math.round(single.left)) : 0;

    const cols: string[] = [];
    for (let boxIndex = 0; boxIndex < row.length; boxIndex++) {
      const box = row[boxIndex];
      // Unwrap single-child wrapper chains, keeping every wrapper's appearance.
      const chain: Boxed[] = [box];
      let deepest = box;
      let nested = childItems(html, deepest.node, facts);
      while (nested.length === 1) {
        deepest = nested[0];
        chain.push(deepest);
        nested = childItems(html, deepest.node, facts);
      }

      for (const link of chain) {
        const id = attrValue(link.node.attrs, 'id');
        if (id && copied.section) copied.anchors.set(id, copied.section);
      }

      // Whether copySubtree will emit `deepest` as its own tag (a `<span>`, an
      // `<a>`...) with its own class, rather than just inlining its content.
      const deepestEmitsSelf = SEMANTIC_TAGS.has(deepest.node.tag);
      const body = nested.length > 0
        ? emitRows(html, nested, deepest.width ?? containerWidth, facts, book, copied, force).html
        : copySubtree(html, deepest.node, facts, book, copied, deepestEmitsSelf, force);

      // The gap between a container's own edge and its first/last row.
      //
      // emitRows below only ever spaces rows from ONE ANOTHER (`gapAbove`,
      // computed from the previous row's bottom) — the very first row has no
      // previous row to measure from, so the real distance from the
      // container's own top edge to its first bit of content was silently
      // discarded, and the same for the last row and the container's bottom
      // edge. A card whose real box was taller than its content (real
      // breathing room above a heading, or below a final button — ordinary
      // padding on any real page) rendered with its content flush against
      // both edges instead. `nested`, not the row-grouped output, is what
      // still has each item's original top/height at this point.
      let padTop = 0;
      let padBottom = 0;
      if (nested.length > 0) {
        const firstTop = Math.min(...nested.map((n) => n.top));
        padTop = Math.max(0, Math.min(Math.round(firstTop), MAX_ROW_GAP_PX));
        // Only from a height the container really declared — never from
        // `deepest.height`'s own effectiveHeight fallback. That fallback IS
        // "the bottom edge of these same children" (see effectiveHeight), so
        // comparing it back against `lastBottom` here is circular: the two
        // are usually near-identical by construction, and rounding/measuring
        // noise between them then reads as a real gap. A zero-height `<form>`
        // (or any other zero-height semantic wrapper) got a phantom
        // padding-bottom this way, on every single one across the page.
        const declaredHeight = pixels(deepest.decls.height);
        if (declaredHeight) {
          const lastBottom = Math.max(...nested.map((n) => n.top + (n.height ?? 0)));
          padBottom = Math.max(0, Math.min(Math.round(declaredHeight - lastBottom), MAX_ROW_GAP_PX));
        }
      }

      // Every wrapper's appearance merges onto the `.sl-col` div that replaces
      // them — except `deepest`'s own, when copySubtree already put it on the
      // tag it just emitted. Merging it a second time here duplicated the
      // exact same border/background onto both the wrapping column AND the
      // `<a>`/`<span>` inside it: two nested boxes with an identical outline,
      // which is what a real CTA button's border looked doubled up.
      const classChain = deepestEmitsSelf ? chain.slice(0, -1) : chain;
      const classes = classChain.map((l) => book.classFor(l.decls)).filter(Boolean);
      const photo = chain.find((l) => /url\(/i.test(l.decls['background-image'] ?? ''));
      if (!body.trim() && !photo) continue;

      const units = rowUnits ? rowUnits[boxIndex] : GRID_UNITS;
      const align = alignmentOf(deepest.decls) || alignmentOf(box.decls);
      // A photo carried as a CSS background has no content to give it a height,
      // so it keeps the one it had. min-height still lets the section grow.
      const minH = !body.trim() && photo?.height ? `min-height: ${photo.height}px` : '';
      const sizeDecl = singleNarrow && box.width
        ? `flex: 0 0 auto; width: ${Math.round(box.width)}px${singleMarginLeft ? `; margin-left: ${singleMarginLeft}px` : ''}`
        : '';
      const padDecl = [padTop ? `padding-top: ${padTop}px` : '', padBottom ? `padding-bottom: ${padBottom}px` : '']
        .filter(Boolean).join('; ');
      const style = [minH, sizeDecl, padDecl, align.replace(/^ style="|"$/g, '')].filter(Boolean).join('; ');
      const gridClass = singleNarrow ? '' : ` sl-g${units}`;
      cols.push(
        `<div class="sl-col${gridClass}${classes.length ? ` ${classes.join(' ')}` : ''}"${style ? ` style="${style}"` : ''}>\n` +
        `${indent(body, 2)}\n</div>`,
      );
    }

    if (cols.length === 0) return;
    emitted++;
    const rowStyle = [
      gapAbove > 0 ? `margin-top: ${Math.min(gapAbove, MAX_ROW_GAP_PX)}px` : '',
      gap > 0 ? `gap: ${gap}px` : '',
    ].filter(Boolean).join('; ');
    out.push(
      `<div class="sl-row"${rowStyle ? ` style="${rowStyle}"` : ''}>\n` +
      `${indent(cols.join('\n'), 2)}\n</div>`,
    );
  });

  return { html: out.join('\n'), rows: emitted };
}

/**
 * Re-point the page's own jump links at the sections their targets ended up in.
 *
 * Without this every `href="#lp-pom-box-840"` in the output is a dead link,
 * because the ids those hrefs name were dropped along with the rest of the
 * exporter's identity.
 */
function rewriteAnchors(
  html: string,
  anchors: Map<string, string>,
  sections: Set<string>,
): string {
  return html.replace(/href="#([^"]+)"/g, (whole, id: string) => {
    const section = anchors.get(id);
    if (section) return `href="#${section}"`;
    if (sections.has(id)) return whole;
    // The target was hidden on desktop, so it is not in the output — and it was
    // not reachable on the original desktop page either. Left as written it is a
    // link to an id that does not exist, which is worse than a link to the top.
    return 'href="#"';
  });
}

/** The real horizontal gap between columns, from their source positions. */
function columnGap(row: Boxed[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < row.length; i++) {
    const prev = row[i - 1];
    gaps.push(row[i].left - (prev.left + (prev.width ?? 0)));
  }
  const positive = gaps.filter((g) => g > 0);
  if (positive.length === 0) return 0;
  return Math.round(positive.reduce((a, b) => a + b, 0) / positive.length);
}

/** Keep a text box's alignment, which a flex column would otherwise reset. */
function alignmentOf(decls: Record<string, string>): string {
  const align = (decls['text-align'] ?? '').trim().toLowerCase();
  if (align === 'center') return ' style="text-align: center"';
  if (align === 'right') return ' style="text-align: right"';
  return '';
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => (line.trim() ? pad + line : line)).join('\n');
}

/** Collapses insignificant whitespace between tags so re-indented markup can
 *  still be compared for content equality. See the call site in checkTranspile. */
function canonicalizeMarkup(html: string): string {
  return html.replace(/>\s+</g, '><').trim();
}

/**
 * Page-level defaults: the body's own colours and font, plus a sane reset.
 *
 * Taken from the source body rather than invented, so a page whose text is
 * white on navy stays white on navy even where an element said nothing.
 */
/**
 * Page-level defaults: the body's own colours and font, plus a sane reset.
 *
 * No `:root` custom-property block here on purpose — a real browser already
 * resolved every `var(--x)` before these facts ever reached this file, so the
 * values in `decls` are the final colours/fonts themselves, not references.
 */
function baseCss(facts: Facts): string {
  const decls = facts.get(-1) ?? {};
  const own = appearanceCss(decls);
  return `*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; ${own} }
img { display: block; }
h1, h2, h3, h4, h5, h6, p { margin: 0; }
a { text-decoration: none; color: inherit; }`;
}

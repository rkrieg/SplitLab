/**
 * Pull a page's CONTENT out of its markup, by code, so it can be rebuilt.
 *
 * ── Why this is code and not a prompt ──────────────────────────────────────
 *
 * A page whose layout is pixel coordinates cannot be patched (see
 * ai-page-layout.ts) — the only safe way to make it editable is to rebuild it as
 * a flow-layout page. Rebuilding means the model writes new markup, and the one
 * thing that must not happen is the model *remembering* the old page's content:
 * that is how a rebuild quietly loses a phone number, changes a price, or
 * invents a testimonial that was never there.
 *
 * So nothing here asks a model anything. Every headline, paragraph, bullet,
 * button label, link, image, video embed, colour and font is lifted out of the
 * HTML by counting and string work, and handed to the builder as facts it is
 * told to reproduce verbatim. What the model contributes is layout and
 * structure, which is the part it is actually good at. Content fidelity ends up
 * near 100% because content never passes through a model's memory; layout is a
 * re-interpretation, and always will be.
 *
 * ── Reading a page that has no reading order ───────────────────────────────
 *
 * On a coordinate page, document order means nothing — an element's place on the
 * screen is its `top` in the stylesheet, so the markup can list the footer
 * before the hero. Reading order is therefore recovered by ADDING UP the `top`
 * offsets down each element's ancestor chain and sorting by the result. On an
 * ordinary flow page every `top` is absent, every y is 0, and the sort falls
 * back to document order — which is the correct answer there.
 *
 * Content is grouped into BANDS: one band per top-level block of the page. That
 * matches how a landing page reads (a stack of horizontal sections) and it is
 * also what the original builder produced, so band order is section order.
 *
 * Dependency-free apart from the stylesheet reader it shares with
 * ai-page-layout.ts — deliberately the same one, so "where does this element
 * sit" is answered identically by the test that decides to rebuild and by the
 * code that does the rebuilding.
 */

import {
  readStyleFacts,
  declarationsFor,
  pixels,
  pageBlocks,
  type StyleFacts,
} from './ai-page-layout';

export type TextRole = 'heading' | 'subheading' | 'body' | 'bullet' | 'button' | 'label';

export interface ExtractedText {
  text: string;
  role: TextRole;
  /** Present on buttons and links. */
  href?: string;
  /** Declared font size in px, when the stylesheet gave one. Used to rank. */
  fontPx?: number;
}

export interface ExtractedImage {
  src: string;
  alt?: string;
}

export interface ExtractedBand {
  /** A name taken from what the block already calls itself, else band-N. */
  name: string;
  /** Recovered screen position. Ties break on document order. */
  y: number;
  background?: string;
  texts: ExtractedText[];
  images: ExtractedImage[];
  /** iframe/video sources — the embeds a rebuild must not silently drop. */
  embeds: string[];
}

export interface ExtractedPage {
  title?: string;
  metaDescription?: string;
  /** Font families the page actually used, most-used first. */
  fonts: string[];
  colors: { background?: string; text?: string; accents: string[] };
  logoUrl?: string;
  bands: ExtractedBand[];
  stats: {
    bands: number;
    headings: number;
    texts: number;
    buttons: number;
    images: number;
    embeds: number;
    links: number;
  };
}

// ── What counts as a piece of content ───────────────────────────────────────

/** Elements whose text is a content item in its own right. */
const TEXT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'a', 'button', 'blockquote', 'figcaption', 'label',
  'td', 'th', 'dt', 'dd', 'summary', 'legend', 'caption',
]);

/**
 * Containers that hold text directly, with no TEXT_TAGS inside.
 *
 * Unbounce and Figma exports write headlines as a bare
 * `<div class="lp-pom-text">…</div>`, so restricting to the semantic tags above
 * would read those pages as having no content at all.
 */
const LOOSE_TEXT_TAGS = new Set(['div', 'span', 'strong', 'em', 'b', 'i', 'section', 'header', 'footer', 'nav']);

/** Contents are not markup and must never be read as content. */
const OPAQUE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** A loose container bigger than this is a section, not a piece of text. */
const MAX_LOOSE_TEXT_BYTES = 4000;

/**
 * A band this crowded is really several sections, so it gets split at its widest
 * vertical gaps. One top-level block routinely holds the whole hero area of a
 * coordinate page — 200 items in a single "section" is not something a builder
 * can lay out, and 200 sections of one item each is worse.
 */
const MAX_BAND_ITEMS = 12;

/**
 * Two bands starting within this many pixels of each other are the same row.
 *
 * A card grid on a coordinate page is four absolutely-positioned columns at the
 * same top offset, which arrive here as four separate bands. Left unmerged the
 * rebuilt page stacks them as four full-width sections.
 */
const SAME_ROW_PX = 24;

/** Longer than this is a paragraph, however it was tagged. */
const MAX_BUTTON_CHARS = 40;

/** Longer than this and it is not a heading, whatever its font size says. */
const MAX_HEADING_CHARS = 200;

// ── Text ────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…',
  trade: '™', copy: '©', reg: '®', deg: '°',
  bull: '•', middot: '·', times: '×', euro: '€', pound: '£',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/**
 * Visible text of a fragment.
 *
 * Tags become spaces rather than vanishing: deleting a `<br>` or an inline
 * `</span><span>` boundary with nothing glues the words on either side together
 * ("Leads.Real Jobs." instead of "Leads. Real Jobs."), and that mangled string
 * is then what the rebuilt page says.
 */
function visibleText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The visible text of a whole page, normalised the same way extracted content is.
 *
 * Exported because "is this string really on that page?" has to be asked with
 * ONE normalisation on both sides. Asking it with two — the extractor decoding
 * `&ndash;` to an en dash while the checker left it encoded — reports content as
 * missing when it is there, which on the rebuild path means throwing away a
 * perfectly good rebuild.
 */
export function pageVisibleText(html: string): string {
  return visibleText(html);
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v === undefined ? undefined : decodeEntities(v).trim();
}

/** A 1×1 spacer or blank placeholder, not the image the page shows. */
function isPlaceholderSrc(src: string): boolean {
  if (!src.startsWith('data:')) return false;
  // Lazy-loaders inline a tiny transparent GIF/PNG/SVG until the real file
  // loads. A real inlined photo is thousands of characters; these are ~70.
  return src.length < 300;
}

/**
 * The image an <img> actually shows.
 *
 * `src` is not always it. Lazy-loading — which Unbounce, Instapage and most
 * exporters use — puts a 70-byte transparent GIF in `src` and the real file in
 * `data-src`. Reading `src` alone dropped two thirds of the images off a real
 * page and made a 1×1 spacer the brand logo.
 */
function imageSrc(attrs: string): string | undefined {
  const src = attr(attrs, 'src');
  if (src && !isPlaceholderSrc(src)) return src;

  // Every lazy-loader invents its own attribute name — data-src, data-lazy-src,
  // data-original, and the real page that prompted this used
  // `data-src-desktop-1x` / `data-src-mobile-1x`. Rather than keep a list of
  // builders' spellings, take any data-* attribute whose VALUE is an image URL.
  const candidates: Array<{ name: string; value: string }> = [];
  const re = /\b(data-[a-z0-9-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs))) {
    const value = decodeEntities((m[2] ?? m[3] ?? '').trim());
    if (looksLikeImageUrl(value)) candidates.push({ name: m[1].toLowerCase(), value });
  }
  if (candidates.length > 0) {
    // Several resolutions are normal; the desktop one is the page's real image.
    const desktop = candidates.find((c) => c.name.includes('desktop'));
    return (desktop ?? candidates[0]).value;
  }

  const srcset = attr(attrs, 'srcset') ?? attr(attrs, 'data-srcset');
  if (srcset) {
    // "a.jpg 1x, b.jpg 2x" — the first entry is the base image.
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (first) return first;
  }
  return undefined;
}

function looksLikeImageUrl(value: string): boolean {
  if (!value || value.length > 600 || /\s/.test(value)) return false;
  if (value.startsWith('data:')) return false;
  return /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(value);
}

/** A kebab-case name from an element's own class or id. */
function nameFor(attrs: string, fallback: string): string {
  const cls = attr(attrs, 'class')?.split(/\s+/)[0];
  const id = attr(attrs, 'id');
  for (const candidate of [cls, id]) {
    const clean = (candidate ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (clean && /^[a-z0-9][a-z0-9_-]*$/.test(clean)) return clean;
  }
  return fallback;
}

// ── Colour ──────────────────────────────────────────────────────────────────

/** First colour in a CSS value, normalised to #rrggbb, or null. */
function colorOf(value: string | undefined): string | null {
  if (!value) return null;
  const hex = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i.exec(value);
  if (hex) {
    const h = hex[1];
    return ('#' + (h.length === 3 ? h.split('').map((c) => c + c).join('') : h)).toLowerCase();
  }
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(value);
  if (rgb) {
    // Fully transparent is not a colour anyone chose to see.
    if (rgb[4] !== undefined && parseFloat(rgb[4]) === 0) return null;
    const to2 = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return ('#' + to2(rgb[1]) + to2(rgb[2]) + to2(rgb[3])).toLowerCase();
  }
  return null;
}

/** Black, white and greys are backgrounds and body text, not brand accents. */
function isAccentColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min > 24;
}

/** Font families as written, minus quotes and fallbacks. */
function fontFamilyOf(value: string | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (!first) return null;
  if (/^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(first)) return null;
  // `font-family: var(--font-heading)` names a variable, not a typeface. Passing
  // it on would tell the builder to use a font called "var(--font-heading)".
  if (/^var\s*\(/i.test(first)) return null;
  return first;
}

/**
 * Hidden by CSS, so not part of what the page shows.
 *
 * This one matters more than it looks. Unbounce (and every other
 * breakpoint-based exporter) ships the SAME content twice — once for desktop,
 * once for mobile — and hides one copy with `display: none` per media query.
 * Without this check the extraction reads every headline, price and CTA twice,
 * and the rebuilt page shows both.
 */
function isHidden(decls: Record<string, string>): boolean {
  const display = (decls.display ?? '').toLowerCase();
  if (display === 'none') return true;
  const visibility = (decls.visibility ?? '').toLowerCase();
  return visibility === 'hidden' || visibility === 'collapse';
}

// ── The walk ────────────────────────────────────────────────────────────────

interface OpenElement {
  tag: string;
  /** Recovered screen position: this element's top plus its ancestors'. */
  y: number;
  /** True when this element or an ancestor is hidden by CSS. */
  hidden: boolean;
}

/** One piece of content, before it has been grouped into a band. */
interface Item {
  kind: 'text' | 'image' | 'embed';
  y: number;
  /** Document order, the tie-break for equal y. */
  doc: number;
  /** Which top-level block it came from. */
  block: number;
  text?: string;
  role?: TextRole;
  href?: string;
  fontPx?: number;
  src?: string;
  alt?: string;
}

/** End of the element opened at `openEnd`, or null when tags do not balance. */
function elementEnd(html: string, tag: string, openEnd: number): number | null {
  const scan = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}\\s*>`, 'gi');
  scan.lastIndex = openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(html))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else if (m[1] !== '/') {
      depth++;
    }
  }
  return null;
}

/**
 * Turn a flat list of content into the page's sections, in reading order.
 *
 * Two rules, in this order:
 *
 *   1. One band per top-level block. That is how the section map cuts the page
 *      up (see pageBlocks), so the rebuilt page's sections line up with the
 *      sections the original had.
 *
 *   2. A block holding more than MAX_BAND_ITEMS pieces of content is split at
 *      its widest vertical gaps. On a coordinate page one block routinely holds
 *      the entire hero area — the real Unbounce page put 200+ items in a single
 *      `<div class="lp-positioned-content">` — and handing a builder one section
 *      with 200 items in it produces one wall of text.
 *
 * Bands are then ordered by recovered screen position, ties broken on document
 * order. On a flow page every y is 0, so that is exactly document order.
 */
function groupIntoBands(
  items: Item[],
  blocks: Array<{ tag: string; attrs: string }>,
  blockDecls: Array<Record<string, string>>,
): ExtractedBand[] {
  if (items.length === 0) return [];

  const byBlock = new Map<number, Item[]>();
  for (const item of items) {
    const list = byBlock.get(item.block);
    if (list) list.push(item);
    else byBlock.set(item.block, [item]);
  }

  const bands: ExtractedBand[] = [];
  const blockKeys = Array.from(byBlock.keys());
  for (const blockIndex of blockKeys) {
    const group = byBlock.get(blockIndex)!.slice().sort((a, b) => (a.y - b.y) || (a.doc - b.doc));
    const decls = blockIndex >= 0 ? blockDecls[blockIndex] ?? {} : {};
    const background =
      colorOf(decls['background-color']) ?? colorOf(decls.background) ?? undefined;
    const baseName =
      blockIndex >= 0 && blocks[blockIndex]
        ? nameFor(blocks[blockIndex].attrs, `band-${blockIndex + 1}`)
        : 'page';

    // Cut at the widest vertical gaps until no part is over the cap. Cutting at
    // the WIDEST gap rather than every N items keeps the split on a real visual
    // boundary instead of an arbitrary count.
    const parts: Item[][] = [group];
    // Only a coordinate-placed group gets split. On a flow page the block IS the
    // section — our own builder writes sections with twenty items in them quite
    // happily — and there are no offsets to cut on, so splitting would just be an
    // arbitrary chop through the middle of somebody's section.
    const groupUsesCoordinates = group.some((i) => i.y > 0);
    while (groupUsesCoordinates && parts.some((p) => p.length > MAX_BAND_ITEMS)) {
      const idx = parts.findIndex((p) => p.length > MAX_BAND_ITEMS);
      const part = parts[idx];
      let cutAt = -1;
      let widest = -1;
      for (let i = 1; i < part.length; i++) {
        const gap = part[i].y - part[i - 1].y;
        if (gap > widest) { widest = gap; cutAt = i; }
      }
      // Every item at the same y (a flow page, or one absolute container) — no
      // visual boundary to cut on, so fall back to an even split.
      if (cutAt <= 0 || widest <= 0) cutAt = Math.ceil(part.length / 2);
      parts.splice(idx, 1, part.slice(0, cutAt), part.slice(cutAt));
    }

    parts.forEach((part, i) => {
      if (part.length === 0) return;
      const band: ExtractedBand & { block?: number } = {
        name: parts.length > 1 ? `${baseName}-${i + 1}` : baseName,
        y: part[0].y,
        block: blockIndex,
        ...(background ? { background } : {}),
        texts: [],
        images: [],
        embeds: [],
      };
      // Per BAND, not per page: a phone number legitimately repeats in the
      // header and the footer, and dropping the second one loses real content.
      const seen = new Set<string>();
      for (const item of part) {
        if (item.kind === 'text' && item.text && item.role) {
          const key = item.role + ' ' + item.text.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          band.texts.push({
            text: item.text,
            role: item.role,
            ...(item.href ? { href: item.href } : {}),
            ...(item.fontPx !== undefined ? { fontPx: item.fontPx } : {}),
          });
        } else if (item.kind === 'image' && item.src) {
          if (!band.images.some((i2) => i2.src === item.src)) {
            band.images.push({ src: item.src, ...(item.alt ? { alt: item.alt } : {}) });
          }
        } else if (item.kind === 'embed' && item.src) {
          if (!band.embeds.includes(item.src)) band.embeds.push(item.src);
        }
      }
      if (band.texts.length > 0 || band.images.length > 0 || band.embeds.length > 0) bands.push(band);
    });
  }

  // Reading order. The doc index of each band's first item is the tie-break, so
  // a page that never used coordinates comes out in document order.
  const sorted = bands
    .map((band, index) => ({ band, index }))
    .sort((a, b) => (a.band.y - b.band.y) || (a.index - b.index))
    .map(({ band }) => band);

  // Bands at the same height are columns of one row, not sections stacked on
  // each other — a four-across card grid arrives here as four bands all at
  // y=3273. Merged, they become the one section a reader sees.
  //
  // Both bands must have a real offset. On a flow page every y is 0 because
  // nothing was positioned, NOT because everything is side by side — merging on
  // that basis collapsed an eleven-section page down to five. Requiring y > 0 on
  // both sides is also why a stray decorative absolute element on an otherwise
  // ordinary page cannot trigger it.
  const merged: ExtractedBand[] = [];
  for (const band of sorted) {
    const last = merged[merged.length - 1];
    const sameRow =
      last !== undefined &&
      last.y > 0 &&
      band.y > 0 &&
      Math.abs(band.y - last.y) <= SAME_ROW_PX &&
      last.texts.length + band.texts.length <= MAX_BAND_ITEMS * 2;
    if (!sameRow) {
      merged.push(band);
      continue;
    }
    for (const t of band.texts) {
      if (!last.texts.some((e) => e.role === t.role && e.text === t.text)) last.texts.push(t);
    }
    for (const i of band.images) if (!last.images.some((e) => e.src === i.src)) last.images.push(i);
    for (const e of band.embeds) if (!last.embeds.includes(e)) last.embeds.push(e);
  }
  return merged;
}

/**
 * Everything on the page, in the order a visitor reads it.
 *
 * Pure. No AI, no network, same answer every time.
 */
export function extractPageContent(html: string): ExtractedPage {
  const empty: ExtractedPage = {
    fonts: [],
    colors: { accents: [] },
    bands: [],
    stats: { bands: 0, headings: 0, texts: 0, buttons: 0, images: 0, embeds: 0, links: 0 },
  };
  if (!html || html.length < 40) return empty;

  const facts: StyleFacts = readStyleFacts(html);

  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const bodyFrom = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const bodyCloseIdx = html.toLowerCase().lastIndexOf('</body>');
  const bodyTo = bodyCloseIdx > bodyFrom ? bodyCloseIdx : html.length;

  // Top-level blocks, so content is grouped the way the section map is.
  const blocks = pageBlocks(html);
  const blockDecls = blocks.map((b) => declarationsFor(facts, b.tag, b.attrs));
  const blockOf = (offset: number): number => {
    for (let i = 0; i < blocks.length; i++) {
      if (offset >= blocks[i].start && offset < blocks[i].end) return i;
    }
    return -1;
  };

  const items: Item[] = [];
  const fontCounts = new Map<string, number>();
  const accentCounts = new Map<string, number>();
  let logoUrl: string | undefined;
  let frameBackground: string | undefined;
  let doc = 0;

  const stack: OpenElement[] = [];
  const parent = (): OpenElement | undefined => stack[stack.length - 1];

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  tagRe.lastIndex = bodyFrom;
  let m: RegExpExecArray | null;

  // Commented-out markup is not on the page. `<!--` never matches the tag regex
  // itself, so without this the `<h1>` inside `<!-- <h1>old headline</h1> -->`
  // is read as a real heading — and uploaded HTML is full of commented-out
  // markup, including the SL markers we add ourselves.
  let commentAt = html.indexOf('<!--', bodyFrom);

  while ((m = tagRe.exec(html))) {
    if (m.index >= bodyTo) break;

    let insideComment = false;
    while (commentAt !== -1 && commentAt < m.index) {
      const commentEnd = html.indexOf('-->', commentAt);
      if (commentEnd === -1) { insideComment = true; break; }
      if (commentEnd + 3 > m.index) {
        // This match is inside the comment — resume scanning after it.
        tagRe.lastIndex = commentEnd + 3;
        commentAt = html.indexOf('<!--', commentEnd + 3);
        insideComment = true;
        break;
      }
      commentAt = html.indexOf('<!--', commentEnd + 3);
    }
    if (insideComment) continue;

    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const isClose = m[0][1] === '/';
    const selfClosing = /\/\s*$/.test(attrs);

    if (isClose) {
      // Pop to the matching open tag. Uploaded HTML is not always balanced, and
      // unwinding the whole stack on one stray </div> would throw away the
      // position and hidden-ness of everything still open.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (OPAQUE_TAGS.has(tag)) {
      const end = elementEnd(html, tag, m.index + m[0].length);
      tagRe.lastIndex = end ?? m.index + m[0].length;
      continue;
    }

    const decls = declarationsFor(facts, tag, attrs);
    const hidden = (parent()?.hidden ?? false) || isHidden(decls);
    const y = (parent()?.y ?? 0) + (pixels(decls.top) ?? 0);
    const block = blockOf(m.index);

    if (tag === 'img') {
      const src = imageSrc(attrs);
      if (src && !hidden) {
        items.push({ kind: 'image', y, doc: doc++, block, src, alt: attr(attrs, 'alt') });
        if (!logoUrl && /logo/i.test(attrs)) logoUrl = src;
      }
      continue;
    }

    if (tag === 'iframe' || tag === 'video') {
      const src = attr(attrs, 'src') ?? attr(attrs, 'data-src');
      if (src && !hidden) items.push({ kind: 'embed', y, doc: doc++, block, src });
      if (tag === 'iframe') continue;
    }

    if (VOID_TAGS.has(tag) || selfClosing) continue;

    const innerEndGuess = elementEnd(html, tag, m.index + m[0].length);
    const inner =
      innerEndGuess === null
        ? ''
        : html.slice(m.index + m[0].length, Math.max(m.index + m[0].length, innerEndGuess - tag.length - 3));

    // Fonts and accent colours, gathered from wherever they were declared.
    // Hidden elements still count here: a breakpoint copy of a headline carries
    // the same brand colours as the copy that is on screen.
    const family = fontFamilyOf(decls['font-family']);
    if (family) fontCounts.set(family, (fontCounts.get(family) ?? 0) + 1);
    const bg = colorOf(decls['background-color']) ?? colorOf(decls.background);
    // The page's own background is usually declared on the frame element rather
    // than on <body> — Unbounce puts it on `#lp-pom-root`. Without this the
    // rebuilt page comes out on whatever background the builder felt like.
    if (bg && frameBackground === undefined && stack.length <= 2) frameBackground = bg;
    if (bg && isAccentColor(bg)) accentCounts.set(bg, (accentCounts.get(bg) ?? 0) + 1);
    const fg = colorOf(decls.color);
    if (fg && isAccentColor(fg)) accentCounts.set(fg, (accentCounts.get(fg) ?? 0) + 1);

    const fontPx = pixels(decls['font-size']) ?? undefined;
    // Hidden content is not content. Breakpoint-based exporters ship the same
    // headline twice and hide one copy per media query, so reading it would put
    // every headline, price and CTA on the rebuilt page twice.
    const text = hidden ? '' : visibleText(inner);

    if (text) {
      const isTextTag = TEXT_TAGS.has(tag);
      // A loose container only counts when the text is ITS text — otherwise the
      // same sentence would be recorded again for every wrapper around it.
      const isLooseLeaf =
        !isTextTag &&
        LOOSE_TEXT_TAGS.has(tag) &&
        inner.length <= MAX_LOOSE_TEXT_BYTES &&
        !/<(?:h[1-6]|p|li|a|button|blockquote|figcaption|label|td|th|dt|dd|summary|legend|caption)\b/i.test(inner);

      if (isTextTag || isLooseLeaf) {
        const href = tag === 'a' ? attr(attrs, 'href') : undefined;
        let role: TextRole;
        if (tag === 'li' || tag === 'dd' || tag === 'dt') role = 'bullet';
        else if ((tag === 'a' || tag === 'button') && text.length <= MAX_BUTTON_CHARS) role = 'button';
        else if (/^h[1-3]$/.test(tag)) role = 'heading';
        else if (/^h[4-6]$/.test(tag)) role = 'subheading';
        else role = 'body';
        items.push({
          kind: 'text', y, doc: doc++, block, text, role,
          ...(href ? { href } : {}),
          ...(fontPx !== undefined ? { fontPx } : {}),
        });
      }
    }

    stack.push({ tag, y, hidden });
  }

  // ── Page-level facts ─────────────────────────────────────────────────────

  const ordered = groupIntoBands(items, blocks, blockDecls);

  const bodyDecls = bodyOpen ? declarationsFor(facts, 'body', bodyOpen[0]) : {};
  const background =
    colorOf(bodyDecls['background-color']) ??
    colorOf(bodyDecls.background) ??
    frameBackground ??
    ordered.find((b) => b.background)?.background ??
    undefined;
  const textColor = colorOf(bodyDecls.color) ?? undefined;

  const fonts = Array.from(fontCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([f]) => f);
  const accents = Array.from(accentCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([c]) => c);

  // One heading per band, promoting the biggest text when nothing was tagged as
  // one — Unbounce writes every headline as a plain div, so without this a
  // rebuilt page would have no headings at all.
  // The same words must not appear twice in one section. Uploaded markup nests
  // the same string at several levels (a positioned wrapper, an inner heading,
  // a styled span), and the roles differ enough that the per-role dedupe during
  // grouping lets a pair through — which showed up in the content dump as the
  // same headline handed over as both an <h2> and a <p>, so the rebuilt page
  // said it twice.
  const ROLE_RANK: Record<TextRole, number> = {
    button: 0, heading: 1, subheading: 2, bullet: 3, label: 4, body: 5,
  };
  for (const band of ordered) {
    const best = new Map<string, ExtractedText>();
    for (const t of band.texts) {
      const key = t.text.toLowerCase();
      const held = best.get(key);
      if (!held || ROLE_RANK[t.role] < ROLE_RANK[held.role]) best.set(key, t);
    }
    if (best.size !== band.texts.length) {
      band.texts = band.texts.filter((t) => best.get(t.text.toLowerCase()) === t);
    }
  }

  for (const band of ordered) {
    if (band.texts.some((t) => t.role === 'heading')) continue;
    const candidates = band.texts.filter(
      (t) => t.role === 'body' && t.text.length <= MAX_HEADING_CHARS,
    );
    if (candidates.length === 0) continue;
    let best = candidates[0];
    for (const c of candidates) {
      const cSize = c.fontPx ?? 0;
      const bSize = best.fontPx ?? 0;
      if (cSize > bSize || (cSize === bSize && c.text.length > best.text.length && bSize === 0)) best = c;
    }
    best.role = 'heading';
  }

  if (!logoUrl) logoUrl = ordered[0]?.images[0]?.src;

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const descMatch = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(html);

  const texts = ordered.reduce((n, b) => n + b.texts.length, 0);
  return {
    title: titleMatch ? visibleText(titleMatch[1]) || undefined : undefined,
    metaDescription: descMatch ? attr(descMatch[0], 'content') : undefined,
    fonts,
    colors: { background, text: textColor, accents },
    logoUrl,
    bands: ordered,
    stats: {
      bands: ordered.length,
      headings: ordered.reduce((n, b) => n + b.texts.filter((t) => t.role === 'heading').length, 0),
      texts,
      buttons: ordered.reduce((n, b) => n + b.texts.filter((t) => t.role === 'button').length, 0),
      images: ordered.reduce((n, b) => n + b.images.length, 0),
      embeds: ordered.reduce((n, b) => n + b.embeds.length, 0),
      links: ordered.reduce((n, b) => n + b.texts.filter((t) => t.href).length, 0),
    },
  };
}

// ── Handing it to the builder ───────────────────────────────────────────────

function looksLikeFooter(band: ExtractedBand): boolean {
  if (/footer/i.test(band.name)) return true;
  return band.texts.some((t) => /©|\ba\.?\s*rights reserved\b|all rights reserved/i.test(t.text));
}

function looksLikeNav(band: ExtractedBand, isFirst: boolean): boolean {
  if (/^(nav|navbar|header|top-?bar|menu)/i.test(band.name)) return true;
  if (!isFirst) return false;
  const links = band.texts.filter((t) => t.role === 'button' && t.href);
  return links.length >= 2 && band.texts.every((t) => t.text.length <= MAX_BUTTON_CHARS);
}

/**
 * The extraction as a schema the page builder already understands.
 *
 * Shape follows the create path (see pages/generate's "Schema structure"):
 * hero + sections[] + footer, so the rebuilt page gets the same click-to-edit
 * data-field paths as any page we generate ourselves.
 */
export function extractedPageToSchema(page: ExtractedPage): Record<string, unknown> {
  const bands = page.bands.slice();
  const schema: Record<string, unknown> = {
    vertical: 'rebuilt from an uploaded page — keep the original copy',
  };
  if (page.title) schema.business_name = page.title.split(/[|–—-]/)[0].trim() || page.title;
  if (page.logoUrl) schema.brand_logo_url = page.logoUrl;
  if (page.metaDescription) schema.meta_description = page.metaDescription;

  // Nav off the front, footer off the back, before anything becomes the hero.
  //
  // A logo strip is a nav even with no links in it: the real page starts with a
  // band holding nothing but the logo image, and letting that become the hero
  // produced a hero whose headline was the browser title and whose "photo" was
  // the logo.
  while (bands.length > 1 && (looksLikeNav(bands[0], true) || bands[0].texts.length === 0)) {
    const nav = bands.shift()!;
    const links = nav.texts.filter((t) => t.role === 'button');
    if (!schema.brand_logo_url && nav.images[0]) schema.brand_logo_url = nav.images[0].src;
    if (links.length > 0 || !schema.nav) {
      schema.nav = { links: links.map((t) => ({ label: t.text, url: t.href ?? '#' })) };
    }
    if (nav.texts.length > 0) break;
  }
  if (bands.length > 1 && looksLikeFooter(bands[bands.length - 1])) {
    const footer = bands.pop()!;
    const copyright = footer.texts.find((t) => /©|all rights reserved/i.test(t.text));
    schema.footer = {
      copyright: copyright?.text ?? footer.texts[0]?.text ?? '',
      links: footer.texts.filter((t) => t.href && t !== copyright).map((t) => t.text),
    };
  }

  const bandToSection = (band: ExtractedBand): Record<string, unknown> => {
    const heading = band.texts.find((t) => t.role === 'heading');
    const sub = band.texts.find((t) => t.role === 'subheading');
    const body = band.texts.filter((t) => t.role === 'body').map((t) => t.text);
    const bullets = band.texts.filter((t) => t.role === 'bullet').map((t) => t.text);
    const buttons = band.texts.filter((t) => t.role === 'button');
    const out: Record<string, unknown> = { type: band.name };
    if (heading) out.headline = heading.text;
    if (sub) out.subhead = sub.text;
    if (body.length > 0) out.body = body;
    if (bullets.length > 0) out.items = bullets;
    if (buttons.length > 0) {
      out.cta_text = buttons[0].text;
      out.cta_url = buttons[0].href ?? '#';
      if (buttons.length > 1) {
        out.links = buttons.slice(1).map((b) => ({ label: b.text, url: b.href ?? '#' }));
      }
    }
    if (band.images.length > 0) out.image = band.images[0].src;
    if (band.images.length > 1) out.images = band.images.slice(1).map((i) => i.src);
    if (band.embeds.length > 0) out.embed_url = band.embeds[0];
    if (band.background) out.background = band.background;
    return out;
  };

  const first = bands.shift();
  if (first) {
    const hero = bandToSection(first);
    schema.hero = {
      headline: hero.headline ?? page.title ?? '',
      ...(hero.subhead ? { subhead: hero.subhead } : {}),
      ...(hero.body ? { body: hero.body } : {}),
      ...(hero.cta_text ? { cta_text: hero.cta_text, cta_url: hero.cta_url } : {}),
      ...(hero.image ? { image: hero.image } : {}),
      ...(hero.embed_url ? { embed_url: hero.embed_url } : {}),
    };
  }
  schema.sections = bands.map(bandToSection);
  return schema;
}

// styleTokensFrom() and contentDumpFrom() used to live here.
//
// They turned an uploaded page into two prompt blocks — "here are the real
// colours and fonts, use them exactly" and "here is the copy in reading order,
// don't invent anything" — and handed them to the page builder so a model could
// rebuild the page. That approach is gone. A model asked to recreate a page makes
// choices, and it made them: it invented a palette, changed the typeface, dropped
// four images and a video, and added copy that was never there. The rebuild now
// copies values out of the page's own stylesheet instead (ai-page-transpile.ts),
// so there is nothing to describe to anybody. Removed rather than left unused,
// because their existence invites putting the model back in that seat.

/**
 * Every piece of content that must survive the rebuild, for checking afterwards.
 *
 * The builder is told to reproduce the content verbatim; this is how we find out
 * whether it did, instead of taking its word for it.
 */
export function requiredContentOf(page: ExtractedPage): {
  texts: string[];
  images: string[];
  embeds: string[];
} {
  const texts: string[] = [];
  for (const band of page.bands) {
    for (const t of band.texts) {
      // Short labels ("Home", "×") match by accident and prove nothing.
      if (t.text.length >= 12) texts.push(t.text);
    }
  }
  return {
    texts,
    images: page.bands.flatMap((b) => b.images.map((i) => i.src)),
    embeds: page.bands.flatMap((b) => b.embeds),
  };
}

/** How much of the required content is actually on the rebuilt page. */
export function contentSurvival(
  rebuiltHtml: string,
  required: { texts: string[]; images: string[]; embeds: string[] },
): { textsFound: number; textsTotal: number; missingTexts: string[]; missingImages: string[]; missingEmbeds: string[] } {
  const haystack = visibleText(rebuiltHtml).toLowerCase();
  const missingTexts: string[] = [];
  let textsFound = 0;
  for (const t of required.texts) {
    if (haystack.includes(t.toLowerCase())) textsFound++;
    else missingTexts.push(t);
  }
  return {
    textsFound,
    textsTotal: required.texts.length,
    missingTexts,
    missingImages: required.images.filter((src) => !rebuiltHtml.includes(src)),
    missingEmbeds: required.embeds.filter((src) => !rebuiltHtml.includes(src)),
  };
}

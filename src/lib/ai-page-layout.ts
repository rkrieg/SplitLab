/**
 * Is this page's layout defined by its MARKUP, or by pixel COORDINATES?
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Every AI edit in this app works the same way: hand the model one section's
 * HTML, take back a new version, splice it in. That only works if moving
 * markup moves the page.
 *
 * A real failure, on an Unbounce export: the user asked to redesign the hero.
 * We handed over a section, got back a clean new hero, spliced it in, and said
 * "Done!". On screen the new hero landed UNDERNEATH the old one — both visible,
 * overlapping. The reason was in the head stylesheet, which no scoped edit ever
 * sees:
 *
 *     #lp-pom-root    { min-width: 1326px; height: 5713px; }
 *     #lp-pom-box-28  { position: absolute; left: 34px;  top: 3777px; … }
 *     #lp-pom-text-29 { position: absolute; left: 299px; top: 16px;   … }
 *
 * The page is a fixed 1326×5713px canvas and every element is nailed to an x/y
 * spot on it. Document order means nothing. New markup has no coordinates, so
 * it stacks wherever the browser drops it, and the original content — being
 * absolutely positioned — takes up no flow space to push it out of the way.
 *
 * ── The rule this file implements ──────────────────────────────────────────
 *
 * PATCHED (edited in place, page otherwise untouched) — pages whose layout
 * comes from their markup: our own generated pages, hand-written HTML,
 * Tailwind/Bootstrap, Webflow, Elementor and other WordPress builders, even old
 * <table> layouts. Order and nesting decide position, so rewriting a section
 * IS redesigning it. Nothing about the page is changed except the part asked
 * for.
 *
 * NEEDS A REBUILD (cannot be safely patched) — pages whose layout comes from
 * per-element pixel coordinates: Unbounce, Instapage, classic Leadpages, Adobe
 * Muse, Google Web Designer, Figma/Sketch HTML exporters, and Framer when it
 * exports absolute positioning. Here markup edits are inert: the coordinates
 * still rule, so anything new overlaps instead of flowing. These pages can
 * still take text/image/colour edits in place — what they cannot take is
 * restructuring.
 *
 * What "needs a rebuild" does: at prep time, before the user has typed
 * anything, the page is left exactly as uploaded and the chat asks whether to
 * rebuild it (see describePrepOutcome and schema-from-html). Nothing is
 * rebuilt automatically and the chat stays locked until that question is
 * answered — an edit typed past the question would be a restructure request
 * against a page that cannot take one. Answering yes runs rebuild-flow, which
 * extracts the content by code (ai-page-extract.ts), regenerates the page in
 * flow layout, and throws its own output away rather than save a lossy page.
 * Answering no leaves the page as it is, still editable for text, images and
 * colours, with the offer still reachable in the chat.
 *
 * Note that the decision is NOT made by sniffing for `lp-pom-` or any other
 * builder's fingerprint. Titan Funding is one page out of thousands of possible
 * uploads, and the next one will be some exporter nobody here has heard of.
 * Elementor is a page builder and still patches fine because it lays out with
 * flex/grid — which is exactly why this measures the layout instead of guessing
 * from the tool that produced it.
 *
 * Dependency-free and deterministic on purpose: no AI call, no network, same
 * answer every time, and testable against real uploaded HTML
 * (scripts/verify-page-layout.mjs).
 */

/** Elements a layout positions. Text nodes and inline spans are not placed. */
const LAYOUT_TAGS = new Set([
  'div', 'section', 'header', 'footer', 'nav', 'main', 'article', 'aside',
  'form', 'table', 'figure', 'ul', 'ol',
]);

/** Contents are not markup and must never be scanned as such. */
const OPAQUE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/**
 * A container this tall is not a component, it is a whole page frozen at one
 * height. Deliberately well above any real hero or full-viewport band (a 900px
 * hero is normal; a 1500px+ fixed container that holds the entire document is
 * not) so a flow page never trips this on a tall section.
 */
const PAGE_HEIGHT_PX = 1500;

/** Below this there is not enough of a page to measure a ratio against. */
const MIN_BLOCKS = 6;

/** A handful of absolutely-placed badges is normal. A layout's worth is not. */
const MIN_POSITIONED = 5;

/** Half a page's blocks on coordinates means coordinates ARE the layout. */
const POSITIONED_SHARE = 0.5;

export type LayoutKind = 'flow' | 'coordinate';

export interface PageLayout {
  kind: LayoutKind;
  /**
   * 'patch'   — markup edits move the page; edit sections in place.
   * 'rebuild' — markup edits are inert; restructuring would overlap.
   */
  strategy: 'patch' | 'rebuild';
  /** Plain-English evidence. Safe to log and to show a user verbatim. */
  reasons: string[];
  /** Fixed pixel height found on a top-level container, if any. */
  containerHeightPx: number | null;
  /** Layout elements on the whole page placed by left/top coordinates. */
  positioned: number;
  /** Layout elements on the whole page. */
  candidates: number;
  /** The page's own top-level blocks — the denominator of `share`. */
  blocks: number;
  /** Top-level blocks placed by left/top coordinates. */
  blocksPositioned: number;
  /** blocksPositioned / blocks, 0 when there is nothing to measure. */
  share: number;
}

// ── CSS reading (enough of it, not a real cascade) ───────────────────────────

/**
 * The viewport we resolve the stylesheet at.
 *
 * Everything downstream — where an element sits, how wide it is, what colour it
 * is — is read at this one width, so a page is measured and rebuilt at the size
 * it was designed for rather than at whatever breakpoint the CSS happens to end
 * on. 1280 is the narrowest common desktop; picking it over 1440 or 1920 means a
 * `min-width: 1400px` refinement is skipped rather than a `max-width: 1280px`
 * mobile override being let in, and skipping a refinement is the cheaper mistake.
 */
export const DESKTOP_VIEWPORT_PX = 1280;

/** A pixel length, or null for %, auto, calc(), vh — anything that can flex. */
function pxValue(value: string | null): number | null {
  if (!value) return null;
  const m = /^(-?\d+(?:\.\d+)?)px\b/i.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * The keys a selector can be matched to an element by: '#id', '.class', or
 * 'tag:name' for a bare tag selector.
 *
 * Only the RIGHTMOST compound of each comma-separated part is read, since that
 * is the element the rule actually styles (`.wrap > #box` styles #box). For a
 * compound like `.lp-element.lp-pom-block` the first class is taken, which
 * matches slightly more elements than the real selector would — an over-count
 * that can only push a page towards "measure it more carefully", never towards
 * silently patching a coordinate page.
 *
 * Each key also reports the ancestor compound the rule needs, when it has one.
 * `.tf-card p { font-size: 12px }` keys on `tag:p` and needs `.tf-card` above it.
 * Ignoring that requirement is safe for a verdict but ruinous for a rebuild: the
 * rule reads as "every paragraph on the page", and one card's small print
 * repaints the whole document. That shipped, and it is why {@link ancestorKey}
 * exists. See resolveDeclarations.
 */
interface SelectorKey {
  /** The element the rule styles: '#id' | '.class' | 'tag:name'. */
  key: string;
  /**
   * Compounds that must ALL appear among the element's ancestors, or empty when
   * the rule stands alone.
   *
   * Every one of them, not just the nearest: `.project-data li span { color:
   * #94A3B8 }` reduced to "a span inside an li" repainted an unrelated checklist
   * in another section grey. Nesting order is not checked, so `.a .b p` would also
   * match `.b .a p` — an over-match of a different order of magnitude from that one.
   */
  ancestorKeys: string[];
}

function compoundKey(compound: string): string | null {
  const base = compound.split(':')[0];
  if (!base) return null;
  const id = /#([A-Za-z0-9_-]+)/.exec(base);
  if (id) return '#' + id[1];
  const cls = /\.([A-Za-z0-9_-]+)/.exec(base);
  if (cls) return '.' + cls[1];
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*)$/.exec(base);
  return tag ? 'tag:' + tag[1].toLowerCase() : null;
}

function selectorKeys(selector: string): SelectorKey[] {
  const out: SelectorKey[] = [];
  for (const part of selector.split(',')) {
    const s = part.trim();
    // At-rule headers (@media …, @supports …) are not selectors.
    if (!s || s.startsWith('@')) continue;
    const compounds = s.split(/[\s>+~]+/).filter(Boolean);
    const last = compounds.pop();
    if (!last) continue;
    const key = compoundKey(last);
    if (!key) continue;

    // A universal or pseudo-only step ('*', ':hover') identifies nothing, so it
    // is skipped rather than treated as a requirement nothing can satisfy.
    // `html` and `body` are skipped for the same reason: every element is inside
    // them, so requiring them excludes nothing and only costs a lookup.
    const ancestorKeys: string[] = [];
    for (const compound of compounds) {
      const found = compoundKey(compound);
      if (!found || found === 'tag:html' || found === 'tag:body') continue;
      if (!ancestorKeys.includes(found)) ancestorKeys.push(found);
    }
    out.push({ key, ancestorKeys });
  }
  return out;
}

/**
 * What the page's stylesheets say, keyed by how an element can be matched.
 *
 * Exported because rebuilding a coordinate page needs the same facts this
 * verdict needs — where each element sits, what colour it is, what font it uses
 * (see ai-page-extract.ts). Reading the stylesheet twice, two different ways,
 * is how the two would drift apart.
 */
export interface StyleFacts {
  /**
   * Key ('#id' / '.class' / 'tag:name') → every declaration any rule gave it,
   * merged. Later rules win, matching the cascade closely enough for this.
   * Only rules that hold at {@link DESKTOP_VIEWPORT_PX} are in here.
   */
  byKey: Map<string, Record<string, string>>;
  /**
   * The same rules, split by whether they need an ancestor — the index a rebuild
   * reads, because it cannot afford {@link byKey}'s over-match.
   *
   * `own` holds rules that stand alone (`p { … }`, `.btn { … }`). `contextual`
   * holds the rest, each carrying the ancestor compound it needs, and is applied
   * only to elements that really sit inside one. See resolveDeclarations.
   */
  own: Map<string, Record<string, string>>;
  contextual: Map<string, Array<{ ancestorKeys: string[]; decls: Record<string, string> }>>;
  /**
   * The same two indexes again, but only for declarations that came from
   * inside an `@media` block that holds at {@link DESKTOP_VIEWPORT_PX} — never
   * from the page's unconditional stylesheet. See {@link resolveMediaDeclarations}
   * for why this exists: an unconditional `display: none` is not proof an
   * element is meant to stay off the desktop page.
   */
  mediaOwn: Map<string, Record<string, string>>;
  mediaContextual: Map<string, Array<{ ancestorKeys: string[]; decls: Record<string, string> }>>;
  /**
   * Every custom property the page defines, from any selector, flattened.
   *
   * Kept separately because they have to be re-declared on `:root` in a rebuild:
   * carrying `font-family: var(--font-heading)` across without the definition
   * silently drops the page's typeface back to the browser default.
   */
  vars: Record<string, string>;
}

/**
 * Remove `/* … *\/` comments.
 *
 * Not cosmetic. Comments were left in, so the declaration after one absorbed it
 * into its property name: `/* Typography *\/ --font-heading: 'Montserrat'` parsed
 * as a property called "/* typography *\/ --font-heading", which is not a custom
 * property and was dropped. A real page lost `--clr-navy`, `--font-heading` and
 * `--section-pad` that way — every one the first declaration after a comment —
 * and its headings silently fell back to the default typeface.
 */
function stripCssComments(css: string): string {
  return css.includes('/*') ? css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ') : css;
}

/** Declarations of one `{ … }` block, lowercased property → raw value. */
function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of stripCssComments(body).split(';')) {
    const colon = part.indexOf(':');
    if (colon <= 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (!prop) continue;
    // Custom properties are kept — a page whose headings say
    // `font-family: var(--font-heading)` loses its typeface without them.
    // Vendor-prefixed properties are still skipped.
    if (prop.startsWith('-') && !prop.startsWith('--')) continue;
    const value = part.slice(colon + 1).trim();
    if (!value) continue;
    out[prop] = value;
  }
  return out;
}

/** A media-feature length in px. Handles px/em/rem/pt; null for anything else. */
function mediaLengthPx(raw: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*(px|em|rem|pt)$/i.exec(raw.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2].toLowerCase()) {
    case 'em':
    case 'rem': return n * 16;
    case 'pt': return n * (4 / 3);
    default: return n;
  }
}

/** Index just past the `}` that closes the block opened at `open`. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    const c = css[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return css.length;
}

/**
 * Does one `@media` query hold at {@link DESKTOP_VIEWPORT_PX} on a screen?
 *
 * Unrecognised features are treated as holding. That is deliberate: a feature we
 * do not model is far more often decorative (`hover`, `aspect-ratio`) than
 * layout-defining, and dropping the block would lose real styles. The exceptions
 * below are the ones that reliably carry a *different* design rather than a
 * refinement of the same one.
 */
function mediaQueryApplies(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;

  // `not (…)` inverts a condition we would have to resolve to invert correctly.
  if (/^not\b/.test(q)) return false;
  if (/\bprint\b/.test(q) && !/\bscreen\b/.test(q)) return false;
  if (/\bspeech\b/.test(q)) return false;

  const featureRe = /\(\s*([a-z-]+)\s*:\s*([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = featureRe.exec(q))) {
    const name = m[1];
    const raw = m[2].trim();
    if (name === 'min-width' || name === 'min-device-width') {
      const px = mediaLengthPx(raw);
      if (px !== null && DESKTOP_VIEWPORT_PX < px) return false;
    } else if (name === 'max-width' || name === 'max-device-width') {
      const px = mediaLengthPx(raw);
      if (px !== null && DESKTOP_VIEWPORT_PX > px) return false;
    } else if (name === 'prefers-color-scheme') {
      // A dark-mode block is a second palette, not this page's palette.
      if (raw !== 'light') return false;
    } else if (name === 'orientation') {
      if (raw !== 'landscape') return false;
    } else if (name === 'pointer' || name === 'any-pointer') {
      if (raw === 'coarse') return false;
    } else if (name === 'hover' || name === 'any-hover') {
      // `hover: none` is the touch-device stylesheet.
      if (raw === 'none') return false;
    } else if (
      name === 'min-resolution' ||
      name === 'min-device-pixel-ratio' ||
      name === '-webkit-min-device-pixel-ratio'
    ) {
      // Retina-only overrides swap assets, they do not describe the layout.
      return false;
    }
  }

  // Range syntax: (width <= 600px) / (600px < width) / (width >= 1024px).
  const rangeRe =
    /\(\s*(?:(-?[\d.]+(?:px|em|rem|pt))\s*(<=?|>=?)\s*width|width\s*(<=?|>=?)\s*(-?[\d.]+(?:px|em|rem|pt)))\s*\)/g;
  let r: RegExpExecArray | null;
  while ((r = rangeRe.exec(q))) {
    // Normalise both spellings to `width <op> length`.
    const flipped = r[1] !== undefined;
    const len = mediaLengthPx(flipped ? r[1] : r[4]);
    if (len === null) continue;
    let op = flipped ? r[2] : r[3];
    if (flipped) op = op.startsWith('<') ? '>' + op.slice(1) : '<' + op.slice(1);
    const w = DESKTOP_VIEWPORT_PX;
    const holds =
      op === '<' ? w < len : op === '<=' ? w <= len : op === '>' ? w > len : w >= len;
    if (!holds) return false;
  }

  return true;
}

/** Does an at-rule header's block contain rules we should read? */
function atRuleApplies(header: string): boolean {
  const h = header.trim();
  const name = /@([a-zA-Z-]+)/.exec(h)?.[1]?.toLowerCase();
  if (!name) return true;
  if (name === 'media') return h.slice(h.toLowerCase().indexOf('media') + 5)
    // A comma-separated query list holds if any one query holds.
    .split(',')
    .some(mediaQueryApplies);
  // Animation frames are `0% { … }`, not selectors — reading them would file
  // junk keys like `tag:from` and mid-animation values as if they were styles.
  if (name === 'keyframes') return false;
  // @supports, @layer, nested @media: step inside and keep reading.
  return true;
}

/**
 * Read every <style> block on the page into per-key declarations, resolved at
 * {@link DESKTOP_VIEWPORT_PX}.
 *
 * The media-query filtering is the whole point of this function's shape. An
 * earlier version stepped into every at-rule and read its contents as if they
 * were top-level, so with "later wins" the *last* breakpoint in the file
 * decided every value. On a real Unbounce export that was the 320px mobile
 * stylesheet: the page's main container came back as `left: 50%; width: 320px`
 * and the canvas as 8216px tall, when the desktop design is 1010px wide and
 * 5713px tall. Every position, width and background handed to the rebuild came
 * from the wrong breakpoint, which is most of why the rebuilt page looked
 * nothing like the original. Blocks that do not hold at the desktop width are
 * now skipped whole.
 */
export function readStyleFacts(html: string): StyleFacts {
  const byKey = new Map<string, Record<string, string>>();
  const own = new Map<string, Record<string, string>>();
  const contextual = new Map<string, Array<{ ancestorKeys: string[]; decls: Record<string, string> }>>();
  const mediaOwn = new Map<string, Record<string, string>>();
  const mediaContextual = new Map<string, Array<{ ancestorKeys: string[]; decls: Record<string, string> }>>();
  const vars: Record<string, string> = {};
  // Which at-rule blocks we are currently inside, so a declaration can be
  // filed as media-sourced when any enclosing block is an `@media` that holds
  // at desktop width. Blocks that do not hold are skipped whole below and
  // never push here at all.
  const blockStack: Array<{ end: number; isMedia: boolean }> = [];

  let css = '';
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = styleRe.exec(html))) css += sm[1] + '\n';

  // Before the brace walk, not after: a commented-out rule (`/* .a { b: c } */`)
  // would otherwise feed its braces to the walker as if it were live CSS.
  css = stripCssComments(css);

  // Walks `selector { declarations }` pairs by index rather than by regex.
  //
  // The regex version of this was `/([^{}]+)\{([^{}]*)\}/g`, which is quadratic
  // when the braces it needs are not there: on a 200KB <style> block with no
  // braces in it, `[^{}]+` matches to the end, fails to find `{`, and the engine
  // retries from every following character. That hung for minutes on a single
  // page — an availability bug in the prep, build and follow-up paths alike, for
  // an input nobody would notice was malformed. This is strictly linear.
  let i = 0;
  let selectorStart = 0;
  while (i < css.length) {
    while (blockStack.length > 0 && i >= blockStack[blockStack.length - 1].end) blockStack.pop();

    const open = css.indexOf('{', i);
    if (open === -1) break;
    const close = css.indexOf('}', open + 1);
    if (close === -1) break;

    // Another '{' before the '}' means `open` closed an at-rule header
    // (@media …, @supports …), not a selector. Whether we step inside depends on
    // whether the block holds at the desktop viewport; if it does not, skip past
    // its matching brace so none of its rules are read at all.
    const nextOpen = css.indexOf('{', open + 1);
    if (nextOpen !== -1 && nextOpen < close) {
      const header = css.slice(selectorStart, open);
      if (!atRuleApplies(header)) {
        const past = blockEnd(css, open);
        i = past;
        selectorStart = past;
        continue;
      }
      const name = /@([a-zA-Z-]+)/.exec(header.trim())?.[1]?.toLowerCase();
      blockStack.push({ end: blockEnd(css, open), isMedia: name === 'media' });
      i = open + 1;
      selectorStart = open + 1;
      continue;
    }

    const selector = css.slice(selectorStart, open);
    const body = css.slice(open + 1, close);
    i = close + 1;
    selectorStart = close + 1;

    const decls = parseDeclarations(body);
    if (Object.keys(decls).length === 0) continue;

    // Custom properties are collected whatever the selector, since `:root` and
    // `html` are not selectors this index can key an element by.
    for (const [prop, value] of Object.entries(decls)) {
      if (prop.startsWith('--')) vars[prop] = value;
    }

    const keys = selectorKeys(selector);
    if (keys.length === 0) continue;

    const inMedia = blockStack.some((b) => b.isMedia);

    for (const { key, ancestorKeys } of keys) {
      const existing = byKey.get(key);
      if (existing) Object.assign(existing, decls);
      else byKey.set(key, { ...decls });

      if (ancestorKeys.length > 0) {
        const list = contextual.get(key);
        if (list) list.push({ ancestorKeys, decls });
        else contextual.set(key, [{ ancestorKeys, decls }]);

        if (inMedia) {
          const mList = mediaContextual.get(key);
          if (mList) mList.push({ ancestorKeys, decls });
          else mediaContextual.set(key, [{ ancestorKeys, decls }]);
        }
      } else {
        const kept = own.get(key);
        if (kept) Object.assign(kept, decls);
        else own.set(key, { ...decls });

        if (inMedia) {
          const mKept = mediaOwn.get(key);
          if (mKept) Object.assign(mKept, decls);
          else mediaOwn.set(key, { ...decls });
        }
      }
    }
  }

  return { byKey, own, contextual, mediaOwn, mediaContextual, vars };
}

/** Every way a rule could name this element: 'tag:name', each '.class', '#id'. */
export function elementKeys(tag: string, attrs: string): string[] {
  const keys = ['tag:' + tag.toLowerCase()];
  for (const cls of classesOf(attrs)) keys.push('.' + cls);
  const id = idOf(attrs);
  if (id) keys.push('#' + id);
  return keys;
}

/**
 * Declarations for one element, honouring the ancestor a rule asked for.
 *
 * The difference from {@link declarationsFor} is `ancestorKeys` — every key of
 * every element above this one. A contextual rule is applied only when its
 * required ancestor is in that set, so `.tf-card p { font-size: 12px }` reaches
 * paragraphs inside a card and leaves the rest of the page alone.
 *
 * Order approximates specificity: tag, then class, then contextual, then id, then
 * inline. Still an approximation — `.a.b` does not outrank `.b` here — but it is
 * the difference between a rebuild that resembles the page and one that does not.
 */
function resolveFrom(
  ownMap: Map<string, Record<string, string>>,
  contextualMap: Map<string, Array<{ ancestorKeys: string[]; decls: Record<string, string> }>>,
  tag: string,
  attrs: string,
  ancestorKeys: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = elementKeys(tag, attrs);

  const tagDecls = ownMap.get(keys[0]);
  if (tagDecls) Object.assign(out, tagDecls);
  for (const key of keys) {
    if (key.startsWith('.')) {
      const d = ownMap.get(key);
      if (d) Object.assign(out, d);
    }
  }
  for (const key of keys) {
    for (const rule of contextualMap.get(key) ?? []) {
      if (rule.ancestorKeys.every((need) => ancestorKeys.has(need))) {
        Object.assign(out, rule.decls);
      }
    }
  }
  const idKey = keys.find((k) => k.startsWith('#'));
  if (idKey) {
    const d = ownMap.get(idKey);
    if (d) Object.assign(out, d);
  }
  return out;
}

export function resolveDeclarations(
  facts: StyleFacts,
  tag: string,
  attrs: string,
  ancestorKeys: ReadonlySet<string>,
): Record<string, string> {
  const out = resolveFrom(facts.own, facts.contextual, tag, attrs, ancestorKeys);

  const inline = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const inlineText = inline?.[1] ?? inline?.[2] ?? '';
  if (inlineText) Object.assign(out, parseDeclarations(inlineText));
  return out;
}

/**
 * `display`/`visibility` as stated ONLY by rules sourced from an `@media`
 * block that holds at desktop width — never the unconditional stylesheet.
 *
 * Exists because a real Unbounce export marks real, load-bearing desktop
 * content `display: none` in its plain, unconditional CSS and reveals it with
 * its own runtime JS (a fade/lazy-reveal effect) — the same static-looking
 * declaration a genuine "this only exists on mobile" duplicate uses. A
 * transpile that trusts unconditional `display: none` as "not part of the
 * desktop page" cannot tell those two apart, and it guessed wrong: property
 * photos, a whole trust-logo strip and a form all vanished from a real page
 * this way, silently, because the independent verifier trusted the exact same
 * signal and agreed. Genuinely mobile-only content does not need this check at
 * all — it is excluded already, because the `@media` block that describes it
 * does not hold at desktop width and {@link readStyleFacts} never reads its
 * rules in the first place. So the only `display: none` worth treating as
 * "hidden at desktop" is one that survived that filter, i.e. one that came
 * from a media query that DOES hold at desktop (a real, if rare, desktop-only
 * hide) — which is exactly what this resolves.
 */
export function resolveMediaDeclarations(
  facts: StyleFacts,
  tag: string,
  attrs: string,
  ancestorKeys: ReadonlySet<string>,
): Record<string, string> {
  return resolveFrom(facts.mediaOwn, facts.mediaContextual, tag, attrs, ancestorKeys);
}

/**
 * Every declaration that applies to one element, inline style last.
 *
 * Merged across ALL of its keys, which is the point: exporters routinely write
 * `.node { position: absolute }` once and a per-element `#n7 { left: 10px; top:
 * 900px }` separately. An earlier version kept "is absolute" and "has offsets"
 * as two key sets and intersected them per key — neither rule matched the other's
 * key, and a pure coordinate page read as flow.
 *
 * Specificity is approximated by order (tag, then class, then id, then inline),
 * not computed. Good enough to answer "roughly where is this and what colour is
 * it"; nowhere near a real cascade.
 */
export function declarationsFor(
  facts: StyleFacts,
  tag: string,
  attrs: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const tagDecls = facts.byKey.get('tag:' + tag);
  if (tagDecls) Object.assign(out, tagDecls);
  for (const cls of classesOf(attrs)) {
    const d = facts.byKey.get('.' + cls);
    if (d) Object.assign(out, d);
  }
  const id = idOf(attrs);
  if (id) {
    const d = facts.byKey.get('#' + id);
    if (d) Object.assign(out, d);
  }
  const inline = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const inlineText = inline?.[1] ?? inline?.[2] ?? '';
  if (inlineText) Object.assign(out, parseDeclarations(inlineText));
  return out;
}

/** A pixel number out of a declaration value, or null when it can flex. */
export function pixels(value: string | undefined): number | null {
  return pxValue(value ?? null);
}

// ── Element reading ─────────────────────────────────────────────────────────

interface OpenTag {
  tag: string;
  attrs: string;
}

/** Every open tag inside <body>, in document order, opaque subtrees skipped. */
function bodyOpenTags(html: string): OpenTag[] {
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const from = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const closeIdx = html.toLowerCase().lastIndexOf('</body>');
  const to = closeIdx > from ? closeIdx : html.length;

  const out: OpenTag[] = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && m.index < to) {
    const tag = m[1].toLowerCase();
    if (OPAQUE_TAGS.has(tag)) {
      // Jump the whole subtree rather than reading CSS or JS as markup.
      const close = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      re.lastIndex = close === -1 ? to : close + tag.length + 3;
      continue;
    }
    out.push({ tag, attrs: m[2] });
  }
  return out;
}

function idOf(attrs: string): string | null {
  const m = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const v = (m?.[1] ?? m?.[2] ?? '').trim();
  return v || null;
}

function classesOf(attrs: string): string[] {
  const m = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? '').trim().split(/\s+/).filter(Boolean);
}

/** Is this element placed by coordinates rather than by document flow? */
export function isCoordinatePlaced(decls: Record<string, string>): boolean {
  const position = (decls.position ?? '').toLowerCase();
  if (position !== 'absolute' && position !== 'fixed') return false;
  return decls.left !== undefined || decls.top !== undefined;
}

// ── The page's own blocks ───────────────────────────────────────────────────
//
// The ratio has to be measured over the page's TOP-LEVEL blocks, not over every
// element on it. Measured over everything, an ordinary page that happens to put
// an absolutely-positioned badge inside each of its 16 sections comes out at
// 19/35 "positioned" and gets refused for restructuring — a sticky nav, a modal,
// an overlay and a badge per card is completely normal markup.
//
// What separates the two is which elements the coordinates PLACE. On a
// coordinate page the page's own blocks are the positioned ones. On a flow page
// the blocks flow and the positioned things are decorations sitting inside them.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** A lone wrapper is where blocks live, not a block. Descend through it. */
const WRAPPER_TAGS = new Set(['div', 'main', 'body']);

interface Element {
  tag: string;
  attrs: string;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
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

/** Direct element children of a byte range, in document order. */
function directChildren(html: string, from: number, to: number): Element[] {
  const out: Element[] = [];
  let i = from;

  while (i < to) {
    const lt = html.indexOf('<', i);
    if (lt < 0 || lt >= to) break;

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt);
      i = close < 0 ? to : close + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('</', lt) || html.startsWith('<?', lt)) {
      const close = html.indexOf('>', lt);
      i = close < 0 ? to : close + 1;
      continue;
    }

    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/.exec(html.slice(lt, Math.min(to, lt + 4096)));
    if (!m) { i = lt + 1; continue; }

    const tag = m[1].toLowerCase();
    const openEnd = lt + m[0].length;
    const selfClosing = m[0].endsWith('/>');

    if (VOID_TAGS.has(tag) || selfClosing) {
      out.push({ tag, attrs: m[2], start: lt, end: openEnd, innerStart: openEnd, innerEnd: openEnd });
      i = openEnd;
      continue;
    }

    const end = elementEnd(html, tag, openEnd);
    // Unbalanced — stop rather than invent a span.
    if (end === null || end > to) break;
    const closeStart = html.lastIndexOf('</', end);
    out.push({
      tag,
      attrs: m[2],
      start: lt,
      end,
      innerStart: openEnd,
      innerEnd: closeStart > openEnd ? closeStart : openEnd,
    });
    i = end;
  }

  return out;
}

/**
 * The range that holds the page's blocks, and the containers wrapping it.
 *
 * Starts at <body> and walks down through any single wrapper element, so
 * <body><div class="page">…</div></body> is read the same as a flat page. The
 * chain is returned as well, because a whole-page fixed height is declared on
 * one of exactly these elements — checking "the first few structural tags"
 * instead would trip on any tall section that happens to come early.
 *
 * Same descent rule as blockContainer() in ai-sl-markers.ts on purpose: this
 * has to measure the boxes that markers actually get drawn around.
 */
function blockContainer(html: string): { from: number; to: number; chain: Element[] } {
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  let from = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  let to = bodyClose > from ? bodyClose : html.length;
  const chain: Element[] = [];

  for (let depth = 0; depth < 3; depth++) {
    const children = directChildren(html, from, to).filter(
      (el) => !OPAQUE_TAGS.has(el.tag) && !VOID_TAGS.has(el.tag),
    );
    if (children.length !== 1) break;
    const only = children[0];
    if (!WRAPPER_TAGS.has(only.tag)) break;
    chain.push(only);
    from = only.innerStart;
    to = only.innerEnd;
  }

  return { from, to, chain };
}

// ── The measurement ─────────────────────────────────────────────────────────

// One-entry memo. A single request measures the same page string several times
// (prep logs it, the editor path reads it back), and the CSS scan runs over a
// stylesheet that is routinely 90KB+. Keyed by `===`, which V8 short-circuits
// on reference identity, so a repeat call on the same string is free and a
// different page can never read a stale answer.
let memoInput: string | null = null;
let memoResult: PageLayout | null = null;

/**
 * Decide how this page can be edited. Pure, deterministic, no AI, no network.
 *
 * Fails towards 'patch' (today's behaviour) whenever there is not enough page
 * to measure — an empty string, a fragment with no elements, a three-block
 * page. Being wrong that way costs nothing; being wrong the other way would
 * refuse edits on a perfectly ordinary page.
 */
export function analyzePageLayout(html: string): PageLayout {
  if (memoInput === html && memoResult) return memoResult;

  const result = measure(html);
  memoInput = html;
  memoResult = result;
  return result;
}

function measure(html: string): PageLayout {
  if (!html || html.length < 40) {
    return {
      kind: 'flow',
      strategy: 'patch',
      reasons: ['page is empty'],
      containerHeightPx: null,
      positioned: 0,
      candidates: 0,
      blocks: 0,
      blocksPositioned: 0,
      share: 0,
    };
  }

  const facts = readStyleFacts(html);
  const isPositioned = (attrs: string, tag: string): boolean =>
    isCoordinatePlaced(declarationsFor(facts, tag, attrs));
  const fixedHeightOf = (attrs: string, tag: string): number | null =>
    pixels(declarationsFor(facts, tag, attrs).height);

  // Whole-page counts. Evidence for the log and for the second clause below,
  // not the ratio — see the note above blockContainer().
  let candidates = 0;
  let positioned = 0;
  for (const el of bodyOpenTags(html)) {
    if (!LAYOUT_TAGS.has(el.tag)) continue;
    candidates++;
    if (isPositioned(el.attrs, el.tag)) positioned++;
  }

  // The page's own blocks, and the containers that hold them.
  const { from, to, chain } = blockContainer(html);
  const children = directChildren(html, from, to).filter((el) => LAYOUT_TAGS.has(el.tag));
  const blocks = children.length;
  let blocksPositioned = 0;
  for (const el of children) if (isPositioned(el.attrs, el.tag)) blocksPositioned++;

  // ── Is the page frozen at one height? ──────────────────────────────────
  //
  // Looked for on <body>, on the wrappers the descent walked through, AND on
  // every direct child of the body — because a page rarely stays as tidy as the
  // descent assumes. The Unbounce page in question reads as a 5713px canvas as
  // uploaded, and after one AI edit had appended a section, its body had two
  // children instead of one, the descent stopped early, and a chain-only check
  // lost the signal on the very page it was written for. A stray cookie banner
  // or modal at the end of the body would do the same thing.
  //
  // What stops a tall hero being mistaken for a page canvas is the size test:
  // the element has to hold most of the body. A 1800px hero on a long page does
  // not; a root div that IS the page does.
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  const bodyFrom = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const bodyCloseIdx = html.toLowerCase().lastIndexOf('</body>');
  const bodyTo = bodyCloseIdx > bodyFrom ? bodyCloseIdx : html.length;
  const bodyBytes = Math.max(1, bodyTo - bodyFrom);

  let containerHeightPx: number | null = null;
  const noteHeight = (h: number | null) => {
    if (h !== null && h >= PAGE_HEIGHT_PX && h > (containerHeightPx ?? 0)) containerHeightPx = h;
  };
  if (bodyOpen) noteHeight(fixedHeightOf(bodyOpen[0], 'body'));
  const canvasCandidates = chain.concat(
    directChildren(html, bodyFrom, bodyTo).filter((el) => !OPAQUE_TAGS.has(el.tag)),
  );
  const seen = new Set<number>();
  for (const el of canvasCandidates) {
    if (seen.has(el.start)) continue;
    seen.add(el.start);
    // Holds most of the page, or it is a section, not the canvas.
    if ((el.innerEnd - el.innerStart) / bodyBytes < 0.5) continue;
    noteHeight(fixedHeightOf(el.attrs, el.tag));
  }

  const share = blocks > 0 ? blocksPositioned / blocks : 0;
  const reasons: string[] = [];

  // Two independent ways to be coordinate-based, because a hybrid page trips
  // only one of them.
  //
  // The real Unbounce page is exactly that, and it is worth knowing why. Its
  // top-level blocks are full-width bands — `#lp-pom-block-622` is
  // `position: absolute; width: 100%; height: 154px; margin: auto`, with no
  // left/top at all — so the ratio reads 1 of 22 and says "flow". The
  // coordinates are one level down, on the bands' CONTENTS, together with
  // `#lp-pom-root { height: 5713px }` in the head. 156 elements on that page
  // carry left/top. Only the second clause sees any of it.
  const mostlyPositioned =
    blocks >= MIN_BLOCKS && blocksPositioned >= MIN_POSITIONED && share >= POSITIONED_SHARE;
  const fixedCanvas = positioned >= MIN_POSITIONED && containerHeightPx !== null;

  if (mostlyPositioned) {
    reasons.push(
      `${blocksPositioned} of the page's ${blocks} top-level blocks are placed at fixed left/top coordinates`,
    );
  }
  if (fixedCanvas) {
    reasons.push(
      `the page sits in a container locked to ${containerHeightPx}px tall, so it cannot grow or shrink, ` +
      `and ${positioned} of its elements are placed at fixed left/top coordinates`,
    );
  }

  if (mostlyPositioned || fixedCanvas) {
    return {
      kind: 'coordinate',
      strategy: 'rebuild',
      reasons,
      containerHeightPx,
      positioned,
      candidates,
      blocks,
      blocksPositioned,
      share,
    };
  }

  return {
    kind: 'flow',
    strategy: 'patch',
    reasons: [
      blocks < MIN_BLOCKS
        ? 'too few top-level blocks to measure — treated as ordinary markup'
        : `layout comes from the markup (${blocksPositioned} of ${blocks} top-level blocks use fixed coordinates)`,
    ],
    containerHeightPx,
    positioned,
    candidates,
    blocks,
    blocksPositioned,
    share,
  };
}

/**
 * The page's top-level blocks, with their byte spans.
 *
 * Exported because a rebuild has to group content the same way the section map
 * does — one band per top-level block (see ai-page-extract.ts). Anything else
 * and the rebuilt page's sections would not line up with the sections the
 * original had.
 */
export function pageBlocks(html: string): Array<{ tag: string; attrs: string; start: number; end: number }> {
  if (!html) return [];
  const { from, to } = blockContainer(html);
  return directChildren(html, from, to)
    .filter((el) => !OPAQUE_TAGS.has(el.tag) && !VOID_TAGS.has(el.tag))
    .map((el) => ({ tag: el.tag, attrs: el.attrs, start: el.start, end: el.end }));
}

/** How many layout elements a page has — for before/after comparison. */
export function countLayoutElements(html: string): number {
  let n = 0;
  for (const el of bodyOpenTags(html)) if (LAYOUT_TAGS.has(el.tag)) n++;
  return n;
}

/**
 * What to tell the user once a page has been prepared.
 *
 * Written to be shown verbatim in the chat. It says which of the two things
 * happened and why, because the alternative — the flat "Done preparing this
 * page!" this replaces — was also what the user saw on the Unbounce page whose
 * hero had just been stacked on top of itself.
 */
export function describePrepOutcome(layout: PageLayout, brokenBoxes: number): {
  strategy: 'patch' | 'rebuild';
  message: string;
} {
  if (layout.strategy === 'patch') {
    const caveat =
      brokenBoxes > 0
        ? ' A few empty wrapper blocks were skipped — they hold no content to edit.'
        : '';
    return {
      strategy: 'patch',
      message:
        'Done preparing this page — nothing about it was changed or rebuilt. ' +
        'Its layout comes from its own markup, so I can edit any part of it in place. ' +
        'Click any text in the preview to edit it, or ask me to make changes.' +
        caveat,
    };
  }

  // Deliberately short, and it ends in a question.
  //
  // The first version of this explained the whole diagnosis — the container
  // height, the number of positioned elements, what could and could not be
  // edited — and it landed as an eight-line wall of text before the user had
  // typed a word. Nobody reads that on page load. The measurements still exist
  // for anyone who wants them: they are on the layout object and in the server
  // log. What belongs in the chat is the decision the user has to make.
  //
  // The "what you can still do" note moved to the decline branch in the UI,
  // where it is the answer to a question the user just asked.
  return {
    strategy: 'rebuild',
    message:
      'This page needs rebuilding before I can restructure it — its layout is fixed pixel ' +
      'coordinates rather than markup, so anything new would land on top of the old. ' +
      'Rebuild it? Everything you can see is copied across exactly — only the positioning ' +
      'is rewritten.',
  };
}

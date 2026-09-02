/**
 * Put back the <!-- SL:name --> markers a page is missing.
 *
 * Those markers are how every later pass finds a section. Without them a
 * section still renders perfectly and is completely uneditable — the editor
 * cannot see it, cannot name it, cannot change it.
 *
 * What that costs, from a real session: a page had 11 top-level blocks and 5
 * markers. The user asked to remove two skills. The skills live in an unmarked
 * block, so the rewrite was handed a page WITHOUT them on it and asked to
 * remove them. It returned "nothing to change", and we answered "I couldn't
 * work out what to change. Name the section" — blaming the user's wording for
 * a block we never showed the model. No phrasing could ever have worked.
 *
 * Where the gap comes from: the builder is TOLD to write the markers, in prose,
 * in its prompt (see ai-page-builder.ts, "Section markers — REQUIRED"). It then
 * hand-types them while writing a 900-line document, and nothing verifies the
 * result. On the page above it wrapped 5 of 11 and misnamed one of those.
 *
 * Note the contrast with the IMPORT path (schema-from-html): there the model
 * never types a marker. It reports where the blocks are and CODE inserts them.
 * That path does not have this bug. This file brings the same division of
 * labour — model judges, code writes bytes — to the pages we generate.
 *
 * Two passes, cheapest first, neither of which needs an AI call:
 *
 *   1. STRUCTURAL. Walk the page's top-level blocks and wrap any that have no
 *      markers, naming each from what it already calls itself. This is the one
 *      that matters, because the pages that come out short are the ones we
 *      built, and our own builder always emits flat top-level blocks.
 *
 *   2. SCHEMA-ANCHORED. For anything still missing, find the block by text we
 *      hold in the schema. A fallback for pages whose shape pass 1 could not
 *      read.
 *
 * Both skip whatever they cannot place with certainty. A marker around the
 * wrong span is far worse than a missing one: it lets a later edit rewrite a
 * part of the page nobody named.
 *
 * Dependency-free on purpose, so the rules can be tested against real HTML.
 */

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Elements a section is plausibly built from, widest-meaning first. */
const SECTION_TAGS = ['section', 'footer', 'header', 'nav', 'main', 'article', 'aside', 'div'];

/**
 * Top-level elements that are page blocks worth addressing.
 *
 * Deliberately wider than the semantic five. Uploaded HTML is whatever the
 * customer had: Webflow div soup, a Bootstrap page of bare <div class="row">,
 * an email-style layout built entirely from <table>. A block we do not
 * recognise is a block nobody can ever edit, so the list errs towards
 * including things rather than leaving them unreachable.
 */
const WRAPPABLE_TAGS = new Set([
  'section', 'nav', 'header', 'footer', 'main', 'article', 'aside', 'div', 'form', 'table',
]);

/**
 * A lone wrapper is not a section — it is the thing sections live in. Descend
 * through it so a page built as <body><div id="page">…</div></body> gets its
 * real blocks marked instead of one marker around the entire document.
 */
const WRAPPER_TAGS = new Set(['div', 'main', 'body']);

/** Never a page block, and their contents must not be scanned as markup. */
const OPAQUE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Below this a block is a spacer or a stray node, not a section worth naming. */
const MIN_BLOCK_CHARS = 30;

export interface MarkerRepair {
  html: string;
  /** Sections that got their markers back, from either pass. */
  repaired: string[];
  /** Named by the structural pass. Subset of `repaired`, for logging. */
  structural: string[];
  /** Schema sections we could not place. Left alone on purpose — see above. */
  skipped: string[];
  /** Outer markers removed because they had swallowed other sections. */
  unnested: string[];
}

function hasMarker(html: string, name: string): boolean {
  return new RegExp(`<!--\\s*SL:${name}\\s*-->`, 'i').test(html);
}

/** Every marker name currently on the page. */
function existingMarkerNames(html: string): string[] {
  return Array.from(html.matchAll(/<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->/gi)).map((m) => m[1]);
}

/** Already inside a marker pair? Wrapping again would nest and corrupt both. */
function insideAnyMarker(html: string, index: number): boolean {
  const before = html.slice(0, index);
  const lastOpen = before.lastIndexOf('<!-- SL:');
  if (lastOpen === -1) return false;
  const lastClose = before.lastIndexOf('<!-- /SL:');
  return lastOpen > lastClose;
}

/**
 * Wrap html[start, end) in markers, matching the page's own formatting.
 *
 * The newlines are not cosmetic. On a hand-formatted page each block already
 * sits on its own line, so a marker with newlines reads naturally. On MINIFIED
 * html — a single line, elements butted together — adding them inserts
 * whitespace between block elements that was not there before. Harmless in
 * most layouts and not in all of them (inline-block gaps are exactly this),
 * and "the repair changed how the page renders" is not a trade worth making
 * for tidier source. So: newline only where the source already had one.
 */
function wrapAt(html: string, start: number, end: number, name: string): string {
  const openOnOwnLine = start === 0 || html[start - 1] === '\n';
  const closeOnOwnLine = end >= html.length || html[end] === '\n';
  return (
    html.slice(0, start) +
    (openOnOwnLine ? `<!-- SL:${name} -->\n` : `<!-- SL:${name} -->`) +
    html.slice(start, end) +
    (closeOnOwnLine ? `\n<!-- /SL:${name} -->` : `<!-- /SL:${name} -->`) +
    html.slice(end)
  );
}

// ── Pass 1: the page's own structure ────────────────────────────────────────

interface TopLevelElement {
  tag: string;
  /** Byte range of the whole element, opening tag through closing tag. */
  start: number;
  end: number;
  /** Byte range of what sits between the tags. */
  innerStart: number;
  innerEnd: number;
  openTag: string;
}

/**
 * End of the element opened at `openStart`, counting nesting of the same tag.
 *
 * Returns null when the tags do not balance. Guessing an end here would put a
 * closing marker in the middle of someone's markup.
 */
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
function topLevelElements(html: string, from: number, to: number): TopLevelElement[] {
  const out: TopLevelElement[] = [];
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

    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) { i = lt + 1; continue; }

    const tag = m[1].toLowerCase();
    const gt = html.indexOf('>', lt);
    if (gt < 0 || gt >= to) break;
    const openEnd = gt + 1;
    const selfClosing = html[gt - 1] === '/';

    if (VOID_TAGS.has(tag) || selfClosing) {
      out.push({ tag, start: lt, end: openEnd, innerStart: openEnd, innerEnd: openEnd, openTag: html.slice(lt, openEnd) });
      i = openEnd;
      continue;
    }

    const end = elementEnd(html, tag, openEnd);
    if (end === null || end > to) {
      // Unbalanced. Stop rather than invent a span.
      break;
    }
    const closeStart = html.lastIndexOf('</', end);
    out.push({
      tag,
      start: lt,
      end,
      innerStart: openEnd,
      innerEnd: closeStart > openEnd ? closeStart : openEnd,
      openTag: html.slice(lt, openEnd),
    });
    i = end;
  }

  return out;
}

/** One opening marker, anywhere. */
const ANY_OPEN_MARKER = /<!--\s*SL:[a-zA-Z0-9_-]+\s*-->/i;

/**
 * Is there a marker sitting directly at this level, rather than inside a child?
 *
 * Markers live in the gaps BETWEEN the children — `<!-- SL:hero -->` is a
 * sibling of `<section class="hero">`, not part of it. So the test is: cut the
 * children out and look at what is left.
 */
function markerAtLevel(
  html: string,
  from: number,
  to: number,
  kids: Array<{ start: number; end: number }>,
): boolean {
  let gaps = '';
  let cursor = from;
  for (const k of kids) {
    gaps += html.slice(cursor, k.start);
    cursor = k.end;
  }
  gaps += html.slice(cursor, to);
  return ANY_OPEN_MARKER.test(gaps);
}

/**
 * The range that actually holds the page's blocks.
 *
 * Starts at <body> and walks down through any single wrapper element, so a
 * page written as <body><div class="page-wrapper">…</div></body> is read the
 * same as a flat one. Bounded, because "descend while there is one child"
 * would otherwise walk all the way into a leaf.
 *
 * The order of the three tests below is the whole point, and it is there
 * because of a real page. An uploaded Unbounce export is
 * `<body><main class="tfr-page">…8 marked sections…</main></body>`, and the
 * browser had left two empty `display:none` spans after the `</main>`. The old
 * rule was "descend only when there is exactly ONE child": three children, so
 * it never looked inside <main>, saw no markers at body level, and wrapped the
 * entire page in a single `SL:tfr-page` that swallowed all eight. Every
 * subsequent edit then had one 44,000-character section to aim at, wrote back a
 * section named `hero` that no longer existed, and failed with "I couldn't work
 * out what to change" — which blamed the user for our own bookkeeping.
 *
 * So: the markers a page already carries are the most reliable evidence we have
 * about where its blocks live. Trust them first, and fall back to counting
 * children only when there are none.
 */
function blockContainer(html: string): { from: number; to: number } {
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  let from = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  let to = bodyClose > from ? bodyClose : html.length;

  for (let depth = 0; depth < 3; depth++) {
    const children = topLevelElements(html, from, to).filter(
      (el) => !OPAQUE_TAGS.has(el.tag) && !VOID_TAGS.has(el.tag),
    );

    // 1. Markers already sit at THIS level. This is the block level, by proof
    //    rather than by inference — stop, whatever else is lying around here.
    if (markerAtLevel(html, from, to, children)) break;

    // 2. Exactly one child holds the markers. That child is the real page
    //    wrapper and everything beside it is noise, however big that noise is.
    const holders = children.filter(
      (el) =>
        WRAPPER_TAGS.has(el.tag) &&
        !insideAnyMarker(html, el.start) &&
        ANY_OPEN_MARKER.test(html.slice(el.innerStart, el.innerEnd)),
    );
    if (holders.length === 1) {
      from = holders[0].innerStart;
      to = holders[0].innerEnd;
      continue;
    }

    // 3. No markers anywhere yet — a page being prepared for the first time.
    //    Count children as before, but ignore the ones too small to ever BE a
    //    block: wrapTopLevelBlocks already refuses to wrap those, so counting
    //    them here only ever produced a level nobody wanted.
    const real = children.filter((el) => el.innerEnd - el.innerStart >= MIN_BLOCK_CHARS);
    if (real.length !== 1) break;
    const only = real[0];
    if (!WRAPPER_TAGS.has(only.tag)) break;
    // A wrapper that is already a marked section is a section, not a wrapper.
    if (insideAnyMarker(html, only.start)) break;
    from = only.innerStart;
    to = only.innerEnd;
  }

  return { from, to };
}

/**
 * A name the block already answers to.
 *
 * Class before id, matching the convention the builder is given in its own
 * prompt ("name: the FIRST CSS class on the element") — and it also lines up
 * with the data-field prefixes already stamped into the page, so a rewritten
 * section keeps the schema keys it had.
 */
function nameForElement(openTag: string, tag: string): string | null {
  const cls = /\sclass\s*=\s*"([^"]*)"|\sclass\s*=\s*'([^']*)'/i.exec(openTag);
  const first = (cls?.[1] ?? cls?.[2] ?? '').trim().split(/\s+/)[0];
  const id = /\sid\s*=\s*"([^"]*)"|\sid\s*=\s*'([^']*)'/i.exec(openTag);

  for (const candidate of [first, (id?.[1] ?? id?.[2] ?? '').trim(), tag]) {
    const clean = candidate
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (clean && SAFE_NAME_RE.test(clean)) return clean;
  }
  return null;
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 50; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Wrap every top-level block that has no markers.
 *
 * Only ever ADDS markers. Blocks that already have them are left exactly as
 * they are, including their names — renaming a section would break every
 * reference to it in the schema and the conversation history.
 */
export function wrapTopLevelBlocks(html: string): { html: string; wrapped: string[] } {
  const wrapped: string[] = [];
  if (!html) return { html, wrapped };

  const { from, to } = blockContainer(html);
  const taken = existingMarkerNames(html);
  const edits: Array<{ start: number; end: number; name: string }> = [];

  for (const el of topLevelElements(html, from, to)) {
    if (!WRAPPABLE_TAGS.has(el.tag)) continue;
    if (insideAnyMarker(html, el.start)) continue;
    if (el.innerEnd - el.innerStart < MIN_BLOCK_CHARS) continue;
    // A block whose contents are ALREADY marked is a container, not a section.
    //
    // Without this, a builder that emits `<main>` around its own SL:hero and
    // SL:contact gets that <main> wrapped as one more section — and the two
    // real sections end up nested inside it. The route reads sections with an
    // outermost-only regex, so a nested marker is invisible: the page reports
    // three sections when it has five, every edit is aimed at the giant outer
    // one, and a rewrite that correctly returns "hero" is spliced in, cannot be
    // found on the way back out, and is thrown away with whatever it cost to
    // produce. That happened on a real page, and the generated image that turn
    // paid for went in the bin with it.
    //
    // It also stops this pass undoing Pass 0. dropNestedMarkers had already
    // removed the outer marker for exactly this reason; wrapping the same
    // element again put it straight back, so the two passes fought and the
    // page came out of "repair" no better than it went in.
    if (ANY_OPEN_MARKER.test(html.slice(el.innerStart, el.innerEnd))) continue;

    const base = nameForElement(el.openTag, el.tag);
    if (!base) continue;
    const name = uniqueName(base, taken);
    taken.push(name);
    edits.push({ start: el.start, end: el.end, name });
  }

  if (edits.length === 0) return { html, wrapped };

  // Back to front, so an insertion never shifts an offset still to be used.
  edits.sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of edits) {
    out = wrapAt(out, e.start, e.end, e.name);
    wrapped.push(e.name);
  }
  return { html: out, wrapped: wrapped.reverse() };
}

// ── Pass 2: find a block by text we already hold ────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#160': ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : whole;
    }
    return whole;
  });
}

interface TextIndex {
  /** Visible text: tags removed, entities decoded, whitespace collapsed. */
  text: string;
  /** text[i] came from html[map[i]]. */
  map: number[];
}

/**
 * Visible text of the page, with a way back to byte offsets.
 *
 * The old version searched the raw HTML for a raw schema string, and that was
 * wrong twice over on a real page. The schema holds `web, app & AI services`
 * while the markup holds `web, app &amp; AI services`, and a headline stored
 * as one string is written as `Experienced<br>Web, App &amp;<br><span>AI</span>`.
 * Both make indexOf fail, so every anchor missed and the pass repaired nothing.
 */
function buildTextIndex(html: string): TextIndex {
  let text = '';
  const map: number[] = [];
  let i = 0;
  let lastWasSpace = true;

  const push = (ch: string, at: number) => {
    if (/\s/.test(ch)) {
      if (lastWasSpace) return;
      text += ' ';
      map.push(at);
      lastWasSpace = true;
      return;
    }
    text += ch;
    map.push(at);
    lastWasSpace = false;
  };

  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      if (html.startsWith('<!--', i)) {
        const close = html.indexOf('-->', i);
        i = close < 0 ? html.length : close + 3;
        continue;
      }
      const tagName = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(i, i + 64))?.[1]?.toLowerCase();
      const gt = html.indexOf('>', i);
      if (gt < 0) break;
      if (tagName && OPAQUE_TAGS.has(tagName) && html[i + 1] !== '/') {
        const end = elementEnd(html, tagName, gt + 1);
        i = end ?? gt + 1;
        continue;
      }
      // A tag boundary separates words: "a<br>b" is "a b", never "ab".
      push(' ', i);
      i = gt + 1;
      continue;
    }
    if (ch === '&') {
      const semi = html.indexOf(';', i);
      if (semi > i && semi - i <= 10) {
        const decoded = decodeEntities(html.slice(i, semi + 1));
        for (const d of decoded) push(d, i);
        i = semi + 1;
        continue;
      }
    }
    push(ch, i);
    i++;
  }

  return { text, map };
}

function normalizeAnchor(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/** Byte offset in `html` where this schema string is rendered, or -1. */
function findAnchorOffset(idx: TextIndex, anchor: string): number {
  const needle = normalizeAnchor(anchor);
  if (needle.length < 12) return -1;
  const at = idx.text.indexOf(needle);
  if (at < 0) return -1;
  return idx.map[at] ?? -1;
}

/**
 * Byte offset where a schema string is rendered on the page, or -1.
 *
 * Exported only so this can be tested directly. It is where the schema pass
 * silently failed on a real page — every anchor missed, nothing was repaired,
 * and the log said `repaired: []` with no indication why.
 */
export function locateSchemaText(html: string, text: string): number {
  if (!html || !text) return -1;
  return findAnchorOffset(buildTextIndex(html), text);
}

/**
 * Strings from a section's schema entry that are worth searching for.
 * Longest first: a 40-character headline identifies a section, "Home" does not.
 */
function anchorsFromSchemaValue(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    const t = value.trim();
    // Long enough to be distinctive, short enough to survive minor edits.
    if (t.length >= 12 && t.length <= 300) out.push(t);
  } else if (Array.isArray(value)) {
    for (const v of value) anchorsFromSchemaValue(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) anchorsFromSchemaValue(v, out);
  }
  return out;
}

/**
 * Grow outwards from a match to the element that contains it.
 *
 * Depth-aware, so a <section> holding another <section> does not cut the wrap
 * short. Returns null rather than guessing when tags are unbalanced.
 */
function enclosingElementSpan(html: string, at: number): [number, number] | null {
  let best: [number, number] | null = null;

  for (const tag of SECTION_TAGS) {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    let m: RegExpExecArray | null;
    let candidate: number | null = null;
    // The last opening tag before our match is the innermost one containing it.
    while ((m = openRe.exec(html))) {
      if (m.index > at) break;
      candidate = m.index;
    }
    if (candidate === null) continue;

    const openEnd = html.indexOf('>', candidate) + 1;
    if (openEnd <= 0) continue;

    const close = elementEnd(html, tag, openEnd);
    if (close === null || close <= at) continue;

    // Widest span that still contains the anchor wins — a section is the outer
    // block, not the inner <div> the headline happens to sit in.
    if (!best || candidate < best[0]) best = [candidate, close];
  }
  return best;
}

// ── Pass 0: undo a marker that swallowed the page ───────────────────────────

/**
 * Remove any marker pair that CONTAINS another marker pair.
 *
 * Nesting is not a judgement call — it is against our own rule. The builder's
 * prompt says "Do NOT add SL markers inside sections — top level only", so a
 * marker wrapping other markers can only ever be a mistake, and the mistake is
 * always the OUTER one: the inner markers name real sections, the outer one
 * names whatever container happened to be around them.
 *
 * It exists because pages are already saved in that state. A page whose eight
 * sections ended up inside a ninth `SL:tfr-page` reads as ONE section, so every
 * edit fails with nothing for the user to do about it. Fixing `blockContainer`
 * stops new pages getting there; this un-does the ones that already are, on the
 * next turn, with no re-upload and no migration.
 *
 * Only the two comments are cut. Not one character of page content moves —
 * that is what makes this safe to run on every page, every time.
 *
 * It also cleans up a SECOND, unrelated source of nesting, and that one is
 * left to this pass ON PURPOSE. Our own builder emits `<!-- SL:head -->`
 * twice — the model hand-types markers from its prompt (ai-page-builder.ts,
 * "Section markers — REQUIRED") and types that one two lines running, so the
 * outer pair ends up spanning past `</head>`. Nothing in code writes SL:head,
 * so the only real fix is to take marker-writing away from the model in the
 * build path.
 *
 * Not worth it. The duplicate has no effect on anything — nothing reads the
 * outer pair, and this pass removes it on every load anyway, keeping the
 * correct inner pair. Rewriting how the builder emits markers to prevent a
 * defect that is already neutralised would risk the one path that currently
 * works, for no user-visible gain. Revisit only if the builder starts
 * duplicating markers that are NOT head.
 */
export function dropNestedMarkers(html: string): { html: string; dropped: string[] } {
  const dropped: string[] = [];
  if (!html) return { html, dropped };

  const cuts: Array<{ name: string; open: [number, number]; close: [number, number] }> = [];

  for (const open of Array.from(html.matchAll(/<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->/gi))) {
    const name = open[1];
    const innerStart = (open.index ?? 0) + open[0].length;
    const closeRe = new RegExp(`<!--\\s*\\/SL:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->`, 'i');
    const close = closeRe.exec(html.slice(innerStart));
    if (!close) continue; // Unclosed. Leave it; guessing where it ended is worse.

    const innerEnd = innerStart + close.index;
    if (!ANY_OPEN_MARKER.test(html.slice(innerStart, innerEnd))) continue;

    cuts.push({
      name,
      open: [open.index ?? 0, innerStart],
      close: [innerEnd, innerEnd + close[0].length],
    });
  }

  // Keep only cuts that do not overlap one another, outermost first.
  //
  // "Back to front keeps offsets valid" holds for cuts that sit side by side.
  // It does NOT hold when one cut's span contains another's: removing the inner
  // pair shortens the string, and the outer cut's CLOSE offset — which sits
  // after it — has moved. Slicing at the stale offset then eats live markup.
  //
  // That is not hypothetical. A real page carried its markers in triplicate
  // (head, hero, stats-proof, testimonials and footer each appearing three
  // times, from earlier saves that duplicated them). Pairing each opener with
  // the next matching closer produced overlapping spans, and the second cut
  // removed six characters of a real element: `<section class="ue-testimonials
  // -section">` came out as `<!-- SLon class="ue-testimonials-section">`. A
  // customer's page, corrupted by the pass whose entire job is repairing it.
  //
  // Dropping the overlaps rather than trying to be clever about them: one clean
  // level of un-nesting per load is enough, this function runs on every load,
  // and a page shaped badly enough to produce overlapping pairs is exactly the
  // page that should not be rewritten on a guess.
  const disjoint: typeof cuts = [];
  let lastEnd = -1;
  for (const cut of cuts.sort((a, b) => a.open[0] - b.open[0])) {
    if (cut.open[0] < lastEnd) continue;
    disjoint.push(cut);
    lastEnd = cut.close[1];
  }
  cuts.length = 0;
  cuts.push(...disjoint);

  // Back to front, so a cut never shifts an offset still to be used.
  let out = html;
  for (const cut of cuts.reverse()) {
    out = out.slice(0, cut.close[0]) + out.slice(cut.close[1]);
    out = out.slice(0, cut.open[0]) + out.slice(cut.open[1]);
    dropped.push(cut.name);
  }
  return { html: out, dropped: dropped.reverse() };
}

// ── Both passes, cheapest first ─────────────────────────────────────────────

/**
 * Wrap every section that has lost its markers.
 *
 * Never touches a section that already has them, never wraps inside an
 * existing pair, and skips anything it cannot place — `skipped` is returned so
 * a caller can log it rather than fail silently.
 */
export function repairSlMarkers(html: string, schema: unknown): MarkerRepair {
  const repaired: string[] = [];
  const skipped: string[] = [];
  if (!html) return { html, repaired, structural: [], skipped, unnested: [] };

  // Pass 0 — undo a marker that swallowed other sections. Runs FIRST because
  // both passes below read the page's existing markers to decide what is
  // already covered, and a swallowing marker makes the whole page look covered.
  const unnest = dropNestedMarkers(html);
  const source = unnest.html;

  // Pass 1 — the page's own structure. Needs no schema, so it runs even when
  // the schema is missing, stale, or (as on the page that prompted this) simply
  // has no entry for the blocks that are unmarked.
  const structuralPass = wrapTopLevelBlocks(source);
  let working = structuralPass.html;
  repaired.push(...structuralPass.wrapped);

  if (!schema || typeof schema !== 'object') {
    return {
      html: working,
      repaired,
      structural: structuralPass.wrapped,
      skipped,
      unnested: unnest.dropped,
    };
  }

  // Pass 2 — anything the schema names that is still unmarked.
  //
  // Scalars are fields, not sections: `brand_logo_url` and `vertical` sit at
  // the schema's top level next to real sections, and treating them as sections
  // put two names into every skipped-list that were never sections at all.
  const entries = Object.entries(schema as Record<string, unknown>).filter(
    ([name, value]) =>
      SAFE_NAME_RE.test(name) && name !== 'head' && !!value && typeof value === 'object',
  );

  type Edit = { start: number; end: number; name: string };
  const edits: Edit[] = [];
  const claimed: Array<[number, number]> = [];
  const idx = buildTextIndex(working);

  for (const [name, value] of entries) {
    if (hasMarker(working, name)) continue;

    const anchors = anchorsFromSchemaValue(value).sort((a, b) => b.length - a.length).slice(0, 6);
    let placed = false;

    for (const anchor of anchors) {
      const at = findAnchorOffset(idx, anchor);
      if (at < 0) continue;
      if (insideAnyMarker(working, at)) continue;
      const span = enclosingElementSpan(working, at);
      if (!span) continue;
      // Two sections must never claim the same element.
      if (claimed.some(([s, e]) => !(span[1] <= s || span[0] >= e))) continue;
      claimed.push(span);
      edits.push({ start: span[0], end: span[1], name });
      placed = true;
      break;
    }
    if (!placed) skipped.push(name);
  }

  if (edits.length === 0) {
    return {
      html: working,
      repaired,
      structural: structuralPass.wrapped,
      skipped,
      unnested: unnest.dropped,
    };
  }

  // Back to front, so an insertion never shifts an offset still to be used.
  edits.sort((a, b) => b.start - a.start);
  const fromSchema: string[] = [];
  for (const e of edits) {
    working = wrapAt(working, e.start, e.end, e.name);
    fromSchema.push(e.name);
  }
  repaired.push(...fromSchema.reverse());

  return {
      html: working,
      repaired,
      structural: structuralPass.wrapped,
      skipped,
      unnested: unnest.dropped,
    };
}

/**
 * How much of the page is addressable.
 *
 * The number nobody had: a page can render perfectly with two thirds of it
 * invisible to every edit, and the only symptom is edits that quietly do
 * nothing. Logged after a build so a short page is caught at the source rather
 * than by a user whose request went nowhere.
 */
export function markerCoverage(html: string): {
  blocks: number;
  marked: number;
  unmarked: string[];
} {
  if (!html) return { blocks: 0, marked: 0, unmarked: [] };
  const { from, to } = blockContainer(html);
  const unmarked: string[] = [];
  let blocks = 0;
  let marked = 0;

  for (const el of topLevelElements(html, from, to)) {
    if (!WRAPPABLE_TAGS.has(el.tag)) continue;
    if (el.innerEnd - el.innerStart < MIN_BLOCK_CHARS) continue;
    blocks++;
    if (insideAnyMarker(html, el.start)) marked++;
    else unmarked.push(nameForElement(el.openTag, el.tag) ?? el.tag);
  }

  return { blocks, marked, unmarked };
}

// ── Are the boxes any good? ─────────────────────────────────────────────────
//
// markerCoverage above answers "is every block INSIDE a box?" — and that turned
// out to be the wrong question. An Unbounce upload passed it cleanly and was
// still unusable, because Unbounce keeps its content in absolutely-positioned
// siblings rather than inside its wrapper divs. The 22 markers we stamped were:
//
//   lp-positioned-content   171,515 bytes   ← the entire page, in one box
//   head                     96,244 bytes   ← the stylesheet, as a "section"
//   stats / qualify / cta / footer / lp-element … ~188 bytes each, 19 of them
//                                           ← empty wrappers, no content at all
//
// Every block was inside a box, so coverage reported clean. Then the router was
// offered a box called "hero" that was empty, picked it (reasonably — it is the
// only box whose NAME matches "redesign the hero"), and the editing model, shown
// an empty div and asked for a hero, wrote a brand new one. Nothing had told
// anyone the box was a decoy.
//
// So this asks the two questions that actually matter, by counting — no AI, no
// class-name sniffing, nothing specific to one builder:
//
//   1. Is any box empty?           → a decoy the router can be lured into
//   2. Is one box hogging the page? → nothing else can be addressed separately
//
// `head` is exempt from both: prep deliberately marks the <style> block under
// that name (see schema-from-html's SYSTEM_PROMPT) so global CSS can be edited,
// and a stylesheet legitimately has no visible text.

/** The name prep gives the <style> block. Never a content box. */
const CSS_BOX_NAME = 'head';

/**
 * Below this a box has no text at all — not "not much text".
 *
 * Deliberately tiny. The first version used 15 characters and flagged a real
 * navigation bar (`Home` + `Pricing` = 12 characters) as an empty decoy, which
 * would have dropped the markers off the one section users ask about most. The
 * boxes this is hunting have literally nothing in them:
 *
 *   <div class="lp-element lp-pom-block" id="lp-pom-block-622">
 *     <div id="lp-pom-block-622-color-overlay"></div>
 *     <div class="lp-pom-block-content"></div>
 *   </div>
 *
 * Three characters, rather than zero, so a box holding a stray bullet, a
 * non-breaking space or a lone period is still recognised as empty.
 */
const MIN_BOX_TEXT_CHARS = 3;

/** Non-text content is worth roughly this much text when weighing a box. */
const MEDIA_WEIGHT = 250;

/** One box holding this much of the page means the rest cannot be reached. */
const DOMINANT_SHARE = 0.7;

/** Below this there is nothing for content to be spread ACROSS. */
const MIN_BOXES_TO_JUDGE = 3;

export interface SectionBox {
  name: string;
  /** Bytes between the markers. */
  bytes: number;
  /** Visible text characters, tags stripped and whitespace collapsed. */
  textChars: number;
  /** Images, video, iframes, form fields, CSS backgrounds — content that isn't text. */
  media: number;
  /** This box sits inside another box, so the router never offers it on its own. */
  nested: boolean;
  /** Nothing a user could see or edit. A decoy. */
  empty: boolean;
}

export interface MarkerQuality {
  boxes: SectionBox[];
  /** Names of boxes with no content in them. */
  empty: string[];
  /** The one box holding most of the page, if there is one. */
  dominant: { name: string; share: number } | null;
  /** Nothing wrong found. A page with 0-2 boxes is always ok — see above. */
  ok: boolean;
}

interface SectionSpan {
  name: string;
  /** Byte range of the whole thing, opening comment through closing comment. */
  outerStart: number;
  outerEnd: number;
  /** Byte range between the comments. */
  innerStart: number;
  innerEnd: number;
}

/**
 * Every <!-- SL:name --> pair on the page, nesting included.
 *
 * Pairs by NAME rather than by scanning forwards to the next close comment,
 * because a box can legitimately contain another box, and the non-greedy regex
 * the routes use for reading sections would then hand back the outer box only —
 * fine for editing, useless for finding a decoy hidden one level down.
 *
 * Names are unique per page by construction (`uniqueName` here, `usedNames` in
 * schema-from-html), so first-open/first-matching-close is unambiguous. An open
 * marker with no close is skipped rather than guessed at.
 */
function sectionSpans(html: string): SectionSpan[] {
  const spans: SectionSpan[] = [];
  const openRe = /<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html))) {
    const name = m[1];
    const closeRe = new RegExp(`<!--\\s*/SL:${name}\\s*-->`, 'g');
    closeRe.lastIndex = m.index + m[0].length;
    const close = closeRe.exec(html);
    if (!close) continue;
    spans.push({
      name,
      outerStart: m.index,
      outerEnd: close.index + close[0].length,
      innerStart: m.index + m[0].length,
      innerEnd: close.index,
    });
  }
  return spans;
}

/** Tags that put something on screen without contributing any text. */
const MEDIA_RE = /<(?:img|iframe|video|audio|canvas|picture|source|input|select|textarea|svg)\b/gi;
const CSS_BACKGROUND_RE = /background(?:-image)?\s*:\s*[^;"']*url\s*\(/gi;

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

function visibleTextChars(inner: string): string {
  return inner
    // Opaque subtrees are not visible text — a box holding only a <script> is empty.
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Whitespace entities are whitespace. Padding a box with &nbsp; does not
    // put anything in it, and counting each one as a visible character was
    // enough to make a spacer div look like real content.
    .replace(/&(nbsp|ensp|emsp|thinsp|zwnj|zwj|#160|#xa0|#xA0);/gi, ' ')
    // Any other entity renders as one glyph — an arrow, a dash, a symbol.
    .replace(/&[a-z#0-9]+;/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Measure the boxes on a page: are any of them empty, is one of them the page?
 *
 * Pure counting. Logged everywhere markers are written (build, follow-up, prep)
 * so a bad map is visible at the source, and acted on only at prep — the schema,
 * the click-to-edit fields and the chat history are all keyed to section names,
 * so re-cutting boxes mid-conversation would break a live page.
 */
export function markerQuality(html: string): MarkerQuality {
  const spans = sectionSpans(html);
  const boxes: SectionBox[] = spans.map((s) => {
    const inner = html.slice(s.innerStart, s.innerEnd);
    const text = visibleTextChars(inner);
    const media =
      countMatches(inner, MEDIA_RE) + countMatches(inner, CSS_BACKGROUND_RE);
    const nested = spans.some(
      (o) => o !== s && o.outerStart < s.outerStart && o.outerEnd > s.outerEnd,
    );
    return {
      name: s.name,
      bytes: s.innerEnd - s.innerStart,
      textChars: text.length,
      media,
      nested,
      empty:
        s.name !== CSS_BOX_NAME && text.length < MIN_BOX_TEXT_CHARS && media === 0,
    };
  });

  const empty = boxes.filter((b) => b.empty).map((b) => b.name);

  // Dominance is judged on the boxes the router is actually offered: top-level
  // ones, minus the stylesheet box.
  const offered = boxes.filter((b) => !b.nested && b.name !== CSS_BOX_NAME);
  const weight = (b: SectionBox) => b.textChars + b.media * MEDIA_WEIGHT;
  const total = offered.reduce((sum, b) => sum + weight(b), 0);
  let dominant: { name: string; share: number } | null = null;
  if (offered.length >= MIN_BOXES_TO_JUDGE && total > 0) {
    const top = offered.reduce((a, b) => (weight(b) > weight(a) ? b : a));
    const share = weight(top) / total;
    if (share >= DOMINANT_SHARE) dominant = { name: top.name, share };
  }

  // A one- or two-box page has nothing to spread content across, and an
  // uploaded fragment legitimately IS one block. Not a fault.
  const ok = offered.length < MIN_BOXES_TO_JUDGE
    ? empty.length === 0
    : empty.length === 0 && dominant === null;

  return { boxes, empty, dominant, ok };
}

/**
 * Remove the markers around boxes that hold nothing.
 *
 * This is the decoy fix, and it is deliberately the ONLY thing that rewrites a
 * box — called from prep alone, before the page has a schema, a chat history, or
 * any click-to-edit field keyed to a section name.
 *
 * Dropping a pair does not change the page: the element stays exactly where it
 * was, byte for byte, it simply stops being offered as somewhere an edit could
 * land. That is the whole point — an empty box is a name with nothing behind it,
 * and the router picking one is how a hero got written into a 188-byte
 * `<div class="lp-pom-block">` and stacked on top of the real page.
 *
 * Never drops everything: if the empty boxes are all there is, they are left
 * alone so the page keeps at least one addressable section (a page with no
 * markers at all forces every future edit into a full-page rewrite, which is a
 * different and worse failure — see schema-from-html's no-sections guard).
 */
export function dropEmptySectionMarkers(html: string): { html: string; dropped: string[] } {
  if (!html) return { html, dropped: [] };
  const spans = sectionSpans(html);
  if (spans.length === 0) return { html, dropped: [] };

  const quality = markerQuality(html);
  const emptyNames = new Set(quality.empty);
  if (emptyNames.size === 0) return { html, dropped: [] };

  // At least one box that isn't the stylesheet has to survive. Otherwise the
  // page ends up with `head` as its only addressable section, and every future
  // chat edit is forced into a full-page rewrite — slower, more expensive, and
  // far more destructive than the empty boxes we were trying to remove.
  const survivors = spans.filter(
    (s) => !emptyNames.has(s.name) && s.name !== CSS_BOX_NAME,
  );
  if (survivors.length === 0) return { html, dropped: [] };

  // Every byte range to delete, all computed against the ORIGINAL string, then
  // merged and applied in one pass. Two empty boxes can be nested inside each
  // other, so editing them one at a time would leave the outer box's offsets
  // pointing into a string that had already shifted underneath it.
  //
  // The newline each marker was written with (see wrapAt) is swallowed along
  // with it, so removing a pair leaves the source exactly as it was rather than
  // a blank line — and only when it is actually there, since minified pages get
  // markers with no newlines at all.
  const cuts: Array<[number, number]> = [];
  for (const s of spans) {
    if (!emptyNames.has(s.name)) continue;
    cuts.push([s.outerStart, html[s.innerStart] === '\n' ? s.innerStart + 1 : s.innerStart]);
    cuts.push([html[s.innerEnd - 1] === '\n' ? s.innerEnd - 1 : s.innerEnd, s.outerEnd]);
  }
  cuts.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut[0] <= last[1]) last[1] = Math.max(last[1], cut[1]);
    else merged.push([cut[0], cut[1]]);
  }

  let out = '';
  let at = 0;
  for (const [start, end] of merged) {
    out += html.slice(at, start);
    at = end;
  }
  out += html.slice(at);

  return { html: out, dropped: Array.from(emptyNames) };
}

/**
 * Shared HTML probes for skill checks.
 *
 * Regex, not a DOM. We have no layout engine and no parser in this path, so
 * every helper here answers a question that is genuinely answerable from the
 * source text, and anything that is not (what is visually above the fold, what
 * a colour contrasts against once rendered) is either approximated with an
 * honest label or not asked at all.
 */

/** Strip <style>/<script> so their text can't be mistaken for page content. */
export function stripCode(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
}

/** Just the CSS the page ships, concatenated. */
export function styleText(html: string): string {
  return Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    .map((m) => m[1])
    .join('\n');
}

export interface CtaLink {
  tag: string;
  href: string | null;
  text: string;
  index: number;
}

const CTA_WORDS =
  /\b(get|start|book|buy|shop|join|sign\s?up|signup|subscribe|request|claim|try|schedule|order|apply|download|contact|call|reserve|enroll|register|talk to|demo|quote|estimate|consultation)\b/i;

/**
 * Anchors and buttons that read as a call to action.
 *
 * Deliberately narrow: a nav link labelled "Pricing" is not a CTA, and counting
 * it would inflate every CTA number on every page. Anything carrying a CTA-ish
 * verb, or a class the builder itself uses for buttons, counts.
 */
export function findCtas(html: string): CtaLink[] {
  const body = stripCode(html);
  const out: CtaLink[] = [];
  const re = /<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const attrs = m[2] ?? '';
    const text = m[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const classAttr = /class\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
    const looksButton = /\b(btn|button|cta)\b/i.test(classAttr) || m[1].toLowerCase() === 'button';
    if (!looksButton && !CTA_WORDS.test(text)) continue;
    // A nav bar full of styled links is not five CTAs.
    if (text.length > 60) continue;
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? null;
    out.push({ tag: m[1].toLowerCase(), href, text, index: m.index });
  }
  return out;
}

/**
 * The first screenful, approximated as "everything before the second SL
 * section marker", falling back to the first 20% of the document.
 *
 * This is NOT the fold. Nothing here renders, measures or scrolls anything.
 * Every label built on this must say "hero block", never "above the fold".
 */
export function heroRegion(html: string): { start: number; end: number } {
  const markers = Array.from(html.matchAll(/<!--\s*SL:[a-z0-9_-]+\s*-->/gi)).map((m) => m.index ?? 0);
  if (markers.length >= 2) return { start: 0, end: markers[1] };
  const bodyStart = html.search(/<body\b/i);
  return { start: bodyStart >= 0 ? bodyStart : 0, end: Math.floor(html.length * 0.2) };
}

export interface ImgTag {
  raw: string;
  index: number;
  attrs: string;
}

export function findImages(html: string): ImgTag[] {
  return Array.from(html.matchAll(/<img\b([^>]*)>/gi)).map((m) => ({
    raw: m[0],
    index: m.index ?? 0,
    attrs: m[1] ?? '',
  }));
}

export function hasAttr(attrs: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*=\\s*["'][^"']*["']`, 'i').test(attrs);
}

export function attrValue(attrs: string, name: string): string | null {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)?.[1] ?? null;
}

/**
 * An <img> sized by CSS (aspect-ratio, an explicit height, or object-fit in a
 * fixed box) does not shift layout either, so a missing width/height attribute
 * is only a real CLS risk when the inline style says nothing about size.
 */
export function imageIsSized(attrs: string): boolean {
  if (hasAttr(attrs, 'width') && hasAttr(attrs, 'height')) return true;
  const style = attrValue(attrs, 'style') ?? '';
  return /aspect-ratio\s*:/i.test(style) || (/height\s*:/i.test(style) && /width\s*:/i.test(style));
}

export function bytes(html: string): number {
  // TextEncoder, not Buffer — this module is imported by the skill registry,
  // which the builder UI also imports for its cards. Buffer is not a browser
  // global and would only blow up if a check ever ran client-side.
  return new TextEncoder().encode(html).length;
}

export function formatKb(n: number): string {
  return `${Math.round(n / 1024)} KB`;
}

/** Distinct declared values for a CSS property, e.g. border-radius. */
export function distinctCssValues(css: string, property: string): string[] {
  const re = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'gi');
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const v = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    if (!v || v === '0' || v === 'none' || v === 'inherit' || v === 'initial') continue;
    seen.add(v);
  }
  return Array.from(seen);
}

/**
 * The name on the nearest <!-- SL:name --> marker at or before a position.
 *
 * Lets a check ask "what section is this thing in?" without a parser. Returns
 * null for anything sitting above the first marker (the <head>, the nav).
 */
export function sectionNameAt(html: string, index: number): string | null {
  const re = /<!--\s*SL:([a-z0-9_-]+)\s*-->/gi;
  let name: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if ((m.index ?? 0) > index) break;
    name = m[1];
  }
  return name;
}

export interface FormField {
  tag: string;
  attrs: string;
  index: number;
  /** Lowercased type attribute; 'textarea'/'select' for those tags. */
  type: string;
  name: string;
  id: string;
}

/** Field types that are never user-facing and must not be judged as fields. */
const NON_INPUT_TYPES = /^(hidden|submit|button|image|reset)$/i;

/**
 * Every user-facing form control on the page.
 *
 * A hidden tracking field or the submit button itself is not something a
 * visitor labels, autofills or types into, so counting them would make every
 * form look longer and less accessible than it is.
 */
export function findFormFields(html: string): FormField[] {
  const body = stripCode(html);
  const out: FormField[] = [];
  const re = /<(input|select|textarea)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const type =
      tag === 'input' ? (attrValue(attrs, 'type') ?? 'text').toLowerCase() : tag;
    if (tag === 'input' && NON_INPUT_TYPES.test(type)) continue;
    out.push({
      tag,
      attrs,
      index: m.index ?? 0,
      type,
      name: attrValue(attrs, 'name') ?? '',
      id: attrValue(attrs, 'id') ?? '',
    });
  }
  return out;
}

/** ids referenced by a <label for="...">. */
export function labelledIds(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of Array.from(html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi))) {
    out.add(m[1]);
  }
  return out;
}

/** [start, end] spans of every <label>...</label>, for wrapping-label detection. */
export function labelRanges(html: string): Array<[number, number]> {
  return Array.from(html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)).map((m) => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);
}

/**
 * Whether a field is named to something a visitor recognises.
 *
 * We look at name/id/placeholder/aria-label together because the builder is
 * free to use any one of them, and a field called "user_tel" is a phone field
 * whichever attribute carries the word.
 */
export function fieldPurposeText(f: FormField): string {
  return [f.name, f.id, attrValue(f.attrs, 'placeholder') ?? '', attrValue(f.attrs, 'aria-label') ?? '']
    .join(' ')
    .toLowerCase();
}

/** Void elements never have children, so a scanner must not wait for a close tag. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Direct element children of the element whose opening tag ends at `openEnd`,
 * plus whether the scan closed cleanly.
 *
 * Used by the grid-placement check: a grid row with more direct children than
 * it has column tracks silently wraps the overflow children into the FIRST
 * track, which on an icon/number + text row means a paragraph rendered at the
 * icon's width. Counting children needs real nesting depth, not a regex.
 *
 * Returns `balanced: false` when the markup runs out before the element
 * closes — the caller should then skip rather than report on a bad parse.
 */
export function directChildTags(
  html: string,
  openEnd: number,
  tagName: string,
): { children: string[]; balanced: boolean } {
  const children: string[] = [];
  const TAG = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  TAG.lastIndex = openEnd;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html))) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClosing = m[3].trimEnd().endsWith('/') || VOID_TAGS.has(name);
    if (closing) {
      if (depth === 0) return { children, balanced: name === tagName.toLowerCase() };
      depth--;
      continue;
    }
    if (depth === 0) children.push(name);
    if (!selfClosing) depth++;
  }
  return { children, balanced: false };
}

/**
 * Column track count for a `grid-template-columns` value, or null when the
 * track count is not statically knowable (repeat(auto-fit/auto-fill), subgrid,
 * a var() the value depends on).
 */
export function gridTrackCount(value: string): number | null {
  const v = value.trim();
  if (!v || /subgrid|auto-fit|auto-fill|var\(/i.test(v)) return null;
  // Expand a literal repeat(N, tracks) before counting.
  const expanded = v.replace(/repeat\(\s*(\d+)\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)/gi, (_all, n, tracks) =>
    Array.from({ length: Number(n) }, () => tracks.trim()).join(' '),
  );
  // Tokenise on whitespace that is not inside brackets — minmax(0,1fr) is one track.
  const tokens = expanded.match(/(?:[^\s()[\]]+(?:\([^()]*\))?|\[[^\]]*\])/g) ?? [];
  const tracks = tokens.filter((t) => !t.startsWith('['));
  return tracks.length || null;
}

/**
 * Turns a user prompt into machine-checkable requirements, enforces the ones we
 * can apply deterministically, and reports which ones actually landed.
 *
 * Why this exists: success used to mean "the HTML string changed and contains
 * certain substrings". That let a page ship with a dead logo, a CTA the user
 * explicitly banned, and a section they asked to delete — all while the UI said
 * "Done!". Requirements are prompt-agnostic (typed, not per-feature regexes) so
 * a request the code has never seen still gets checked rather than trusted.
 *
 * Deliberately conservative: only requirements we can verify from the HTML are
 * emitted. Taste ("make it premium") is not a requirement — it can't be checked,
 * and inventing a check for it would just produce false failures.
 */

export type RequirementKind =
  | 'no_cta'
  | 'asset_present'
  | 'text_present'
  | 'element_absent'
  | 'section_absent'
  | 'color_applied'
  | 'section_changed';

export interface PageRequirement {
  kind: RequirementKind;
  /** Human-readable ask, shown to the user when it fails. */
  label: string;
  /** URL / phrase / hex / section name depending on kind. */
  value?: string;
  /** SL section names this applies to; empty = whole page. */
  sections?: string[];
  /** For color_applied: the color the user actually named ("blue", "#0f2540"). */
  colorName?: string;
}

export interface RequirementResult {
  requirement: PageRequirement;
  passed: boolean;
}

const CTA_BAN_RE =
  /\b(no (buttons?|calls? to action|ctas?|links?)|without (any )?(buttons?|ctas?)|remove (all )?(the )?(buttons?|ctas?)|nothing else (is )?(required|needed)|no clickable)\b/i;

/**
 * Fallback hex per color word, plus the hue window we accept as "that color".
 * The window is what makes the check general: when the user says blue we verify
 * the applied background is actually in the blue range, instead of the old
 * "anything that isn't white" test which would have passed a green nav.
 * Achromatic words (black/white/grey) are judged on lightness, not hue.
 */
const NAMED_COLORS: Record<
  string,
  { hex: string; hue?: [number, number]; lightness?: [number, number]; minSaturation?: number }
> = {
  blue: { hex: '#1e3a5f', hue: [185, 260], minSaturation: 0.12 },
  navy: { hex: '#0f2540', hue: [195, 260], minSaturation: 0.12 },
  teal: { hex: '#0f766e', hue: [160, 200], minSaturation: 0.12 },
  green: { hex: '#146c43', hue: [85, 165], minSaturation: 0.12 },
  yellow: { hex: '#ca8a04', hue: [40, 70], minSaturation: 0.15 },
  orange: { hex: '#c2410c', hue: [18, 45], minSaturation: 0.15 },
  red: { hex: '#b02a37', hue: [340, 15], minSaturation: 0.15 },
  pink: { hex: '#be185d', hue: [300, 345], minSaturation: 0.12 },
  purple: { hex: '#5b21b6', hue: [255, 305], minSaturation: 0.12 },
  black: { hex: '#000000', lightness: [0, 0.22] },
  white: { hex: '#ffffff', lightness: [0.9, 1] },
  grey: { hex: '#4b5563', lightness: [0.22, 0.9], minSaturation: 0 },
  gray: { hex: '#4b5563', lightness: [0.22, 0.9], minSaturation: 0 },
};

/**
 * Quote-delimited spans in a prompt, by quote family.
 *
 * A straight apostrophe only counts as a delimiter when both ends sit on a word
 * boundary. Treating every `'` as a quote pairs the apostrophe in `That's` with
 * one in a later word: the prompt
 *   …during your call time.” That's pretty much it. Use the logo, use the same…
 * yielded the span “s pretty much it. Use the logo, use the same co…”, which was
 * then shown to the user as a required copy line that never landed.
 */
export function extractQuotedSpans(prompt: string, min = 3, max = 400): string[] {
  const out: string[] = [];
  const len = `{${min},${max}}`;
  const patterns = [
    new RegExp(`"([^"\\n]${len})"`, 'g'),
    new RegExp(`“([^”\\n]${len})”`, 'g'),
    new RegExp(`‘([^’\\n]${len})’`, 'g'),
    new RegExp(`(?:^|[\\s(\\[])'([^'\\n]${len})'(?=$|[\\s.,;:!?)\\]])`, 'g'),
  ];
  for (const re of patterns) {
    for (const m of Array.from(prompt.matchAll(re))) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (t.length >= min) out.push(t);
    }
  }
  return Array.from(new Set(out));
}

/** Quoted copy the user expects to see verbatim on the page. */
export function extractQuotedPhrases(prompt: string): string[] {
  return extractQuotedSpans(prompt, 8, 220).slice(0, 6);
}

/**
 * The floor: assets WE decided to embed must actually be in the HTML.
 *
 * This is the only requirement code should invent on its own, because it is the
 * only one that doesn't involve guessing what the user meant — we put the URL
 * there, so it had better be there. Everything else comes from the model that
 * read the request (see REQUIREMENT_EXTRACTION_INSTRUCTION).
 */
export function assetRequirements(assetUrls: string[]): PageRequirement[] {
  return Array.from(new Set(assetUrls.filter((u) => !!u))).map((url) => ({
    kind: 'asset_present' as const,
    label: 'the real logo/image is on the page',
    value: url,
  }));
}

/**
 * Build the requirement list for a prompt.
 *
 * `knownSections` lets removal asks bind to real SL section names instead of
 * guessing; `assetUrls` are assets we intend to embed (already verified).
 *
 * DEAD — no live callers. The "kept for the create path's CTA ban" note below
 * is stale: generate/build now use the model's own `requirements` checklist and
 * never call this. It survives only for the verify suites.
 *
 * Prefer the model's checklist plus `assetRequirements` for new call sites: the
 * prompt-derived checks here guess intent from wording, which is how a design
 * screenshot's own headline became "required copy" on a page whose text the user
 * had explicitly replaced.
 *
 * Do not revive. A wrong requirement is worse than a missing one — it fails a
 * correct edit and throws real work away.
 */
export function extractRequirements(opts: {
  prompt: string;
  knownSections?: string[];
  assetUrls?: string[];
  designCopyLines?: string[];
}): PageRequirement[] {
  const { prompt, assetUrls = [], designCopyLines = [] } = opts;
  const reqs: PageRequirement[] = [];

  if (CTA_BAN_RE.test(prompt)) {
    reqs.push({ kind: 'no_cta', label: 'no buttons / calls to action on the page' });
  }

  for (const url of assetUrls) {
    reqs.push({
      kind: 'asset_present',
      label: 'the real logo/image is on the page',
      value: url,
    });
  }

  for (const phrase of extractQuotedPhrases(prompt)) {
    reqs.push({ kind: 'text_present', label: `the copy “${truncate(phrase)}” appears`, value: phrase });
  }

  // Design-screenshot OCR: a sample is enough to prove the reference landed,
  // and requiring every line would fail on chrome the model reasonably drops.
  for (const line of designCopyLines.slice(0, 4)) {
    reqs.push({
      kind: 'text_present',
      label: `screenshot copy “${truncate(line)}” appears`,
      value: line,
    });
  }

  const colorAsk = detectThemeColorAsk(prompt);
  if (colorAsk) {
    reqs.push({
      kind: 'color_applied',
      label: `${colorAsk.sections.join(' / ')} are ${colorAsk.colorName}`,
      value: colorAsk.hex,
      sections: colorAsk.sections,
      colorName: colorAsk.colorName,
    });
  }

  return dedupe(reqs);
}

/**
 * "keep the nav and footer blue" → the sections plus a hex to look for.
 * Only fires when a color word and a page part appear together, so ordinary
 * copy mentioning a color doesn't create a bogus requirement.
 */
export function detectThemeColorAsk(
  prompt: string,
): { sections: string[]; hex: string; colorName: string } | null {
  // An explicit hex in the prompt always wins over a color word.
  const hexMatch = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(prompt);
  const colorMatch = new RegExp(`\\b(${Object.keys(NAMED_COLORS).join('|')})\\b`, 'i').exec(prompt);
  if (!hexMatch && !colorMatch) return null;
  const partRe = /\b(nav(?:igation)?(?:\s*bar)?|navbar|header|footer|hero|background)\b/gi;
  const parts = Array.from(prompt.matchAll(partRe)).map((m) => normalizePart(m[1]));
  if (parts.length === 0) return null;
  const colorName = hexMatch ? hexMatch[0].toLowerCase() : colorMatch![1].toLowerCase();
  return {
    sections: Array.from(new Set(parts)),
    hex: hexMatch ? hexMatch[0] : NAMED_COLORS[colorName].hex,
    colorName,
  };
}

function normalizePart(raw: string): string {
  const t = raw.toLowerCase();
  if (/nav/.test(t) || /header/.test(t)) return 'nav';
  if (/footer/.test(t)) return 'footer';
  if (/hero/.test(t)) return 'hero';
  return t;
}

/** Anchor/button elements that read as CTAs (not plain inline text links). */
const CTA_ELEMENT_RE =
  /<(a|button)\b[^>]*>[\s\S]*?<\/\1>/gi;

function looksLikeCta(tag: string): boolean {
  // Logos and icons are almost always wrapped in a styled <a> — stripping those
  // as "buttons" would delete the brand mark the user explicitly asked for.
  if (/<(img|svg)\b/i.test(tag)) return false;
  if (/^<button\b/i.test(tag)) return true;
  if (/\b(class|style)=["'][^"']*\b(btn|button|cta)\b/i.test(tag)) return true;
  if (/style=["'][^"']*(background(-color)?\s*:\s*(?!transparent|none|inherit)[^;"']+)/i.test(tag)) {
    // A padded, colored anchor is a button in everything but tag name.
    return /padding\s*:/i.test(tag) || /border-radius\s*:/i.test(tag);
  }
  return false;
}

/**
 * Remove CTA buttons when the user banned them. Plain text links (privacy,
 * terms) survive — deleting those would break footers users still want.
 */
export function stripCtaElements(html: string): { html: string; removed: number } {
  let removed = 0;
  const out = html.replace(CTA_ELEMENT_RE, (tag) => {
    if (!looksLikeCta(tag)) return tag;
    removed++;
    return '';
  });
  return { html: out, removed };
}

export function pageHasCta(html: string): boolean {
  for (const m of Array.from(html.matchAll(CTA_ELEMENT_RE))) {
    if (looksLikeCta(m[0])) return true;
  }
  return false;
}

function sectionInner(html: string, sectionName: string): string | null {
  const esc = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<!--\\s*SL:${esc}\\s*-->([\\s\\S]*?)<!--\\s*/SL:${esc}\\s*-->`, 'i');
  const m = re.exec(html);
  if (m) return m[1];
  if (/footer/i.test(sectionName)) {
    return /<footer\b[^>]*>[\s\S]*?<\/footer>/i.exec(html)?.[0] ?? null;
  }
  if (/nav|header/i.test(sectionName)) {
    return /<(header|nav)\b[^>]*>[\s\S]*?<\/\1>/i.exec(html)?.[0] ?? null;
  }
  return null;
}

/**
 * The background color a section actually renders, resolving var() references
 * against :root so a themed section isn't reported as unstyled.
 */
function sectionBackgroundColor(inner: string, fullHtml: string): string | null {
  const bg = /background(?:-color)?\s*:\s*([^;"']+)/gi;
  for (const m of Array.from(inner.matchAll(bg))) {
    const val = m[1].trim();
    if (/^(transparent|none|inherit|initial)$/i.test(val)) continue;

    const varRef = /var\(\s*(--[a-z0-9-]+)/i.exec(val);
    if (varRef) {
      const resolved = resolveCssVar(fullHtml, varRef[1]);
      if (resolved) return resolved;
      continue;
    }
    if (parseCssColor(val)) return val;
  }
  return null;
}

function resolveCssVar(html: string, name: string): string | null {
  const root = /:root\s*{([\s\S]*?)}/i.exec(html)?.[1] ?? '';
  const m = new RegExp(`${name}\\s*:\\s*([^;]+)`, 'i').exec(root);
  return m ? m[1].trim() : null;
}

/** Parse any CSS color we can reasonably meet in generated HTML. */
export function parseCssColor(raw: string): { r: number; g: number; b: number } | null {
  const c = raw.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .slice(0, 3)
        .split('')
        .map((ch) => ch + ch)
        .join('');
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }

  const basic: Record<string, string> = {
    white: '#ffffff',
    black: '#000000',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    navy: '#000080',
    teal: '#008080',
    orange: '#ffa500',
    purple: '#800080',
    pink: '#ffc0cb',
    yellow: '#ffff00',
    grey: '#808080',
    gray: '#808080',
  };
  if (basic[c]) return parseCssColor(basic[c]);
  return null;
}

/** Hue in degrees, saturation and lightness in 0..1. */
export function toHsl(rgb: { r: number; g: number; b: number }): {
  h: number;
  s: number;
  l: number;
} {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/**
 * Does this color read as the color the user named? Hue windows wrap around 0
 * so "red" spans both ends of the wheel.
 */
export function colorMatchesName(color: string, colorName: string): boolean {
  const spec = NAMED_COLORS[colorName.toLowerCase()];
  const rgb = parseCssColor(color);
  if (!rgb) return false;

  // Prompt gave a literal hex — compare by hue/lightness rather than channel
  // distance, which rates a green and a navy as "close" once you add up
  // channels that happen to differ in opposite directions.
  if (!spec) {
    const target = parseCssColor(colorName);
    if (!target) return false;
    const a = toHsl(rgb);
    const b = toHsl(target);
    if (Math.abs(a.l - b.l) > 0.25) return false;
    // Near-greys have no meaningful hue — judge them on lightness alone.
    if (a.s < 0.1 || b.s < 0.1) return Math.abs(a.s - b.s) <= 0.2;
    const hueGap = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
    return hueGap <= 25;
  }

  const { h, s, l } = toHsl(rgb);
  if (spec.lightness) {
    const [lo, hi] = spec.lightness;
    if (l < lo || l > hi) return false;
    if (spec.hue === undefined && (colorName === 'grey' || colorName === 'gray')) {
      return s <= 0.2;
    }
    return true;
  }
  if (spec.minSaturation !== undefined && s < spec.minSaturation) return false;
  if (!spec.hue) return true;
  const [lo, hi] = spec.hue;
  return lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi;
}

/** Near-white backgrounds are never a useful "theme" color to copy from. */
function isWhitish(color: string): boolean {
  const rgb = parseCssColor(color);
  if (!rgb) return false;
  return toHsl(rgb).l >= 0.9;
}

/**
 * The page's own dominant band color — used when the user says "follow the
 * theme" instead of naming a hex. Prefers design-system variables, then falls
 * back to the most frequently used non-white background on the page.
 */
export function extractThemeBackgroundColor(html: string): string | null {
  const root = /:root\s*{([\s\S]*?)}/i.exec(html)?.[1] ?? '';
  const preferred = [
    '--color-primary',
    '--primary',
    '--color-brand',
    '--brand',
    '--bg-dark',
    '--color-bg-dark',
    '--surface-dark',
    '--color-surface',
  ];
  for (const name of preferred) {
    const m = new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{3,8}|rgba?\\([^)]+\\))`, 'i').exec(root);
    if (m && !isWhitish(m[1])) return m[1].trim();
  }

  const counts = new Map<string, number>();
  for (const m of Array.from(
    html.matchAll(/background(?:-color)?\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/gi),
  )) {
    const val = m[1].trim();
    if (isWhitish(val)) continue;
    counts.set(val, (counts.get(val) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

function withBackgroundStyle(openTag: string, color: string, overwrite = false): string {
  if (/\bstyle=["'][^"']*background/i.test(openTag)) {
    // A white nav already declares a background, so "leave it alone" would make
    // the fix a no-op — replace the declared value instead.
    if (!overwrite) return openTag;
    return openTag.replace(
      /background(-color)?\s*:\s*[^;"']+/i,
      `background$1:${color}`,
    );
  }
  if (/\bstyle=["']/i.test(openTag)) {
    return openTag.replace(/\bstyle=["']/i, (m) => `${m}background:${color};`);
  }
  return openTag.replace(/^<([a-z0-9]+)/i, (_m, tag: string) => `<${tag} style="background:${color};"`);
}

/**
 * Give a named section a real background when the user asked for one and the
 * model left it white. Applied to the section's own wrapper so it spans the
 * full band rather than tinting a single child.
 */
export function applyBackgroundToSection(
  html: string,
  sectionName: string,
  color: string,
  opts: { overwrite?: boolean } = {},
): string {
  const { overwrite = false } = opts;
  const esc = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slRe = new RegExp(`(<!--\\s*SL:${esc}\\s*-->)([\\s\\S]*?)(<!--\\s*/SL:${esc}\\s*-->)`, 'i');
  const sl = slRe.exec(html);
  if (sl) {
    const inner = sl[2];
    // When replacing a wrong color, patch the element that actually declares
    // the background. Styling the wrapper instead just leaves the old color on
    // a child, where it still wins visually while the check reads as fixed.
    const declared = overwrite
      ? /<(?:div|section|header|nav|footer|aside|main)\b[^>]*style=["'][^"']*background[^"']*["'][^>]*>/i.exec(
          inner,
        )
      : null;
    const container = declared ?? /<(div|section|header|nav|footer|aside|main)\b[^>]*>/i.exec(inner);
    if (container && container.index !== undefined) {
      const patchedTag = withBackgroundStyle(container[0], color, overwrite);
      if (patchedTag === container[0]) return html;
      const nextInner =
        inner.slice(0, container.index) +
        patchedTag +
        inner.slice(container.index + container[0].length);
      return html.replace(slRe, () => `${sl[1]}${nextInner}${sl[3]}`);
    }
    return html.replace(
      slRe,
      () => `${sl[1]}<div style="background:${color};">${inner}</div>${sl[3]}`,
    );
  }

  const tagName = /footer/i.test(sectionName) ? 'footer' : /nav|header/i.test(sectionName) ? '(header|nav)' : null;
  if (!tagName) return html;
  const elRe = new RegExp(`<${tagName}\\b[^>]*>`, 'i');
  const el = elRe.exec(html);
  if (!el) return html;
  const patched = withBackgroundStyle(el[0], color, overwrite);
  if (patched === el[0]) return html;
  return html.slice(0, el.index) + patched + html.slice(el.index + el[0].length);
}

/** Check every requirement against the finished HTML. */
/**
 * Dropped into the system prompt of a call the flow already makes (the edit
 * router, the create schema pass), so the model writes its own checklist at no
 * extra latency.
 *
 * The model interprets — it understands "our footer should match the
 * screenshot" or "make the navbar text bigger" far better than any regex here
 * ever will. It does NOT get to grade itself: it only names what to check, and
 * `checkRequirements` does the checking against the real HTML.
 */
export const REQUIREMENT_EXTRACTION_INSTRUCTION = `"requirements": a list of the user's asks that can be MECHANICALLY verified in the final HTML. This is how we avoid telling the user "Done" when part of their request was silently dropped, so be thorough about real asks and silent about everything else.

Each item: { "kind": ..., "label": "<short human phrase, e.g. 'the logo is in the hero'>", "value": ..., "sections": ["<sl section name>"] }

Allowed kinds ONLY:
- "text_present" — value: exact copy that must appear on the page (verbatim wording the user gave, or wording you read off an attached screenshot).
- "asset_present" — value: an exact image/logo URL that must appear in an <img src>.
- "color_applied" — sections + "color_name" (e.g. "blue", "navy") for a background color the user asked for.
- "no_cta" — the user banned buttons / calls to action on the whole page.
- "section_absent" — value: an sl section name the user asked to delete.
- "element_absent" — value: an exact string that must NOT appear.
- "section_changed" — sections that MUST end up different from before. Use this for style/layout asks with nothing quotable: "make the navbar text bigger", "tighten the hero spacing", "make the footer match the screenshot".

Rules:
- Use section names EXACTLY as given in the section list. Never invent one.
- Emit nothing for taste ("make it premium", "cleaner") — unverifiable, and a fake check becomes a fake failure.
- Do not restate the same ask twice under different kinds.
- If the instruction has several parts, emit an item for EACH part — a multi-part request is where asks get dropped.
- Empty list is correct when nothing is mechanically checkable.`;

const ALLOWED_KINDS = new Set<RequirementKind>([
  'no_cta',
  'asset_present',
  'text_present',
  'element_absent',
  'section_absent',
  'color_applied',
  'section_changed',
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Same asset, ignoring cache-busting query strings.
 *
 * Deliberately exact on the path: matching by filename would let a source URL
 * pass as its re-hosted copy (and vice versa), which is the ambiguity this
 * check exists to remove.
 */
function sameAssetUrl(a: string, b: string): boolean {
  const strip = (u: string) => u.split(/[?#]/)[0];
  return strip(a) === strip(b);
}

function asCleanString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || t.length > max) return null;
  return t;
}

/**
 * Turn the model's checklist into requirements we are actually able to verify.
 *
 * Fail-closed on the model's side: anything malformed, unverifiable, or aimed
 * at a section that doesn't exist is dropped rather than trusted, because an
 * un-droppable bad requirement would fail every attempt and block the edit.
 */
export function parseModelRequirements(
  raw: unknown,
  opts?: { knownSections?: string[]; max?: number; embeddableAssetUrls?: string[] },
): PageRequirement[] {
  let input = raw;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return [];
    }
  }
  const record = asRecord(input);
  const list = Array.isArray(input) ? input : Array.isArray(record?.requirements) ? record!.requirements : null;
  if (!list) return [];

  const known = opts?.knownSections ?? [];
  const resolveSections = (v: unknown): string[] => {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
    const out: string[] = [];
    for (const entry of arr) {
      const name = asCleanString(entry, 80);
      if (!name) continue;
      if (known.length === 0) {
        out.push(name);
        continue;
      }
      const hit = known.find((k) => k.toLowerCase() === name.toLowerCase());
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
  };

  const out: PageRequirement[] = [];
  for (const entry of list as unknown[]) {
    const item = asRecord(entry);
    if (!item) continue;

    const kind = asCleanString(item.kind, 40) as RequirementKind | null;
    if (!kind || !ALLOWED_KINDS.has(kind)) continue;

    const value = asCleanString(item.value, 400);
    const sections = resolveSections(item.sections);
    const colorName = asCleanString(item.color_name ?? item.colorName, 40);

    switch (kind) {
      case 'text_present':
        // Too short to be a meaningful check and it matches by accident.
        if (!value || value.length < 4) continue;
        break;
      case 'asset_present': {
        if (!value || !/^(https?:\/\/|\/)/i.test(value)) continue;
        // The model sees the SOURCE url (the brand's own site, a scraped logo),
        // but we never hotlink — assets are fetched and re-hosted, so the URL
        // that ends up in the HTML is ours. Checking the model's URL therefore
        // fails forever and reports a logo that is plainly on the page as a
        // dropped ask. Only keep it when it names a URL we actually embed.
        const embeddable = opts?.embeddableAssetUrls;
        if (embeddable && !embeddable.some((u) => sameAssetUrl(u, value))) continue;
        break;
      }
      case 'element_absent':
      case 'section_absent':
        if (!value) continue;
        break;
      case 'color_applied':
        // No resolvable section means nothing to look at, and no color name
        // means nothing to compare against.
        if (sections.length === 0 || !(colorName ?? value)) continue;
        break;
      case 'section_changed':
        if (sections.length === 0) continue;
        break;
      case 'no_cta':
        break;
    }

    const label =
      asCleanString(item.label, 160) ?? defaultLabelFor(kind, value, sections, colorName);

    out.push({
      kind,
      label,
      ...(value ? { value } : {}),
      ...(sections.length > 0 ? { sections } : {}),
      ...(colorName ? { colorName } : {}),
    });
  }

  return dedupe(out).slice(0, opts?.max ?? 12);
}

function defaultLabelFor(
  kind: RequirementKind,
  value: string | null,
  sections: string[],
  colorName: string | null,
): string {
  switch (kind) {
    case 'no_cta':
      return 'no buttons / calls to action on the page';
    case 'asset_present':
      return 'the requested image is on the page';
    case 'text_present':
      return `the copy “${truncate(value ?? '')}” appears`;
    case 'element_absent':
      return `“${truncate(value ?? '')}” is gone`;
    case 'section_absent':
      return `the ${value} section is removed`;
    case 'color_applied':
      return `${sections.join(' / ')} are ${colorName ?? value}`;
    case 'section_changed':
      return `the ${sections.join(' / ')} section was actually updated`;
  }
}

/**
 * Model checklist + regex checklist. The regex pass stays as a floor so a bad
 * or failed extraction call can only add checks, never remove the guarantees
 * that already shipped.
 */
export function mergeRequirements(...lists: PageRequirement[][]): PageRequirement[] {
  return dedupe(lists.flat()).slice(0, 16);
}

export function checkRequirements(
  html: string,
  requirements: PageRequirement[],
  opts?: { beforeHtml?: string },
): RequirementResult[] {
  return requirements.map((requirement) => ({
    requirement,
    passed: checkOne(html, requirement, opts?.beforeHtml),
  }));
}

function checkOne(html: string, req: PageRequirement, beforeHtml?: string): boolean {
  switch (req.kind) {
    case 'section_changed': {
      // Style asks ("bigger nav text") have nothing quotable to look for, but
      // an untouched section still proves the ask was not carried out. Without
      // a before-image there is nothing to compare, so don't invent a failure.
      if (!beforeHtml) return true;
      const sections = req.sections ?? [];
      if (sections.length === 0) return html !== beforeHtml;
      return sections.every((name) => {
        const after = sectionInner(html, name);
        const before = sectionInner(beforeHtml, name);
        if (before === null || after === null) return true;
        return before !== after;
      });
    }
    case 'no_cta':
      return !pageHasCta(html);
    case 'asset_present':
      return !!req.value && html.includes(req.value);
    case 'text_present':
      return !!req.value && normalizeText(html).includes(normalizeText(req.value));
    case 'element_absent': {
      if (!req.value) return false;
      // A section-scoped ask ("remove the CTA from the navbar") must only be
      // checked against that section — the same label commonly exists
      // elsewhere on the page (a hero CTA, a footer link) on purpose, and a
      // whole-page substring search flags that as the removal having failed.
      const sections = req.sections ?? [];
      const haystacks =
        sections.length > 0
          ? sections.map((name) => sectionInner(html, name)).filter((s): s is string => s !== null)
          : [html];
      // A named section that no longer exists in the HTML has nothing to
      // search — that is not evidence the element is still there.
      if (sections.length > 0 && haystacks.length === 0) return true;
      const stillPresent = haystacks.some((h) => h.includes(req.value as string));
      if (stillPresent) {
        const hit = haystacks.find((h) => h.includes(req.value as string))!;
        const idx = hit.indexOf(req.value);
        console.warn('[ai-page-requirements] element_absent still present', {
          value: req.value,
          sections,
          context: hit.slice(Math.max(0, idx - 60), idx + req.value.length + 60),
        });
      }
      return !stillPresent;
    }
    case 'section_absent': {
      if (!req.value) return true;
      return !sectionInner(html, req.value);
    }
    case 'color_applied': {
      const sections = req.sections ?? [];
      if (sections.length === 0) return true;
      const wanted = req.colorName ?? req.value;
      if (!wanted) return true;
      return sections.every((name) => {
        const inner = sectionInner(html, name);
        if (!inner) return true; // section doesn't exist → nothing to color
        const bg = sectionBackgroundColor(inner, html);
        // No background at all is a miss; a background of the wrong family
        // (green when they said blue) is also a miss, which the old
        // "is it non-white" test happily passed.
        return !!bg && colorMatchesName(bg, wanted);
      });
    }
    default:
      return true;
  }
}

/**
 * Apply what we can without another model call. Returns the patched HTML plus
 * the requirements still unmet, which callers turn into a retry instruction.
 */
export function enforceRequirements(
  html: string,
  requirements: PageRequirement[],
): { html: string; applied: string[] } {
  let out = html;
  const applied: string[] = [];

  for (const req of requirements) {
    if (req.kind === 'no_cta' && pageHasCta(out)) {
      const stripped = stripCtaElements(out);
      if (stripped.removed > 0) {
        out = stripped.html;
        applied.push(`removed ${stripped.removed} CTA element(s)`);
      }
      continue;
    }

    if (req.kind === 'color_applied') {
      const wanted = req.colorName ?? req.value;
      // Prefer the page's own token so "keep them blue, follow the theme" uses
      // the theme's blue — but only when that token really is the color asked
      // for, otherwise fall back to the named color's default.
      const themeColor = extractThemeBackgroundColor(out);
      const color =
        themeColor && wanted && colorMatchesName(themeColor, wanted) ? themeColor : req.value;
      if (!color) continue;
      for (const section of req.sections ?? []) {
        const inner = sectionInner(out, section);
        if (inner) {
          const current = sectionBackgroundColor(inner, out);
          if (current && wanted && colorMatchesName(current, wanted)) continue;
        }
        const before = out;
        out = applyBackgroundToSection(out, section, color, { overwrite: true });
        if (out !== before) applied.push(`applied ${color} background to ${section}`);
      }
    }
  }

  return { html: out, applied };
}

/** One short sentence naming what did not land — never a fake success. */
export function describeUnmet(results: RequirementResult[]): string | null {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return null;
  const labels = failed.map((f) => f.requirement.label);
  const head = labels.slice(0, 3).join('; ');
  const rest = labels.length > 3 ? ` (+${labels.length - 3} more)` : '';
  return `${head}${rest}`;
}

/** Instruction appended to a retry so the model fixes only what failed. */
export function retryInstructionFor(results: RequirementResult[]): string | null {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return null;
  const lines = failed.map((f) => {
    switch (f.requirement.kind) {
      case 'no_cta':
        return '- Remove every button / call-to-action element. Plain text links are fine.';
      case 'asset_present':
        return `- Use EXACTLY this asset URL in an <img src>: ${f.requirement.value}`;
      case 'text_present':
        return `- The page must contain this copy verbatim: "${f.requirement.value}"`;
      case 'color_applied':
        return `- Give ${(f.requirement.sections ?? []).join(' and ')} the page's dark/brand background color — not white.`;
      case 'section_absent':
        return `- Delete the ${f.requirement.value} section entirely.`;
      case 'section_changed':
        return `- You returned ${(f.requirement.sections ?? []).join(' and ')} unchanged. Actually apply the requested change to it.`;
      case 'element_absent':
        return `- Remove this from the page entirely: ${f.requirement.value}`;
      default:
        return `- ${f.requirement.label}`;
    }
  });
  return `The previous attempt did not satisfy these requirements. Fix ONLY these:\n${lines.join('\n')}`;
}

function normalizeText(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function truncate(s: string, max = 48): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function dedupe(reqs: PageRequirement[]): PageRequirement[] {
  const seen = new Set<string>();
  const out: PageRequirement[] = [];
  for (const r of reqs) {
    const key = `${r.kind}:${r.value ?? ''}:${(r.sections ?? []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

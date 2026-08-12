/**
 * Click-to-edit is driven only by [data-field]. The HTML model is asked to
 * emit those attributes; when it doesn't, the preview looks right but nothing
 * is clickable.
 *
 * 1) stampSchemaDataFields — exact schema string/URL match (best path names)
 * 2) stampStructuralDataFields — inside each SL section, tag remaining
 *    headings/paragraphs/buttons/imgs so screenshot copy still becomes editable
 *
 * ensureClickToEditFields = both, in order. Never invent fields outside SL
 * sections (avoids SplitLab chrome). Idempotent.
 */

const SKIP_KEYS = new Set([
  'image_prompt',
  'vertical',
  'type',
  'palette_direction',
  'layout_rhythm',
  'copy_tone',
  'motion_style',
  'styleTag',
  'requirements',
  'thinking',
]);

const TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'span', 'li', 'label', 'strong', 'em', 'div'];

/** Tags we will mark for click-to-edit inside an SL section. */
const STRUCTURAL_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'label', 'li', 'img'] as const;

interface SchemaLeaf {
  path: string;
  value: string;
  isUrl: boolean;
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function collectLeaves(node: unknown, prefix: string, out: SchemaLeaf[]): void {
  if (node == null) return;
  if (typeof node === 'string') {
    const value = node.trim();
    if (value.length < 4 || value.length > 280) return;
    const isUrl = /^https?:\/\//i.test(value) || value.startsWith('/');
    if (!prefix) return;
    out.push({ path: prefix, value, isUrl });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectLeaves(item, prefix ? `${prefix}.${i}` : String(i), out));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (SKIP_KEYS.has(k)) continue;
      const next = prefix ? `${prefix}.${k}` : k;
      collectLeaves(v, next, out);
    }
  }
}

function existingFields(html: string): Set<string> {
  const set = new Set<string>();
  for (const m of Array.from(html.matchAll(/\bdata-field=["']([^"']+)["']/gi))) {
    if (m[1]) set.add(m[1]);
  }
  return set;
}

export function countDataFields(html: string): number {
  return (html.match(/\bdata-field=["']/gi) ?? []).length;
}

function findInsertIndex(html: string, leaf: SchemaLeaf, used: Set<number>): number | null {
  const target = normalizeText(leaf.value);
  if (!target) return null;

  if (leaf.isUrl) {
    const re = /<img\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (used.has(m.index)) continue;
      if (/\bdata-field\s*=/i.test(m[1])) continue;
      const src = /src\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] ?? '';
      if (src === leaf.value) {
        used.add(m.index);
        return m.index + 4;
      }
    }
    return null;
  }

  for (const tag of TEXT_TAGS) {
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (used.has(m.index)) continue;
      if (/\bdata-field\s*=/i.test(m[1])) continue;
      const inner = normalizeText(m[2].replace(/<[^>]+>/g, ' '));
      if (inner === target) {
        used.add(m.index);
        return m.index + 1 + tag.length;
      }
    }
  }
  return null;
}

/**
 * Add missing data-field attributes for schema copy/images that already
 * appear in the HTML. Idempotent: existing data-field values are left alone.
 */
export function stampSchemaDataFields(html: string, schema: unknown): string {
  if (!html || !schema || typeof schema !== 'object') return html;
  const leaves: SchemaLeaf[] = [];
  collectLeaves(schema, '', leaves);
  if (leaves.length === 0) return html;

  const have = existingFields(html);
  const edits: { index: number; insert: string }[] = [];
  const used = new Set<number>();

  for (const leaf of leaves) {
    if (have.has(leaf.path)) continue;
    const index = findInsertIndex(html, leaf, used);
    if (index == null) continue;
    used.add(index);
    have.add(leaf.path);
    const safe = leaf.path.replace(/"/g, '');
    edits.push({ index, insert: ` data-field="${safe}"` });
  }

  if (edits.length === 0) return html;
  edits.sort((a, b) => b.index - a.index);
  let out = html;
  for (const e of edits) {
    out = out.slice(0, e.index) + e.insert + out.slice(e.index);
  }
  return out;
}

function structuralKind(tag: string, counts: Record<string, number>): string {
  const t = tag.toLowerCase();
  if (t === 'h1') return counts.h1 ? `headline_${counts.h1}` : 'headline';
  if (t === 'h2' || t === 'h3') return counts[t] ? `heading_${t}_${counts[t]}` : `heading_${t}`;
  if (t === 'img') return counts.img ? `image_${counts.img}` : 'image';
  if (t === 'a' || t === 'button') return counts.cta ? `cta_${counts.cta}` : 'cta';
  if (t === 'li') return `item_${counts.li ?? 0}`;
  return counts.p ? `text_${counts.p}` : 'text';
}

/**
 * Inside each <!-- SL:name --> block, stamp remaining editable tags that the
 * schema pass missed (screenshot copy, paraphrased headlines, etc.).
 */
export function stampStructuralDataFields(html: string): string {
  if (!html || !/<!--\s*SL:/i.test(html)) return html;

  const sectionRe = /<!--\s*SL:([a-z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/SL:\1\s*-->/gi;
  const parts: { full: string; name: string; inner: string; index: number }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = sectionRe.exec(html))) {
    parts.push({ full: sm[0], name: sm[1], inner: sm[2], index: sm.index });
  }
  if (parts.length === 0) return html;

  let out = html;
  // Apply from end so earlier indices stay valid
  for (let si = parts.length - 1; si >= 0; si--) {
    const { name, inner, index, full } = parts[si];
    const counts: Record<string, number> = {};
    const edits: { index: number; insert: string }[] = [];
    const usedPaths = existingFields(inner);

    for (const tag of STRUCTURAL_TAGS) {
      if (tag === 'img') {
        const re = /<img\b([^>]*)>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(inner))) {
          if (/\bdata-field\s*=/i.test(m[1])) continue;
          const src = /src\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] ?? '';
          if (!src || src.startsWith('data:')) continue;
          const n = counts.img ?? 0;
          counts.img = n + 1;
          const path = `${name}.${structuralKind('img', { img: n })}`.replace(/"/g, '');
          if (usedPaths.has(path)) continue;
          usedPaths.add(path);
          edits.push({ index: m.index + 4, insert: ` data-field="${path}"` });
        }
        continue;
      }

      const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(inner))) {
        if (/\bdata-field\s*=/i.test(m[1])) continue;
        // Skip wrappers that only contain other block tags (no own text).
        const text = normalizeText(m[2].replace(/<[^>]+>/g, ' '));
        if (text.length < 2) continue;
        if (tag === 'li' && text.length < 2) continue;
        // Avoid stamping huge nested div-like blocks via accidental tags — we
        // only use STRUCTURAL_TAGS, not div.
        const key = tag === 'h1' ? 'h1' : tag === 'h2' || tag === 'h3' ? tag : tag === 'a' || tag === 'button' ? 'cta' : tag === 'li' ? 'li' : 'p';
        const n = counts[key] ?? 0;
        counts[key] = n + 1;
        const path = `${name}.${structuralKind(tag, { ...counts, [key]: n })}`.replace(/"/g, '');
        if (usedPaths.has(path)) continue;
        usedPaths.add(path);
        edits.push({ index: m.index + 1 + tag.length, insert: ` data-field="${path}"` });
      }
    }

    if (edits.length === 0) continue;
    edits.sort((a, b) => b.index - a.index);
    let newInner = inner;
    for (const e of edits) {
      newInner = newInner.slice(0, e.index) + e.insert + newInner.slice(e.index);
    }
    const replacement = `<!-- SL:${name} -->${newInner}<!-- /SL:${name} -->`;
    out = out.slice(0, index) + replacement + out.slice(index + full.length);
  }

  return out;
}

/** Schema match first, then structural fill for whatever is still bare. */
export function ensureClickToEditFields(html: string, schema?: unknown): string {
  if (!html) return html;
  let out = stampSchemaDataFields(html, schema ?? null);
  out = stampStructuralDataFields(out);
  return out;
}

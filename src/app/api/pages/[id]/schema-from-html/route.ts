import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { askAIStream, isRateLimited, AIResponseTruncatedError } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';

export const dynamic = 'force-dynamic';
// The AI call now returns a compact field/section list (not the full page),
// so this should complete well under the old 300s ceiling — kept at 120 as
// a safety margin rather than the previous 300s (which was needed only
// because the old approach echoed the whole page back).
export const maxDuration = 120;

// Prepares an existing raw-HTML page (e.g. a hand-authored test variant) for
// the schema-driven AI Pages editor — WITHOUT redesigning it.
//
// Unlike the old implementation, the AI is never asked to reproduce the
// page's HTML. It only reports WHERE the editable content and structural
// sections are (a short JSON list); this route then inserts the
// data-field="..." attributes and <!-- SL:name --> markers itself via
// string/tag matching. This keeps the AI's output size proportional to the
// number of editable fields, not the size of the page — the old approach's
// 16-32k-token echo was the actual latency bottleneck (see
// docs/edit-html-with-ai-todos.md, "Follow-up: schema-from-html latency
// fix"). schema_json is then built directly from the same field list, no
// second parsing pass needed.
const SYSTEM_PROMPT = `You are analyzing an existing, already-designed landing page's HTML so it can be edited going forward through a WYSIWYG editor and an AI chat assistant — WITHOUT changing anything about how the page looks.

## Task
You will be given the complete HTML of an existing page. Do NOT return any HTML. Return ONLY a JSON object (no markdown fences, no explanation, no extra text) with this exact shape:

{
  "sections": [
    { "name": "hero", "tag": "section", "anchor": "<section class=\\"hero-section\\" id=\\"hero\\">" }
  ],
  "fields": [
    { "dot_path": "hero.headline", "tag": "h1", "match_text": "Grow Your Business 10x Faster", "occurrence": 0 },
    { "dot_path": "hero.image", "tag": "img", "match_text": "https://example.com/hero.jpg", "occurrence": 0 }
  ]
}

### "sections" — one entry per top-level block
Include: the <style> block (name: "head", tag: "style"), the <nav> (name: "nav"), every top-level <section> or major top-level content block (short kebab-case name describing it, suffix -2/-3 for duplicate names), and the <footer> (name: "footer").
"anchor" must be the element's opening tag copied byte-for-byte EXACTLY as it appears in the given HTML — same attribute order, same quote characters, ending at ">" — including enough of it (class/id/etc.) to uniquely identify that one element if the bare tag name repeats elsewhere on the page.

### "fields" — one entry per editable element
Every editable text element (headings, paragraphs, labels, button/link text, list items, testimonial quotes, FAQ answers, stat numbers, etc.) and every meaningful content <img> (skip logos and purely decorative icons).
- "dot_path": describes the section and field, e.g. "hero.headline", "features.items.0.title", "testimonials.items.0.quote", "hero.image". Use the same path pattern for repeated items in a list (indexed .0, .1, .2, ...).
- "tag": the element's HTML tag name (lowercase, no brackets), e.g. "h1", "p", "a", "span", "img".
- "match_text": for non-<img> elements, the element's exact rendered text content (tags stripped, but preserve exact wording/punctuation/capitalization as it appears). For <img>, the exact "src" attribute value.
- "occurrence": 0-indexed. If the exact same (tag, match_text) pair appears more than once on the page (e.g. a repeated "Learn More" button), set this to which occurrence it is in top-to-bottom document order. Otherwise 0.

## CRITICAL rules
- Do not invent, paraphrase, or summarize text — "match_text" must be copyable verbatim from the given HTML.
- Do not include elements that are not present in the given HTML.
- Return JSON only — nothing else.`;

function minifyHtmlForModel(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

function setPathValue(root: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split('.').filter(Boolean);
  if (keys.length === 0) return;
  let current: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const existing = current[key];
    if (typeof existing !== 'object' || existing === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

const SAFE_TAG_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

interface FieldEntry {
  dot_path: string;
  tag: string;
  match_text: string;
  occurrence: number;
}

interface SectionEntry {
  name: string;
  tag: string;
  anchor: string;
}

interface FieldListResponse {
  sections?: SectionEntry[];
  fields?: FieldEntry[];
}

// Named entities beyond the handful of structural ones (nbsp/amp/quot/lt/gt)
// — mainly typographic marks common in marketing copy (curly quotes,
// dashes, ellipsis). The AI tends to write these decoded ("you're") even
// when the source HTML has them encoded ("you&#8217;re") or vice versa, so
// both the match_text and the HTML's actual inner text need to normalize to
// the same characters or matching silently fails on exactly the fields most
// likely to contain them (headlines, quotes).
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…',
  trade: '™', copy: '©', reg: '®',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function normalizeText(s: string): string {
  return decodeEntities(s)
    .replace(/\s+/g, ' ')
    .trim();
}

// Replaces (not just removes) each tag with a space — deleting a <br> or an
// inline <span> boundary with nothing glues the words on either side
// together ("Leads.Real Jobs." instead of "Leads. Real Jobs."), which never
// matches the AI's naturally-spaced match_text. normalizeText() collapses
// the resulting extra whitespace, so this is safe everywhere.
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

interface OpenTagEdit {
  index: number; // index of the char right after the tag name, where new attrs get inserted
  attr: string; // e.g. ' data-field="hero.headline"'
}

interface WrapEdit {
  start: number; // insert-before index (element start)
  end: number; // insert-after index (element end, exclusive)
  before: string;
  after: string;
}

/**
 * Locates the nth (0-indexed) `<tag ...>innerText</tag>` (or `<img ...>` for
 * tag === 'img') whose normalized text/src matches matchText, and returns
 * the index right after the tag name in the OPENING tag (where an attribute
 * can be inserted). Returns null if not enough matches were found.
 */
function findFieldOpenTagInsertPoint(
  html: string,
  tag: string,
  matchText: string,
  occurrence: number,
): number | null {
  if (!SAFE_TAG_RE.test(tag)) return null;
  const target = normalizeText(matchText);
  let found = 0;

  if (tag.toLowerCase() === 'img') {
    const re = /<img\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const srcMatch = /src\s*=\s*["']([^"']*)["']/i.exec(m[1]);
      const src = srcMatch ? srcMatch[1] : '';
      if (normalizeText(src) === target) {
        if (found === occurrence) return m.index + 4; // right after "<img"
        found++;
      }
    }
    return null;
  }

  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const inner = stripTags(m[2]);
    if (normalizeText(inner) === target) {
      if (found === occurrence) return m.index + 1 + tag.length; // right after "<tag"
      found++;
    }
  }
  return null;
}

/**
 * Locates a section element by its AI-supplied opening-tag "anchor" (an
 * exact-copy match attempted first, then a looser fallback keyed on a
 * distinguishing class/id substring pulled from the anchor). Returns the
 * [elementStart, elementEnd) span (elementEnd is exclusive, right after the
 * matching closing tag), found via depth-aware scanning so nested same-name
 * tags don't cut the wrap short. Returns null if the element can't be
 * located.
 */
function findSectionSpan(html: string, tag: string, anchor: string): [number, number] | null {
  if (!SAFE_TAG_RE.test(tag)) return null;

  let openTagEnd: number | null = null;
  let elementStart: number | null = null;

  const literalIdx = html.indexOf(anchor);
  if (literalIdx !== -1) {
    elementStart = literalIdx;
    openTagEnd = literalIdx + anchor.length;
  } else {
    // Fallback: extract a distinguishing class/id from the anchor and find
    // the first <tag ...> whose attrs contain that same substring.
    const idMatch = /\bid\s*=\s*["']([^"']*)["']/.exec(anchor);
    const classMatch = /\bclass\s*=\s*["']([^"']*)["']/.exec(anchor);
    const needle = idMatch?.[1] || classMatch?.[1]?.split(/\s+/)[0];
    if (!needle) return null;
    const tagOpenRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = tagOpenRe.exec(html))) {
      if (m[0].includes(needle)) {
        elementStart = m.index;
        openTagEnd = m.index + m[0].length;
        break;
      }
    }
  }

  if (elementStart === null || openTagEnd === null) return null;

  // Depth-aware scan for the matching close tag (handles nested same-tag
  // elements, e.g. <section> containing another <section>, or <div> nesting
  // when tag happens to be "div").
  const scanRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
  scanRe.lastIndex = openTagEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = scanRe.exec(html))) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) return [elementStart, m.index + m[0].length];
    } else {
      depth++;
    }
  }
  return null; // unbalanced/never closed — skip rather than guess
}

/**
 * Given the AI's field/section list and the original page HTML, builds the
 * annotated HTML (data-field attrs + SL markers inserted server-side) and
 * the derived schema_json in one pass. Fields/sections that can't be
 * confidently located are skipped, not treated as fatal — one missed field
 * is a smaller schema, not a broken page.
 */
function annotateHtml(
  html: string,
  parsed: FieldListResponse,
): { annotatedHtml: string; schemaJson: Record<string, unknown>; matchedCount: number; requestedCount: number } {
  const fields = parsed.fields ?? [];
  const sections = parsed.sections ?? [];
  const schemaJson: Record<string, unknown> = {};

  const openTagEdits: OpenTagEdit[] = [];
  let matchedCount = 0;

  for (const f of fields) {
    if (!f?.dot_path || !f.tag || typeof f.match_text !== 'string') continue;
    const occurrence = Number.isInteger(f.occurrence) && f.occurrence >= 0 ? f.occurrence : 0;
    const insertAt = findFieldOpenTagInsertPoint(html, f.tag, f.match_text, occurrence);
    if (insertAt === null) {
      console.warn(`[schema-from-html] field not matched, skipping: ${f.dot_path}`);
      continue;
    }
    openTagEdits.push({ index: insertAt, attr: ` data-field="${f.dot_path.replace(/"/g, '&quot;')}"` });
    setPathValue(schemaJson, f.dot_path, f.tag.toLowerCase() === 'img' ? f.match_text : f.match_text);
    matchedCount++;
  }

  const wrapEdits: WrapEdit[] = [];
  const usedNames = new Set<string>();
  for (const s of sections) {
    if (!s?.name || !SAFE_NAME_RE.test(s.name) || !s.tag || !s.anchor) continue;
    if (usedNames.has(s.name)) continue; // duplicate name from the model, skip re-wrap
    const span = findSectionSpan(html, s.tag, s.anchor);
    if (!span) {
      console.warn(`[schema-from-html] section not matched, skipping: ${s.name}`);
      continue;
    }
    usedNames.add(s.name);
    const [start, end] = span;
    wrapEdits.push({ start, end, before: `<!-- SL:${s.name} -->\n`, after: `\n<!-- /SL:${s.name} -->` });
  }

  // Apply every edit by index, from the end of the document backwards, so
  // earlier insertions never shift the indices of edits still pending.
  type Edit = { index: number; insert: string };
  const flat: Edit[] = [
    ...openTagEdits.map((e) => ({ index: e.index, insert: e.attr })),
    ...wrapEdits.flatMap((e) => [
      { index: e.end, insert: e.after },
      { index: e.start, insert: e.before },
    ]),
  ].sort((a, b) => b.index - a.index);

  let result = html;
  for (const edit of flat) {
    result = result.slice(0, edit.index) + edit.insert + result.slice(edit.index);
  }

  return { annotatedHtml: result, schemaJson, matchedCount, requestedCount: fields.length };
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, schema_json, slug')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (session.user.role !== 'admin') {
    const ownerPlan = await resolveOwnerPlan(page.workspace_id);
    if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
      return NextResponse.json(
        { error: 'AI page editing requires an Agency or Scale plan. Please upgrade to use this feature.', limitError: true },
        { status: 403 }
      );
    }
  }

  // Idempotency guard #1 — already has a schema, nothing to do.
  if (page.schema_json) {
    return NextResponse.json({ already: true, schema_json: page.schema_json, html_url: page.html_url });
  }

  if (!page.html_url && !page.html_content) {
    return NextResponse.json({ error: 'Page has no HTML yet' }, { status: 400 });
  }

  if (isRateLimited(session.user.id, 3, 60_000) || isRateLimited(session.user.id, 15, 3_600_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a moment before trying again.' }, { status: 429 });
  }

  const html = page.html_content ?? (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
  if (!html) return NextResponse.json({ error: 'Could not load current HTML' }, { status: 400 });

  const htmlForModel = minifyHtmlForModel(html);

  let parsed: FieldListResponse;
  try {
    // Streamed even though we don't need the chunks — matches every other
    // AI call in this app to avoid the Anthropic SDK's non-streaming HTTP
    // timeout at high maxTokens.
    const text = await askAIStream(
      {
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Existing page HTML:\n${htmlForModel}` }],
        maxTokens: 8000,
      },
      () => {},
    );

    let jsonText = text.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }
    parsed = JSON.parse(jsonText);
  } catch (err) {
    if (err instanceof AIResponseTruncatedError) {
      return NextResponse.json({ error: 'This page is too large to prepare for AI editing in one pass.' }, { status: 500 });
    }
    console.error('[schema-from-html] field-list generation failed', err);
    return NextResponse.json({ error: 'Could not prepare this page for AI editing' }, { status: 500 });
  }

  const { annotatedHtml, schemaJson, matchedCount, requestedCount } = annotateHtml(html, parsed);

  // If almost nothing the AI listed could actually be located in the HTML,
  // something is structurally wrong (not just one-off text drift) — treat
  // as a failure rather than shipping a near-empty schema.
  if (requestedCount === 0 || matchedCount / requestedCount < 0.3) {
    console.error(`[schema-from-html] low match rate: ${matchedCount}/${requestedCount}`);
    return NextResponse.json({ error: 'Could not prepare this page for AI editing' }, { status: 500 });
  }

  const storagePath = page.html_url ? fileNameFromUrl(page.html_url) : `pages/${page.workspace_id}/${params.id}.html`;
  const htmlUrl = await uploadHtml(storagePath, annotatedHtml);

  const updatePayload = {
    schema_json: schemaJson,
    html_url: htmlUrl,
    html_content: annotatedHtml.length < 500_000 ? annotatedHtml : null,
    field_selectors_json: null,
    updated_at: new Date().toISOString(),
  };

  // Idempotency guard #2 — atomic write, only applies if still schema-less.
  // If a concurrent call already set schema_json, this update matches zero
  // rows and we fall back to returning the row's current state.
  const { data: updated } = await db
    .from('pages')
    .update(updatePayload)
    .eq('id', params.id)
    .is('schema_json', null)
    .select('schema_json, html_url')
    .single();

  if (!updated) {
    const { data: current } = await db.from('pages').select('schema_json, html_url').eq('id', params.id).single();
    return NextResponse.json({ already: true, schema_json: current?.schema_json, html_url: current?.html_url });
  }

  await db.from('personalization_rules').delete().eq('page_id', params.id);

  return NextResponse.json({ schema_json: updated.schema_json, html_url: updated.html_url });
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { jsonrepair } from 'jsonrepair';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { askAIStream, isRateLimited, AIResponseTruncatedError } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan, resolveWorkspaceOwner } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
import { isTestVariantPage } from '@/lib/page-drafts';
import { extractDataUris, restoreDataUris, restoreDataUrisInValue } from '@/lib/data-uri-strip';
import { createSSEStream, sendSSE, sendSSEPing, closeSSE, SSE_HEADERS } from '@/lib/sse';
import { checkAiAllowance, type UsageContext } from '@/lib/ai-usage';
import { reportAiOverageUsage } from '@/lib/ai-overage-billing';

export const dynamic = 'force-dynamic';
// The AI call returns a compact field/section list (not the full page), but
// maxTokens is set to 128000 (the model's actual ceiling) so a field-dense
// page never gets cut off mid-JSON — for a large page that can legitimately
// take several minutes, so this matches the same 800s ceiling already used
// by rebuild-with-ai/follow-up for the same kind of call, rather than the
// mismatched 120s this used to have back when maxTokens was capped at 16000.
export const maxDuration = 800;

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

// Detects a span that's already immediately wrapped by an <!-- SL:name --> /
// <!-- /SL:name --> pair — e.g. HTML pasted in from a page that was already
// converted elsewhere (a prior schema-from-html run, or exported from
// production with markers baked in). Re-wrapping it would nest a second
// marker pair around the first, corrupting the boundaries every later patch
// relies on — so these spans are treated as already matched and left alone.
function isAlreadySectionWrapped(html: string, start: number, end: number): boolean {
  const before = html.slice(Math.max(0, start - 60), start);
  const after = html.slice(end, end + 60);
  return (
    /<!--\s*SL:[a-zA-Z0-9_-]+\s*-->\s*$/.test(before) &&
    /^\s*<!--\s*\/SL:[a-zA-Z0-9_-]+\s*-->/.test(after)
  );
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
): {
  annotatedHtml: string;
  schemaJson: Record<string, unknown>;
  matchedCount: number;
  requestedCount: number;
  matchedSectionCount: number;
  requestedSectionCount: number;
} {
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
  let matchedSectionCount = 0;
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
    if (isAlreadySectionWrapped(html, start, end)) {
      console.log(`[schema-from-html] section already SL-wrapped, skipping re-wrap: ${s.name}`);
      matchedSectionCount++;
      continue;
    }
    matchedSectionCount++;
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

  return {
    annotatedHtml: result,
    schemaJson,
    matchedCount,
    requestedCount: fields.length,
    matchedSectionCount,
    requestedSectionCount: sections.length,
  };
}

// ── Field-list generation (single pass) ─────────────────────────────────────
// Extracted so both the primary single-pass path and the chunked fallback can
// reuse it. Throws AIResponseTruncatedError when the model's JSON output hits
// the token cap (that's the signal to fall back to chunking).
async function generateFieldList(htmlForModel: string, isFragment: boolean, usage?: UsageContext): Promise<FieldListResponse> {
  const fragmentNote = isFragment
    ? '\n\nNOTE: This is ONE FRAGMENT of a larger page, not the whole page. List only the sections and fields present in THIS fragment. Do not invent content from other parts of the page.'
    : '';
  const text = await askAIStream(
    {
      system: SYSTEM_PROMPT + fragmentNote,
      messages: [{ role: 'user', content: `Existing page HTML:\n${htmlForModel}` }],
      usage,
      label: isFragment ? 'schema-from-html:chunk' : 'schema-from-html',
      // Each chunk is a fraction of the page, so 32K output is ample and keeps
      // per-chunk calls fast. max_tokens is a cap not a charge — we only pay for
      // tokens generated.
      maxTokens: 32000,
    },
    () => {},
  );
  let jsonText = text.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    return JSON.parse(jsonrepair(jsonText));
  }
}

// ── Chunked field-list generation (fallback for very large pages) ────────────
// When a page's field-list would exceed the single-pass output cap, split the
// page into top-level sections, generate a field-list per chunk (in parallel,
// each well under the cap), and merge. annotateHtml() matches fields/sections
// against the FULL html by content, so a merged list annotates the whole page
// unchanged — the only fix-up needed is recomputing each field's `occurrence`
// globally, since a chunk's model only sees (and counts) its own slice.

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

/** Depth-aware spans of each top-level element in an HTML fragment. */
function topLevelElementSpans(html: string): [number, number][] {
  const spans: [number, number][] = [];
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let i = 0;
  while (i < html.length) {
    openRe.lastIndex = i;
    const m = openRe.exec(html);
    if (!m) break;
    const tag = m[1].toLowerCase();
    const openStart = m.index;
    const openEnd = m.index + m[0].length;
    if (m[2] === '/' || VOID_TAGS.has(tag)) {
      spans.push([openStart, openEnd]);
      i = openEnd;
      continue;
    }
    const scanRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
    scanRe.lastIndex = openEnd;
    let depth = 1;
    let closeEnd = html.length;
    let cm: RegExpExecArray | null;
    while ((cm = scanRe.exec(html))) {
      if (cm[0].startsWith('</')) {
        depth--;
        if (depth === 0) { closeEnd = cm.index + cm[0].length; break; }
      } else {
        depth++;
      }
    }
    spans.push([openStart, closeEnd]);
    i = closeEnd;
  }
  return spans;
}

/**
 * Split minified page HTML into chunks: the <head>/<style> block as its own
 * chunk, then the body's top-level elements grouped up to ~targetChars each so
 * we make as few AI calls as possible while keeping every element whole.
 */
function splitMinifiedIntoChunks(minified: string, targetChars = 12000): string[] {
  const chunks: string[] = [];

  const headMatch =
    /<head\b[^>]*>[\s\S]*?<\/head>/i.exec(minified) ||
    /<style\b[^>]*>[\s\S]*?<\/style>/i.exec(minified);
  if (headMatch) chunks.push(headMatch[0]);

  const bodyOpen = /<body\b[^>]*>/i.exec(minified);
  const bodyStart = bodyOpen ? bodyOpen.index + bodyOpen[0].length : 0;
  const bodyCloseIdx = minified.toLowerCase().lastIndexOf('</body>');
  const bodyEnd = bodyCloseIdx !== -1 ? bodyCloseIdx : minified.length;
  const body = minified.slice(bodyStart, bodyEnd);

  let buf = '';
  for (const [s, e] of topLevelElementSpans(body)) {
    const el = body.slice(s, e);
    if (buf && buf.length + el.length > targetChars) {
      chunks.push(buf);
      buf = '';
    }
    buf += el;
  }
  if (buf.trim()) chunks.push(buf);

  return chunks.length ? chunks : [minified];
}

/** Merge per-chunk field lists and recompute global (document-order) occurrence. */
function mergeFieldLists(lists: FieldListResponse[]): FieldListResponse {
  const sections: SectionEntry[] = [];
  const fields: FieldEntry[] = [];
  for (const list of lists) {
    for (const s of list?.sections ?? []) sections.push(s);
    for (const f of list?.fields ?? []) fields.push(f);
  }
  // Recompute occurrence globally: chunks are concatenated in document order,
  // so counting each (tag, normalized text) as we go yields the same indices
  // annotateHtml() will when it scans the full page top-to-bottom.
  const counts = new Map<string, number>();
  for (const f of fields) {
    if (!f?.tag || typeof f.match_text !== 'string') continue;
    const key = `${f.tag.toLowerCase()} ${normalizeText(f.match_text)}`;
    const n = counts.get(key) ?? 0;
    f.occurrence = n;
    counts.set(key, n + 1);
  }
  return { sections, fields };
}

async function generateFieldListChunked(minified: string, usage?: UsageContext): Promise<FieldListResponse> {
  const chunks = splitMinifiedIntoChunks(minified);
  console.log(`[schema-from-html] chunked fallback: ${chunks.length} chunks`);
  const results = await Promise.all(
    chunks.map(async (chunk, idx) => {
      try {
        return await generateFieldList(chunk, true, usage);
      } catch (err) {
        // One chunk failing (truncation on a single huge section, or a parse
        // error) drops that chunk's fields rather than failing the whole page.
        console.error(`[schema-from-html] chunk ${idx}/${chunks.length} failed`, err);
        return { sections: [], fields: [] } as FieldListResponse;
      }
    }),
  );
  return mergeFieldLists(results);
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const startedAt = Date.now();

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, html_content, schema_json, slug, draft_html_content, draft_schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (session.user.role !== 'admin') {
    const ownerPlan = await resolveOwnerPlan(page.workspace_id);
    if (!PLAN_LIMITS[ownerPlan]?.aiPages) {
      return NextResponse.json(
        { error: 'AI page editing requires a Growth, Agency, or Scale plan. Please upgrade to use this feature.', limitError: true },
        { status: 403 }
      );
    }
  }

  // Variant pages annotate straight into the draft — this is the first "edit"
  // that seeds it, since inserting data-field/SL markers changes the actual
  // markup (invisibly) even though nothing about the render changes.
  const isVariant = await isTestVariantPage(params.id);

  // Idempotency guard #1 — already has a schema (draft schema for variant
  // pages, live schema otherwise), nothing to do.
  if (isVariant ? page.draft_schema_json : page.schema_json) {
    return NextResponse.json(
      isVariant
        ? { already: true, schema_json: page.draft_schema_json, html_url: page.html_url }
        : { already: true, schema_json: page.schema_json, html_url: page.html_url }
    );
  }
  if (isVariant && page.schema_json) {
    // Already annotated before drafts existed — nothing to prepare.
    return NextResponse.json({ already: true, schema_json: page.schema_json, html_url: page.html_url });
  }

  if (!page.html_url && !page.html_content) {
    return NextResponse.json({ error: 'Page has no HTML yet' }, { status: 400 });
  }

  if (isRateLimited(session.user.id, 3, 60_000) || isRateLimited(session.user.id, 15, 3_600_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a moment before trying again.' }, { status: 429 });
  }

  // Meter this prepare against the account owner (AI credits / overage), and
  // soft-cap before opening the SSE stream so a blocked request returns clean
  // JSON the editor turns into an upsell (admins bypass).
  const { ownerId, plan: ownerPlanForUsage } = await resolveWorkspaceOwner(page.workspace_id);
  const usageCtx: UsageContext = {
    ownerId,
    workspaceId: page.workspace_id,
    pageId: params.id,
    operation: 'prepare',
  };
  if (session.user.role !== 'admin') {
    const gate = await checkAiAllowance(ownerId, ownerPlanForUsage);
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: gate.reason === 'over_cap'
            ? 'You\'ve reached your AI overage spend cap. Raise it in Billing to continue.'
            : 'You\'re out of AI credits for this month. Enable overage in Billing to continue.',
          softCap: true,
          reason: gate.reason,
          usage: gate.summary,
          overage: gate.overage,
        },
        { status: 402 },
      );
    }
  }

  // ── Open SSE stream — no NextResponse.json after this point ───────────────
  // Everything above this line is a fast guard (auth/plan/rate-limit/already-
  // prepared) and stays a plain JSON response; only the actual multi-minute
  // pipeline below streams progress.
  const { stream, controller } = createSSEStream();
  const response = new Response(stream, { headers: SSE_HEADERS });

  void (async () => {
    try {
      sendSSE(controller, { type: 'status', message: 'Loading page…' });
      const html = page.html_content ?? (page.html_url ? await downloadHtmlByPath(fileNameFromUrl(page.html_url)) : null);
      if (!html) {
        sendSSE(controller, { type: 'error', message: 'Could not load current HTML' });
        closeSSE(controller);
        return;
      }

      // Matching/annotation below all runs against `htmlNoDataUris` (placeholders
      // in place of real image bytes) so positions line up with what the model
      // saw; the real bytes go back in at the very end via dataUriMap.
      const { html: htmlNoDataUris, map: dataUriMap } = extractDataUris(html);
      const htmlForModel = minifyHtmlForModel(htmlNoDataUris);

      sendSSE(controller, { type: 'status', message: 'Analyzing structure…' });

      let parsed: FieldListResponse;
      // The model can sit on a large page for 2+ minutes before emitting its
      // first token, and askAIStream's onChunk isn't called during that gap —
      // so a chunk-driven heartbeat wouldn't help. A plain timer keeps bytes
      // flowing on the SSE connection the whole time the AI call is in
      // flight, so an idle-connection proxy timeout (Cloudflare, Vercel) never
      // sees a multi-minute silent gap and kills the stream before "Saving…".
      // Sent as an SSE comment line, not a real event — readSSEStream only
      // reacts to "data: " lines, so this never reaches LiveProgressPanel and
      // never duplicates the "Analyzing structure…" checklist row.
      const heartbeat = setInterval(() => sendSSEPing(controller), 15_000);
      try {
        // Streamed even though we don't need the chunks — matches every other
        // AI call in this app to avoid the Anthropic SDK's non-streaming HTTP
        // timeout at high maxTokens.
        const text = await askAIStream(
          {
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: `Existing page HTML:\n${htmlForModel}` }],
            maxTokens: 128000,
            label: 'schema-from-html',
            usage: usageCtx,
          },
          () => {},
        );

        let jsonText = text.trim();
        if (jsonText.startsWith('```')) {
          jsonText = jsonText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
        }
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          // Most common real-world cause: match_text echoes a quoted phrase from
          // the source HTML without escaping the inner quotes. jsonrepair fixes
          // that and other minor near-JSON issues before we give up entirely.
          parsed = JSON.parse(jsonrepair(jsonText));
        }
      } catch (err) {
        if (err instanceof AIResponseTruncatedError) {
          // Field-list overflowed even the 128K single pass — split the page
          // into top-level sections and generate a field-list per chunk, then
          // merge. Keeps arbitrarily large pages working.
          console.warn('[schema-from-html] single pass truncated, falling back to chunked generation');
          sendSSE(controller, { type: 'status', message: 'Large page — analyzing in sections…' });
          try {
            parsed = await generateFieldListChunked(htmlForModel, usageCtx);
          } catch (chunkErr) {
            clearInterval(heartbeat);
            console.error('[schema-from-html] chunked generation failed', chunkErr);
            sendSSE(controller, { type: 'error', message: 'This page is too large to prepare for AI editing.' });
            closeSSE(controller);
            return;
          }
        } else {
          clearInterval(heartbeat);
          console.error('[schema-from-html] field-list generation failed', err);
          sendSSE(controller, { type: 'error', message: 'Could not prepare this page for AI editing' });
          closeSSE(controller);
          return;
        }
      }
      clearInterval(heartbeat);

      sendSSE(controller, { type: 'status', message: 'Mapping fields…' });

      const {
        annotatedHtml: annotatedHtmlWithPlaceholders,
        schemaJson: schemaJsonWithPlaceholders,
        matchedCount,
        requestedCount,
        matchedSectionCount,
        requestedSectionCount,
      } = annotateHtml(htmlNoDataUris, parsed);

      // Swap real image bytes back in now that positions/markers are locked in —
      // both in the saved HTML and in the schema values the editor reads to show
      // "current image" thumbnails.
      const annotatedHtml = restoreDataUris(annotatedHtmlWithPlaceholders, dataUriMap);
      const schemaJson = restoreDataUrisInValue(schemaJsonWithPlaceholders, dataUriMap) as Record<string, unknown>;

      // If almost nothing the AI listed could actually be located in the HTML,
      // something is structurally wrong (not just one-off text drift) — treat
      // as a failure rather than shipping a near-empty schema.
      if (requestedCount === 0 || matchedCount / requestedCount < 0.3) {
        console.error(`[schema-from-html] low field match rate: ${matchedCount}/${requestedCount}`);
        sendSSE(controller, { type: 'error', message: 'Could not prepare this page for AI editing' });
        closeSSE(controller);
        return;
      }

      // Always logged (not just on failure) so match rate can be checked against
      // real client pages without needing to reproduce a failure first.
      console.log(`[schema-from-html] match rate — fields: ${matchedCount}/${requestedCount}, sections: ${matchedSectionCount}/${requestedSectionCount}`);

      // A page that comes out with zero (or almost zero) SL section markers has
      // no way to receive `type:"patch"` edits later — `follow-up/route.ts`
      // falls back to `type:"style"` (full-document 32k-token rewrite) for
      // EVERY future chat edit on this page, which is the actual latency
      // complaint. Failing here (same as the field guard above) forces a retry
      // instead of silently shipping a page that will always be slow to edit.
      if (requestedSectionCount === 0 || matchedSectionCount === 0) {
        console.error(`[schema-from-html] no sections matched: ${matchedSectionCount}/${requestedSectionCount} — page would have no SL markers and every future follow-up would be forced into a full-page rewrite`);
        sendSSE(controller, { type: 'error', message: 'Could not prepare this page for AI editing' });
        closeSSE(controller);
        return;
      }

      sendSSE(controller, { type: 'status', message: 'Saving…' });

      let updatePayload: Record<string, unknown>;
      let idempotencyColumn: 'schema_json' | 'draft_schema_json';

      if (isVariant) {
        // Annotated markup goes into the draft only — the live storage file and
        // live columns a test is actually serving stay untouched, same as any
        // other draft edit.
        updatePayload = {
          draft_schema_json: schemaJson,
          draft_html_content: annotatedHtml,
          updated_at: new Date().toISOString(),
        };
        idempotencyColumn = 'draft_schema_json';
      } else {
        const storagePath = page.html_url ? fileNameFromUrl(page.html_url) : `pages/${page.workspace_id}/${params.id}.html`;
        const htmlUrl = await uploadHtml(storagePath, annotatedHtml);
        updatePayload = {
          schema_json: schemaJson,
          html_url: htmlUrl,
          html_content: annotatedHtml.length < 500_000 ? annotatedHtml : null,
          field_selectors_json: null,
          updated_at: new Date().toISOString(),
        };
        idempotencyColumn = 'schema_json';
      }

      // Idempotency guard #2 — atomic write, only applies if still schema-less.
      // If a concurrent call already set schema_json/draft_schema_json, this
      // update matches zero rows and we fall back to returning the row's current state.
      const { data: updated } = await db
        .from('pages')
        .update(updatePayload)
        .eq('id', params.id)
        .is(idempotencyColumn, null)
        .select('schema_json, html_url, draft_schema_json')
        .single();

      if (!updated) {
        const { data: current } = await db.from('pages').select('schema_json, html_url, draft_schema_json').eq('id', params.id).single();
        sendSSE(controller, {
          type: 'done',
          already: true,
          html_url: current?.html_url ?? '',
          schema_json: isVariant ? current?.draft_schema_json : current?.schema_json,
          elapsed_ms: Date.now() - startedAt,
        });
        closeSSE(controller);
        return;
      }

      if (!isVariant) {
        await db.from('personalization_rules').delete().eq('page_id', params.id);
      }

      // Report accrued overage to Stripe (no-op unless configured). Fire-and-forget.
      void reportAiOverageUsage(ownerId);

      sendSSE(controller, {
        type: 'done',
        html_url: updated.html_url ?? '',
        schema_json: isVariant ? updated.draft_schema_json : updated.schema_json,
        elapsed_ms: Date.now() - startedAt,
      });
      closeSSE(controller);
    } catch (err) {
      console.error('[schema-from-html]', err);
      sendSSE(controller, { type: 'error', message: 'Could not prepare this page for AI editing' });
      closeSSE(controller);
    }
  })();

  return response;
}

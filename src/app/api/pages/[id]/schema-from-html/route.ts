import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { askAIStream, isRateLimited, AIResponseTruncatedError } from '@/lib/ai-client';
import { uploadHtml, downloadHtmlByPath, fileNameFromUrl } from '@/lib/storage';
import { resolveWorkspaceRole, resolveOwnerPlan } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Prepares an existing raw-HTML page (e.g. a hand-authored test variant) for
// the schema-driven AI Pages editor — WITHOUT redesigning it. Unlike
// /generate + /build, this never asks the AI to invent layout or styling.
// It only asks the AI to ANNOTATE the existing markup (add data-field +
// SL:name markers) so the byte-for-byte page keeps its exact look. The
// schema is then derived deterministically from those attributes, not
// guessed by a second AI call. Isolated from /generate, /build, /follow-up —
// none of those files are touched by this route.
const SYSTEM_PROMPT = `You are annotating an existing, already-designed landing page's HTML so it can be edited going forward through a WYSIWYG editor and an AI chat assistant — WITHOUT changing anything about how the page looks.

## Task
You will be given the complete HTML of an existing page. Return the SAME HTML with exactly two kinds of additions:

1. Add a data-field="<dot.path>" attribute to every editable text element (headings, paragraphs, labels, button/link text, list items, testimonial quotes, FAQ answers, stat numbers, etc.) and every meaningful content <img> (skip logos and purely decorative icons). Choose dot-path names that describe the section and field, following this pattern:
   - data-field="hero.headline", data-field="hero.subhead", data-field="hero.cta_text"
   - data-field="features.items.0.title", data-field="features.items.1.title"
   - data-field="testimonials.items.0.quote", data-field="testimonials.items.0.author"
   - data-field="hero.image" for an <img>
   Use the SAME path format for repeated items in a list (indexed with .0, .1, .2, ...).

2. Wrap every top-level block in HTML comment markers: the <style> block, the <nav>, each top-level <section> or major top-level content block, and the <footer>. Format (marker on its own line, immediately before/after the element):
   <!-- SL:name -->
   ...the element...
   <!-- /SL:name -->
   Use name="head" for <style>, name="nav" for <nav>, name="footer" for <footer>, and a short kebab-case slug per section (suffix -2, -3 for duplicate names).

## CRITICAL rules — this is an annotation pass, NOT a rewrite
- Do NOT change, rewrite, reformat, reorder, add, or remove any element, class, inline style, CSS rule, script, attribute value, or text content.
- Do NOT restyle anything. Do NOT "improve" or "fix" the design, layout, or spacing, even if it looks unusual.
- The ONLY changes allowed are: adding data-field="..." attributes, and adding <!-- SL:name --> / <!-- /SL:name --> comment markers around top-level blocks.
- Preserve every other byte of the HTML exactly as given.
- Return the complete HTML document only, starting with <!DOCTYPE html>. No explanation, no markdown fences, no extra text.`;

function minifyHtmlForModel(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

// Builds the schema object purely from data-field attributes already present
// in the annotated HTML — deterministic, no AI guessing, always in sync with
// what's actually on the page since it's derived FROM the page.
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

function extractAttr(attrsStr: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrsStr);
  return m ? m[1] : null;
}

function stripTagsAndDecode(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveSchemaFromAnnotatedHtml(html: string): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  // Void <img> elements have no closing tag — value is the src attribute.
  const imgRe = /<img\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) {
    const attrs = m[1];
    const field = extractAttr(attrs, 'data-field');
    if (!field) continue;
    setPathValue(schema, field, extractAttr(attrs, 'src') ?? '');
  }

  // Any other tag carrying data-field — value is its inner text, tags stripped.
  // Non-greedy match to the first matching closing tag; data-field is only
  // ever applied to leaf-level content elements per the system prompt, so
  // same-tag-name nesting inside a tagged element is not expected in practice.
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  while ((m = tagRe.exec(html))) {
    const [, tag, attrs, inner] = m;
    if (tag.toLowerCase() === 'img') continue;
    const field = extractAttr(attrs, 'data-field');
    if (!field) continue;
    setPathValue(schema, field, stripTagsAndDecode(inner));
  }

  return schema;
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

  let annotatedHtml: string;
  try {
    // Streamed even though we don't need the chunks — matches every other
    // large-output AI call in this app (build/follow-up) to avoid the
    // Anthropic SDK's non-streaming HTTP timeout at high maxTokens.
    const text = await askAIStream(
      {
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Existing page HTML:\n${htmlForModel}` }],
        maxTokens: 32000,
      },
      () => {},
    );

    annotatedHtml = text.trim();
    if (annotatedHtml.startsWith('```')) {
      annotatedHtml = annotatedHtml.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }
    if (!annotatedHtml.startsWith('<!DOCTYPE') && !annotatedHtml.startsWith('<html')) {
      throw new Error('AI provider returned invalid HTML');
    }
  } catch (err) {
    if (err instanceof AIResponseTruncatedError) {
      return NextResponse.json({ error: 'This page is too large to prepare for AI editing in one pass.' }, { status: 500 });
    }
    console.error('[schema-from-html] annotation failed', err);
    return NextResponse.json({ error: 'Could not prepare this page for AI editing' }, { status: 500 });
  }

  const schemaJson = deriveSchemaFromAnnotatedHtml(annotatedHtml);
  if (Object.keys(schemaJson).length === 0) {
    console.error('[schema-from-html] AI returned HTML with no data-field annotations');
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

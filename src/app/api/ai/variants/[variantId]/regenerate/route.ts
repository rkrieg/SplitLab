import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { LANDING_PAGE_FRAMEWORK } from '@/lib/landing-page-framework';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const VARIANTS_BUCKET = 'variants';

// Prepare HTML for Claude's context — strip non-text elements to reduce tokens
function prepareHtml(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, (match) => {
    return match.length > 500 ? '<!-- svg -->' : match;
  });
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  if (s.length > 100_000) s = s.slice(0, 100_000) + '\n<!-- truncated -->';
  return s;
}

function absolutifyUrls(html: string, sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  const origin = parsed.origin;

  let result = html;
  result = result.replace(/((?:href|src|action|poster)\s*=\s*["'])\/((?!\/)[^"']*["'])/gi, `$1${origin}/$2`);
  result = result.replace(/url\(\s*(['"]?)\/((?!\/)[^)'"]*)\1\s*\)/gi, `url($1${origin}/$2$1)`);
  result = result.replace(/(srcset\s*=\s*["'])([^"']+)(["'])/gi, (_match, pre: string, value: string, post: string) => {
    const fixed = value.replace(/(^|,\s*)\/((?!\/)[^\s,]+)/g, `$1${origin}/$2`);
    return pre + fixed + post;
  });

  return result;
}

function applyReplacements(html: string, replacements: Array<{ find: string; replace: string }>): string {
  let result = html;
  let applied = 0;
  for (const { find, replace } of replacements) {
    if (!find || find === replace) continue;

    if (result.includes(find)) {
      result = result.replace(find, replace);
      applied++;
      continue;
    }

    const parts = find.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      console.warn(`[Regenerate] Replacement not found: "${find.slice(0, 80)}..."`);
      continue;
    }
    const pattern = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    try {
      const regex = new RegExp(pattern);
      if (regex.test(result)) {
        result = result.replace(regex, replace);
        applied++;
      } else {
        console.warn(`[Regenerate] Replacement not found (flex): "${find.slice(0, 80)}..."`);
      }
    } catch {
      console.warn(`[Regenerate] Invalid regex for replacement: "${find.slice(0, 80)}..."`);
    }
  }
  console.log(`[Regenerate] Applied ${applied}/${replacements.length} replacements`);
  return result;
}

interface DiffResponse {
  replacements: Array<{ find: string; replace: string }>;
  changes_summary: Array<{ change: string; reason: string }>;
  variant_label: string;
  impact_hypothesis: string;
}

function parseDiffResponse(response: string): DiffResponse {
  try {
    return JSON.parse(response);
  } catch {
    const match = response.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned invalid JSON for variant regeneration');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { variantId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { variantId } = params;
  let instructions: string | undefined;

  try {
    const body = await request.json();
    instructions = body.instructions;
  } catch {
    // No body is fine — instructions are optional
  }

  const { data: variantPage, error: vpErr } = await db
    .from('variant_pages')
    .select('*')
    .eq('variant_id', variantId)
    .order('version', { ascending: false })
    .limit(1)
    .single();

  if (vpErr || !variantPage) {
    return NextResponse.json({ error: 'Variant page not found' }, { status: 404 });
  }

  const { data: scrapedPage, error: scrapeErr } = await db
    .from('scraped_pages')
    .select('*')
    .eq('url', variantPage.source_url)
    .order('scraped_at', { ascending: false })
    .limit(1)
    .single();

  if (scrapeErr || !scrapedPage) {
    return NextResponse.json({ error: 'Original scraped page not found' }, { status: 404 });
  }

  const { data: variant } = await db
    .from('test_variants')
    .select('name')
    .eq('id', variantId)
    .single();

  const variantName = variant?.name || 'Variant';
  const strategyLabel = variantName.replace(/^AI:\s*/, '');

  const preparedHtml = prepareHtml(scrapedPage.html);

  let prompt = `## YOUR TASK

Regenerate an A/B test variant of this landing page using the "${strategyLabel}" strategy. This is a REGENERATION — produce DIFFERENT changes than before, with a fresh creative angle while staying within the strategy.

You will produce a list of find-and-replace operations. These replacements will be applied to the original HTML. The page structure, design, and layout stay EXACTLY the same — only text content changes.

Your "find" strings must be VISIBLE TEXT from the page — the words a visitor reads. Do NOT include HTML tags, CSS, or attributes in find strings. Find strings should be long enough to be unique (a full phrase or sentence).

- Keep replacement text within ±20% of the original length
- Produce 5-8 focused replacements
- Match the page's original tone and voice

## Page Analysis
${JSON.stringify(scrapedPage.analysis || {}, null, 2)}

## Source URL: ${scrapedPage.url}

## Response Format
Return ONLY valid JSON, no markdown code fences:
{
  "replacements": [
    {"find": "exact visible text from the page", "replace": "improved text"},
    ...
  ],
  "changes_summary": [{"change": "what was changed", "reason": "why"}],
  "variant_label": "${strategyLabel}",
  "impact_hypothesis": "specific prediction about performance"
}

## ORIGINAL HTML (for context — find strings should be VISIBLE TEXT only)
${preparedHtml}`;

  if (instructions) {
    prompt += `\n\n## Additional Instructions\n${instructions}`;
  }

  try {
    console.log(`[Regenerate] Starting, prompt length: ${prompt.length} chars`);
    const response = await ask(prompt, {
      system: `You are a senior CRO specialist creating A/B test variants. You make precise, focused text changes. Follow the framework below.\n\n${LANDING_PAGE_FRAMEWORK}`,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
    });

    console.log(`[Regenerate] Response length: ${response.length} chars`);
    const parsed = parseDiffResponse(response);
    console.log(`[Regenerate] Parsed OK, ${parsed.replacements?.length || 0} replacements`);

    // Apply text replacements to the ORIGINAL HTML
    const modifiedHtml = applyReplacements(scrapedPage.html, parsed.replacements || []);
    const variantHtml = absolutifyUrls(modifiedHtml, scrapedPage.url);

    const { error: uploadErr } = await db.storage
      .from(VARIANTS_BUCKET)
      .upload(variantPage.html_storage_path, variantHtml, {
        contentType: 'text/html; charset=utf-8',
        upsert: true,
      });

    if (uploadErr) {
      return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 });
    }

    const newVersion = variantPage.version + 1;
    await db
      .from('variant_pages')
      .update({
        version: newVersion,
        changes_summary: parsed.changes_summary,
        generation_prompt: prompt.slice(0, 10000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', variantPage.id);

    return NextResponse.json({
      success: true,
      version: newVersion,
      label: parsed.variant_label,
      impact_hypothesis: parsed.impact_hypothesis,
      changes_summary: parsed.changes_summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Regeneration failed';
    console.error('[Regenerate] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

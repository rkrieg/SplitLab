import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { LANDING_PAGE_FRAMEWORK } from '@/lib/landing-page-framework';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const VARIANTS_BUCKET = 'variants';

function parseClaudeResponse(response: string): {
  html: string;
  changes_summary: Array<{ change: string; reason: string }>;
  variant_label: string;
  impact_hypothesis: string;
} {
  try {
    return JSON.parse(response);
  } catch {
    const match = response.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned invalid JSON');
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

  // Fetch variant_pages to get source_url and previous prompt
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

  // Fetch original scraped page by source_url
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

  // Fetch the variant record for its name/label
  const { data: variant } = await db
    .from('test_variants')
    .select('name')
    .eq('id', variantId)
    .single();

  const variantName = variant?.name || 'Variant';

  // Build regeneration prompt
  const truncatedHtml =
    scrapedPage.html.length > 60_000
      ? scrapedPage.html.slice(0, 60_000) + '\n<!-- truncated -->'
      : scrapedPage.html;

  let prompt = `Regenerate a variant of this landing page. The variant name is "${variantName}". This is a VARIATION of the original — NOT a redesign.

## Original Page Analysis
${JSON.stringify(scrapedPage.analysis || {}, null, 2)}

## Original Page Source URL
${scrapedPage.url}

## Requirements
1. Return a COMPLETE, self-contained HTML page with ALL CSS inlined
2. Keep ALL original image URLs exactly as they are
3. The page MUST be fully responsive (mobile-first, 390px through 1440px+)
4. Add data-sl-editable="true" attribute on all text-containing elements
5. Preserve any tracking scripts or meta tags from the original
6. Do NOT add external CSS frameworks or JS libraries

## Response Format
Return ONLY valid JSON:
{
  "html": "<!DOCTYPE html>...complete HTML page...",
  "changes_summary": [
    { "change": "description", "reason": "why" }
  ],
  "variant_label": "${variantName}",
  "impact_hypothesis": "hypothesis about conversion impact"
}

## Original HTML
${truncatedHtml}`;

  if (instructions) {
    prompt += `\n\n## Additional Instructions\n${instructions}`;
  }

  try {
    const response = await ask(prompt, {
      system: `You are a senior CRO specialist creating A/B test variants of landing pages. Follow the framework below precisely.\n\n${LANDING_PAGE_FRAMEWORK}`,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 16384,
    });

    const parsed = parseClaudeResponse(response);

    // Upload new HTML
    const { error: uploadErr } = await db.storage
      .from(VARIANTS_BUCKET)
      .upload(variantPage.html_storage_path, parsed.html, {
        contentType: 'text/html; charset=utf-8',
        upsert: true,
      });

    if (uploadErr) {
      return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 });
    }

    // Update variant_pages
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
    console.error('[regenerate] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

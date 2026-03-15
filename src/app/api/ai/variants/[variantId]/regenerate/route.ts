import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { LANDING_PAGE_FRAMEWORK } from '@/lib/landing-page-framework';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const VARIANTS_BUCKET = 'variants';

// Keep in sync with generate/route.ts
function prepareHtml(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, (match) => {
    return match.length > 500 ? '<!-- svg-placeholder -->' : match;
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

    // Whitespace-flexible match for collapsed-whitespace find strings
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

  // Determine the strategy from variant name (e.g. "AI: Conversion-Focused")
  const strategyLabel = variantName.replace(/^AI:\s*/, '');

  const preparedHtml = prepareHtml(scrapedPage.html);

  let prompt = `## YOUR TASK
You will receive the HTML of a landing page. Produce a list of find-and-replace operations to create an A/B test variant using the "${strategyLabel}" strategy.

You are NOT rebuilding the page. You are specifying targeted text replacements that will be applied to the original HTML. The original page stays intact except for your replacements.

This is a REGENERATION — produce DIFFERENT changes than the previous version. Be creative with new angles while staying within the strategy.

## RULES FOR REPLACEMENTS
- Each "find" string must be an EXACT substring of the original HTML (case-sensitive, character-for-character)
- Each "find" must be unique enough to match only once in the HTML
- Aim for 8-20 replacements total
- Focus on: CTA button text, subheadlines, paragraph body copy, and descriptive text
- Replacement text must be SIMILAR LENGTH to the original — never dramatically longer or shorter, as this breaks CSS layouts
- You may also change CSS property values (padding, margins) but ONLY for spacing, never colors or fonts

## CRITICAL: DO NOT BREAK THE LAYOUT
- NEVER change text inside elements that use background-clip, text-fill, image-masked text, or decorative CSS text effects — these are sized for specific text and will break visually
- NEVER change very short text (1-2 words) inside heavily styled elements — these are likely decorative
- When in doubt about whether text has special styling, SKIP IT
- Replacement text should be approximately the same character count as the original (within ±20%)

## COPY QUALITY RULES
- Write like a professional copywriter, NOT a used car salesman
- NEVER use words like: URGENT, TIME-SENSITIVE, ACT NOW, DON'T MISS, EXCLUSIVE, WINNERS, GAME-CHANGER, REVOLUTIONARY, SKYROCKET
- NEVER prefix text with labels like "URGENT:" or "TIME-SENSITIVE:" or "LIMITED:"
- NEVER use ALL CAPS for emphasis (unless the original text was all caps)
- Keep the same tone and voice as the original page — if it's professional, stay professional
- Be specific and concrete, not hyperbolic
- Good example: "Contact Us" → "Get Your Free Strategy Call"
- Bad example: "Contact Us" → "CLAIM YOUR SPOT NOW BEFORE IT'S TOO LATE"

## WHAT YOU MUST NOT DO
- Add entirely new HTML sections or elements
- Invent statistics, testimonials, customer counts, or claims
- Add countdown timers, popups, or animations
- Change image URLs or remove images
- Add external CSS/JS libraries or emoji

## Page Analysis
${JSON.stringify(scrapedPage.analysis || {}, null, 2)}

## Source URL: ${scrapedPage.url}

## Response Format: ONLY valid JSON, no markdown fences
{
  "replacements": [
    {"find": "exact string from original HTML", "replace": "replacement string"},
    ...
  ],
  "changes_summary": [{"change": "what changed", "reason": "CRO rationale"}],
  "variant_label": "${strategyLabel}",
  "impact_hypothesis": "why this variant may convert better"
}

## ORIGINAL HTML
${preparedHtml}`;

  if (instructions) {
    prompt += `\n\n## Additional User Instructions\n${instructions}`;
  }

  try {
    console.log(`[Regenerate] Starting regeneration for variant ${variantId}, prompt length: ${prompt.length} chars`);
    const response = await ask(prompt, {
      system: `You are a senior CRO specialist creating A/B test variants of landing pages. Follow the framework below precisely.\n\n${LANDING_PAGE_FRAMEWORK}`,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 16384,
    });

    console.log(`[Regenerate] Response length: ${response.length} chars`);
    const parsed = parseDiffResponse(response);
    console.log(`[Regenerate] Parsed OK, ${parsed.replacements?.length || 0} replacements`);

    // Apply replacements to the ORIGINAL HTML so all content is preserved
    const modifiedHtml = applyReplacements(scrapedPage.html, parsed.replacements || []);
    const variantHtml = absolutifyUrls(modifiedHtml, scrapedPage.url);

    // Upload new HTML
    const { error: uploadErr } = await db.storage
      .from(VARIANTS_BUCKET)
      .upload(variantPage.html_storage_path, variantHtml, {
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
    console.error('[Regenerate] error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

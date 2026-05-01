import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { searchImages } from '@/lib/unsplash';
import { buildClonePrompt } from '@/lib/page-builder-prompts';
import { scorePage } from '@/lib/page-quality';
import { uploadHtml } from '@/lib/storage';
import { prepareHtml } from '@/lib/variant-utils';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

interface VariantAngle {
  label: string;
  focus: string;
  hypothesis: string;
  guidance: string;
}

const DEFAULT_ANGLES: VariantAngle[] = [
  {
    label: 'Headline & Value Prop',
    focus: 'headlines and value proposition',
    hypothesis: 'Clearer, benefit-driven headlines will increase engagement and CTA clicks by 15–25%.',
    guidance:
      'Rewrite ALL section headlines and the main value proposition to be more specific and benefit-driven. Keep the exact same visual design, layout, colors, images, and structure. Only change the wording of headlines and value prop text.',
  },
  {
    label: 'Outcome-Focused CTAs',
    focus: 'calls-to-action and action-oriented copy',
    hypothesis: 'More specific, outcome-focused CTAs will increase click-through rates by 10–20%.',
    guidance:
      'Rewrite all CTA button text and nearby action copy to communicate a specific outcome (e.g., "Get My Free Strategy Session" instead of "Contact Us"). Keep the exact same visual design, layout, colors, images, and all non-CTA text.',
  },
  {
    label: 'Benefit-Driven Body Copy',
    focus: 'body copy and service descriptions',
    hypothesis: 'Rewriting feature-focused copy to lead with client benefits will better communicate value.',
    guidance:
      'Rewrite all body paragraphs and service descriptions to lead with the benefit the client gets, not the feature. Keep the exact same visual design, layout, colors, images, headlines, and CTAs.',
  },
];

/**
 * Generate a complete standalone HTML page for one variant angle.
 * Uses buildClonePrompt so each variant is a real page (not a text patch).
 */
async function generateVariantPage(
  angle: VariantAngle,
  scrapedHtml: string,
  sourceUrl: string,
  analysis: Record<string, unknown>,
  imageUrls: Awaited<ReturnType<typeof searchImages>>,
  baseInstructions?: string
): Promise<string> {
  const angleInstructions = [
    `## CRO STRATEGY: ${angle.label}`,
    `HYPOTHESIS: ${angle.hypothesis}`,
    `FOCUS: ${angle.focus}`,
    `INSTRUCTIONS: ${angle.guidance}`,
    baseInstructions?.trim()
      ? `\n## ADDITIONAL USER INSTRUCTIONS (apply these too):\n${baseInstructions.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const originalHtmlContext = prepareHtml(scrapedHtml).slice(0, 30_000);

  const { system, user } = buildClonePrompt({
    originalHtmlContext,
    sourceUrl,
    analysis: analysis as Parameters<typeof buildClonePrompt>[0]['analysis'],
    instructions: angleInstructions,
    imageUrls,
  });

  const html = await ask(user, {
    system,
    model: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
  });

  let finalHtml = html.trim();
  if (finalHtml.startsWith('```')) {
    finalHtml = finalHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
  }
  if (!finalHtml.startsWith('<!DOCTYPE') && !finalHtml.startsWith('<html')) {
    finalHtml = '<!DOCTYPE html>\n' + finalHtml;
  }

  const lower = finalHtml.toLowerCase();
  if (!lower.includes('</body>') && !lower.includes('</html>')) {
    finalHtml += '\n</body></html>';
  } else if (!lower.includes('</html>')) {
    finalHtml += '\n</html>';
  }

  return finalHtml;
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let scrapedPageId: string;
  let testId: string;
  let numVariants: number;
  let instructions: string | undefined;

  try {
    const body = await request.json();
    scrapedPageId = body.scraped_page_id;
    testId = body.test_id;
    numVariants = body.num_variants ?? 3;
    instructions = body.instructions;

    if (!scrapedPageId || !testId) throw new Error('Missing required fields');
    numVariants = Math.min(3, Math.max(1, numVariants));
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request. Required: scraped_page_id, test_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { data: test, error: testErr } = await db
    .from('tests')
    .select('id, workspace_id')
    .eq('id', testId)
    .single();

  if (testErr || !test) {
    return new Response(JSON.stringify({ error: 'Test not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { data: scrapedPage, error: scrapeErr } = await (db
    .from('scraped_pages')
    .select('*')
    .eq('id', scrapedPageId)
    .single() as unknown as Promise<{
      data: { id: string; html: string; url: string; analysis: Record<string, unknown> } | null;
      error: { message: string } | null;
    }>);

  if (scrapeErr || !scrapedPage) {
    return new Response(JSON.stringify({ error: 'Scraped page not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const angles = DEFAULT_ANGLES.slice(0, numVariants);
  const workspaceId = test.workspace_id as string;
  const analysis = (scrapedPage.analysis || {}) as Record<string, unknown>;

  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      function sendEvent(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      }

      keepalive = setInterval(() => {
        sendEvent('keepalive', { timestamp: Date.now() });
      }, 8_000);

      try {
        sendEvent('started', {
          total_variants: angles.length,
          strategies: angles.map(a => a.label),
        });

        // Search images once for all variants
        const searchQuery = [
          (analysis.primary_offer as string | undefined),
          (analysis.page_type as string | undefined),
          (analysis.target_audience as string | undefined),
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 200) || 'professional business';

        const imageUrls = await searchImages(searchQuery, 'other');

        sendEvent('generating', {
          strategies: angles.map((a, i) => ({ index: i, label: a.label, status: 'in_progress' })),
        });

        // Generate all variants in parallel
        const variantPromises = angles.map(async (angle, index) => {
          const html = await generateVariantPage(
            angle,
            scrapedPage.html,
            scrapedPage.url,
            analysis,
            imageUrls,
            instructions
          );
          return { index, angle, html };
        });

        const results = await Promise.allSettled(variantPromises);

        for (const result of results) {
          if (result.status === 'rejected') {
            const idx = results.indexOf(result);
            const errMsg = (result.reason as Error)?.message || 'Generation failed';
            console.error(`[AI Generate] Variant ${idx} failed:`, errMsg);
            sendEvent('variant_error', {
              index: idx,
              label: angles[idx]?.label,
              error: errMsg,
            });
            continue;
          }

          const { index, angle, html: finalHtml } = result.value;

          try {
            // Score quality
            const quality = scorePage(finalHtml, 'other');

            // Save to pages table
            const pageId = crypto.randomUUID();
            const storagePath = `pages/${workspaceId}/${pageId}.html`;
            const publicUrl = await uploadHtml(storagePath, finalHtml);

            const pageName = `${angle.label} Variant`;
            const { error: pageInsertErr } = await db.from('pages').insert({
              id: pageId,
              workspace_id: workspaceId,
              name: pageName,
              slug: pageId,
              html_url: publicUrl,
              html_content: finalHtml.length < 500_000 ? finalHtml : null,
              status: 'active',
              prompt: `A/B Variant: ${angle.label}\n${angle.hypothesis}`,
              vertical: 'other',
              quality_score: quality.score,
              quality_details: quality.details,
              source_type: 'ai_generated',
              version: 1,
            });

            if (pageInsertErr) throw new Error(`Failed to save page: ${pageInsertErr.message}`);

            const serveUrl = `/api/pages/${pageId}/serve`;
            const variantId = crypto.randomUUID();
            const weight = Math.floor(100 / (angles.length + 1));

            // Save to test_variants — hosted_url points to our generated page
            const { error: variantErr } = await (db.from('test_variants').insert({
              id: variantId,
              test_id: testId,
              name: `AI: ${angle.label}`,
              traffic_weight: weight,
              is_control: false,
              is_ai_generated: true,
              variant_type: 'hosted',
              hosted_url: serveUrl,
            }) as unknown as Promise<{ error: { message: string } | null }>);

            if (variantErr) throw new Error(`Failed to create variant record: ${variantErr.message}`);

            // Save variant_pages for tracking
            await (db.from('variant_pages').insert({
              variant_id: variantId,
              html_storage_path: storagePath,
              source_url: scrapedPage.url,
              generation_prompt: `${angle.label}: ${angle.hypothesis}`.slice(0, 10000),
              changes_summary: [
                { change: angle.label, reason: angle.hypothesis },
                { change: angle.guidance, reason: angle.focus },
              ],
              status: 'ready',
            }) as unknown as Promise<{ error: { message: string } | null }>);

            sendEvent('variant_ready', {
              index,
              variant_id: variantId,
              page_id: pageId,
              label: angle.label,
              impact_hypothesis: angle.hypothesis,
              changes_summary: [
                { change: `${angle.label} rewrite`, reason: angle.hypothesis },
                { change: 'Standalone generated page', reason: 'No dependency on original site assets or URLs' },
              ],
              serve_url: serveUrl,
              hosted_url: serveUrl,
              html: finalHtml,
              status: 'ready',
            });
          } catch (saveErr) {
            const errMsg = saveErr instanceof Error ? saveErr.message : 'Save failed';
            console.error(`[AI Generate] Variant ${index} save failed:`, errMsg);
            sendEvent('variant_error', { index, label: angle.label, error: errMsg });
          }
        }

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        sendEvent('complete', {
          total: angles.length,
          succeeded,
          failed: angles.length - succeeded,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Generation failed';
        console.error('[AI Generate] Fatal error:', message);
        sendEvent('error', { error: message });
      } finally {
        if (keepalive) clearInterval(keepalive);
        keepalive = null;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

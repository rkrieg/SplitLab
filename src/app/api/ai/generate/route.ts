import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { uploadHtml } from '@/lib/storage';
import { prepareHtml, applyReplacements, injectBaseTag } from '@/lib/variant-utils';

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
      'Rewrite section headlines and the main value proposition text to be more specific and benefit-driven. ' +
      'Target <h1>, <h2>, <h3> tags and the subheadline paragraphs immediately beneath them. ' +
      'Do NOT touch CTA buttons, navigation, body paragraphs, testimonials, or footer. ' +
      'Do NOT change images, colors, fonts, layout, or CSS.',
  },
  {
    label: 'Outcome-Focused CTAs',
    focus: 'calls-to-action and action-oriented copy',
    hypothesis: 'More specific, outcome-focused CTAs will increase click-through rates by 10–20%.',
    guidance:
      'Rewrite CTA button text and any copy immediately adjacent to CTAs to communicate a specific outcome ' +
      '(e.g., "Get My Free Strategy Session" instead of "Get In Touch"). ' +
      'Target button text, anchor text inside buttons, and short action phrases near CTAs. ' +
      'Do NOT touch headlines, body paragraphs, testimonials, navigation items, or footer links. ' +
      'Do NOT change images, colors, fonts, layout, or CSS.',
  },
  {
    label: 'Benefit-Driven Body Copy',
    focus: 'body copy and service descriptions',
    hypothesis: 'Rewriting feature-focused copy to lead with client benefits will better communicate value.',
    guidance:
      'Rewrite body paragraphs and service description text to lead with the benefit the client gets, not the feature or process. ' +
      'Target <p> tags in the main content sections, list items describing services. ' +
      'Do NOT touch headlines, CTA buttons, navigation, testimonials, or footer. ' +
      'Do NOT change images, colors, fonts, layout, or CSS.',
  },
];

interface ReplacementResponse {
  replacements: Array<{ find: string; replace: string; description: string }>;
  changes_summary: Array<{ change: string; reason: string }>;
  impact_hypothesis: string;
}

function buildReplacementPrompt(
  html: string,
  angle: VariantAngle,
  sourceUrl: string,
  instructions?: string
): string {
  const preparedHtml = prepareHtml(html);

  return `You are a senior CRO (Conversion Rate Optimization) specialist creating a precise A/B test variant.

## STRATEGY: ${angle.label}
**Hypothesis:** ${angle.hypothesis}
**Focus Area:** ${angle.guidance}

${instructions ? `## Custom Instructions (HIGHEST PRIORITY — overrides focus area if they conflict)\n${instructions}\n` : ''}

## YOUR TASK
Produce 5–12 TEXT-ONLY replacements that change ONLY visible copy — no HTML tags, no CSS, no images.

Each replacement:
- "find": the EXACT visible text string as it appears on the page (copy from the HTML below)
- "replace": the new text (same format — plain text, no HTML tags in either field unless necessary for inline emphasis)
- "description": what changed and why

## CRITICAL RULES
1. "find" must be EXACTLY the visible text as rendered — copy-paste it from the HTML below
2. Keep "find" SHORT (5–20 words max) — find the most unique shortest version
3. Do NOT change navigation items, footer links, or legal text
4. Do NOT change anything outside the focus area
5. If a headline contains ALL CAPS text, rewrite it also in ALL CAPS
6. Match the tone and length of the original text

## Source URL: ${sourceUrl}

## Page HTML:
${preparedHtml}

## RESPONSE FORMAT
Return ONLY valid JSON (no markdown fences):
{
  "replacements": [
    {
      "find": "exact visible text from the page",
      "replace": "improved text following the strategy",
      "description": "what changed and why"
    }
  ],
  "changes_summary": [{"change": "what was changed", "reason": "why this improves conversion"}],
  "impact_hypothesis": "specific prediction about how this variant will perform vs control"
}`;
}

function parseReplacementResponse(response: string): ReplacementResponse {
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned invalid JSON for variant generation');
  }
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

        sendEvent('generating', {
          strategies: angles.map((a, i) => ({ index: i, label: a.label, status: 'in_progress' })),
        });

        // Generate all variants in parallel
        const variantPromises = angles.map(async (angle, index) => {
          const prompt = buildReplacementPrompt(
            scrapedPage.html,
            angle,
            scrapedPage.url,
            instructions
          );

          console.log(`[AI Generate] Variant ${index} (${angle.label}): requesting text replacements`);

          const response = await ask(prompt, {
            system:
              'You are a senior CRO specialist. You create A/B test variants by producing precise text-only replacements. Return only valid JSON as specified.',
            model: 'claude-sonnet-4-20250514',
            maxTokens: 4096,
          });

          const parsed = parseReplacementResponse(response);
          console.log(`[AI Generate] Variant ${index}: got ${parsed.replacements?.length ?? 0} replacements`);

          // Apply replacements to original HTML (keeps layout/CSS/images identical)
          const modifiedHtml = applyReplacements(
            scrapedPage.html,
            parsed.replacements || [],
            `[Variant ${index} (${angle.label})]`
          );

          // Inject base tag so original CSS, images, fonts load from source domain
          const finalHtml = injectBaseTag(modifiedHtml, scrapedPage.url);

          return { index, angle, html: finalHtml, parsed };
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

          const { index, angle, html: finalHtml, parsed } = result.value;

          try {
            // Save to pages table — each variant is a real stored page
            const pageId = crypto.randomUUID();
            const storagePath = `pages/${workspaceId}/${pageId}.html`;
            const publicUrl = await uploadHtml(storagePath, finalHtml);

            const { error: pageInsertErr } = await db.from('pages').insert({
              id: pageId,
              workspace_id: workspaceId,
              name: `${angle.label} Variant`,
              slug: pageId,
              html_url: publicUrl,
              html_content: finalHtml.length < 500_000 ? finalHtml : null,
              status: 'active',
              prompt: `A/B Variant: ${angle.label}\n${angle.hypothesis}`,
              vertical: 'other',
              quality_score: 75,
              source_type: 'ai_generated',
              version: 1,
            });

            if (pageInsertErr) throw new Error(`Failed to save page: ${pageInsertErr.message}`);

            const serveUrl = `/api/pages/${pageId}/serve`;
            const variantId = crypto.randomUUID();
            const weight = Math.floor(100 / (angles.length + 1));

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

            await (db.from('variant_pages').insert({
              variant_id: variantId,
              html_storage_path: storagePath,
              source_url: scrapedPage.url,
              generation_prompt: `${angle.label}: ${angle.hypothesis}`.slice(0, 10000),
              changes_summary: parsed.changes_summary,
              status: 'ready',
            }) as unknown as Promise<{ error: { message: string } | null }>);

            console.log(`[AI Generate] Variant ${index} saved as page ${pageId}`);

            sendEvent('variant_ready', {
              index,
              variant_id: variantId,
              page_id: pageId,
              label: angle.label,
              impact_hypothesis: parsed.impact_hypothesis || angle.hypothesis,
              changes_summary: parsed.changes_summary || [],
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


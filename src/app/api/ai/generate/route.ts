import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { prepareHtml, injectBaseTag } from '@/lib/variant-utils';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const VARIANTS_BUCKET = 'variants';

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
    hypothesis: 'Clearer, benefit-driven headlines and value propositions will increase engagement and CTA clicks.',
    guidance: `Focus on: section headlines, subheadlines, primary value proposition text.
Leave alone: navigation, footer, testimonials, specific numbers/stats.`,
  },
  {
    label: 'CTA & Action Copy',
    focus: 'calls-to-action and action-oriented copy',
    hypothesis: 'More specific, outcome-focused CTAs will increase click-through rates.',
    guidance: `Focus on: CTA button text, text near CTAs, generic actions like "Contact Us"/"Learn More".
Leave alone: headlines, body paragraphs, navigation, testimonials.`,
  },
  {
    label: 'Benefit-Driven Body Copy',
    focus: 'body copy and service descriptions',
    hypothesis: 'Rewriting feature-focused copy to lead with client benefits will better communicate value.',
    guidance: `Focus on: body paragraphs, service descriptions, "about us" copy.
Leave alone: headlines, CTA buttons, testimonials, navigation.`,
  },
];

function buildPatchPrompt(
  html: string,
  angle: VariantAngle,
  sourceUrl: string,
  instructions?: string
): string {
  const preparedHtml = prepareHtml(html);

  return `You are a senior CRO specialist creating an A/B test variant of a landing page.

## Strategy: ${angle.label}
**Hypothesis:** ${angle.hypothesis}
${angle.guidance}

${instructions ? `## Custom Instructions (HIGHEST PRIORITY)\n${instructions}\n\nApply these instructions. If they conflict with the strategy, custom instructions win. You CAN make visual/structural changes (CSS, backgrounds, images, layout) if the instructions ask for them.\n` : ''}

## Your Task
Produce 4-10 HTML search-and-replace patches. Each patch replaces a chunk of the original HTML with a modified version.

## Rules
1. Each "find" must be an EXACT substring from the HTML below (copy-paste, including tags and attributes)
2. Each "find" must be unique in the document — include enough surrounding HTML to be unambiguous
3. The "replace" is the modified version of that same HTML chunk
4. You can change text, CSS styles, classes, attributes, images, structure — anything within the chunk
5. Keep changes focused on supporting the hypothesis
6. Do NOT change scripts, meta tags, or analytics code
7. Make "find" strings at least 50 characters long for reliable matching

## Source URL: ${sourceUrl}

## Original HTML:
${preparedHtml}

## Response Format
Return ONLY valid JSON (no markdown fences):
{
  "patches": [
    {
      "find": "<exact HTML substring from the original>",
      "replace": "<modified HTML>",
      "description": "What was changed and why"
    }
  ],
  "changes_summary": [{"change": "what was changed", "reason": "why this helps conversion"}],
  "variant_label": "${angle.label}",
  "impact_hypothesis": "specific prediction about how this variant will perform"
}`;
}

interface PatchResponse {
  patches: Array<{ find: string; replace: string; description: string }>;
  changes_summary: Array<{ change: string; reason: string }>;
  variant_label: string;
  impact_hypothesis: string;
}

function parsePatchResponse(response: string): PatchResponse {
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

function applyPatches(html: string, patches: Array<{ find: string; replace: string; description: string }>): string {
  let result = html;
  let applied = 0;

  for (const patch of patches) {
    if (!patch.find || patch.find === patch.replace) continue;

    if (result.includes(patch.find)) {
      result = result.replace(patch.find, patch.replace);
      applied++;
      console.log(`[AI Generate] Patch applied: ${patch.description?.slice(0, 80)}`);
    } else {
      // Try with normalized whitespace
      const normalizedFind = patch.find.replace(/\s+/g, '\\s+');
      const regex = new RegExp(normalizedFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\s\+/g, '\\s+'));
      const match = result.match(regex);
      if (match) {
        result = result.replace(match[0], patch.replace);
        applied++;
        console.log(`[AI Generate] Patch applied (fuzzy): ${patch.description?.slice(0, 80)}`);
      } else {
        console.warn(`[AI Generate] Patch NOT found: ${patch.find.slice(0, 100)}`);
      }
    }
  }

  console.log(`[AI Generate] Applied ${applied}/${patches.length} patches`);
  return result;
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

    if (!scrapedPageId || !testId) {
      throw new Error('Missing required fields');
    }
    if (numVariants < 1 || numVariants > 3) {
      numVariants = Math.min(3, Math.max(1, numVariants));
    }
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

  const { data: scrapedPage, error: scrapeErr } = await db
    .from('scraped_pages')
    .select('*')
    .eq('id', scrapedPageId)
    .single();

  if (scrapeErr || !scrapedPage) {
    return new Response(JSON.stringify({ error: 'Scraped page not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const angles = DEFAULT_ANGLES.slice(0, numVariants);

  const { data: buckets } = await db.storage.listBuckets();
  const bucketExists = buckets?.some((b) => b.name === VARIANTS_BUCKET);
  if (!bucketExists) {
    const { error: createErr } = await db.storage.createBucket(VARIANTS_BUCKET, {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024,
    });
    if (createErr) {
      console.error('Failed to create variants bucket:', createErr);
      return new Response(
        JSON.stringify({ error: `Storage setup failed: ${createErr.message}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: string, data: unknown) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      }

      sendEvent('started', {
        total_variants: angles.length,
        strategies: angles.map((a) => a.label),
      });

      sendEvent('generating', {
        strategies: angles.map((a, i) => ({ index: i, label: a.label, status: 'in_progress' })),
      });

      const keepalive = setInterval(() => {
        sendEvent('keepalive', { timestamp: Date.now() });
      }, 10_000);

      const variantPromises = angles.map(async (angle, index) => {
        const prompt = buildPatchPrompt(
          scrapedPage.html,
          angle,
          scrapedPage.url,
          instructions
        );

        console.log(`[AI Generate] Starting variant ${index} (${angle.label}), prompt length: ${prompt.length} chars`);
        const response = await ask(prompt, {
          system: 'You are a senior CRO specialist. You create A/B test variants by producing precise HTML patches. Your patches must use exact HTML substrings from the original document as "find" values.',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
        });
        console.log(`[AI Generate] Variant ${index} response length: ${response.length} chars`);

        return { index, angle, prompt, response };
      });

      const results = await Promise.allSettled(variantPromises);
      clearInterval(keepalive);
      const completed: unknown[] = [];

      for (const result of results) {
        if (result.status === 'rejected') {
          const idx = results.indexOf(result);
          console.error(`Variant ${idx} failed:`, result.reason);
          sendEvent('variant_error', {
            index: idx,
            label: angles[idx]?.label,
            error: result.reason?.message || 'Generation failed',
          });
          continue;
        }

        const { index, angle, prompt, response } = result.value;
        try {
          const parsed = parsePatchResponse(response);

          // Apply HTML patches to the original
          const modifiedHtml = applyPatches(scrapedPage.html, parsed.patches || []);
          const variantHtml = injectBaseTag(modifiedHtml, scrapedPage.url);

          const variantId = crypto.randomUUID();
          const weight = Math.floor(100 / (angles.length + 1));

          const { error: variantErr } = await db.from('test_variants').insert({
            id: variantId,
            test_id: testId,
            name: `AI: ${angle.label}`,
            traffic_weight: weight,
            is_control: false,
            is_ai_generated: true,
            variant_type: 'hosted',
          });

          if (variantErr) throw new Error(`Failed to create variant: ${variantErr.message}`);

          const storagePath = `${testId}/${variantId}.html`;
          const { error: uploadErr } = await db.storage
            .from(VARIANTS_BUCKET)
            .upload(storagePath, variantHtml, {
              contentType: 'text/html; charset=utf-8',
              upsert: true,
            });

          if (uploadErr) throw new Error(`Failed to upload HTML: ${uploadErr.message}`);

          const { data: urlData } = db.storage
            .from(VARIANTS_BUCKET)
            .getPublicUrl(storagePath);

          await db
            .from('test_variants')
            .update({ hosted_url: urlData.publicUrl })
            .eq('id', variantId);

          const { error: pageErr } = await db.from('variant_pages').insert({
            variant_id: variantId,
            html_storage_path: storagePath,
            source_url: scrapedPage.url,
            generation_prompt: prompt.slice(0, 10000),
            changes_summary: parsed.changes_summary,
            status: 'ready',
          });

          if (pageErr) throw new Error(`Failed to create variant_page: ${pageErr.message}`);

          const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://www.trysplitlab.com';
          const previewUrl = `${APP_URL}/api/variants/${testId}/${variantId}`;

          const variantResult = {
            index,
            variant_id: variantId,
            label: parsed.variant_label,
            impact_hypothesis: parsed.impact_hypothesis,
            changes_summary: parsed.changes_summary,
            hosted_url: previewUrl,
            status: 'ready',
          };

          sendEvent('variant_ready', variantResult);
          completed.push(variantResult);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Generation failed';
          console.error(`Variant ${index} (${angle.label}) failed:`, err);
          sendEvent('variant_error', { index, label: angle.label, error: message });
        }
      }

      sendEvent('complete', {
        total: angles.length,
        succeeded: completed.length,
        failed: angles.length - completed.length,
      });

      controller.close();
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

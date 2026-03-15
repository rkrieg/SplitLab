import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';
import { LANDING_PAGE_FRAMEWORK } from '@/lib/landing-page-framework';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const VARIANTS_BUCKET = 'variants';

interface VariantStrategy {
  label: string;
  angle: string;
  directives: string;
}

const STRATEGIES: VariantStrategy[] = [
  {
    label: 'Urgency & Scarcity',
    angle: 'urgency_scarcity',
    directives: `Apply subtle urgency and scarcity to the EXISTING copy and CTAs:
- Adjust existing CTA text to be slightly more action-oriented (e.g. "Get Started" → "Get Started Today")
- Add subtle time-sensitivity to existing headlines or subheadings where natural
- If testimonials exist, reorder to place the strongest one first
- Make existing CTA buttons slightly more prominent (bigger, bolder color)
- NEVER add countdown timers, fake stock counters, or pop-ups
- NEVER fabricate statistics, customer counts, or social proof that isn't in the original`,
  },
  {
    label: 'Trust & Authority',
    angle: 'trust_authority',
    directives: `Reorganize existing content to emphasize trust and credibility:
- If testimonials/reviews exist, move them higher on the page
- If credentials or logos exist, make them more prominent
- Adjust CTA tone to be more consultative (e.g. "Buy Now" → "See How It Works")
- Add a small trust line near existing CTAs (e.g. "No commitment required")
- Make the layout feel more premium — more whitespace, cleaner typography
- NEVER invent testimonials, case studies, awards, or credentials not in the original`,
  },
  {
    label: 'Simplified & Direct',
    angle: 'simplified_direct',
    directives: `Streamline the existing page by removing clutter:
- Consolidate repetitive sections — combine or remove the weakest ones
- Reduce copy length — tighten every paragraph, cut filler words
- Use one clear, consistent CTA repeated 2-3 times max
- Increase whitespace between sections for better visual breathing room
- Remove secondary navigation, sidebars, or distracting elements
- Make the core value proposition unmistakable in the first viewport`,
  },
];

// Prepare HTML for variant generation — keep as much as possible for faithful reproduction
function prepareHtml(html: string): string {
  let s = html;
  // Remove script tags (tracking, analytics, etc.) — not needed for visual reproduction
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Replace large SVGs with placeholder but keep small ones (icons)
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, (match) => {
    return match.length > 500 ? '<!-- svg-placeholder -->' : match;
  });
  // Remove HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Collapse whitespace
  s = s.replace(/\s{2,}/g, ' ');
  // Keep up to 100K chars — Claude Sonnet handles 200K context
  if (s.length > 100_000) s = s.slice(0, 100_000) + '\n<!-- truncated -->';
  return s;
}

function buildPrompt(
  html: string,
  analysis: Record<string, unknown>,
  strategy: VariantStrategy,
  sourceUrl: string,
  instructions?: string
): string {
  const preparedHtml = prepareHtml(html);

  let prompt = `## YOUR TASK
You will receive the HTML of a landing page. Produce a list of find-and-replace operations to create an A/B test variant using the "${strategy.label}" strategy.

You are NOT rebuilding the page. You are specifying targeted text replacements that will be applied to the original HTML. The original page stays intact except for your replacements.

## RULES FOR REPLACEMENTS
- Each "find" string must be an EXACT substring of the original HTML (case-sensitive, character-for-character)
- Each "find" must be unique enough to match only once in the HTML
- Keep replacements surgical: change only what's needed for the strategy
- Aim for 5-15 replacements total
- You may change: headline/subhead text, CTA button text, paragraph copy, CSS property values (colors, sizes, padding)
- You MUST NOT: add new sections, invent content/stats/testimonials, add countdown timers, change image URLs, add external libraries, add emoji
- To reorder sections: use one replacement that moves a block (find the full section, replace with empty, then insert it elsewhere)

## Strategy: ${strategy.label}
${strategy.directives}

## Page Analysis
${JSON.stringify(analysis, null, 2)}

## Source URL: ${sourceUrl}

## Response Format: ONLY valid JSON, no markdown fences
{
  "replacements": [
    {"find": "exact string from original HTML", "replace": "replacement string"},
    ...
  ],
  "changes_summary": [{"change": "what changed", "reason": "CRO rationale"}],
  "variant_label": "${strategy.label}",
  "impact_hypothesis": "why this variant may convert better"
}

## ORIGINAL HTML
${preparedHtml}`;

  if (instructions) {
    prompt += `\n\n## Additional User Instructions\n${instructions}`;
  }

  return prompt;
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
    throw new Error('Claude returned invalid JSON for variant generation');
  }
}

function applyReplacements(html: string, replacements: Array<{ find: string; replace: string }>): string {
  let result = html;
  let applied = 0;
  for (const { find, replace } of replacements) {
    if (!find || find === replace) continue;
    if (result.includes(find)) {
      result = result.replace(find, replace);
      applied++;
    } else {
      console.warn(`[AI Generate] Replacement not found in HTML: "${find.slice(0, 80)}..."`);
    }
  }
  console.log(`[AI Generate] Applied ${applied}/${replacements.length} replacements`);
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

  // Verify test exists
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

  // Fetch scraped page data
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

  const strategies = STRATEGIES.slice(0, numVariants);

  // Ensure the variants storage bucket exists
  const { data: buckets } = await db.storage.listBuckets();
  const bucketExists = buckets?.some((b) => b.name === VARIANTS_BUCKET);
  if (!bucketExists) {
    const { error: createErr } = await db.storage.createBucket(VARIANTS_BUCKET, {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024, // 5MB
    });
    if (createErr) {
      console.error('Failed to create variants bucket:', createErr);
      return new Response(
        JSON.stringify({ error: `Storage setup failed: ${createErr.message}` }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
    console.log('[AI Generate] Created variants storage bucket');
  }

  // SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function sendEvent(event: string, data: unknown) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      }

      sendEvent('started', {
        total_variants: strategies.length,
        strategies: strategies.map((s) => s.label),
      });

      // Generate all variants in PARALLEL to fit within 60s timeout
      sendEvent('generating', {
        strategies: strategies.map((s, i) => ({ index: i, label: s.label, status: 'in_progress' })),
      });

      // Send keepalive events every 10s to prevent Vercel proxy timeout
      const keepalive = setInterval(() => {
        sendEvent('keepalive', { timestamp: Date.now() });
      }, 10_000);

      // Build prompts and fire all Claude calls concurrently
      const variantPromises = strategies.map(async (strategy, index) => {
        const prompt = buildPrompt(
          scrapedPage.html,
          scrapedPage.analysis || {},
          strategy,
          scrapedPage.url,
          instructions
        );

        console.log(`[AI Generate] Starting variant ${index} (${strategy.label}), prompt length: ${prompt.length} chars`);
        const response = await ask(prompt, {
          system: `You are a senior CRO specialist creating A/B test variants of landing pages. Follow the framework below precisely.\n\n${LANDING_PAGE_FRAMEWORK}`,
          model: 'claude-sonnet-4-20250514',
          maxTokens: 16384,
        });
        console.log(`[AI Generate] Variant ${index} response length: ${response.length} chars`);

        return { index, strategy, prompt, response };
      });

      const results = await Promise.allSettled(variantPromises);
      clearInterval(keepalive);
      const completed: unknown[] = [];

      // Process results and persist to DB
      for (const result of results) {
        if (result.status === 'rejected') {
          const idx = results.indexOf(result);
          console.error(`Variant ${idx} failed:`, result.reason);
          sendEvent('variant_error', {
            index: idx,
            label: strategies[idx]?.label,
            error: result.reason?.message || 'Generation failed',
          });
          continue;
        }

        const { index, strategy, prompt, response } = result.value;
        try {
          console.log(`[AI Generate] Parsing variant ${index} response...`);
          const parsed = parseDiffResponse(response);
          console.log(`[AI Generate] Variant ${index} parsed OK, ${parsed.replacements?.length || 0} replacements`);

          // Apply replacements to the original HTML
          const variantHtml = applyReplacements(scrapedPage.html, parsed.replacements || []);

          const variantId = crypto.randomUUID();
          const weight = Math.floor(100 / (strategies.length + 1));

          const { error: variantErr } = await db.from('test_variants').insert({
            id: variantId,
            test_id: testId,
            name: `AI: ${strategy.label}`,
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
          console.error(`Variant ${index} (${strategy.label}) failed:`, err);
          sendEvent('variant_error', { index, label: strategy.label, error: message });
        }
      }

      sendEvent('complete', {
        total: strategies.length,
        succeeded: completed.length,
        failed: strategies.length - completed.length,
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

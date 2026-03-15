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
    label: 'Conversion-Focused',
    angle: 'conversion_focused',
    directives: `Optimize the page for higher conversion without changing the design:
- Rewrite CTA buttons to be specific and outcome-focused (e.g. "Contact Us" → "Get Your Free Strategy Call")
- Tighten paragraph copy — cut filler words and weak sentences by 20-30%
- Rewrite subheadlines to be benefit-driven (focus on what the visitor gets, not what the company does)
- If the page has vague headlines like "Our Services" or "What We Do", rewrite to be specific and compelling
- Make the value proposition clearer in the first section — what does the visitor get and why should they care?
- Strengthen any weak or generic body copy with more specific, concrete language`,
  },
  {
    label: 'Trust & Authority',
    angle: 'trust_authority',
    directives: `Reorganize and refine the page to build more credibility:
- Rewrite CTA buttons to feel lower-risk and consultative (e.g. "Buy Now" → "See How It Works")
- Rewrite vague subheadlines to emphasize expertise and results
- If testimonials exist, rewrite the surrounding context to draw more attention to them
- Add a brief trust line near CTAs: "No commitment required" or "Free consultation"
- Tighten any wordy paragraphs to feel more confident and direct — experts don't ramble
- Rewrite any "about us" type copy to lead with client outcomes, not company history`,
  },
  {
    label: 'Simplified & Direct',
    angle: 'simplified_direct',
    directives: `Streamline the page — cut the fat, sharpen the message:
- Rewrite all CTA buttons to use one consistent, clear action phrase across the page
- Cut paragraph copy by 30-40% — remove filler, hedging, and redundancy
- Rewrite long or wordy headlines to be shorter and punchier
- Rewrite subheadlines to be single clear sentences
- If sections repeat similar ideas, combine their copy into one tighter version
- Remove any "fluff" sentences that don't advance the reader toward the CTA`,
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

// Convert relative URLs to absolute so assets load when served from trysplitlab.com
function absolutifyUrls(html: string, sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  const origin = parsed.origin; // e.g. https://www.infinitymediala.com

  let result = html;

  // href="/..." and src="/..." (root-relative)
  result = result.replace(/((?:href|src|action|poster)\s*=\s*["'])\/((?!\/)[^"']*["'])/gi, `$1${origin}/$2`);

  // url(/...) in CSS (root-relative, with or without quotes)
  result = result.replace(/url\(\s*(['"]?)\/((?!\/)[^)'"]*)\1\s*\)/gi, `url($1${origin}/$2$1)`);

  // srcset="/..." entries
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

          // Apply replacements to the original HTML, then fix relative URLs
          const modifiedHtml = applyReplacements(scrapedPage.html, parsed.replacements || []);
          const variantHtml = absolutifyUrls(modifiedHtml, scrapedPage.url);

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

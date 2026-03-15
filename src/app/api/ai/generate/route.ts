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
  hypothesis: string;
  what_to_change: string;
  what_NOT_to_change: string;
  examples: string;
}

const STRATEGIES: VariantStrategy[] = [
  {
    label: 'Headline & Value Prop',
    angle: 'headline_value_prop',
    hypothesis: 'Clearer, benefit-driven section headlines will increase engagement and CTA clicks.',
    what_to_change: `ONLY change these elements:
- Section headlines throughout the page (e.g. "Our Services" → "How We Drive Growth")
- Subheadlines below section headers (make them benefit-driven and scannable)
- The primary value proposition text if it appears as a regular paragraph near the top`,
    what_NOT_to_change: `Leave these UNTOUCHED:
- The hero/banner area — large decorative text, image-masked text, or animated text in the hero is OFF LIMITS
- Any text that is very short (1-3 words) and appears large/decorative — this likely has special CSS sizing
- CTA button text (that's a different test)
- Body paragraph copy
- Testimonials, quotes, or social proof
- Navigation menu items, footer, or legal text
- Any numbers, statistics, or specific claims
- Service names, product names, or category labels`,
    examples: `Before: "Our Services"
After: "How We Drive Growth for Your Business"

Before: "What We Do"
After: "Marketing That Delivers Measurable Results"

Before: "Why Choose Us"
After: "Why Leading Brands Trust Our Team"`,
  },
  {
    label: 'CTA & Action Copy',
    angle: 'cta_action',
    hypothesis: 'More specific, outcome-focused CTAs will increase click-through rates.',
    what_to_change: `ONLY change these elements:
- CTA button text (make each one specific: what happens when they click?)
- Text immediately adjacent to CTAs (1 sentence before or after) to reinforce the action
- Any generic actions like "Contact Us", "Learn More", "Submit" → make specific`,
    what_NOT_to_change: `Leave these UNTOUCHED:
- ALL headlines, subheadlines, and hero text (that's a different test)
- Body paragraph copy
- Testimonials or social proof
- Navigation menu items, service names, category labels
- Footer, legal text, or any structural text
- Any decorative or large-format text`,
    examples: `Before: "Contact Us"
After: "Get Your Free Strategy Call"

Before: "Learn More"
After: "See How It Works"

Before: "Get Started"
After: "Start Your Free Consultation"`,
  },
  {
    label: 'Benefit-Driven Body Copy',
    angle: 'benefit_copy',
    hypothesis: 'Rewriting feature-focused body copy to lead with client benefits will better communicate value.',
    what_to_change: `ONLY change these elements:
- Body paragraphs (2+ sentences) that describe services or features → reframe to lead with the client benefit
- "About us" paragraphs that talk about the company → rewrite to focus on what clients get
- Service description paragraphs → reframe from "we do X" to "you get X"`,
    what_NOT_to_change: `Leave these UNTOUCHED:
- ALL headlines, subheadlines, and hero text
- CTA button text
- Testimonials or quotes (never alter someone else's words)
- Navigation menu items, service names, category labels
- Short text, labels, or list items — only change full paragraphs
- Footer, legal text, or any structural text
- Any specific numbers, statistics, or claims`,
    examples: `Before: "We offer a wide range of digital marketing services including SEO, PPC, and social media management."
After: "Grow your traffic, leads, and revenue with data-driven SEO, PPC, and social media campaigns."

Before: "Our team of experts has over 20 years of combined experience."
After: "Your campaigns are led by specialists who have driven results for over 20 years."

Before: "We pride ourselves on delivering exceptional results for our clients."
After: "Our clients see measurable growth in traffic, leads, and revenue within 90 days."`,
  },
];

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

function buildPrompt(
  html: string,
  analysis: Record<string, unknown>,
  strategy: VariantStrategy,
  sourceUrl: string,
  instructions?: string
): string {
  const preparedHtml = prepareHtml(html);

  let prompt = `## YOUR TASK

You are creating an A/B test variant of a landing page using the "${strategy.label}" strategy.

**Hypothesis:** ${strategy.hypothesis}

You will produce a list of find-and-replace operations. These replacements will be applied to the original HTML to create the variant. The page structure, design, and layout stay EXACTLY the same — only the text content changes.

## WHAT TO CHANGE
${strategy.what_to_change}

## WHAT NOT TO CHANGE
${strategy.what_NOT_to_change}

## EXAMPLES OF GOOD CHANGES
${strategy.examples}

## HOW TO FORMAT REPLACEMENTS

Your "find" strings must be the VISIBLE TEXT that appears on the page — the actual words a visitor reads. Do NOT include HTML tags, CSS classes, or attributes in your find strings.

- Find the exact text as it appears in the HTML (between tags, not including tags)
- Make find strings long enough to be unique (a full phrase or sentence)
- Keep replacement text within ±20% of the original length
- Produce 5-8 focused replacements that all support the hypothesis

## Page Analysis
${JSON.stringify(analysis, null, 2)}

## Source URL: ${sourceUrl}

## Response Format
Return ONLY valid JSON, no markdown code fences:
{
  "replacements": [
    {"find": "exact visible text from the page", "replace": "improved text"},
    ...
  ],
  "changes_summary": [{"change": "what was changed", "reason": "why this supports the hypothesis"}],
  "variant_label": "${strategy.label}",
  "hypothesis": "${strategy.hypothesis}",
  "impact_hypothesis": "specific prediction about how this variant will perform differently"
}

## ORIGINAL HTML (for context — find strings should be VISIBLE TEXT, not raw HTML)
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
  const origin = parsed.origin;

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

// Apply text replacements to the original HTML.
// Find strings are VISIBLE TEXT (no HTML tags), so we search for them
// as literal text content within the HTML. We try exact match first,
// then whitespace-flexible match for multi-word strings.
function applyReplacements(html: string, replacements: Array<{ find: string; replace: string }>): string {
  let result = html;
  let applied = 0;
  for (const { find, replace } of replacements) {
    if (!find || find === replace) continue;

    // First try exact match (text may appear verbatim in the HTML)
    if (result.includes(find)) {
      result = result.replace(find, replace);
      applied++;
      continue;
    }

    // Whitespace-flexible match: the text in the HTML may have newlines/extra spaces
    // between words that were collapsed when Claude read the prepared version
    const parts = find.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      console.warn(`[AI Generate] Replacement not found: "${find.slice(0, 80)}..."`);
      continue;
    }
    // Escape each word for regex, join with flexible whitespace
    const pattern = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    try {
      const regex = new RegExp(pattern);
      if (regex.test(result)) {
        result = result.replace(regex, replace);
        applied++;
      } else {
        console.warn(`[AI Generate] Replacement not found (flex): "${find.slice(0, 80)}..."`);
      }
    } catch {
      console.warn(`[AI Generate] Invalid regex for replacement: "${find.slice(0, 80)}..."`);
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
          system: `You are a senior CRO specialist creating A/B test variants. You make precise, focused text changes to test specific hypotheses. Follow the framework below.\n\n${LANDING_PAGE_FRAMEWORK}`,
          model: 'claude-sonnet-4-20250514',
          maxTokens: 4096,
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

          // Apply text replacements to the ORIGINAL HTML
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

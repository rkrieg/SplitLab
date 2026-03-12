import { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';

export const maxDuration = 60;
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
    directives: `Focus on URGENCY and SCARCITY tactics:
- Add time-limited language (e.g. "Limited time", "Only X left", "Offer ends soon")
- Make CTAs stronger and more action-oriented (e.g. "Claim Your Spot Now", "Get It Before It's Gone")
- Emphasize social proof (e.g. "Join 10,000+ customers", "Selling fast")
- Use bolder, more attention-grabbing colors for CTAs and key sections
- Add countdown-style urgency elements where appropriate
- Keep the overall structure but make the emotional tone more pressing`,
  },
  {
    label: 'Trust & Authority',
    angle: 'trust_authority',
    directives: `Focus on TRUST and AUTHORITY building:
- Move testimonials and social proof to more prominent positions
- Add or emphasize credentials, certifications, awards, and trust badges
- Include case study references or specific results/numbers
- Use a softer, more consultative CTA approach (e.g. "Schedule a Consultation", "Learn More")
- Adopt a more professional, authoritative tone throughout
- Add trust signals near forms and CTAs (e.g. "No spam", "Cancel anytime", security icons)`,
  },
  {
    label: 'Simplified & Direct',
    angle: 'simplified_direct',
    directives: `Focus on SIMPLIFICATION and DIRECTNESS:
- Remove or consolidate sections — aim for fewer, more impactful sections
- Use a single, clear, repeated CTA throughout the page
- Minimize visual distractions — cleaner layout, more whitespace
- Shorten copy — make every word earn its place
- Remove secondary navigation, sidebars, or anything that diverts from the main goal
- Make the value proposition immediately clear in the first viewport`,
  },
];

// Strip HTML to essentials — remove scripts, large style blocks, SVGs, comments
function stripHtml(html: string): string {
  let s = html;
  // Remove script tags and contents
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Remove SVGs
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>');
  // Remove HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Remove inline styles longer than 200 chars (keep short ones)
  s = s.replace(/style="[^"]{200,}"/gi, 'style="..."');
  // Collapse whitespace
  s = s.replace(/\s{2,}/g, ' ');
  // Truncate to 20K chars max
  if (s.length > 20_000) s = s.slice(0, 20_000) + '\n<!-- truncated -->';
  return s;
}

function buildPrompt(
  html: string,
  analysis: Record<string, unknown>,
  strategy: VariantStrategy,
  sourceUrl: string,
  instructions?: string
): string {
  const strippedHtml = stripHtml(html);

  let prompt = `You are a CRO specialist. Create a variant of this landing page using the "${strategy.label}" strategy.

## Strategy
${strategy.directives}

## Page Analysis
${JSON.stringify(analysis, null, 2)}

## Source URL: ${sourceUrl}

## Requirements
- Return a COMPLETE self-contained HTML page with ALL CSS inlined in <style> tags
- Keep ALL original image URLs exactly as-is
- Must be responsive (390px to 1440px+)
- Add data-sl-editable="true" on text elements (h1-h6, p, a, button, li, span with text)
- Do NOT add external CSS/JS libraries

## Response: ONLY valid JSON, no markdown fences
{"html":"<!DOCTYPE html>...","changes_summary":[{"change":"...","reason":"..."}],"variant_label":"${strategy.label}","impact_hypothesis":"..."}

## Original HTML (stripped)
${strippedHtml}`;

  if (instructions) {
    prompt += `\n\n## User Instructions\n${instructions}`;
  }

  return prompt;
}

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

      // Generate variants sequentially (each needs its own time within the 60s window)
      const completed: unknown[] = [];

      for (let index = 0; index < strategies.length; index++) {
        const strategy = strategies[index];
        try {
          sendEvent('generating', {
            index,
            label: strategy.label,
            status: 'in_progress',
          });

          const prompt = buildPrompt(
            scrapedPage.html,
            scrapedPage.analysis || {},
            strategy,
            scrapedPage.url,
            instructions
          );

          const response = await ask(prompt, {
            model: 'claude-sonnet-4-20250514',
            maxTokens: 8192,
          });

          const parsed = parseClaudeResponse(response);

          // Create test_variant record
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

          if (variantErr) {
            throw new Error(`Failed to create variant: ${variantErr.message}`);
          }

          // Upload HTML to Supabase Storage
          const storagePath = `${testId}/${variantId}.html`;
          const { error: uploadErr } = await db.storage
            .from(VARIANTS_BUCKET)
            .upload(storagePath, parsed.html, {
              contentType: 'text/html; charset=utf-8',
              upsert: true,
            });

          if (uploadErr) {
            throw new Error(`Failed to upload HTML: ${uploadErr.message}`);
          }

          const { data: urlData } = db.storage
            .from(VARIANTS_BUCKET)
            .getPublicUrl(storagePath);

          // Update variant with hosted_url
          await db
            .from('test_variants')
            .update({ hosted_url: urlData.publicUrl })
            .eq('id', variantId);

          // Create variant_pages record
          const { error: pageErr } = await db.from('variant_pages').insert({
            variant_id: variantId,
            html_storage_path: storagePath,
            source_url: scrapedPage.url,
            generation_prompt: prompt.slice(0, 10000),
            changes_summary: parsed.changes_summary,
            status: 'ready',
          });

          if (pageErr) {
            throw new Error(`Failed to create variant_page: ${pageErr.message}`);
          }

          const result = {
            index,
            variant_id: variantId,
            label: parsed.variant_label,
            impact_hypothesis: parsed.impact_hypothesis,
            changes_summary: parsed.changes_summary,
            hosted_url: urlData.publicUrl,
            status: 'ready',
          };

          sendEvent('variant_ready', result);
          completed.push(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Generation failed';
          console.error(`Variant ${index} (${strategy.label}) failed:`, err);
          sendEvent('variant_error', {
            index,
            label: strategy.label,
            error: message,
          });
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

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function scrapeWithFetch(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`Page returned HTTP ${res.status}`);
    }

    const html = await res.text();
    if (!html || html.length < 100) {
      throw new Error('Page returned empty or minimal content');
    }

    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeWithClaude(html: string) {
  // Truncate HTML to avoid token limits — keep first 80k chars
  const truncatedHtml = html.length > 80_000 ? html.slice(0, 80_000) + '\n<!-- truncated -->' : html;

  const systemPrompt = `You are an expert landing page analyst. Analyze the provided HTML and return ONLY valid JSON (no markdown fences, no explanation) with this exact structure:
{
  "page_type": "landing_page | product_page | homepage | blog | form | other",
  "primary_offer": "string describing the main offer or value proposition",
  "target_audience": "string describing who this page targets",
  "sections": [
    { "type": "hero | navigation | features | testimonials | pricing | cta | footer | form | other", "content": "brief description", "position": "top | middle | bottom" }
  ],
  "cta_strategy": "string describing the call-to-action approach",
  "color_palette": ["#hex1", "#hex2", "#hex3"],
  "tone_of_voice": "professional | casual | urgent | friendly | technical | other"
}`;

  const response = await ask(
    `Analyze this landing page HTML:\n\n${truncatedHtml}`,
    {
      system: systemPrompt,
      maxTokens: 2048,
      model: 'claude-sonnet-4-20250514',
    }
  );

  try {
    return JSON.parse(response);
  } catch {
    // Try to extract JSON from the response if it has extra text
    const match = response.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned invalid JSON');
  }
}

// Check if scraped_pages table exists
async function tableExists(): Promise<boolean> {
  const { error } = await db
    .from('scraped_pages')
    .select('id')
    .limit(0);
  return !error;
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let url: string;
  try {
    const body = await request.json();
    url = body.url?.trim();
    if (!url) throw new Error('Missing url');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    new URL(url); // validate
  } catch {
    return NextResponse.json({ error: 'Invalid or missing URL' }, { status: 400 });
  }

  // Pre-flight: check if ANTHROPIC_API_KEY is set
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured. Add it to your Vercel environment variables.' },
      { status: 500 }
    );
  }

  try {
    // Check if the DB table exists
    const hasTable = await tableExists();

    // Check cache if table exists
    if (hasTable) {
      const { data: cached } = await db
        .from('scraped_pages')
        .select('*')
        .eq('url', url)
        .gte('scraped_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .maybeSingle();

      if (cached) {
        return NextResponse.json({
          scraped_page_id: cached.id,
          analysis: cached.analysis,
          screenshot_desktop: cached.screenshot_desktop,
          screenshot_mobile: cached.screenshot_mobile,
          cached: true,
        });
      }
    }

    // Scrape the page using fetch
    let html: string;
    try {
      html = await scrapeWithFetch(url);
    } catch (scrapeErr) {
      const msg = scrapeErr instanceof Error ? scrapeErr.message : 'Unknown scrape error';
      return NextResponse.json(
        { error: `Could not fetch the page: ${msg}. Make sure the URL is accessible.` },
        { status: 422 }
      );
    }

    // Analyze with Claude
    let analysis;
    try {
      analysis = await analyzeWithClaude(html);
    } catch (aiErr: unknown) {
      console.error('AI analysis error:', aiErr);
      // Check for Anthropic authentication errors
      const errObj = aiErr as { status?: number; message?: string };
      if (errObj.status === 401) {
        return NextResponse.json(
          { error: 'Anthropic API key is invalid. Please update ANTHROPIC_API_KEY in your Vercel environment variables with a valid key.' },
          { status: 500 }
        );
      }
      const msg = aiErr instanceof Error ? aiErr.message : 'Unknown AI error';
      return NextResponse.json(
        { error: `AI analysis failed: ${msg}` },
        { status: 500 }
      );
    }

    // Try to save to DB (non-fatal if table doesn't exist)
    let scrapedPageId = crypto.randomUUID();
    if (hasTable) {
      const { data: row, error: insertError } = await db
        .from('scraped_pages')
        .upsert(
          {
            id: scrapedPageId,
            url,
            html,
            analysis,
            screenshot_desktop: null,
            screenshot_mobile: null,
            scraped_at: new Date().toISOString(),
          },
          { onConflict: 'url' }
        )
        .select('id')
        .single();

      if (!insertError && row) {
        scrapedPageId = row.id;
      } else {
        console.warn('DB insert failed (non-fatal):', insertError?.message);
      }
    }

    return NextResponse.json({
      scraped_page_id: scrapedPageId,
      analysis,
      screenshot_desktop: null,
      screenshot_mobile: null,
      cached: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Scrape failed';
    console.error('Scrape error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

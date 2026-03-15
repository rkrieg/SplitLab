import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';

export const maxDuration = 300;
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

// Strip HTML to essentials for faster analysis
function stripForAnalysis(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Keep short inline styles (colors, backgrounds) but strip long ones
  s = s.replace(/style="[^"]{200,}"/gi, 'style="..."');
  s = s.replace(/class="[^"]*"/gi, '');
  // Keep <style> blocks but truncate overly long ones
  s = s.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
    if (css.length > 3000) return `<style>${css.slice(0, 3000)}/* truncated */</style>`;
    return `<style>${css}</style>`;
  });
  s = s.replace(/\s{2,}/g, ' ');
  if (s.length > 20_000) s = s.slice(0, 20_000) + '\n<!-- truncated -->';
  return s;
}

// Extract actual visible colors from inline styles only (not CSS variables/presets)
function extractColors(html: string): string[] {
  const colorMap = new Map<string, number>();

  // Strip CSS variable/preset definitions (WordPress themes define unused color palettes)
  // Only look at inline style="" attributes for actually-used colors
  const styleRegex = /style="([^"]*)"/g;
  let styleMatch: RegExpExecArray | null;
  const inlineStyles: string[] = [];
  while ((styleMatch = styleRegex.exec(html)) !== null) {
    inlineStyles.push(styleMatch[1]);
  }
  const styleText = inlineStyles.join(' ');

  // Match hex colors from inline styles
  const hexRegex = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = hexRegex.exec(styleText)) !== null) {
    let hex = m[0].toLowerCase();
    if (hex.length === 4) {
      hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    // Skip blacks, whites, near-grays
    if (/^#(0{3,6}|f{3,6}|000000|ffffff)$/i.test(hex)) continue;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (Math.max(r, g, b) - Math.min(r, g, b) < 20) continue; // skip grays
    colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
  }

  // Match rgb/rgba from inline styles
  const rgbRegex = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rgbRegex.exec(styleText)) !== null) {
    const r = parseInt(rm[1]), g = parseInt(rm[2]), b = parseInt(rm[3]);
    if (Math.max(r, g, b) - Math.min(r, g, b) < 20) continue;
    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    colorMap.set(hex, (colorMap.get(hex) || 0) + 1);
  }

  // Return top colors sorted by frequency
  return Array.from(colorMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([color]) => color);
}

async function analyzeWithClaude(html: string) {
  const stripped = stripForAnalysis(html);
  const extractedColors = extractColors(html);

  const systemPrompt = `Analyze the HTML and return ONLY valid JSON:
{"page_type":"landing_page|product_page|homepage|blog|form|other","primary_offer":"...","target_audience":"...","sections":[{"type":"hero|navigation|features|testimonials|pricing|cta|footer|form|other","content":"brief","position":"top|middle|bottom"}],"cta_strategy":"...","color_palette":["#hex1","#hex2"],"tone_of_voice":"professional|casual|urgent|friendly|technical"}

IMPORTANT: For color_palette, use these ACTUAL colors extracted from the page CSS: ${JSON.stringify(extractedColors)}. Pick the 3-5 most representative brand colors from this list. Do NOT guess or invent colors.`;

  const response = await ask(
    `Analyze this landing page:\n\n${stripped}`,
    {
      system: systemPrompt,
      maxTokens: 1024,
      model: 'claude-haiku-4-5-20251001',
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
        .gte('scraped_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
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

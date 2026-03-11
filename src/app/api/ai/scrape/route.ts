import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { ask } from '@/lib/claude';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SCREENSHOTS_BUCKET = 'screenshots';

async function uploadScreenshot(
  buffer: Buffer,
  path: string
): Promise<string> {
  const { error } = await db.storage
    .from(SCREENSHOTS_BUCKET)
    .upload(path, buffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (error) throw new Error(`Screenshot upload failed: ${error.message}`);

  const { data } = db.storage.from(SCREENSHOTS_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

async function scrapeWithPuppeteer(url: string) {
  /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
  const chromium: any = require('@sparticuz/chromium');
  const puppeteer: any = require('puppeteer-core');
  /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: null,
    executablePath: await chromium.executablePath(),
    headless: 'shell' as const,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    // Desktop viewport for initial load
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });

    // Capture full rendered HTML
    const html = await page.evaluate(
      () => document.documentElement.outerHTML
    );

    // Desktop screenshot
    const desktopScreenshot = (await page.screenshot({
      fullPage: true,
      type: 'png',
    })) as Buffer;

    // Mobile screenshot
    await page.setViewport({ width: 390, height: 844 });
    await new Promise((r) => setTimeout(r, 1000)); // let layout reflow
    const mobileScreenshot = (await page.screenshot({
      fullPage: true,
      type: 'png',
    })) as Buffer;

    return { html, desktopScreenshot, mobileScreenshot };
  } finally {
    await browser.close();
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

  try {
    // Check cache — return if scraped within the last 24 hours
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

    // Scrape the page
    const { html, desktopScreenshot, mobileScreenshot } = await scrapeWithPuppeteer(url);

    // Generate a temporary ID for storage paths
    const tempId = crypto.randomUUID();

    // Upload screenshots and analyze in parallel
    const [desktopUrl, mobileUrl, analysis] = await Promise.all([
      uploadScreenshot(
        Buffer.from(desktopScreenshot),
        `scraped-pages/${tempId}/desktop.png`
      ),
      uploadScreenshot(
        Buffer.from(mobileScreenshot),
        `scraped-pages/${tempId}/mobile.png`
      ),
      analyzeWithClaude(html),
    ]);

    // Upsert into scraped_pages (update if URL already exists but is stale)
    const { data: row, error: insertError } = await db
      .from('scraped_pages')
      .upsert(
        {
          id: tempId,
          url,
          html,
          analysis,
          screenshot_desktop: desktopUrl,
          screenshot_mobile: mobileUrl,
          scraped_at: new Date().toISOString(),
        },
        { onConflict: 'url' }
      )
      .select('id')
      .single();

    if (insertError) {
      throw new Error(`Database insert failed: ${insertError.message}`);
    }

    return NextResponse.json({
      scraped_page_id: row.id,
      analysis,
      screenshot_desktop: desktopUrl,
      screenshot_mobile: mobileUrl,
      cached: false,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Scrape failed';
    console.error('Scrape error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

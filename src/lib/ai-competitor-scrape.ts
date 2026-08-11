import https from 'https';
import { askAI } from '@/lib/ai-client';

export interface CompetitorContext {
  screenshots: string[];  // Array of JPEG base64 chunks — each ≤4096px tall, sent as separate image blocks to Claude
  cssTokens: string;      // Structured design token block — injected into schema + build prompts
  pageContent: string;    // First 30K chars of cleaned HTML — generate uses this to extract real copy/nav/sections
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  return Array.from(new Set(matches));
}

async function fetchFirecrawlData(url: string, apiKey: string): Promise<{ rawHtml: string; html: string }> {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url, formats: ['rawHtml', 'html'] }),
  });
  if (!res.ok) throw new Error(`Firecrawl responded ${res.status}`);
  const json = await res.json();
  return {
    rawHtml: (json.data?.rawHtml as string) ?? '',
    html: (json.data?.html as string) ?? '',
  };
}

// Read JPEG image height from buffer by parsing SOF (Start of Frame) markers
function getJpegHeight(buffer: Buffer): number {
  let i = 0;
  while (i < buffer.length - 9) {
    if (buffer[i] !== 0xFF) { i++; continue; }
    const marker = buffer[i + 1];
    // SOF markers encode image dimensions
    if (
      (marker >= 0xC0 && marker <= 0xC3) ||
      (marker >= 0xC5 && marker <= 0xC7) ||
      (marker >= 0xC9 && marker <= 0xCB) ||
      (marker >= 0xCD && marker <= 0xCF)
    ) {
      return (buffer[i + 5] << 8) | buffer[i + 6];
    }
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    if (i + 3 >= buffer.length) break;
    const segLen = (buffer[i + 2] << 8) | buffer[i + 3];
    i += 2 + segLen;
  }
  return 0;
}

function httpsGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function apiFlashCapture(params: URLSearchParams): Promise<Buffer> {
  const jsonBuf = await httpsGet(`https://api.apiflash.com/v1/urltoimage?${params}`);
  let json: { url?: string; [k: string]: unknown };
  try {
    json = JSON.parse(jsonBuf.toString());
  } catch {
    throw new Error(`ApiFlash returned non-JSON: ${jsonBuf.toString().slice(0, 200)}`);
  }
  if (!json.url) throw new Error(`ApiFlash: missing url in response — ${JSON.stringify(json)}`);
  return httpsGet(json.url as string);
}

async function fetchApiFlashScreenshots(url: string, apiKey: string): Promise<string[]> {
  const baseParams = {
    access_key: apiKey,
    url,
    format: 'jpeg',
    quality: '80',
    width: '1280',
    response_type: 'json',
  };

  // Step 1 — get full page screenshot to measure total page height
  const fullPageBuf = await apiFlashCapture(new URLSearchParams({
    ...baseParams,
    full_page: 'true',
  }));

  const pageHeight = getJpegHeight(fullPageBuf);
  console.log(`[ApiFlash] full_page height: ${pageHeight}px`);

  // Anthropic accepts images up to 8000px tall — if it fits, send as-is
  if (pageHeight > 0 && pageHeight <= 7900) {
    return [fullPageBuf.toString('base64')];
  }

  // Step 2 — page is too tall; capture in 4096px chunks using js scroll
  const CHUNK = 4096;
  const numChunks = pageHeight > 0 ? Math.ceil(pageHeight / CHUNK) : 3;
  console.log(`[ApiFlash] page too tall (${pageHeight}px) — taking ${numChunks} scrolled chunks`);

  const screenshots: string[] = [];
  for (let i = 0; i < numChunks; i++) {
    const scrollY = i * CHUNK;
    const chunkParams: Record<string, string> = {
      ...baseParams,
      height: String(CHUNK),
    };
    if (scrollY > 0) chunkParams.js = `window.scrollTo(0,${scrollY})`;

    const buf = await apiFlashCapture(new URLSearchParams(chunkParams));
    screenshots.push(buf.toString('base64'));
    console.log(`[ApiFlash] chunk ${i + 1}/${numChunks} captured (scrollY=${scrollY})`);
  }

  return screenshots;
}

function extractStyleBlocks(rawHtml: string): string {
  const matches = rawHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  return matches.join('\n\n');
}

async function extractCssTokens(cssBlocks: string, htmlStructure: string): Promise<string | null> {
  try {
    const result = await askAI({
      system: `You are a design token extractor. Given CSS and HTML structure from a website, extract exact design tokens. Return only the token block — no explanation, no markdown fences, no other text.`,
      messages: [
        {
          role: 'user',
          content: `CSS (from all <style> blocks on the page):\n${cssBlocks}\n\nHTML structure (cleaned DOM for section order):\n${htmlStructure}\n\nExtract and return ONLY this format:\n\nCOLORS:\n  Background: #...\n  Surface/card: #...\n  Primary text: #...\n  Muted text: #...\n  Accent/CTA: #...\n\nTYPOGRAPHY:\n  Headline font: '...' — weight ...\n  Body font: '...' — weight ...\n\nLAYOUT TOKENS:\n  Card border radius: ...\n  Section padding: ...\n  Border style: ...\n  Container max-width: ...\n\nSECTION ORDER:\n  Nav → Hero → ... → Footer`,
        },
      ],
      maxTokens: 128000,
      model: 'claude-sonnet-5',
      label: 'competitor-scrape:extract-css-tokens',
    });
    return result.trim() || null;
  } catch (err) {
    console.error('[extractCssTokens] mini call failed:', err);
    return null;
  }
}

export async function scrapeCompetitorUrl(url: string): Promise<CompetitorContext | null> {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim();
  const apiFlashKey = process.env.API_FLASH_KEY?.trim();

  const firecrawlPromise = firecrawlKey
    ? fetchFirecrawlData(url, firecrawlKey)
    : Promise.reject(new Error('FIRECRAWL_API_KEY not set'));

  const apiFlashPromise = apiFlashKey
    ? fetchApiFlashScreenshots(url, apiFlashKey)
    : Promise.reject(new Error('API_FLASH_KEY not set'));

  let results: PromiseSettledResult<unknown>[];
  try {
    results = await Promise.race([
      Promise.allSettled([firecrawlPromise, apiFlashPromise]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('60s timeout')), 60_000)
      ),
    ]);
  } catch (err) {
    console.error('[scrapeCompetitorUrl] timed out or crashed:', err);
    return null;
  }

  const [firecrawlResult, apiFlashResult] = results as [
    PromiseSettledResult<{ rawHtml: string; html: string }>,
    PromiseSettledResult<string[]>,
  ];

  // Extract CSS tokens from Firecrawl result
  let cssTokens: string | null = null;
  if (firecrawlResult.status === 'fulfilled') {
    const { rawHtml, html } = firecrawlResult.value;
    const cssBlocks = extractStyleBlocks(rawHtml);
    cssTokens = await extractCssTokens(cssBlocks, html);
  } else {
    console.error('[scrapeCompetitorUrl] Firecrawl failed:', firecrawlResult.reason);
  }

  // Get screenshots array from ApiFlash result
  let screenshots: string[] = [];
  if (apiFlashResult.status === 'fulfilled') {
    screenshots = apiFlashResult.value;
    console.log(`[scrapeCompetitorUrl] ApiFlash: ${screenshots.length} screenshot(s), sizes: ${screenshots.map(s => s.length).join(', ')}`);
  } else {
    console.error('[scrapeCompetitorUrl] ApiFlash failed:', apiFlashResult.reason);
  }

  if (!cssTokens && screenshots.length === 0) return null;

  const pageContent = firecrawlResult.status === 'fulfilled'
    ? firecrawlResult.value.html.slice(0, 30_000)
    : '';

  return {
    screenshots,
    cssTokens: cssTokens ?? '',
    pageContent,
  };
}

function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of the site's own logo <img> src from raw page
 * HTML — used when a follow-up explicitly asks to use the "real"/"actual"
 * logo from a referenced URL, so the model gets a literal asset to embed
 * instead of hallucinating one from a screenshot or generating a fake one.
 * Deliberately conservative: returns null rather than guessing when nothing
 * scores as a plausible logo, since embedding the wrong image is worse than
 * falling back to the existing behavior.
 */
export function extractLogoUrl(rawHtml: string, pageUrl: string): string | null {
  const headerMatch = /<header\b[\s\S]*?<\/header>/i.exec(rawHtml);
  const navMatch = /<nav\b[\s\S]*?<\/nav>/i.exec(rawHtml);
  const headerEnd = headerMatch ? headerMatch.index + headerMatch[0].length : -1;
  const navEnd = navMatch ? navMatch.index + navMatch[0].length : -1;

  const imgRe = /<img\b([^>]*)>/gi;
  const candidates: { src: string; score: number; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(rawHtml))) {
    const attrs = m[1];
    const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    // Fall back to the first URL in srcset for responsive <img>s with no
    // plain src attribute — common on modern marketing sites.
    const srcsetMatch = !srcMatch ? /\bsrcset\s*=\s*["']([^"']+)["']/i.exec(attrs) : null;
    const rawSrc = srcMatch?.[1] ?? srcsetMatch?.[1]?.split(',')[0]?.trim().split(/\s+/)[0];
    if (!rawSrc || rawSrc.startsWith('data:')) continue; // must be a real fetchable URL, not inline base64

    const altMatch = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const classMatch = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const looksLikeLogo =
      /logo/i.test(altMatch?.[1] ?? '') || /logo/i.test(classMatch?.[1] ?? '') || /logo/i.test(rawSrc);
    const inHeader = !!headerMatch && m.index >= headerMatch.index && m.index <= headerEnd;
    const inNav = !!navMatch && m.index >= navMatch.index && m.index <= navEnd;

    let score = 0;
    if (looksLikeLogo) score += 2;
    if (inHeader || inNav) score += 2;
    if (score === 0) continue; // not a plausible logo — skip rather than guess wrong
    candidates.push({ src: rawSrc, score, index: m.index });
  }

  if (candidates.length === 0) return null;
  // Highest score wins; ties broken by earliest occurrence — the logo is
  // almost always the first element inside the header/nav.
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return resolveUrl(candidates[0].src, pageUrl);
}

/**
 * Lightweight fetch for just the site's logo asset — used for "use the real
 * logo" follow-ups. Deliberately skips the screenshot capture and CSS-token
 * extraction that scrapeCompetitorUrl() pays for (an extra ApiFlash call and
 * a Sonnet call), since a logo swap only needs the raw HTML to locate one
 * <img> src. Returns null (never throws) on any failure — callers must treat
 * that as "couldn't find a logo," not as a reason to fall back to guessing.
 */
export async function fetchLogoUrl(url: string): Promise<string | null> {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!firecrawlKey) return null;
  try {
    const { rawHtml } = await Promise.race([
      fetchFirecrawlData(url, firecrawlKey),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('20s timeout')), 20_000)),
    ]);
    if (!rawHtml) return null;
    return extractLogoUrl(rawHtml, url);
  } catch (err) {
    console.error('[fetchLogoUrl] failed:', err);
    return null;
  }
}

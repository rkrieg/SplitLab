import https from 'https';
import { askAI } from '@/lib/ai-client';
import { extractFooterContact, extractInlineLogoSvg } from '@/lib/ai-brand-assets';

export interface CompetitorContext {
  screenshots: string[];  // Array of JPEG base64 chunks — each ≤4096px tall, sent as separate image blocks to Claude
  /**
   * Layout tokens + section order, written by a model.
   *
   * Colours and fonts USED to live here too, in a five-slot fill-in-the-blanks
   * form (Background / Surface / Text / Muted / Accent). That form is why a
   * two-colour brand shipped as one: a site built on red AND gold has nowhere
   * to put the gold, so the gold was dropped — and once dropped, red became
   * the only colour the builder had. Colours and fonts are now mechanical
   * facts on `palette` instead, with no slots to overflow.
   */
  cssTokens: string;
  /**
   * Every colour and font actually declared in the site's CSS, with the
   * selectors they sit on and how often each is used. Extracted by code, not
   * summarised by a model: counting is a fact, deciding which colour is "the
   * accent" is a judgement, and the judgement belongs to the model that can
   * also see the screenshot.
   */
  palette: string;
  /**
   * The page as markdown — headings, copy, links, image URLs, nothing else.
   *
   * Typically 5-10x smaller than the same page's HTML, because it carries none
   * of the wrapper divs, class attributes, inline SVG or scripts. That makes it
   * the one layer that reliably fits whole, so the bottom of a long page stops
   * being amputated. Sent ALONGSIDE the HTML, never instead of it: markdown
   * flattens structure (it cannot tell you three cards sat in a row), and the
   * screenshot covers that better than HTML ever did.
   */
  markdown: string;
  pageContent: string;    // Cleaned HTML — generate uses this to extract real copy/nav/sections. NOT truncated here; callers budget it.
  /** Real logo <img> URL extracted from the site HTML — prefer this over screenshot thumbs */
  logoUrl: string | null;
  /**
   * Inline SVG markup when no fetchable <img> logo exists.
   * Uploaded to storage at build time via materializeLogoUrl — never invent a mark if both null.
   */
  logoSvgMarkup: string | null;
  /** Address / email / copyright pulled from footer HTML when present */
  footerContact: { address?: string; email?: string; copyright?: string; phone?: string };
  /** Non-logo content photos (headshots/products) extracted from page HTML — may be empty */
  referenceImageUrls: string[];
  /**
   * What this scrape actually managed to retrieve.
   *
   * A thin result used to ship silently: if Firecrawl came back with half a
   * page, or the stylesheets 403'd, nothing anywhere said so — the page was
   * simply worse and nobody knew why. These numbers go to the log and, when
   * they are bad enough to matter, into the prompt so the model can say so
   * rather than quietly building from scraps.
   */
  stats: ScrapeStats;
}

export interface ScrapeStats {
  /** Bytes of CSS found inline in <style> tags. */
  inlineCssChars: number;
  /** Bytes of CSS fetched from external stylesheets. */
  externalCssChars: number;
  /** External stylesheets successfully fetched / seen in the markup. */
  stylesheetsFetched: number;
  stylesheetsFound: number;
  /** Distinct colours and font families the palette extractor recovered. */
  colorsFound: number;
  fontsFound: number;
  /** Size of each content layer, before any caller-side budgeting. */
  htmlChars: number;
  markdownChars: number;
  imagesFound: number;
  screenshotCount: number;
}

export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  const re = /https?:\/\/[^\s"'<>)]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // A URL immediately followed by "<" in the source wasn't a real URL — it
    // was a template like ".../logos/<name>.webp" and the char class above cut
    // off at the placeholder. What's left looks like a real webpage URL (no
    // file extension) and used to sail past classifyAssetSource's image check,
    // getting scraped as a "competitor site" — which is how a literal
    // Access-Denied page for an asset folder ended up steering page design.
    const next = text[m.index + m[0].length];
    if (next === '<') continue;
    found.add(m[0]);
  }
  return Array.from(found);
}

// Video/media embed CDNs — a URL to one of these in a prompt/PRD is almost always a
// "embed this video" instruction (e.g. "https://player.mux.com/<id>"), never a
// "clone this site's design" reference. Scraping these as a competitor pulls in the
// CDN's own marketing-site chrome (nav, footer, brand colors) and misattributes it to
// the page being built — e.g. a Mux embed URL producing "© Mux, Inc." in the footer.
const NON_COMPETITOR_URL_HOSTS = [
  'player.mux.com',
  'stream.mux.com',
  'player.vimeo.com',
  'vimeo.com',
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'fast.wistia.net',
  'wistia.com',
  'wistia.net',
];

export function isEmbedAssetUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return NON_COMPETITOR_URL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function fetchFirecrawlData(
  url: string,
  apiKey: string,
): Promise<{ rawHtml: string; html: string; markdown: string }> {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    // markdown is requested alongside the two HTML formats, not instead of
    // them. It is the only layer small enough to reliably survive whole on a
    // long page, so it is what guarantees the bottom of a site (footer, final
    // CTA, the second city a firm practises in) reaches the model at all.
    body: JSON.stringify({ url, formats: ['rawHtml', 'html', 'markdown'] }),
  });
  if (!res.ok) throw new Error(`Firecrawl responded ${res.status}`);
  const json = await res.json();
  return {
    rawHtml: (json.data?.rawHtml as string) ?? '',
    html: (json.data?.html as string) ?? '',
    markdown: (json.data?.markdown as string) ?? '',
  };
}

/** Hard ceilings on stylesheet fetching — a page can link a dozen of them. */
const MAX_STYLESHEETS = 12;
const MAX_STYLESHEET_BYTES = 900_000;
const STYLESHEET_TIMEOUT_MS = 12_000;

/**
 * The site's real CSS, fetched from its <link rel="stylesheet"> tags.
 *
 * WHY this exists: extractStyleBlocks() below reads only <style> tags written
 * directly into the document. On WordPress — and on most of the internet —
 * essentially all CSS lives in separate .css files, so that function returned
 * next to nothing and the token extractor was handed an empty page to
 * summarise. That is the whole reason a scraped site shipped with
 * `--font-headline: system-ui` (the OS default, meaning no typeface was ever
 * identified) and a single invented accent colour.
 *
 * Failures are per-file and silent by design: one 403'd stylesheet must not
 * cost us the eleven that did load. The count of what was found vs fetched
 * goes to ScrapeStats so a systematically blocked site is visible.
 */
async function fetchExternalStylesheets(
  rawHtml: string,
  pageUrl: string,
): Promise<{ css: string; found: number; fetched: number }> {
  const hrefs: string[] = [];
  const seen = new Set<string>();
  const linkRe = /<link\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(rawHtml)) !== null) {
    const attrs = m[1];
    if (!/\brel\s*=\s*["'][^"']*stylesheet/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href) continue;
    const resolved = resolveUrl(href, pageUrl);
    if (!resolved || !/^https?:/i.test(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    hrefs.push(resolved);
  }

  const targets = hrefs.slice(0, MAX_STYLESHEETS);
  const settled = await Promise.allSettled(
    targets.map(async (href) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STYLESHEET_TIMEOUT_MS);
      try {
        const res = await fetch(href, {
          signal: controller.signal,
          headers: { Accept: 'text/css,*/*;q=0.1', 'User-Agent': 'Mozilla/5.0 (compatible; SplitLab)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return text.slice(0, MAX_STYLESHEET_BYTES);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const parts: string[] = [];
  let fetched = 0;
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value.trim()) {
      parts.push(r.value);
      fetched++;
    }
  }
  return { css: parts.join('\n\n'), found: hrefs.length, fetched };
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

/**
 * ── FACTS, NOT VERDICTS ──────────────────────────────────────────────────────
 *
 * Every colour and font the site's CSS actually declares, with the selectors
 * they sit on and how often each appears.
 *
 * This replaces a model-written card with five colour slots
 * (Background / Surface / Text / Muted / Accent). That card was not a summary,
 * it was a decision — and a lossy one: a brand built on red AND gold has one
 * accent slot to fit two colours into, so the gold was silently discarded.
 * Every later attempt to fix "the page is too red" then failed, because the
 * missing ingredient had been thrown away before the builder ever ran.
 *
 * The division of labour this restores:
 *   • CODE counts. Which hex codes exist, where they are used, how often.
 *     That is arithmetic and it cannot be wrong.
 *   • The MODEL decides. Which of them is the brand accent, which is the
 *     background, what deserves to be prominent. It has the screenshot, so it
 *     can see that "Recovery" is gold and the hero is teal — and it has these
 *     exact values, so it never has to eyedrop a colour off a JPEG.
 *
 * Do NOT reintroduce a "primary colour" field here. The moment code names one,
 * the screenshot stops mattering and we are back to a one-accent brand.
 */

/** A colour usage: which property carried it, on which selector. */
interface ColorUse {
  count: number;
  props: Set<string>;
  selectors: Set<string>;
}

const COLOR_PROPS =
  /^(background|background-color|color|border|border-color|border-top-color|border-bottom-color|border-left-color|border-right-color|fill|stroke|outline-color|box-shadow|text-decoration-color|caret-color)$/i;

function normalizeHex(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
    return null;
  }
  m = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(v);
  if (m) {
    const to = (n: string) => {
      const x = Math.max(0, Math.min(255, Math.round(parseFloat(n))));
      return x.toString(16).padStart(2, '0');
    };
    return `#${to(m[1])}${to(m[2])}${to(m[3])}`;
  }
  return null;
}

/** Colours carrying no brand information — noise in every stylesheet. */
function isUninteresting(hex: string): boolean {
  return hex === '#ffffff' || hex === '#000000' || hex === '#transp';
}

/**
 * Walk CSS rule blocks, including those nested one level inside @media/@supports.
 * Tolerant by design: minified, malformed and vendor-prefixed CSS all arrive
 * here, and a parser that throws would cost us the whole palette.
 */
function collectRules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  let selStart = 0;
  const stack: string[] = [];
  while (i < clean.length) {
    const ch = clean[i];
    if (ch === '{') {
      const selector = clean.slice(selStart, i).trim();
      // An at-rule wrapper (@media, @supports) holds more rules, not
      // declarations — descend into it rather than reading it as a block.
      if (selector.startsWith('@') && !/^@(font-face|page)/i.test(selector)) {
        stack.push(selector);
        i++;
        selStart = i;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      while (j < clean.length && depth > 0) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}') depth--;
        j++;
      }
      out.push({ selector, body: clean.slice(i + 1, j - 1) });
      i = j;
      selStart = i;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      i++;
      selStart = i;
      continue;
    }
    i++;
  }
  return out;
}

function shortSelector(sel: string): string {
  return sel.replace(/\s+/g, ' ').trim().slice(0, 70);
}

/**
 * Turn a stylesheet into a plain list of what it declares.
 *
 * Bounded by usage count, which is still a fact — the twenty-four most-used
 * colours on a page are the page's colours. It is not a claim about which one
 * matters most.
 */
export function extractPaletteFacts(css: string): { block: string; colors: number; fonts: number } {
  const colors = new Map<string, ColorUse>();
  const fonts = new Map<string, Set<string>>();
  const vars = new Map<string, string>();

  for (const { selector, body } of collectRules(css)) {
    for (const decl of body.split(';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const value = decl.slice(idx + 1).trim();
      if (!prop || !value) continue;

      // CSS custom properties are the most honest statement a site makes about
      // its own brand — a `--brand-gold` is named by the people who own it.
      if (prop.startsWith('--')) {
        const hex = normalizeHex(value);
        if (hex && !vars.has(prop)) vars.set(prop, hex);
        continue;
      }

      if (prop === 'font-family') {
        const fam = value.replace(/\s*!important\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 90);
        if (fam && !/^(inherit|initial|unset|var\()/i.test(fam)) {
          if (!fonts.has(fam)) fonts.set(fam, new Set());
          const set = fonts.get(fam)!;
          if (set.size < 6) set.add(shortSelector(selector));
        }
        continue;
      }

      if (!COLOR_PROPS.test(prop)) continue;
      const found = value.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
      for (const raw of found) {
        const hex = normalizeHex(raw);
        if (!hex || isUninteresting(hex)) continue;
        if (!colors.has(hex)) colors.set(hex, { count: 0, props: new Set(), selectors: new Set() });
        const use = colors.get(hex)!;
        use.count++;
        if (use.props.size < 4) use.props.add(prop);
        if (use.selectors.size < 4) use.selectors.add(shortSelector(selector));
      }
    }
  }

  const rankedColors = Array.from(colors.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 24);
  const rankedFonts = Array.from(fonts.entries()).slice(0, 12);

  const lines: string[] = [];
  if (rankedColors.length > 0) {
    lines.push(
      'COLOURS DECLARED IN THE SITE’S OWN CSS — these are the exact values. Ordered by how often each appears, which is a usage count and NOT a ranking of importance:',
    );
    for (const [hex, use] of rankedColors) {
      lines.push(
        `  ${hex} — ${use.count} use${use.count === 1 ? '' : 's'} — ${Array.from(use.props).join('/')} on: ${Array.from(use.selectors).join(', ')}`,
      );
    }
  }
  if (vars.size > 0) {
    lines.push('', 'CSS VARIABLES THE SITE DEFINES (the brand’s own names for its colours):');
    for (const [name, hex] of Array.from(vars.entries()).slice(0, 24)) {
      lines.push(`  ${name}: ${hex}`);
    }
  }
  if (rankedFonts.length > 0) {
    lines.push('', 'FONT FAMILIES DECLARED, with the selectors they are set on:');
    for (const [fam, sels] of rankedFonts) {
      lines.push(`  ${fam} — on: ${Array.from(sels).join(', ') || '(unscoped)'}`);
    }
  }

  return { block: lines.join('\n'), colors: rankedColors.length, fonts: rankedFonts.length };
}

function extractStyleBlocks(rawHtml: string): string {
  const matches = rawHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
  return matches.join('\n\n');
}

/**
 * Layout tokens and section order only.
 *
 * COLORS and TYPOGRAPHY used to be extracted here too, into a five-slot form.
 * They are now mechanical facts (see extractPaletteFacts) because a form with
 * one accent slot cannot describe a two-colour brand, and silently dropping
 * the second colour is what shipped an all-red page for a red-and-gold firm.
 * What is left here is genuinely a reading job rather than a counting one:
 * "what is the section rhythm of this page" has no regex.
 */
async function extractCssTokens(cssBlocks: string, htmlStructure: string): Promise<string | null> {
  try {
    const result = await askAI({
      system: `You are a design token extractor. Given CSS and HTML structure from a website, extract exact design tokens. Return only the token block — no explanation, no markdown fences, no other text.`,
      messages: [
        {
          role: 'user',
          content: `CSS:\n${cssBlocks.slice(0, 120_000)}\n\nHTML structure (cleaned DOM for section order):\n${htmlStructure.slice(0, 60_000)}\n\nExtract and return ONLY this format. Do NOT include colours or fonts — those are handled elsewhere:\n\nLAYOUT TOKENS:\n  Card border radius: ...\n  Section padding: ...\n  Border style: ...\n  Container max-width: ...\n\nSECTION ORDER:\n  Nav → Hero → ... → Footer`,
        },
      ],
      maxTokens: 128000,
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
    PromiseSettledResult<{ rawHtml: string; html: string; markdown: string }>,
    PromiseSettledResult<string[]>,
  ];

  // Extract CSS tokens + brand assets from Firecrawl result
  let cssTokens: string | null = null;
  let palette = '';
  let markdown = '';
  let logoUrl: string | null = null;
  let logoSvgMarkup: string | null = null;
  let footerContact: CompetitorContext['footerContact'] = {};
  let referenceImageUrls: string[] = [];
  let inlineCssChars = 0;
  let externalCssChars = 0;
  let stylesheetsFound = 0;
  let stylesheetsFetched = 0;
  let colorsFound = 0;
  let fontsFound = 0;
  if (firecrawlResult.status === 'fulfilled') {
    const { rawHtml, html, markdown: md } = firecrawlResult.value;
    markdown = md;
    const inlineCss = extractStyleBlocks(rawHtml);
    // The site's real stylesheets. Without this step inlineCss is usually
    // near-empty on any CMS-built site, and everything downstream — palette,
    // fonts, layout tokens — is summarising a blank page.
    const external = await fetchExternalStylesheets(rawHtml, url);
    inlineCssChars = inlineCss.length;
    externalCssChars = external.css.length;
    stylesheetsFound = external.found;
    stylesheetsFetched = external.fetched;
    const allCss = `${inlineCss}\n\n${external.css}`;
    const facts = extractPaletteFacts(allCss);
    palette = facts.block;
    colorsFound = facts.colors;
    fontsFound = facts.fonts;
    cssTokens = await extractCssTokens(allCss, html);
    logoUrl = extractLogoUrl(rawHtml || html, url);
    if (!logoUrl) {
      logoSvgMarkup = extractInlineLogoSvg(rawHtml || html);
    }
    footerContact = extractFooterContact(html || rawHtml);
    referenceImageUrls = extractContentImageUrls(rawHtml || html, url, MAX_REFERENCE_IMAGES);
    console.log('[scrapeCompetitorUrl] brand assets', {
      logoUrl: logoUrl ? logoUrl.slice(0, 120) : null,
      hasLogoSvg: !!logoSvgMarkup,
      footerContact,
      referenceImageCount: referenceImageUrls.length,
    });
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

  if (!cssTokens && !palette && screenshots.length === 0) return null;

  // NOT truncated here. This function has no idea which call the text is going
  // to or what else that call has to send, so any number picked at this point
  // is a guess about somebody else's page — and the guess was 30,000
  // characters, which amputated the bottom third of a twelve-section site and
  // told nobody. Callers slice it against a real budget instead
  // (remainingInputChars), and markdown above survives whole either way.
  const pageContent = firecrawlResult.status === 'fulfilled'
    ? firecrawlResult.value.html
    : '';

  const stats: ScrapeStats = {
    inlineCssChars,
    externalCssChars,
    stylesheetsFetched,
    stylesheetsFound,
    colorsFound,
    fontsFound,
    htmlChars: pageContent.length,
    markdownChars: markdown.length,
    imagesFound: referenceImageUrls.length,
    screenshotCount: screenshots.length,
  };
  console.log('[scrapeCompetitorUrl] scrape stats', stats);

  return {
    screenshots,
    cssTokens: cssTokens ?? '',
    palette,
    markdown,
    pageContent,
    logoUrl,
    logoSvgMarkup,
    footerContact,
    referenceImageUrls,
    stats,
  };
}

/**
 * Plain-English account of anything this scrape could NOT get.
 *
 * Handed to the model rather than acted on in code: whether a thin scrape is
 * worth mentioning to the user, building around, or asking about is a
 * judgement about the request, and the model is the only thing here that has
 * both the request and the result in front of it. Empty string when the scrape
 * came back healthy, which is the common case.
 */
export function describeScrapeGaps(stats: ScrapeStats): string {
  const gaps: string[] = [];
  if (stats.inlineCssChars + stats.externalCssChars < 2_000) {
    gaps.push(
      'Almost no CSS could be read from this site, so the exact colours and fonts below may be incomplete — lean on the screenshot for anything the palette does not cover, and say so if you had to guess.',
    );
  } else if (stats.stylesheetsFound > stats.stylesheetsFetched) {
    gaps.push(
      `${stats.stylesheetsFound - stats.stylesheetsFetched} of this site's ${stats.stylesheetsFound} stylesheets could not be downloaded, so some colours or fonts may be missing from the palette.`,
    );
  }
  if (stats.colorsFound === 0) gaps.push('No colour values were recoverable from the CSS at all.');
  if (stats.fontsFound === 0) gaps.push('No font families were recoverable from the CSS at all.');
  if (stats.screenshotCount === 0) {
    gaps.push('No screenshot of this site could be captured, so you cannot see its layout — build from the text and palette alone, and keep the structure conservative.');
  }
  if (stats.markdownChars === 0 && stats.htmlChars === 0) {
    gaps.push('None of this page\'s text content could be retrieved.');
  }
  return gaps.length > 0 ? `SCRAPE GAPS — what we could NOT get from this site:\n${gaps.map((g) => `- ${g}`).join('\n')}` : '';
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
 * HTML — used when create/build/follow-up need a real asset URL to embed
 * instead of a screenshot thumb or AI-generated mark.
 * Deliberately conservative: returns null rather than guessing when nothing
 * scores as a plausible logo, since embedding the wrong image is worse than
 * falling back to the existing behavior.
 *
 * Prefers fetchable image URLs (<img src>, srcset, or icon link).
 * For pure inline SVG wordmarks, see extractInlineLogoSvg (ai-brand-assets) —
 * we never invent a mark when both return null.
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

  if (candidates.length === 0) {
    // Last-resort: apple-touch-icon / icon with "logo" in href — never og:image (usually a photo)
    const iconRe = /<link\b[^>]*rel=["'][^"']*(?:apple-touch-icon|icon)[^"']*["'][^>]*>/gi;
    let iconMatch: RegExpExecArray | null;
    while ((iconMatch = iconRe.exec(rawHtml))) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(iconMatch[0])?.[1];
      if (!href || href.startsWith('data:')) continue;
      if (/logo/i.test(href) || /apple-touch-icon/i.test(iconMatch[0])) {
        return resolveUrl(href, pageUrl);
      }
    }
    return null;
  }
  // Highest score wins; ties broken by earliest occurrence — the logo is
  // almost always the first element inside the header/nav.
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return resolveUrl(candidates[0].src, pageUrl);
}

/**
 * Lightweight fetch for logo assets — skips screenshot/CSS extraction.
 * Returns fetchable logoUrl and/or inline logoSvgMarkup (never invents either).
 */
export async function fetchLogoAssets(
  url: string,
): Promise<{ logoUrl: string | null; logoSvgMarkup: string | null }> {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!firecrawlKey) return { logoUrl: null, logoSvgMarkup: null };
  try {
    const { rawHtml, html } = await Promise.race([
      fetchFirecrawlData(url, firecrawlKey),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('20s timeout')), 20_000)),
    ]);
    const source = rawHtml || html;
    if (!source) return { logoUrl: null, logoSvgMarkup: null };
    const logoUrl = extractLogoUrl(source, url);
    const logoSvgMarkup = logoUrl ? null : extractInlineLogoSvg(source);
    return { logoUrl, logoSvgMarkup };
  } catch (err) {
    console.error('[fetchLogoAssets] failed:', err);
    return { logoUrl: null, logoSvgMarkup: null };
  }
}

/**
 * Conservative extraction of non-logo content photos (team/product/hero-ish).
 * Never returns logo candidates. Fail-closed: empty array if unsure.
 */
export const MAX_REFERENCE_IMAGES = 14;

/**
 * Real photographs from the reference site.
 *
 * ── WHY THIS WAS REWRITTEN ───────────────────────────────────────────────────
 * The previous version found four images on a twelve-section site, and the
 * builder filled the gap by paying an image model to invent a fake one. Four
 * separate filters were doing it:
 *
 *   • a SCORE GATE — an image was discarded unless its filename or attributes
 *     matched one of headshot|portrait|team|founder|about|product|photo|
 *     people|staff. A perfectly good `DSC_4821.jpg`, or anything a CMS had
 *     renamed to a hash, scored zero and was dropped. That gate was a keyword
 *     guess about content, which is exactly the kind of judgement this codebase
 *     hands to a model everywhere else. Removed.
 *   • <img src> ONLY — CSS background-image, <picture>/<source>, and lazyload
 *     data-src/data-lazy-src were all invisible. On a modern CMS that is most
 *     of the page's imagery.
 *   • a cap of 6.
 *   • header/nav skipped wholesale, which also skipped the hero on any site
 *     whose hero lives inside <header>.
 *
 * What remains is only what is genuinely mechanical: skip the logo, skip
 * tracking pixels and sprites, skip SVG (it is chrome far more often than
 * content). Deciding whether a photo SUITS a slot stays with the model, which
 * can see them.
 */
export function extractContentImageUrls(
  rawHtml: string,
  pageUrl: string,
  max = MAX_REFERENCE_IMAGES,
): string[] {
  const logoUrl = extractLogoUrl(rawHtml, pageUrl);
  const out: string[] = [];
  const seen = new Set<string>();

  const consider = (src: string | undefined, context: string) => {
    if (!src || out.length >= max) return;
    const trimmed = src.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return;
    if (/\.svgz?(\?|#|$)/i.test(trimmed)) return;
    // Chrome, not content. Kept deliberately narrow — this is the one filter
    // that can still throw away a real photo, so it only matches things that
    // are never photographs.
    if (/logo|sprite|spacer|placeholder|1x1|pixel\.|tracking|favicon|icon-|\/icons?\//i.test(trimmed + ' ' + context)) return;
    const resolved = resolveUrl(trimmed, pageUrl);
    if (!resolved || !/^https?:/i.test(resolved)) return;
    if (logoUrl && resolved === logoUrl) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };

  /** srcset carries several widths of one image — take the last (largest). */
  const fromSrcset = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const candidates = value.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
    return candidates[candidates.length - 1];
  };

  // 1. <img>, including every lazyload attribute in common use.
  const imgRe = /<img\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(rawHtml)) !== null && out.length < max) {
    const attrs = m[1];
    const src =
      /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ||
      /\bdata-src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ||
      /\bdata-lazy-src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ||
      /\bdata-original\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ||
      fromSrcset(/\bsrcset\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]) ||
      fromSrcset(/\bdata-srcset\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]);
    consider(src, attrs);
  }

  // 2. <picture><source srcset>.
  const sourceRe = /<source\b([^>]*)>/gi;
  while ((m = sourceRe.exec(rawHtml)) !== null && out.length < max) {
    const attrs = m[1];
    consider(fromSrcset(/\bsrcset\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]), attrs);
  }

  // 3. CSS background-image, inline or in a <style> block. On CMS-built sites
  //    this is where most section imagery actually lives.
  const bgRe = /background(?:-image)?\s*:\s*[^;"'}]*url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = bgRe.exec(rawHtml)) !== null && out.length < max) {
    consider(m[1], 'background-image');
  }

  return out;
}

/**
 * Lightweight fetch for real content photos (headshots/products) — not logos.
 * Never invents URLs; returns [] on failure.
 */
export async function fetchContentImageAssets(url: string): Promise<string[]> {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!firecrawlKey) return [];
  try {
    const { rawHtml, html } = await Promise.race([
      fetchFirecrawlData(url, firecrawlKey),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('20s timeout')), 20_000)),
    ]);
    const source = rawHtml || html;
    if (!source) return [];
    return extractContentImageUrls(source, url, 6);
  } catch (err) {
    console.error('[fetchContentImageAssets] failed:', err);
    return [];
  }
}

/**
 * Lightweight fetch for just the site's logo image URL — used for "use the real
 * logo" follow-ups when an <img> exists. Prefer fetchLogoAssets when SVG fallback
 * is needed. Returns null (never throws) on any failure.
 */
export async function fetchLogoUrl(url: string): Promise<string | null> {
  const { logoUrl } = await fetchLogoAssets(url);
  return logoUrl;
}

/**
 * One viewport screenshot of the ABOVE-THE-FOLD of a public page URL.
 * Fail-closed: returns null on failure.
 */
export async function capturePageTopScreenshot(pageUrl: string): Promise<string | null> {
  const shots = await capturePageScrollScreenshots(pageUrl);
  return shots[0] ?? null;
}

/**
 * Screenshot the built page for whole-scroll visual QA.
 * Returns 1–3 jpeg base64 chunks (fold, optional mid, optional bottom).
 * Fail-closed: returns [] on any failure — callers skip QA and still Done.
 *
 * Caps: max 3 shots, ~50s total budget. Never a blind full rewrite.
 */
export async function capturePageScrollScreenshots(pageUrl: string): Promise<string[]> {
  const apiKey = process.env.API_FLASH_KEY?.trim();
  if (!apiKey || !pageUrl || !/^https?:\/\//i.test(pageUrl)) return [];

  const base = {
    access_key: apiKey,
    url: pageUrl,
    format: 'jpeg',
    quality: '75',
    width: '1280',
    response_type: 'json',
    fresh: 'true',
  };

  const capture = async (extra: Record<string, string>, timeoutMs: number): Promise<Buffer | null> => {
    try {
      const buf = await Promise.race([
        apiFlashCapture(new URLSearchParams({ ...base, ...extra })),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${timeoutMs}ms timeout`)), timeoutMs),
        ),
      ]);
      if (!buf || buf.length < 1500) return null;
      return buf;
    } catch (err) {
      console.warn('[capturePageScrollScreenshots] chunk failed', err);
      return null;
    }
  };

  try {
    // Prefer one full-page shot when the page is short enough for vision
    const full = await capture({ full_page: 'true' }, 30_000);
    if (full) {
      const h = getJpegHeight(full);
      console.log('[capturePageScrollScreenshots] full_page', { height: h, bytes: full.length });
      if (h > 0 && h <= 7900) {
        return [full.toString('base64')];
      }
      // Tall page: use fold + mid + bottom viewport chunks (max 3)
      const VIEW = 1600;
      const shots: string[] = [];
      const top = await capture({ height: String(VIEW) }, 20_000);
      if (top) shots.push(top.toString('base64'));
      if (h > VIEW * 1.4) {
        const midY = Math.floor(h / 2 - VIEW / 2);
        const mid = await capture(
          { height: String(VIEW), js: `window.scrollTo(0,${Math.max(0, midY)})` },
          20_000,
        );
        if (mid) shots.push(mid.toString('base64'));
      }
      if (h > VIEW * 2) {
        const bottomY = Math.max(0, h - VIEW);
        const bottom = await capture(
          { height: String(VIEW), js: `window.scrollTo(0,${bottomY})` },
          20_000,
        );
        if (bottom) shots.push(bottom.toString('base64'));
      }
      console.log('[capturePageScrollScreenshots] tall page chunks', { count: shots.length, pageHeight: h });
      return shots;
    }

    // full_page failed — at least try fold
    const fold = await capture({ height: '1400' }, 25_000);
    if (!fold) return [];
    console.log('[capturePageScrollScreenshots] fold-only fallback', { bytes: fold.length });
    return [fold.toString('base64')];
  } catch (err) {
    console.error('[capturePageScrollScreenshots] failed — skip live QA', err);
    return [];
  }
}

/**
 * Real, ground-truth style facts for HTML elements — read by asking an actual
 * (headless) browser what it rendered, not by hand-parsing CSS and
 * approximating the cascade ourselves.
 *
 * ai-page-transpile.ts used to read <style> text and approximate specificity
 * (see the old readStyleFacts/resolveDeclarations in ai-page-layout.ts). That
 * guesswork was wrong in ways that mattered: it trusted an unconditional
 * `display:none` an exporter's own JS reveals at runtime, it mis-scored
 * specificity, and fixing one page's edge case kept breaking a different
 * page's. A real browser cannot get "what does this element look like" wrong —
 * rendering pages correctly is its entire job — so this module asks Chrome
 * directly instead.
 *
 * Every element the transpiler needs facts for is tagged with a
 * `data-sl-i="N"` attribute first (see buildTaggedHtml in
 * ai-page-transpile.ts); this module loads that tagged HTML, lets the page's
 * own JS run (so lazy-reveal / fade-in effects settle the same way a real
 * visitor sees them), then reads window.getComputedStyle(el) for every
 * tagged element. document.body's own computed style is always included too,
 * under the reserved index -1.
 */

import puppeteer, { type Browser } from 'puppeteer-core';
import { existsSync } from 'fs';

/**
 * Every CSS property the transpiler and its checks read off an element.
 * Anything not in this list is invisible to the rebuild — keep it in sync
 * with KEEP_PROPS/FLOW_PROPS in ai-page-transpile.ts.
 */
export const RENDER_PROPS = [
  'display', 'visibility', 'position', 'left', 'top', 'width', 'height', 'min-height',
  'color', 'background', 'background-color', 'background-image', 'background-size',
  'background-position', 'background-repeat', 'background-blend-mode',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'text-align',
  'text-transform', 'text-decoration', 'text-shadow', 'white-space',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius',
  'box-shadow', 'opacity', 'list-style', 'list-style-type',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'object-fit', 'object-position', 'fill', 'stroke',
  'flex-direction', 'flex-wrap', 'align-items', 'justify-content',
  'align-content', 'gap', 'row-gap', 'column-gap', 'grid-template-columns',
  'grid-template-rows', 'grid-auto-flow', 'grid-column', 'grid-row', 'place-items',
  'max-width', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
  'margin-left', 'aspect-ratio',
] as const;

async function resolveExecutablePath(): Promise<string> {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (isServerless) {
    const chromium = (await import('@sparticuz/chromium')).default;
    return chromium.executablePath();
  }

  // Local dev has no bundled Chromium — @sparticuz/chromium only ships a Linux
  // binary. Fall back to whatever real Chrome/Edge is already on the machine.
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;

  throw new Error(
    'No Chrome/Edge install found for page rendering. Set PUPPETEER_EXECUTABLE_PATH to a ' +
    'Chrome or Edge executable to run the AI page rebuild locally.',
  );
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
      const executablePath = await resolveExecutablePath();
      let args = ['--no-sandbox', '--disable-setuid-sandbox'];
      if (isServerless) {
        const chromium = (await import('@sparticuz/chromium')).default;
        args = chromium.args;
      }
      return puppeteer.launch({ executablePath, args, headless: true });
    })();
    browserPromise.catch(() => { browserPromise = null; }); // let a failed launch be retried
  }
  return browserPromise;
}

/**
 * Render `taggedHtml` at `viewportWidth` and return real computed style facts
 * per `data-sl-i` index, plus `document.body`'s own facts under index -1.
 */
export async function renderNodeFacts(
  taggedHtml: string,
  viewportWidth: number,
): Promise<Map<number, Record<string, string>>> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    page.on('dialog', (d) => { void d.dismiss(); });
    await page.setViewport({ width: viewportWidth, height: 1200 });
    await page.setContent(taggedHtml, { waitUntil: 'load', timeout: 45_000 });
    // networkidle/load only waits for the network — a timer-driven fade-in
    // (the lazy-reveal pattern real exporters use) still needs a moment to run.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Scroll the whole page top to bottom before reading anything.
    //
    // A real exporter's reveal is routinely IntersectionObserver-driven, not
    // just a timer — the element only becomes visible once it scrolls into
    // view. A headless page that never scrolls never fires that observer, so
    // a whole section far down the page (found on a real Titan Funding export
    // at 4830px into a 5713px canvas) stayed `display:none` in every fact we
    // read — not because it truly isn't shown, but because nothing ever asked
    // the page to show it, the same class of problem as trusting an
    // unconditional `display:none` that a real visitor's scrolling reveals.
    await page.evaluate(async () => {
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      let y = 0;
      const max = document.body.scrollHeight;
      while (y < max) {
        y = Math.min(y + step, max);
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await new Promise((resolve) => setTimeout(resolve, 800));

    const raw = await page.evaluate((props: readonly string[]) => {
      const out: Array<[number, Record<string, string>]> = [];
      const styleOf = (el: Element): Record<string, string> => {
        const cs = window.getComputedStyle(el);
        const decls: Record<string, string> = {};
        for (const prop of props) {
          const v = cs.getPropertyValue(prop);
          if (v) decls[prop] = v;
        }
        // An icon-font glyph (Tabler, Font Awesome…) is an empty tag whose
        // entire visible content is a `content:` rule on ::before/::after —
        // no text, no <img>, nothing the rest of this file's content model
        // otherwise recognises. Reading the real pseudo-element content is
        // the only ground-truth way to tell "empty and decorative" apart from
        // "empty and about to render an icon."
        const before = window.getComputedStyle(el, '::before').content;
        const after = window.getComputedStyle(el, '::after').content;
        const hasPseudoContent = (v: string) => v && v !== 'none' && v !== '""' && v !== "''";
        if (hasPseudoContent(before) || hasPseudoContent(after)) decls['--sl-icon-glyph'] = '1';

        // Real offset from the element's own DOM parent, read off the box the
        // browser actually painted rather than trusted from the `left`/`top`
        // CSS properties above. A page-builder's own runtime JS (a multi-step
        // form engine repositioning its own container after load, the
        // trigger case) can move an element in a way `getComputedStyle` never
        // reflects: the computed `left`/`top` still report the exported
        // stylesheet's original rule, while the actual paint has moved via a
        // transform or a later inline style neither property distinguishes
        // from the stale declared value. getBoundingClientRect() cannot be
        // fooled the same way — it is where the browser really put the box —
        // so it is what every reader of position should trust instead.
        const parent = el.parentElement;
        if (parent) {
          const rect = el.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          decls['--sl-left'] = `${rect.left - parentRect.left}px`;
          decls['--sl-top'] = `${rect.top - parentRect.top}px`;
        }
        return decls;
      };
      document.querySelectorAll('[data-sl-i]').forEach((el) => {
        const idx = Number(el.getAttribute('data-sl-i'));
        if (Number.isFinite(idx)) out.push([idx, styleOf(el)]);
      });
      out.push([-1, styleOf(document.body)]);
      return out;
    }, RENDER_PROPS);

    return new Map(raw);
  } finally {
    await page.close();
  }
}

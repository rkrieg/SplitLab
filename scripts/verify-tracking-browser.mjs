/**
 * The same forwarding, checked in a real browser instead of a shim.
 *
 * verify-tracking-iframes.mjs proves the LOGIC against a hand-written DOM. That
 * cannot tell you whether overriding HTMLIFrameElement.prototype.src actually
 * holds in Chrome, whether the MutationObserver fires early enough for an iframe
 * the HTML parser inserted, or whether the page's own click/form paths still
 * behave once we have patched a prototype underneath them. This runs headless
 * Chrome over two real origins and asserts on the URLs the vendor origin is
 * actually asked for.
 *
 * Two servers, because same-origin vs cross-origin is the whole rule:
 *   site   127.0.0.1:PORT_A  — the "client page", served exactly as the serve
 *                              route builds it (iframe head script + tracking
 *                              snippet, through injectIntoHtml)
 *   vendor localhost:PORT_B  — stands in for Calendly/HubSpot/Stripe. Different
 *                              hostname, so the browser treats it as a third
 *                              party. It logs every URL it is asked for, and
 *                              those logs are what the assertions read.
 *
 * Needs a local Chrome or Edge. Set CHROME_PATH to override the search.
 *
 * Run: node scripts/verify-tracking-browser.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-browser');

// ── locate a browser ─────────────────────────────────────────────────────────
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Edge found. Set CHROME_PATH and re-run.');
  process.exit(1);
}

// ── build the real scripts ───────────────────────────────────────────────────
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'src'), { recursive: true });

for (const f of ['tracking-params.ts', 'tracking-iframes.ts']) {
  writeFileSync(join(outDir, 'src', f), readFileSync(join(repoRoot, 'src', 'lib', f), 'utf8').replace(/@\/lib\//g, './'));
}
writeFileSync(
  join(outDir, 'src', 'tracking.ts'),
  readFileSync(join(repoRoot, 'src', 'lib', 'tracking.ts'), 'utf8')
    .replace("import type { ConversionGoal } from '@/types';", 'type ConversionGoal = { id: string; type: string; selector?: string | null; url_pattern?: string | null };'),
);
writeFileSync(
  join(outDir, 'src', 'tracker.ts'),
  readFileSync(join(repoRoot, 'src', 'app', 'tracker.js', 'route.ts'), 'utf8')
    .replace("import { NextRequest, NextResponse } from 'next/server';", 'type NextRequest = { headers: { get(k: string): string | null } }; const NextResponse: any = class {};')
    .replace(/@\/lib\//g, './')
    .replace('function buildTrackerScript(', 'export function buildTrackerScript('),
);

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(outDir, 'src', 'tracking-params.ts'),
    join(outDir, 'src', 'tracking-iframes.ts'),
    join(outDir, 'src', 'tracking.ts'),
    join(outDir, 'src', 'tracker.ts'),
    '--outDir', join(outDir, 'js'),
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const { buildTrackingSnippet, injectIntoHtml } = require(join(outDir, 'js', 'tracking.js'));
const { buildIframeHeadScript } = require(join(outDir, 'js', 'tracking-iframes.js'));
const { buildTrackerScript } = require(join(outDir, 'js', 'tracker.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── servers ──────────────────────────────────────────────────────────────────
const vendorHits = [];   // every URL the third-party origin was asked for
const events = [];       // every /api/event body the snippet sent

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

const vendorServer = http.createServer((req, res) => {
  vendorHits.push(req.url);
  res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
  res.end('<!doctype html><title>vendor</title><p>vendor page</p>');
});

let pages = {};
const siteServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/event') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      events.push(body);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
    });
    return;
  }
  if (url.pathname === '/tracker.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' });
    res.end(buildTrackerScript(SITE));
    return;
  }
  const body = pages[url.pathname];
  if (!body) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(body);
});

const vendorPort = await listen(vendorServer);
const sitePort = await listen(siteServer);
// Different HOSTNAME, not just a different port — that is what makes the
// browser (and our same-host check) treat the vendor as a third party.
const VENDOR = `http://localhost:${vendorPort}`;
const SITE = `http://127.0.0.1:${sitePort}`;

// ── the page, built exactly the way the serve route builds it ────────────────
function buildPage(bodyHtml, { forwardParams = true, muteMode = '', customParams = [] } = {}) {
  const head = buildIframeHeadScript(customParams, forwardParams, muteMode);
  const snippet = buildTrackingSnippet('test-1', 'variant-a', 'visitor-1', [], SITE, customParams, muteMode, forwardParams);
  const raw = `<!doctype html><html><head><meta charset="utf-8"><title>client page</title></head><body>${bodyHtml}</body></html>`;
  return injectIntoHtml(raw, [head], [], snippet);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function visit(path, html, query = '?utm_source=meta&utm_campaign=spring&gclid=abc123') {
  pages[path] = html;
  vendorHits.length = 0;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${SITE}${path}${query}`, { waitUntil: 'networkidle0' });
  return { page, errors };
}

// LAST hit, not first. An iframe the HTML parser inserted has already begun
// fetching by the time the observer repoints it, so the vendor sees the bare URL
// and then the decorated one — the "loads twice" case. What the visitor ends up
// looking at is the last request, so that is what these assert on.
const hitFor = (needle) => [...vendorHits].reverse().find((u) => u.includes(needle));
const hitCount = (needle) => vendorHits.filter((u) => u.includes(needle)).length;
const paramsOf = (u) => (u ? Object.fromEntries(new URL(u, VENDOR).searchParams.entries()) : null);

// ═════════════════════════════════════════════════════════════════════════════
// 1. The widget shapes that actually matter
// ═════════════════════════════════════════════════════════════════════════════

// Calendly-inline shape: a vendor script finds its placeholder div and builds an
// iframe into it. This is the case that never worked before.
{
  const { page, errors } = await visit('/inline', buildPage(`
    <div id="cal" data-url="${VENDOR}/acme/intro"></div>
    <script>
      var d = document.getElementById('cal');
      var f = document.createElement('iframe');
      f.src = d.getAttribute('data-url');
      d.appendChild(f);
    </script>
  `));
  const p = paramsOf(hitFor('/acme/intro'));
  assert('inline widget (vendor script sets iframe.src) receives the ad params',
    !!p && p.utm_source === 'meta' && p.utm_campaign === 'spring' && p.gclid === 'abc123',
    JSON.stringify(p));
  assert('inline widget receives no sl_* context',
    !!p && !p.sl_vid && !p.sl_tid && !p.sl_vh);
  assert('no page errors on the inline widget page', errors.length === 0, errors[0]);
  await page.close();
}

// Calendly-popup shape: nothing exists until the visitor clicks, minutes later.
{
  const { page } = await visit('/popup', buildPage(`
    <button id="book">Book a call</button>
    <script>
      document.getElementById('book').addEventListener('click', function() {
        var overlay = document.createElement('div');
        var f = document.createElement('iframe');
        f.setAttribute('src', '${VENDOR}/popup/booking');
        overlay.appendChild(f);
        document.body.appendChild(overlay);
      });
    </script>
  `));
  await page.click('#book');
  await page.waitForNetworkIdle();
  const p = paramsOf(hitFor('/popup/booking'));
  assert('popup widget built on click (setAttribute) receives the ad params',
    !!p && p.utm_source === 'meta' && p.gclid === 'abc123', JSON.stringify(p));
  await page.close();
}

// Static markup — the HTML parser sets the attribute, so neither setter is
// involved and the MutationObserver has to catch it.
{
  const { page } = await visit('/static', buildPage(`<iframe src="${VENDOR}/static/embed"></iframe>`));
  const p = paramsOf(hitFor('/static/embed'));
  assert('a plain <iframe src> written in the HTML receives the ad params',
    !!p && p.utm_source === 'meta' && p.gclid === 'abc123', JSON.stringify(p));
  // The known cost of this path, pinned so it can never become a reload loop.
  //
  // One request or two, never more. It is a genuine race between the parser
  // starting the fetch and the MutationObserver repointing the element, and
  // both outcomes are correct: two means the bare URL was fetched first and
  // then replaced (the documented cost), one means the observer won and the
  // bare URL was never requested at all, which is strictly better. The check
  // above already pins the part that matters — the request that lands carries
  // the params. Asserting exactly 2 pinned the slower side of a race and
  // failed on a fast run.
  assert('a static iframe is repointed at most once (never a reload loop)',
    hitCount('/static/embed') >= 1 && hitCount('/static/embed') <= 2,
    `${hitCount('/static/embed')} requests`);
  await page.close();
}

// innerHTML — the other parser path, and the one MutationObserver exists for.
{
  const { page } = await visit('/inner', buildPage(`
    <div id="host"></div>
    <script>
      document.getElementById('host').innerHTML =
        '<iframe src="${VENDOR}/inner/embed"></iframe>';
    </script>
  `));
  await page.waitForNetworkIdle();
  const p = paramsOf(hitFor('/inner/embed'));
  assert('an iframe injected via innerHTML receives the ad params',
    !!p && p.utm_source === 'meta', JSON.stringify(p));
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. The skip cases — where we must NOT interfere
// ═════════════════════════════════════════════════════════════════════════════

{
  const { page } = await visit('/own', buildPage(`<iframe src="${VENDOR}/vendor/keeps?utm_source=partner"></iframe>`));
  const p = paramsOf(hitFor('/vendor/keeps'));
  assert('a param the vendor URL already sets keeps the vendor value', !!p && p.utm_source === 'partner');
  assert('the params the vendor did not set are still added', !!p && p.gclid === 'abc123');
  await page.close();
}
{
  const { page } = await visit('/optout', buildPage(`
    <div data-sl-no-params><iframe src="${VENDOR}/payments/card"></iframe></div>
  `));
  const p = paramsOf(hitFor('/payments/card'));
  assert('data-sl-no-params on a wrapper leaves the iframe URL untouched',
    !!p && Object.keys(p).length === 0, JSON.stringify(p));
  await page.close();
}
{
  const { page } = await visit('/off', buildPage(`<iframe src="${VENDOR}/x/off"></iframe>`, { forwardParams: false }));
  const p = paramsOf(hitFor('/x/off'));
  assert('forward_url_params off leaves the iframe URL untouched',
    !!p && Object.keys(p).length === 0, JSON.stringify(p));
  await page.close();
}
{
  const { page } = await visit('/preview', buildPage(`<iframe src="${VENDOR}/x/prev"></iframe>`, { muteMode: 'preview' }));
  const p = paramsOf(hitFor('/x/prev'));
  assert('a staff preview render leaves the iframe URL untouched',
    !!p && Object.keys(p).length === 0, JSON.stringify(p));
  await page.close();
}
{
  // A visitor who came from an ad EARLIER keeps their params for 90 days, so a
  // later visit with a clean URL still forwards them. That is deliberate — it is
  // the same remembered set decorate() has always used for links, and it is why
  // "ad lands on page 1, books on page 3" attributes at all. Asserted here so it
  // is a decision on the record rather than a surprise.
  const { page } = await visit('/returning', buildPage(`<iframe src="${VENDOR}/x/returning"></iframe>`), '');
  const p = paramsOf(hitFor('/x/returning'));
  assert('a returning visitor still forwards the ad params they arrived on',
    !!p && p.utm_source === 'meta', JSON.stringify(p));
  await page.close();
}
{
  // True direct traffic: a browser that has never seen an ad. Needs its own
  // context — every page above shares one profile, and therefore one localStorage.
  const ctx = await browser.createBrowserContext();
  pages['/direct'] = buildPage(`<iframe src="${VENDOR}/x/direct"></iframe>`);
  vendorHits.length = 0;
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${SITE}/direct`, { waitUntil: 'networkidle0' });
  const p = paramsOf(hitFor('/x/direct'));
  assert('a brand-new visitor with no ad params changes nothing at all',
    !!p && Object.keys(p).length === 0, JSON.stringify(p));
  assert('no page errors for a first-time visitor', errors.length === 0, errors[0]);
  await page.close();
  await ctx.close();
}
{
  // about:blank first, then a real src — the pattern many SDKs use.
  const { page } = await visit('/blank', buildPage(`
    <div id="h"></div>
    <script>
      var f = document.createElement('iframe');
      f.src = 'about:blank';
      document.getElementById('h').appendChild(f);
      f.src = '${VENDOR}/late/embed';
    </script>
  `));
  await page.waitForNetworkIdle();
  const p = paramsOf(hitFor('/late/embed'));
  assert('an about:blank iframe repointed later still gets the ad params',
    !!p && p.utm_source === 'meta', JSON.stringify(p));
  await page.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. REGRESSION — everything that already worked must still work
// ═════════════════════════════════════════════════════════════════════════════

{
  const { page, errors } = await visit('/links', buildPage(`
    <a id="out" href="${VENDOR}/out/link">Go</a>
    <form id="f" method="get" action="${VENDOR}/out/form"><button type="submit">Send</button></form>
    <iframe src="${VENDOR}/side/frame"></iframe>
  `));
  await page.waitForNetworkIdle();

  const href = await page.$eval('#out', (a) => { a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return a.href; });
  const linkP = paramsOf(href);
  assert('REGRESSION: a cross-domain link still gets the ad params on mousedown',
    linkP.utm_source === 'meta' && linkP.gclid === 'abc123', href);
  assert('REGRESSION: a cross-domain link still gets the sl_* context',
    linkP.sl_tid === 'test-1' && linkP.sl_vid === 'variant-a' && linkP.sl_vh === 'visitor-1');

  const hidden = await page.evaluate(() => {
    const f = document.getElementById('f');
    f.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const btn = f.querySelector('button');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return Array.from(f.querySelectorAll('input[type=hidden]')).map((i) => [i.name, i.value]);
  });
  const hiddenMap = Object.fromEntries(hidden);
  assert('REGRESSION: a GET form still carries the ad params as hidden inputs',
    hiddenMap.utm_source === 'meta' && hiddenMap.gclid === 'abc123', JSON.stringify(hidden));

  assert('REGRESSION: patching the iframe prototype broke nothing on the page', errors.length === 0, errors[0]);
  await page.close();
}

{
  // window.open on its own page: replacing window.open from the test would
  // replace the snippet's own patch and measure nothing, so let the real call
  // through and read the URL the vendor was actually asked for.
  const { page } = await visit('/open', buildPage(`
    <button id="w" onclick="window.open('${VENDOR}/out/open')">Open</button>
  `));
  await page.click('#w');
  await page.waitForNetworkIdle();
  const p = paramsOf(hitFor('/out/open'));
  assert('REGRESSION: window.open is still decorated with the iframe hook installed',
    !!p && p.utm_source === 'meta' && p.gclid === 'abc123', JSON.stringify(p));
  assert('REGRESSION: window.open still carries the sl_* context',
    !!p && p.sl_tid === 'test-1' && p.sl_vid === 'variant-a');
  await page.close();
}

{
  // The snippet's own signals must be unaffected by anything added in <head>.
  events.length = 0;
  const { page } = await visit('/events', buildPage('<p>hello</p>'));
  await page.waitForNetworkIdle();
  const pv = events.map((e) => { try { return JSON.parse(e); } catch { return null; } }).filter(Boolean);
  assert('REGRESSION: the pageview still fires',
    pv.some((e) => e.type === 'pageview' && e.testId === 'test-1' && e.variantId === 'variant-a'),
    JSON.stringify(pv));
  await page.close();
}

{
  // A page carrying BOTH the head script and a hardcoded tracker.js tag: one
  // hook must win, and the iframe must be decorated exactly once.
  const { page, errors } = await visit('/both', buildPage(`
    <script src="${SITE}/tracker.js"></script>
    <iframe src="${VENDOR}/both/embed"></iframe>
  `));
  await page.waitForNetworkIdle();
  const hits = vendorHits.filter((u) => u.includes('/both/embed'));
  const p = paramsOf(hits[hits.length - 1]);
  assert('a page running both the snippet and tracker.js decorates the iframe once',
    !!p && p.utm_source === 'meta' && !p.sl_vid, JSON.stringify(p));
  assert('no page errors with both scripts present', errors.length === 0, errors[0]);
  await page.close();
}

{
  // Same origin as the page itself: never touched.
  const { page } = await visit('/same', buildPage('<iframe src="/inner-page"></iframe>'));
  pages['/inner-page'] = '<!doctype html><p>inner</p>';
  await page.reload({ waitUntil: 'networkidle0' });
  const same = await page.$eval('iframe', (f) => f.getAttribute('src'));
  assert('REGRESSION: a same-origin iframe is left exactly as authored', same === '/inner-page', same);
  await page.close();
}

await browser.close();
vendorServer.close();
siteServer.close();
rmSync(outDir, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll browser checks passed.' : `\n${failed} browser check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

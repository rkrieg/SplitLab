/**
 * Real behaviour tests for src/lib/ai-page-transpile.ts.
 *
 * ── What went wrong, and what these tests are protecting ───────────────────
 *
 * The rebuild used to be a model call: pull the page's words and colours out with
 * code, hand them to the page builder, ask for "the same page in flow layout".
 * The model designed its own page. On a real Unbounce upload the output was about
 * a fifth as similar as it should have been:
 *
 *   - buttons came back red on white; the original was gold on navy
 *   - the typeface changed from Montserrat to the builder's default
 *   - four of seven images and the Vimeo embed were simply absent
 *   - copy was ADDED that was never on the page (142 text runs became 174)
 *
 * The fix was to stop generating and start copying. Every value is lifted from
 * the page's own stylesheet; only position/left/top/width/height are rewritten,
 * into sections, flex rows and proportional columns. That is what makes the two
 * halves of the job compatible rather than a trade-off: the output has to look
 * like the original AND be genuinely restructurable, because being
 * restructurable is the entire reason the rebuild exists.
 *
 * So there are two families of assertion here and BOTH must hold:
 *
 *   fidelity      every visible text run, image URL, embed URL, band background,
 *                 font and custom property survives
 *   editability   nothing absolute, no pixel left/top, no exporter ids or
 *                 classes, one <section> per band with SL markers around it
 *
 * A page that scores well on one and badly on the other is a failed rebuild.
 *
 * Run: node scripts/verify-page-transpile.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-transpile');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(repoRoot, 'src', 'lib', 'ai-page-layout.ts'),
    join(repoRoot, 'src', 'lib', 'ai-page-transpile.ts'),
    '--outDir', outDir,
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--downlevelIteration',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const T = require(join(outDir, 'ai-page-transpile.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A synthetic coordinate page, built to look like what exporters emit
// ═══════════════════════════════════════════════════════════════════════════
//
// Two background strips stacked in flow (a navy hero over a white body), with
// every piece of content in an absolutely positioned overlay above them, placed
// by page coordinates. Plus the three traps that cost real fidelity on a real
// page: a mobile stylesheet that comes LAST, a lazy-loaded image whose `src` is a
// 1x1 spacer, and a block the page hides on desktop.

const coordinatePage = `<!DOCTYPE html>
<html><head>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --brand-navy: #1b2268; --font-heading: Montserrat, sans-serif; }
  body { background: rgba(255,255,255,1); color: #222222; }
  #root { position: relative; width: 1200px; height: 1400px; }
  #band-hero { position: relative; width: 100%; height: 600px;
    background: rgba(27,34,104,0.9);
    background-image: url(https://cdn.example.com/hero-photo.png); }
  #band-body { position: relative; width: 100%; height: 800px;
    background: rgba(248,249,252,1); }
  #hidden-band { position: relative; width: 100%; height: 400px;
    display: none; background: rgba(255,0,0,1); }
  #headline { position: absolute; left: 100px; top: 80px; width: 1000px; height: 120px;
    font-family: var(--font-heading); font-size: 48px; font-weight: 700; color: #ffffff;
    text-align: center; }
  #subhead { position: absolute; left: 100px; top: 220px; width: 1000px; height: 60px;
    font-family: Montserrat; font-size: 20px; color: #d3dcf3; }
  #cta { position: absolute; left: 480px; top: 320px; width: 240px; height: 56px;
    background: rgba(191,146,35,1); color: #0b1b3d; border-radius: 6px; }
  #photo-left { position: absolute; left: 60px; top: 700px; width: 540px; height: 300px; }
  #copy-right { position: absolute; left: 640px; top: 700px; width: 500px; height: 300px;
    font-size: 18px; color: #333333; }
  #legal { position: absolute; left: 100px; top: 1300px; width: 1000px; height: 40px;
    font-size: 12px; color: #888888; }
  #secret { position: absolute; left: 0px; top: 1100px; width: 400px; height: 200px;
    display: none; }
  @media only screen and (max-width: 600px) {
    #root { width: 320px !important; height: 3000px !important; }
    #band-hero { height: 1200px !important; background: rgba(0,0,0,1) !important; }
    #headline { left: 10px !important; top: 20px !important; width: 300px !important;
      font-size: 22px !important; color: #000000 !important; }
    #cta { width: 300px !important; background: rgba(255,0,0,1) !important; }
  }
</style>
</head><body>
<div id="root">
  <div id="headline"><h1>Lock In Eleven Percent A Year</h1></div>
  <div id="subhead"><p>Two hundred projects since 2014.</p></div>
  <a id="cta" href="#secret"><span>See My Monthly Income</span></a>
  <div id="photo-left">
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
         alt="A funded project"
         data-src-mobile-1x="https://cdn.example.com/project-mobile.png"
         data-src-desktop-1x="https://cdn.example.com/project-desktop.png">
  </div>
  <div id="copy-right"><p>Every loan is secured against a hard asset.</p></div>
  <div id="video"><iframe src="https://player.vimeo.com/video/12345" allowfullscreen></iframe></div>
  <div id="legal"><p>Past performance is not a guarantee of future results.</p></div>
  <div id="secret"><p>Mobile-only duplicate headline</p></div>
  <div id="band-hero"></div>
  <div id="band-body"></div>
  <div id="hidden-band"><p>Never shown on desktop</p></div>
</div>
<script>document.querySelector('#cta').addEventListener('click', function () {});</script>
</body></html>`;

const r = T.transpileCoordinatePage(coordinatePage);
const out = r.html;

// ── Fidelity: the design came across ──────────────────────────────────────

assert('the hero keeps its own overlay colour', out.includes('rgba(27,34,104,0.9)'), out.slice(0, 200));
assert('and its own background photograph',
  out.includes('https://cdn.example.com/hero-photo.png'));
assert('the second band keeps its own colour', out.includes('rgba(248,249,252,1)'));
assert('the gold button stays gold', out.includes('rgba(191,146,35,1)'));
assert('and keeps its navy label colour', out.includes('#0b1b3d'));
assert('the real typeface is carried over, not the builder default',
  out.includes('Montserrat'));
assert('the font stylesheet the page linked comes with it',
  out.includes('fonts.googleapis.com'));
// Custom properties are the trap here: carrying `font-family: var(--font-heading)`
// across without its definition silently falls back to a browser default.
assert('custom properties are re-declared so var() still resolves',
  /:root \{[\s\S]*--font-heading: Montserrat/.test(out), 'no :root block with the font var');
assert('a heading that referenced a var still references it',
  out.includes('var(--font-heading)'));

// ── Fidelity: the mobile stylesheet did not win ───────────────────────────
//
// The 320px block is LAST in the file, so a media-query-blind reader takes its
// values for everything. On a real page that meant every position, width and
// background came from the phone layout.
assert('the mobile breakpoint does not decide the hero colour',
  !out.includes('rgba(0,0,0,1)'), 'mobile hero background leaked in');
assert('nor the button colour', !out.includes('rgba(255,0,0,1)'), 'mobile button colour leaked in');
assert('nor the heading colour', !/color: #000000/.test(out), 'mobile heading colour leaked in');
assert('the desktop font size is the one that survives', out.includes('48px') && !out.includes('22px'));

// ── Fidelity: nothing was dropped, nothing was invented ──────────────────

const check = T.checkTranspile(coordinatePage, out);
assert('every visible text run survives, exactly', check.missingTexts.length === 0,
  JSON.stringify(check.missingTexts));
assert('every image survives', check.missingImages.length === 0,
  JSON.stringify(check.missingImages));
assert('every embed survives', check.missingEmbeds.length === 0,
  JSON.stringify(check.missingEmbeds));
assert('so the check passes as a whole', check.ok === true);

// The lazy-loading trap: the only thing in `src` is a 1x1 spacer, and the real
// photo is in a data- attribute. Trusting `src` copies fourteen blank GIFs.
assert('a lazy-loaded image resolves to its real desktop source',
  out.includes('https://cdn.example.com/project-desktop.png'), 'lazy image not resolved');
assert('and not to its mobile source',
  !out.includes('project-mobile.png'), 'mobile variant of the image was used');
assert('the 1x1 spacer is not shipped as a picture',
  !out.includes('R0lGODlhAQABAIAAAAAAAP'), 'spacer GIF survived into the output');

// Exporters keep a hidden second copy of the page for small screens. Copying it
// does not reproduce the page, it duplicates every heading in it.
assert('content the page hides on desktop is left out',
  !out.includes('Mobile-only duplicate headline'), 'hidden duplicate was copied');
assert('and so is a whole hidden band',
  !out.includes('Never shown on desktop'), 'hidden band was copied');
assert('the hidden band does not contribute its colour either',
  !out.includes('rgba(255,0,0,1)'));
assert('what was skipped is counted, not silently swallowed', r.hidden > 0, `hidden=${r.hidden}`);

// ── Editability: the reason the rebuild exists at all ────────────────────

assert('nothing in the output is absolutely positioned',
  !/position:\s*absolute/i.test(out), 'absolute positioning survived');
assert('no element is placed by pixel left/top',
  !/(?:^|[^-\w])(?:left|top):\s*-?\d+px/im.test(out), 'pixel coordinates survived');
assert('the fixed page canvas is gone', !/height:\s*1400px/.test(out));
assert('exporter ids and classes are dropped',
  !/id="(?:headline|cta|band-hero)"/.test(out) && !out.includes('lp-pom'),
  'exporter identity survived');
assert('the page is sections in normal flow', (out.match(/<section/g) || []).length >= 2,
  `sections=${(out.match(/<section/g) || []).length}`);
assert('every section is wrapped in the markers the editor needs',
  (out.match(/<!-- SL:/g) || []).length === (out.match(/<section/g) || []).length);
assert('and every marker is closed',
  (out.match(/<!-- \/SL:/g) || []).length === (out.match(/<!-- SL:/g) || []).length);
assert('side-by-side content becomes a row of columns',
  out.includes('class="sl-row"') && /class="sl-col/.test(out));
assert('column widths are proportional, not pixel widths',
  /flex-grow:/.test(out) && !/width:\s*540px/.test(out));
assert('there is a breakpoint so the rebuilt page works on a phone',
  /@media \(max-width: 768px\)/.test(out));

// The image and the copy beside it genuinely are side by side (same top, no
// horizontal overlap), so they must share a row. This is the arithmetic that
// replaces the coordinates, and if it fails the page reads as a single column.
const photoRow = /<div class="sl-row"[^>]*>(?:(?!<\/div>\n)[\s\S])*?project-desktop\.png[\s\S]*?hard asset/;
assert('a photo and the copy beside it end up in the same row',
  photoRow.test(out), 'the two-column row was split into two rows');

// A subheading below a headline must NOT become a column beside it, even though
// exporter text boxes are tall enough to overlap vertically.
const headlineIdx = out.indexOf('Lock In Eleven Percent');
const subheadIdx = out.indexOf('Two hundred projects');
const between = out.slice(headlineIdx, subheadIdx);
assert('a stacked subheading stays below its headline, not beside it',
  headlineIdx > -1 && subheadIdx > headlineIdx && between.includes('class="sl-row"'),
  'headline and subheading were merged into one row');

// ── The link the exporter pointed at its own element id ─────────────────

assert('an in-page jump link is re-pointed at a section that exists',
  !out.includes('href="#secret"'), 'dead anchor left pointing at a dropped id');

// ── What we admit we cannot carry ───────────────────────────────────────
//
// Exporter JavaScript drives its widgets through the per-element ids the rebuild
// has to drop. Keeping the ids would keep the page unrestructurable, so this is a
// real loss and the user is told about it rather than left to find out.
assert('the loss of the page builder\'s own scripts is reported',
  r.warnings.some((w) => /Interactive extras/.test(w)), JSON.stringify(r.warnings));
assert('and the note is written in plain language',
  r.warnings.some((w) => /pop-ups|sliders|sticky bars/.test(w)));

// ── Sections are named after their content ─────────────────────────────

assert('sections get readable names', r.sections.length >= 2 &&
  r.sections.every((s) => /^[a-z0-9][a-z0-9-]*$/.test(s.name)),
  JSON.stringify(r.sections.map((s) => s.name)));
assert('section names are unique',
  new Set(r.sections.map((s) => s.name)).size === r.sections.length);

// ═══════════════════════════════════════════════════════════════════════════
// Pages that are not coordinate pages, and malformed input
// ═══════════════════════════════════════════════════════════════════════════
//
// This runs on user-uploaded HTML, so it must not throw on anything. A rebuild
// that crashes is worse than one that produces a thin page: the route can report
// "nothing came through" and leave the page alone, but it cannot recover from an
// exception mid-stream.

const nasty = [
  ['empty string', ''],
  ['no body', '<html><head><style>#a{position:absolute;left:1px;top:2px}</style></head></html>'],
  ['unclosed tags', '<body><div id="a"><p>hello<div><span>world</body>'],
  ['no stylesheet', '<body><div><h1>Plain</h1></div></body>'],
  ['style block with no braces', '<body><style>this is not css at all</style><p>hi</p></body>'],
  ['comment only', '<body><!-- nothing here --></body>'],
  ['a flow page', '<body><section><h1>Flow</h1><p>Normal markup</p></section></body>'],
];
for (const [label, html] of nasty) {
  let ok = true;
  let detail = '';
  try {
    const res = T.transpileCoordinatePage(html);
    if (typeof res.html !== 'string') { ok = false; detail = 'no html returned'; }
    T.checkTranspile(html, res.html);
    T.expectedContent(html);
  } catch (err) {
    ok = false;
    detail = String(err && err.message ? err.message : err);
  }
  assert(`survives ${label} without throwing`, ok, detail);
}

// A page with no background strips at all still has to keep its content — the
// fallback puts everything in one section rather than returning nothing.
const noBands = `<html><head><style>
  #a { position: absolute; left: 0px; top: 0px; width: 600px; height: 100px; }
  #b { position: absolute; left: 0px; top: 200px; width: 600px; height: 100px; }
</style></head><body>
  <div id="a"><h1>Still here</h1></div><div id="b"><p>And this too</p></div>
</body></html>`;
const nb = T.transpileCoordinatePage(noBands);
assert('a page with no background strips keeps its content',
  nb.html.includes('Still here') && nb.html.includes('And this too'), nb.html.slice(0, 300));
assert('and says so rather than pretending it found sections',
  nb.warnings.some((w) => /one section/.test(w)), JSON.stringify(nb.warnings));

// ═══════════════════════════════════════════════════════════════════════════
// The real Unbounce upload, when it is present
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Whose rule is it? Context-dependent selectors
// ═══════════════════════════════════════════════════════════════════════════
//
// The single worst bug this file has seen. The stylesheet reader kept only the
// rightmost part of a selector, so `.tf-dashboard__circle-inner span { font-size:
// 12px; color: #d3dcf3 }` was stored as "every span on the page" — and the
// rebuild dutifully repainted every headline as small grey print. All 115 text
// runs were present, so the content check passed. The user's screenshots did not.
//
// This is asserted here, on a page small enough to read, rather than through
// checkAppearance — that check resolves BOTH sides with this same code, so a
// resolver that misreads the source copies the wrong value into the output and
// then agrees with itself. Breaking the resolver on purpose does not fail it.
// Reading the emitted CSS back out is what makes this test independent.

/** The CSS the output actually gives the element that directly holds `text`. */
function emittedStyleFor(html, text) {
  const at = html.indexOf(text);
  if (at === -1) return null;
  const open = html.lastIndexOf('<', at);
  const tag = html.slice(open, at);
  const cls = /class="([^"]*)"/.exec(tag);
  if (!cls) return '';
  return cls[1]
    .split(/\s+/)
    .map((c) => new RegExp(`\\.${c}\\s*\\{([^}]*)\\}`).exec(html)?.[1] ?? '')
    .join(' ');
}

const contextPage = `<!DOCTYPE html>
<html><head><style>
  #root { position: relative; width: 1000px; height: 900px; }
  #band { position: relative; width: 100%; height: 900px; background: rgba(240,240,240,1); }
  #a { position: absolute; left: 0px; top: 0px; width: 1000px; height: 200px; }
  #b { position: absolute; left: 0px; top: 300px; width: 1000px; height: 200px; }
  #c { position: absolute; left: 0px; top: 600px; width: 1000px; height: 200px; }
  /* Context-dependent: must reach the card's paragraph and nothing else. */
  .card p { font-size: 11px; color: #cccccc; }
  /* Two ancestors deep, rightmost a bare tag — the real page's exact shape. */
  .stats li span { color: #94a3b8; }
  /* Standalone rules still apply everywhere. */
  strong { font-weight: 800; }
</style></head><body>
<div id="root">
  <div id="a"><div class="card"><p>Small print inside the card</p></div></div>
  <div id="b"><p>A paragraph that is not in any card at all</p></div>
  <div id="c"><ul><li><span>A list item outside the stats block</span></li></ul>
    <p><strong>Bold everywhere</strong></p></div>
  <div id="band"></div>
</div>
</body></html>`;

const ctx = T.transpileCoordinatePage(contextPage).html;

assert('a contextual rule reaches the element it was written for',
  /font-size:\s*11px/.test(emittedStyleFor(ctx, 'Small print inside the card')),
  emittedStyleFor(ctx, 'Small print inside the card'));
assert('and does NOT reach the same tag elsewhere on the page',
  !/font-size:\s*11px/.test(emittedStyleFor(ctx, 'A paragraph that is not in any card')),
  emittedStyleFor(ctx, 'A paragraph that is not in any card'));
assert('every ancestor a selector names is required, not just the nearest',
  !/94a3b8/i.test(emittedStyleFor(ctx, 'A list item outside the stats block')),
  emittedStyleFor(ctx, 'A list item outside the stats block'));
assert('a standalone tag rule still applies',
  /font-weight:\s*800/.test(emittedStyleFor(ctx, 'Bold everywhere')),
  emittedStyleFor(ctx, 'Bold everywhere'));

// ═══════════════════════════════════════════════════════════════════════════
// Wrappers, comments, and junk values
// ═══════════════════════════════════════════════════════════════════════════

const wrapperPage = `<!DOCTYPE html>
<html><head><style>
  :root {
    /* Palette — the comment is the point: the declaration after one used to be
       swallowed into its property name and dropped. */
    --panel: #101828;
    --ink: #ffffff;
  }
  #root { position: relative; width: 1000px; height: 700px; }
  #band { position: relative; width: 100%; height: 700px; background: rgba(255,255,255,1); }
  #box { position: absolute; left: 0px; top: 0px; width: 1000px; height: 400px; }
  .panel { background: var(--panel); border-radius: 18px; padding: 32px;
    display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .panel p { color: var(--ink); }
  .btn { background: #bf9223; border-color: #undefined; border-width: undefinedpx; }
</style></head><body>
<div id="root">
  <div id="box"><div class="panel">
    <p>Left half of the panel</p><p>Right half of the panel</p>
    <button class="btn">Go</button>
  </div></div>
  <div id="band"></div>
</div>
</body></html>`;

const wr = T.transpileCoordinatePage(wrapperPage).html;

assert('a wrapper that paints something survives as a div',
  /<div class="sl-s\d+">/.test(wr) && /border-radius: 18px/.test(wr), wr.slice(0, 400));
assert('and keeps its own padding rather than losing it with the box',
  /padding: 32px/.test(wr));
assert('a flow wrapper keeps the grid that puts its children side by side',
  /grid-template-columns: 1fr 1fr/.test(wr) && /gap: 24px/.test(wr));
assert('the first custom property after a CSS comment is not lost',
  wr.includes('--panel:') && wr.includes('--ink:'), wr.slice(0, 500));
assert('so text inheriting through var() still resolves',
  /color: var\(--ink\)/.test(wr) && wr.includes('--ink:'));
assert('values the page builder wrote broken are dropped, not copied',
  !/undefined/.test(wr));
assert('while the good value beside them is kept', wr.includes('#bf9223'));

const titanPath = join(repoRoot, 'titan-template-original.html');
if (existsSync(titanPath)) {
  const titan = readFileSync(titanPath, 'utf8');
  const t = T.transpileCoordinatePage(titan);
  const tc = T.checkTranspile(titan, t.html);

  assert('[real page] it becomes several editable sections', t.sections.length >= 5,
    `sections=${t.sections.length}`);
  assert('[real page] every text run survives', tc.missingTexts.length === 0,
    JSON.stringify(tc.missingTexts.slice(0, 3)));
  assert('[real page] every image survives', tc.missingImages.length === 0,
    JSON.stringify(tc.missingImages));
  assert('[real page] the video embed survives', tc.missingEmbeds.length === 0,
    JSON.stringify(tc.missingEmbeds));
  // The four colours the model-written version got wrong, and the typeface.
  assert('[real page] the navy hero overlay is kept', t.html.includes('rgba(27,34,104,0.32)'));
  assert('[real page] the navy strip is kept', t.html.includes('rgba(22,43,86,1)'));
  assert('[real page] the gold button is kept', /rgba\(191,146,35/.test(t.html));
  assert('[real page] Montserrat is kept', t.html.includes('Montserrat'));
  assert('[real page] nothing is absolutely positioned',
    !/position:\s*absolute/i.test(t.html));
  assert('[real page] no exporter identity is left',
    !/lp-pom|lp-element|lp-code/.test(t.html));
  assert('[real page] no dead in-page anchors', !/href="#lp-/.test(t.html));
  assert('[real page] the rebuild is small enough to edit', t.html.length < titan.length / 2,
    `${t.html.length} vs ${titan.length}`);

  // ── Appearance ───────────────────────────────────────────────────────────
  //
  // Everything above passed on a rebuild that was visually unusable: one
  // over-matched stylesheet rule (`.tf-dashboard__circle-inner span { font-size:
  // 12px; color: #d3dcf3 }`, keyed as "every span") repainted every headline on
  // the page as small grey print, and all 115 text runs were still present, so
  // the content check went green. These are the assertions that were missing.
  const ta = T.checkAppearance(titan, t.html);
  assert('[real page] every run of text keeps its font, size and colour',
    ta.ok, `${ta.mismatches.length} mismatches, e.g. ` +
    JSON.stringify(ta.mismatches.slice(0, 3)));
  assert('[real page] and enough of them were actually compared to mean something',
    ta.compared >= 100, `compared=${ta.compared}`);

  // The specific failures behind that rebuild, each pinned so it cannot come back.
  const src = T.resolveTextAppearance(titan);
  const out = T.resolveTextAppearance(t.html);
  const headline = 'We Loan Your Money To Real Estate Builders To Pay You';
  const key = [...src.keys()].find((k) => k.startsWith(headline));
  assert('[real page] the hero headline is found on both sides', !!key && out.has(key));
  if (key) {
    assert('[real page] the headline is not repainted as small print',
      out.get(key)['font-size'] === src.get(key)['font-size'],
      `${out.get(key)['font-size']} vs ${src.get(key)['font-size']}`);
    assert('[real page] the headline keeps its colour',
      out.get(key).color === src.get(key).color,
      `${out.get(key).color} vs ${src.get(key).color}`);
  }
  // `--font-heading` and `--clr-navy` were both the first declaration after a CSS
  // comment, and both were dropped, so every heading lost its typeface.
  assert('[real page] custom properties after a CSS comment survive',
    t.html.includes('--font-heading:') && t.html.includes('--clr-navy:'));
  assert('[real page] no var() is left pointing at nothing',
    [...(t.html.match(/var\(--[a-z0-9-]+/gi) ?? [])]
      .every((v) => t.html.includes(`${v.slice(4)}:`)),
    'a var() in the output has no :root definition');
  // Wrappers used to be discarded wholesale, which deleted every card on the page
  // and left light-on-white text where a dark panel had been.
  assert('[real page] cards keep their own background and padding',
    /<div class="sl-s\d+">/.test(t.html) && /border-radius: 16px/.test(t.html));
  // Hand-written blocks inside a coordinate page are already in flow; their own
  // grid is what puts two cards side by side instead of stacking them.
  assert('[real page] flow sections keep their grid', /grid-template-columns:/.test(t.html));
  assert('[real page] no broken values are copied', !/undefined|NaN/.test(t.html));
  // Coordinate gaps are only meaningful while what filled them still exists — a
  // script-injected calendar left a 382px hole and two footer columns a 699px gap.
  const bigGaps = [...(t.html.match(/(?:margin-top|gap):\s*(\d+)px/g) ?? [])]
    .map((m) => parseInt(m.match(/(\d+)/)[1], 10))
    .filter((n) => n > 200);
  assert('[real page] no runaway holes left by dropped widgets', bigGaps.length === 0,
    JSON.stringify(bigGaps));
} else {
  console.log('SKIP: titan-template-original.html not present');
}

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll transpile checks passed.');

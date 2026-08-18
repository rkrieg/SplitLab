/**
 * Real behavior tests for src/lib/ai-page-layout.ts.
 *
 * The bug this guards: an Unbounce landing page was uploaded, prepared for AI
 * editing, and the user asked to redesign its hero. We produced a clean new
 * hero, spliced it in, and reported "Done!" — twice, including after the user
 * said it was broken. On screen the new hero sat UNDERNEATH the old one, both
 * visible. The cause was in the head stylesheet, which no scoped edit ever
 * sees:
 *
 *     #lp-pom-root    { min-width: 1326px; height: 5713px; }
 *     #lp-pom-box-28  { position: absolute; left: 34px; top: 3777px; … }
 *
 * The page is a fixed pixel canvas. New markup has no coordinates, so it stacks
 * instead of flowing, and the original — being absolutely positioned — takes no
 * flow space to push it away.
 *
 * Two real files at the repo root are the headline cases when present:
 *   titan-template-original.html — the Unbounce upload (must read 'coordinate')
 *   template.html                — a page our own builder made (must read 'flow')
 *
 * Everything below them is the part that matters more: a wrong 'coordinate'
 * verdict would refuse restructuring on an ordinary page, so the flow cases
 * (Tailwind, Bootstrap, tables, minified, a few absolute badges, sticky nav)
 * are asserted just as hard as the coordinate ones.
 *
 * Run: node scripts/verify-page-layout.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-layout');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-page-layout.ts');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc', srcFile,
    '--outDir', outDir,
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--downlevelIteration',
    '--noResolve',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const L = require(join(outDir, 'ai-page-layout.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const kindOf = (html) => L.analyzePageLayout(html).kind;
const show = (html) => {
  const r = L.analyzePageLayout(html);
  return `kind=${r.kind} positioned=${r.positioned}/${r.candidates} h=${r.containerHeightPx}`;
};

// ═══════════════════════════════════════════════════════════════════════════
// The real pages
// ═══════════════════════════════════════════════════════════════════════════

const titanPath = join(repoRoot, 'titan-template-original.html');
if (existsSync(titanPath)) {
  const titan = readFileSync(titanPath, 'utf8');
  const r = L.analyzePageLayout(titan);

  assert('the real Unbounce upload reads as coordinate-based', r.kind === 'coordinate', show(titan));
  assert('and is therefore not offered for patching', r.strategy === 'rebuild');
  assert('the fixed page canvas is what gives it away', r.containerHeightPx !== null && r.containerHeightPx >= 1500,
    `containerHeightPx=${r.containerHeightPx}`);
  assert('with a real count of coordinate-placed elements behind it', r.positioned >= 50,
    `positioned=${r.positioned}`);
  // This is why the ratio alone is not enough: Titan embeds one large
  // flow-layout island (a <div class="lp-code"> full of <section>/flex/grid),
  // and those extra flow divs drag the share below half on their own.
  assert('and it would have been MISSED by a ratio test alone', r.share < 0.5,
    `share=${r.share.toFixed(2)} — if this is now >= 0.5 the fixed-canvas clause is no longer load-bearing`);
  assert('the reason is stated in words a user can read', r.reasons.length > 0 && /\d+px/.test(r.reasons.join(' ')));
} else {
  console.log('SKIP: titan-template-original.html not at repo root');
}

// The page after two AI edit turns — still the same coordinate page, so a
// prepared/edited copy must not read differently from the original.
const afterPath = join(repoRoot, 'titan-template-after.html');
if (existsSync(afterPath)) {
  const after = readFileSync(afterPath, 'utf8');
  assert('the same page after our edits still reads as coordinate-based',
    kindOf(after) === 'coordinate', show(after));
}

const templatePath = join(repoRoot, 'template.html');
if (existsSync(templatePath)) {
  const ours = readFileSync(templatePath, 'utf8');
  const r = L.analyzePageLayout(ours);
  assert('a page our own builder made reads as flow', r.kind === 'flow', show(ours));
  assert('and is patched in place', r.strategy === 'patch');
  assert('a couple of decorative absolute elements do not tip it over', r.positioned <= 5,
    `positioned=${r.positioned}`);
} else {
  console.log('SKIP: template.html not at repo root');
}

// ═══════════════════════════════════════════════════════════════════════════
// Coordinate layouts — the pages that must NOT be patched
// ═══════════════════════════════════════════════════════════════════════════

// Shape of an Unbounce/Instapage/Muse export: a fixed-height canvas, every
// element pinned by id.
const canvas = `<html><head><style>
#root { min-width: 1200px; height: 4200px; margin: auto; }
${Array.from({ length: 12 }, (_, i) =>
  `#box-${i} { position: absolute; left: ${20 + i}px; top: ${i * 300}px; width: 900px; height: 260px; }`,
).join('\n')}
</style></head><body><div id="root">
${Array.from({ length: 12 }, (_, i) => `<div id="box-${i}"><p>Block ${i} of this page</p></div>`).join('\n')}
</div></body></html>`;
assert('a fixed-height canvas of id-positioned boxes is coordinate-based',
  kindOf(canvas) === 'coordinate', show(canvas));

// Figma/Sketch exporters write the coordinates straight onto the element.
const inlineCoords = `<html><body><div style="position:relative;height:3000px">
${Array.from({ length: 10 }, (_, i) =>
  `<div style="position:absolute;left:40px;top:${i * 280}px;width:800px"><h2>Section ${i}</h2></div>`,
).join('\n')}
</div></body></html>`;
assert('inline left/top on every block is coordinate-based too',
  kindOf(inlineCoords) === 'coordinate', show(inlineCoords));

// Split declarations: position in one rule, coordinates in another.
const splitDecls = `<html><head><style>
.node { position: absolute; }
${Array.from({ length: 10 }, (_, i) => `#n${i} { left: 10px; top: ${i * 200}px; }`).join('\n')}
.node { display: block; }
</style></head><body><main>
${Array.from({ length: 10 }, (_, i) => `<div class="node" id="n${i}"><p>Item number ${i}</p></div>`).join('\n')}
</main></body></html>`;
assert('position and left/top declared in separate rules still counts',
  kindOf(splitDecls) === 'coordinate', show(splitDecls));

// The regression that the real "after" file caught: one AI edit had appended a
// section, so the body had two children instead of one, the single-wrapper
// descent stopped early, and a canvas check that only looked at the descent
// chain lost the signal on the exact page it was written for. A cookie banner or
// a modal parked at the end of the body does the same thing.
const canvasPlusStray = canvas.replace(
  '</body>',
  '<div class="cookie-banner"><p>We use cookies on this site</p></div></body>',
);
assert('a stray element at the end of the body does not hide the fixed canvas',
  kindOf(canvasPlusStray) === 'coordinate', show(canvasPlusStray));
const canvasPlusAppended = canvas.replace(
  '</div></body>',
  '</div><section class="hero"><h1>A brand new hero</h1><p>Written by an edit.</p></section></body>',
);
assert('and neither does a section our own edit appended',
  kindOf(canvasPlusAppended) === 'coordinate', show(canvasPlusAppended));

// Coordinates only inside a media query — same page, still coordinate-based.
const mediaOnly = `<html><head><style>
@media only screen and (min-width: 601px) {
  #wrap { height: 3800px; }
${Array.from({ length: 9 }, (_, i) => `  #m${i} { position: absolute; top: ${i * 300}px; left: 0; }`).join('\n')}
}
</style></head><body><div id="wrap">
${Array.from({ length: 9 }, (_, i) => `<div id="m${i}"><p>Row ${i} content here</p></div>`).join('\n')}
</div></body></html>`;
assert('coordinates inside a media query are read the same as top-level ones',
  kindOf(mediaOnly) === 'coordinate', show(mediaOnly));

// ═══════════════════════════════════════════════════════════════════════════
// Flow layouts — the pages that MUST keep being patched in place
// ═══════════════════════════════════════════════════════════════════════════

const tailwind = `<html><head><style>.sr-only{position:absolute;width:1px;height:1px}</style></head><body>
${Array.from({ length: 14 }, (_, i) =>
  `<section class="py-20 bg-slate-900"><div class="max-w-6xl mx-auto grid grid-cols-3 gap-8"><h2 class="text-4xl">Heading ${i}</h2><p>Some body copy for section ${i}.</p></div></section>`,
).join('\n')}
</body></html>`;
assert('a Tailwind page is flow', kindOf(tailwind) === 'flow', show(tailwind));

// The classic false positive to avoid: sticky nav, a badge, a modal, an overlay
// — a handful of absolutely-placed elements on an otherwise ordinary page.
const badges = `<html><head><style>
.nav { position: fixed; top: 0; left: 0; width: 100%; }
.badge { position: absolute; top: 12px; right: 12px; }
.modal { position: absolute; left: 50%; top: 50%; }
.overlay { position: absolute; left: 0; top: 0; }
.tooltip { position: absolute; left: 4px; top: 4px; }
.hero { padding: 120px 0; }
</style></head><body>
<nav class="nav"><a href="/">Home</a></nav>
<div class="overlay"></div><div class="modal"><p>Modal copy</p></div>
${Array.from({ length: 16 }, (_, i) =>
  `<section class="hero"><div class="badge">New</div><h2>Section ${i}</h2><p>Copy for ${i}.</p></section>`,
).join('\n')}
</body></html>`;
const badgeResult = L.analyzePageLayout(badges);
assert('a sticky nav, a modal and per-section badges do NOT make a page coordinate-based',
  badgeResult.kind === 'flow', show(badges));
assert('even though several elements really are absolutely positioned',
  badgeResult.positioned >= 4, `positioned=${badgeResult.positioned}`);

// An email-style table layout: brittle, but flow — order and nesting still rule.
const tables = `<html><body>
${Array.from({ length: 10 }, (_, i) =>
  `<table width="600"><tr><td><h2>Row ${i}</h2><p>Copy in row ${i} of this layout.</p></td></tr></table>`,
).join('\n')}
</body></html>`;
assert('a table layout is flow, not coordinates', kindOf(tables) === 'flow', show(tables));

// A tall hero is not a page canvas.
const tallHero = `<html><head><style>
.hero { height: 1800px; }
.badge { position: absolute; top: 8px; left: 8px; }
</style></head><body>
<section class="hero"><h1>Big hero</h1><div class="badge">New</div></section>
${Array.from({ length: 10 }, (_, i) => `<section class="band"><h2>Band ${i}</h2><p>Copy ${i}</p></section>`).join('\n')}
</body></html>`;
assert('one very tall section is not mistaken for a fixed page canvas',
  kindOf(tallHero) === 'flow', show(tallHero));

// A fixed-height container with nothing positioned in it is odd, not coordinate-based.
const tallNoCoords = `<html><head><style>#wrap { height: 5000px; }</style></head><body><div id="wrap">
${Array.from({ length: 12 }, (_, i) => `<section><h2>Part ${i}</h2><p>Copy for part ${i}.</p></section>`).join('\n')}
</div></body></html>`;
assert('a fixed page height alone, with nothing positioned, is still flow',
  kindOf(tallNoCoords) === 'flow', show(tallNoCoords));

// position:absolute WITHOUT coordinates (inset-0 / stretched overlays) is a
// flow-friendly pattern and must not be counted.
const noCoords = `<html><head><style>
${Array.from({ length: 12 }, (_, i) => `.fill-${i} { position: absolute; inset: 0; }`).join('\n')}
#wrap { height: 4000px; }
</style></head><body><div id="wrap">
${Array.from({ length: 12 }, (_, i) => `<div class="fill-${i}"><p>Overlay ${i} copy</p></div>`).join('\n')}
</div></body></html>`;
assert('absolute with no left/top is not a coordinate placement',
  kindOf(noCoords) === 'flow', show(noCoords));

// Minified — a single line, no whitespace anywhere.
const minified = canvas.replace(/\n/g, '').replace(/>\s+</g, '><');
assert('a minified coordinate page still reads as coordinate-based',
  kindOf(minified) === 'coordinate', show(minified));
const minifiedFlow = tailwind.replace(/\n/g, '').replace(/>\s+</g, '><');
assert('a minified flow page still reads as flow',
  kindOf(minifiedFlow) === 'flow', show(minifiedFlow));

// ═══════════════════════════════════════════════════════════════════════════
// Property names that look alike (the reason declValue anchors on ^ or ;)
// ═══════════════════════════════════════════════════════════════════════════

const lookalikes = `<html><head><style>
${Array.from({ length: 12 }, (_, i) =>
  `#p${i} { background-position: left top; line-height: 2000px; max-height: 3000px; }`,
).join('\n')}
</style></head><body>
${Array.from({ length: 12 }, (_, i) => `<div id="p${i}"><p>Panel ${i} copy</p></div>`).join('\n')}
</body></html>`;
const look = L.analyzePageLayout(lookalikes);
assert('background-position is not read as position', look.positioned === 0,
  `positioned=${look.positioned}`);
assert('line-height / max-height are not read as a fixed page height',
  look.containerHeightPx === null, `containerHeightPx=${look.containerHeightPx}`);
assert('so a page of lookalike properties stays flow', look.kind === 'flow');

// Non-px heights can flex, so they are never a fixed canvas.
const flexHeights = `<html><head><style>
#wrap { height: 100vh; }
.tall { height: 90%; }
.calc { height: calc(100vh - 60px); }
${Array.from({ length: 8 }, (_, i) => `#f${i} { position: absolute; left: 0; top: ${i}px; }`).join('\n')}
</style></head><body><div id="wrap">
${Array.from({ length: 8 }, (_, i) => `<div id="f${i}"><p>Floating ${i}</p></div>`).join('\n')}
<section class="tall"><p>a</p></section><section class="calc"><p>b</p></section>
${Array.from({ length: 12 }, (_, i) => `<section><p>Normal band ${i} with copy</p></section>`).join('\n')}
</div></body></html>`;
const flexH = L.analyzePageLayout(flexHeights);
assert('vh / % / calc heights are never a fixed canvas', flexH.containerHeightPx === null,
  `containerHeightPx=${flexH.containerHeightPx}`);
assert('and 8 positioned elements among 20+ stay under the ratio', flexH.kind === 'flow', show(flexHeights));

// ═══════════════════════════════════════════════════════════════════════════
// Degenerate input — must never throw, must never guess 'coordinate'
// ═══════════════════════════════════════════════════════════════════════════

for (const [name, html] of [
  ['empty string', ''],
  ['whitespace', '   \n  '],
  ['bare text', 'just some text with no tags at all in it whatsoever'],
  ['no body tag', '<div class="x"><p>fragment with no document around it</p></div>'],
  ['unclosed tags', '<body><section><div><p>oh dear this never closes'],
  ['style block never closed', '<body><style>#a{position:absolute;left:0;top:0}<div id="a">x</div></body>'],
  ['comment only', '<body><!-- nothing here --></body>'],
  ['head with no body', '<html><head><style>#a{height:9000px}</style></head></html>'],
]) {
  let r = null;
  let threw = null;
  try { r = L.analyzePageLayout(html); } catch (e) { threw = e; }
  assert(`${name}: does not throw`, !threw, threw && String(threw));
  assert(`${name}: falls back to patchable, never refuses an edit on a guess`,
    !!r && r.kind === 'flow' && r.strategy === 'patch',
    r ? `kind=${r.kind}` : 'no result');
}

// A three-block page has nothing to measure a ratio against, even if all three
// are absolutely positioned — too small to refuse edits on.
const tiny = `<html><head><style>
#a{position:absolute;left:0;top:0}#b{position:absolute;left:0;top:100px}
</style></head><body><div id="a"><p>One</p></div><div id="b"><p>Two</p></div></body></html>`;
assert('a two-block fragment is not judged', kindOf(tiny) === 'flow', show(tiny));

// A <script> or <style> body must never be read as markup.
const scriptSoup = `<html><head><style>#wrap{height:6000px}</style></head><body><div id="wrap">
<script>var s = '<div style="position:absolute;left:0;top:0"></div>'; for (var i=0;i<9;i++) {}</script>
${Array.from({ length: 12 }, (_, i) => `<section><h2>Real section ${i}</h2><p>Copy ${i}</p></section>`).join('\n')}
</div></body></html>`;
const soup = L.analyzePageLayout(scriptSoup);
assert('markup inside a <script> string is not counted as an element',
  soup.positioned === 0, `positioned=${soup.positioned}`);
assert('and such a page stays flow', soup.kind === 'flow', show(scriptSoup));

// ═══════════════════════════════════════════════════════════════════════════
// Speed, on real pages and on input designed to be awkward
//
// This runs on every prepare, every build and every follow-up edit, on pages up
// to half a megabyte. The first version of the CSS reader used
// /([^{}]+)\{([^{}]*)\}/g, which is quadratic when the braces are missing: a
// 200KB <style> block with no braces in it took MINUTES, not milliseconds.
// ═══════════════════════════════════════════════════════════════════════════

function timed(label, html, budgetMs) {
  const t = Date.now();
  L.analyzePageLayout(html + ' ');
  const ms = Date.now() - t;
  assert(`${label} in under ${budgetMs}ms`, ms < budgetMs, `took ${ms}ms`);
  return ms;
}

timed('a 400KB style block with no braces at all', `<html><head><style>${'a'.repeat(400_000)}</style></head><body><div>x</div></body></html>`, 2000);
timed('a 200KB style block of unclosed rules', `<html><head><style>${'.a{color:red'.repeat(16_000)}</style></head><body><div>x</div></body></html>`, 2000);
timed('a 300KB single-line body', `<html><body>${'<div class="a"><p>copy</p></div>'.repeat(10_000)}</body></html>`, 2000);
{
  const heavy = `<html><head><style>${Array.from({ length: 8000 }, (_, i) => `#x${i}{position:absolute;left:${i}px;top:0}`).join('')}</style></head><body>${Array.from({ length: 8000 }, (_, i) => `<div id="x${i}">c</div>`).join('')}</body></html>`;
  timed('8000 coordinate rules against 8000 elements', heavy, 3000);
  assert('and that page is still correctly read as coordinate-based',
    kindOf(heavy) === 'coordinate', show(heavy));
}
for (const path of [titanPath, afterPath, templatePath]) {
  if (!existsSync(path)) continue;
  timed(`the real ${path.split(/[\\/]/).pop()}`, readFileSync(path, 'utf8'), 500);
}

// ═══════════════════════════════════════════════════════════════════════════
// countLayoutElements — what the follow-up caveat compares
// ═══════════════════════════════════════════════════════════════════════════

assert('countLayoutElements counts layout elements only',
  L.countLayoutElements('<body><div></div><section></section><span></span><p></p><h1>x</h1></body>') === 2,
  String(L.countLayoutElements('<body><div></div><section></section><span></span><p></p><h1>x</h1></body>')));
assert('countLayoutElements sees an added block',
  L.countLayoutElements('<body><div><section><p>a</p></section></div></body>') -
  L.countLayoutElements('<body><div><p>a</p></div></body>') === 1);
assert('countLayoutElements ignores markup inside a script',
  L.countLayoutElements('<body><script>var a="<div></div><div></div>"</script><div></div></body>') === 1,
  String(L.countLayoutElements('<body><script>var a="<div></div><div></div>"</script><div></div></body>')));
assert('countLayoutElements survives empty input', L.countLayoutElements('') === 0);

// ═══════════════════════════════════════════════════════════════════════════
// The memo must never answer for the wrong page
// ═══════════════════════════════════════════════════════════════════════════

assert('memo: alternating between two pages gives each its own answer',
  kindOf(canvas) === 'coordinate' &&
  kindOf(tailwind) === 'flow' &&
  kindOf(canvas) === 'coordinate' &&
  kindOf(tailwind) === 'flow');
{
  // Same content, different string object — the memo compares with ===, which
  // is a value comparison for strings, so this must hit and still be right.
  const copy = (canvas + ' ').slice(0, -1);
  assert('memo: an equal-but-separate string gets the same verdict',
    kindOf(copy) === 'coordinate');
}

// ═══════════════════════════════════════════════════════════════════════════
// describePrepOutcome — what the user is actually told
// ═══════════════════════════════════════════════════════════════════════════

const patchOutcome = L.describePrepOutcome(L.analyzePageLayout(tailwind), 0);
assert('a patched page is told nothing was changed',
  patchOutcome.strategy === 'patch' && /nothing about it was changed/i.test(patchOutcome.message));
assert('and it is not warned about restructuring it cannot do',
  !/needs rebuilding/i.test(patchOutcome.message));

const droppedOutcome = L.describePrepOutcome(L.analyzePageLayout(tailwind), 3);
assert('dropped empty wrappers are mentioned rather than hidden',
  /empty wrapper blocks were skipped/i.test(droppedOutcome.message));

const rebuildOutcome = L.describePrepOutcome(L.analyzePageLayout(canvas), 0);
assert('a coordinate page is told restructuring will not work',
  rebuildOutcome.strategy === 'rebuild' && /needs rebuilding/i.test(rebuildOutcome.message));
assert('and is given the reason, not just the verdict',
  /coordinates/i.test(rebuildOutcome.message));

// This message is the first thing the user sees on page load, before they have
// typed anything. The version that shipped first explained the whole diagnosis
// — container height, positioned-element count, what was and was not editable —
// and read as an eight-line wall of text. These two guards exist so it cannot
// grow back into one: it has to ask a question, and it has to stay short.
assert('the rebuild message ASKS rather than lectures',
  rebuildOutcome.message.includes('?'));
assert('and stays short enough to read on page load',
  rebuildOutcome.message.length <= 280);
assert('the raw measurements stay out of the chat',
  !/\d+px/.test(rebuildOutcome.message) && !/\d+ of (its|the)/.test(rebuildOutcome.message));
assert('the patch message stays short too', patchOutcome.message.length <= 280);
assert('neither message is a multi-paragraph dump',
  !patchOutcome.message.includes('\n') && !rebuildOutcome.message.includes('\n'));
assert('neither message ever claims we rebuilt the page ourselves',
  !/we rebuilt|has been rebuilt|was rebuilt/i.test(patchOutcome.message + rebuildOutcome.message));

// ═══════════════════════════════════════════════════════════════════════════

rmSync(outDir, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll layout checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

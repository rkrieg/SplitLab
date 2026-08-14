/**
 * Real behavior tests for src/lib/ai-sl-markers.ts.
 *
 * The bug this guards, from a real session: a generated page had 11 top-level
 * blocks and 5 markers. The user asked to remove two skills. The skills sit in
 * an unmarked block, so the rewrite was handed a page WITHOUT them and asked to
 * remove them — it returned "nothing to change", and the product answered
 * "I couldn't work out what to change. Name the section." No wording could ever
 * have worked, and the same page had already been through several turns of the
 * user retrying.
 *
 * template.html at the repo root is that exact page, saved from the download
 * button, so the headline assertions here run against the real thing rather
 * than a fixture written to pass.
 *
 * Run: node scripts/verify-sl-markers.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-markers');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-sl-markers.ts');

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
const M = require(join(outDir, 'ai-sl-markers.js'));

let failed = 0;
function assert(name, cond) {
  if (cond) console.log(`OK: ${name}`);
  else { console.error(`FAIL: ${name}`); failed++; }
}

const countMarkers = (html, name) =>
  (html.match(new RegExp(`<!-- SL:${name} -->`, 'g')) || []).length;

const strip = (h) =>
  h.replace(/<!--\s*\/?SL:[a-zA-Z0-9_-]+\s*-->\n?/g, '').replace(/\s+/g, ' ').trim();

// ═══════════════════════════════════════════════════════════════════════════
// The real page
// ═══════════════════════════════════════════════════════════════════════════

const templatePath = join(repoRoot, 'template.html');
if (existsSync(templatePath)) {
  const real = readFileSync(templatePath, 'utf8');

  // What shipped: 5 of 11 blocks addressable.
  const before = M.markerCoverage(real);
  assert('the real page is measurably short on markers',
    before.blocks === 11 && before.marked === 5);
  assert('and the missing blocks are named, not just counted',
    ['hero', 'stats', 'marquee', 'process', 'gallery', 'cta-banner']
      .every((n) => before.unmarked.includes(n)));

  const fixed = M.repairSlMarkers(real, null);

  // The one that mattered: "remove 2 skills" lives here.
  assert('the skills/experience block becomes addressable',
    /<!-- SL:process -->[\s\S]*Experience &amp; Skills[\s\S]*Associate Software Engineer[\s\S]*<!-- \/SL:process -->/
      .test(fixed.html));
  assert('every unmarked block on the real page is wrapped',
    ['hero', 'stats', 'marquee', 'process', 'gallery', 'cta-banner']
      .every((n) => fixed.repaired.includes(n)));
  assert('the whole page is now addressable',
    M.markerCoverage(fixed.html).unmarked.length === 0);

  // Names must be stable and meaningful, not tag names or invented ones.
  assert('blocks are named after what they already call themselves',
    countMarkers(fixed.html, 'hero') === 1 &&
    countMarkers(fixed.html, 'process') === 1 &&
    countMarkers(fixed.html, 'cta-banner') === 1);

  // Existing markers are load-bearing: the schema and the conversation history
  // both refer to sections by name, so renaming one breaks every reference.
  assert('the 5 blocks that already had markers are untouched',
    ['nav', 'features', 'sections', 'contact', 'footer'].every(
      (n) => countMarkers(fixed.html, n) === 1 && !fixed.repaired.includes(n)));

  // Nothing may move, vanish, or be duplicated.
  assert('the real page is byte-identical once markers are stripped from both',
    strip(fixed.html) === strip(real));
  assert('the trailing script and tracker placeholder are not wrapped',
    !/<!-- SL:[a-z-]+ -->\s*<script>/.test(fixed.html) &&
    fixed.html.includes('<!-- TRACKER_PLACEHOLDER -->'));
  assert('the <head> styles are untouched',
    fixed.html.includes('--accent: #4DFFAF;'));

  // Running it again must be a no-op, or an edit would re-wrap on every turn.
  const again = M.repairSlMarkers(fixed.html, null);
  assert('a second pass over a fixed page changes nothing',
    again.html === fixed.html && again.repaired.length === 0);
} else {
  console.log('SKIP: template.html not present — real-page checks not run');
}

// ═══════════════════════════════════════════════════════════════════════════
// Structure the walker has to handle
// ═══════════════════════════════════════════════════════════════════════════

// Not every page is flat. Webflow/Bootstrap output wraps everything in a div,
// and marking that ONE div would make the entire page a single section.
const wrapped = `<body><div class="page-wrapper">
<section class="hero"><h1>Something long enough to count here</h1></section>
<section class="pricing"><h2>Another block with real content inside</h2></section>
</div></body>`;
const w = M.repairSlMarkers(wrapped, null);
assert('a single wrapper div is descended through, not marked',
  w.repaired.includes('hero') && w.repaired.includes('pricing') &&
  !w.repaired.includes('page-wrapper'));

// Blocks need not be <section> — plenty of pages use divs.
const divs = `<body>
<div class="hero-area"><h1>A headline with enough characters</h1></div>
<div class="cta-area"><h2>A second block with enough characters</h2></div>
</body>`;
const d = M.repairSlMarkers(divs, null);
assert('top-level divs are treated as blocks',
  d.repaired.includes('hero-area') && d.repaired.includes('cta-area'));

// Two blocks sharing a class must not produce two identical marker names —
// every later pass looks sections up BY NAME.
const dupes = `<body>
<section class="feature"><h2>The first feature block right here</h2></section>
<section class="feature"><h2>The second feature block right here</h2></section>
</body>`;
const dup = M.repairSlMarkers(dupes, null);
assert('duplicate class names are made unique',
  dup.repaired.length === 2 && new Set(dup.repaired).size === 2);

// A new name must never collide with a marker already on the page.
const collide = M.repairSlMarkers(
  `<body><!-- SL:hero --><section class="x">already marked and addressable</section><!-- /SL:hero -->
<section class="hero"><h1>An unmarked block calling itself hero</h1></section></body>`,
  null,
);
assert('a new block cannot steal an existing marker name',
  countMarkers(collide.html, 'hero') === 1 && !collide.repaired.includes('hero'));

// Wrapping a spacer adds a section nobody will ever mean.
const tiny = M.repairSlMarkers(`<body><div class="sp"></div><section class="real"><h1>Real content lives in this block</h1></section></body>`, null);
assert('trivial nodes are not turned into sections',
  tiny.repaired.length === 1 && tiny.repaired[0] === 'real');

// ═══════════════════════════════════════════════════════════════════════════
// Uploaded HTML is whatever the customer had
// ═══════════════════════════════════════════════════════════════════════════
//
// These are not hypotheticals. The upload path asks a model to list the page's
// blocks and skips any it cannot match ("section not matched, skipping"), so a
// page it reads badly comes out part-marked — the same broken state as a
// generated page, reached a different way. The structural pass now runs on its
// output too, which only helps if it survives real-world markup.

// Minified: no newlines, no indentation, one enormous line.
const minified = `<!doctype html><html><body><div class="hdr"><h1>A headline that is long enough</h1></div><div class="bd"><p>Body copy that is also long enough to count</p></div></body></html>`;
const min = M.repairSlMarkers(minified, null);
assert('minified single-line HTML still resolves into blocks',
  min.repaired.includes('hdr') && min.repaired.includes('bd'));
assert('and minified content survives byte-for-byte',
  strip(min.html) === strip(minified));

// Email/legacy layout: the whole page is tables.
const tables = `<body><table class="head"><tr><td>A masthead cell with real content</td></tr></table>
<table class="body"><tr><td>A body cell with real content in it</td></tr></table></body>`;
const tbl = M.repairSlMarkers(tables, null);
assert('a table-based layout is addressable, not skipped',
  tbl.repaired.includes('head') && tbl.repaired.includes('body'));

// Div soup with no classes or ids to name anything from.
const soup = `<body><div><h1>The first block of this page here</h1></div>
<div><h2>The second block of this page here</h2></div></body>`;
const sp = M.repairSlMarkers(soup, null);
assert('nameless divs still become addressable, with unique names',
  sp.repaired.length === 2 && new Set(sp.repaired).size === 2);

// Nested wrappers — Webflow/Bootstrap habitually stack two or three.
const nested = `<body><div class="page"><div class="main-wrap">
<section class="hero"><h1>A headline that is long enough here</h1></section>
<section class="feat"><h2>A second block that is long enough</h2></section>
</div></div></body>`;
const nst = M.repairSlMarkers(nested, null);
assert('stacked wrappers are descended through to the real blocks',
  nst.repaired.includes('hero') && nst.repaired.includes('feat') &&
  !nst.repaired.includes('page') && !nst.repaired.includes('main-wrap'));

// A fragment with no <html>/<body> at all.
const fragment = `<div class="a">The first fragment block right here</div>
<div class="b">The second fragment block right here</div>`;
const frg = M.repairSlMarkers(fragment, null);
assert('a fragment with no <body> is handled',
  frg.repaired.includes('a') && frg.repaired.includes('b'));

// Upload path already marked some blocks, model missed the rest — the exact
// half-done state that "section not matched, skipping" produces.
const halfDone = `<body><!-- SL:hero --><section class="hero"><h1>Already matched by the model</h1></section><!-- /SL:hero -->
<section class="pricing"><h2>The model never listed this one at all</h2></section></body>`;
const half = M.repairSlMarkers(halfDone, null);
assert('blocks the upload path skipped get picked up',
  half.repaired.length === 1 && half.repaired[0] === 'pricing' &&
  countMarkers(half.html, 'hero') === 1);

// Unreadable is not the same as covered. A page whose blocks we cannot see at
// all must report zero, not a clean bill of health.
const unreadable = M.markerCoverage('<body>just some bare text, no elements at all</body>');
assert('a page with no recognisable blocks reports zero, not "all covered"',
  unreadable.blocks === 0 && unreadable.marked === 0);

// Malformed markup must never produce a marker across the wrong span.
const broken = M.repairSlMarkers(
  `<body><section class="a"><div>unclosed div and unclosed section here`, null);
assert('unbalanced markup yields no marker rather than a wrong one',
  broken.repaired.length === 0 && !broken.html.includes('<!-- SL:'));

// ═══════════════════════════════════════════════════════════════════════════
// Schema fallback — for pages the structural walk cannot read
// ═══════════════════════════════════════════════════════════════════════════

const page = `<!doctype html><html><head><style>.x{color:red}</style></head><body>
<!-- SL:nav --><nav><a href="/">Home</a></nav><!-- /SL:nav -->
<section class="about-wrap"><h2>I've been Crafting and Coding Since 2021</h2><img src="https://cdn.site.com/me.png"/><p>Software Engineer</p></section>
<!-- SL:footer --><footer><p>Privacy Policy</p></footer><!-- /SL:footer -->
</body></html>`;

const schema = {
  nav: { link: 'Home' },
  about: { headline: "I've been Crafting and Coding Since 2021", role: 'Software Engineer' },
  footer: { legal: 'Privacy Policy' },
};

const r = M.repairSlMarkers(page, schema);
assert('an unmarked section gets markers, and only one set',
  countMarkers(r.html, 'nav') === 1 && countMarkers(r.html, 'footer') === 1 &&
  r.repaired.length === 1);
assert('sections that already had markers are left alone',
  !r.repaired.includes('nav') && !r.repaired.includes('footer'));
assert('the whole section element is wrapped, image included',
  /<!-- SL:[a-z-]+ -->[\s\S]*cdn\.site\.com\/me\.png[\s\S]*<!-- \/SL:[a-z-]+ -->/.test(r.html));
assert('the page content is unchanged once markers are removed from both',
  strip(r.html) === strip(page));

// The bug that made the schema pass useless on the real page. It searched the
// raw HTML for the raw schema string, and both differ from what is rendered:
// the schema holds "web, app & AI" where the markup holds "web, app &amp; AI",
// and a headline stored as one string is written split across <br> and <span>.
// Every anchor missed, so the pass repaired nothing and said nothing about why.
const markup = `<h1>Experienced<br>Web, App &amp;<br><span class="a">AI Developer</span></h1>
<p>Helping businesses worldwide with custom, high-quality web, app &amp; AI services.</p>`;

const subhead = 'Helping businesses worldwide with custom, high-quality web, app & AI services.';
assert('the old raw search really did fail on &amp; — this test means something',
  markup.indexOf(subhead) === -1);
assert('an anchor matches across &amp;',
  M.locateSchemaText(markup, subhead) >= 0);
assert('an anchor matches across inline <br> and <span> tags',
  M.locateSchemaText(markup, 'Experienced Web, App & AI Developer') >= 0);
assert('the offset points at the text, not at the top of the document',
  M.locateSchemaText(markup, subhead) === markup.indexOf('Helping'));
assert('text that is not on the page is still not found',
  M.locateSchemaText(markup, 'a phrase that appears nowhere here') === -1);
assert('script and style contents are not searchable text',
  M.locateSchemaText('<style>.hero{content:"the quick brown fox jumps"}</style>',
    'the quick brown fox jumps') === -1);

// One block gets one marker, and the structural pass goes first. Once it has
// named a block from its class, the schema pass must not nest a second name
// inside it — two markers around the same content is the corruption this whole
// file exists to prevent.
const named = M.repairSlMarkers(
  `<body><div class="odd"><h1>Web, App &amp; AI Developer</h1>
<p>Helping businesses worldwide with custom, high-quality web, app &amp; AI services.</p></div>
<div class="other">a second block, so there is no lone wrapper to descend</div></body>`,
  { hero: { subhead } },
);
assert('a block already wrapped by the structural pass is not wrapped again',
  named.repaired.includes('odd') && countMarkers(named.html, 'hero') === 0);
assert('and the schema name it could not place is reported, not silently dropped',
  named.skipped.includes('hero'));

// The other half of that trade: when the structural pass deliberately skips a
// lone wrapper, the schema pass is what makes it addressable — and it gets the
// schema's own name for it, which is the name the rest of the system uses.
const lone = M.repairSlMarkers(
  `<body><div class="page-wrap"><h1>Web, App &amp; AI Developer</h1>
<p>Helping businesses worldwide with custom, high-quality web, app &amp; AI services.</p></div></body>`,
  { hero: { subhead } },
);
assert('a lone wrapper the structural pass skipped is named by the schema',
  lone.repaired.length === 1 && lone.repaired[0] === 'hero' &&
  lone.skipped.length === 0);

// Fields sitting at the schema's top level are not sections.
const scalars = M.repairSlMarkers(page, {
  ...schema,
  brand_logo_url: 'https://cdn.site.com/logo-file-name.png',
  vertical: 'software engineering services',
});
assert('scalar schema fields are not reported as unplaceable sections',
  !scalars.skipped.includes('brand_logo_url') && !scalars.skipped.includes('vertical'));

// A marker in the wrong place is worse than none — it lets a later edit rewrite
// a part of the page nobody named.
const drifted = M.repairSlMarkers(page, {
  ...schema,
  pricing: { headline: 'Nothing on this page says anything like this at all' },
});
assert('a section that cannot be located is skipped, not guessed at',
  drifted.skipped.includes('pricing') && !drifted.repaired.includes('pricing'));

const shortOnly = M.repairSlMarkers(page, { mystery: { label: 'Home' } });
assert('a too-short value is not treated as an anchor',
  shortOnly.skipped.includes('mystery'));

// ═══════════════════════════════════════════════════════════════════════════
// Garbage in, page out
// ═══════════════════════════════════════════════════════════════════════════

const clean = `<body><!-- SL:hero --><section><h1>Hello there friends of mine</h1></section><!-- /SL:hero --></body>`;
const noop = M.repairSlMarkers(clean, { hero: { headline: 'Hello there friends of mine' } });
assert('a page needing no repair comes back unchanged',
  noop.html === clean && noop.repaired.length === 0);

assert('empty html is not a crash', M.repairSlMarkers('', schema).html === '');
assert('no schema still runs the structural pass',
  M.repairSlMarkers(page, null).repaired.length === 1);
assert('unbalanced markup does not throw',
  typeof M.repairSlMarkers('<body><section><div>oh dear this is broken', null).html === 'string');

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll SL-marker repair checks passed.');

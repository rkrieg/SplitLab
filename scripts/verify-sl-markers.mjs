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

// ═══════════════════════════════════════════════════════════════════════════
// markerQuality — are the boxes any good, not just present?
//
// The bug: an Unbounce upload passed markerCoverage cleanly and was still
// unusable. 19 of its 22 boxes were empty wrapper divs (~188 bytes each), one
// held the entire 171KB page, and one was the stylesheet. The router was then
// offered a box called "hero" that had nothing in it, picked it (the only box
// whose NAME matched "redesign the hero"), and a brand new hero was written into
// an empty div and stacked on top of the real page.
// ═══════════════════════════════════════════════════════════════════════════

const box = (name, inner) => `<!-- SL:${name} -->\n${inner}\n<!-- /SL:${name} -->`;
// Markers removed and whitespace BETWEEN TAGS normalized. Dropping a marker
// pair takes the newline it was written with; `strip` above only takes trailing
// newlines, so the two disagree by one space where markers were nested.
const bones = (h) => strip(h).replace(/>\s+</g, '><');

const goodMap = `<body>
${box('nav', '<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>')}
${box('hero', '<section><h1>Grow your business faster</h1><p>Real copy here.</p></section>')}
${box('features', '<section><h2>What you get</h2><p>Three good reasons.</p></section>')}
${box('footer', '<footer><p>© 2026 Some Company Ltd</p></footer>')}
</body>`;
const good = M.markerQuality(goodMap);
assert('a page with four real boxes reads as ok', good.ok, JSON.stringify(good.empty));
assert('and none of them is empty', good.empty.length === 0);
assert('and none of them is hogging the page', good.dominant === null);
// The false positive that a 15-character threshold produced: a real nav bar
// ("Home", "Pricing") called empty, which would have dropped the markers off the
// section users ask about most.
assert('a nav bar with two short links is not an empty box',
  !good.empty.includes('nav'));
assert('a box holding nothing but whitespace and entities IS empty',
  M.markerQuality(`<body>${box('pad', '<div>&nbsp; &nbsp;</div>')}${box('r', '<section><h1>Real headline here</h1></section>')}</body>`)
    .empty.includes('pad'));

// The real shape: empty wrapper boxes plus one box holding everything.
const decoyMap = `<body>
${box('head', '<style>body{color:#000}</style>')}
${box('lp-positioned-content', '<div class="lp-positioned-content">' +
  '<h1>Investors across the country are earning monthly income</h1>' +
  '<p>' + 'Long real page copy. '.repeat(60) + '</p>' +
  '<img src="/hero.jpg"><img src="/proof.jpg"><iframe src="/video"></iframe></div>')}
${box('hero', '<div class="lp-element lp-pom-block" id="lp-pom-block-622"><div id="lp-pom-block-622-color-overlay"></div><div class="lp-pom-block-content"></div></div>')}
${box('stats', '<div class="lp-element lp-pom-block" id="lp-pom-block-379"><div class="lp-pom-block-content"></div></div>')}
${box('footer', '<div class="lp-element lp-pom-block" id="lp-pom-block-400"><div class="lp-pom-block-content"></div></div>')}
</body>`;
const decoy = M.markerQuality(decoyMap);
assert('empty wrapper boxes are found', decoy.empty.length === 3 &&
  ['hero', 'stats', 'footer'].every((n) => decoy.empty.includes(n)), JSON.stringify(decoy.empty));
assert('the box holding the whole page is found',
  decoy.dominant !== null && decoy.dominant.name === 'lp-positioned-content',
  JSON.stringify(decoy.dominant));
assert('so the map is reported as bad', !decoy.ok);
assert('and the stylesheet box is never called empty', !decoy.empty.includes('head'));
assert('nor counted when judging what hogs the page',
  !decoy.boxes.find((b) => b.name === 'head')?.empty);

// A box holding only a script, or only a comment, is empty.
const scriptBox = `<body>${box('a', '<div><script>var x = 1;</script></div>')}${box('b', '<section><h1>Real content in here</h1></section>')}${box('c', '<div><!-- placeholder --></div>')}</body>`;
const scriptQ = M.markerQuality(scriptBox);
assert('a box holding only a <script> is empty', scriptQ.empty.includes('a'));
assert('a box holding only a comment is empty', scriptQ.empty.includes('c'));
assert('a box with real content is not', !scriptQ.empty.includes('b'));

// Content that is not text still counts as content.
const mediaBoxes = `<body>
${box('logo-strip', '<div><img src="/a.png"><img src="/b.png"></div>')}
${box('band', '<div style="background-image:url(/photo.jpg)"></div>')}
${box('embed', '<div><iframe src="https://player.example/1"></iframe></div>')}
${box('form', '<form><input name="email"><textarea name="msg"></textarea></form>')}
</body>`;
const media = M.markerQuality(mediaBoxes);
assert('images, CSS backgrounds, iframes and form fields all count as content',
  media.empty.length === 0, JSON.stringify(media.empty));

// One- and two-box pages have nothing to spread content across.
const oneBox = `<body>${box('page', '<section><h1>A single-block fragment</h1><p>' + 'copy '.repeat(50) + '</p></section>')}</body>`;
assert('a one-box page is not accused of hogging itself', M.markerQuality(oneBox).ok);
assert('a page with no markers at all is ok, not broken',
  M.markerQuality('<body><section><h1>No markers here</h1></section></body>').ok);
assert('empty html is ok', M.markerQuality('').ok);

// Nested boxes: only the outer ones are offered to the router, but an empty box
// hidden one level down still has to be found.
const nestedBoxes = `<body>
${box('outer', '<section><h1>Outer section with real copy in it</h1>' + box('inner-empty', '<div></div>') + '</section>')}
${box('two', '<section><h2>Second real section</h2><p>More copy.</p></section>')}
${box('three', '<section><h2>Third real section</h2><p>More copy.</p></section>')}
</body>`;
const nest = M.markerQuality(nestedBoxes);
assert('an empty box nested inside a real one is still found', nest.empty.includes('inner-empty'));
assert('and the nesting is recorded', nest.boxes.find((b) => b.name === 'inner-empty')?.nested === true);
assert('while the outer box is not marked nested', nest.boxes.find((b) => b.name === 'outer')?.nested === false);

// ═══════════════════════════════════════════════════════════════════════════
// dropEmptySectionMarkers — remove the decoys, change nothing else
// ═══════════════════════════════════════════════════════════════════════════

const dropped = M.dropEmptySectionMarkers(decoyMap);
assert('the three empty boxes lose their markers', dropped.dropped.length === 3);
assert('and are really gone from the html',
  countMarkers(dropped.html, 'hero') === 0 &&
  countMarkers(dropped.html, 'stats') === 0 &&
  countMarkers(dropped.html, 'footer') === 0);
assert('the boxes that hold something keep theirs',
  countMarkers(dropped.html, 'lp-positioned-content') === 1 && countMarkers(dropped.html, 'head') === 1);
assert('no half-pairs are left behind',
  (dropped.html.match(/<!-- SL:/g) || []).length === (dropped.html.match(/<!-- \/SL:/g) || []).length);
assert('the PAGE itself is untouched — same markup, byte for byte', bones(dropped.html) === bones(decoyMap));
assert('and the empty divs are still on the page, just not addressable',
  dropped.html.includes('id="lp-pom-block-622"') && dropped.html.includes('id="lp-pom-block-379"'));
assert('running it again is a no-op', M.dropEmptySectionMarkers(dropped.html).dropped.length === 0);
assert('what is left reads as having no empty boxes', M.markerQuality(dropped.html).empty.length === 0);

// The one thing it must never do: leave a page with nothing to edit.
const allEmpty = `<body>${box('a', '<div></div>')}${box('b', '<div></div>')}</body>`;
const allE = M.dropEmptySectionMarkers(allEmpty);
assert('a page whose every box is empty is left alone',
  allE.dropped.length === 0 && allE.html === allEmpty);
const onlyCss = `<body>${box('head', '<style>body{color:#000}</style>')}${box('a', '<div></div>')}</body>`;
const onlyC = M.dropEmptySectionMarkers(onlyCss);
assert('and so is one where only the stylesheet box would survive',
  onlyC.dropped.length === 0 && onlyC.html === onlyCss);

// Two empty boxes nested in each other — the case that breaks any
// one-at-a-time rewrite, since editing the inner one shifts the outer's offsets.
const nestedEmpty = `<body>${box('outer-empty', '<div>' + box('inner-empty', '<div></div>') + '</div>')}${box('real', '<section><h1>Something real to keep</h1></section>')}</body>`;
const nestE = M.dropEmptySectionMarkers(nestedEmpty);
assert('nested empty boxes are both dropped in one pass', nestE.dropped.length === 2);
assert('and the result has no stray markers',
  !/SL:outer-empty/.test(nestE.html) && !/SL:inner-empty/.test(nestE.html) &&
  countMarkers(nestE.html, 'real') === 1);
assert('and the page survives it', bones(nestE.html) === bones(nestedEmpty));

// Minified input gets markers with no newlines — cutting must not eat markup.
const minifiedBoxes = `<body><!-- SL:e --><div class="lp-pom-block"></div><!-- /SL:e --><!-- SL:r --><section><h1>Real headline right here</h1></section><!-- /SL:r --></body>`;
const minD = M.dropEmptySectionMarkers(minifiedBoxes);
assert('a minified page drops its empty box cleanly',
  minD.dropped.length === 1 && bones(minD.html) === bones(minifiedBoxes) &&
  minD.html.includes('<div class="lp-pom-block"></div>'));

assert('empty html does not throw', M.dropEmptySectionMarkers('').html === '');
assert('an unclosed marker is skipped, not guessed at',
  M.dropEmptySectionMarkers('<body><!-- SL:x --><div></div></body>').dropped.length === 0);

// Both of these run on every prepare, build and follow-up edit, on pages up to
// half a megabyte — so they are timed, not just checked.
{
  const many = `<body>${Array.from({ length: 300 }, (_, i) =>
    box(`s${i}`, `<section><h2>Section ${i}</h2><p>${'body copy '.repeat(40)}</p></section>`),
  ).join('\n')}</body>`;
  let t = Date.now();
  const q = M.markerQuality(many);
  const qms = Date.now() - t;
  assert(`300 boxes on a ${(many.length / 1024) | 0}KB page measured in under 1500ms`, qms < 1500);
  assert('and all 300 read as real content', q.empty.length === 0 && q.ok);

  t = Date.now();
  M.dropEmptySectionMarkers(many);
  assert('dropping empties on the same page is under 1500ms', Date.now() - t < 1500);

  // A long declaration that never reaches url() is the shape that makes a
  // background-image scan backtrack.
  const nastyBg = `<body>${box('a', `<div style="background:${'linear-gradient(red,blue),'.repeat(4000)}none"></div>`)}${box('b', '<section><h1>Real content here</h1></section>')}</body>`;
  t = Date.now();
  M.markerQuality(nastyBg);
  assert('a 100KB background declaration with no url() is under 1500ms', Date.now() - t < 1500);
}

// A page we built ourselves must come out of both untouched.
if (existsSync(templatePath)) {
  const ours = readFileSync(templatePath, 'utf8');
  const repaired = M.repairSlMarkers(ours, null).html;
  const q = M.markerQuality(repaired);
  assert('our own repaired page has no empty boxes', q.empty.length === 0, JSON.stringify(q.empty));
  assert('and no box hogging it', q.dominant === null, JSON.stringify(q.dominant));
  assert('so dropping empties is a no-op on it',
    M.dropEmptySectionMarkers(repaired).html === repaired);
}

// ── The repair pass must never damage the page it is repairing ─────────────
// A real page carried its markers in triplicate from earlier saves. Pairing
// each opener with the next matching closer produced overlapping spans, and
// cutting them back-to-front used an offset that the previous cut had already
// moved — so six characters of a live element were eaten and
// `<section class="ue-testimonials-section">` came out as
// `<!-- SLon class="ue-testimonials-section">`. Marker repair corrupting a
// customer's markup is worse than any nesting it was there to fix.
{
  const dup = [
    '<!doctype html><html><head></head><body>',
    '<!-- SL:hero -->',
    '<section class="a"><h1>First hero with plenty of words in it</h1></section>',
    '<!-- SL:hero -->',
    '<section class="b"><h1>Second hero, also carrying real copy</h1></section>',
    '<!-- /SL:hero -->',
    '<section class="testimonials"><p>Quoted words from a customer we must not lose.</p></section>',
    '<!-- /SL:hero -->',
    '<footer class="f"><p>Footer copy that must survive the repair pass.</p></footer>',
    '</body></html>',
  ].join('\n');

  const out = M.repairSlMarkers(dup, null).html;
  const strip = (s) => s.replace(/<!--\s*\/?SL:[a-zA-Z0-9_-]+\s*-->/g, '').replace(/\s+/g, ' ').trim();
  assert('duplicate marker names never corrupt the markup',
    !/<!--\s*SL[a-z]/.test(out), out.slice(0, 200));
  assert('and no page content is lost to the repair',
    strip(out) === strip(dup));
  assert('the testimonials element survives intact',
    out.includes('<section class="testimonials">'));
  assert('the footer element survives intact',
    out.includes('<footer class="f">'));
}

// ── A container among marked siblings is not a section ─────────────────────
// The shape that broke a freshly built page. Because nav and footer are marked
// at body level, the search for "where the blocks live" stops there — and the
// unmarked <main> beside them then reads as one more block and gets wrapped,
// burying the two real sections inside it. Sections are read outermost-first,
// so hero and contact stopped existing: the page reported three sections
// instead of five, and an image swap aimed at the hero was generated, spliced,
// then discarded because it could not be found on the way back out.
//
// The same page WITHOUT the marked siblings passed, which is why this went out.
// The siblings are the whole test.
{
  const S = (n, inner) => `<!-- SL:${n} -->\n${inner}\n<!-- /SL:${n} -->`;
  const page = [
    '<!doctype html><html><head><!-- SL:head --><style>.hero{color:#111}</style><!-- /SL:head --></head><body>',
    S('nav', '<nav class="nav"><a href="#top">Austin Plumbing</a><a href="#contact">Get my quote</a></nav>'),
    '<main id="top">',
    S('hero', '<section class="hero"><h1>Need a plumber in Austin today?</h1><p>Tell us what is happening and we reply with a time and a price.</p></section>'),
    S('contact', '<section class="contact"><h2>Tell us about the job</h2><form><input name="name"><button>Get my quote</button></form></section>'),
    '</main>',
    S('footer', '<footer class="footer"><span>© 2025 Austin Plumbing. All rights reserved.</span></footer>'),
    '</body></html>',
  ].join('\n');

  const out = M.repairSlMarkers(page, null);
  const readable = [];
  const re = /<!-- SL:([a-zA-Z0-9_-]+) -->([\s\S]*?)<!-- \/SL:\1 -->/g;
  let mm;
  while ((mm = re.exec(out.html))) readable.push(mm[1]);

  assert('an unmarked container beside marked siblings is not wrapped',
    out.structural.length === 0, JSON.stringify(out.structural));
  assert('the sections inside it stay readable',
    readable.includes('hero') && readable.includes('contact'), readable.join(', '));
  assert('and so do the ones outside it',
    readable.includes('nav') && readable.includes('footer'), readable.join(', '));
  assert('no marker is left buried inside another',
    [...out.html.matchAll(/<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->/g)]
      .map((m) => m[1]).every((n) => readable.includes(n)));
}

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll SL-marker repair checks passed.');

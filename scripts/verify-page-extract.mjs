/**
 * Real behavior tests for src/lib/ai-page-extract.ts.
 *
 * What this guards: a coordinate-layout page cannot be edited by rewriting its
 * markup, so the only way to make it editable is to rebuild it — and a rebuild
 * that quietly loses a phone number, a price or a disclaimer is worse than no
 * rebuild at all. Every piece of content is therefore lifted out by code rather
 * than recalled by a model, and this file is what proves the lifting works.
 *
 * The two headline properties, in order of importance:
 *
 *   1. NOTHING IS INVENTED. Every string handed to the builder must be findable
 *      in the original page's own visible text. If this ever fails, the rebuild
 *      is putting words on a customer's page that were never there.
 *   2. NOTHING IS LOST. The headlines, paragraphs, CTA labels, links, images and
 *      video embeds a visitor can see must all come through.
 *
 * titan-template-original.html at the repo root is a real Unbounce export (a
 * 1326×5713px canvas, 156 absolutely-positioned elements, content in markup
 * order that has nothing to do with reading order). template.html is a page our
 * own builder made. Both are asserted against directly, so these are not
 * fixtures written to pass.
 *
 * Run: node scripts/verify-page-extract.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-extract');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

// Both files: ai-page-extract imports the stylesheet reader from ai-page-layout
// on purpose, so that "where does this element sit" is answered identically by
// the test that decides to rebuild and by the code that does the rebuilding.
execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(repoRoot, 'src', 'lib', 'ai-page-layout.ts'),
    join(repoRoot, 'src', 'lib', 'ai-page-extract.ts'),
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
const E = require(join(outDir, 'ai-page-extract.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

/**
 * The same normalisation the extractor uses — its own function, deliberately.
 *
 * An earlier version of this file rolled its own entity handling and reported a
 * real page string as "invented" because the extractor had decoded `&ndash;` to
 * an en dash and this had not. Two normalisations is the bug; one is the fix, and
 * the rebuild route's own survival check uses this same one.
 */
const visible = (html) => E.pageVisibleText(html).toLowerCase();

const allTexts = (page) => page.bands.flatMap((b) => b.texts.map((t) => t.text));

// ═══════════════════════════════════════════════════════════════════════════
// The real Unbounce export
// ═══════════════════════════════════════════════════════════════════════════

const titanPath = join(repoRoot, 'titan-template-original.html');
if (existsSync(titanPath)) {
  const titan = readFileSync(titanPath, 'utf8');
  const page = E.extractPageContent(titan);
  const texts = allTexts(page);
  const source = visible(titan);

  assert('the real coordinate page yields content', page.bands.length > 10 && texts.length > 100,
    `bands=${page.bands.length} texts=${texts.length}`);

  // ── Property 1: nothing invented ───────────────────────────────────────
  const invented = texts.filter((t) => !source.includes(visible(t).trim()));
  assert('every extracted string is really on the page — nothing invented',
    invented.length === 0,
    invented.slice(0, 3).map((t) => JSON.stringify(t.slice(0, 60))).join(' | '));

  // ── Property 2: nothing a visitor can see is lost ──────────────────────
  const mustSurvive = [
    'We Loan Your Money To Real Estate Builders',   // the headline
    '561-867-2424',                                  // the phone number
    'SEE MY MONTHLY INCOME',                         // the primary CTA
    'Titan Funding',                                 // the brand
  ];
  for (const needle of mustSurvive) {
    assert(`"${needle.slice(0, 42)}" survives extraction`,
      texts.some((t) => t.toLowerCase().includes(needle.toLowerCase())));
  }
  assert('the video embed is captured, not dropped',
    page.bands.some((b) => b.embeds.some((e) => /vimeo|youtube|player/i.test(e))),
    JSON.stringify(page.bands.flatMap((b) => b.embeds)));

  // ── Reading order, recovered from the stylesheet ────────────────────────
  const indexOfText = (needle) =>
    page.bands.findIndex((b) => b.texts.some((t) => t.text.toLowerCase().includes(needle.toLowerCase())));
  const heroAt = indexOfText('We Loan Your Money');
  const legalAt = indexOfText('informational purposes only');
  const contactAt = indexOfText('Contact Information');
  assert('the hero comes before the contact block', heroAt >= 0 && contactAt > heroAt,
    `hero=${heroAt} contact=${contactAt}`);
  assert('and the legal small print comes last-ish', legalAt > heroAt, `legal=${legalAt}`);
  assert('bands are ordered by screen position, not markup order',
    page.bands.every((b, i) => i === 0 || page.bands[i - 1].y <= b.y));

  // ── Images: real files, not lazy-load placeholders ──────────────────────
  const images = page.bands.flatMap((b) => b.images.map((i) => i.src));
  assert('images were found', images.length >= 5, `images=${images.length}`);
  assert('and none of them is a 1×1 lazy-load placeholder',
    images.every((s) => !(s.startsWith('data:') && s.length < 300)),
    images.filter((s) => s.startsWith('data:')).slice(0, 2).join(' '));
  assert('the real image URLs were recovered from the data-* attributes',
    images.some((s) => /^https?:\/\//.test(s)));
  assert('a logo was identified and it is a real file',
    !!page.logoUrl && /^https?:\/\//.test(page.logoUrl), String(page.logoUrl).slice(0, 80));

  // ── Breakpoint duplicates ──────────────────────────────────────────────
  // Unbounce ships every headline twice, hiding one copy per media query.
  for (const band of page.bands) {
    const seen = new Set();
    for (const t of band.texts) {
      const key = t.text.toLowerCase();
      if (seen.has(key)) {
        assert(`no repeated text inside one band (${band.name})`, false, JSON.stringify(t.text.slice(0, 50)));
        break;
      }
      seen.add(key);
    }
  }
  assert('no band repeats the same words twice', true);

  // ── Style ──────────────────────────────────────────────────────────────
  assert('the page background was read', !!page.colors.background, String(page.colors.background));
  assert('brand colours were read', page.colors.accents.length >= 2, JSON.stringify(page.colors.accents));
  assert('real font families were read', page.fonts.length >= 1, JSON.stringify(page.fonts));
  assert('and none of them is a CSS variable rather than a typeface',
    page.fonts.every((f) => !/^var\(/i.test(f)), JSON.stringify(page.fonts));

  // ── The schema handed to the builder ───────────────────────────────────
  const schema = E.extractedPageToSchema(page);
  assert('the schema has a hero and sections',
    !!schema.hero && Array.isArray(schema.sections) && schema.sections.length > 5,
    `sections=${schema.sections?.length}`);
  assert('the hero headline is real page copy, not the browser title',
    typeof schema.hero.headline === 'string' &&
    schema.hero.headline.length > 5 &&
    source.includes(visible(schema.hero.headline).trim()));
  assert('the logo is on the schema for nav/footer use', !!schema.brand_logo_url);
  assert('every section carries something', schema.sections.every((s) =>
    s.headline || s.body || s.items || s.image || s.embed_url || s.cta_text));

  // The two "what goes in the prompt" helpers this used to cover — contentDumpFrom
  // and styleTokensFrom — are gone. Nothing describes an uploaded page to a model
  // any more; the rebuild copies values out of the page's own stylesheet instead.
  // See the note where they used to live in ai-page-extract.ts, and
  // scripts/verify-page-transpile.mjs for what replaced them.

  // ── The survival check ─────────────────────────────────────────────────
  const required = E.requiredContentOf(page);
  assert('required content skips strings too short to prove anything',
    required.texts.every((t) => t.length >= 12));
  const selfCheck = E.contentSurvival(titan, required);
  assert('checked against the ORIGINAL page, everything survives',
    selfCheck.textsFound === selfCheck.textsTotal,
    `${selfCheck.textsFound}/${selfCheck.textsTotal} missing e.g. ${JSON.stringify(selfCheck.missingTexts.slice(0, 2))}`);
  assert('and its images and embeds are found there too',
    selfCheck.missingImages.length === 0 && selfCheck.missingEmbeds.length === 0);
  const emptyCheck = E.contentSurvival('<html><body><p>nothing here</p></body></html>', required);
  assert('checked against a page that has none of it, nothing survives',
    emptyCheck.textsFound === 0 && emptyCheck.missingImages.length === required.images.length);
} else {
  console.log('SKIP: titan-template-original.html not at repo root');
}

// ═══════════════════════════════════════════════════════════════════════════
// A page our own builder made — the flow-layout case
// ═══════════════════════════════════════════════════════════════════════════

const templatePath = join(repoRoot, 'template.html');
if (existsSync(templatePath)) {
  const ours = readFileSync(templatePath, 'utf8');
  const page = E.extractPageContent(ours);
  const source = visible(ours);

  const invented = allTexts(page).filter((t) => !source.includes(visible(t).trim()));
  assert('flow page: nothing invented', invented.length === 0,
    invented.slice(0, 3).map((t) => JSON.stringify(t.slice(0, 50))).join(' | '));

  // A flow page's bands must be its own top-level blocks, in document order —
  // not split, not merged. Every y is 0 here, and an earlier version merged every
  // section on the page into one because of it.
  assert('flow page: one band per top-level block', page.bands.length >= 9 && page.bands.length <= 13,
    `bands=${page.bands.length}`);
  assert('flow page: bands are named after the page\'s own sections',
    ['hero', 'features', 'gallery'].every((n) => page.bands.some((b) => b.name.startsWith(n))),
    page.bands.map((b) => b.name).join(', '));
  assert('flow page: document order is preserved',
    page.bands.every((b) => b.y === 0));
  const heroIdx = page.bands.findIndex((b) => b.name.startsWith('hero'));
  const footIdx = page.bands.findIndex((b) => /footer/.test(b.name));
  assert('flow page: hero before footer', heroIdx >= 0 && footIdx > heroIdx, `hero=${heroIdx} footer=${footIdx}`);
} else {
  console.log('SKIP: template.html not at repo root');
}

// ═══════════════════════════════════════════════════════════════════════════
// The behaviours that make a coordinate page readable at all
// ═══════════════════════════════════════════════════════════════════════════

// Markup order deliberately reversed against screen order — the footer is
// written first and the hero last. Only the stylesheet says which is which.
const scrambled = `<html><head><style>
#root { height: 4000px; }
#foot { position: absolute; left: 0; top: 3200px; }
#mid  { position: absolute; left: 0; top: 1600px; }
#hero { position: absolute; left: 0; top: 100px; }
</style></head><body><div id="root">
<div id="foot"><p>Copyright notice at the bottom of the page</p></div>
<div id="mid"><h2>The middle section of this page</h2></div>
<div id="hero"><h1>The headline at the top of the page</h1></div>
</div></body></html>`;
{
  const p = E.extractPageContent(scrambled);
  const order = p.bands.flatMap((b) => b.texts.map((t) => t.text));
  assert('reading order is recovered from the stylesheet, not the markup',
    order[0].includes('headline at the top') && order[order.length - 1].includes('bottom of the page'),
    JSON.stringify(order));
}

// The same content twice, one copy hidden per breakpoint.
const breakpoints = `<html><head><style>
.desktop { display: block; }
.mobile  { display: none; }
</style></head><body>
<section><div class="desktop"><h1>Grow your business ten times faster</h1></div>
<div class="mobile"><h1>Grow your business ten times faster</h1></div></section>
<section><div class="mobile"><p>Mobile-only paragraph that is hidden here</p></div></section>
</body></html>`;
{
  const p = E.extractPageContent(breakpoints);
  const texts = allTexts(p);
  assert('a headline shipped twice for two breakpoints is extracted once',
    texts.filter((t) => t.includes('ten times faster')).length === 1, JSON.stringify(texts));
  assert('and content hidden by display:none is not read at all',
    !texts.some((t) => t.includes('Mobile-only')), JSON.stringify(texts));
}

// Lazy-loading: the real file is in a data-* attribute nobody can predict.
const lazy = `<html><body><section>
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
     data-src-desktop-1x="https://cdn.example.com/real-photo.png"
     data-src-mobile-1x="https://cdn.example.com/real-photo-small.png" alt="A photo">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
     data-lazy-src="https://cdn.example.com/second.jpg">
<img srcset="https://cdn.example.com/third.jpg 1x, https://cdn.example.com/third@2x.jpg 2x">
<img src="https://cdn.example.com/plain.png">
<p>Some copy so the section is not empty at all</p>
</section></body></html>`;
{
  const p = E.extractPageContent(lazy);
  const srcs = p.bands.flatMap((b) => b.images.map((i) => i.src));
  assert('the desktop lazy-load URL is preferred over the placeholder',
    srcs.includes('https://cdn.example.com/real-photo.png'), JSON.stringify(srcs));
  assert('other lazy-load spellings work too', srcs.includes('https://cdn.example.com/second.jpg'));
  assert('srcset is read when there is nothing else', srcs.includes('https://cdn.example.com/third.jpg'));
  assert('a plain src is still just used', srcs.includes('https://cdn.example.com/plain.png'));
  assert('and no 1×1 placeholder was kept', srcs.every((s) => !s.startsWith('data:')));
}

// Side-by-side columns are one row, not four stacked sections.
const grid = `<html><head><style>
#wrap { height: 2000px; }
.card { position: absolute; top: 800px; }
#c1 { left: 0 } #c2 { left: 320px } #c3 { left: 640px } #c4 { left: 960px }
.below { position: absolute; top: 1400px; left: 0 }
</style></head><body><div id="wrap">
<div class="card" id="c1"><h3>First card title</h3><p>First card body copy</p></div>
<div class="card" id="c2"><h3>Second card title</h3><p>Second card body copy</p></div>
<div class="card" id="c3"><h3>Third card title</h3><p>Third card body copy</p></div>
<div class="card" id="c4"><h3>Fourth card title</h3><p>Fourth card body copy</p></div>
<div class="below"><h2>A section underneath the cards</h2></div>
</div></body></html>`;
{
  const p = E.extractPageContent(grid);
  const cardBand = p.bands.find((b) => b.texts.some((t) => t.text.includes('First card')));
  assert('four columns at the same height become one section',
    !!cardBand && ['First', 'Second', 'Third', 'Fourth'].every((n) =>
      cardBand.texts.some((t) => t.text.includes(n))),
    JSON.stringify(p.bands.map((b) => b.texts.length)));
  assert('and the section below them stays separate',
    p.bands.some((b) => b.texts.some((t) => t.text.includes('underneath the cards')) && b !== cardBand));
}

// Roles: what becomes a heading, a button, a bullet.
const roles = `<html><body><section>
<h1>The main headline of the page</h1>
<h4>A smaller supporting line</h4>
<p>A paragraph of body copy that runs on for a while here.</p>
<ul><li>First bullet point</li><li>Second bullet point</li></ul>
<a href="/signup">Get started now</a>
<a href="/very-long">This link text is far too long to be a button label on any page</a>
<button>Book a call</button>
</section></body></html>`;
{
  const p = E.extractPageContent(roles);
  const byRole = (r) => p.bands.flatMap((b) => b.texts.filter((t) => t.role === r).map((t) => t.text));
  assert('an <h1> is a heading', byRole('heading').some((t) => t.includes('main headline')));
  assert('an <h4> is a subheading', byRole('subheading').some((t) => t.includes('supporting line')));
  assert('a <li> is a bullet', byRole('bullet').length === 2, JSON.stringify(byRole('bullet')));
  assert('a short link is a button, and keeps its href',
    p.bands.some((b) => b.texts.some((t) => t.role === 'button' && t.text === 'Get started now' && t.href === '/signup')));
  assert('a <button> is a button', byRole('button').some((t) => t === 'Book a call'));
  assert('a long link is body copy, not a button label',
    byRole('body').some((t) => t.includes('far too long')), JSON.stringify(byRole('body')));
}

// A page whose headlines are bare divs — no semantic tags anywhere.
const divsOnly = `<html><head><style>
#w { height: 3000px }
#a { position:absolute; top:100px; font-size: 64px }
#b { position:absolute; top:400px; font-size: 16px }
</style></head><body><div id="w">
<div id="a">This oversized line is the page headline</div>
<div id="b">And this smaller line is the supporting copy underneath it</div>
</div></body></html>`;
{
  const p = E.extractPageContent(divsOnly);
  const heading = p.bands.flatMap((b) => b.texts).find((t) => t.role === 'heading');
  assert('the biggest text becomes the heading when nothing is tagged as one',
    !!heading && heading.text.includes('page headline'),
    JSON.stringify(p.bands.flatMap((b) => b.texts.map((t) => `${t.role}:${t.text.slice(0, 30)}`))));
}

// ═══════════════════════════════════════════════════════════════════════════
// Degenerate input — must never throw, must never invent
// ═══════════════════════════════════════════════════════════════════════════

for (const [name, html] of [
  ['empty string', ''],
  ['whitespace', '    \n '],
  ['bare text', 'just some words with no markup around them at all'],
  ['no body tag', '<div><p>A fragment with no document around it</p></div>'],
  ['unclosed tags', '<body><section><div><p>this never closes'],
  ['unclosed style', '<body><style>#a{top:0<div id="a">hello there</div></body>'],
  ['script only', '<body><script>var x = "<h1>not real content</h1>";</script></body>'],
  ['comment only', '<body><!-- <h1>not content either</h1> --></body>'],
]) {
  let p = null;
  let threw = null;
  try { p = E.extractPageContent(html); } catch (e) { threw = e; }
  assert(`${name}: does not throw`, !threw, threw && String(threw));
  if (!p) continue;
  const src = visible(html);
  const bad = allTexts(p).filter((t) => !src.includes(visible(t).trim()));
  assert(`${name}: invents nothing`, bad.length === 0, JSON.stringify(bad.slice(0, 2)));
  // Schema building must survive the same input.
  let schemaThrew = null;
  try { E.extractedPageToSchema(p); E.requiredContentOf(p); } catch (e) { schemaThrew = e; }
  assert(`${name}: schema and required-content do not throw`, !schemaThrew, schemaThrew && String(schemaThrew));
}

assert('script contents are never read as page text',
  !allTexts(E.extractPageContent('<body><section><script>var a="<h1>fake</h1>"</script><p>Real copy on the page</p></section></body>'))
    .some((t) => t.includes('fake')));

// ═══════════════════════════════════════════════════════════════════════════
// Speed — this runs inside a rebuild request on pages up to half a megabyte
// ═══════════════════════════════════════════════════════════════════════════

function timed(label, html, budgetMs) {
  const t = Date.now();
  E.extractPageContent(html);
  const ms = Date.now() - t;
  assert(`${label} in under ${budgetMs}ms`, ms < budgetMs, `took ${ms}ms`);
}
timed('a 400KB style block with no braces', `<html><head><style>${'a'.repeat(400_000)}</style></head><body><div>x</div></body></html>`, 2000);
timed('a 300KB single-line body', `<html><body>${'<div class="a"><p>copy here</p></div>'.repeat(9000)}</body></html>`, 4000);
if (existsSync(titanPath)) timed('the real Unbounce export', readFileSync(titanPath, 'utf8'), 1500);
if (existsSync(templatePath)) timed('the real generated page', readFileSync(templatePath, 'utf8'), 500);

// ═══════════════════════════════════════════════════════════════════════════

rmSync(outDir, { recursive: true, force: true });
console.log(failed === 0 ? '\nAll extraction checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

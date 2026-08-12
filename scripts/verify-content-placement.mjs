/**
 * Real behavior tests for src/lib/ai-content-placement.ts.
 *
 * Guards the generality claim: a user can name ANY section the builder emits
 * ("put the logo in the testimonials"), not just the handful of nouns that were
 * once hardcoded in this file.
 *
 * Run: node scripts/verify-content-placement.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-placement');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-content-placement.ts');

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
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const C = require(join(outDir, 'ai-content-placement.js'));

let failed = 0;
function assert(name, cond) {
  if (cond) console.log(`OK: ${name}`);
  else { console.error(`FAIL: ${name}`); failed++; }
}

// A realistic page: names well beyond the old hardcoded noun list.
const SECTIONS = [
  'nav', 'hero', 'features', 'how_it_works', 'testimonials',
  'pricing', 'team', 'gallery', 'faq', 'cta-form', 'footer',
];

const infer = (p) => C.inferTargetSectionNames(p, SECTIONS);

// ── Any live section is addressable ─────────────────────────────────────────

assert('hero by name', infer('add the logo to the hero section').includes('hero'));
assert('testimonials by name', infer('put the logo in the testimonials').includes('testimonials'));
assert('team by name', infer('make the team section text bigger').includes('team'));
assert('gallery by name', infer('use this image in the gallery').includes('gallery'));
assert('multi-word section by name',
  infer('change the how it works section').includes('how_it_works'));
assert('features singular still matches',
  infer('the feature section needs work').includes('features'));

// ── Spoken synonyms for parts named something else ──────────────────────────

assert('navbar → nav', infer('make the navbar text bigger').includes('nav'));
assert('navigation bar → nav', infer('why is the navigation bar white').includes('nav'));
assert('header → nav', infer('the header should be blue').includes('nav'));
assert('banner → hero', infer('put it in the banner').includes('hero'));
assert('reviews → testimonials', infer('fix the reviews').includes('testimonials'));
assert('form → cta-form', infer('the form is broken').includes('cta-form'));
assert('questions → faq', infer('the questions section is too long').includes('faq'));

// ── No false positives ──────────────────────────────────────────────────────

assert('"information" does not match the form section',
  !infer('add more information about pricing plans').includes('cta-form'));
assert('unrelated prompt matches nothing',
  infer('make the whole page feel more premium').length === 0);
assert('pricing still matches when named',
  infer('add more information about pricing plans').includes('pricing'));

// ── everywhere ──────────────────────────────────────────────────────────────

const everywhere = infer('use the logo everywhere on the page');
assert('everywhere resolves to nav + footer',
  everywhere.includes('nav') && everywhere.includes('footer'));
assert('everywhere also includes hero when the page has one',
  everywhere.includes('hero'));

assert(
  'make the logo white everywhere is a style ask, not reuse',
  C.isLogoColorStyleAsk('make the logo white everywhere') === true &&
    C.detectContentReuseIntent('make the logo white everywhere', SECTIONS) === null,
);
assert(
  'make the logo colors white everywhere is not reuse',
  C.detectContentReuseIntent(
    'make the footer like this also make the logo colors white everywhere',
    SECTIONS,
  ) === null,
);
assert(
  '"use the new white logo in the footer" is still placement, not recolor',
  C.isLogoColorStyleAsk('use the new white logo in the footer as well') === false,
);

// ── Logo placement into arbitrary sections ──────────────────────────────────

const heroLogo = C.detectContentReuseIntent('add the logo to the hero section', SECTIONS);
assert('logo → hero is a reuse intent', heroLogo?.kind === 'logo');
assert('logo → hero targets hero', heroLogo?.targets.includes('hero'));

const teamLogo = C.detectContentReuseIntent('please put our logo in the team section too', SECTIONS);
assert('logo → team (never hardcoded) works', teamLogo?.kind === 'logo' && teamLogo.targets.includes('team'));

const galleryLogo = C.detectContentReuseIntent('show the logo in the gallery as well', SECTIONS);
assert('logo → gallery works', galleryLogo?.targets.includes('gallery'));

const footerLogo = C.detectContentReuseIntent('use the new white logo in the footer as well', SECTIONS);
assert('the original reported prompt still works',
  footerLogo?.kind === 'logo' && footerLogo.targets.includes('footer'));

const footerToNav = C.detectContentReuseIntent(
  'make navbar logo same as footer, use the same logo which is used in footer',
  SECTIONS,
);
assert('footer→nav logo reuse is logo kind', footerToNav?.kind === 'logo');
assert('footer→nav source is footer', footerToNav?.sourceSectionHint === 'footer');
assert('footer→nav dest is nav not footer',
  footerToNav?.targets.includes('nav') && !footerToNav?.targets.includes('footer'));

const copyFooterToNav = C.detectContentReuseIntent(
  'copy the logo from footer to navbar',
  SECTIONS,
);
assert('copy from footer to navbar is logo kind', copyFooterToNav?.kind === 'logo');
assert('copy from footer → source footer', copyFooterToNav?.sourceSectionHint === 'footer');
assert('copy from footer → dest nav only',
  copyFooterToNav?.targets.includes('nav') && !copyFooterToNav?.targets.includes('footer'));

// ── Text reuse into arbitrary sections ──────────────────────────────────────

const textToTeam = C.detectContentReuseIntent(
  'copy the hero headline to the team section', SECTIONS,
);
assert('text reuse targets a non-hardcoded section',
  textToTeam?.kind === 'text' && textToTeam.targets.includes('team'));
assert('text reuse keeps the source hint', textToTeam?.sourceSectionHint === 'hero');

const quotedToTestimonials = C.detectContentReuseIntent(
  'put "Trusted by 400 teams" in the testimonials', SECTIONS,
);
assert('quoted copy into an arbitrary section',
  quotedToTestimonials?.kind === 'text' &&
  quotedToTestimonials.targets.includes('testimonials') &&
  quotedToTestimonials.textPayload === 'Trusted by 400 teams');

// ── Placement actually applies ──────────────────────────────────────────────

const html = `<!-- SL:team --><section><div class="wrap"><h2>Our Team</h2></div></section><!-- /SL:team -->`;
const placed = C.forcePlaceTextInSection(html, 'team', 'Meet The Crew');
assert('text lands in an arbitrary section', placed.includes('Meet The Crew'));
assert('section markers survive placement',
  placed.includes('<!-- SL:team -->') && placed.includes('<!-- /SL:team -->'));

const duped = C.dedupeDesignCopyLines([
  'Privacy Policy',
  'Privacy Policy',
  'privacy policy',
  '  Privacy Policy  ',
  'Contact us at 555-0100',
  'Contact us',
]);
assert('duplicate screenshot lines collapse to one',
  duped.filter((l) => /privacy policy/i.test(l)).length === 1);
assert('shorter line absorbed into the longer one',
  duped.some((l) => l === 'Contact us at 555-0100') && !duped.includes('Contact us'));

const footerHtml = `<!-- SL:footer --><footer><p>Privacy Policy</p></footer><!-- /SL:footer -->`;
const stuffed = C.forceAppendMissingDesignCopy(footerHtml, 'footer', [
  'Privacy Policy',
  'Privacy Policy',
  'Privacy Policy',
]);
assert('already-present copy is not stamped again',
  (stuffed.match(/Privacy Policy/g) || []).length === 1);

// ── Style reference vs content source ───────────────────────────────────────
// The prompt that shipped the reference's own headline onto the page and then
// reported it as an unmet ask.
const STYLE_REF_PROMPT =
  'The page should pretty much just look like this hero section, except it should say, ' +
  '“Your call is confirmed. We look forward to speaking to you during your call time.” ' +
  "That's pretty much it. Use the logo, use the same colors, flat background. " +
  'You can use the KPIs that are in this screen. There are no buttons, no calls to action, ' +
  "nothing else that's required.";

assert('replacement copy → screenshot copy is NOT content', C.wantsReferenceCopy(STYLE_REF_PROMPT) === false);
assert('clone a named part → screenshot copy IS content', C.wantsReferenceCopy('make our footer like this') === true);
assert('explicit "use the text from it" → content', C.wantsReferenceCopy('use the copy from this screenshot') === true);
assert('bare style ask → not content', C.wantsReferenceCopy('make it feel more premium') === false);
assert(
  '"except it should say" beats clone language',
  C.wantsReferenceCopy('make the footer like this, except it should say Contact Us') === false,
);

// ── Quoted payloads: an apostrophe is not a quote ───────────────────────────
const reuse = C.detectContentReuseIntent(
  "put the hero headline in the footer. That's what I want, don't overthink it.",
  SECTIONS,
);
assert(
  'apostrophes do not become a quoted payload',
  !reuse || !reuse.textPayload || !/^s\b/.test(reuse.textPayload),
);

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll content-placement behavior checks passed.');

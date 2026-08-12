/**
 * Real behavior tests for src/lib/ai-page-requirements.ts.
 *
 * The other verify script asserts wiring by reading source text. That catches
 * "someone deleted the call" but not "the CTA stripper eats the logo", so this
 * one compiles the module (it has no imports) and exercises the actual code.
 *
 * Run: node scripts/verify-page-requirements.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-page-requirements.ts');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    srcFile,
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
const R = require(join(outDir, 'ai-page-requirements.js'));

let failed = 0;
function assert(name, cond) {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    console.error(`FAIL: ${name}`);
    failed++;
  }
}

// ── CTA detection + stripping ───────────────────────────────────────────────

const navWithCta = `
<!-- SL:nav --><nav style="background:#1e3a5f"><div class="wrap">
<a href="/" class="logo"><img src="https://x/logo.svg" alt="logo" /></a>
<a href="#book" style="background:#3D8BDA;padding:12px 24px;border-radius:999px;">Book a Call</a>
</div></nav><!-- /SL:nav -->`;

assert('pageHasCta detects pill anchor', R.pageHasCta(navWithCta) === true);

const stripped = R.stripCtaElements(navWithCta);
assert('stripCtaElements removes the CTA', stripped.removed === 1);
assert('CTA text is gone', !stripped.html.includes('Book a Call'));
assert('logo <img> survives CTA strip', stripped.html.includes('https://x/logo.svg'));
assert('logo anchor survives CTA strip', /class="logo"/.test(stripped.html));
assert('no CTA remains after strip', R.pageHasCta(stripped.html) === false);

const footerLinks = `<footer><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a></footer>`;
assert('plain text links are not CTAs', R.pageHasCta(footerLinks) === false);
assert('plain text links survive', R.stripCtaElements(footerLinks).removed === 0);

const buttonTag = `<div><button class="x">Submit</button></div>`;
assert('<button> counts as CTA', R.pageHasCta(buttonTag) === true);

// ── Requirement extraction ──────────────────────────────────────────────────

const minimalPrompt =
  'The page should just say "Your Call Is Confirmed." There are no buttons, no calls to action, nothing else that\'s required. Keep the navigation bar and footer blue.';

const reqs = R.extractRequirements({
  prompt: minimalPrompt,
  assetUrls: ['https://storage/logo.png'],
  designCopyLines: [],
});
const kinds = reqs.map((r) => r.kind);

assert('extracts no_cta from "no buttons"', kinds.includes('no_cta'));
assert('extracts asset_present for logo', kinds.includes('asset_present'));
assert('extracts text_present from quoted copy', kinds.includes('text_present'));
assert('extracts color_applied for nav/footer', kinds.includes('color_applied'));

const colorReq = reqs.find((r) => r.kind === 'color_applied');
assert('color ask binds to nav and footer', 
  !!colorReq && colorReq.sections.includes('nav') && colorReq.sections.includes('footer'));

const plainPrompt = 'Build a landing page for a dental clinic in Austin.';
assert('plain prompt yields no bogus requirements',
  R.extractRequirements({ prompt: plainPrompt }).length === 0);

const colorOnlyCopy = 'Our blue widgets are the best widgets money can buy.';
assert('color word without a page part is not a requirement',
  R.extractRequirements({ prompt: colorOnlyCopy }).length === 0);

// ── Checking ────────────────────────────────────────────────────────────────

const pageWithCta = `<html><body>${navWithCta}<p>Your Call Is Confirmed.</p><img src="https://storage/logo.png"/></body></html>`;
let results = R.checkRequirements(pageWithCta, reqs);
const noCtaResult = results.find((r) => r.requirement.kind === 'no_cta');
assert('no_cta FAILS while button is present', noCtaResult.passed === false);
assert('describeUnmet names the failure', (R.describeUnmet(results) ?? '').includes('buttons'));

const enforced = R.enforceRequirements(pageWithCta, reqs);
results = R.checkRequirements(enforced.html, reqs);
assert('no_cta PASSES after enforcement',
  results.find((r) => r.requirement.kind === 'no_cta').passed === true);
assert('asset_present passes when logo URL present',
  results.find((r) => r.requirement.kind === 'asset_present').passed === true);
assert('text_present passes for quoted copy',
  results.find((r) => r.requirement.kind === 'text_present').passed === true);

const missingAsset = R.checkRequirements('<html><body>no logo here</body></html>', [
  { kind: 'asset_present', label: 'logo', value: 'https://storage/logo.png' },
]);
assert('asset_present FAILS when URL absent', missingAsset[0].passed === false);

// text matching ignores markup and smart quotes
const spanned = '<h1>Your <span>Call</span> Is  Confirmed.</h1>';
assert('text_present ignores tags and whitespace',
  R.checkRequirements(spanned, [
    { kind: 'text_present', label: 't', value: 'Your Call Is Confirmed.' },
  ])[0].passed === true);

// ── Theme color ─────────────────────────────────────────────────────────────

const themedPage = `<style>:root{--color-primary:#1e3a5f;}</style>
<!-- SL:nav --><nav><div class="wrap">links</div></nav><!-- /SL:nav -->
<!-- SL:hero --><section style="background:#1e3a5f">hero</section><!-- /SL:hero -->`;

assert('theme color read from :root token',
  R.extractThemeBackgroundColor(themedPage) === '#1e3a5f');

const noTokens = `<div style="background:#ffffff">a</div><div style="background:#0f2540">b</div><div style="background:#0f2540">c</div>`;
assert('theme color falls back to dominant non-white',
  R.extractThemeBackgroundColor(noTokens) === '#0f2540');

const whiteNav = `<!-- SL:nav --><nav><div class="wrap">links</div></nav><!-- /SL:nav -->`;
const colorReqs = [
  { kind: 'color_applied', label: 'nav blue', value: '#1e3a5f', sections: ['nav'], colorName: 'blue' },
];
assert('white nav FAILS color requirement',
  R.checkRequirements(whiteNav, colorReqs)[0].passed === false);

const coloredNav = R.enforceRequirements(whiteNav + '<style>:root{--color-primary:#1e3a5f;}</style>', colorReqs);
assert('color enforcement applies a background', coloredNav.applied.length === 1);
assert('color enforcement PASSES after applying',
  R.checkRequirements(coloredNav.html, colorReqs)[0].passed === true);
assert('applied color is the page theme token', coloredNav.html.includes('#1e3a5f'));

const alreadyBlue = `<!-- SL:footer --><footer><div style="background:#1e3a5f">x</div></footer><!-- /SL:footer -->`;
assert('already-colored section passes untouched',
  R.checkRequirements(alreadyBlue, [
    { kind: 'color_applied', label: 'footer', value: '#1e3a5f', sections: ['footer'], colorName: 'blue' },
  ])[0].passed === true);

// ── Color is checked by the color ASKED FOR, not merely "not white" ─────────

assert('parses hex, short hex and rgb',
  R.parseCssColor('#1e3a5f').b === 95 &&
  R.parseCssColor('#abc').r === 170 &&
  R.parseCssColor('rgb(30, 58, 95)').g === 58);

assert('navy hex reads as blue', R.colorMatchesName('#1e3a5f', 'blue') === true);
assert('green hex does NOT read as blue', R.colorMatchesName('#146c43', 'blue') === false);
assert('green hex reads as green', R.colorMatchesName('#146c43', 'green') === true);
assert('white does not read as blue', R.colorMatchesName('#ffffff', 'blue') === false);
assert('black reads as black', R.colorMatchesName('#111111', 'black') === true);
assert('red wraps the hue wheel', R.colorMatchesName('#b02a37', 'red') === true);
assert('literal hex ask matches a near shade', R.colorMatchesName('#1e3a60', '#1e3a5f') === true);
assert('literal hex ask rejects a far shade', R.colorMatchesName('#146c43', '#1e3a5f') === false);

const greenNav = `<!-- SL:nav --><nav><div style="background:#146c43">links</div></nav><!-- /SL:nav -->`;
assert('GREEN nav FAILS a request for blue — the old non-white test passed this',
  R.checkRequirements(greenNav, colorReqs)[0].passed === false);

const fixedGreenNav = R.enforceRequirements(greenNav, colorReqs);
assert('wrong-color background is overwritten, not skipped',
  R.checkRequirements(fixedGreenNav.html, colorReqs)[0].passed === true);
assert('overwrite removed the green', !fixedGreenNav.html.includes('#146c43'));

const varNav = `<style>:root{--brand-navy:#0f2540;}</style><!-- SL:nav --><nav><div style="background:var(--brand-navy)">l</div></nav><!-- /SL:nav -->`;
assert('var() backgrounds resolve against :root',
  R.checkRequirements(varNav, colorReqs)[0].passed === true);

const askedGreen = R.extractRequirements({ prompt: 'make the footer green please' });
assert('a green ask records green, not a blue default',
  askedGreen[0].colorName === 'green');
assert('blue footer FAILS a green ask',
  R.checkRequirements(
    `<!-- SL:footer --><footer><div style="background:#1e3a5f">x</div></footer><!-- /SL:footer -->`,
    askedGreen,
  )[0].passed === false);

const hexAsk = R.extractRequirements({ prompt: 'make the nav #0f2540' });
assert('explicit hex in prompt beats the color word', hexAsk[0].value === '#0f2540');

// ── Retry instruction ───────────────────────────────────────────────────────

const retry = R.retryInstructionFor(R.checkRequirements(pageWithCta, reqs));
assert('retry instruction names the CTA fix', (retry ?? '').includes('call-to-action'));
assert('retry instruction is null when all pass',
  R.retryInstructionFor(R.checkRequirements(enforced.html, [
    { kind: 'no_cta', label: 'no cta' },
  ])) === null);

// ── Model-written checklist ─────────────────────────────────────────────────
//
// The model interprets the ask; this parser decides what we are willing to
// verify. It must be fail-closed: a hallucinated or unverifiable requirement
// would fail every attempt and block the edit entirely.

const SECTIONS = ['nav', 'hero', 'testimonials', 'footer'];
const parse = (reqs) => R.parseModelRequirements({ requirements: reqs }, { knownSections: SECTIONS });

assert('accepts a well-formed model checklist',
  parse([{ kind: 'text_present', label: 'the confirmation copy appears', value: 'Your call is confirmed.' }])
    .length === 1);

assert('accepts a JSON string payload',
  R.parseModelRequirements(
    JSON.stringify({ requirements: [{ kind: 'no_cta', label: 'no buttons' }] }),
  ).length === 1);

assert('accepts a bare array',
  R.parseModelRequirements([{ kind: 'no_cta', label: 'no buttons' }]).length === 1);

assert('survives junk instead of JSON', R.parseModelRequirements('not json at all').length === 0);
assert('survives null', R.parseModelRequirements(null).length === 0);
assert('survives a missing field', R.parseModelRequirements({}).length === 0);

assert('drops an unverifiable taste requirement',
  parse([{ kind: 'looks_premium', label: 'the page feels premium' }]).length === 0);
assert('drops a hallucinated section name',
  parse([{ kind: 'section_changed', label: 'x', sections: ['pricing'] }]).length === 0);
assert('drops asset_present without a real URL',
  parse([{ kind: 'asset_present', label: 'logo', value: 'the company logo' }]).length === 0);
assert('drops text_present that is too short to mean anything',
  parse([{ kind: 'text_present', label: 'x', value: 'hi' }]).length === 0);
assert('drops color_applied with no color named',
  parse([{ kind: 'color_applied', label: 'blue nav', sections: ['nav'] }]).length === 0);

assert('accepts color_applied with color_name in snake_case',
  parse([{ kind: 'color_applied', label: 'blue nav', sections: ['nav'], color_name: 'blue' }])
    .length === 1);
assert('resolves section names case-insensitively',
  parse([{ kind: 'section_changed', label: 'x', sections: ['NAV'] }])[0].sections[0] === 'nav');
assert('supplies a label when the model omits one',
  parse([{ kind: 'no_cta' }])[0].label.length > 0);
assert('caps a runaway list', parse(
  Array.from({ length: 40 }, (_, i) => ({ kind: 'text_present', label: `l${i}`, value: `phrase number ${i}` })),
).length <= 12);

// ── section_changed: the check that makes style asks honest ─────────────────

const beforePage =
  `<!-- SL:nav --><nav><a>Home</a></nav><!-- /SL:nav -->` +
  `<!-- SL:hero --><section><h1>Welcome</h1></section><!-- /SL:hero -->`;
const navUntouched =
  `<!-- SL:nav --><nav><a>Home</a></nav><!-- /SL:nav -->` +
  `<!-- SL:hero --><section><h1>Welcome back</h1></section><!-- /SL:hero -->`;
const navBigger =
  `<!-- SL:nav --><nav style="font-size:20px"><a>Home</a></nav><!-- /SL:nav -->` +
  `<!-- SL:hero --><section><h1>Welcome</h1></section><!-- /SL:hero -->`;

const navMustChange = parse([
  { kind: 'section_changed', label: 'the nav text is bigger', sections: ['nav'] },
]);
assert('"make the navbar text bigger" is a real requirement', navMustChange.length === 1);
assert('an untouched nav FAILS even though the page changed',
  R.checkRequirements(navUntouched, navMustChange, { beforeHtml: beforePage })[0].passed === false);
assert('a genuinely edited nav passes',
  R.checkRequirements(navBigger, navMustChange, { beforeHtml: beforePage })[0].passed === true);
assert('no before-image means no invented failure',
  R.checkRequirements(navUntouched, navMustChange)[0].passed === true);
assert('retry tells the model it returned the section unchanged',
  (R.retryInstructionFor(
    R.checkRequirements(navUntouched, navMustChange, { beforeHtml: beforePage }),
  ) ?? '').includes('unchanged'));

// ── Merge: the regex pass stays a floor, never a ceiling ────────────────────

const regexFloor = R.extractRequirements({ prompt: 'no buttons at all please' });
const merged = R.mergeRequirements(
  parse([{ kind: 'section_changed', label: 'nav updated', sections: ['nav'] }]),
  regexFloor,
);
assert('merge keeps the model checks', merged.some((r) => r.kind === 'section_changed'));
assert('merge keeps the regex guarantees', merged.some((r) => r.kind === 'no_cta'));
assert('a failed extraction cannot remove existing guarantees',
  R.mergeRequirements([], regexFloor).some((r) => r.kind === 'no_cta'));
assert('merge dedupes an ask both passes found',
  R.mergeRequirements(regexFloor, regexFloor).filter((r) => r.kind === 'no_cta').length === 1);

// ── The user's three-part prompt, end to end ────────────────────────────────

const threePart = parse([
  { kind: 'asset_present', label: 'the logo is in the hero', value: 'https://cdn.x/logo.svg', sections: ['hero'] },
  { kind: 'section_changed', label: 'the navbar text is bigger', sections: ['nav'] },
  { kind: 'section_changed', label: 'the footer matches the screenshot', sections: ['footer'] },
  { kind: 'text_present', label: 'screenshot copy appears', value: 'Focused Capital Partners' },
]);
assert('all four parts of a multi-part ask become checks', threePart.length === 4);

const partialResult = R.checkRequirements(
  `<!-- SL:nav --><nav><a>Home</a></nav><!-- /SL:nav -->` +
    `<!-- SL:hero --><section><img src="https://cdn.x/logo.svg"/></section><!-- /SL:hero -->` +
    `<!-- SL:footer --><footer><p>Focused Capital Partners</p></footer><!-- /SL:footer -->`,
  threePart,
  {
    beforeHtml:
      `<!-- SL:nav --><nav><a>Home</a></nav><!-- /SL:nav -->` +
      `<!-- SL:hero --><section></section><!-- /SL:hero -->` +
      `<!-- SL:footer --><footer></footer><!-- /SL:footer -->`,
  },
);
assert('the two parts that landed pass',
  partialResult.filter((r) => r.passed).length === 3);
assert('the dropped navbar ask is reported, not called Done',
  (R.describeUnmet(partialResult) ?? '').includes('navbar'));

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll page-requirement behavior checks passed.');

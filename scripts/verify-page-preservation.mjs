/**
 * Real behavior tests for src/lib/ai-page-preservation.ts.
 *
 * The bug this guards: an edit about nav colors deleted a logo nobody asked it
 * to touch, and every existing check passed because they only ever verified
 * that requested changes landed.
 *
 * Run: node scripts/verify-page-preservation.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-preservation');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-page-preservation.ts');

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
const P = require(join(outDir, 'ai-page-preservation.js'));

let failed = 0;
function assert(name, cond) {
  if (cond) console.log(`OK: ${name}`);
  else { console.error(`FAIL: ${name}`); failed++; }
}

const pageWithLogo = `
<!-- SL:nav --><nav><a href="/"><img src="https://cdn.site.com/logo.svg" alt="logo"/></a></nav><!-- /SL:nav -->
<!-- SL:hero --><section><h1>Your Call Is Confirmed.</h1></section><!-- /SL:hero -->
<!-- SL:footer --><footer><img src="https://cdn.site.com/logo.svg"/><p>Focused Capital</p></footer><!-- /SL:footer -->`;

// The exact reported failure: asked for colors, got a deleted logo.
const logoDeleted = `
<!-- SL:nav --><nav style="background:#1e3a5f"><span>Focused Capital</span></nav><!-- /SL:nav -->
<!-- SL:hero --><section><h1>Your Call Is Confirmed.</h1></section><!-- /SL:hero -->
<!-- SL:footer --><footer style="background:#1e3a5f"><p>Focused Capital</p></footer><!-- /SL:footer -->`;

const losses = P.findUnrequestedLosses({
  beforeHtml: pageWithLogo,
  afterHtml: logoDeleted,
  prompt: 'why is navigation bar and footer white keep them blue of the theme',
});
assert('detects a logo deleted without being asked', losses.images.length === 1);
assert('names the deleted logo URL', losses.images[0] === 'https://cdn.site.com/logo.svg');
assert('describeLosses is human readable',
  (P.describeLosses(losses) ?? '').includes('image') &&
  (P.describeLosses(losses) ?? '').includes('without being asked'));

// A requested delete must NOT be reported as a regression.
const requested = P.findUnrequestedLosses({
  beforeHtml: pageWithLogo,
  afterHtml: logoDeleted,
  prompt: 'remove the logo from the nav and footer',
});
assert('requested removal is not a loss', P.hasLosses(requested) === false);

assert('removal intent detected: remove', P.promptHasRemovalIntent('remove that section') === true);
assert('removal intent detected: get rid of', P.promptHasRemovalIntent('get rid of the FAQ') === true);
assert('removal intent detected: take that out', P.promptHasRemovalIntent('see screenshot... take that out') === true);
assert('no removal intent in a color ask',
  P.promptHasRemovalIntent('keep the nav and footer blue') === false);

// Re-hosting the same asset is not a loss.
const rehosted = pageWithLogo.split('https://cdn.site.com/logo.svg').join(
  'https://xyz.supabase.co/storage/v1/object/public/ai-pages-images/p/images/logo.svg',
);
assert('re-hosted copy of the same file is not a loss',
  P.findUnrequestedLosses({ beforeHtml: pageWithLogo, afterHtml: rehosted, prompt: 'make it blue' })
    .images.length === 0);

// Section and heading loss.
const sectionGone = pageWithLogo.replace(
  /<!-- SL:footer -->[\s\S]*?<!-- \/SL:footer -->/,
  '',
);
const sectionLosses = P.findUnrequestedLosses({
  beforeHtml: pageWithLogo,
  afterHtml: sectionGone,
  prompt: 'make the hero bigger',
});
assert('detects a section that vanished', sectionLosses.sections.includes('footer'));

const headingGone = pageWithLogo.replace('Your Call Is Confirmed.', 'Welcome');
assert('detects a heading that vanished',
  P.findUnrequestedLosses({ beforeHtml: pageWithLogo, afterHtml: headingGone, prompt: 'make it blue' })
    .headings.length === 1);

// No change → no false alarms.
assert('identical page reports no losses',
  P.hasLosses(P.findUnrequestedLosses({
    beforeHtml: pageWithLogo,
    afterHtml: pageWithLogo,
    prompt: 'make the nav blue',
  })) === false);

// Adding content is never a loss.
const added = pageWithLogo.replace('</footer>', '<p>New line</p></footer>');
assert('adding content reports no losses',
  P.hasLosses(P.findUnrequestedLosses({
    beforeHtml: pageWithLogo,
    afterHtml: added,
    prompt: 'add a line to the footer',
  })) === false);

// Snapshot sanity
const facts = P.snapshotPageFacts(pageWithLogo);
assert('snapshot collects sections', facts.sectionNames.join(',') === 'nav,hero,footer');
assert('snapshot dedupes image URLs', facts.imageUrls.length === 1);
assert('snapshot collects headings', facts.headings[0] === 'your call is confirmed.');

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll preservation behavior checks passed.');

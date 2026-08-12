/**
 * Behavior tests for src/lib/ai-data-field-stamp.ts
 * Run: node scripts/verify-data-field-stamp.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-stamp');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-data-field-stamp.ts');

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
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const { stampSchemaDataFields, ensureClickToEditFields, stampStructuralDataFields } = require(join(outDir, 'ai-data-field-stamp.js'));

function assert(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log('OK:', name);
}

const schema = {
  hero: {
    headline: 'Your call is confirmed.',
    subhead: 'We look forward to speaking to you during your call time.',
    image_prompt: 'do not stamp this',
  },
  nav: { logo_url: 'https://cdn.example.com/logo.svg' },
};

const html = `<!DOCTYPE html><html><body>
<!-- SL:nav --><nav><img src="https://cdn.example.com/logo.svg" alt="logo"></nav><!-- /SL:nav -->
<!-- SL:hero --><section>
<h1>Your call is confirmed.</h1>
<p>We look forward to speaking to you during your call time.</p>
</section><!-- /SL:hero -->
</body></html>`;

const stamped = stampSchemaDataFields(html, schema);
assert('stamps headline', /<h1 data-field="hero.headline">Your call is confirmed\.<\/h1>/.test(stamped));
assert('stamps subhead', /<p data-field="hero.subhead">We look forward/.test(stamped));
assert('stamps logo img', /<img data-field="nav.logo_url" src="https:\/\/cdn.example.com\/logo.svg"/.test(stamped));
assert('does not stamp image_prompt', !stamped.includes('image_prompt'));

const already = stampSchemaDataFields(stamped, schema);
assert('idempotent', already === stamped);

const noMatch = stampSchemaDataFields('<h1>Other text</h1>', schema);
assert('no false stamp on unmatched text', !noMatch.includes('data-field'));

const screenshotHtml = `<!-- SL:hero --><section>
<h1>Screenshot headline not in schema</h1>
<p>Extra disclaimer from the mock.</p>
</section><!-- /SL:hero -->`;
const structural = stampStructuralDataFields(screenshotHtml);
assert('structural stamps unmatched headline', /data-field="hero\.headline"/.test(structural));
assert('structural stamps unmatched paragraph', /data-field="hero\.text"/.test(structural));
const ensured = ensureClickToEditFields(screenshotHtml, { hero: { headline: 'Different' } });
assert('ensure fills structural when schema misses', /data-field="hero\.headline"/.test(ensured));

rmSync(outDir, { recursive: true, force: true });
console.log('\nAll data-field stamp checks passed.');

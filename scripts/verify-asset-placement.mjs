/**
 * Real behavior tests for src/lib/asset-placement.ts.
 *
 * The bug this guards: a user pasted a Google Drive folder into their brief,
 * watched four thumbnails import, and got back a page with none of them on it
 * plus the words "Your page is ready!". The build was in fact correct — that
 * brief banned extra imagery in three separate places, so the model declined
 * every file on purpose — but nothing said so, and "imported four, used none,
 * said nothing" is indistinguishable from a broken fetch. It was reported as a
 * broken fetch.
 *
 * So the counting has to be right in both directions. A false "none landed" on
 * a page that does use the photos is the worse failure of the two: it would
 * tell the user their import broke while they are looking at it working.
 *
 * Run: node scripts/verify-asset-placement.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-asset-placement');
const srcFile = join(repoRoot, 'src', 'lib', 'asset-placement.ts');

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
const A = require(join(outDir, 'asset-placement.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// The real URLs from the dealership build that proved the feature works —
// four Drive files re-hosted onto our own storage.
const BASE =
  'https://atbhqnboljbuceaxojrm.supabase.co/storage/v1/object/public/ai-pages-images/1fca3f1c-7dab-47c6-b443-be6a36543ad8/images';
const LIB = [
  { url: `${BASE}/82d42990-1c66-439c-b1f8-6c885da058ce.jpeg`, name: 'car2.jpg' },
  { url: `${BASE}/747c0710-f697-4f73-b609-fd2862e20b0a.jpeg`, name: 'car4.jpg' },
  { url: `${BASE}/1edb655f-76e1-4572-b9b9-370441ae6f5d.jpeg`, name: 'odometer.jpeg' },
  { url: `${BASE}/d17eeef0-615f-4fda-a558-5a29685bcb28.jpeg`, name: 'p2.jpg' },
];

const page = (urls) =>
  `<html><body>${urls.map((u) => `<img src="${u}" alt="">`).join('')}</body></html>`;

// ── Counting ──────────────────────────────────────────────────────────────

let m = A.measureAssetPlacement(LIB, page(LIB.map((a) => a.url)));
assert('all four placed counts 4', m.placed === 4 && m.imported === 4, JSON.stringify(m));
assert('all four placed lists nothing unused', m.unusedNames.length === 0, JSON.stringify(m.unusedNames));

m = A.measureAssetPlacement(LIB, '<html><body><h1>No imagery on this page</h1></body></html>');
assert('total decline counts 0', m.placed === 0 && m.imported === 4, JSON.stringify(m));
assert('total decline names all four', m.unusedNames.join() === 'car2.jpg,car4.jpg,odometer.jpeg,p2.jpg', m.unusedNames.join());

m = A.measureAssetPlacement(LIB, page([LIB[0].url, LIB[3].url]));
assert('partial counts 2', m.placed === 2, JSON.stringify(m));
assert('partial names only the missing two', m.unusedNames.join() === 'car4.jpg,odometer.jpeg', m.unusedNames.join());

// A URL embedded in CSS rather than an <img> still counts — the builder writes
// hero photos as background-image, which is exactly the hero slot the user is
// most likely to be asking about.
m = A.measureAssetPlacement([LIB[0]], `<div style="background-image:url('${LIB[0].url}')"></div>`);
assert('background-image counts as placed', m.placed === 1, JSON.stringify(m));

// srcset, same reasoning.
m = A.measureAssetPlacement([LIB[1]], `<img srcset="${LIB[1].url} 2x" src="x.png">`);
assert('srcset counts as placed', m.placed === 1, JSON.stringify(m));

// The front of the URL is not load-bearing: a CDN host swap rewrites the origin
// and leaves the object path alone. Missing this would report a working page as
// a failed import.
m = A.measureAssetPlacement(
  [LIB[2]],
  '<img src="https://cdn.example.com/object/public/ai-pages-images/1fca3f1c-7dab-47c6-b443-be6a36543ad8/images/1edb655f-76e1-4572-b9b9-370441ae6f5d.jpeg">',
);
assert('host swap still counts via object path', m.placed === 1, JSON.stringify(m));

// Two files whose ids differ by one character must not be confused.
const twin = { url: `${BASE}/82d42990-1c66-439c-b1f8-6c885da058cf.jpeg`, name: 'twin.jpg' };
m = A.measureAssetPlacement([LIB[0], twin], page([LIB[0].url]));
assert('near-identical id is not a match', m.placed === 1 && m.unusedNames.join() === 'twin.jpg', JSON.stringify(m));

// No library at all -> nothing to report, and no division by zero.
m = A.measureAssetPlacement([], page([]));
assert('empty library is inert', m.imported === 0 && m.placed === 0, JSON.stringify(m));

// ── The sentence ──────────────────────────────────────────────────────────

const say = (assets, html) => A.describeAssetPlacement(A.measureAssetPlacement(assets, html));

assert('silent when every file landed', say(LIB, page(LIB.map((a) => a.url))) === null);
assert('silent when there was no library', say([], '<html></html>') === null);

const declined = say(LIB, '<html><body>nothing</body></html>');
assert('decline says none are on the page', /None of the 4 images/.test(declined || ''), String(declined));
assert('decline names the files', /car2\.jpg/.test(declined || ''), String(declined));
assert('decline invites a fix', /where they should go/.test(declined || ''), String(declined));

const one = say([LIB[0]], '<html><body>nothing</body></html>');
assert('single file uses singular wording', /The image from your link/.test(one || ''), String(one));

const partial = say(LIB, page([LIB[0].url, LIB[1].url]));
assert('partial reports the ratio', /2 of the 4 images/.test(partial || ''), String(partial));
assert('partial names only what is missing', /odometer\.jpeg, p2\.jpg/.test(partial || '') && !/car2/.test(partial || ''), String(partial));

// A 20-file import must not produce a wall of filenames.
const many = Array.from({ length: 20 }, (_, i) => ({ url: `${BASE}/${i}.jpeg`, name: `shot${i}.jpg` }));
const wall = say(many, '<html><body>nothing</body></html>');
assert('long list is capped', /and 16 more/.test(wall || ''), String(wall));
assert('long list stays short', (wall || '').length < 260, String((wall || '').length));

// A file imported with no name still reads as a sentence.
const nameless = say([{ url: `${BASE}/x.jpeg` }], '<html></html>');
assert('missing filename falls back to "image"', /\(image\)/.test(nameless || ''), String(nameless));

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');

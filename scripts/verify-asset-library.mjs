/**
 * Real behavior tests for the link-imported asset library.
 *
 * Two units, one bug between them.
 *
 * src/lib/ai-asset-library.ts turns the library into prompt text. It has to be
 * BOUNDED and it has to report what it dropped: the whole reason the library is
 * text instead of pictures is cost, and an unbounded list would put the cost
 * straight back — a build that fails with "prompt is too long" is exactly the
 * failure this design removes.
 *
 * src/lib/asset-proxy.ts hands out URLs for Drive files we have not downloaded.
 * A Drive ref is not a URL, and three parties with no session have to fetch it:
 * the browser, the caption model, and our own re-host pass reading the finished
 * page. The signature is what stops that route being a free Drive proxy on our
 * API quota.
 *
 * Run: node scripts/verify-asset-library.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-asset-library');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

process.env.NEXTAUTH_SECRET = 'test-secret-for-verification';
process.env.GOOGLE_DRIVE_API_KEY = 'test-drive-key';
process.env.NEXT_PUBLIC_APP_URL = 'https://www.trysplitlab.com';

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(repoRoot, 'src', 'lib', 'ai-asset-library.ts'),
    join(repoRoot, 'src', 'lib', 'asset-proxy.ts'),
    '--outDir', outDir,
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--downlevelIteration',
    // No --noResolve here: asset-proxy imports node's crypto, and resolving it
    // is the point — the signature is the security boundary of the proxy route.
    '--rootDir', join(repoRoot, 'src', 'lib'),
    '--types', 'node',
  ],
  { cwd: repoRoot, stdio: 'pipe' },
);

const require = createRequire(import.meta.url);
const L = require(join(outDir, 'ai-asset-library.js'));
const P = require(join(outDir, 'asset-proxy.js'));

let failed = 0;
function assert(name, cond) {
  if (cond) console.log(`OK: ${name}`);
  else { console.error(`FAIL: ${name}`); failed++; }
}

const { buildLibraryBlock, MAX_LIBRARY_BLOCK_CHARS } = L;
const { publicAssetUrl, signAssetRef, verifyAssetRef } = P;

// Realistic shapes, because the cost is dominated by URL length and a short
// example URL is what hid the true price of a 500-image folder.
const PROXY_URL = (i) =>
  `https://www.trysplitlab.com/api/assets/drive/1BxYz9AbCdEfGhIjKlMnOpQrStUvWxY${i}?sig=${'a'.repeat(32)}`;
const asset = (i, caption) => ({
  url: PROXY_URL(i),
  name: `DSC_0${1000 + i}-reception.jpg`,
  caption,
});

// ── The description is what the model chooses on ────────────────────────────
// The bug: the model saw 8 images and knew the other 32 by filename, so a hero
// shot called IMG_4471.jpg could never be chosen on purpose.
{
  const block = buildLibraryBlock([asset(1, 'smiling dental team in a bright reception — photo')]);
  assert('a caption reaches the model',
    block.lines.includes('smiling dental team in a bright reception'));
  assert('the URL reaches the model, because that is what gets placed',
    block.lines.includes(PROXY_URL(1)));
  assert('the filename is kept alongside the description',
    block.lines.includes('DSC_01001-reception.jpg'));
}

// ── No caption is a degrade, never a drop ───────────────────────────────────
// SVGs and anything the caption model cannot open still have to be placeable.
{
  const block = buildLibraryBlock([
    { url: 'https://example.com/logo.svg', name: 'logo.svg', caption: null },
    { url: 'https://example.com/x.png', name: 'x.png' },
  ]);
  assert('an uncaptioned asset is still offered', block.included === 2);
  assert('an uncaptioned asset still carries its filename and URL',
    block.lines.includes('logo.svg') && block.lines.includes('https://example.com/logo.svg'));
  assert('no empty description separator is emitted for it',
    !block.lines.includes('logo.svg —  —'));
}

// ── Bounded, and honest about the bound ─────────────────────────────────────
{
  const many = Array.from({ length: 5000 }, (_, i) => asset(i, 'a fairly wordy description of this particular photograph'));
  const block = buildLibraryBlock(many);
  assert('the block never exceeds its character ceiling',
    block.chars <= MAX_LIBRARY_BLOCK_CHARS);
  assert('the ceiling actually bites on a huge library', block.dropped > 0);
  assert('what was dropped is counted, not silently lost',
    block.included + block.dropped === many.length);
  assert('the reported character count matches the text it produced',
    Math.abs(block.chars - (block.lines.length + 1)) <= 1);
}

// ── A realistic 500-image folder fits, because that is the promise ──────────
// MAX_LIBRARY_IMPORT is 500, so the block ceiling has to clear a full one at
// realistic line length — captions AND the URLs, which are the bigger half.
{
  const folder = Array.from({ length: 500 }, (_, i) =>
    asset(i, 'wide shot of a smiling dental team in a bright clinic reception — photo'));
  const block = buildLibraryBlock(folder);
  assert('a full 500-image folder is offered whole, nothing dropped for space',
    block.dropped === 0);
  // The build call has ~64k tokens of input room after the 128k output
  // reservation. A full library must leave real space for the reference site.
  const tokens = block.chars / 3;
  assert('and still leaves the reference scrape room to work in',
    tokens < 45_000);
}

// ── Numbering is sequential over what was INCLUDED ──────────────────────────
// A gap would make "use image 12" ambiguous.
{
  const block = buildLibraryBlock([asset(1, 'a'), asset(2, 'b'), asset(3, 'c')]);
  const numbers = block.lines.split('\n').map((l) => parseInt(l, 10));
  assert('lines are numbered 1..n with no gaps',
    numbers.join(',') === '1,2,3');
}

// ── Empty in, empty out ─────────────────────────────────────────────────────
{
  const block = buildLibraryBlock([]);
  assert('no assets produces no text', block.lines === '' && block.included === 0);
  assert('and nothing is reported as dropped', block.dropped === 0);
}

// ── Drive refs become URLs anyone can GET ───────────────────────────────────
{
  const url = publicAssetUrl('drive:1AbCdEfGhIjKlMnOp');
  assert('a Drive ref becomes an absolute URL', !!url && url.startsWith('https://'));
  assert('the Drive API key never appears in it', !url.includes('test-drive-key'));
  assert('it points at our own proxy', url.includes('/api/assets/drive/'));
  assert('it carries a signature', /[?&]sig=[0-9a-f]{32}/.test(url));
}

// ── Non-Drive sources are passed through untouched ──────────────────────────
{
  assert('a plain https asset needs no proxy',
    publicAssetUrl('https://cdn.example.com/a.png') === 'https://cdn.example.com/a.png');
  assert('something that is not a URL is refused rather than embedded',
    publicAssetUrl('not-a-url') === null);
  assert('a malformed Drive ref is refused',
    publicAssetUrl('drive:short') === null);
}

// ── The signature is what keeps it from being an open Drive proxy ───────────
{
  const id = '1AbCdEfGhIjKlMnOp';
  const sig = signAssetRef(id);
  assert('a correct signature verifies', verifyAssetRef(id, sig) === true);
  assert('a wrong signature does not', verifyAssetRef(id, 'f'.repeat(32)) === false);
  assert('a signature for one file does not open another',
    verifyAssetRef('1ZzZzZzZzZzZzZzZz', sig) === false);
  assert('a truncated signature is rejected rather than compared loosely',
    verifyAssetRef(id, sig.slice(0, 8)) === false);
  assert('a missing signature is rejected', verifyAssetRef(id, '') === false);
  assert('signing is stable, so URLs stored on a page keep working',
    signAssetRef(id) === sig);
}

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll asset library checks passed');

/**
 * Real behavior tests for src/lib/ai-context-budget.ts.
 *
 * The bug this guards: a hardcoded "send at most 60k characters of page
 * context" number, invented without knowing what a real page weighs. A fixed
 * budget is a guess about somebody else's page — too small starves the model of
 * context it could easily have afforded (which is how "use the image already in
 * the hero" got answered with the user's attached screenshot), too large kills
 * the call outright.
 *
 * The limit is arithmetic: the window, minus the room the reply needs, minus
 * what the call is already committed to sending.
 *
 * Run: node scripts/verify-context-budget.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-budget');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-context-budget.ts');

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
  { cwd: repoRoot, stdio: 'pipe' },
);

const require = createRequire(import.meta.url);
const C = require(join(outDir, 'ai-context-budget.js'));

let failed = 0;
function assert(name, cond) {
  if (cond) console.log(`OK: ${name}`);
  else { console.error(`FAIL: ${name}`); failed++; }
}

const { remainingInputChars, AI_CONTEXT_TOKENS, CHARS_PER_TOKEN, IMAGE_TOKENS } = C;

// ── The window is real, and both halves of the call live in it ──────────────
assert('the context window is stated, not implied', AI_CONTEXT_TOKENS >= 100_000);
assert('markup is costed pessimistically, never optimistically', CHARS_PER_TOKEN <= 4);

// A small page on a normal edit should get plenty of room — this is the case
// the old 60k constant was quietly capping for no reason.
const roomy = remainingInputChars({ usedChars: 20_000, reservedOutputTokens: 8_000 });
assert('a small ask leaves far more room than the old fixed 60k guess',
  roomy > 60_000);

// ── Reserving output shrinks the input budget, exactly as much as reserved ──
const small = remainingInputChars({ usedChars: 20_000, reservedOutputTokens: 8_000 });
const large = remainingInputChars({ usedChars: 20_000, reservedOutputTokens: 128_000 });
assert('reserving more room for the answer leaves less for the question',
  large < small);
assert('the shrink matches the reservation, it is not a fudge factor',
  Math.abs((small - large) - (128_000 - 8_000) * CHARS_PER_TOKEN) < CHARS_PER_TOKEN * 2);

// ── What we already send comes off the top ──────────────────────────────────
const lean = remainingInputChars({ usedChars: 10_000, reservedOutputTokens: 60_000 });
const heavy = remainingInputChars({ usedChars: 310_000, reservedOutputTokens: 60_000 });
assert('a bigger region leaves less room for page context', heavy < lean);
assert('300k more characters of region costs 300k of budget',
  Math.abs((lean - heavy) - 300_000) < CHARS_PER_TOKEN * 2);

// ── Images are not free just because they are not text ──────────────────────
const noImages = remainingInputChars({ usedChars: 20_000, reservedOutputTokens: 60_000, images: 0 });
const threeImages = remainingInputChars({ usedChars: 20_000, reservedOutputTokens: 60_000, images: 3 });
assert('attachments cost budget', threeImages < noImages);
assert('each attachment costs the same, whatever its file size',
  Math.abs((noImages - threeImages) - 3 * IMAGE_TOKENS * CHARS_PER_TOKEN) < CHARS_PER_TOKEN * 2);

// ── Never returns a negative budget ─────────────────────────────────────────
// A caller doing `text.slice(0, budget)` with a negative number silently sends
// nothing at all, which is the starvation bug wearing a different hat.
const overspent = remainingInputChars({ usedChars: 5_000_000, reservedOutputTokens: 128_000 });
assert('an impossible call reports zero room, never a negative slice',
  overspent === 0);

const exactlyFull = remainingInputChars({
  usedChars: 0,
  reservedOutputTokens: AI_CONTEXT_TOKENS,
});
assert('reserving the whole window for output leaves nothing for input',
  exactlyFull === 0);

// ── Safety headroom is real and adjustable ──────────────────────────────────
const cautious = remainingInputChars({ usedChars: 0, reservedOutputTokens: 0, safetyTokens: 50_000 });
const bold = remainingInputChars({ usedChars: 0, reservedOutputTokens: 0, safetyTokens: 0 });
assert('headroom is reserved for the system prompt and our estimation error',
  cautious < bold);
assert('the default leaves some headroom rather than filling the window',
  remainingInputChars({ usedChars: 0, reservedOutputTokens: 0 }) <
    AI_CONTEXT_TOKENS * CHARS_PER_TOKEN);

// ── A realistic page fits, a huge one degrades rather than exploding ────────
// The point of the whole exercise: an ordinary page should be sent in full,
// and a 10k-line monster should fall back to summaries instead of killing the
// call. Both decided by the same arithmetic.
const typicalPageChars = 90_000;
const monsterPageChars = 450_000;
const editBudget = remainingInputChars({
  usedChars: 25_000,
  reservedOutputTokens: 128_000,
  images: 1,
});
assert('an ordinary page fits inside the budget', typicalPageChars <= editBudget);
assert('a 10k-line page does not, so it degrades to summaries',
  monsterPageChars > editBudget);

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll context-budget behavior checks passed.');

/**
 * Real behavior tests for src/lib/traffic-weights.ts.
 *
 * The incident this guards against: a landing page taking ~$1,000/day of ad
 * spend sat at 100% traffic on a test that also had six old pages parked at
 * 0%. Archiving one of the dead pages rewrote the whole split to an EQUAL
 * share — the money page dropped from 100% to ~14% and ~86% of paid traffic
 * went to pages nobody was testing any more. The same equalization ran on
 * delete, on add, and on un-archive.
 *
 * Every check below is about one promise: a weight change only redistributes
 * the share that actually moved, in proportion to what everyone else already
 * holds. A variant at 0% is never handed traffic by an operation happening
 * somewhere else on the test.
 *
 * Run: node scripts/verify-traffic-weights.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-weights');
const srcFile = join(repoRoot, 'src', 'lib', 'traffic-weights.ts');

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
const {
  scaleToTotal,
  weightForNewVariant,
  weightsAfterRemoval,
  weightsAfterSet,
  validateFullSplit,
} = require(join(outDir, 'traffic-weights.js'));

let failed = 0;
function assert(label, condition) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}

/** [30, 70] -> [{id:'v0',traffic_weight:30}, {id:'v1',traffic_weight:70}] */
function split(...weights) {
  return weights.map((w, i) => ({ id: `v${i}`, traffic_weight: w }));
}

/** Result weights back into the v0,v1,... order so they can be compared. */
function ordered(result, count) {
  if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
  const map = new Map(result.weights.map((w) => [w.id, w.traffic_weight]));
  return Array.from({ length: count }, (_, i) => map.get(`v${i}`));
}

function same(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ── The incident, as a test ────────────────────────────────────────────────
// One page at 100%, six parked at 0%. Archive a parked one. Before the fix
// this produced 14/14/14/14/14/14 and sent 86% of paid traffic to dead pages.
console.log('\nThe production incident:');
{
  const live = split(100, 0, 0, 0, 0, 0, 0);
  const after = ordered(weightsAfterRemoval(live, 'v3'), 7);
  assert('archiving a parked 0% page leaves the money page at 100%', after[0] === 100);
  assert('no traffic leaks to the other parked pages',
    after[1] === 0 && after[2] === 0 && after[4] === 0 && after[5] === 0 && after[6] === 0);
  assert('the archived page is set to 0%', after[3] === 0);
}

// ── Removal: archive and delete ────────────────────────────────────────────
console.log('\nRemoving a variant (archive / delete):');
{
  assert('70/20/10, archive the 10 -> 78/22',
    same(ordered(weightsAfterRemoval(split(70, 20, 10), 'v2'), 3).slice(0, 2), [78, 22]));

  assert('50/50, archive one -> the other takes everything',
    ordered(weightsAfterRemoval(split(50, 50), 'v1'), 2)[0] === 100);

  const ratio = ordered(weightsAfterRemoval(split(60, 20, 20), 'v2'), 3);
  assert('60/20/20, archive a 20 -> 75/25, the 3:1 ratio survives',
    ratio[0] === 75 && ratio[1] === 25);

  const onlyFunded = weightsAfterRemoval(split(100, 0, 0), 'v0');
  assert('archiving the ONLY variant with traffic refuses instead of guessing',
    !onlyFunded.ok && /nowhere for its share to go/.test(onlyFunded.reason));

  const last = weightsAfterRemoval(split(100), 'v0');
  assert('archiving the last active variant refuses', !last.ok);

  const missing = weightsAfterRemoval(split(50, 50), 'nope');
  assert('removing a variant that is not in the active split refuses', !missing.ok);
}

// ── Setting one variant's weight (the inline weight edit) ──────────────────
console.log('\nSetting a weight:');
{
  assert('70/20/10, set the 70 to 50 -> 50/33/17',
    same(ordered(weightsAfterSet(split(70, 20, 10), 'v0', 50), 3), [50, 33, 17]));

  assert('100/0/0, ramp a parked page to 20% -> 80/20/0 (the other parked page stays at 0)',
    same(ordered(weightsAfterSet(split(100, 0, 0), 'v1', 20), 3), [80, 20, 0]));

  assert('setting a variant to 100% zeroes the others',
    same(ordered(weightsAfterSet(split(70, 20, 10), 'v0', 100), 3), [100, 0, 0]));

  const blocked = weightsAfterSet(split(100, 0, 0), 'v0', 50);
  assert('turning the only funded variant down refuses — nowhere for the freed traffic to go',
    !blocked.ok && /Every other variant is at 0%/.test(blocked.reason));

  assert('the refusal tells the user what to do instead',
    /Set the traffic on the variant you want to send it to/.test(blocked.reason));

  assert('a lone variant can only be at 100%', !weightsAfterSet(split(100), 'v0', 60).ok);
  assert('a lone variant set to 100 is fine', weightsAfterSet(split(100), 'v0', 100).ok);
  assert('a fractional weight refuses', !weightsAfterSet(split(50, 50), 'v0', 33.3).ok);
  assert('a weight above 100 refuses', !weightsAfterSet(split(50, 50), 'v0', 140).ok);
}

// ── Adding a variant ───────────────────────────────────────────────────────
console.log('\nAdding a variant:');
{
  // Renny's second ask, and the Unbounce rule: adding never moves traffic.
  // The whole operation is one number, so there is nothing left to get wrong.
  assert('a variant added to a money page at 100% joins at 0%',
    weightForNewVariant(split(100)) === 0);

  assert('a variant added to a 70/30 test joins at 0%',
    weightForNewVariant(split(70, 30)) === 0);

  assert('parked pages on the test make no difference — still 0%',
    weightForNewVariant(split(100, 0, 0)) === 0);

  assert('the first variant on an empty test carries 100%',
    weightForNewVariant([]) === 100);
}

// ── Rounding ───────────────────────────────────────────────────────────────
console.log('\nRounding:');
{
  assert('thirds land on exactly 100',
    ordered(weightsAfterRemoval(split(25, 25, 25, 25), 'v3'), 4)
      .slice(0, 3)
      .reduce((a, b) => a + b, 0) === 100);

  const thirds = ordered(weightsAfterRemoval(split(1, 1, 1, 1), 'v3'), 4).slice(0, 3);
  assert('an even three-way split is 34/33/33, not 33/33/33',
    same(thirds, [34, 33, 33]) && thirds.reduce((a, b) => a + b, 0) === 100);

  assert('scaleToTotal to 0 zeroes everything',
    scaleToTotal(split(70, 30), 0).every((w) => w.traffic_weight === 0));

  assert('scaleToTotal refuses when the group holds no traffic at all',
    scaleToTotal(split(0, 0), 100) === null);

  assert('an empty group scales to an empty result', scaleToTotal([], 100).length === 0);
}

// ── Self-healing on already-broken data ────────────────────────────────────
// Tests written by the old buggy code can have active weights that do not sum
// to 100 (weight leaked onto archived variants). Any operation should put the
// split back to 100 while keeping the surviving ratios.
console.log('\nAlready-corrupted splits:');
{
  const corrupted = split(40, 20, 20); // sums to 80, not 100
  const healed = ordered(weightsAfterRemoval(corrupted, 'v2'), 3);
  assert('a broken 40/20/20 heals to 100 on the next change',
    healed[0] + healed[1] === 100);
  assert('and the 2:1 ratio between the survivors is kept',
    healed[0] === 67 && healed[1] === 33);
}

// ── validateFullSplit: what the API accepts ────────────────────────────────
console.log('\nWeight writes reaching the API:');
{
  const active = ['a', 'b'];
  const w = (id, n) => ({ id, traffic_weight: n });

  assert('the exact active set summing to 100 is accepted',
    validateFullSplit([w('a', 60), w('b', 40)], active).ok);

  assert('a partial set is rejected — it would leave the split off 100',
    !validateFullSplit([w('a', 100)], active).ok);

  const archived = validateFullSplit([w('a', 60), w('archived', 40)], active);
  assert('naming an archived variant is rejected', !archived.ok);
  assert('and says why an archived variant cannot take weight',
    /archived variants always sit at 0%/.test(archived.reason));

  assert('weights that do not sum to 100 are rejected',
    !validateFullSplit([w('a', 60), w('b', 30)], active).ok);

  assert('a duplicated variant id is rejected',
    !validateFullSplit([w('a', 50), w('a', 50)], ['a']).ok);
}

// ── Fuzz: the two invariants, over many random splits ──────────────────────
console.log('\nInvariants over 20,000 random splits:');
{
  let sumBroken = 0;
  let zeroFunded = 0;
  let ratioBroken = 0;
  let addMoved = 0;

  // Deterministic PRNG so a failure is reproducible.
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  for (let iteration = 0; iteration < 20000; iteration++) {
    const count = 2 + rand(6);
    // A realistic live split: whole numbers summing to 100, often with
    // several variants parked at 0.
    const raw = Array.from({ length: count }, () => (rand(4) === 0 ? 0 : 1 + rand(20)));
    const total = raw.reduce((a, b) => a + b, 0);
    const scaled = scaleToTotal(split(...raw), 100);
    if (!scaled) continue;
    const active = scaled;
    if (total === 0) continue;

    const zeros = new Set(active.filter((v) => v.traffic_weight === 0).map((v) => v.id));
    const pick = active[rand(active.length)].id;

    // Adding is not fuzzed as a rebalance because it no longer is one: the
    // new variant joins at 0% and every existing weight is left alone. The
    // only thing to check is that it never claims traffic on a live test.
    if (weightForNewVariant(active) !== 0) addMoved++;

    const results = [
      weightsAfterRemoval(active, pick),
      weightsAfterSet(active, pick, rand(101)),
    ];

    for (const result of results) {
      if (!result.ok) continue;
      const sum = result.weights.reduce((a, b) => a + b.traffic_weight, 0);
      if (sum !== 100) sumBroken++;
      // A parked variant must never be handed traffic — unless it is the very
      // variant the caller explicitly set a weight on.
      for (const wgt of result.weights) {
        if (zeros.has(wgt.id) && wgt.id !== pick && wgt.traffic_weight !== 0) zeroFunded++;
      }
    }

    // Removal keeps the survivors' ratios: scaling back down by the same
    // factor must reproduce the original weights (within rounding).
    const removal = weightsAfterRemoval(active, pick);
    if (removal.ok) {
      const before = new Map(active.map((v) => [v.id, v.traffic_weight]));
      const survivors = removal.weights.filter((v) => v.id !== pick);
      const beforeTotal = survivors.reduce((a, b) => a + before.get(b.id), 0);
      for (const s of survivors) {
        const expected = (before.get(s.id) * 100) / beforeTotal;
        if (Math.abs(expected - s.traffic_weight) > 1) ratioBroken++;
      }
    }
  }

  assert('every accepted result sums to exactly 100', sumBroken === 0);
  assert('adding a variant to a live test never claims traffic', addMoved === 0);
  assert('a variant parked at 0% is never handed traffic by someone else\'s change',
    zeroFunded === 0);
  assert('survivors keep their ratios through a removal (within 1 point of rounding)',
    ratioBroken === 0);
}

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll traffic-weight behavior checks passed.');

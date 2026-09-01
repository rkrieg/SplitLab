#!/usr/bin/env node
/**
 * Read-only audit of live traffic splits.
 *
 * Two questions, asked of real data:
 *
 *  1. Is anything already corrupted? The pre-fix `createVariant` and
 *     `delete_variant_id` paths re-equalized weights across ALL of a test's
 *     variants with no archived filter, so an archive-then-add/delete on the
 *     same test could leave weight sitting on archived variants and the active
 *     split not summing to 100.
 *
 *  2. Does the new logic behave correctly on every split that actually exists?
 *     Every active variant of every test is run through the new
 *     archive/delete/weight calculations as a dry run, and the invariants are
 *     checked against the real shapes rather than invented ones.
 *
 * NOTHING IS WRITTEN. Every statement runs inside `begin read only`, so the
 * database itself rejects any write this script could attempt.
 *
 *   node scripts/audit-traffic-weights.mjs                  # uses DATABASE_URL
 *   node scripts/audit-traffic-weights.mjs --env PROD_DATABASE_URL
 *   node scripts/audit-traffic-weights.mjs --label staging
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const ENV_KEY = arg('env', 'DATABASE_URL');
const LABEL = arg('label', ENV_KEY === 'DATABASE_URL' ? 'database' : ENV_KEY.replace('_DATABASE_URL', '').toLowerCase());

function loadUrl() {
  if (process.env[ENV_KEY]) return process.env[ENV_KEY];
  for (const file of ['.env.local', '.env']) {
    const p = path.join(ROOT, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      // Commented-out entries count: prod is kept commented in .env.local.
      const m = line.match(new RegExp(`^\\s*#?\\s*${ENV_KEY}=(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
    }
  }
  throw new Error(`${ENV_KEY} not found in env, .env.local or .env`);
}

function findPsql() {
  const candidates = [process.env.PSQL, 'psql'];
  for (const v of ['17', '16', '15', '14']) {
    candidates.push(`C:\\Program Files\\PostgreSQL\\${v}\\bin\\psql.exe`);
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {}
  }
  throw new Error('psql not found. Set PSQL=/path/to/psql.exe');
}

// `begin read only` makes this physically incapable of modifying anything.
const AUDIT_SQL = `
begin read only;
select json_build_object(
  'tests', coalesce((select json_agg(row_to_json(x)) from (
    select t.id, t.name, t.status,
           coalesce((select json_agg(json_build_object(
                       'id', v.id,
                       'name', v.name,
                       'weight', v.traffic_weight,
                       'archived', (v.archived_at is not null)
                     ) order by v.created_at)
                     from test_variants v where v.test_id = t.id), '[]'::json) as variants
    from tests t
  ) x), '[]'::json)
);
commit;
`;

const psql = findPsql();
const url = loadUrl();
const host = (url.match(/@([^/:]+)/) ?? [, 'unknown'])[1];

console.log(`\n  Auditing ${LABEL.toUpperCase()}  (${host})`);
console.log('  Read-only transaction — nothing is written.\n');

const raw = execFileSync(
  psql,
  [url, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', AUDIT_SQL],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
);

const payload = JSON.parse(raw.split('\n').map((l) => l.trim()).filter(Boolean).join(''));
const tests = payload.tests ?? [];

// ── Compile the real helper so the dry run uses production code ────────────
const outDir = path.join(ROOT, '.verify-tmp-audit');
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc', path.join(ROOT, 'src', 'lib', 'traffic-weights.ts'),
    '--outDir', outDir,
    '--target', 'es2020', '--module', 'commonjs', '--moduleResolution', 'node',
    '--skipLibCheck', '--downlevelIteration', '--noResolve',
  ],
  { cwd: ROOT, stdio: 'pipe' },
);
const require = createRequire(import.meta.url);
const { weightsAfterRemoval, weightsAfterSet, weightForNewVariant } =
  require(path.join(outDir, 'traffic-weights.js'));

// ── 1. Existing corruption ─────────────────────────────────────────────────
const sumOff = [];
const archivedWithWeight = [];
const allZero = [];
const vulnerableShape = [];

for (const t of tests) {
  const active = t.variants.filter((v) => !v.archived);
  const archived = t.variants.filter((v) => v.archived);
  const total = active.reduce((s, v) => s + v.weight, 0);

  if (active.length > 0 && total !== 100) sumOff.push({ test: t, total });
  const dirty = archived.filter((v) => v.weight > 0);
  if (dirty.length > 0) archivedWithWeight.push({ test: t, variants: dirty });
  if (active.length > 0 && total === 0) allZero.push(t);
  if (active.some((v) => v.weight === 0) && active.some((v) => v.weight > 0)) {
    vulnerableShape.push(t);
  }
}

function describe(t) {
  const active = t.variants.filter((v) => !v.archived);
  const arch = t.variants.filter((v) => v.archived);
  const split = active.map((v) => `${v.name} ${v.weight}%`).join(' / ') || '(none)';
  return `    [${t.status}] ${t.name}\n      active: ${split}${arch.length ? `\n      archived: ${arch.map((v) => `${v.name} ${v.weight}%`).join(' / ')}` : ''}`;
}

console.log(`  ${tests.length} tests, ${tests.reduce((s, t) => s + t.variants.length, 0)} variants\n`);

console.log('  1. Active weights not summing to 100');
if (sumOff.length === 0) console.log('     none — every test\'s live split is intact\n');
else {
  console.log(`     ${sumOff.length} test(s):`);
  for (const { test, total } of sumOff) console.log(`${describe(test)}\n      sums to ${total}, not 100`);
  console.log('');
}

console.log('  2. Archived variants still holding traffic weight');
if (archivedWithWeight.length === 0) console.log('     none — no archived variant can take traffic\n');
else {
  console.log(`     ${archivedWithWeight.length} test(s):`);
  for (const { test, variants } of archivedWithWeight) {
    console.log(`${describe(test)}\n      archived but weighted: ${variants.map((v) => `${v.name} ${v.weight}%`).join(', ')}`);
  }
  console.log('');
}

console.log('  3. Tests where every active variant is at 0% (serve 404 / undefined split)');
if (allZero.length === 0) console.log('     none\n');
else { for (const t of allZero) console.log(describe(t)); console.log(''); }

console.log('  4. Tests in the shape the bug was catastrophic on (funded page + parked 0% pages)');
if (vulnerableShape.length === 0) console.log('     none currently\n');
else {
  console.log(`     ${vulnerableShape.length} test(s) — these were one archive click away from an even split:`);
  for (const t of vulnerableShape) console.log(describe(t));
  console.log('');
}

// ── 2. Dry run of the new logic over every real split ──────────────────────
let checked = 0;
const violations = [];
const refusals = [];

for (const t of tests) {
  const active = t.variants
    .filter((v) => !v.archived)
    .map((v) => ({ id: v.id, traffic_weight: v.weight }));
  if (active.length === 0) continue;

  const nameOf = (id) => t.variants.find((v) => v.id === id)?.name ?? id;
  const zeros = new Set(active.filter((v) => v.traffic_weight === 0).map((v) => v.id));

  const check = (op, result, setId = null) => {
    checked++;
    if (!result.ok) {
      refusals.push({ test: t, op, reason: result.reason });
      return;
    }
    const sum = result.weights.reduce((s, w) => s + w.traffic_weight, 0);
    if (sum !== 100) {
      violations.push(`${t.name}: ${op} produced a split summing to ${sum}`);
    }
    for (const w of result.weights) {
      if (zeros.has(w.id) && w.id !== setId && w.traffic_weight !== 0) {
        violations.push(`${t.name}: ${op} gave traffic to "${nameOf(w.id)}", which is parked at 0%`);
      }
    }
  };

  for (const v of active) {
    check(`archive/delete "${nameOf(v.id)}"`, weightsAfterRemoval(active, v.id));
    for (const w of [0, 10, 50, 100]) {
      check(`set "${nameOf(v.id)}" to ${w}%`, weightsAfterSet(active, v.id, w), v.id);
    }
  }
  // Adding is a single number now, not a rebalance: it must always be 0% on
  // a test that already has active variants, and must move nothing.
  checked++;
  if (weightForNewVariant(active) !== 0) {
    violations.push(`${t.name}: adding a variant would claim live traffic`);
  }
}

console.log(`  5. Dry run of the new logic over every real split (${checked} operations)`);
if (violations.length === 0) {
  console.log('     no invariant violations — every result sums to 100, and no variant');
  console.log('     parked at 0% is ever handed traffic by someone else\'s change\n');
} else {
  console.log(`     ${violations.length} VIOLATION(S):`);
  for (const v of violations.slice(0, 40)) console.log(`       ${v}`);
  console.log('');
}

// Refusals are correct behaviour, but the client will meet them, so name them.
const refusalsByTest = new Map();
for (const r of refusals) {
  if (!refusalsByTest.has(r.test.id)) refusalsByTest.set(r.test.id, { test: r.test, ops: [] });
  refusalsByTest.get(r.test.id).ops.push(r);
}
console.log('  6. Operations the new code will REFUSE (correct, but users will see these)');
if (refusalsByTest.size === 0) console.log('     none\n');
else {
  console.log(`     ${refusalsByTest.size} test(s) have at least one blocked operation:`);
  for (const { test, ops } of refusalsByTest.values()) {
    const kinds = new Set(ops.map((o) => o.reason));
    console.log(`${describe(test)}`);
    for (const k of kinds) console.log(`      → ${k}`);
  }
  console.log('');
}

rmSync(outDir, { recursive: true, force: true });

// Distinct tests — one test can appear in more than one category.
const corrupted = new Set([
  ...sumOff.map((s) => s.test.id),
  ...archivedWithWeight.map((a) => a.test.id),
  ...allZero.map((t) => t.id),
]).size;
console.log('  ─────────────────────────────────────────────────────────');
console.log(`  ${LABEL.toUpperCase()}: ${corrupted === 0 ? 'no corrupted splits found' : `${corrupted} test(s) need repair`}`);
console.log(`  new logic: ${violations.length === 0 ? 'correct on all real data' : `${violations.length} violations`}`);
console.log('  ─────────────────────────────────────────────────────────\n');

if (violations.length > 0) process.exit(1);

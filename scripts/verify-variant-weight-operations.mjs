/**
 * End-to-end behavior tests for the weight-changing operations in
 * src/lib/services/tests.ts — archive, un-archive, delete, add, and direct
 * weight writes — run against an in-memory stand-in for the Supabase client.
 *
 * verify-traffic-weights.mjs proves the arithmetic. This proves the wiring:
 * that each operation actually loads the ACTIVE variants, calls the right
 * calculation, and writes back exactly the rows it should. The production
 * incident was not a maths error — the maths was never consulted. Every
 * operation ran its own equal-split loop, and one of them (add) did not even
 * filter out archived variants.
 *
 * Run: node scripts/verify-variant-weight-operations.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import Module from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-ops');
const tsconfigPath = join(repoRoot, '.verify-tmp-ops.tsconfig.json');

for (const path of [outDir, tsconfigPath]) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

writeFileSync(
  tsconfigPath,
  JSON.stringify({
    compilerOptions: {
      outDir: '.verify-tmp-ops',
      rootDir: 'src',
      target: 'es2020',
      module: 'commonjs',
      moduleResolution: 'node',
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      downlevelIteration: true,
      strict: false,
      noEmitOnError: false,
      baseUrl: '.',
      paths: { '@/*': ['src/*'] },
    },
    files: ['src/lib/services/tests.ts'],
  }),
);

try {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', tsconfigPath],
    { cwd: repoRoot, stdio: 'pipe' },
  );
} catch (err) {
  // Type errors in unrelated transitively-imported files must not stop the
  // run — the emit still happened. A missing emit is caught by the require
  // below.
  if (!existsSync(join(outDir, 'lib', 'services', 'tests.js'))) {
    console.error(String(err.stdout ?? err));
    throw new Error('tsc produced no output for services/tests.ts');
  }
}

// The emitted JS keeps the "@/..." specifiers, so resolve them into outDir.
const compiledRoot = join(outDir, 'lib');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/lib/')) {
    return originalResolve.call(this, join(compiledRoot, request.slice('@/lib/'.length)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);

// ── In-memory stand-in for the Supabase query builder ──────────────────────
// Only the query shapes services/tests.ts actually issues.
let tables = {};

function matches(row, filters) {
  return filters.every((f) => {
    if (f.op === 'eq') return row[f.col] === f.val;
    if (f.op === 'neq') return row[f.col] !== f.val;
    if (f.op === 'is') return (row[f.col] ?? null) === f.val;
    if (f.op === 'in') return f.val.includes(row[f.col]);
    if (f.op === 'notIn') return !f.val.includes(row[f.col]);
    return true;
  });
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.mode = 'select';
    this.cols = '*';
    this.payload = null;
    this.orderCol = null;
    this.limitN = null;
  }
  select(cols = '*', opts) {
    if (this.mode === 'insert' || this.mode === 'update' || this.mode === 'delete') {
      this.returning = true;
      return this;
    }
    this.mode = 'select';
    this.cols = cols;
    this.head = !!opts?.head;
    return this;
  }
  insert(payload) { this.mode = 'insert'; this.payload = payload; return this; }
  update(payload) { this.mode = 'update'; this.payload = payload; return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(col, val) { this.filters.push({ op: 'eq', col, val }); return this; }
  neq(col, val) { this.filters.push({ op: 'neq', col, val }); return this; }
  is(col, val) { this.filters.push({ op: 'is', col, val }); return this; }
  in(col, val) { this.filters.push({ op: 'in', col, val }); return this; }
  not(col, op, val) {
    // Only the `.not('id', 'in', '("a","b")')` form is used.
    const ids = String(val).replace(/[()"]/g, '').split(',').filter(Boolean);
    this.filters.push({ op: 'notIn', col, val: ids });
    return this;
  }
  order(col, opts) { this.orderCol = { col, ascending: opts?.ascending !== false }; return this; }
  limit(n) { this.limitN = n; return this; }

  run() {
    const rows = tables[this.table] ?? (tables[this.table] = []);

    if (this.mode === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      const created = incoming.map((row) => ({
        id: row.id ?? `generated-${Math.random().toString(16).slice(2)}`,
        created_at: new Date(Date.now() + rows.length).toISOString(),
        ...row,
      }));
      rows.push(...created);
      return { data: created, error: null };
    }

    let hit = rows.filter((r) => matches(r, this.filters));

    if (this.mode === 'update') {
      for (const row of hit) Object.assign(row, this.payload);
      return { data: hit, error: null };
    }
    if (this.mode === 'delete') {
      tables[this.table] = rows.filter((r) => !hit.includes(r));
      return { data: hit, error: null };
    }

    if (this.orderCol) {
      const { col, ascending } = this.orderCol;
      hit = [...hit].sort((a, b) =>
        (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (ascending ? 1 : -1),
      );
    }
    if (this.limitN != null) hit = hit.slice(0, this.limitN);
    if (this.head) return { data: null, count: hit.length, error: null };

    // Nested relation selects, e.g. '*, test_variants(*, pages(id, name))'
    const withRelations = hit.map((row) => {
      const out = { ...row };
      if (this.table === 'tests' && this.cols.includes('test_variants(')) {
        out.test_variants = (tables.test_variants ?? [])
          .filter((v) => v.test_id === row.id)
          .map((v) => ({ ...v, pages: (tables.pages ?? []).find((p) => p.id === v.page_id) ?? null }));
      }
      if (this.table === 'tests' && this.cols.includes('conversion_goals(')) {
        out.conversion_goals = (tables.conversion_goals ?? []).filter((g) => g.test_id === row.id);
      }
      return out;
    });
    return { data: withRelations, count: withRelations.length, error: null };
  }

  single() {
    const res = this.run();
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    return Promise.resolve(
      row ? { data: row, error: null } : { data: null, error: { message: 'No rows' } },
    );
  }
  maybeSingle() {
    const res = this.run();
    const row = Array.isArray(res.data) ? res.data[0] : res.data;
    return Promise.resolve({ data: row ?? null, error: null });
  }
  then(resolve, reject) {
    try {
      const res = this.run();
      return Promise.resolve(res).then(resolve, reject);
    } catch (err) {
      return Promise.reject(err).then(resolve, reject);
    }
  }
}

const fakeDb = { from: (table) => new Query(table) };

// Stub the modules that talk to the outside world, before tests.js loads.
function stub(specifier, exports) {
  const resolved = originalResolve.call(Module, join(compiledRoot, specifier), { paths: [compiledRoot] });
  const mod = new Module(resolved);
  mod.filename = resolved;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[resolved] = mod;
}

stub('supabase-server.js', { db: fakeDb });
stub('storage.js', {
  uploadHtml: async () => 'https://example.test/page.html',
  downloadHtml: async () => '<html></html>',
  inlineDataUrisToStorage: async (html) => html,
  downloadHtmlByPath: async () => '<html></html>',
  fileNameFromUrl: () => 'file.html',
});
stub('ai-asset-integrity.js', { takeOwnershipOfHtmlAssets: async (html) => ({ html }) });
stub('page-drafts.js', { getLinkedVariant: async () => null });
stub('services/scan.js', { rescanVariantHtml: async () => {} });

const { updateTest, createVariant } = require(join(compiledRoot, 'services', 'tests.js'));

let failed = 0;
function assert(label, condition) {
  if (condition) console.log(`  ok   ${label}`);
  else { failed++; console.error(`  FAIL ${label}`); }
}

const TEST_ID = 'test-1';
const TEST_META = { workspace_id: 'ws-1', url_path: '/lp', status: 'active' };

/** Seeds a test whose variants are given as [name, weight, archived?]. */
function seed(variants) {
  tables = {
    tests: [{ id: TEST_ID, workspace_id: 'ws-1', url_path: '/lp', status: 'active', scan_results: null }],
    test_variants: variants.map(([name, weight, archived], i) => ({
      id: name,
      test_id: TEST_ID,
      name,
      traffic_weight: weight,
      archived_at: archived ? '2026-01-01T00:00:00.000Z' : null,
      page_id: null,
      redirect_url: 'https://example.test/',
      created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
    })),
    pages: [],
    conversion_goals: [],
  };
}

/** Current weights as { name: weight }. */
function weights() {
  return Object.fromEntries(tables.test_variants.map((v) => [v.id, v.traffic_weight]));
}
function isArchived(id) {
  return !!tables.test_variants.find((v) => v.id === id)?.archived_at;
}
function sameWeights(actual, expected) {
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every((k) => actual[k] === expected[k]);
}

// ── The production incident, through the real service function ─────────────
console.log('\nArchiving, as it happened in production:');
{
  seed([['money', 100], ['old-a', 0], ['old-b', 0], ['old-c', 0], ['old-d', 0], ['old-e', 0], ['old-f', 0]]);
  const result = await updateTest(TEST_ID, TEST_META, { archive_variant_id: 'old-c' });

  assert('the archive succeeds', result.ok);
  assert('the $1,000/day page is STILL at 100% (was 14% before the fix)',
    weights().money === 100);
  assert('every other parked page is still at 0%',
    sameWeights(weights(), {
      money: 100, 'old-a': 0, 'old-b': 0, 'old-c': 0, 'old-d': 0, 'old-e': 0, 'old-f': 0,
    }));
  assert('the archived page is marked archived', isArchived('old-c'));
}

console.log('\nArchiving a variant that does hold traffic:');
{
  seed([['a', 70], ['b', 20], ['c', 10]]);
  const result = await updateTest(TEST_ID, TEST_META, { archive_variant_id: 'c' });
  assert('70/20/10, archive the 10 -> 78/22', result.ok && sameWeights(weights(), { a: 78, b: 22, c: 0 }));
  assert('the archived variant is left at 0%', weights().c === 0);
}
{
  seed([['a', 100], ['b', 0]]);
  const result = await updateTest(TEST_ID, TEST_META, { archive_variant_id: 'a' });
  assert('archiving the only funded variant is refused', !result.ok);
  assert('and nothing at all was written', !isArchived('a') && sameWeights(weights(), { a: 100, b: 0 }));
}
{
  seed([['a', 100], ['b', 0, true]]);
  const result = await updateTest(TEST_ID, TEST_META, { archive_variant_id: 'a' });
  assert('archiving the last ACTIVE variant is refused even with archived ones present', !result.ok);
  assert('and the live variant is untouched', !isArchived('a') && weights().a === 100);
}

console.log('\nUn-archiving:');
{
  seed([['money', 100], ['old', 0, true]]);
  const result = await updateTest(TEST_ID, TEST_META, { unarchive_variant_id: 'old' });
  assert('the restore succeeds', result.ok);
  assert('it comes back at 0% and the live page keeps 100%',
    sameWeights(weights(), { money: 100, old: 0 }));
  assert('it is no longer archived', !isArchived('old'));
}

console.log('\nDeleting:');
{
  seed([['money', 100], ['old-a', 0], ['old-b', 0]]);
  const result = await updateTest(TEST_ID, TEST_META, { delete_variant_id: 'old-b' });
  assert('deleting a parked page succeeds', result.ok);
  assert('and moves no traffic', sameWeights(weights(), { money: 100, 'old-a': 0 }));
}
{
  seed([['a', 70], ['b', 20], ['c', 10]]);
  const result = await updateTest(TEST_ID, TEST_META, { delete_variant_id: 'c' });
  assert('70/20/10, delete the 10 -> 78/22', result.ok && sameWeights(weights(), { a: 78, b: 22 }));
}
{
  seed([['a', 100], ['b', 0]]);
  const result = await updateTest(TEST_ID, TEST_META, { delete_variant_id: 'a' });
  assert('deleting the only funded variant is refused', !result.ok);
  assert('and the variant still exists, untouched',
    tables.test_variants.length === 2 && weights().a === 100);
}
{
  // An archived variant holds no traffic, so deleting it must not rebalance.
  seed([['money', 100], ['old', 0, true]]);
  const result = await updateTest(TEST_ID, TEST_META, { delete_variant_id: 'old' });
  assert('deleting an archived variant succeeds and moves no traffic',
    result.ok && sameWeights(weights(), { money: 100 }));
}

console.log('\nAdding a variant:');
{
  seed([['money', 100], ['old', 0]]);
  const result = await createVariant(TEST_ID, 'ws-1', 'admin', {
    name: 'New', redirect_url: 'https://example.test/new',
  });
  const added = tables.test_variants.find((v) => v.name === 'New');
  assert('adding a variant succeeds', result.ok);
  assert('the new variant joins at 0%', added.traffic_weight === 0);
  assert('and the live split is left completely alone',
    weights().money === 100 && weights().old === 0);
}
{
  // The page taking $1,000/day of ad spend. Adding must not cost it a point.
  seed([['money', 60], ['challenger', 40]]);
  await createVariant(TEST_ID, 'ws-1', 'admin', {
    name: 'New', redirect_url: 'https://example.test/new',
  });
  const after = weights();
  assert('a funded 60/40 split is untouched by an add',
    after.money === 60 && after.challenger === 40);
  assert('the active weights still sum to 100',
    tables.test_variants
      .filter((v) => !v.archived_at)
      .reduce((sum, v) => sum + v.traffic_weight, 0) === 100);
}
{
  // The old code re-equalized across ALL variants, archived ones included,
  // handing traffic to a page deliberately pulled out of the test.
  seed([['money', 100], ['archived-old', 0, true]]);
  await createVariant(TEST_ID, 'ws-1', 'admin', {
    name: 'New', redirect_url: 'https://example.test/new',
  });
  assert('adding a variant never gives an ARCHIVED variant traffic',
    weights()['archived-old'] === 0);
  assert('and the money page keeps all 100%', weights().money === 100);
}

console.log('\nHand-adjusted splits from the confirm dialog:');
{
  // The dialog proposes a proportional split, but the user overrides it.
  // Their numbers win, as long as they cover the survivors and total 100.
  seed([['money', 60], ['b', 30], ['c', 10]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    archive_variant_id: 'c',
    remaining_weights: [{ id: 'money', traffic_weight: 90 }, { id: 'b', traffic_weight: 10 }],
  });
  assert('an archive with hand-adjusted weights succeeds', result.ok);
  assert('the typed split is written, not the proportional one',
    sameWeights(weights(), { money: 90, b: 10, c: 0 }));
  assert('and the archived variant is out of the split',
    tables.test_variants.find((v) => v.id === 'c').archived_at !== null);
}
{
  seed([['money', 60], ['b', 30], ['c', 10]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    delete_variant_id: 'c',
    remaining_weights: [{ id: 'money', traffic_weight: 75 }, { id: 'b', traffic_weight: 25 }],
  });
  assert('a delete with hand-adjusted weights succeeds', result.ok);
  assert('the typed split is written', sameWeights(weights(), { money: 75, b: 25 }));
}
{
  // The dialog disables Apply below/above 100, but the API is the real guard.
  seed([['money', 60], ['b', 30], ['c', 10]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    archive_variant_id: 'c',
    remaining_weights: [{ id: 'money', traffic_weight: 50 }, { id: 'b', traffic_weight: 30 }],
  });
  assert('a hand-adjusted split that sums to 80 is refused', !result.ok);
  assert('and nothing was archived or rewritten',
    sameWeights(weights(), { money: 60, b: 30, c: 10 })
      && tables.test_variants.find((v) => v.id === 'c').archived_at === null);
}
{
  seed([['money', 60], ['b', 30], ['c', 10]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    archive_variant_id: 'c',
    remaining_weights: [{ id: 'money', traffic_weight: 100 }],
  });
  assert('a hand-adjusted split missing a surviving variant is refused', !result.ok);
  assert('and the test is untouched', sameWeights(weights(), { money: 60, b: 30, c: 10 }));
}
{
  seed([['money', 60], ['b', 30], ['c', 10]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    archive_variant_id: 'c',
    remaining_weights: [
      { id: 'money', traffic_weight: 50 },
      { id: 'b', traffic_weight: 30 },
      { id: 'c', traffic_weight: 20 },
    ],
  });
  assert('a hand-adjusted split naming the variant being archived is refused', !result.ok);
  assert('so an archived page can never keep traffic',
    sameWeights(weights(), { money: 60, b: 30, c: 10 }));
}
{
  // The case the old code refused outright: the variant leaving owns all the
  // traffic. With an editable dialog the user just says where it goes.
  seed([['money', 100], ['parked', 0]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    archive_variant_id: 'money',
    remaining_weights: [{ id: 'parked', traffic_weight: 100 }],
  });
  assert('archiving the only funded variant works when the split is given', result.ok);
  assert('the traffic lands where the user put it',
    sameWeights(weights(), { money: 0, parked: 100 }));
}

console.log('\nDirect weight writes (dashboard + MCP):');
{
  seed([['a', 70], ['b', 30]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    weights: [{ id: 'a', traffic_weight: 50 }, { id: 'b', traffic_weight: 50 }],
  });
  assert('a complete, valid split is written', result.ok && sameWeights(weights(), { a: 50, b: 50 }));
}
{
  seed([['a', 70], ['b', 30]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    weights: [{ id: 'a', traffic_weight: 100 }],
  });
  assert('a partial set is refused', !result.ok);
  assert('and nothing was written', sameWeights(weights(), { a: 70, b: 30 }));
}
{
  seed([['a', 100], ['archived', 0, true]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    weights: [{ id: 'a', traffic_weight: 60 }, { id: 'archived', traffic_weight: 40 }],
  });
  assert('weights naming an archived variant are refused', !result.ok);
  assert('so an archived page can never be handed live traffic',
    sameWeights(weights(), { a: 100, archived: 0 }));
}
{
  seed([['a', 70], ['b', 30]]);
  const result = await updateTest(TEST_ID, TEST_META, {
    weights: [{ id: 'a', traffic_weight: 60 }, { id: 'b', traffic_weight: 30 }],
  });
  assert('a split that does not sum to 100 is refused', !result.ok);
}

rmSync(outDir, { recursive: true, force: true });
rmSync(tsconfigPath, { force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll variant weight-operation checks passed.');

/**
 * Real behavior tests for the AI credit meter in src/lib/ai-usage.ts.
 *
 * The bug this guards against: prepaid top-ups were summed with
 * `created_at >= period_start`, so credits a customer PAID for silently
 * disappeared at the end of the calendar month they were bought in. Someone
 * buying $500 of credits on the 28th lost them three days later, unused.
 *
 * The promise now: plan credits reset every month, purchased credits never do.
 * Spending draws plan allowance first, then the prepaid balance, and only what
 * neither covers is overage. Every check below is about that ordering holding
 * at its boundaries — the moment the plan runs out, the moment the balance
 * does, and the moment the spend cap does.
 *
 * Run: node scripts/verify-ai-credits.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import Module from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-credits');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-usage.ts');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

// Compiles this one file in isolation, so its '@/...' imports are unresolvable
// and tsc exits non-zero on TS2307. It still emits the JS, which is all we
// need — the imports are replaced with stubs below. Type errors are caught by
// the project-wide `npx tsc --noEmit`, not here.
try {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'tsc', srcFile,
      '--outDir', outDir,
      '--target', 'es2020',
      '--module', 'commonjs',
      '--moduleResolution', 'node',
      '--skipLibCheck',
      '--noResolve',
    ],
    { cwd: repoRoot, stdio: 'pipe' },
  );
} catch { /* TS2307 on the aliased imports — expected, see above */ }

if (!existsSync(join(outDir, 'ai-usage.js'))) {
  console.error('tsc produced no output for ai-usage.ts — cannot run checks.');
  process.exit(1);
}

const TOKENS_PER_CREDIT = 1000;
const AI_CREDITS = { free: 0, pro: 0, growth: 2000, agency: 5000, scale: 15000 };

// ── Fake database ───────────────────────────────────────────────────────────
// One response object per table. Terminal calls (.maybeSingle/.single) and
// awaiting the chain directly both resolve to it, which is enough to drive
// every read the summary and the gate make.
let responses = {};
function makeChain(table) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    insert: async () => ({ error: null }),
    maybeSingle: async () => responses[table] ?? { data: null, error: null },
    single: async () => responses[table] ?? { data: null, error: null },
    then: (ok, no) => Promise.resolve(responses[table] ?? { data: [], error: null }).then(ok, no),
  };
  return chain;
}
const db = { from: makeChain, rpc: async () => ({ error: null }) };

// The compiled file still imports by '@/...' alias (compiled with --noResolve),
// so hand it stubs instead of the real Supabase client and plan table.
const stubs = {
  '@/lib/supabase-server': { db },
  '@/lib/plans': {
    TOKENS_PER_CREDIT,
    aiCreditsForPlan: (plan) => AI_CREDITS[plan] ?? 0,
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const {
  getAiUsageSummary,
  checkAiAllowance,
  imageCostMicros,
  imageTokenEquivalent,
  creditsForCents,
  IMAGE_CREDITS,
  softCapBody,
} = require(join(outDir, 'ai-usage.js'));

let failed = 0;
function assert(label, condition) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}
function eq(label, actual, expected) {
  assert(`${label} (got ${actual}, want ${expected})`, actual === expected);
}

/**
 * Point the fake DB at one scenario.
 *   used    - tokens spent this month
 *   drawn   - prepaid tokens already consumed this month
 *   balance - prepaid tokens still unspent (the part that rolls over)
 */
function scenario({ used = 0, drawn = 0, balance = 0, overageMicros = 0, overageOn = false, cap = 5000 } = {}) {
  responses = {
    ai_usage_monthly: {
      data: { tokens: used, overage_cost_micros: overageMicros, topup_tokens_drawn: drawn },
      error: null,
    },
    users: {
      data: {
        ai_topup_tokens: balance,
        ai_overage_enabled: overageOn,
        ai_overage_cap_cents: cap,
        plan: 'growth',
      },
      error: null,
    },
  };
}

const M = 1_000_000;
const run = [];

run.push(async () => {
  console.log('\nplan allowance, nothing purchased');
  scenario({ used: 500_000 });
  const s = await getAiUsageSummary('owner', 'growth');
  eq('credits included', s.creditsIncluded, 2000);
  eq('credits used', s.creditsUsed, 500);
  eq('tokens remaining', s.tokensRemaining, 1_500_000);
  eq('no overage yet', s.overageTokens, 0);
  const gate = await checkAiAllowance('owner', 'growth');
  assert('allowed inside the plan allowance', gate.allowed && gate.reason === 'ok');
});

run.push(async () => {
  console.log('\nTHE REGRESSION: credits bought in an earlier month still spend');
  // Plan fully spent, 500 prepaid credits left over from a previous month.
  // Under the old month-scoped rule this balance was invisible and the user
  // was blocked despite having paid for credits.
  scenario({ used: 2 * M, drawn: 0, balance: 500_000 });
  const s = await getAiUsageSummary('owner', 'growth');
  eq('included covers the rolled-over balance', s.creditsIncluded, 2500);
  eq('used', s.creditsUsed, 2000);
  assert('not treated as exhausted', s.creditsUsed < s.creditsIncluded);
  const gate = await checkAiAllowance('owner', 'growth');
  assert('still allowed to build', gate.allowed && gate.reason === 'ok');
});

run.push(async () => {
  console.log('\nprepaid balance partly spent this month');
  scenario({ used: 2.5 * M, drawn: 500_000, balance: 500_000 });
  const s = await getAiUsageSummary('owner', 'growth');
  // plan 2,000,000 + drawn 500,000 + remaining 500,000
  eq('included', s.creditsIncluded, 3000);
  eq('used', s.creditsUsed, 2500);
  eq('prepaid still unspent', s.topupCredits, 500);
  eq('prepaid spent this month', s.topupCreditsDrawn, 500);
  eq('nothing is overage yet', s.overageTokens, 0);
});

run.push(async () => {
  console.log('\neverything spent, overage off');
  scenario({ used: 3 * M, drawn: 1 * M, balance: 0 });
  const s = await getAiUsageSummary('owner', 'growth');
  eq('included', s.creditsIncluded, 3000);
  assert('reads as exhausted', s.creditsUsed >= s.creditsIncluded);
  const gate = await checkAiAllowance('owner', 'growth');
  assert('blocked with a soft cap', !gate.allowed && gate.reason === 'over_allowance');
});

run.push(async () => {
  console.log('\noverage on');
  scenario({ used: 3.2 * M, drawn: 1 * M, balance: 0, overageMicros: 400_000, overageOn: true, cap: 5000 });
  const s = await getAiUsageSummary('owner', 'growth');
  eq('overage tokens are only what credits did not cover', s.overageTokens, 200_000);
  eq('overage cost in cents', s.overageCostCents, 40);
  const under = await checkAiAllowance('owner', 'growth');
  assert('allowed while under the spend cap', under.allowed && under.reason === 'ok');

  scenario({ used: 3.2 * M, drawn: 1 * M, balance: 0, overageMicros: 60_000_000, overageOn: true, cap: 5000 });
  const at = await checkAiAllowance('owner', 'growth');
  assert('blocked at the spend cap', !at.allowed && at.reason === 'over_cap');
});

run.push(async () => {
  console.log('\nplan with no AI and no balance');
  scenario({ used: 0, balance: 0 });
  const gate = await checkAiAllowance('owner', 'pro');
  assert('blocked as no_ai', !gate.allowed && gate.reason === 'no_ai');

  // But a leftover balance from a downgrade is still theirs to spend.
  scenario({ used: 0, balance: 200_000 });
  const withBalance = await checkAiAllowance('owner', 'pro');
  assert('purchased credits survive a downgrade', withBalance.allowed);
});

run.push(async () => {
  console.log('\nprepaid balance is never negative on the meter');
  scenario({ used: 4 * M, drawn: 1 * M, balance: 0 });
  const s = await getAiUsageSummary('owner', 'growth');
  eq('remaining floors at zero', s.tokensRemaining, 0);
  assert('percent used goes past 100 rather than wrapping', s.percentUsed > 100);
});

run.push(async () => {
  console.log('\ngenerated images');
  eq('high quality cost (micro-$)', imageCostMicros('high'), 167_000);
  eq('high quality credits', IMAGE_CREDITS.high, 13);
  eq('high quality charged as tokens', imageTokenEquivalent('high'), 13_000);
  eq('unknown quality falls back to high, never free', imageTokenEquivalent('bogus'), 13_000);
  assert('an image costs us less than it charges', imageCostMicros('high') / 1e6 < (IMAGE_CREDITS.high * 5) / 100);
});

run.push(async () => {
  console.log('\nwho the soft-cap upsell is addressed to');
  // AI usage is billed to the client owner, so whoever hits the cap is often not
  // the account being charged. Only someone allowed to spend on that account may
  // be offered the buy / enable-overage buttons — otherwise they pay into their
  // own balance while the gate keeps reading the owner's, and stay blocked.
  const capGate = {
    reason: 'over_allowance',
    summary: { creditsUsed: 10, creditsIncluded: 10 },
    overage: { enabled: false, capCents: 5000 },
  };
  const acctOwner = { id: 'owner-1', name: 'Birsted Agency' };

  const asOwner = softCapBody(capGate, acctOwner, { id: 'owner-1', role: 'manager' });
  assert('owner is told the credits are their own', asOwner.owner.isSelf === true);
  assert('owner may buy credits', asOwner.owner.canManage === true);

  const asMember = softCapBody(capGate, acctOwner, { id: 'member-9', role: 'manager' });
  assert('invited member is not the billed account', asMember.owner.isSelf === false);
  assert('invited member may not spend the owner money', asMember.owner.canManage === false);
  eq('invited member is told whose account it is', asMember.owner.name, 'Birsted Agency');

  const asAdmin = softCapBody(capGate, acctOwner, { id: 'staff-1', role: 'admin' });
  assert('platform admin may act for the owner', asAdmin.owner.canManage === true);

  const noOwner = softCapBody(capGate, { id: null, name: null }, { id: 'member-9', role: 'manager' });
  assert('unknown owner never counts as self', noOwner.owner.isSelf === false);
  assert('unknown owner does not unlock spending', noOwner.owner.canManage === false);

  const overCap = softCapBody({ ...capGate, reason: 'over_cap' }, acctOwner, { id: 'owner-1', role: 'manager' });
  assert('cap reason still reaches the editor', overCap.reason === 'over_cap');
  assert('soft-cap flag still set', overCap.softCap === true);
});

run.push(async () => {
  console.log('\ntop-up pricing');
  eq('$50 buys 1,000 credits', creditsForCents(5000), 1000);
  eq('$500 buys 10,000 credits', creditsForCents(50000), 10000);
});

for (const t of run) await t();

Module._load = origLoad;
rmSync(outDir, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll AI credit checks passed.' : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);

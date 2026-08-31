/**
 * Tests for the shared capability list and the "this is platform, not a page
 * edit" routing outcome.
 *
 * The point of the change is that two consumers — the intent classifier and the
 * question-answering prompt — stop keeping their own hand-written copies of
 * "what SplitLab can do" and read one file instead. So the checks that matter
 * are not "does the file exist" but:
 *
 *   1. Does the text the model ACTUALLY RECEIVES contain the shared list? A
 *      template literal pasted as a plain string would leave a literal
 *      "${PLATFORM_BEHAVIOURS}" sitting in the prompt and no compiler would
 *      notice. To test that honestly this stubs askAIStream and runs the real
 *      classifyEditIntent, then reads the system prompt it was handed.
 *
 *   2. Can the new flag ever swallow a real edit? That is the whole risk of
 *      adding a third outcome — an over-eager "that's platform behaviour"
 *      silently declining a change someone asked for. The guard is that
 *      platformRequest is forced false whenever asks[] is non-empty, and that
 *      is asserted directly, including for a model answer that contradicts
 *      itself.
 *
 *   3. Did anything ELSE in either prompt change? Both are long and
 *      load-bearing. Every pre-existing field meaning and paragraph is
 *      spot-checked for still being there.
 *
 * ai-edit-intent.ts pulls in the AI client, which would drag the whole app into
 * this script, so ai-client and ai-usage are replaced with stubs below. Nothing
 * under test lives in them: askAI/askAIStream are the network calls, and
 * ai-usage is imported for its type only. ai-page-requirements and
 * ai-content-placement are compiled for real — normalizeIntent calls into the
 * first one.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-platform-caps');
const stageDir = join(outDir, 'src');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const readSrc = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

// Real sources, with the `@/` alias rewritten to a sibling path (the alias
// lives in tsconfig paths; resolving it here would pull in the whole app).
for (const f of [
  'platform-capabilities.ts',
  'ai-edit-intent.ts',
  'ai-page-requirements.ts',
  'ai-content-placement.ts',
]) {
  writeFileSync(join(stageDir, f), readSrc(`src/lib/${f}`).replace(/@\/lib\//g, './'));
}

// Stubs for the two the classifier only reaches through the network / types.
writeFileSync(
  join(stageDir, 'ai-client.ts'),
  [
    'export type AIContentBlock = { type: string; url?: string; text?: string };',
    'export type AIContent = string | AIContentBlock[];',
    'export const __calls: Array<Record<string, unknown>> = [];',
    "let __reply = '{}';",
    'export function __setReply(r: string) { __reply = r; }',
    'export async function askAI(o: Record<string, unknown>): Promise<string> { __calls.push(o); return __reply; }',
    'export async function askAIStream(o: Record<string, unknown>, _cb: (s: string) => void): Promise<string> {',
    '  __calls.push(o);',
    '  return __reply;',
    '}',
    '',
  ].join('\n'),
);
writeFileSync(join(stageDir, 'ai-usage.ts'), 'export interface UsageContext { [k: string]: unknown }\n');

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(stageDir, 'platform-capabilities.ts'),
    join(stageDir, 'ai-edit-intent.ts'),
    '--outDir', join(outDir, 'js'),
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--strict',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const caps = require(join(outDir, 'js', 'platform-capabilities.js'));
const intentMod = require(join(outDir, 'js', 'ai-edit-intent.js'));
const client = require(join(outDir, 'js', 'ai-client.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const routeSrc = readSrc('src/app/api/pages/[id]/follow-up/route.ts');
const intentSrc = readSrc('src/lib/ai-edit-intent.ts');

// ── 1. The list itself ───────────────────────────────────────────────────────
console.log('\n── the capability list ──');

for (const k of ['BUILDER_CAPABILITIES', 'PLATFORM_BEHAVIOURS', 'NOT_SUPPORTED']) {
  assert(`${k} is a non-empty string`, typeof caps[k] === 'string' && caps[k].trim().length > 50);
}
const block = caps.buildCapabilityBlock();
assert('buildCapabilityBlock() includes the builder list verbatim', block.includes(caps.BUILDER_CAPABILITIES));
assert('buildCapabilityBlock() includes the platform list verbatim', block.includes(caps.PLATFORM_BEHAVIOURS));
assert('buildCapabilityBlock() includes the not-supported list verbatim', block.includes(caps.NOT_SUPPORTED));
assert('buildCapabilityBlock() has no unresolved template placeholder', !block.includes('${'));

// The content the whole exercise was for: what was missing before.
for (const [what, needle] of [
  ['UTM capture', 'utm_'],
  ['click IDs', 'gclid'],
  ['the 90-day memory', '90 days'],
  ['embedded booking widgets', 'Calendly'],
  ['the per-test off switch', 'UTM & ad-click forwarding'],
  ['the JavaScript-redirect exception', 'running JavaScript'],
  ['the same-site frame exception', 'SAME site'],
  ['the deliberate opt-out', 'data-sl-no-params'],
  ['A/B splitting', 'traffic weights'],
  ['custom domains', 'custom domains'],
  ['lead capture', 'captured into SplitLab'],
  ['lead forwarding', 'HubSpot'],
]) {
  assert(`platform list documents ${what}`, caps.PLATFORM_BEHAVIOURS.includes(needle));
}

// ── 2. No second copy left behind ────────────────────────────────────────────
console.log('\n── one list, not two ──');

assert('follow-up route imports the shared list', routeSrc.includes("from '@/lib/platform-capabilities'"));
assert('follow-up route interpolates it into the answer prompt', routeSrc.includes('${buildCapabilityBlock()}'));
for (const bullet of [
  'Generate real photography for sections via AI image generation.',
  'Add brand-new sections, remove sections, reorder sections.',
  'What it CANNOT do yet:',
]) {
  assert(`the old hand-written bullet is gone from the route: "${bullet.slice(0, 40)}"`, !routeSrc.includes(bullet));
}
assert('classifier imports the shared platform list', intentSrc.includes("from './platform-capabilities'"));
assert('classifier does not hand-copy the platform text', !intentSrc.includes('remembered for 90 days'));

// ── 3. What the model is actually handed ─────────────────────────────────────
console.log('\n── the real system prompt ──');

async function classify(reply, prompt = 'hello') {
  client.__setReply(reply);
  client.__calls.length = 0;
  const intent = await intentMod.classifyEditIntent({
    prompt,
    sectionNames: ['hero', 'faq'],
    label: 'verify',
  });
  return { intent, system: String(client.__calls[0]?.system ?? '') };
}

const base = await classify('{"is_question":false,"asks":[{"instruction":"x","sections":["hero"],"op":"edit"}]}');
assert('the classifier prompt carries the shared platform list', base.system.includes(caps.PLATFORM_BEHAVIOURS));
assert('...interpolated, not left as a literal placeholder', !base.system.includes('${PLATFORM_BEHAVIOURS}'));
assert('the classifier prompt has no unresolved placeholders at all', !base.system.includes('${'));
assert('the classifier schema declares platform_request', base.system.includes('"platform_request": true|false,'));
assert('platform_request has a field meaning', base.system.includes('- "platform_request":'));
assert('...which tells the model to leave asks empty', base.system.includes('leave "asks" EMPTY'));
assert('...and gives a not-platform counter-example', base.system.includes('add a Calendly booking section'));

// Nothing else in that prompt moved.
for (const key of [
  'is_question', 'question_aside', 'design_reference', 'reuse_reference_copy',
  'bug_report', 'attachment_roles', 'earlier_images_used', 'asks', 'constraints',
  'full_rebuild', 'uses_earlier_source', 'source_url', 'asset_source',
  'content_reuse', 'proceed_anyway', 'removal_intent', 'intentional_asset_replace',
  'wants_social_proof',
]) {
  assert(`pre-existing field "${key}" still documented`, base.system.includes(`- "${key}":`));
}

// ── 4. The guard: a real edit can never be swallowed ─────────────────────────
console.log('\n── the flag can never cancel an edit ──');

const a = await classify('{"platform_request":true,"asks":[]}');
assert('platform_request + no asks -> platformRequest true', a.intent.platformRequest === true);
assert('...and asks stays empty', a.intent.asks.length === 0);

const b = await classify('{"platform_request":true,"asks":[{"instruction":"make the hero blue","sections":["hero"],"op":"edit"}]}');
assert('platform_request + a real ask -> platformRequest FALSE (the edit survives)', b.intent.platformRequest === false);
assert('...and the ask is still there', b.intent.asks.length === 1);

const c = await classify('{"is_question":true,"platform_request":true,"asks":[]}');
assert('both flags together still route to an answer', c.intent.isQuestion === true && c.intent.platformRequest === true);

const d = await classify('{"asks":[{"instruction":"make the hero blue","sections":["hero"],"op":"edit"}]}');
assert('a response with no platform_request field -> false (every existing answer shape is unaffected)',
  d.intent.platformRequest === false);
assert('...and is still a normal edit', d.intent.asks.length === 1 && d.intent.isQuestion === false);

const e = await classify('{"platform_request":"true","asks":[]}');
assert('a string "true" is read as true, like every other flag here', e.intent.platformRequest === true);

const f = await classify('{"platform_request":false,"is_question":true,"asks":[]}');
assert('a plain question is untouched by the new flag',
  f.intent.isQuestion === true && f.intent.platformRequest === false);

// ── 5. Route wiring ──────────────────────────────────────────────────────────
console.log('\n── the route acts on it ──');

assert('the answer branch tests both flags',
  routeSrc.includes('if ((intent.isQuestion || intent.platformRequest) && intent.asks.length === 0) {'));
assert('the branch still requires asks to be empty',
  !/if \(\s*intent\.platformRequest\s*\)\s*\{/.test(routeSrc));
assert('the new flag is logged for diagnosis', routeSrc.includes('platformRequest: intent.platformRequest,'));

// The answer prompt kept everything it had.
for (const [what, needle] of [
  ['reading the page HTML', "You are always given the current page's real HTML below"],
  ['the visual-judgement caveat', 'What you genuinely cannot judge from HTML alone'],
  ['seeing attached images', 'Never claim you cannot see an attached image'],
  ['the greeting rule', 'just a greeting or small talk'],
  ['the no-guessing rule', 'say so plainly rather than guessing'],
]) {
  assert(`answer prompt still covers ${what}`, routeSrc.includes(needle));
}
assert('answer prompt bans jargon in replies', routeSrc.includes('Plain words only.'));
assert('answer prompt requires the exception to be named', routeSrc.includes("Name the exception, don't hide it."));
assert('answer prompt allows exactly one clarifying question when torn',
  routeSrc.includes('ask ONE short question to confirm'));

rmSync(outDir, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll platform-capability checks passed.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);

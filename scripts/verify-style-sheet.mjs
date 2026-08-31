/**
 * Real behavior tests for src/lib/ai-page-style-sheet.ts.
 *
 * What this guards: the design-brief call now WRITES the page's palette, fonts
 * and tokens instead of naming one of twelve hand-written styles. That removes
 * the cap on how many different pages the builder can make — and removes the
 * guarantee that came with a hand-written table, which is that the values were
 * looked at by a person first.
 *
 * parseStyleSheet is what replaces that guarantee. Everything it rejects is a
 * page that would be visibly broken in a browser:
 *   - a colour that is not a colour        -> CSS custom property is ignored
 *   - a font outside FONT_LIBRARY          -> no @import, no measured metrics,
 *                                             so the font never loads AND the
 *                                             hero H1 sizing math has no input
 *   - text that fails contrast             -> a page nobody can read
 *
 * A rejection costs the page its invented identity and falls back to one of the
 * twelve, so these checks have to be exactly as strict as the failure they
 * prevent and no stricter: every false rejection is a client who gets the same
 * page as another client for no reason.
 *
 * Run: node scripts/verify-style-sheet.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-style-sheet');
const stageDir = join(outDir, 'src');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-page-style-sheet.ts');
const fontsFile = join(repoRoot, 'src', 'lib', 'ai-page-fonts.ts');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// Two files, because the sheet reads the font library for its allowed font
// names. tsc is given copies with the `@/` alias rewritten to a sibling path:
// the alias lives in tsconfig paths, and resolving it here would drag the whole
// app in behind it. Only the import line differs from the real source.
writeFileSync(
  join(stageDir, 'ai-page-style-sheet.ts'),
  readFileSync(srcFile, 'utf8').replace(/@\/lib\/ai-page-fonts/g, './ai-page-fonts'),
);
writeFileSync(join(stageDir, 'ai-page-fonts.ts'), readFileSync(fontsFile, 'utf8'));

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    join(stageDir, 'ai-page-style-sheet.ts'),
    join(stageDir, 'ai-page-fonts.ts'),
    '--outDir', join(outDir, 'js'),
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--downlevelIteration',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const S = require(join(outDir, 'js', 'ai-page-style-sheet.js'));
const { FONT_LIBRARY } = require(join(outDir, 'js', 'ai-page-fonts.js'));

let failed = 0;
function assert(name, cond, detail) {
  if (cond) console.log(`OK: ${name}`);
  else {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// Silence the deliberate rejection warnings — every negative case below logs
// one, and 20 warnings in the output make a real failure hard to see.
const realWarn = console.warn;
console.warn = () => {};
const lastReason = () => reasons[reasons.length - 1] ?? '';
const reasons = [];
console.warn = (...args) => { reasons.push(args.map(String).join(' ')); };

/** A sheet that should pass everything. Deliberately not one of the twelve. */
function goodSheet(overrides = {}) {
  return {
    label: 'Chalk and Oxblood',
    mood: 'Heavy, quiet, expensive — a room where people lift in silence.',
    palette: { background: '#F4F1EC', text: '#161412', accent: '#7A2E2E', secondaryAccent: '#3F4A3C' },
    tokens: {
      surface: '#EAE5DD',
      elevated: '#FFFFFF',
      border: '#C9C1B4',
      textMuted: '#5C554C',
      radius: '4px',
      radiusLg: '8px',
      radiusPill: '999px',
      sectionPy: 'clamp(72px, 9vw, 128px)',
      container: '1180px',
      shadow: '0 1px 2px rgba(22,20,18,0.08)',
      shadowLg: '0 12px 32px rgba(22,20,18,0.12)',
    },
    typography: { headline: '"Bebas Neue", Impact, sans-serif', body: 'Inter, system-ui, sans-serif' },
    typeScale: 'h1 clamp(3rem, 7vw, 5.5rem) at 400 with 0.02em tracking; body a plain 1.0625rem.',
    geometry: 'Nearly square: 4px on everything, one hairline border, shadows only where a card lifts.',
    layoutNotes: 'Wide gutters, two-column splits, one full-bleed band per screen.',
    signatureMoves: 'Oxblood rule under every section heading; numbers set in the headline face at body size.',
    avoid: 'Neon, gradients, stock gym photography, anything that reads as a chain.',
    motionStyle: 'Almost none — 200ms opacity, no transforms.',
    aestheticTarget: 'Think a butcher shop sign, a Barbour catalogue, a 1970s weight room.',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The happy path
// ═══════════════════════════════════════════════════════════════════════════

const parsed = S.parseStyleSheet(goodSheet());
assert('a well-formed invented sheet is accepted', parsed !== null, lastReason());
if (parsed) {
  assert('every palette value survives', parsed.palette.background === '#F4F1EC' && parsed.palette.accent === '#7A2E2E');
  assert('the optional secondary accent survives', parsed.palette.secondaryAccent === '#3F4A3C');
  assert('all eleven tokens survive', Object.keys(parsed.tokens).length === 11,
    `got ${Object.keys(parsed.tokens).join(',')}`);
  assert('the full font stack is kept, not just the family', parsed.typography.headline === '"Bebas Neue", Impact, sans-serif');
  assert('prose fields survive', parsed.signatureMoves.startsWith('Oxblood rule'));
}

// Omitting the secondary accent is explicitly allowed by the JSON spec.
const noSecondary = goodSheet();
delete noSecondary.palette.secondaryAccent;
const parsedNoSecondary = S.parseStyleSheet(noSecondary);
assert('a sheet with no secondary accent is still accepted', parsedNoSecondary !== null, lastReason());
assert('and reports no secondary accent rather than an empty string',
  parsedNoSecondary && parsedNoSecondary.palette.secondaryAccent === undefined);

// Whitespace around a value is the model's, not a defect.
const padded = S.parseStyleSheet(goodSheet({
  label: '  Chalk and Oxblood  ',
  palette: { background: ' #F4F1EC ', text: '#161412', accent: '#7A2E2E' },
}));
assert('values are trimmed rather than rejected', padded !== null && padded.label === 'Chalk and Oxblood' && padded.palette.background === '#F4F1EC',
  lastReason());

// Three-digit hex is valid CSS and must not be rejected.
assert('3-digit hex is accepted',
  S.parseStyleSheet(goodSheet({ palette: { background: '#FFF', text: '#111', accent: '#7A2E2E' } })) !== null,
  lastReason());

// ═══════════════════════════════════════════════════════════════════════════
// Every font in the library must pass — the spec text and the validator are
// two descriptions of the same list, and a page is dead if they disagree.
// ═══════════════════════════════════════════════════════════════════════════

for (const name of Object.keys(FONT_LIBRARY.headline)) {
  const ok = S.parseStyleSheet(goodSheet({
    typography: { headline: `"${name}", sans-serif`, body: 'Inter, sans-serif' },
  }));
  assert(`headline font "${name}" is accepted`, ok !== null, lastReason());
  assert(`headline font "${name}" is named in the JSON spec`, S.STYLE_SHEET_JSON_SPEC.includes(name));
}
for (const name of Object.keys(FONT_LIBRARY.body)) {
  const ok = S.parseStyleSheet(goodSheet({
    typography: { headline: '"Syne", sans-serif', body: `"${name}", sans-serif` },
  }));
  assert(`body font "${name}" is accepted`, ok !== null, lastReason());
  assert(`body font "${name}" is named in the JSON spec`, S.STYLE_SHEET_JSON_SPEC.includes(name));
}
assert('an unquoted family name is read the same as a quoted one',
  S.parseStyleSheet(goodSheet({ typography: { headline: 'Syne, sans-serif', body: 'Inter, sans-serif' } })) !== null,
  lastReason());

// ═══════════════════════════════════════════════════════════════════════════
// Rejections — each one is a page that would be broken on screen
// ═══════════════════════════════════════════════════════════════════════════

assert('a font outside the library is rejected (no @import, no metrics)',
  S.parseStyleSheet(goodSheet({
    typography: { headline: '"Archivo Black", sans-serif', body: 'Inter, sans-serif' },
  })) === null);
assert('and the reason names the font',
  lastReason().includes('Archivo Black'), lastReason());

assert('a headline font that is only a BODY font is rejected',
  S.parseStyleSheet(goodSheet({
    typography: { headline: '"Manrope", sans-serif', body: 'Inter, sans-serif' },
  })) === null);

assert('a colour word instead of a hex is rejected',
  S.parseStyleSheet(goodSheet({ palette: { background: 'white', text: '#161412', accent: '#7A2E2E' } })) === null);
assert('an rgb() instead of a hex is rejected',
  S.parseStyleSheet(goodSheet({ palette: { background: 'rgb(244,241,236)', text: '#161412', accent: '#7A2E2E' } })) === null);
assert('a 5-digit hex is rejected',
  S.parseStyleSheet(goodSheet({ palette: { background: '#F4F1E', text: '#161412', accent: '#7A2E2E' } })) === null);
assert('a non-hex token colour is rejected',
  S.parseStyleSheet(goodSheet({ tokens: { ...goodSheet().tokens, border: 'currentColor' } })) === null);
assert('a bad secondary accent is rejected rather than dropped',
  S.parseStyleSheet(goodSheet({
    palette: { background: '#F4F1EC', text: '#161412', accent: '#7A2E2E', secondaryAccent: 'olive' },
  })) === null);

assert('a missing token is rejected',
  (() => { const s = goodSheet(); delete s.tokens.radiusPill; return S.parseStyleSheet(s) === null; })());
assert('an empty prose field is rejected',
  S.parseStyleSheet(goodSheet({ signatureMoves: '   ' })) === null);
assert('a missing palette block is rejected',
  (() => { const s = goodSheet(); delete s.palette; return S.parseStyleSheet(s) === null; })());
assert('a non-object is rejected', S.parseStyleSheet('a nice warm gym page') === null);
assert('null is rejected', S.parseStyleSheet(null) === null);

// Shadows and spacings are free-form CSS on purpose — "none" and a clamp() are
// both correct, and a validator that demanded a shape here would reject the
// flat-page styles the twelve already contain.
assert('shadow: none is accepted, not treated as missing',
  S.parseStyleSheet(goodSheet({ tokens: { ...goodSheet().tokens, shadow: 'none', shadowLg: 'none' } })) !== null,
  lastReason());
assert('a hard offset shadow is accepted',
  S.parseStyleSheet(goodSheet({ tokens: { ...goodSheet().tokens, shadow: '6px 6px 0 #0A0A0A' } })) !== null,
  lastReason());

// ═══════════════════════════════════════════════════════════════════════════
// Contrast — the check that actually saves a page from being unreadable
// ═══════════════════════════════════════════════════════════════════════════

assert('black on white is 21:1', Math.round(S.contrastRatio('#000000', '#FFFFFF')) === 21,
  String(S.contrastRatio('#000000', '#FFFFFF')));
assert('a colour against itself is 1:1', S.contrastRatio('#7A2E2E', '#7A2E2E') === 1);
assert('the ratio is symmetric',
  S.contrastRatio('#161412', '#F4F1EC') === S.contrastRatio('#F4F1EC', '#161412'));
assert('3-digit and 6-digit forms of the same colour agree',
  S.contrastRatio('#FFF', '#000') === S.contrastRatio('#FFFFFF', '#000000'));

assert('light-grey body text on a white page is rejected',
  S.parseStyleSheet(goodSheet({ palette: { background: '#FFFFFF', text: '#BBBBBB', accent: '#7A2E2E' } })) === null);
assert('and the reason gives the measured ratio', /:1$/.test(lastReason().trim()), lastReason());

assert('a pale-yellow accent on a white page is rejected',
  S.parseStyleSheet(goodSheet({ palette: { background: '#FFFFFF', text: '#111111', accent: '#FFE9A8' } })) === null);
assert('muted text too close to the background is rejected',
  S.parseStyleSheet(goodSheet({ tokens: { ...goodSheet().tokens, textMuted: '#EDEAE4' } })) === null);

// The floor has to leave room for real design. A dark page with a saturated
// accent is a normal, legible page — if this starts failing, the thresholds
// have been tightened past the point of usefulness.
assert('a dark page with a saturated accent passes',
  S.parseStyleSheet(goodSheet({
    palette: { background: '#0B0B0C', text: '#F2F2F0', accent: '#C6F24E' },
    tokens: { ...goodSheet().tokens, surface: '#141416', elevated: '#1C1C1F', border: '#2A2A2E', textMuted: '#9A9A96' },
  })) !== null, lastReason());
assert('a mid-tone accent that clears 3:1 but not 4.5:1 still passes',
  S.parseStyleSheet(goodSheet({
    palette: { background: '#FFFFFF', text: '#111111', accent: '#0F7B8A' },
  })) !== null, lastReason());

// ═══════════════════════════════════════════════════════════════════════════
// The stored value
// ═══════════════════════════════════════════════════════════════════════════

const stored = S.customStyleValue(goodSheet());
assert('an invented sheet stores its own name', stored === 'custom:Chalk and Oxblood', stored);
assert('the prefix is what the UI strips', stored.startsWith(S.CUSTOM_STYLE_PREFIX));

// The prefix has to be unmistakable for a StyleTag, or reading pages.style back
// would feed a made-up name into STYLE_EXEMPLARS.
const exemplarSrc = readFileSync(join(repoRoot, 'src', 'lib', 'ai-page-exemplars.ts'), 'utf8');
const tagUnion = exemplarSrc.slice(exemplarSrc.indexOf('export type StyleTag'), exemplarSrc.indexOf(';', exemplarSrc.indexOf('export type StyleTag')));
const tags = [...tagUnion.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
assert('the exemplar tags were found', tags.length >= 12, `found ${tags.length}`);
assert('no StyleTag could ever collide with the custom prefix',
  tags.every((t) => !t.startsWith(S.CUSTOM_STYLE_PREFIX) && !t.includes(':')),
  tags.join(','));

// ═══════════════════════════════════════════════════════════════════════════
// The prompt text
// ═══════════════════════════════════════════════════════════════════════════

assert('the JSON spec asks for every field the validator requires',
  ['label', 'mood', 'palette', 'tokens', 'typography', 'typeScale', 'geometry', 'layoutNotes', 'signatureMoves', 'avoid', 'motionStyle', 'aestheticTarget']
    .every((k) => S.STYLE_SHEET_JSON_SPEC.includes(`"${k}"`)));
assert('the rules tell the model contrast is enforced, not advisory',
  /contrast/i.test(S.STYLE_SHEET_RULES));
assert('the rules keep a user-supplied brand out of the invention',
  /never invent over a brand/i.test(S.STYLE_SHEET_RULES));
// The point of the whole change: without this, "invent a look" returns the same
// two or three looks it would have returned for any brief.
assert('the rules name the generic defaults as a signal to answer again',
  /answer again from the business/i.test(S.STYLE_SHEET_RULES));

console.warn = realWarn;
rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll style-sheet checks passed');

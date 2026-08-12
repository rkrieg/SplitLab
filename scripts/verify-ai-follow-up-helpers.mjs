/**
 * Verifies pure helpers mirrored from src/lib/ai-follow-up-helpers.ts
 * Run: node scripts/verify-ai-follow-up-helpers.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function userWantsUsToDecide(prompt) {
  return /\b(you decide|your (call|choice|judgment)|feel free|up to you|i('m| am) (fine|ok|okay) (with )?whatever|surprise me|just (do|pick|choose|decide)|pick (one|for me)|whichever (you|makes)|don'?t ask|no (more )?questions)\b/i.test(
    prompt,
  );
}

function isScreenshotComplaint(prompt, hasUserImages) {
  if (!hasUserImages) return false;
  return /\b(look(s|ing)? (at )?(this|that|it)|can you (not )?see|this is (ridiculous|absurd|sloppy|wrong|broken|weird)|it looks|doesn'?t (even )?(blend|match|look)|fake logo|line breaks|dark around|background.*(wrong|weird|not)|not (even )?the same)\b/i.test(
    prompt,
  );
}

function looksLikeMultiIntent(prompt) {
  const t = prompt.trim();
  if (t.length < 40) return false;
  if (/(?:^|\n)\s*(?:\d+[\.)]|[-*•])\s+\S+/m.test(t) && (t.match(/(?:^|\n)\s*(?:\d+[\.)]|[-*•])\s+/gm) || []).length >= 2) {
    return true;
  }
  if (/\b(?:also|plus|then|after that|and also|as well as)\b/i.test(t) && t.length > 60) {
    return true;
  }
  if ((t.match(/\s\+\s/g) || []).length >= 1 && /\b(logo|hero|form|nav|footer|headline|button|image)\b/i.test(t)) {
    return true;
  }
  const sectionHits = t.match(/\b(logo|nav(?:bar)?|hero|footer|form|faq|pricing|headline|button|cta|section)\b/gi) || [];
  const uniqueSections = new Set(sectionHits.map((s) => s.toLowerCase()));
  const actionHits = t.match(/\b(change|update|fix|remove|delete|rewrite|replace|swap|add|move|center|shrink|make|use|paste|embed|get\s+rid)\b/gi) || [];
  if (uniqueSections.size >= 2 && actionHits.length >= 2 && t.length > 80) {
    return true;
  }
  if (
    uniqueSections.size >= 2 &&
    /\b(get\s+rid|remove|delete|shrink|no buttons?|dead-?end|keep it (nice and )?simple)\b/i.test(t) &&
    t.length > 80
  ) {
    return true;
  }
  return false;
}

function extractVerifyQuotes(prompt) {
  const out = [];
  const re = /"([^"\n]{6,200})"|'([^'\n]{6,200})'|“([^”\n]{6,200})”/g;
  let m;
  while ((m = re.exec(prompt)) !== null) {
    const q = (m[1] || m[2] || m[3] || '').trim();
    if (q.length >= 6) out.push(q);
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function verifyScopedPatchIntent(opts) {
  const { prompt, sectionName, beforeHtml, afterHtml, requiredSubstring } = opts;
  if (requiredSubstring && !afterHtml.includes(requiredSubstring)) {
    return { ok: false, reason: `patched_${sectionName}_missing_required_asset` };
  }
  if (beforeHtml === afterHtml) {
    const quotes = extractVerifyQuotes(prompt);
    if (quotes.length > 0 || requiredSubstring) {
      return { ok: false, reason: `patched_${sectionName}_unchanged` };
    }
  }
  const quotes = extractVerifyQuotes(prompt);
  const namesThisSection = new RegExp(`\\b${escapeRegExp(sectionName)}\\b`, 'i').test(prompt);
  const rewriteIntent = /\b(change|rewrite|replace|update|say|should say|make it say|use this|to:)\b/i.test(prompt);
  if (rewriteIntent && quotes.length > 0) {
    const anyQuoteInAfter = quotes.some((q) => afterHtml.includes(q));
    const anyQuoteInBefore = quotes.some((q) => beforeHtml.includes(q));
    if (!anyQuoteInAfter) {
      if (namesThisSection || anyQuoteInBefore) {
        return { ok: false, reason: `patched_${sectionName}_missing_quoted_copy` };
      }
    }
  }
  const removeIntent = /\b(remove|delete|get rid of|take (out|off)|strip)\b/i.test(prompt);
  if (removeIntent && quotes.length > 0 && namesThisSection) {
    const stillPresent = quotes.filter((q) => afterHtml.includes(q) && beforeHtml.includes(q));
    if (stillPresent.length > 0 && stillPresent.length === quotes.length) {
      return { ok: false, reason: `patched_${sectionName}_remove_did_not_apply` };
    }
  }
  return { ok: true };
}

let failed = 0;
function assert(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  } else {
    console.log('OK:', name);
  }
}

assert('you decide → decide', userWantsUsToDecide('Make it shorter, you decide'));
assert('feel free → decide', userWantsUsToDecide('feel free to pick what to cut'));
assert('normal edit → not decide', !userWantsUsToDecide('Change the hero headline to Hello'));

assert(
  'ridiculous + images → screenshot complaint',
  isScreenshotComplaint('I mean, this is ridiculous. Look at this thing. This is absurd.', true),
);
assert(
  'ridiculous without images → not complaint gate',
  !isScreenshotComplaint('I mean, this is ridiculous. Look at this thing. This is absurd.', false),
);
assert(
  'sloppy logo background → complaint',
  isScreenshotComplaint(
    "Can you not see this? You pasted a logo with a background that's not even the same",
    true,
  ),
);

assert(
  'logo + hero + form → multi',
  looksLikeMultiIntent('Update the logo + rewrite the hero + fix the form questions'),
);
assert(
  'single headline → not multi',
  !looksLikeMultiIntent('Change the hero headline to Welcome'),
);
assert(
  'dead-end multi actions → multi',
  looksLikeMultiIntent(
    "The big text doesn't have to be that big. Get rid of the buttons about Learn More and the link about The Bend, and the buttons on the hero section, the button on the footer. Dead-end page.",
  ),
);

assert(
  'verify: quoted copy must land in named section',
  !verifyScopedPatchIntent({
    prompt: 'Change the hero to say "Your call is confirmed. We look forward to speaking."',
    sectionName: 'hero',
    beforeHtml: '<section>Old headline</section>',
    afterHtml: '<section>Old headline</section>',
  }).ok,
);

assert(
  'verify: quoted copy present → ok',
  verifyScopedPatchIntent({
    prompt: 'Change the hero to say "Your call is confirmed."',
    sectionName: 'hero',
    beforeHtml: '<section>Old</section>',
    afterHtml: '<section>Your call is confirmed.</section>',
  }).ok,
);

assert(
  'verify: required asset missing → fail',
  !verifyScopedPatchIntent({
    prompt: 'use this logo',
    sectionName: 'nav',
    beforeHtml: '<nav><img src="old.png"></nav>',
    afterHtml: '<nav><img src="old.png"></nav>',
    requiredSubstring: 'https://cdn.example/logo.png',
  }).ok,
);

assert(
  'verify: centering without quotes, changed html → ok',
  verifyScopedPatchIntent({
    prompt: 'Everything here should be centered.',
    sectionName: 'footer',
    beforeHtml: '<footer style="text-align:left">x</footer>',
    afterHtml: '<footer style="text-align:center">x</footer>',
  }).ok,
);

const gen = readFileSync(join(__dirname, '../src/app/api/pages/generate/route.ts'), 'utf8');
assert('generate drops forced 4-7', !gen.includes('Pick 4-7 sections beyond hero/footer'));
assert('generate has flexible shape', gen.includes('Page shape follows the user'));
assert('generate no fake proof default', gen.includes('Do NOT invent fake statistics'));
assert('generate you decide', gen.includes('you decide'));

const follow = readFileSync(join(__dirname, '../src/app/api/pages/[id]/follow-up/route.ts'), 'utf8');
assert('follow-up imports helpers', follow.includes('ai-follow-up-helpers'));
assert('follow-up multi-intent plan', follow.includes('planMultiIntentEdit'));
assert('follow-up forceDecide', follow.includes('forceDecideEarly'));
assert('follow-up verifyScopedPatchIntent', follow.includes('verifyScopedPatchIntent'));
assert('follow-up screenshot complaint in routing prompt', follow.includes('Never set confidence "low"'));

const helpers = readFileSync(join(__dirname, '../src/lib/ai-follow-up-helpers.ts'), 'utf8');
assert('helpers export userWantsUsToDecide', helpers.includes('export function userWantsUsToDecide'));
assert('helpers export looksLikeMultiIntent', helpers.includes('export function looksLikeMultiIntent'));

// Brand assets / create+URL parity (confirmation-page gold case)
function userWantsCustomOrMinimalPage(prompt) {
  return /\b(pretty much just|just (look|be|the)|only (the )?(hero|footer)|hero (section )?only|thank[- ]?you|confirmation|confirmed|dead-?end|no buttons|no (calls? to action|ctas?)|nothing else|that'?s (pretty much|about) it|keep it (nice and )?simple|flat background|success page)\b/i.test(
    prompt,
  );
}
function userWantsLogoFromReference(prompt) {
  return /\b((real|actual|exact|same|correct)\s+logo|use (the |their |this )?logo|logo from|with (the )?logo|keep (the )?logo|same logo|focused capital.*logo|logo.*from (this|the|that))\b/i.test(
    prompt,
  );
}
function forceEmbedLogoInHtml(html, logoUrl) {
  if (!logoUrl || html.includes(logoUrl)) return html;
  const logoImg = `<img src="${logoUrl}" alt="logo" style="height:40px;width:auto;display:block;background:transparent;" />`;
  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  if (slNav) {
    let inner = slNav[1];
    if (/<img\b/i.test(inner)) inner = inner.replace(/<img\b[^>]*>/i, logoImg);
    else inner = logoImg + inner;
    return html.slice(0, slNav.index) + `<!-- SL:nav -->${inner}<!-- /SL:nav -->` + html.slice(slNav.index + slNav[0].length);
  }
  return html;
}

const rennyPrompt =
  'The page should pretty much just look like this hero section, except it should say, "Your call is confirmed." Use the logo, use the same colors, flat background. There are no buttons. https://investor.focusedcapital.com/accredited';
assert('renny prompt = minimal shape', userWantsCustomOrMinimalPage(rennyPrompt));
assert('renny prompt = wants logo', userWantsLogoFromReference(rennyPrompt));
assert(
  'forceEmbedLogo replaces screenshot thumb',
  forceEmbedLogoInHtml(
    '<!-- SL:nav --><nav><img src="data:image/jpeg;base64,AAA" alt="x"></nav><!-- /SL:nav -->',
    'https://cdn.example/logo.svg',
  ).includes('https://cdn.example/logo.svg'),
);

assert('generate has minimal competitor branch', gen.includes('STYLE + ASSETS ONLY'));
assert('generate returns competitor_logo_url', gen.includes('competitor_logo_url'));
assert('generate injectBrandAssets', gen.includes('injectBrandAssetsIntoSchema'));

const build = readFileSync(join(__dirname, '../src/app/api/pages/build/route.ts'), 'utf8');
assert('build forceEmbedLogo', build.includes('forceEmbedLogoInHtml'));
assert('build accepts competitor_logo_url', build.includes('competitor_logo_url'));

const scrape = readFileSync(join(__dirname, '../src/lib/ai-competitor-scrape.ts'), 'utf8');
assert('scrape returns logoUrl', scrape.includes('logoUrl'));
assert('scrape returns footerContact', scrape.includes('footerContact'));

const brand = readFileSync(join(__dirname, '../src/lib/ai-brand-assets.ts'), 'utf8');
assert('brand-assets module exists', brand.includes('forceEmbedLogoInHtml'));

assert('follow-up broader logo intent', follow.includes('use|keep|with|from'));
assert('follow-up forceEmbed on structural', follow.includes('forceEmbedLogoInHtml'));

const pageBuilder = readFileSync(join(__dirname, '../src/lib/ai-page-builder.ts'), 'utf8');
assert('builder minimal addendum', pageBuilder.includes('COMPETITOR_MINIMAL_ADDENDUM'));
assert('builder realLogoUrl option', pageBuilder.includes('realLogoUrl'));

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll helper + contract checks passed.');

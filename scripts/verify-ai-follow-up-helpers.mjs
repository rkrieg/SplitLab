/**
 * Verifies pure helpers mirrored from src/lib/ai-follow-up-helpers.ts
 * + brand-asset / shape contracts. Run: node scripts/verify-ai-follow-up-helpers.mjs
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

function isDesignReferenceAsk(prompt, hasAttachments = false) {
  const t = prompt.trim();
  if (!t) return false;
  if (hasAttachments) {
    const MATCH_VERB =
      /\b(match|matching|copy|copied|replicate|recreate|mirror|mimic|follow|same|like|similar|as shown|according to)\b/i;
    const REFERENT =
      /\b(screenshot|screen\s?shot|image|photo|picture|design|mockup|reference|attachment|this|that|it)\b/i;
    if (MATCH_VERB.test(t) && REFERENT.test(t)) return true;
    if (/\bsimilar\s+to\s+(the\s+)?(screenshot|image|photo|this|that)\b/i.test(t)) return true;
    if (
      /\b(footer|nav(?:bar)?|header|hero|logo|section|form|cta|colou?rs?|font|spacing|layout)\b/i.test(t) &&
      /\b(not|isn'?t|aren'?t|wrong|off|incorrect|proper(?:ly)?|fix|adjust|correct)\b/i.test(t)
    ) {
      return true;
    }
  }
  if (
    /\b((keep|make|update|change|redo|rebuild|redesign|restyle|replace)\b.{0,80}\b(like this|like that|like the (image|screenshot|photo|reference)|to (match|look like) this)|(look|looks|looking) like this|match this|match that|same as this|exactly like this|copy this|based on this|use this as (a )?(reference|template|style|design)|style (it |this )?after this|from this (image|screenshot|photo|reference))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(footer|nav(?:bar)?|header|hero|logo|section|form|cta)\b/i.test(t) &&
    /\b(like this|like that|match this|match that|same as (this|that)|as shown|as in (the )?(image|screenshot|photo))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

function isScreenshotComplaint(prompt, hasUserImages) {
  if (!hasUserImages) return false;
  if (isDesignReferenceAsk(prompt)) return false;
  return /\b(look(s|ing)? (at )?(this|that|it)|can you (not )?see|this is (ridiculous|absurd|sloppy|wrong|broken|weird)|it looks|doesn'?t (even )?(blend|match|look)|fake logo|line breaks|dark around|background.*(wrong|weird|not)|not (even )?the same)\b/i.test(
    prompt,
  );
}

function inferDesignMatchSectionNames(prompt, sectionNames) {
  const found = [];
  const addMatching = (pred) => {
    for (const name of sectionNames) {
      if (pred(name.toLowerCase()) && !found.includes(name)) found.push(name);
    }
  };
  if (/\bfooter\b/i.test(prompt)) addMatching((n) => n.includes('footer'));
  if (/\b(nav(?:bar)?|header)\b/i.test(prompt)) {
    addMatching((n) => n === 'nav' || n.startsWith('nav') || n.includes('header') || n === 'navbar');
  }
  if (/\bhero\b/i.test(prompt)) addMatching((n) => n.includes('hero'));
  if (/\blogo\b/i.test(prompt) && found.length === 0) {
    addMatching((n) => n === 'nav' || n.includes('header') || n.includes('logo') || n.includes('footer'));
  }
  if (/\b(form|cta)\b/i.test(prompt) && found.length === 0) {
    addMatching((n) => /cta|form|popup|contact|lead/.test(n));
  }
  return found.slice(0, 3);
}

function uniqueSectionCount(t) {
  const sectionHits = t.match(/\b(logo|nav(?:bar)?|hero|footer|form|faq|pricing|headline|button|cta|section)\b/gi) || [];
  return new Set(sectionHits.map((s) => s.toLowerCase())).size;
}

function looksLikeMultiIntent(prompt) {
  const t = prompt.trim();
  if (t.length < 40) return false;
  if (/(?:^|\n)\s*(?:\d+[\.)]|[-*•])\s+\S+/m.test(t) && (t.match(/(?:^|\n)\s*(?:\d+[\.)]|[-*•])\s+/gm) || []).length >= 2) {
    return true;
  }
  if (/\b(?:also|plus|then|after that|and also|as well as|while you'?re at it)\b/i.test(t) && t.length > 50) {
    return true;
  }
  if (
    /\b(and|,)\s+(the\s+)?(logo|nav|hero|footer|form|faq|headline|button|cta)\b/i.test(t) &&
    uniqueSectionCount(t) >= 2 &&
    t.length > 45
  ) {
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
  if (uniqueSections.size >= 2 && t.length > 120) {
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

function dataFieldNames(html) {
  const out = [];
  for (const m of Array.from(html.matchAll(/\bdata-field=["']([^"']+)["']/gi))) {
    const f = m[1].trim();
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

function verifyScopedPatchIntent(opts) {
  const { prompt, sectionName, beforeHtml, afterHtml, requiredSubstring } = opts;
  if (requiredSubstring && !afterHtml.includes(requiredSubstring)) {
    return { ok: false, reason: `patched_${sectionName}_missing_required_asset`, severity: 'hard' };
  }
  if (beforeHtml === afterHtml) {
    const quotes = extractVerifyQuotes(prompt);
    if (quotes.length > 0 || requiredSubstring) {
      return { ok: false, reason: `patched_${sectionName}_unchanged`, severity: 'hard' };
    }
  }
  if (!/\b(remove|delete|get rid of|take (it|that|this|them) (out|off)|drop|strip|hide|without the)\b/i.test(prompt)) {
    const lost = dataFieldNames(beforeHtml).filter((f) => !dataFieldNames(afterHtml).includes(f));
    if (lost.length > 0) {
      return { ok: false, reason: `patched_${sectionName}_lost_editable_fields:${lost.join(',')}`, severity: 'hard' };
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

/** Mirror of extractInlineLogoSvg (fail-closed scoring). */
function extractInlineLogoSvg(rawHtml) {
  const MAX = 40_000;
  const headerMatch = /<header\b[\s\S]*?<\/header>/i.exec(rawHtml);
  const navMatch = /<nav\b[\s\S]*?<\/nav>/i.exec(rawHtml);
  const scopes = [];
  if (headerMatch) scopes.push(headerMatch[0]);
  if (navMatch) scopes.push(navMatch[0]);
  if (scopes.length === 0) scopes.push(rawHtml.slice(0, 25_000));
  const candidates = [];
  for (const scope of scopes) {
    let m;
    const re = /<svg\b[\s\S]*?<\/svg>/gi;
    while ((m = re.exec(scope))) {
      const svg = m[0];
      if (svg.length < 40 || svg.length > MAX) continue;
      if ((svg.match(/<path\b/gi) || []).length > 80) continue;
      let score = 0;
      if (/logo/i.test(svg)) score += 3;
      if (/aria-label\s*=\s*["'][^"']*logo/i.test(svg)) score += 2;
      if (/class\s*=\s*["'][^"']*logo/i.test(svg)) score += 2;
      if (headerMatch && scope === headerMatch[0]) score += 1;
      if (navMatch && scope === navMatch[0]) score += 1;
      if (svg.length < 8_000) score += 1;
      if (score === 0) continue;
      candidates.push({ svg, score, index: m.index });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0].svg.replace(/\s+/g, ' ').trim();
}

function forceEmbedLogoInHtml(html, logoUrl, logoSvg = null) {
  let markup = null;
  if (logoUrl) {
    markup = `<img src="${logoUrl}" alt="logo" style="height:40px;width:auto;display:block;background:transparent;" />`;
  } else if (logoSvg && /^<svg\b/i.test(logoSvg)) {
    markup = logoSvg;
  }
  if (!markup) return html;
  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  if (slNav) {
    if (logoUrl && slNav[1].includes(logoUrl)) return html;
    let inner = slNav[1];
    if (/<img\b/i.test(inner)) inner = inner.replace(/<img\b[^>]*>/i, markup);
    else if (/<svg\b[\s\S]*?<\/svg>/i.test(inner)) inner = inner.replace(/<svg\b[\s\S]*?<\/svg>/i, markup);
    else inner = markup + inner;
    return html.slice(0, slNav.index) + `<!-- SL:nav -->${inner}<!-- /SL:nav -->` + html.slice(slNav.index + slNav[0].length);
  }
  return html;
}

function userWantsLogoPlacedInSection(prompt) {
  if (!/\blogo\b/i.test(prompt)) return false;
  const hasDest =
    /\b(footer|hero|nav(?:bar)?|header|about|cta|sidebar|pricing|faq|section)\b/i.test(prompt) ||
    /\beverywhere\b|\ball sections\b|\bnav and footer\b|\bfooter and nav\b/i.test(prompt);
  if (!hasDest) return false;
  return (
    /\b(in (the )?|on (the )?|into (the )?|to (the )?|also|as well|too|same (one|logo)|everywhere|both)\b/i.test(
      prompt,
    ) ||
    /\b(put|place|add|copy|show|keep|use)\b[\s\S]{0,50}\blogo\b[\s\S]{0,50}\b(footer|hero|nav|header|about|section)\b/i.test(
      prompt,
    ) ||
    /\blogo\b[\s\S]{0,50}\b(in|on|into|to)\b[\s\S]{0,30}\b(footer|hero|nav|header|about|section)\b/i.test(
      prompt,
    )
  );
}

function inferLogoPlacementSectionNames(prompt, sectionNames) {
  const found = [];
  const addMatching = (pred) => {
    for (const name of sectionNames) {
      if (pred(name.toLowerCase()) && !found.includes(name)) found.push(name);
    }
  };
  const everywhere =
    /\beverywhere\b|\ball sections\b|\bnav and footer\b|\bfooter and nav\b|\bboth (the )?(nav|footer)/i.test(
      prompt,
    );
  if (everywhere || /\bfooter\b/i.test(prompt)) addMatching((n) => n.includes('footer'));
  if (everywhere || /\b(nav(?:bar)?|header)\b/i.test(prompt)) {
    addMatching((n) => n === 'nav' || n.startsWith('nav') || n.includes('header') || n === 'navbar');
  }
  if (/\bhero\b/i.test(prompt)) addMatching((n) => n.includes('hero'));
  if (/\babout\b/i.test(prompt)) addMatching((n) => n.includes('about'));
  return found.slice(0, 4);
}

function extractPrimaryLogoUrlFromHtml(html) {
  const slNav = /<!--\s*SL:nav\s*-->([\s\S]*?)<!--\s*\/SL:nav\s*-->/i.exec(html);
  const scope = slNav ? slNav[1] : html;
  const imgs = [...scope.matchAll(/<img\b[^>]*>/gi)];
  for (const m of imgs) {
    const srcM = /\bsrc=["']([^"']+)["']/i.exec(m[0]);
    if (srcM && /^https?:\/\//i.test(srcM[1])) return srcM[1];
  }
  return null;
}

function forceEmbedLogoInFooterHtml(html, logoUrl) {
  if (!logoUrl) return html;
  const markup = `<img src="${logoUrl}" alt="logo" style="height:40px;width:auto;display:block;background:transparent;" />`;
  const sl = /<!--\s*SL:footer\s*-->([\s\S]*?)<!--\s*\/SL:footer\s*-->/i.exec(html);
  if (!sl) return html;
  if (sl[1].includes(logoUrl)) return html;
  let inner = sl[1];
  if (/<img\b/i.test(inner)) inner = inner.replace(/<img\b[^>]*>/i, markup);
  else inner = markup + inner;
  return html.slice(0, sl.index) + `<!-- SL:footer -->${inner}<!-- /SL:footer -->` + html.slice(sl.index + sl[0].length);
}

function forceEmbedLogoIntoSections(html, sectionNames, logoUrl) {
  let out = html;
  for (const name of sectionNames) {
    if (name === 'footer') out = forceEmbedLogoInFooterHtml(out, logoUrl);
    else {
      const re = new RegExp(
        `<!--\\s*SL:${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*-->([\\s\\S]*?)<!--\\s*\\/SL:${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*-->`,
        'i',
      );
      const sl = re.exec(out);
      if (!sl || sl[1].includes(logoUrl)) continue;
      const markup = `<img src="${logoUrl}" alt="logo" />`;
      let inner = sl[1];
      if (/<img\b/i.test(inner)) inner = inner.replace(/<img\b[^>]*>/i, markup);
      else inner = markup + inner;
      out = out.slice(0, sl.index) + `<!-- SL:${name} -->${inner}<!-- /SL:${name} -->` + out.slice(sl.index + sl[0].length);
    }
  }
  return out;
}

function userWantsCustomOrMinimalPage(prompt) {
  return /\b(pretty much just|just (look|be|the)|only (the )?(hero|footer)|hero (section )?only|thank[- ]?you|confirmation|confirmed|dead-?end|no buttons|no (calls? to action|ctas?)|nothing else|that'?s (pretty much|about) it|keep it (nice and )?simple|flat background|success page|receipt page|booked call)\b/i.test(
    prompt,
  );
}
function userWantsLogoFromReference(prompt) {
  return /\b((real|actual|exact|same|correct)\s+logo|use (the |their |this )?logo|logo from|with (the )?logo|keep (the )?logo|same logo|focused capital.*logo|logo.*from (this|the|that))\b/i.test(
    prompt,
  );
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
  'keep footer like this → design reference ask',
  isDesignReferenceAsk('keep the footer like this'),
);
assert(
  'make nav match this → design reference ask',
  isDesignReferenceAsk('make the nav match this screenshot'),
);
// With an attachment, the exact phrase "like this" is not required. These two
// real prompts previously took the generic path and ended in "no changes were
// applied" because neither matched a phrase in the lists below.
assert(
  'attachment + "match the footer with screenshot" → design reference',
  isDesignReferenceAsk('also match the footer with screenshot.', true),
);
assert(
  'attachment + "logo colors are not properly copied" → design reference',
  isDesignReferenceAsk('the logo colors are not properly copied.', true),
);
assert(
  'no attachment → those same prompts are not design references',
  !isDesignReferenceAsk('the logo colors are not properly copied.', false) &&
    !isDesignReferenceAsk('also match the footer with screenshot.', false),
);
assert(
  'attachment alone does not make every edit a design reference',
  !isDesignReferenceAsk('change the headline to Book Your Call', true) &&
    !isDesignReferenceAsk('delete the pricing section', true),
);
assert(
  'design ask is NOT screenshot complaint',
  !isScreenshotComplaint('keep the footer like this', true),
);
assert(
  'real bug rant still complaint',
  isScreenshotComplaint('Look at this, the logo is broken and sloppy', true),
);
assert(
  'infer footer section from design ask',
  inferDesignMatchSectionNames('keep the footer like this', ['nav', 'hero', 'footer']).join(',') ===
    'footer',
);
assert(
  'infer nav from match this nav',
  inferDesignMatchSectionNames('make the nav look like this', ['nav', 'hero', 'footer']).includes('nav'),
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
  'soft: logo and the footer → multi',
  looksLikeMultiIntent('Please change the logo and the footer to use the real brand assets from the site'),
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

assert(
  'verify: rewrite that drops data-field is rejected',
  !verifyScopedPatchIntent({
    prompt: 'make the headline bigger',
    sectionName: 'hero',
    beforeHtml: '<section><h1 data-field="headline">Hi</h1></section>',
    afterHtml: '<section><h1 style="font-size:48px">Hi</h1></section>',
  }).ok,
);
assert(
  'verify: rewrite that keeps data-field is ok',
  verifyScopedPatchIntent({
    prompt: 'make the headline bigger',
    sectionName: 'hero',
    beforeHtml: '<section><h1 data-field="headline">Hi</h1></section>',
    afterHtml: '<section><h1 data-field="headline" style="font-size:48px">Hi</h1></section>',
  }).ok,
);
assert(
  'verify: deliberate removal is not blocked by the data-field guard',
  verifyScopedPatchIntent({
    prompt: 'remove the subheadline',
    sectionName: 'hero',
    beforeHtml: '<section><h1 data-field="headline">Hi</h1><p data-field="sub">Bye</p></section>',
    afterHtml: '<section><h1 data-field="headline">Hi</h1></section>',
  }).ok,
);

const logoSvg = '<svg class="logo" viewBox="0 0 100 40"><path d="M0 0h10v10H0z"/><path d="M20 0h10v10H20z"/></svg>';
const pageWithSvgLogo = `<header><nav>${logoSvg}</nav></header><main>body</main>`;
assert('extractInlineLogoSvg finds header logo class', !!extractInlineLogoSvg(pageWithSvgLogo));
assert(
  'extractInlineLogoSvg ignores decorative mega-svg',
  !extractInlineLogoSvg(
    '<div>' +
      '<svg>' +
      Array.from({ length: 90 }, (_, i) => `<path d="M${i} 0"/>`).join('') +
      '</svg></div>',
  ),
);
assert(
  'forceEmbedLogo SVG replaces img in SL:nav',
  forceEmbedLogoInHtml(
    '<!-- SL:nav --><nav><img src="data:image/jpeg;base64,AAA" alt="x"></nav><!-- /SL:nav -->',
    null,
    logoSvg,
  ).includes('<svg class="logo"'),
);
assert(
  'forceEmbedLogo URL still works',
  forceEmbedLogoInHtml(
    '<!-- SL:nav --><nav><img src="data:image/jpeg;base64,AAA" alt="x"></nav><!-- /SL:nav -->',
    'https://cdn.example/logo.svg',
  ).includes('https://cdn.example/logo.svg'),
);

assert(
  'logo in footer ask → placement',
  userWantsLogoPlacedInSection('use the new white logo in the footer as well'),
);
assert(
  'logo in hero ask → placement',
  userWantsLogoPlacedInSection('put the logo in the hero too'),
);
assert(
  'fetch logo from URL only → not placement',
  !userWantsLogoPlacedInSection('use the original logo of the website https://example.com'),
);
assert(
  'infer footer + hero placement targets',
  inferLogoPlacementSectionNames('put the logo in the hero and footer', ['nav', 'hero', 'footer']).join(',') ===
    'footer,hero',
);

const pageNavHasLogo =
  '<!-- SL:nav --><nav><img src="https://cdn.example.com/white-logo.png" alt="logo"></nav><!-- /SL:nav -->' +
  '<!-- SL:footer --><footer><img src="https://broken.example/missing.png" alt="x"><p>© Co</p></footer><!-- /SL:footer -->' +
  '<!-- SL:hero --><section><h1>Hi</h1></section><!-- /SL:hero -->';
assert(
  'extract logo from nav',
  extractPrimaryLogoUrlFromHtml(pageNavHasLogo) === 'https://cdn.example.com/white-logo.png',
);
const placed = forceEmbedLogoIntoSections(pageNavHasLogo, ['footer', 'hero'], 'https://cdn.example.com/white-logo.png');
assert(
  'forceEmbed into footer replaces broken img even when nav already has logo',
  /<!--\s*SL:footer\s*-->[\s\S]*white-logo\.png[\s\S]*<!--\s*\/SL:footer\s*-->/i.test(placed) &&
    !/<!--\s*SL:footer\s*-->[\s\S]*broken\.example[\s\S]*<!--\s*\/SL:footer\s*-->/i.test(placed),
);
assert(
  'forceEmbed into hero works too',
  /<!--\s*SL:hero\s*-->[\s\S]*white-logo\.png[\s\S]*<!--\s*\/SL:hero\s*-->/i.test(placed),
);

// --- Content reuse (text) — mirrored from ai-content-placement.ts ---
function detectContentReuseIntent(prompt, sectionNames) {
  const t = prompt.trim();
  if (!t) return null;
  const targets = inferLogoPlacementSectionNames(t, sectionNames);
  const quotes = [];
  const re = /"([^"\n]{3,400})"|'([^'\n]{3,400})'|“([^”\n]{3,400})”/g;
  let m;
  while ((m = re.exec(t))) {
    const q = (m[1] || m[2] || m[3] || '').replace(/\s+/g, ' ').trim();
    if (q.length >= 3) quotes.push(q);
  }
  if (/\blogo\b/i.test(t) && targets.length > 0 && /\b(in |on |also|as well|too|put|place|copy|use)\b/i.test(t)) {
    return { kind: 'logo', targets, textPayload: null, sourceSectionHint: null };
  }
  const textish = /\b(text|copy|headline|heading|title)\b/i.test(t) || quotes.length > 0;
  const copyFromTo =
    /\b(copy|move)\b/i.test(t) ||
    /\b(same|that|this)\s+(text|headline|copy)\b/i.test(t) ||
    (quotes.length > 0 && /\b(in|to|into)\b/i.test(t));
  if (textish && copyFromTo) {
    let sourceSectionHint = null;
    const fromM = /\b(?:from|of)\s+(?:the\s+)?(footer|hero|nav|header|about)\b/i.exec(t) ||
      /\b(footer|hero|nav|header|about)\s+(?:headline|heading|title|text|copy)\b/i.exec(t);
    if (fromM) sourceSectionHint = fromM[1].toLowerCase();
    let dests = targets;
    const toM = /\b(?:to|into|in)\s+(?:the\s+)?(footer|hero|nav|header|about|cta)\b/i.exec(t);
    if (toM) dests = inferLogoPlacementSectionNames(toM[1], sectionNames);
    return { kind: 'text', targets: dests, textPayload: quotes[0] || null, sourceSectionHint };
  }
  return null;
}
function forcePlaceTextInSection(html, sectionName, text) {
  const re = new RegExp(`<!--\\s*SL:${sectionName}\\s*-->([\\s\\S]*?)<!--\\s*\\/SL:${sectionName}\\s*-->`, 'i');
  const sl = re.exec(html);
  if (!sl || sl[1].includes(text)) return html;
  let inner = sl[1];
  if (/<h[1-3]\b/i.test(inner)) {
    inner = inner.replace(/(<h[1-3]\b[^>]*>)([\s\S]*?)(<\/h[1-3]>)/i, `$1${text}$3`);
  } else {
    inner = `<p>${text}</p>` + inner;
  }
  return html.slice(0, sl.index) + `<!-- SL:${sectionName} -->${inner}<!-- /SL:${sectionName} -->` + html.slice(sl.index + sl[0].length);
}

assert(
  'copy hero headline to footer → text reuse',
  detectContentReuseIntent('copy the hero headline to the footer', ['nav', 'hero', 'footer'])?.kind === 'text',
);
assert(
  'quoted text into about → text reuse',
  detectContentReuseIntent('put "Accredited investors only" in the about section', ['about', 'hero'])?.kind ===
    'text',
);
const textPlaced = forcePlaceTextInSection(
  '<!-- SL:footer --><footer><h2>Old</h2></footer><!-- /SL:footer -->',
  'footer',
  'You Are Through',
);
assert('forcePlaceText replaces footer heading', textPlaced.includes('You Are Through') && !/<h2>Old<\/h2>/.test(textPlaced));

const rennyPrompt =
  'The page should pretty much just look like this hero section, except it should say, "Your call is confirmed." Use the logo, use the same colors, flat background. There are no buttons. https://investor.focusedcapital.com/accredited';
assert('renny prompt = minimal shape', userWantsCustomOrMinimalPage(rennyPrompt));
assert('renny prompt = wants logo', userWantsLogoFromReference(rennyPrompt));

const gen = readFileSync(join(__dirname, '../src/app/api/pages/generate/route.ts'), 'utf8');
assert('generate drops forced 4-7', !gen.includes('Pick 4-7 sections beyond hero/footer'));
assert('generate has flexible shape', gen.includes('Page shape follows the user'));
assert('generate no fake proof default', gen.includes('Do NOT invent fake statistics'));
assert('generate you decide', gen.includes('you decide'));
assert('generate has minimal competitor branch', gen.includes('STYLE + ASSETS ONLY'));
assert('generate returns competitor_logo_url', gen.includes('competitor_logo_url'));
assert('generate returns competitor_logo_svg', gen.includes('competitor_logo_svg'));
assert('generate classifyPageShapeIntent', gen.includes('classifyPageShapeIntent'));
assert('generate injectBrandAssets', gen.includes('injectBrandAssetsIntoSchema'));

const follow = readFileSync(join(__dirname, '../src/app/api/pages/[id]/follow-up/route.ts'), 'utf8');
assert('follow-up imports helpers', follow.includes('ai-follow-up-helpers'));
assert('follow-up multi-intent plan', follow.includes('planMultiIntentEdit'));
assert('follow-up forceDecide', follow.includes('forceDecideEarly'));
assert('follow-up verifyScopedPatchIntent', follow.includes('verifyScopedPatchIntent'));
assert('follow-up screenshot complaint in routing prompt', follow.includes('Never set confidence "low"'));
assert('follow-up broader logo intent', follow.includes('use|keep|with|from'));
assert('follow-up forceEmbed on structural', follow.includes('forceEmbedLogoInHtml'));
assert('follow-up classifyAttachedImages', follow.includes('classifyAttachedImages'));
assert('follow-up embedImageUrls', follow.includes('embedImageUrls'));
assert('follow-up materializeLogoUrl', follow.includes('materializeLogoUrl'));
assert('follow-up fetchLogoAssets', follow.includes('fetchLogoAssets'));

const helpers = readFileSync(join(__dirname, '../src/lib/ai-follow-up-helpers.ts'), 'utf8');
assert('helpers export userWantsUsToDecide', helpers.includes('export function userWantsUsToDecide'));
assert('helpers export looksLikeMultiIntent', helpers.includes('export function looksLikeMultiIntent'));
assert('helpers soft and-the-section pattern', helpers.includes('(and|,)\\s+(the\\s+)?'));
assert('helpers classifyAttachedImages', helpers.includes('export async function classifyAttachedImages'));
assert('helpers design_reference role', helpers.includes("design_reference"));
assert('helpers isDesignReferenceAsk', helpers.includes('export function isDesignReferenceAsk'));
assert('helpers extractDesignReferenceCopy', helpers.includes('export async function extractDesignReferenceCopy'));
assert('helpers requiredPhrases verify', helpers.includes('requiredPhrases'));
assert('helpers inferDesignMatchSectionNames', helpers.includes('export function inferDesignMatchSectionNames'));
assert('follow-up designReferenceUrls', follow.includes('designReferenceUrls'));
assert('follow-up DESIGN REFERENCE', follow.includes('DESIGN REFERENCE'));
assert('follow-up inferDesignMatchSectionNames', follow.includes('inferDesignMatchSectionNames'));
assert('follow-up design match htmlUnchanged message', follow.includes('Could not match the attached design reference'));
assert('helpers longer 2-section soft', helpers.includes('t.length > 120'));
assert('helpers userWantsFullCompetitorRebuild', helpers.includes('export function userWantsFullCompetitorRebuild'));
assert('helpers allowScopedDespiteCompetitorUrl', helpers.includes('export function allowScopedDespiteCompetitorUrl'));
assert('helpers userWantsSiteContentImage', helpers.includes('export function userWantsSiteContentImage'));
assert('helpers userAskedForSocialProof', helpers.includes('export function userAskedForSocialProof'));

function userWantsFullCompetitorRebuild(prompt) {
  return /\b((look|looks|looking) like|replicate|clone|copy (this|the) (site|page)|same as|exactly like|redesign|rebuild|match (this|the|their) (site|page|design|layout)|make (it|this|the page) (look |be )?(like|similar)|based on (this |the )?(site|page|url|link|website)|(from|using) (this |the )?(site|page|url|link) as (a )?(reference|template))\b/i.test(
    prompt,
  );
}
function allowScopedDespiteCompetitorUrl(prompt) {
  if (userWantsFullCompetitorRebuild(prompt)) return false;
  const withoutUrls = prompt
    .replace(/https?:\/\/[^\s"'<>)]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutUrls.length < 16) return false;
  if (
    /\b(change|rewrite|rephrase|update|fix|replace|swap|shrink|center|remove|delete|get\s+rid|make)\b/i.test(
      withoutUrls,
    ) &&
    /\b(headline|heading|title|text|copy|button|cta|footer|hero|nav|logo|form|section|wording|subhead|padding|spacing)\b/i.test(
      withoutUrls,
    )
  ) {
    return true;
  }
  if (/["'“][^"'”\n]{6,}["'”]/.test(prompt)) return true;
  return false;
}
assert(
  'incidental URL + headline edit → scoped ok',
  allowScopedDespiteCompetitorUrl('Change the hero headline to Welcome https://example.com/page'),
);
assert(
  'look like URL → NOT scoped',
  !allowScopedDespiteCompetitorUrl('Make the page look like https://example.com/page'),
);
assert(
  'clone phrasing → full rebuild',
  userWantsFullCompetitorRebuild('Please clone https://example.com and match the design'),
);
assert(
  'normal headline no url → not full rebuild helper alone',
  !userWantsFullCompetitorRebuild('Change the hero headline to Welcome'),
);

assert('follow-up allowScopedDespiteCompetitorUrl wiring', follow.includes('allowScopedDespiteCompetitorUrl'));
assert('follow-up shouldScrapeCompetitor', follow.includes('shouldScrapeCompetitor'));
assert('follow-up content image swap', follow.includes('isContentImageSwapAttempt'));
assert('follow-up fetchContentImageAssets', follow.includes('fetchContentImageAssets'));
assert('follow-up multi-intent retry finish', follow.includes('multi-intent completed after retry'));
assert('follow-up design-ref OCR', follow.includes('extractDesignReferenceCopy'));
assert('follow-up REQUIRED visible copy', follow.includes('REQUIRED visible copy from the design reference'));
assert('follow-up Retrying step', follow.includes('Retrying step'));

assert('generate stripUnpromptedSocialProof', gen.includes('stripUnpromptedSocialProof'));
assert('generate REAL SITE PHOTOS', gen.includes('REAL SITE PHOTOS'));
assert('generate MINIMAL PAGE TASTE', gen.includes('MINIMAL PAGE TASTE'));

const build = readFileSync(join(__dirname, '../src/app/api/pages/build/route.ts'), 'utf8');
assert('build forceEmbedLogo', build.includes('forceEmbedLogoInHtml'));
assert('build accepts competitor_logo_url', build.includes('competitor_logo_url'));
assert('build accepts competitor_logo_svg', build.includes('competitor_logo_svg'));
assert('build materializeLogoUrl', build.includes('materializeLogoUrl'));

const scrape = readFileSync(join(__dirname, '../src/lib/ai-competitor-scrape.ts'), 'utf8');
assert('scrape returns logoUrl', scrape.includes('logoUrl'));
assert('scrape returns logoSvgMarkup', scrape.includes('logoSvgMarkup'));
assert('scrape returns footerContact', scrape.includes('footerContact'));
assert('scrape extractInlineLogoSvg', scrape.includes('extractInlineLogoSvg'));
assert('scrape fetchLogoAssets', scrape.includes('export async function fetchLogoAssets'));
assert('scrape fetchContentImageAssets', scrape.includes('export async function fetchContentImageAssets'));
assert('scrape referenceImageUrls', scrape.includes('referenceImageUrls'));
assert('scrape extractContentImageUrls', scrape.includes('export function extractContentImageUrls'));

const brand = readFileSync(join(__dirname, '../src/lib/ai-brand-assets.ts'), 'utf8');
assert('brand-assets module exists', brand.includes('forceEmbedLogoInHtml'));
assert('brand extractInlineLogoSvg', brand.includes('export function extractInlineLogoSvg'));
assert('brand forceEmbedLogoInFooterHtml', !brand.includes('export function forceEmbedLogoInFooterHtml'));
assert('brand forceEmbedLogoIntoSections', brand.includes('export function forceEmbedLogoIntoSections'));
assert('brand no userWantsLogoInFooter export', !brand.includes('export function userWantsLogoInFooter'));
assert('brand extractPrimaryLogoUrlFromHtml', brand.includes('export function extractPrimaryLogoUrlFromHtml'));
assert('brand extractLogoUrlFromSection', brand.includes('export function extractLogoUrlFromSection'));
assert('follow-up logo from section', follow.includes('content reuse: logo from section'));
assert('follow-up skip intentional logo restore', follow.includes('skip logo restore (intentional replace)'));
assert('brand userWantsLogoPlacedInSection', brand.includes('export function userWantsLogoPlacedInSection'));
assert('brand inferLogoPlacementSectionNames', brand.includes('export function inferLogoPlacementSectionNames'));
assert('follow-up logo placement path', follow.includes('content reuse: logo placed'));
assert('follow-up text reuse path', follow.includes('content reuse: text placed'));
assert('follow-up forceEmbedLogoIntoSections', follow.includes('forceEmbedLogoIntoSections'));
assert('follow-up detectContentReuseIntent', follow.includes('detectContentReuseIntent'));
assert('build logo fail-closed', build.includes('logo URL missing from HTML after embed'));
assert('build forceEmbedLogoIntoSections', build.includes('forceEmbedLogoIntoSections'));

const placement = readFileSync(join(__dirname, '../src/lib/ai-content-placement.ts'), 'utf8');
assert('placement detectContentReuseIntent', placement.includes('export function detectContentReuseIntent'));
assert('placement forcePlaceTextInSection', placement.includes('export function forcePlaceTextInSection'));
assert('placement inferTargetSectionNames', placement.includes('export function inferTargetSectionNames'));
assert('placement forceAppendMissingDesignCopy', placement.includes('export function forceAppendMissingDesignCopy'));
assert('placement dedupes duplicate screenshot copy', placement.includes('export function dedupeDesignCopyLines'));
assert('OCR extracts unique lines from duplicate shots', helpers.includes('SAME screenshot'));

// Create-path parity: screenshot OCR + multi-ask (must stay wired)
assert('generate accepts image_urls', gen.includes('image_urls'));
assert('generate design OCR', gen.includes('extractDesignReferenceCopy'));
assert('generate multi-part prompts', gen.includes('Multi-part first prompts'));
assert('generate looksLikeMultiIntent', gen.includes('looksLikeMultiIntent'));
assert('generate returns design_copy_lines', gen.includes('design_copy_lines'));
assert('generate vision images on schema', gen.includes("type: 'image'") || gen.includes('type: "image"'));
assert('build accepts design_copy_lines', build.includes('design_copy_lines'));
assert('build design OCR fallback', build.includes('Reading design screenshot'));
assert('build forceAppendMissingDesignCopy', build.includes('forceAppendMissingDesignCopy'));

assert('brand materializeLogoUrl', brand.includes('export async function materializeLogoUrl'));
assert('brand classifyPageShapeIntent', brand.includes('export async function classifyPageShapeIntent'));
assert('brand forceEmbed accepts logoSvg', brand.includes('logoSvg: string | null'));
assert('brand stripUnpromptedSocialProof', brand.includes('export function stripUnpromptedSocialProof'));

const client = readFileSync(
  join(__dirname, '../src/app/(dashboard)/clients/[id]/pages/new/AIBuilderClient.tsx'),
  'utf8',
);
assert('client competitorLogoSvg state', client.includes('competitorLogoSvg'));
assert('client passes competitor_logo_svg', client.includes('competitor_logo_svg'));
assert('client partial toast path', client.includes('Partly done (not fully finished)'));
assert('client uploads before generate', client.includes('upload-chat-image') && client.includes('createAttachUrlsRef'));
assert('client passes design_copy_lines to build', client.includes('design_copy_lines'));
assert('client passes image_urls to generate', client.includes('image_urls: createImageUrls'));
assert('client skips attaching the same file twice', client.includes('That screenshot is already attached'));

const pageBuilder = readFileSync(join(__dirname, '../src/lib/ai-page-builder.ts'), 'utf8');
assert('builder minimal addendum', pageBuilder.includes('COMPETITOR_MINIMAL_ADDENDUM'));
assert('builder realLogoUrl option', pageBuilder.includes('realLogoUrl'));
assert('builder minimal taste hierarchy', pageBuilder.includes('Taste: one clear H1 hierarchy'));
assert('builder no invent stats in HTML', pageBuilder.includes('Do NOT invent fake statistics'));
assert('builder designReferenceCopy option', pageBuilder.includes('designReferenceCopy'));

// Asset integrity: nothing may embed an unverified third-party URL
const assets = readFileSync(join(__dirname, '../src/lib/ai-asset-integrity.ts'), 'utf8');
assert('assets materializeAsset', assets.includes('export async function materializeAsset'));
assert('assets verifyAndRehostHtmlImages', assets.includes('export async function verifyAndRehostHtmlImages'));
assert('assets checks content-type', assets.includes("contentType.startsWith('image/')"));
assert('assets re-host via uploadImage', assets.includes('uploadImage('));
assert('brand logo verifies before embed', brand.includes('materializeAsset'));
assert('brand no raw hotlink return', !/if \(opts\.logoUrl && \/\^https\?:\\\/\\\/\/i\.test\(opts\.logoUrl\)\) return opts\.logoUrl;/.test(brand));
assert('build verifies page images', build.includes('verifyAndRehostHtmlImages'));
assert('follow-up verifies page images', follow.includes('verifyAndRehostHtmlImages'));

// Layout-safe injection: never prepend bare markup onto a section body
assert('brand injectIntoFirstContainer', brand.includes('function injectIntoFirstContainer'));
assert('brand footer injects inside wrapper', !brand.includes('block.replace(/<footer\\b[^>]*>/i, (open) => `${open}${markup}`)'));

// Requirements: prompt → checkable asks → honest completion
const reqs = readFileSync(join(__dirname, '../src/lib/ai-page-requirements.ts'), 'utf8');
assert('requirements extract', reqs.includes('export function extractRequirements'));
assert('requirements enforce', reqs.includes('export function enforceRequirements'));
assert('requirements check', reqs.includes('export function checkRequirements'));
assert('requirements describeUnmet', reqs.includes('export function describeUnmet'));
assert('requirements retry instruction', reqs.includes('export function retryInstructionFor'));
assert('requirements CTA strip', reqs.includes('export function stripCtaElements'));
assert('requirements theme color', reqs.includes('export function extractThemeBackgroundColor'));
assert('requirements protects logo from CTA strip', reqs.includes('if (/<(img|svg)\\b/i.test(tag)) return false;'));
assert('requirements match the color asked for', reqs.includes('export function colorMatchesName'));
assert('requirements parse real CSS colors', reqs.includes('export function parseCssColor'));
assert('requirements no non-white shortcut', !reqs.includes('sectionHasNonWhiteBackground'));

// Preservation: an edit must not silently destroy what it wasn't asked to touch
const preserve = readFileSync(join(__dirname, '../src/lib/ai-page-preservation.ts'), 'utf8');
assert('preservation snapshot', preserve.includes('export function snapshotPageFacts'));
assert('preservation finds losses', preserve.includes('export function findUnrequestedLosses'));
assert('preservation respects removal intent', preserve.includes('export function promptHasRemovalIntent'));
assert('follow-up guards against losses', follow.includes('findUnrequestedLosses'));
assert('follow-up restores a deleted logo', follow.includes('restored logo removed without request'));
assert('follow-up reports unrepaired losses', follow.includes('describeLosses'));
assert('build wires requirements', build.includes('extractRequirements') && build.includes('checkRequirements'));
assert('build reports unmet', build.includes('unmet_requirements'));
// The checklist is the model's (seeded by the intent pass, refined by routing);
// the only check code invents is "an asset we embedded is present".
assert('follow-up wires requirements', follow.includes('assetRequirements(') && follow.includes('describeUnmet'));
assert('follow-up seeds the checklist from the intent pass',
  follow.includes('intent?.requirements ?? []'));
assert('follow-up no longer derives requirements from prompt keywords',
  !follow.includes('extractRequirements('));
assert('follow-up unmet downgrades toast', follow.includes('Still not applied'));
assert('client surfaces unmet on create', client.includes('unmet_requirements') && client.includes('not everything landed'));

// ── Routing is decided by the model, keywords are only the fallback ─────────
const intentSrc = readFileSync(join(__dirname, '../src/lib/ai-edit-intent.ts'), 'utf8');
assert('intent module exists', intentSrc.includes('export async function classifyEditIntent'));
assert('intent validates against live sections', intentSrc.includes('export function normalizeIntent'));
assert('intent fails open', intentSrc.includes('caller should clarify or decide') || intentSrc.includes('falling back to keyword gates'));
assert('intent never invents a source URL', intentSrc.includes('allowedUrls.includes(claimedUrl)'));
assert('intent asks the model for the checklist too', intentSrc.includes('requirementInstruction'));
assert('follow-up classifies intent first', follow.includes('await classifyEditIntent('));
assert('intent failure asks the user instead of silent regex',
  follow.includes('intent unavailable — asking user (no regex fallback)'));
assert('intent keyword fallback only after decide/prior clarify',
  follow.includes('allowIntentKeywordFallback'));
assert('edit-intent budget allows the checklist', intentSrc.includes('maxTokens: 8000'));
assert('follow-up routes design match off the intent', follow.includes('const wantsDesignMatch = intent'));
assert('follow-up routes multi-ask off the intent', follow.includes('const hasMultipleAsks = intent'));
assert('follow-up takes target sections from the intent', follow.includes('intentSections.length > 0'));
assert('follow-up keeps keyword gates only as fallback',
  follow.includes(': isDesignReferenceAsk(prompt, hasUserImages)') &&
    follow.includes(': looksLikeMultiIntent(prompt)'));
assert('create path classifies intent too', gen.includes('await classifyEditIntent('));
assert('create decision is forwarded, not re-guessed',
  gen.includes('reuse_reference_copy: reuseReferenceWords') &&
    build.includes("typeof reuse_reference_copy === 'boolean'") &&
    client.includes('reuse_reference_copy: reuseReferenceCopy'));

// A soft quality miss must never delete a real edit
assert('verify reports severity', helpers.includes("severity: 'hard' | 'soft'"));
assert('design-copy shortfall is soft', helpers.includes("severity: 'soft'"));
assert('follow-up keeps soft-shortfall edits',
  follow.includes("verify.severity === 'hard'") && follow.includes('softShortfalls'));
assert('phrase match is text-level, not raw HTML',
  helpers.includes('normalizeForPhraseMatch'));

// Full sweep: every routing decision reads the classifier first, keyword
// regex is fallback-only everywhere — not just the gates fixed first.
assert('verify no-op check uses the classifier\'s resolved sections, not fresh keyword inference',
  helpers.includes('intentTargetSections') &&
    helpers.includes('intentTargetSections && intentTargetSections.length > 0'));
assert('content-reuse (logo/text/image placement) comes from the classifier',
  intentSrc.includes('contentReuse: ContentReuseIntent | null') &&
    follow.includes('const resolveContentReuse ='));
assert('follow-up no longer calls detectContentReuseIntent directly at any routing site',
  (follow.match(/\bdetectContentReuseIntent\(/g) || []).length === 1); // only inside resolveContentReuse's fallback
assert('"proceed anyway" / "you decide" comes from the classifier',
  intentSrc.includes('proceedAnyway: boolean') && follow.includes('const wantsUsToDecide ='));
assert('follow-up only uses userWantsUsToDecide when intent is missing or as decide-fallback',
  (follow.match(/userWantsUsToDecide\(prompt\)/g) || []).length <= 4);
assert('create path forwards its design-reference verdict to build, not just reuse-copy',
  gen.includes('design_reference: designAsk') &&
    build.includes("typeof design_reference === 'boolean'") &&
    client.includes('design_reference: designReference'));
assert('create path classifies intent for plain text prompts too, not just attachments',
  gen.includes('const createIntent = prompt.trim()'));
assert('create path\'s multi-ask note comes from the classifier',
  gen.includes('const hasMultipleAsks = createIntent ? createIntent.asks.length > 1'));

assert('build stamps data-field from schema', build.includes('ensureClickToEditFields(html, enrichedSchema)'));
assert('follow-up stamps data-field after a successful edit',
  follow.includes('ensureClickToEditFields(finalHtmlPersisted'));
assert('logo recolor is not treated as logo embed',
  placement.includes('export function isLogoColorStyleAsk') &&
    follow.includes('isLogoColorStyleAsk(askText)'));
assert('everywhere / all-logos expands past nav+footer',
  placement.includes('nav|header|footer|hero'));
assert('multi-ask seeds the planner from classifier asks',
  helpers.includes('seedAsks') && follow.includes('seedAsks: intent && intent.asks.length >= 2'));
assert('partial multi-ask keeps successful steps',
  follow.includes('multi-intent partial after retry — keeping wins'));
assert('style+head is a scoped patch, not an automatic full rebuild',
  follow.includes("routing.type === 'patch' || routing.type === 'style'"));
assert('verify does not re-run design-match regex when the caller already decided',
  helpers.includes('designMatch?: boolean') && helpers.includes('treatAsDesignMatch'));
assert('source URL is inherited only to fetch assets or rebuild',
  follow.includes('intent.usesEarlierSource && (intent.assetSource || intent.fullRebuild)'));
assert('competitor_fetch_failed only after a scrape actually ran',
  follow.includes('scrapeAttempted') &&
    follow.includes('scrapeAttempted && !competitorContext'));
assert('merged classifier asks still split when the prompt has several asks',
  follow.includes('intent.asks.length > 1 || looksLikeMultiIntent(prompt)'));
assert('multi-ask no-op does not use the design-reference-only toast',
  follow.includes('Some of those edits did not apply'));
assert('image roles come from intent when available',
  intentSrc.includes('export function imageRolesFromIntent') &&
    follow.includes('imageRolesFromIntent(intent'));
assert('no single-image logo→bug regex short-circuit',
  !helpers.includes("if (/\\b(fix|wrong|broken|sloppy|align|spacing|logo)\\b/i.test(prompt))"));
assert('classifyAttachedImages only when intent is null',
  follow.includes('attached image roles from intent') &&
    follow.includes('classified = await classifyAttachedImages'));
assert('open page can stamp missing data-field',
  client.includes('ensure-editable') &&
    readFileSync(join(__dirname, '../src/app/api/pages/[id]/ensure-editable/route.ts'), 'utf8').includes('ensureClickToEditFields'));
assert('structural stamp exists for screenshot copy',
  readFileSync(join(__dirname, '../src/lib/ai-data-field-stamp.ts'), 'utf8').includes('stampStructuralDataFields'));

// "the logo on nav is wrong" must not touch the footer's logo
assert('logo swap targets the section the user named',
  follow.includes('const namedLogoSection = intentSections.find('));
assert('logo swap fallback is section-scoped, not whole-page',
  !/const forced = forceEmbedLogoInHtml\(/.test(follow));

// Live visual QA is disabled at the create/edit call sites (destructive
// rewrites from error-page captures). The module stays; re-enable later
// with capture-is-our-page + data-field preservation.

// A dropped connection mid-stream must not lose the whole build
const aiClientSrc = readFileSync(join(__dirname, '../src/lib/ai-client.ts'), 'utf8');
assert('stream retries mid-stream', aiClientSrc.includes('transient-connection-mid-stream'));
assert('callers can reset progress buffers', aiClientSrc.includes('onStreamRestart'));
assert('build reports the real AI error', build.includes('userFacingAIErrorMessage(err)'));

// A source URL given in an earlier turn is still usable this turn
assert('helpers export referencesEarlierSource', helpers.includes('export function referencesEarlierSource'));
assert('follow-up inherits an earlier source URL', follow.includes('referencesEarlierSource(prompt)'));

// Screenshot copy is not content unless the user asked for the words
assert('placement exports wantsReferenceCopy', placement.includes('export function wantsReferenceCopy'));
assert('build gates design OCR on wantsReferenceCopy', build.includes('reuseReferenceCopy'));
assert('generate gates design OCR on wantsReferenceCopy', gen.includes('wantsReferenceCopy(prompt)'));

// One attachment must be uploaded once: two consumers, one synchronous source
assert('client consumes attachments via a synchronous ref', client.includes('takePendingChatImages'));
assert('client no longer reads stale chatImages state to upload', !/const attachedImages = chatImages;/.test(client));

// Our own uploads are probed too, or a broken logo ships as "Done"
const assetIntegritySrc = readFileSync(join(__dirname, '../src/lib/ai-asset-integrity.ts'), 'utf8');
assert(
  'asset scan probes own-storage images',
  assetIntegritySrc.includes('ownResults') && assetIntegritySrc.includes('ownSrcs'),
);

const visualQa = readFileSync(join(__dirname, '../src/lib/ai-visual-qa.ts'), 'utf8');
assert('visual-qa module shouldRun', visualQa.includes('export function shouldRunNavLogoVisualQa'));
assert('visual-qa once helper', visualQa.includes('export async function runNavLogoVisualQaOnce'));
assert('visual-qa whole-scroll scope', visualQa.includes('FULL page') || visualQa.includes('whole-scroll') || visualQa.includes('WHOLE-SCROLL'));
assert('visual-qa max section fixes', visualQa.includes('MAX_SECTION_FIXES'));
assert('visual-qa listSlSectionNames', visualQa.includes('export function listSlSectionNames'));
assert('visual-qa fail-closed parse', visualQa.includes('treating as ok (fail-closed)'));
assert('visual-qa live post-upload', visualQa.includes('export async function runPostUploadNavLogoQa'));
assert('visual-qa kill switch is off', visualQa.includes('const LIVE_VISUAL_QA_ENABLED = false'));
assert('visual-qa resultScreenshots', visualQa.includes('resultScreenshots'));
assert('visual-qa extractHero', visualQa.includes('export function extractHeroSectionHtml'));
assert('build visual-qa call site is disabled',
  build.includes('DISABLED runPostUploadNavLogoQa') && !build.includes('await runPostUploadNavLogoQa('));
assert('follow-up visual-qa call sites are disabled',
  follow.includes('DISABLED runNavLogoVisualQaOnce') &&
    follow.includes('DISABLED runPostUploadNavLogoQa') &&
    !follow.includes('await runNavLogoVisualQaOnce(') &&
    !follow.includes('await runPostUploadNavLogoQa('));
assert(
  'follow-up continues leftover asks after logo swap',
  follow.includes('logo swap done — continuing remaining asks') && follow.includes('logoSwapCompleted'),
);
assert(
  'follow-up does not competitor-scrape after a logo swap',
  follow.includes('!logoSwapCompleted'),
);
assert('scrape capturePageTopScreenshot', scrape.includes('export async function capturePageTopScreenshot'));
assert('scrape capturePageScrollScreenshots', scrape.includes('export async function capturePageScrollScreenshots'));

function shouldRunNavLogoVisualQa(opts) {
  const hasExternalRef = (opts.imageUrls?.length || 0) > 0 || (opts.competitorScreenshots?.length || 0) > 0;
  const hasResult = !!opts.resultScreenshot || (opts.resultScreenshots?.length || 0) > 0;
  if (!hasExternalRef && !hasResult) return false;
  if (hasExternalRef) return true;
  if (opts.logoIntent) return true;
  if (opts.expectedLogoUrl) return true;
  return false;
}
assert(
  'visual-qa gate: no images → skip',
  !shouldRunNavLogoVisualQa({ logoIntent: true, imageUrls: [], competitorScreenshots: [] }),
);
assert(
  'visual-qa gate: screenshots alone → run',
  shouldRunNavLogoVisualQa({ competitorScreenshots: ['abc'] }),
);
assert(
  'visual-qa gate: live chunks + logo → run',
  shouldRunNavLogoVisualQa({ logoIntent: true, resultScreenshots: ['a', 'b'], expectedLogoUrl: 'https://x/logo.svg' }),
);

function listSlSectionNames(html) {
  const names = [];
  const re = /<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->/gi;
  let m;
  while ((m = re.exec(html))) {
    const n = m[1].toLowerCase();
    if (!names.includes(n)) names.push(n);
  }
  return names;
}
assert(
  'listSlSectionNames finds nav hero footer',
  listSlSectionNames(
    '<!-- SL:nav -->a<!-- /SL:nav --><!-- SL:hero -->b<!-- /SL:hero --><!-- SL:footer -->c<!-- /SL:footer -->',
  ).join(',') === 'nav,hero,footer',
);

// ── Section targeting must stay general, not a hardcoded noun list ──────────
assert(
  'placement resolves targets against live section names',
  /for \(const name of sectionNames\)[\s\S]{0,400}escapeRe\(spoken\)/.test(placement),
);
assert(
  'placement keeps synonyms only for parts named differently',
  placement.includes('SECTION_SYNONYMS'),
);
assert(
  'placement logo branch no longer gated on a fixed noun list',
  !/hasDestNoun/.test(placement),
);
assert(
  'preservation can locate an asset by section',
  preserve.includes('export function sectionsContainingAsset'),
);
assert(
  'follow-up restores a lost logo where it was, not always nav/footer',
  follow.includes('sectionsContainingAsset(originalHtmlForPreservation'),
);
assert(
  'unchanged section fails when the user named that section',
  helpers.includes('userNamedThisSection'),
);

// ── The model writes the checklist; code still does the checking ────────────
const requirementsSrc = readFileSync(join(__dirname, '../src/lib/ai-page-requirements.ts'), 'utf8');
assert('requirements expose a model-facing schema',
  requirementsSrc.includes('export const REQUIREMENT_EXTRACTION_INSTRUCTION'));
assert('model checklist is validated, not trusted',
  requirementsSrc.includes('export function parseModelRequirements'));
assert('model and regex checklists merge',
  requirementsSrc.includes('export function mergeRequirements'));
assert('section_changed is a checkable kind', requirementsSrc.includes("'section_changed'"));
assert('edit router asks for the checklist',
  follow.includes('REQUIREMENT_EXTRACTION_INSTRUCTION') && follow.includes('"requirements":[...]'));
assert('edit flow captures the routed checklist',
  follow.includes('captureModelRequirements'));
assert('edit flow merges model + regex checklists',
  /mergeRequirements\(\s*modelRequirements/.test(follow));
assert('edit flow passes the before-image so section_changed is checkable',
  follow.includes('beforeHtml: originalHtmlForPreservation'));
assert('create schema pass asks for the checklist',
  gen.includes('REQUIREMENT_EXTRACTION_INSTRUCTION') && gen.includes('parseModelRequirements'));
assert('create returns the checklist', gen.includes('{ requirements: modelRequirements }'));
assert('build accepts and merges the checklist',
  build.includes('parseModelRequirements(model_requirements') && build.includes('mergeRequirements('));
assert('client forwards the checklist to build',
  client.includes('createRequirementsRef') && client.includes('requirements: modelRequirements'));

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll helper + contract checks passed.');

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
assert('generate has ONE reference block', !gen.includes('STYLE + ASSETS ONLY') && !gen.includes('Reference site context — MANDATORY'));
assert('generate defers fidelity to the user', gen.includes('### How close to stay') && gen.includes("Read the user's own words above and judge it yourself"));
assert('generate does not force every section', !gen.includes('a content error, not a simplification'));
assert('generate guards credibility when condensing', gen.includes('What not to lose when you condense'));
assert('generate keeps reference weight proportional', gen.includes('Weight, not just presence'));
assert('generate keeps base design rules alive', gen.includes('The base design rules still apply'));
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
assert('follow-up logo swap is intent assetSource only', follow.includes("intent.assetSource === 'logo'"));
assert('follow-up forceEmbed on structural', follow.includes('forceEmbedLogoInHtml'));
assert('follow-up image roles from intent only', follow.includes('imageRolesFromIntent(intent'));
assert('follow-up no classifyAttachedImages fallback', !follow.includes('classifyAttachedImages'));
assert('follow-up does not keep a separate embed-url list from roles',
  !follow.includes('embedImageUrls'));
assert('follow-up materializeLogoUrl', follow.includes('materializeLogoUrl'));
assert('follow-up fetchLogoAssets', follow.includes('fetchLogoAssets'));

const helpers = readFileSync(join(__dirname, '../src/lib/ai-follow-up-helpers.ts'), 'utf8');
assert('helpers export userWantsUsToDecide', helpers.includes('export function userWantsUsToDecide'));
assert('helpers export looksLikeMultiIntent', helpers.includes('export function looksLikeMultiIntent'));
assert('helpers soft and-the-section pattern', helpers.includes('(and|,)\\s+(the\\s+)?'));
// classifyAttachedImages / AttachedImageRole used to be asserted present here.
// They were a second role vocabulary with nothing calling them — see the
// "One role vocabulary, not two" check below, which now asserts they are gone.
assert('helpers isDesignReferenceAsk', helpers.includes('export function isDesignReferenceAsk'));
assert('helpers extractDesignReferenceCopy', helpers.includes('export async function extractDesignReferenceCopy'));
assert('helpers requiredPhrases verify', helpers.includes('requiredPhrases'));
assert('helpers inferDesignMatchSectionNames', helpers.includes('export function inferDesignMatchSectionNames'));
assert('follow-up designReferenceUrls', follow.includes('designReferenceUrls'));
assert('follow-up DESIGN REFERENCE', follow.includes('DESIGN REFERENCE'));
// Was: asserted inferDesignMatchSectionNames (keyword) was wired in. Design-match
// sections now come from the classifier, falling back to a focused model call.
assert('follow-up resolves design-match sections via the model',
  follow.includes("label: 'follow-up:resolve-design-sections'"));
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

assert('follow-up scoped-despite-URL from intent.fullRebuild', follow.includes('!intent.fullRebuild'));
assert('follow-up shouldScrapeCompetitor', follow.includes('shouldScrapeCompetitor'));
assert('follow-up content image swap', follow.includes('isContentImageSwapAttempt'));
assert('follow-up fetchContentImageAssets', follow.includes('fetchContentImageAssets'));
assert('follow-up multi-intent retry finish', follow.includes('multi-intent completed after retry'));
assert('follow-up design-ref OCR', follow.includes('extractDesignReferenceCopy'));
assert('follow-up REQUIRED visible copy', follow.includes('REQUIRED visible copy from an attached screenshot'));
assert('follow-up Retrying step', follow.includes('Retrying step'));

assert('generate stripUnpromptedSocialProof', gen.includes('stripUnpromptedSocialProof'));
assert('generate REAL SITE PHOTOS', gen.includes('REAL PHOTOS FROM THE REFERENCE SITE'));
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
assert('follow-up content reuse from intent only', follow.includes('intent.contentReuse'));
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
assert('generate multi-ask from createIntent asks', gen.includes('createIntent?.asks.length'));
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
// The create path's reply used to be written in the browser after the stream
// closed. It is composed on the server now (a build outlives the tab that asked
// for it), so the two checks below follow it there rather than lapsing.
const pageBuilds = readFileSync(join(__dirname, '../src/lib/page-builds.ts'), 'utf8');

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
const fromHtml = readFileSync(join(__dirname, '../src/app/api/pages/from-html/route.ts'), 'utf8');
const schemaFromHtml = readFileSync(join(__dirname, '../src/app/api/pages/[id]/schema-from-html/route.ts'), 'utf8');
const rebuildFlow = readFileSync(join(__dirname, '../src/app/api/pages/[id]/rebuild-flow/route.ts'), 'utf8');
const ensureEditable = readFileSync(join(__dirname, '../src/app/api/pages/[id]/ensure-editable/route.ts'), 'utf8');
const uploadRoute = readFileSync(join(__dirname, '../src/app/api/upload/route.ts'), 'utf8');
const pagesService = readFileSync(join(__dirname, '../src/lib/services/pages.ts'), 'utf8');
const testsService = readFileSync(join(__dirname, '../src/lib/services/tests.ts'), 'utf8');
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
// Create path, same rule as the edit path: the model's checklist plus one
// code-invented floor (an asset we embedded must be present). No prompt-derived
// keyword requirements — those invented asks the user never made.
assert('build wires requirements', build.includes('assetRequirements(') && build.includes('checkRequirements'));
assert('build derives no requirements from prompt keywords',
  !build.includes('extractRequirements('));
assert('build reports unmet', build.includes('unmet_requirements'));
// The checklist is the model's (seeded by the intent pass, refined by routing);
// the only check code invents is "an asset we embedded is present".
assert('follow-up wires requirements', follow.includes('assetRequirements(') && follow.includes('describeUnmet'));
assert('follow-up seeds the checklist from the intent pass',
  follow.includes('let modelRequirements: PageRequirement[] = intent.requirements'));
assert('follow-up no longer derives requirements from prompt keywords',
  !follow.includes('extractRequirements('));
assert('follow-up unmet downgrades toast', follow.includes('Still not applied'));
assert('the create path still reports unmet asks',
  pageBuilds.includes('unmet_requirements') && pageBuilds.includes('not everything landed'));
assert('the client shows the reply the build composed',
  client.includes('assistant_reply') && client.includes('unmet_requirements'));

// ── Routing is decided by the model; intent failure clarifies (no regex) ────
const intentSrc = readFileSync(join(__dirname, '../src/lib/ai-edit-intent.ts'), 'utf8');
assert('intent module exists', intentSrc.includes('export async function classifyEditIntent'));
assert('intent validates against live sections', intentSrc.includes('export function normalizeIntent'));
assert('intent never invents a source URL', intentSrc.includes('allowedUrls.includes(claimedUrl)'));
assert('intent asks the model for the checklist too', intentSrc.includes('requirementInstruction'));
assert('follow-up classifies intent first', follow.includes('await classifyEditIntent('));
// A failed classification is OUR outage, not a badly-worded request: report it
// and let them retry. It must not regex-route, and must not push a clarifying
// question into their conversation asking them to re-explain a clear message.
assert('intent failure reports an AI outage instead of interrogating the user',
  follow.includes('intent unavailable — reporting AI outage, no regex fallback') &&
    follow.includes('didn’t respond properly just now'));
assert('no allowIntentKeywordFallback gate', !follow.includes('allowIntentKeywordFallback'));
assert('edit-intent budget allows the checklist',
  /maxTokens: (?:8000|1[6-9]\d{3}|[2-9]\d{4,})/.test(intentSrc));
assert('follow-up routes design match off the intent', follow.includes('const wantsDesignMatch = intent.designReference'));
assert('follow-up routes multi-ask off the intent', follow.includes('intent.asks.length > 1'));
assert('follow-up takes target sections from the intent', follow.includes('intentSections.length > 0') || follow.includes('intent.targetSections'));
assert('follow-up does not ternary-fallback design match to keywords',
  !follow.includes(': isDesignReferenceAsk(prompt, hasUserImages)'));
assert('create path classifies intent too', gen.includes('await classifyEditIntent('));
assert('create decision is forwarded, not re-guessed',
  gen.includes('reuse_reference_copy: reuseReferenceWords') &&
    build.includes("typeof reuse_reference_copy === 'boolean'") &&
    client.includes('reuse_reference_copy: reuseReferenceCopy'));
assert('generate does not keyword-guess design ask when intent missing',
  gen.includes('createIntent.designReference') && !gen.includes('isDesignReferenceAsk('));

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
  helpers.includes('const userNamedThisSection = intentTargetSections.includes(sectionName)'));
assert('content-reuse (logo/text/image placement) comes from the classifier',
  intentSrc.includes('contentReuse: ContentReuseIntent | null') &&
    follow.includes('const resolveContentReuse ='));
assert('follow-up never calls detectContentReuseIntent',
  !follow.includes('detectContentReuseIntent'));
assert('"proceed anyway" / "you decide" comes from the classifier',
  intentSrc.includes('proceedAnyway: boolean') && follow.includes('const wantsUsToDecide = intent.proceedAnyway'));
// Strip comments first: tombstones naming a deleted helper are documentation,
// not a call. Only real code counts.
const followCode = follow
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');
assert('edit route references no keyword-decision helper at all',
  !/\b(userWantsUsToDecide|isLogoStyleAsk|inferTargetSectionNames|inferDesignMatchSectionNames|promptHasIntentionalLogoReplace|promptHasRemovalIntent|looksLikeMultiIntent|detectContentReuseIntent|wantsReferenceCopy|isSimpleTextRewritePrompt)\s*\(/.test(followCode));
assert('planner decides design-match per step, not a keyword test',
  helpers.includes('design_match: boolean') && follow.includes('step.design_match'));
assert('planner clarify override uses the caller\'s forceDecide only',
  !/userWantsUsToDecide\(prompt\)/.test(helpers.split('PLANNER_SYSTEM')[1] ?? ''));
assert('page shape is model-decided, no keyword pre-check',
  !gen.includes('userWantsCustomOrMinimalPage(prompt)') &&
    !brand.includes('if (userWantsCustomOrMinimalPage(prompt)) return'));
const builderSrc = readFileSync(join(__dirname, '../src/lib/ai-page-builder.ts'), 'utf8');
assert('builder takes the shape decision from upstream',
  builderSrc.includes('options.minimalShape === true') &&
    build.includes('minimalShape: minimal_shape === true'));
assert('create/build do not switch embed-all vs embed-none on a design_reference boolean',
  !gen.includes('design_reference: designAsk') &&
    !build.includes('imagesAreDesignRefs') &&
    !builderSrc.includes('imagesAreDesignRefs') &&
    !client.includes('design_reference: designReference') &&
    !builderSrc.includes('Embed them directly in the HTML using EXACTLY these URLs') &&
    !builderSrc.includes('DESIGN REFERENCES showing how the page should LOOK') &&
    builderSrc.includes('attachedImagesInstructionNote(') &&
    gen.includes('The instruction says what they are for'));
assert('create path classifies intent for plain text prompts too, not just attachments',
  gen.includes('const createIntent = prompt.trim()'));
assert('create path\'s multi-ask note comes from the classifier',
  gen.includes('(createIntent?.asks.length ?? 0) > 1'));

assert('build stamps data-field from schema', build.includes('ensureClickToEditFields(html, enrichedSchema)'));
assert('follow-up stamps data-field after a successful edit',
  follow.includes('ensureClickToEditFields(finalHtmlPersisted'));
// Recolour/resize must not be read as "copy the logo somewhere". This was a
// regex that overruled the model AFTER it answered; it is now stated in the
// classifier's own instructions, so the model answers correctly in one pass.
assert('logo style asks are not treated as logo embed in intent normalize',
  intentSrc.includes('NOT for recoloring') &&
    intentSrc.includes('NOT for resizing') &&
    !intentSrc.includes('isLogoStyleAsk(opts.prompt)'));
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
assert('multi-ask count is classifier asks only',
  follow.includes('const hasMultipleAsks = intent.asks.length > 1') &&
    !follow.includes('looksLikeMultiIntent(prompt)'));
assert('multi-ask no-op does not use the design-reference-only toast',
  /const designMatch\s*=\s*\n?\s*!hasMultipleAsks\s*&&/.test(follow));
// A failure must name every ask it dropped, not just the one whose wording
// happened to match a keyword — that hid half of a two-part failure.
assert('no-op failure enumerates every failed ask',
  follow.includes('const failedAsks = intent.asks') && follow.includes('None of these applied:'));
assert('no-op failure says which part of the page was unresolved',
  follow.includes('const noTargetResolved =') &&
    follow.includes('couldn’t tell which part of the page'));
// A model that hands back byte-identical HTML gets one corrective retry before
// the user is told "nothing changed" — "remove this" + a screenshot died here.
assert('no-op gets one corrective retry against the resolved section',
  follow.includes('no-op retry applied') &&
    follow.includes('your previous attempt returned this section completely unchanged'));
assert('retry keeps click-to-edit handles',
  follow.includes('Keep every data-field attribute'));
// The classifier must SEE the page, not just section names — without this,
// "remove this"/"that strip" can never resolve to a section.
assert('intent classifier receives a per-section outline',
  intentSrc.includes('export function buildSectionOutline') &&
    intentSrc.includes('sectionOutline?: SectionOutlineEntry[]') &&
    follow.includes('sectionOutline: intentSectionsSnapshot.map('));
assert('outline is capped so long pages cannot blow up the call',
  intentSrc.includes('OUTLINE_CHARS_PER_SECTION') && intentSrc.includes('OUTLINE_MAX_SECTIONS'));
// Screenshot copy lands only where the model said — never a keyword guess,
// never an arbitrary footer/nav/hero dump.
assert('design-copy placement uses model-resolved sections only',
  build.includes('design_copy_sections') &&
    !build.includes('inferDesignMatchSectionNames') &&
    build.includes('no model-resolved target section'));
assert('design-copy sections are forwarded create → build',
  gen.includes('design_copy_sections: createIntent.targetSections') &&
    client.includes('design_copy_sections: designCopySections'));
assert('image roles come from intent when available',
  intentSrc.includes('export function imageRolesFromIntent') &&
    follow.includes('imageRolesFromIntent(intent'));
assert('no single-image logo→bug regex short-circuit',
  !helpers.includes("if (/\\b(fix|wrong|broken|sloppy|align|spacing|logo)\\b/i.test(prompt))"));
assert('no classifyAttachedImages on follow-up path',
  follow.includes('attached image roles from intent') &&
    !follow.includes('classifyAttachedImages'));
assert('open page can stamp missing data-field',
  client.includes('ensure-editable') &&
    readFileSync(join(__dirname, '../src/app/api/pages/[id]/ensure-editable/route.ts'), 'utf8').includes('ensureClickToEditFields'));
assert('structural stamp exists for screenshot copy',
  readFileSync(join(__dirname, '../src/lib/ai-data-field-stamp.ts'), 'utf8').includes('stampStructuralDataFields'));

// ── Zero keyword-driven decisions left in the edit path ─────────────────────
assert('no keyword shortcut forks routing',
  !follow.includes('function isSimpleTextRewritePrompt'));
assert('surgical text path is gated on the classifier',
  follow.includes('const surgicalEligible =') && follow.includes('intent.asks.length <= 1'));
assert('section fallbacks ask the model, never a regex',
  !/inferTargetSectionNames\(/.test(follow) &&
    follow.includes('resolveSectionsForAsk({'));
assert('section resolver refuses to guess',
  intentSrc.includes('export async function resolveSectionsForAsk') &&
    intentSrc.includes('caller must not guess'));
assert('removal intent comes from the classifier',
  intentSrc.includes('removalIntent: boolean') &&
    follow.includes('removalIntent: intent.removalIntent') &&
    !/promptHasRemovalIntent\(/.test(follow));
assert('intentional asset replace comes from the classifier',
  intentSrc.includes('intentionalAssetReplace: boolean') &&
    follow.includes('intent.intentionalAssetReplace') &&
    !/promptHasIntentionalLogoReplace\(/.test(follow));
assert('preservation accepts an explicit removal decision',
  preserve.includes('removalIntent?: boolean'));
// Stronger than the old runtime check: the parameter is REQUIRED, so no code
// path can omit it and fall back to word-matching. TypeScript enforces it.
assert('classifier sections are authoritative even when empty',
  helpers.includes('intentTargetSections: string[];') &&
    !helpers.includes('intentTargetSections?:') &&
    !/namesThisSection = .*\.test\(prompt\)/.test(helpers));
assert('failure messaging has no keyword style test',
  !follow.includes('const styleAsk ='));

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

// A source URL given in an earlier turn is still usable this turn — via intent only
assert('helpers export referencesEarlierSource', helpers.includes('export function referencesEarlierSource'));
assert('follow-up inherits earlier source via intent only',
  follow.includes('intent.usesEarlierSource') &&
    !follow.includes('referencesEarlierSource(prompt)'));

// Screenshot copy is not content unless the user asked for the words
assert('placement exports wantsReferenceCopy', placement.includes('export function wantsReferenceCopy'));
assert('build gates design OCR on reuseReferenceCopy boolean', build.includes('reuseReferenceCopy'));
assert('generate gates design OCR on intent reuseReferenceCopy',
  gen.includes('createIntent?.reuseReferenceCopy') || gen.includes('reuseReferenceWords'));

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
  follow.includes('sectionsContainingAsset(preservationBaseline'),
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
  follow.includes('beforeHtml: preservationBaseline'));
assert('create schema pass asks for the checklist',
  gen.includes('REQUIREMENT_EXTRACTION_INSTRUCTION') && gen.includes('parseModelRequirements'));
assert('create returns the checklist', gen.includes('{ requirements: modelRequirements }'));
assert('build accepts and merges the checklist',
  build.includes('parseModelRequirements(model_requirements') && build.includes('mergeRequirements('));
assert('client forwards the checklist to build',
  client.includes('createRequirementsRef') && client.includes('requirements: modelRequirements'));

// ── A hint about WHERE must never decide WHAT ────────────────────────────────
// The class of bug behind "add a section" being carried out as "edit the hero":
// a value being already set caused a model decision to be skipped entirely.
assert('classifier hint does not pre-empt the dispatcher',
  /let pinnedSections: string\[\] \| null =/.test(follow) &&
  /let targetSections: string\[\] \| null = null;/.test(follow));
assert('the dispatcher is not gated on the classifier having named a section',
  !/targetSections: string\[\] \| null =\s*\n?\s*intentSections\.length > 0/.test(follow));
assert('an unusable routing result still honours the classifier hint',
  follow.includes('routing unusable — patching classifier-named sections'));

// ── Asks carry their own kind of job, and their own reference ────────────────
assert('asks declare an op', /export type EditAskOp =/.test(intentSrc) &&
  /op: EditAskOp;/.test(intentSrc));
assert('add-asks are excluded from the patch target union',
  /asks\.filter\(\(a\) => a\.op !== 'add'\)/.test(intentSrc));
assert('an add ask may legitimately name no section',
  intentSrc.includes('leaving "sections" EMPTY is correct and expected'));
assert('asks carry a count so multi-section adds are not silently halved',
  /count: number;/.test(intentSrc) && /count\?: number;/.test(helpers));
assert('the insert path honours the requested count',
  /const wanted = Math\.min\(Math\.max\(step\.count \?\? 1, 1\), 4\)/.test(follow));
assert('planner seeds the ask op instead of hardcoding patch',
  !/op: 'patch' as const,/.test(helpers) && /a\.op === 'add'\s*\?\s*'insert_section'/.test(helpers));
assert('a lone structural ask still reaches the step executor',
  /seeded\.length === 1 && seeded\[0\]\.op !== 'patch'/.test(helpers) &&
  /hasMultipleAsks \|\| hasStructuralAsk/.test(follow));

// ── One reference image must not license rebuilding every section ────────────
assert('design match is decided per ask, not per message',
  /designMatch: boolean;/.test(intentSrc) && /design_match: a\.designMatch === true/.test(helpers));
assert('the message-level design flag is no longer stamped onto every step',
  !/design_match: opts\.designMatch \?\? false/.test(helpers));
assert('each step gets only the images its ask points at',
  /imageIndexes: number\[\];/.test(intentSrc) && /const stepImages = step\.image_urls \?\? routingImageUrls/.test(follow));

// ── Constraints are conditions, not work items ──────────────────────────────
assert('constraints are classified separately from asks',
  /constraints: string\[\];/.test(intentSrc) && intentSrc.includes('"constraints"'));
assert('constraints reach every step', /const withConstraints = /.test(follow) &&
  /withConstraints\(step\.instruction/.test(follow));
assert('the planner is told not to emit a step for a constraint',
  helpers.includes('Constraints are not steps'));

// ── Destruction is rejected, not narrated ───────────────────────────────────
assert('an edit that destroys unrequested content is rejected',
  /let destructive = false;/.test(follow) &&
  /rejecting destructive edit — restoring pre-edit page/.test(follow));
assert('whether a loss was intended is judged by the model, not by counting',
  /export async function judgeUnrequestedLoss/.test(helpers) &&
  /await judgeUnrequestedLoss\(/.test(follow));
assert('an unavailable loss judgement never reverts a good edit',
  helpers.includes('treating loss as intended'));
assert('click-to-edit is re-stamped before damage is measured, not after',
  follow.indexOf('stamped missing data-field attributes before loss check') <
    follow.indexOf('const losses = findUnrequestedLosses'));

// ── Repair the damage before throwing the user's edit away ──────────────────
// Reverting everything makes the user pay for our mistake: they asked for one
// change, got it, we broke something unrelated, and handed back their old page.
assert('damage is repaired before an edit is rejected',
  /export function restoreDamagedSections/.test(preserve) &&
  /await restoreDamagedSections\(|restoreDamagedSections\(\{/.test(follow) &&
  follow.indexOf('restoreDamagedSections({') <
    follow.indexOf('rejecting destructive edit — restoring pre-edit page'));
assert('a repair never silently undoes the section the user asked about',
  /protectedSections: requestedSections/.test(follow) &&
  /intent\.asks\.flatMap\(\(a\) => a\.sections\)/.test(follow) &&
  preserve.includes('quietly undo the very thing that was asked for'));
assert('what survives a repair is re-judged, not assumed',
  /losses: afterRepair/.test(follow) && /stillDestructive/.test(follow));
assert('the loss summary is taken from the repaired page, not the page as it was',
  /const lossNote = describeLosses\(effectiveLosses\)/.test(follow));
// Shipped to a real user: "That edit would also have removed An image and the
// team.members.0.generated_image_url field were removed, even though ..., which
// isn't part of what you asked for."
assert('the judge sentence is not spliced into another sentence',
  !/would also have removed \$\{lossSummary/.test(follow) &&
  /const damage = lossSummary/.test(follow));
assert('the judge is told its summary is shown verbatim',
  helpers.includes('shown to the user verbatim as a standalone sentence'));
assert('internal field names are kept out of user-facing damage reports',
  helpers.includes('never quote internal identifiers'));

// ── The general path is reachable from EVERY dead end ───────────────────────
// A narrow verb failing means our vocabulary was too short, not that the ask was
// impossible. Every one of these used to end the turn with an error.
assert('there is one general fallback, declared once',
  /const tryGeneralFallback = async \(reason: string, baseHtml: string\)/.test(follow) &&
  follow.includes('The one general path, reachable from every narrow dead end'));
assert('the general fallback runs the region rewrite, not a full-page rebuild',
  follow.indexOf('const tryGeneralFallback') < follow.indexOf('applyRegionRewriteToHtml({') ||
  /tryGeneralFallback[\s\S]{0,900}applyRegionRewriteToHtml\(\{/.test(follow));
for (const site of [
  'content_reuse_text_no_payload',
  'content_reuse_text_failed',
  'content_reuse_image_no_source',
  'content_reuse_image_failed',
  'full_page_too_long',
  'full_page_invalid_json',
  'full_page_invalid_patch',
  'full_page_invalid_html',
  'structural_rebuild_failed',
  'html_unchanged',
]) {
  assert(`dead end "${site}" falls through to the general path`,
    new RegExp(`tryGeneralFallback\\(\\s*\\n?\\s*'${site}'`).test(follow) ||
    follow.includes(`tryGeneralFallback('${site}'`) ||
    follow.includes(`? '${site}'`) || follow.includes(`: '${site}',`));
}
assert('a failed scoped op tries the general path before erroring',
  /!\(await tryGeneralFallback\(scopedFailureReason, html\)\)/.test(follow));
assert('"I couldn\'t apply that" is the last thing said, not the first',
  follow.indexOf("tryGeneralFallback('html_unchanged'") <
    follow.indexOf('I couldn’t apply that.'));
assert('a recovered turn does not then re-run the full-page path',
  /if \(scopedApplied\) \{[\s\S]{0,400}already recovered by region rewrite/.test(follow) &&
  /if \(!structuralRecovered\) finalSchemaJson = enrichedSchema;/.test(follow));

// ── One number for how many attachments a message carries ───────────────────
// The route accepted 3, the classifier looked at 2, the role assigner labelled
// 2 — so a third image arrived unseen and took the default role, which means
// "rebuild that section from this picture".
assert('the attachment cap is a single shared constant',
  /export const MAX_ATTACHMENTS = 3;/.test(intentSrc) &&
  /slice\(0, MAX_ATTACHMENTS\)/.test(intentSrc) &&
  /slice\(0, MAX_ATTACHMENTS\)/.test(follow));
assert('no attachment cap is hardcoded next to the shared one',
  !/const images = \(opts\.imageUrls \?\? \[\]\)\.slice\(0, 2\)/.test(intentSrc));

// ── One role vocabulary, not two ────────────────────────────────────────────
// A second, older AttachedImageRole enum sat in the helpers with three values
// and a default of bug_reference. Nothing called it.
assert('the duplicate attachment-role classifier is gone',
  !helpers.includes('classifyAttachedImages') &&
  !helpers.includes('AttachedImageRole') &&
  !follow.includes('classifyAttachedImages'));

// ── A screenshot can say WHERE, not just how it should look ─────────────────
// "pls put the image of the hero section here as well" + a screenshot of their
// own About section. With no role for "this is the bit I mean", the picture was
// read as a design to copy, the section was rebuilt from it, and the real team
// photo it did not happen to show was destroyed.
assert('an attachment can be a pointer instead of a design',
  /'locator'/.test(intentSrc) &&
  intentSrc.includes('"locator": it shows a part of OUR page purely to say WHICH part'));
assert('a locator is never embedded and never rebuilt from',
  intentSrc.includes('it is never embedded and never copied from'));
assert('a locator survives the message-level design flag',
  /const onlyLocators = /.test(intentSrc) &&
  /truthy\(raw\.design_reference\) && !onlyLocators/.test(intentSrc));
assert('a locator cannot carry design_match on its ask',
  intentSrc.includes('is ALWAYS design_match false'));

// ── Reuse copies what is already there, from where the user said ────────────
assert('image reuse reads the source section the classifier resolved',
  /content reuse: image from section/.test(follow) &&
  /extractPrimaryImageFromSection\(html, srcName\)/.test(follow));
assert('image reuse no longer starts from the page logo when a source was named',
  !/const existingImg = extractPrimaryLogoUrlFromHtml\(html\);/.test(follow));
assert('only a content_asset attachment may be embedded as the asset',
  /imageRolesFromIntent\(intent, effectiveImageUrls\)\s*\n\s*\.filter\(\(r\) => r\.role === 'content_asset'\)/.test(follow) &&
  /const imgUrl = existingImg \?\? attachedAssets\[0\]/.test(follow));
assert('a named source with no image says so instead of pasting something else',
  /I couldn't find an image in the \$\{imgSourceHint\} section to copy/.test(follow));

// ── "Done" must mean the ask happened ───────────────────────────────────────
assert('there is an outcome check, not just a bytes-changed check',
  /export async function verifyAskApplied/.test(helpers) &&
  /not_applied:\$\{name\}/.test(follow));
assert('an unavailable outcome check does not discard a real edit',
  helpers.includes('treating step as applied'));

// ── An attachment is a source; never go scrape a different one ──────────────
// Deliberately not pinned to the exact condition list: the guard has since
// gained `&& libraryAssets.length === 0` and may gain more sources. What must
// hold is that attached user images are one of the things it counts.
assert('attached images count at the inherited-source guard',
  /if \(competitorUrls\.length === 0 && !hasUserImages\b/.test(follow));

// ── New sections can contain real images ────────────────────────────────────
assert('the insert path can generate images', follow.includes('SL_IMG_1') &&
  /image_prompts/.test(follow));
assert('unfilled image slots never ship as a literal src',
  /src=\["'\]SL_IMG_/.test(follow));

// ── Where a new section goes is decided, not defaulted ──────────────────────
assert('insert placement is resolved by the model',
  /export async function resolveInsertPlacement/.test(intentSrc) &&
  /await resolveInsertPlacement\(/.test(follow));
assert('an unplaced insert no longer anchors on the last section, after it',
  !/liveSections\[liveSections\.length - 1\]\?\.name \?\?\s*\n?\s*null;/.test(follow));
assert('the chosen position is honoured by the splice',
  /insertSlSectionBlock\(workingHtml, anchorForNext, positionForNext, wrappedBlock\)/.test(follow));
assert('a multi-section add stays on the near side of its anchor',
  /positionForNext = 'after';/.test(follow));

// ── Moving a section is not editing a section ───────────────────────────────
assert('reorder survives as its own op instead of collapsing to structural',
  /'reorder_sections'/.test(helpers) &&
  !/a\.op === 'reorder'\s*\?\s*'structural'/.test(helpers));
assert('the step executor can actually move sections',
  /step\.op === 'reorder_sections'/.test(follow) &&
  /await resolveSectionOrder\(/.test(follow) &&
  /reorderSlSections\(workingHtml, newOrder\)/.test(follow));
assert('a partial reorder is refused rather than half-applied',
  intentSrc.includes('section order was not a clean permutation'));

// ── There is a general hand, so a fixed verb list is not the ceiling ────────
assert('the region a change needs is resolved by the model',
  /export async function resolveEditRegion/.test(intentSrc) &&
  /await resolveEditRegion\(/.test(follow));
assert('a run of sections can be rewritten wholesale',
  /async function runRegionRewrite/.test(follow) &&
  /function findSlRegionBounds/.test(follow));
// Adding, deleting, splitting, merging and reordering must all still be
// sayable. The contract changed HOW a deletion is expressed (name it), never
// whether it can be — taking the verb away would be the old bug in reverse.
assert('the region rewrite may still return a different set of sections',
  follow.includes('brand new ones (splitting or adding), or the whole run reordered') &&
  follow.includes('listing the absorbed name in "deleted"'));
assert('work the narrow verbs cannot express falls to the general one',
  /stepTargets\.length === 0 \|\| step\.op === 'structural'/.test(follow) &&
  /await applyRegionRewrite\(step\.instruction, stepImages\)/.test(follow));
assert('a failed narrow verb falls through instead of dead-ending',
  (follow.match(/await applyRegionRewrite\(/g) ?? []).length >= 4);
assert('the region splice is checked before it counts as done',
  follow.includes('region splice did not survive re-extraction'));
// "Could not act" and "chose to ask" are separate outcomes, and neither may be
// reported as success. The null checks are split now that a question is a third
// return shape — both halves still have to return null.
// A failure now carries WHY. All three used to collapse into null, and the user
// got one sentence — "name the section" — which is only true for one of them.
assert('a region rewrite that cannot act reports failure, never success',
  /if \(result\.kind === 'failed'\) return result;/.test(follow) &&
  /return \{ kind: 'failed', reason: 'unusable' \};/.test(follow));
assert('the reason survives all the way to the user, per case',
  follow.includes('function regionFailureMessage(reason: RegionFailReason)') &&
  follow.includes("case 'too_long':") &&
  follow.includes('message: regionFailureMessage(regionFailReason),'));
assert('a too-large payload is named as such, never blamed on wording',
  /isPromptTooLongError\(err\)/.test(follow) &&
  follow.includes('too large to change several sections at once'));
assert('both edit paths share one region rewrite, not two copies',
  /async function applyRegionRewriteToHtml/.test(follow) &&
  (follow.match(/applyRegionRewriteToHtml\(\{/g) ?? []).length >= 2);
assert('a single unroutable instruction tries the region before a full rebuild',
  follow.indexOf('Rewriting that part of the page') > 0 &&
  follow.indexOf('routing did not qualify and no region resolved') > 0);
assert('region results still pass through the damage guard',
  follow.indexOf('const losses = findUnrequestedLosses') >
    follow.indexOf('async function applyRegionRewriteToHtml'));

// ── Region rewrite is the job, not a backup after a menu ────────────────────
// Menus (op / attachment_roles / routing.type) must not pick the executor.
// Sonnet already understands mixed prompts and images; code that forces a
// nearest button is the hurdle. Fetch-from-URL stays (the model cannot download).
assert('the region rewrite is the primary executor, not a fallback-only path',
  follow.includes('primary region rewrite applied') &&
  follow.includes('PRIMARY executor') &&
  follow.includes('primary region rewrite could not act'));
assert('a rewrite miss does not dispatch a menu',
  follow.includes('primary region rewrite missed — not dispatching a menu'));
assert('the rewrite model is not told to embed every attached URL',
  !follow.includes('use these EXACT strings verbatim in any src attribute') &&
  follow.includes('Embed an attached URL in src ONLY when the user wants that picture itself on the page'));
assert('follow-up full-page does not dispatch attachments by role menu',
  !follow.includes('ONLY these URL(s) may be used in src attributes (content assets)') &&
  !follow.includes('User-attached image(s) are bug-reference screenshots for diagnosis') &&
  !follow.includes('Image roles: ONLY embed these content-asset URL(s)'));
assert('create, edit, and follow-up share one attached-image instruction note',
  intentSrc.includes('export function attachedImagesInstructionNote') &&
  follow.includes('attachedImagesInstructionNote(') &&
  builderSrc.includes('attachedImagesInstructionNote('));
// The editable set no longer has to be one contiguous strip — that single fact
// cost a two-part message its second ask ("the footer's logo on the nav, and
// the hero's image in the about section" sent only nav). A page that fits is
// sent whole; a page too big is triaged, and there the classifier's sections
// and the resolver's run are UNIONED so neither read can drop an ask alone.
assert('the editable set may be scattered, and is never one strip',
  follow.includes('Sections do not have to be neighbours') &&
  /editableNames = Array\.from\(new Set\(\[\.\.\.focus, \.\.\.fromResolver\]\)\)/.test(follow));
assert('a page that fits is sent whole rather than sliced',
  /if \(bodyChars <= contextBudget\) \{/.test(follow) &&
  follow.includes('editableNames = focus.length > 0 ? focus : body.map((sec) => sec.name);'));
assert('the classifier\'s sections actually reach the rewrite',
  follow.includes('focusSections?: string[];') &&
  (follow.match(/focusSections: intent\.targetSections,/g) || []).length >= 4);

// ── The MODEL decides whether to ask, not the code ──────────────────────────
// Clarifying questions used to live in two code-owned exits (the planner's
// plan.mode==='clarify' and routing.clarifying_question), both of which decided
// from confidence scores and keyword guards whether a human got asked anything.
// Both are unreachable now. The rewrite itself judges it instead: it is shown
// the page, the instruction and the attachments, so it is the only thing that
// can tell "two real readings" from "vague taste I should just exercise".
assert('the rewrite prompt gives the model a way to ask',
  follow.includes('{"question":"...one short question, in plain language..."}') &&
  follow.includes('This is YOUR call and yours alone'));
assert('vague style is explicitly NOT a reason to ask',
  follow.includes('Vague taste is your judgement to exercise, not an ambiguity'));
assert('a question is a distinct outcome, never a failed rewrite',
  /kind: 'question'; question: string/.test(follow) &&
  follow.includes("if (result.kind === 'question') return result;"));
assert('the question is checked before the no-sections failure',
  follow.indexOf("kind: 'question', question }") <
    follow.indexOf('region rewrite replied with words but no edit'));
assert('the model\'s question reaches the user verbatim',
  follow.includes("sendSSE(controller, { type: 'clarify', message: result.question })"));
assert('asking twice in a row is prevented by conversation fact, not by judging the ask',
  follow.includes('noQuestions: lastAssistantWasClarify || wantsUsToDecide') &&
  follow.includes('content: result.question, clarify: true'));
assert('a mid-recovery and a mid-plan rewrite may not ask',
  (follow.match(/noQuestions: true/g) || []).length >= 2);

// ── A reply with words and no edit is asked again, not thrown away ──────────
// A user pointed at a section with a screenshot and asked for a redesign. The
// screenshot was read, the section resolved, the call returned cleanly — and
// the reply was a confident one-line account of the redesign with no HTML in
// it. We discarded the turn and told them to name a section we had named two
// steps earlier. The contract marks "message" always required and never says
// the same of "sections", so words-only is a legal reply: the guard has to be
// code, because a prompt rule is guidance and this is not.
assert('a reply carrying no edit at all is its own failure, not "unusable"',
  follow.includes("| 'empty_reply'") &&
  follow.includes("return { kind: 'failed', reason: 'empty_reply' };"));
assert('the retry wraps the call instead of living inside it',
  follow.includes('async function runRegionRewriteOnce(opts: {') &&
  follow.includes('const first = await runRegionRewriteOnce(opts);') &&
  follow.includes('const second = await runRegionRewriteOnce(opts);'));
assert('only an empty reply is retried, and only once',
  /if \(first\.kind !== 'failed' \|\| first\.reason !== 'empty_reply'\) return first;/.test(follow) &&
  (follow.match(/await runRegionRewriteOnce\(opts\)/g) || []).length === 2);
assert('no caller bypasses the retry by calling the inner function',
  (follow.match(/await runRegionRewrite\(\{/g) || []).length >= 1 &&
  !/await runRegionRewriteOnce\(\{/.test(follow));
// A question, a no_change, a deletion and {"sections":[]} are all read and
// returned above this point, so none of them can reach the retry.
assert('the retry sits after every legitimate reply shape has been taken',
  follow.indexOf("kind: 'question', question }") <
    follow.indexOf("reason: 'empty_reply'") &&
  follow.indexOf("kind: 'no_change', reason }") <
    follow.indexOf("reason: 'empty_reply'"));
assert('the failure no longer sends the user back to name a section we resolved',
  follow.includes(`return "That didn't come through properly. Please send it once more — your page hasn't been changed.";`) &&
  !/return "I couldn't work out what to change\./.test(follow));
assert('the reasoning behind an empty reply is kept, not discarded',
  follow.includes('onThinking: (t) => {') &&
  follow.includes('thinkingTail: thinking.slice(-2000)'));

// The splice keeps any section the model does not mention; only "deleted"
// removes. The prompt went on telling the model the opposite long after that
// changed, on every single edit.
assert('the model is not told that an unreturned section is destroyed',
  !follow.includes('Every section in this run is being replaced by what you return') &&
  follow.includes('Inside a section you DO return, anything you fail to carry across is destroyed'));
assert('the warning that is still true is kept, scoped to one section',
  follow.includes('A section you do not return at all is kept exactly as it is'));

const aiClient = readFileSync(join(__dirname, '../src/lib/ai-client.ts'), 'utf8');
assert('a caller can be handed the model\'s reasoning for a call',
  aiClient.includes('onThinking?: (thinking: string) => void;') &&
  (aiClient.match(/options\.onThinking\?\.\(thinkingText\(response\.content\)\)/g) || []).length === 2);
assert('reasoning is offered before the truncation throw, not after',
  aiClient.indexOf('options.onThinking?.(thinkingText(response.content));') <
    aiClient.indexOf('throw new AIResponseTruncatedError'));
assert('a thinking block that the SDK does not expose is simply no reasoning',
  aiClient.includes("rec.type === 'thinking' && typeof rec.thinking === 'string'"));

// "Nothing could place this ask" is handed to the rewrite as a fact, so that
// call decides between doing it and asking. Widening the region is a mechanical
// safety (show everything rather than the wrong slice), never a decision to
// rewrite everything.
assert('an unplaced ask travels as a fact, not as a decision to rebuild the page',
  /regionUnresolved = editableNames\.length === 0;/.test(follow) &&
  follow.includes('regionUnresolved,') &&
  follow.includes('an earlier step could not work out which part of the page'));
assert('the unplaced ask can still just be done, or asked about — both allowed',
  follow.includes('change just those sections and say nothing about the others') &&
  follow.includes('reply with {"question"} rather than guessing'));
assert('the widened-region case is visible in the logs',
  follow.includes('unresolved: regionUnresolved'));

// ── A model asked to rule on something must be shown the thing ──────────────
// Reported from client testing: "pls put the image of the hero section here as
// well" + a crop of the About section. The rewrite did it — the About photo was
// replaced by the hero photo, which is the ask — and the loss judge threw the
// whole edit away. It had been handed the literal string "1 image(s)": no URL,
// no section. It could not tell the replaced photo from an unrelated casualty,
// so it guessed, and the user got their old page back.
//
// Withholding the facts a decision needs is the same disease as making the
// decision in code. Every input to a judgement call has to carry its context.
assert('the loss judge is told WHICH image and WHERE it was',
  helpers.includes('imageSections?: Array<{ url: string; sections: string[] }>') &&
  helpers.includes('was in section: ') &&
  follow.includes('sections: sectionsContainingAsset(preservationBaseline, url)'));
// ── Re-hosting an image must not read as deleting it ────────────────────────
// The loss check diffs the page against its previous self BY IMAGE URL, and
// the re-host step rewrites image URLs on one side of that diff. An untouched
// image therefore looked deleted: confirmed live on a headline-only edit as 6
// phantom losses, one ~90s repair call each (514s total), and a duplicate copy
// of every "restored" image on the page. findUnrequestedLosses tries to survive
// this by comparing filename tails, but Unbounce-style URLs end in the whole
// percent-encoded original link, so the tail never matches and the guard was
// silently inert for exactly the pages that needed it.
assert('the before-copy is re-addressed the same way the edited page was',
  follow.includes('applyRehostMap(originalHtmlForPreservation, assetScan.rehostedMap)'));
assert('every asset lookup after the re-host uses that baseline, not the raw original',
  !/beforeHtml: originalHtmlForPreservation/.test(follow) &&
  !/sectionsContainingAsset\(originalHtmlForPreservation/.test(follow) &&
  !/splitLossesByRegion\([a-zA-Z]+, originalHtmlForPreservation/.test(follow));
// Re-hosting is correctness (a skipped copy = a permanent dependency on someone
// else's server); the own-storage probe is only a health check. So the cap
// belongs on the probe, never on the copy — it used to be `.slice(0, 12)` on
// the work list, which left images 13+ foreign forever.
assert('re-hosting is never truncated, only the health probe is',
  assets.includes('const targets = Array.from(srcs);') &&
  assets.includes('Array.from(ownSrcs).slice(0, Math.max(0, maxProbes))'));
assert('assets are fetched in bounded batches rather than all at once',
  assets.includes('const REHOST_CONCURRENCY = 5;') &&
  assets.includes('async function inBatches'));
// Every route that hands a page to the editor re-hosts first, so by edit time
// there is nothing left to move and the diff above can never be tripped.
// ── One call owns BOTH ways a page can depend on someone else ───────────────
// base64 inlined in the markup, and <img> pointing at another host. Every
// intake closed the first; exactly one closed the second, so a variant pasted
// in through tests.ts kept its Unbounce URLs. Unifying them means a seventh
// intake cannot be added that remembers half.
assert('every HTML intake takes ownership of both, via one call',
  [fromHtml, uploadRoute, pagesService, testsService].every((f) =>
    f.includes('takeOwnershipOfHtmlAssets(')));
assert('no intake still calls the base64 half on its own',
  [fromHtml, uploadRoute, pagesService, testsService].every((f) =>
    !f.includes('inlineDataUrisToStorage(')));
assert('the helper does both halves',
  assets.includes('const inlined = await inlineDataUrisToStorage(html, pageId);') &&
  assets.includes('await verifyAndRehostHtmlImages({ pageSlug: pageId, html: inlined })'));
// An embedded player is a live service, not an asset to copy — rewriting its
// src would break playback. Only <img> is ever touched.
assert('embedded players and other tags are never rewritten',
  (assets.match(/html\.matchAll\(\/</g) || []).length === 1 &&
  /html\.matchAll\(\/<img\\b/.test(assets));
// Wherever a schema travels with the html, it carries image URLs of its own and
// has to move with the same map, or page and editor point at different copies.
assert('a schema written alongside the html is re-addressed too',
  pagesService.includes('applyRehostMap(JSON.stringify(data.schema_json), owned.rehostedMap)') &&
  pagesService.includes('applyRehostMap(JSON.stringify(page.draft_schema_json), ownedDraft.rehostedMap)'));
// Copying images is network work proportional to image count; on the platform
// default (~10-15s) an image-heavy page is killed mid-copy and left half-owned.
assert('every route that now downloads images has a real time ceiling',
  [fromHtml, uploadRoute, ensureEditable].every((f) => /export const maxDuration = \d+;/.test(f)));
assert('every path into the editor re-hosts before the first edit',
  fromHtml.includes('await takeOwnershipOfHtmlAssets(') &&
  schemaFromHtml.includes('await verifyAndRehostHtmlImages(') &&
  rebuildFlow.includes('await verifyAndRehostHtmlImages(') &&
  ensureEditable.includes('await verifyAndRehostHtmlImages('));
// schema-from-html runs only when a page has NO schema; ensure-editable only
// when it HAS one. They are exact complements, so covering both is what makes
// the copy unconditional — a page edited long ago under the old code never
// sees prep again, and would otherwise stay foreign forever.
assert('the two prep routes are complements, so no page is skipped',
  schemaFromHtml.includes('await verifyAndRehostHtmlImages(') &&
  ensureEditable.includes("if (!schema) {") &&
  client.includes('if (initialPage.draft_schema_json ?? initialPage.schema_json) return;') &&
  client.includes('if (!(initialPage.draft_schema_json ?? initialPage.schema_json)) return;'));
// Stamping used to be this route's only job, so it returned early when there
// was nothing to stamp. That early return would now discard a completed asset
// copy and leave the page foreign for the next edit to trip over.
assert('a completed re-host is saved even when there is nothing to stamp',
  ensureEditable.includes('const schemaChanged = rehostedCount > 0;') &&
  ensureEditable.includes('if (!htmlChanged && !schemaChanged) {'));
// The schema stores image URLs for the editor's thumbnails; leaving those on
// the old host points page and editor at two different copies.
assert('the schema is re-addressed alongside the html',
  schemaFromHtml.includes('applyRehostMap(JSON.stringify(schemaJson)') &&
  rebuildFlow.includes('applyRehostMap(JSON.stringify(finalSchema)'));
assert('the loss judge is told which sections the edit was about',
  helpers.includes('requestedSections?: string[]') &&
  helpers.includes('THE EDIT WAS ABOUT THESE SECTIONS:') &&
  follow.includes('requestedSections,'));
assert('a loss inside the edited section is flagged as such, and read as a replacement',
  helpers.includes('[INSIDE the section this edit was about]') &&
  helpers.includes('one already was replaces it, and that is the edit working, not failing') &&
  helpers.includes('is a REWRITE, not a deletion'));
assert('both judge calls get the same facts — not just the first',
  (follow.match(/imageSections:/g) || []).length >= 2 &&
  (follow.match(/requestedSections,/g) || []).length >= 2);

// ── Every model that must resolve "it" gets the conversation ────────────────
// The route has held the full history since day one and handed it to exactly
// ONE call: the full-page rebuild — the path that now almost never runs. The
// classifier, the region resolver and the rewrite itself, which handle nearly
// every edit, were each given a bare sentence and asked what it referred to.
// "logo looks too small", "make it bigger", "do the same for the footer" are
// unanswerable that way, so they returned "I cannot tell" or guessed — and both
// look like a stupid model rather than a starved one.
assert('there is one shared way to build conversation context',
  intentSrc.includes('export function buildConversationContext'));
// Stronger than "context only", because that was not strong enough. An older
// "generate a logo and replace it everywhere" stayed live in the model's head:
// the next message, "use the image already in the hero", was read as the next
// step of the logo job, and the nav logo became a portrait. Old turns are
// finished work, and an old "everywhere" belongs to the turn that said it.
assert('history is framed as finished work, not a live to-do list',
  intentSrc.includes('ALREADY DONE, NOT A TO-DO LIST') &&
  intentSrc.includes('applied to THAT turn only') &&
  intentSrc.includes('The new message is the only job.'));
assert('and it warns against the opposite mistake — dragging an old topic forward',
  intentSrc.includes('an older turn about a LOGO does not make a'));
// Our own past turns used to be replayed as 400 chars of truncated schema JSON.
assert('our own turns are replayed as what they changed, not as raw JSON',
  intentSrc.includes('You: edited the ${changed.join') &&
  intentSrc.includes("return 'You: edited the page.'") &&
  follow.includes('sections: rewrittenRegion ?? intent.targetSections,'));
assert('the edit classifier gets the conversation',
  intentSrc.includes('conversation?: string;') &&
  follow.includes('conversation: conversationContext,'));
assert('the region resolver gets the conversation',
  /conversation: opts\.conversation,/.test(follow) &&
  intentSrc.includes("opts.conversation ?? ''"));
assert('the rewrite itself gets the conversation',
  /text: `\$\{opts\.conversation \? `\$\{opts\.conversation\}/.test(follow));
assert('the create path classifier gets it too, not just its schema call',
  gen.includes('conversation: buildConversationContext(history)'));
assert('every rewrite call site passes it, not just the primary one',
  (follow.match(/conversation: conversationContext,/g) || []).length >= 4);

// ── Silence keeps. Only an explicit name deletes. ───────────────────────────
// Reported live: "no, use the image that's already in the hero section". The
// run was the whole page, the model sensibly returned only the sections it
// changed, and the splice — which replaced the entire run with whatever came
// back — destroyed the stats and gallery sections. The instruction telling it
// to "return only the sections you actually changed" made that certain.
//
// A section must now leave the page only when the model NAMES it in "deleted".
// Forgetting to mention something cannot delete it, and deletion is still
// fully expressible, so nothing is taken away from the model.
assert('the rewrite contract says omission keeps',
  follow.includes('## Silence means KEEP') &&
  follow.includes('is kept exactly as it is') &&
  follow.includes('Never rely on omitting it'));
assert('the destructive "only return what you changed" instruction is gone',
  !follow.includes('return only the sections you actually changed'));
assert('deletion is a named list, parsed separately from the rewrites',
  follow.includes('deleted: string[];') &&
  /const removed = new Set\(deleted\);/.test(follow));
// Each section is spliced into its OWN byte range. The version before this one
// replaced everything between the first and last marked section — safe only if
// the page is nothing but marked sections, which a real page was not. On a page
// with 3 of 10 sections marked, a nav+footer edit wiped the whole about section,
// 4 images, 20 headings and 60 click-to-edit fields that sat unmarked in between.
assert('each section is spliced into its own bounds, never a span',
  follow.includes('const at = findSlBlockBounds(spliced, sec.name);') &&
  follow.includes('edits.sort((a, b) => b.from - a.from);'));
assert('content between sections is never inside an edit range',
  follow.includes('Anything between sections — marked or not — is never'));
assert('markers are written by code, so a rewrite cannot drop them',
  follow.includes('const block = (name: string, htmlBody: string) =>') &&
  follow.includes('text: block(sec.name, sec.html)'));
assert('a delete-only turn is still a real edit',
  follow.includes("if (deleted.length > 0) return { kind: 'sections', sections: [], deleted, message };"));
// Reordering has to MOVE bytes, which no in-place replacement can express — so
// it is only attempted when nothing unmarked sits between the sections.
assert('reordering is attempted only when it cannot drag unmarked content along',
  follow.includes('const looksLikeReorder =') &&
  follow.includes('reorder skipped — unmarked content sits between sections'));
assert('what was kept vs deleted is visible in the logs',
  follow.includes('keptUntouched:'));

// ── Reusing a picture needs to know the picture exists ──────────────────────
// Same turn, the step before: "put the image of the hero section here as well"
// with the run scoped to the about section. The hero's HTML was never in the
// payload, so the hero's image URL did not exist for that call — the only URL
// it could see was the user's attached screenshot, and it embedded that. The
// page's own photo became a screenshot of the page.
assert('the rewrite is told what images already exist elsewhere on the page',
  follow.includes('outsideAssets?: string;') &&
  follow.includes('Images already on the page, by section'));
assert('and told to prefer those exact URLs over an attachment',
  follow.includes('never substitute an attached screenshot for one'));

// ── The retry must not turn a structural step into an edit ──────────────────
assert('only patch steps are retried through the patch path',
  /if \(s\.op !== 'patch'\) return false;/.test(follow));

// ── "Partly done" means an ASK is missing, and nothing else ─────────────────
// Client feedback: "Change these headigns to something better" reworded two
// headings, the loss judge ruled it intended (so the edit was kept), and the
// turn still reported "Partly done (not fully finished). Heads up: 2 headings
// disappeared without being asked for." Three of six writers to partialMessage
// were firing on work that had fully landed.
const sseSrc = readFileSync(join(__dirname, '../src/lib/sse.ts'), 'utf8');

assert('there is a channel for "done, with a caveat"',
  /notes\?: string;/.test(sseSrc));
// Joined one-per-line, not space-separated: two or three separate calls render
// as a list in the callout instead of running together into a paragraph.
assert('the follow-up route emits notes on the done event',
  follow.includes("...(pageNotes.length > 0 ? { notes: pageNotes.join('") &&
  /pageNotes\.join\('.n'\)/.test(follow));
assert('the orphaned `warning` field is gone',
  !/\{ warning: assetWarning \}/.test(follow) && !/let assetWarning/.test(follow));
// The headline itself is now the model's own sentence when it wrote one — the
// fixed copy is the fallback, not the default (see SSEEvent.message). What this
// still guards is the shape: the note travels on its OWN message field, so it
// renders as its own callout instead of trailing the status sentence where it
// went unread — and it is never routed through the partial_message branch that
// raises a retry toast.
assert('a note keeps the Done headline and raises no retry toast',
  /const didIt = done\.message\?\.trim\(\) \|\| 'Done! The page has been updated\.';/.test(client) &&
  client.includes('content: didIt,') && client.includes('note: done.notes,'));
// Every success sentence the user read used to be written by us — one fixed
// line, printed whether the turn nudged a logo or rebuilt a hero. The model knew
// what it had changed and had nowhere to say it, because the rewrite contract
// asked only for HTML. These four keep that channel open end to end.
assert('the rewrite is required to write one sentence for the user',
  follow.includes('## "message" — always required') &&
  follow.includes('{"message":"...one sentence to the user...","sections"'));
assert('that sentence survives parsing and reaches the caller',
  follow.includes('return raw.length >= 3 ? raw.slice(0, 1200) : null;') &&
  follow.includes('const message = normalizeEditorMessage(parsed.message);') &&
  follow.includes('message: result.message,'));
// One message can carry several asks ("make the logo bigger, remove the FAQ,
// and make the button red"), so the reply is one line per thing changed. The
// first version of this collapsed ALL whitespace, which ran three reported
// edits into one paragraph — and a squeezed report is how an ask that never
// happened goes unnoticed. Line breaks are load-bearing on both sides: kept by
// the parser, and rendered by the bubble.
assert('a multi-ask edit can report each change on its own line',
  (follow.match(/ONE LINE PER THING THE USER ASKED FOR/g) || []).length >= 2 &&
  follow.includes('.split(/\\r?\\n/)') &&
  follow.includes(".replace(/[ \\t]+/g, ' ')") &&
  client.includes('break-words whitespace-pre-wrap">{msg.content}</p>'));
// ── The full-page rewrite speaks too ────────────────────────────────────────
// Only the region rewrite could write its own message, so a whole-page redesign
// — the biggest thing this product does — reported the fixed "Done! The page
// has been updated." Both paths now share one normalizer, so there is exactly
// one implementation of how the model's words reach the chat.
assert('the full-page rewrite is asked for a message too',
  follow.includes('"message":"...what you changed, for the user...","type":"structural"') &&
  follow.includes('"message":"...what you changed, for the user...","type":"patch"') &&
  follow.includes('"message":"...what you changed, for the user...","type":"style"'));
assert('the full-page message is parsed and does not clobber the region one',
  follow.includes('editorMessage = editorMessage ?? normalizeEditorMessage(parsed.message);'));
// A rebuild touches everything, so "one line per section changed" would print a
// wall. The count is over ASKS, which keeps "redesign the page" at one line and
// still gives "redesign the page and enlarge the logo" two.
assert('the reply counts asks, not edits',
  (follow.match(/Count ASKS, not edits/g) || []).length >= 2);
assert('thinking and message are kept distinct on the full-page path',
  follow.includes('"thinking" and "message" are NOT the same field'));
assert('an ask that could not be carried out has to be named, not dropped',
  follow.includes('Say what did NOT happen, in its own line'));
assert('the done event carries it, and omits it when no model wrote one',
  /\.\.\.\(editorMessage \? \{ message: editorMessage \} : \{\}\)/.test(follow) &&
  /message\?: string;/.test(sseSrc));
assert('a silent no-change still prefers the model words over our fixed line',
  follow.includes('reason: message ?? "I looked at that and didn\'t find anything to change on the page."'));

assert('a note is not lost when something else really is partial',
  client.includes('content: `Partly done (not fully finished). ${done.partial_message}`,') &&
  client.includes('note: done.notes,'));
// The callout is the whole reason the note left `content`. If it stops being
// rendered, the note is silently gone from the UI while every assertion above
// still passes.
// An edit turn used to persist JSON.stringify(done). The restore path detects a
// `{`-prefixed row as a legacy payload and swaps it for canned text, so the note
// the user was shown during the session was gone the moment they reopened the
// page. Storing the sentence keeps it, and keeps model history readable too.
assert('an edit turn persists the sentence and its note, not a JSON blob',
  !client.includes("content: JSON.stringify(done)") &&
  client.includes("content: done.message?.trim() || 'Done! The page has been updated.',") &&
  client.includes("...(done.notes ? { note: done.notes } : {}),"));
// Notes appended to the status sentence by older builds are split back out on a
// literal match against the sentences we authored — never a guess at where one
// sentence ends.
assert('notes stored inside older content are recovered, not stranded',
  client.includes('const splitStoredNote =') &&
  client.includes("'Your page is ready! Click any text in the preview to edit it, or ask me to make changes.',"));
assert('the note is rendered as its own callout the user can act on',
  /\{msg\.note && \(/.test(client) &&
  /A call I made/.test(client) &&
  /note\?: string;/.test(client));

// A cleared loss has nothing honest to say: every destructive outcome returns
// before this point, so the only thing left to report would contradict the
// judge that just approved the edit.
assert('a loss the judge cleared is logged, not announced as partly done',
  /losses cleared as intended — not reported/.test(follow) &&
  !/Heads up: \$\{lossNote\}/.test(follow));
assert('a fully-applied plan does not report a screenshot mismatch as unfinished',
  /addNote\(`The \$\{parts\} may not match the screenshot exactly/.test(follow));
assert('a section that was rewritten does not report itself as unfinished',
  /addNote\(`The \$\{name\} was rewritten but may not match/.test(follow));
assert('a broken image URL is a note about the page, not a failed ask',
  /addNote\(\s*`\$\{assetScan\.broken\.length\} image URL\(s\)/.test(follow));
assert('the create path does not list a broken image under "not everything landed"',
  /const tail =\s*\(done\.broken_assets/.test(pageBuilds) &&
  !/caveats\.push\(`\$\{brokenAssets\}/.test(pageBuilds) &&
  !/caveats\.push\(`\$\{brokenAssets\}/.test(client));

// The three legitimate writers must survive — a genuinely missing ask still has
// to say so, or this fix trades a false alarm for a silent failure.
assert('a genuinely unmet requirement still reports partly done',
  follow.includes('Still not applied: ${userFacingUnmet}.`'));
assert('a step still failing after its retry still reports partly done',
  /Applied part of that request\. Some parts still need a follow-up/.test(follow));
assert('a logo landing while other asks failed still reports partly done',
  /Logo is in\. Some other parts of that request still need a follow-up\./.test(follow));

// ── Detecting incomplete work means fixing it, not narrating it ─────────────
// The last and most reliable check in the turn (the model's own checklist) was
// the only one with no retry. retryInstructionFor() was written, unit-tested,
// and called by nothing.
assert('the requirement retry instruction is actually wired into the route',
  /retryInstructionFor,/.test(follow) &&
  /const fixInstruction = retryInstructionFor\(retryable\)/.test(follow));
assert('the retry runs before the loss guard, so damage it causes is still caught',
  follow.indexOf('const fixInstruction = retryInstructionFor(retryable)') <
    follow.indexOf('const losses = findUnrequestedLosses'));
assert('the retry is capped at one pass',
  (follow.match(/const fixInstruction = retryInstructionFor/g) ?? []).length === 1);
assert('the retry only targets sections that exist on the page',
  /\.filter\(\(name\) => availableSections\.some\(\(s\) => s\.name === name\)\)/.test(follow));
assert('a requirement naming no section falls back to the turn, never the whole page',
  /failedSections\.length > 0 \? failedSections : intent\.targetSections/.test(follow));
assert('the retry result is kept only if it fixes something and breaks nothing',
  /const regressed = failedAfter\.some\(\(bad, i\) => bad && !failedBefore\[i\]\)/.test(follow) &&
  /if \(!regressed && fixed > 0 && inventedAssets\.length === 0\)/.test(follow));
assert('a discarded retry leaves the pre-retry page in place',
  /requirement retry discarded — kept pre-retry page/.test(follow));
assert('the retry re-checks against the same requirements array, so labels cannot collide',
  /const candidateResults = checkRequirements\(candidate, requirements/.test(follow));
assert('image bytes are stripped before the retry call and restored after',
  /const \{ html: sectionForModel, map: sectionUris \} = extractDataUris\(section\.html\)/.test(follow) &&
  /restoreDataUris\(attempt\.html, sectionUris\)/.test(follow));
assert('an aborted request does not start a retry',
  /results\.some\(\(r\) => !r\.passed\) && !request\.signal\.aborted/.test(follow));
assert('a retry with nowhere to go is logged rather than silently skipped',
  /unmet requirements with nowhere to retry/.test(follow));
// Each target is a sequential model call inside an open SSE stream. 16
// requirements uncapped is minutes of hang, then a proxy idle-timeout kills the
// turn and the user loses an edit that had already been applied.
assert('the retry cannot hang the stream with an unbounded number of calls',
  /const REQUIREMENT_RETRY_SECTION_CAP = 3;/.test(follow) &&
  /\.slice\(0, REQUIREMENT_RETRY_SECTION_CAP\)/.test(follow));
assert('an abort mid-retry stops the remaining calls',
  /for \(const name of retryTargets\) \{\s*\n\s*if \(request\.signal\.aborted\) break;/.test(follow));
// Image verification already ran by this point, so a URL the retry invents would
// ship unchecked and 404 on the live page.
assert('a retry that invents an unverified image URL is discarded',
  /const inventedAssets = externalImgSrcs\(candidate\)\.filter\(/.test(follow) &&
  /inventedAssets\.length === 0/.test(follow));
// A scoped patch must return the same outer tag, so it can never delete a
// section — retrying one would burn a call every turn and always be discarded.
assert('a delete-the-section requirement is not retried through the patch path',
  /r\.requirement\.kind !== 'section_absent'/.test(follow) &&
  /const fixInstruction = retryInstructionFor\(retryable\)/.test(follow));
assert('but the asset a requirement demands is allowed to appear',
  /const allowedNewAssets = new Set\(/.test(follow) &&
  /!allowedNewAssets\.has\(url\)/.test(follow));

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll helper + contract checks passed.');

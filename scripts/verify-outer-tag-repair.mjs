/** Standalone verification of repairScopedSectionOuterTag logic (mirrors follow-up/route.ts). */

function outerTag(html) {
  const m = /^\s*<([a-zA-Z][a-zA-Z0-9]*)/.exec(html);
  return m ? m[1].toLowerCase() : null;
}

function sanityCheckScopedSection(original, updated) {
  if (!updated.trim()) return false;
  const origTag = outerTag(original);
  const newTag = outerTag(updated);
  return !!origTag && origTag === newTag;
}

function repairScopedSectionOuterTag(original, updated) {
  const origTag = outerTag(original);
  const newTag = outerTag(updated);
  if (!origTag || !newTag) return null;
  if (origTag === newTag) return updated;

  if (
    newTag === 'html' ||
    newTag === 'head' ||
    newTag === 'body' ||
    /^\s*<!DOCTYPE/i.test(updated)
  ) {
    return null;
  }

  const openMatch = new RegExp(`^\\s*(<${origTag}\\b[^>]*>)`, 'i').exec(original);
  if (!openMatch) return null;
  const openTag = openMatch[1];

  const inner = updated.trim();
  const origLen = original.trim().length;
  const minLen = Math.max(150, Math.floor(origLen * 0.25));
  if (inner.length < minLen) return null;

  const repaired = `${openTag}\n${inner}\n</${origTag}>`;
  if (!sanityCheckScopedSection(original, repaired)) return null;
  return repaired;
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS:', msg);
}

// Case 1: cta-form style — section vs div (production failure)
const original = `<section class="cta-form" id="deck">
  <div class="form-wrap">
    <label>Investment range</label>
    <select><option>1</option></select>
  </div>
</section>`;
const aiDiv = `<div class="form-wrap">
    <label>What is your investment range?</label>
    <select><option>1</option></select>
    <label>What is your investment timeline?</label>
    <select><option>2</option></select>
  </div>`;
assert(!sanityCheckScopedSection(original, aiDiv), 'raw div fails sanity');
const repaired = repairScopedSectionOuterTag(original, aiDiv);
assert(!!repaired, 'repair returns html');
assert(repaired.startsWith('<section class="cta-form" id="deck">'), 'keeps original opening tag+attrs');
assert(repaired.includes('What is your investment range?'), 'keeps AI content');
assert(sanityCheckScopedSection(original, repaired), 'repaired passes sanity');

// Case 2: already correct — return as-is
const good = `<section class="cta-form" id="deck"><p>ok</p></section>`;
assert(repairScopedSectionOuterTag(original, good) === good, 'same tag returns updated unchanged');

// Case 3: reject full document
assert(
  repairScopedSectionOuterTag(original, '<!DOCTYPE html><html><body>x</body></html>') === null,
  'rejects doctype/html',
);

// Case 4: reject tiny herotop strip
const tiny = '<div class="herotop"><a>logo</a></div>';
assert(repairScopedSectionOuterTag(original, tiny) === null, 'rejects tiny fragment');

// Case 5: hero — large enough div still repairs (attrs preserved)
const heroOrig = `<section class="hero bg-dark">${'x'.repeat(800)}</section>`;
const heroBad = `<div class="herotop">${'y'.repeat(400)}</div>`;
const heroRep = repairScopedSectionOuterTag(heroOrig, heroBad);
assert(!!heroRep && heroRep.startsWith('<section class="hero bg-dark">'), 'hero attrs preserved');

// Case 6: accept path simulation — first attempt wrong tag → repair skips retry need
function accept(sectionHtml, candidate) {
  if (!candidate) return null;
  if (sanityCheckScopedSection(sectionHtml, candidate)) return candidate;
  return repairScopedSectionOuterTag(sectionHtml, candidate);
}
const accepted = accept(original, aiDiv);
assert(!!accepted && sanityCheckScopedSection(original, accepted), 'accept() heals without model retry');

console.log('\nAll outer-tag repair checks passed.');

/**
 * Real behavior tests for src/lib/ai-page-preservation.ts.
 *
 * The bug this guards: an edit about nav colors deleted a logo nobody asked it
 * to touch, and every existing check passed because they only ever verified
 * that requested changes landed.
 *
 * Run: node scripts/verify-page-preservation.mjs
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outDir = join(repoRoot, '.verify-tmp-preservation');
const srcFile = join(repoRoot, 'src', 'lib', 'ai-page-preservation.ts');

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'tsc',
    srcFile,
    '--outDir', outDir,
    '--target', 'es2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--downlevelIteration',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const P = require(join(outDir, 'ai-page-preservation.js'));

let failed = 0;
function assert(name, cond) {
  if (cond) console.log(`OK: ${name}`);
  else { console.error(`FAIL: ${name}`); failed++; }
}

const pageWithLogo = `
<!-- SL:nav --><nav><a href="/"><img src="https://cdn.site.com/logo.svg" alt="logo"/></a></nav><!-- /SL:nav -->
<!-- SL:hero --><section><h1>Your Call Is Confirmed.</h1></section><!-- /SL:hero -->
<!-- SL:footer --><footer><img src="https://cdn.site.com/logo.svg"/><p>Focused Capital</p></footer><!-- /SL:footer -->`;

// The exact reported failure: asked for colors, got a deleted logo.
const logoDeleted = `
<!-- SL:nav --><nav style="background:#1e3a5f"><span>Focused Capital</span></nav><!-- /SL:nav -->
<!-- SL:hero --><section><h1>Your Call Is Confirmed.</h1></section><!-- /SL:hero -->
<!-- SL:footer --><footer style="background:#1e3a5f"><p>Focused Capital</p></footer><!-- /SL:footer -->`;

const losses = P.findUnrequestedLosses({
  beforeHtml: pageWithLogo,
  afterHtml: logoDeleted,
  prompt: 'why is navigation bar and footer white keep them blue of the theme',
});
assert('detects a logo deleted without being asked', losses.images.length === 1);
assert('names the deleted logo URL', losses.images[0] === 'https://cdn.site.com/logo.svg');
assert('describeLosses is human readable',
  (P.describeLosses(losses) ?? '').includes('image') &&
  (P.describeLosses(losses) ?? '').includes('without being asked'));

// A requested delete must NOT be reported as a regression.
const requested = P.findUnrequestedLosses({
  beforeHtml: pageWithLogo,
  afterHtml: logoDeleted,
  prompt: 'remove the logo from the nav and footer',
});
assert('requested removal is not a loss', P.hasLosses(requested) === false);

assert('removal intent detected: remove', P.promptHasRemovalIntent('remove that section') === true);
assert('removal intent detected: get rid of', P.promptHasRemovalIntent('get rid of the FAQ') === true);
assert('removal intent detected: take that out', P.promptHasRemovalIntent('see screenshot... take that out') === true);
assert(
  'intentional logo replace detected',
  P.promptHasIntentionalLogoReplace('make navbar logo same as footer') === true,
);
assert(
  'color ask is not intentional logo replace',
  P.promptHasIntentionalLogoReplace('why is navigation bar and footer white keep them blue') === false,
);
assert('no removal intent in a color ask',
  P.promptHasRemovalIntent('keep the nav and footer blue') === false);

// Re-hosting the same asset is not a loss.
const rehosted = pageWithLogo.split('https://cdn.site.com/logo.svg').join(
  'https://xyz.supabase.co/storage/v1/object/public/ai-pages-images/p/images/logo.svg',
);
assert('re-hosted copy of the same file is not a loss',
  P.findUnrequestedLosses({ beforeHtml: pageWithLogo, afterHtml: rehosted, prompt: 'make it blue' })
    .images.length === 0);

// Confirmed live: a "make it responsive" rewrite regenerated a testimonial
// section and picked a fresh headshot upload for an avatar's data-field slot
// (different file entirely, not a re-host of the same one) while restructuring
// everything around it. The old URL is gone, but the slot is still filled —
// this must not read as a loss, or the guard puts the stale avatar back in
// too and the page shows the same person twice.
const avatarSlot = `
<!-- SL:testimonials --><section><img src="https://i.imgur.com/old-avatar.png" data-field="sections.2.image" alt="Michael Rodriguez"/></section><!-- /SL:testimonials -->`;
const avatarResourced = `
<!-- SL:testimonials --><section><img src="https://supabase.co/storage/new-avatar.jpeg" data-field="sections.2.image" alt="Michael Rodriguez"/></section><!-- /SL:testimonials -->`;
assert('re-sourcing a data-field image slot with a different file is not a loss',
  P.findUnrequestedLosses({ beforeHtml: avatarSlot, afterHtml: avatarResourced, prompt: 'make it responsive' })
    .images.length === 0);

// The other half: if the data-field slot is genuinely empty afterward (no <img>
// with that field at all), the old URL disappearing IS still a real loss.
const avatarDropped = `
<!-- SL:testimonials --><section><p>Michael Rodriguez</p></section><!-- /SL:testimonials -->`;
assert('a data-field slot that truly has no image left is still reported as a loss',
  P.findUnrequestedLosses({ beforeHtml: avatarSlot, afterHtml: avatarDropped, prompt: 'make it responsive' })
    .images.length === 1);

// Section and heading loss.
const sectionGone = pageWithLogo.replace(
  /<!-- SL:footer -->[\s\S]*?<!-- \/SL:footer -->/,
  '',
);
const sectionLosses = P.findUnrequestedLosses({
  beforeHtml: pageWithLogo,
  afterHtml: sectionGone,
  prompt: 'make the hero bigger',
});
assert('detects a section that vanished', sectionLosses.sections.includes('footer'));

const headingGone = pageWithLogo.replace('Your Call Is Confirmed.', 'Welcome');
assert('detects a heading that vanished',
  P.findUnrequestedLosses({ beforeHtml: pageWithLogo, afterHtml: headingGone, prompt: 'make it blue' })
    .headings.length === 1);

// No change → no false alarms.
assert('identical page reports no losses',
  P.hasLosses(P.findUnrequestedLosses({
    beforeHtml: pageWithLogo,
    afterHtml: pageWithLogo,
    prompt: 'make the nav blue',
  })) === false);

// Adding content is never a loss.
const added = pageWithLogo.replace('</footer>', '<p>New line</p></footer>');
assert('adding content reports no losses',
  P.hasLosses(P.findUnrequestedLosses({
    beforeHtml: pageWithLogo,
    afterHtml: added,
    prompt: 'add a line to the footer',
  })) === false);

// Snapshot sanity
const facts = P.snapshotPageFacts(pageWithLogo);
assert('snapshot collects sections', facts.sectionNames.join(',') === 'nav,hero,footer');
assert('snapshot dedupes image URLs', facts.imageUrls.length === 1);
assert('snapshot collects headings', facts.headings[0] === 'your call is confirmed.');

// ── Click-to-edit handles ────────────────────────────────────────────────
// A rewrite that keeps the text but drops data-field takes away the user's
// ability to click that text and edit it — invisible in a screenshot, and now
// that soft verification misses are kept instead of discarded, nothing else
// would catch this.
const editablePage = `<!-- SL:hero --><h1 data-field="headline">Your call is confirmed.</h1><p data-field="subhead">See you soon.</p><!-- /SL:hero -->`;
const strippedFields = `<!-- SL:hero --><h1>Your call is confirmed.</h1><p>See you soon.</p><!-- /SL:hero -->`;
assert('snapshot collects data-field names',
  P.snapshotPageFacts(editablePage).editableFields.join(',') === 'headline,subhead');
assert('losing data-field is reported as a loss',
  P.hasLosses(P.findUnrequestedLosses({
    beforeHtml: editablePage,
    afterHtml: strippedFields,
    prompt: 'make the headline bigger',
  })) === true);
assert('describeLosses names the editable-field loss',
  /click-to-edit/.test(
    P.describeLosses(P.findUnrequestedLosses({
      beforeHtml: editablePage,
      afterHtml: strippedFields,
      prompt: 'make the headline bigger',
    })) ?? '',
  ));
assert('keeping data-field reports no loss',
  P.hasLosses(P.findUnrequestedLosses({
    beforeHtml: editablePage,
    afterHtml: editablePage.replace('bigger', 'bigger').replace('font-size', 'font-size'),
    prompt: 'make the headline bigger',
  })) === false);

// ── Repair instead of revert ─────────────────────────────────────────────
// Reported from local testing: user attached a photo and asked to put it in the
// hero. It landed, but the team member's photo vanished on the way past, so the
// whole edit was thrown away and they got their old page back. The hero was the
// only section they asked about — the team section had a good copy one edit ago.
const teamPage = `
<!-- SL:hero --><section><h1>I've been crafting since 2021</h1></section><!-- /SL:hero -->
<!-- SL:team --><section><img src="https://cdn.site.com/taimoor.png" data-field="team.members.0.generated_image_url"/><h2>Muhammad Taimoor</h2></section><!-- /SL:team -->
<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;

const heroDoneTeamBroken = `
<!-- SL:hero --><section><img src="https://cdn.site.com/attached.png"/><h1>I've been crafting since 2021</h1></section><!-- /SL:hero -->
<!-- SL:team --><section><h2>Muhammad Taimoor</h2></section><!-- /SL:team -->
<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;

const collateral = P.findUnrequestedLosses({
  beforeHtml: teamPage,
  afterHtml: heroDoneTeamBroken,
  prompt: 'pls put the image of the hero section here as well',
});
assert('the team photo reads as an unrequested loss', P.hasLosses(collateral));

const repaired = P.restoreDamagedSections({
  beforeHtml: teamPage,
  afterHtml: heroDoneTeamBroken,
  losses: collateral,
  protectedSections: ['hero'],
});
assert('the damaged section is the one put back', repaired.restored.join(',') === 'team');
assert('the requested hero image survives the repair',
  repaired.html.includes('https://cdn.site.com/attached.png'));
assert('the collateral loss is gone after repair',
  P.hasLosses(P.findUnrequestedLosses({
    beforeHtml: teamPage,
    afterHtml: repaired.html,
    prompt: 'pls put the image of the hero section here as well',
  })) === false);

// The other half: never "repair" the section the user asked about — that undoes
// the request and then reports Done, which is worse than refusing.
const heroRewritten = `
<!-- SL:hero --><section><h1>Crafting software since 2021</h1></section><!-- /SL:hero -->
<!-- SL:team --><section><img src="https://cdn.site.com/taimoor.png" data-field="team.members.0.generated_image_url"/><h2>Muhammad Taimoor</h2></section><!-- /SL:team -->
<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;
const heroRepair = P.restoreDamagedSections({
  beforeHtml: teamPage,
  afterHtml: heroRewritten,
  losses: P.findUnrequestedLosses({
    beforeHtml: teamPage,
    afterHtml: heroRewritten,
    prompt: 'reword the hero headline',
  }),
  protectedSections: ['hero'],
});
assert('the section the user asked about is never restored',
  heroRepair.restored.length === 0 && heroRepair.html === heroRewritten);

// A section deleted outright comes back at its original seam.
const teamDeleted = `
<!-- SL:hero --><section><h1>I've been crafting since 2021</h1></section><!-- /SL:hero -->
<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;
const sectionRepair = P.restoreDamagedSections({
  beforeHtml: teamPage,
  afterHtml: teamDeleted,
  losses: P.findUnrequestedLosses({
    beforeHtml: teamPage,
    afterHtml: teamDeleted,
    prompt: 'make the footer text bigger',
  }),
  protectedSections: ['footer'],
});
assert('a deleted section is re-inserted', sectionRepair.restored.includes('team'));
assert('it goes back where it was, not at the end',
  sectionRepair.html.indexOf('SL:team') > sectionRepair.html.indexOf('SL:hero') &&
  sectionRepair.html.indexOf('SL:team') < sectionRepair.html.indexOf('SL:footer'));

// Content that MOVED is not content that was lost — putting the old copy back
// would show the user the same block twice.
const teamMerged = `
<!-- SL:hero --><section><h1>I've been crafting since 2021</h1><img src="https://cdn.site.com/taimoor.png" data-field="team.members.0.generated_image_url"/><h2>Muhammad Taimoor</h2></section><!-- /SL:hero -->
<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;
const mergeRepair = P.restoreDamagedSections({
  beforeHtml: teamPage,
  afterHtml: teamMerged,
  losses: { images: [], sections: ['team'], headings: [], editableFields: [] },
  protectedSections: [],
});
assert('a merged-away section is not duplicated back onto the page',
  mergeRepair.restored.length === 0);

// ── The guard must stop at the edge of the model's own work ─────────────────
// Reported from client testing, live, mid-demo: "pls put the image of the hero
// section here as well" with a crop of the About section. The rewrite did it —
// the About photo was replaced by the hero photo, which IS the ask — and the
// guard called the replaced photo damage and reverted the whole edit.
//
// A rewrite is handed a run of sections and told to change them. Losing an
// image in there is the edit working. Losing one outside is real damage,
// because the splice copies those bytes across untouched.
const beforeEdit = `
<!-- SL:nav --><nav><img src="https://cdn.site.com/logo.svg"/></nav><!-- /SL:nav -->
<!-- SL:hero --><section><h1>Experienced Web Developer</h1><img src="https://cdn.site.com/hero-dark.png"/></section><!-- /SL:hero -->
<!-- SL:about --><section><h2>About me</h2><img src="https://cdn.site.com/about-smiling.png" data-field="about.photo"/></section><!-- /SL:about -->
<!-- SL:team --><section><h2>The Team</h2><img src="https://cdn.site.com/team-lead.png"/></section><!-- /SL:team -->`;

// The photo the user asked us to replace, and nothing else.
const replacedInAbout = {
  images: ['https://cdn.site.com/about-smiling.png'],
  sections: [],
  headings: [],
  editableFields: [],
};
const aboutOnly = P.splitLossesByRegion(replacedInAbout, beforeEdit, ['about']);
assert('replacing the photo in the section you were told to change is not damage',
  aboutOnly.outside.images.length === 0 && aboutOnly.inside.images.length === 1);

// The original bug, and it must still be caught: an unrelated section's photo
// disappears while editing About.
const outsideLoss = {
  images: ['https://cdn.site.com/team-lead.png'],
  sections: [],
  headings: [],
  editableFields: [],
};
const outsideHit = P.splitLossesByRegion(outsideLoss, beforeEdit, ['about']);
assert('a photo lost OUTSIDE the rewritten run is still real damage',
  outsideHit.outside.images.length === 1 && outsideHit.inside.images.length === 0);

// Both at once: keep the edit's own replacement, still flag the casualty.
const mixed = P.splitLossesByRegion(
  { ...replacedInAbout, images: [...replacedInAbout.images, ...outsideLoss.images] },
  beforeEdit,
  ['about'],
);
assert('a mixed turn keeps the replacement and still reports the casualty',
  mixed.inside.images.length === 1 &&
  mixed.outside.images.length === 1 &&
  mixed.outside.images[0].includes('team-lead'));

// A wider run covers more, so the same loss changes side. This is the whole
// point: WHERE the model was working decides, not how bad the loss looks.
const widerRun = P.splitLossesByRegion(outsideLoss, beforeEdit, ['about', 'team']);
assert('the same loss is not damage when the run included that section',
  widerRun.outside.images.length === 0);

// data-field paths carry their section in the name.
const fieldLoss = P.splitLossesByRegion(
  { images: [], sections: [], headings: [], editableFields: ['about.photo', 'team.lead'] },
  beforeEdit,
  ['about'],
);
assert('click-to-edit fields are placed by their own dot-path',
  fieldLoss.inside.editableFields.includes('about.photo') &&
  fieldLoss.outside.editableFields.includes('team.lead'));

// Fail toward showing the user a real loss, never toward hiding one.
const unlocatable = P.splitLossesByRegion(
  { images: ['https://cdn.site.com/never-was-here.png'], sections: [], headings: [], editableFields: [] },
  beforeEdit,
  ['about'],
);
assert('a loss we cannot place is treated as outside, not waved through',
  unlocatable.outside.images.length === 1);

// A section the run swallowed (merge) belongs to the run.
const mergedSection = P.splitLossesByRegion(
  { images: [], sections: ['about'], headings: [], editableFields: [] },
  beforeEdit,
  ['about', 'team'],
);
assert('a section merged away inside the run is the edit, not damage',
  mergedSection.inside.sections.includes('about') &&
  mergedSection.outside.sections.length === 0);

// ── restoreLostImagesInPlace: image-granularity repair, not section revert ──
// The generalized fix: a broad "make the whole page responsive" rewrite can
// legitimately repad a section AND silently drop an unrelated image in that
// same output. restoreDamagedSections refuses to touch that section (it was
// part of the request), so this is the only thing that can put the image
// back without undoing the real padding change.
const paddedSectionWithLogo = `
<!-- SL:for-investors --><section style="padding:12px"><h2>For Investors</h2><img src="https://cdn.site.com/logo.png" data-field="for-investors.logo" alt="Titan Funding"/></section><!-- /SL:for-investors -->
<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;

// The model correctly widened the padding for the responsive ask, but the
// logo tag silently vanished from the same section's output.
const paddedSectionLogoDropped = `
<!-- SL:for-investors --><section style="padding:32px"><h2>For Investors</h2></section><!-- /SL:for-investors -->
<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;

const imageRestore = P.restoreLostImagesInPlace({
  beforeHtml: paddedSectionWithLogo,
  afterHtml: paddedSectionLogoDropped,
  images: ['https://cdn.site.com/logo.png'],
});
assert('the missing image is reported as restored', imageRestore.restored.join(',') === 'https://cdn.site.com/logo.png');
assert('the image comes back with its original data-field intact',
  imageRestore.html.includes('data-field="for-investors.logo"'));
assert('the padding change the edit actually made survives the repair',
  imageRestore.html.includes('padding:32px') && !imageRestore.html.includes('padding:12px'));
assert('nothing else in the section is reverted (heading untouched, footer untouched)',
  imageRestore.html.includes('<h2>For Investors</h2>') && imageRestore.html.includes('<p>Contact us</p>'));

// Already present → no-op, not a second copy.
const noOpRestore = P.restoreLostImagesInPlace({
  beforeHtml: paddedSectionWithLogo,
  afterHtml: paddedSectionWithLogo,
  images: ['https://cdn.site.com/logo.png'],
});
assert('an image that is already present is left alone', noOpRestore.restored.length === 0);
assert('no-op does not duplicate the tag',
  (noOpRestore.html.match(/logo\.png/g) ?? []).length === 1);

// The section itself is gone entirely — that is restoreDamagedSections' job,
// not this one. Must not throw, must not invent a section.
const sectionAlsoGone = `<!-- SL:footer --><footer><p>Contact us</p></footer><!-- /SL:footer -->`;
const cannotPlace = P.restoreLostImagesInPlace({
  beforeHtml: paddedSectionWithLogo,
  afterHtml: sectionAlsoGone,
  images: ['https://cdn.site.com/logo.png'],
});
assert('a vanished section is left to restoreDamagedSections, not guessed at',
  cannotPlace.restored.length === 0 && cannotPlace.html === sectionAlsoGone);

// Dollar-figure copy must survive byte-for-byte — String.replace() treats
// "$1", "$&", "$50" etc. in a STRING replacement as capture-group syntax even
// when the search side is a plain string, which would silently mangle a
// dollar amount sitting in the same section as the restored image.
const dollarSection = `
<!-- SL:pricing --><section><h2>Get a check for $50 every month, up to $500M funded</h2><img src="https://cdn.site.com/badge.png" data-field="pricing.badge"/></section><!-- /SL:pricing -->`;
const dollarDropped = `
<!-- SL:pricing --><section><h2>Get a check for $50 every month, up to $500M funded</h2></section><!-- /SL:pricing -->`;
const dollarRestore = P.restoreLostImagesInPlace({
  beforeHtml: dollarSection,
  afterHtml: dollarDropped,
  images: ['https://cdn.site.com/badge.png'],
});
assert('a dollar figure next to the restored image is not mangled by $-replacement syntax',
  dollarRestore.html.includes('$50 every month, up to $500M funded'));
assert('the badge image is restored alongside the untouched dollar copy',
  dollarRestore.html.includes('https://cdn.site.com/badge.png'));

// Same image used in two places, lost from both — both come back, each with
// its own original data-field (not a single guessed name copied twice).
const twoSpots = `
<!-- SL:nav --><nav><img src="https://cdn.site.com/logo.png" data-field="nav.logo"/></nav><!-- /SL:nav -->
<!-- SL:footer --><footer><img src="https://cdn.site.com/logo.png" data-field="footer.logo"/></footer><!-- /SL:footer -->`;
const twoSpotsDropped = `
<!-- SL:nav --><nav></nav><!-- /SL:nav -->
<!-- SL:footer --><footer></footer><!-- /SL:footer -->`;
const twoSpotsRestore = P.restoreLostImagesInPlace({
  beforeHtml: twoSpots,
  afterHtml: twoSpotsDropped,
  images: ['https://cdn.site.com/logo.png'],
});
assert('an image used in two sections is restored to both',
  (twoSpotsRestore.html.match(/logo\.png/g) ?? []).length === 2);
assert('each restored copy keeps ITS OWN original data-field name',
  twoSpotsRestore.html.includes('data-field="nav.logo"') &&
  twoSpotsRestore.html.includes('data-field="footer.logo"'));

// A restored image must not be able to blow out the section it lands in —
// the section around it was regenerated, so any sizing the original relied
// on from a parent class or the section's own <style> block is gone. The
// tag itself must come back with a self-contained overflow guard.
const noStyleSection = `
<!-- SL:trust --><section><div class="row"><h3>Trusted by</h3></div></section><!-- /SL:trust -->`;
const noStyleBefore = `
<!-- SL:trust --><section><div class="row"><h3>Trusted by</h3><img src="https://cdn.site.com/badge.png" data-field="trust.badge"/></div></section><!-- /SL:trust -->`;
const noStyleRestore = P.restoreLostImagesInPlace({
  beforeHtml: noStyleBefore,
  afterHtml: noStyleSection,
  images: ['https://cdn.site.com/badge.png'],
});
assert('a restored image with no prior inline style gets an overflow guard',
  /<img[^>]*style="max-width:100%;height:auto;"[^>]*src="https:\/\/cdn\.site\.com\/badge\.png"/.test(noStyleRestore.html));

// One that already had SOME inline style (but no max-width) must keep that
// style and have the guard appended, not replaced.
const partialStyleSection = `
<!-- SL:trust --><section><div class="row"></div></section><!-- /SL:trust -->`;
const partialStyleBefore = `
<!-- SL:trust --><section><div class="row"><img src="https://cdn.site.com/badge.png" style="border-radius:4px" data-field="trust.badge"/></div></section><!-- /SL:trust -->`;
const partialStyleRestore = P.restoreLostImagesInPlace({
  beforeHtml: partialStyleBefore,
  afterHtml: partialStyleSection,
  images: ['https://cdn.site.com/badge.png'],
});
assert('an existing inline style is kept and the overflow guard is appended to it',
  partialStyleRestore.html.includes('style="border-radius:4px;max-width:100%;height:auto;"'));

// One that already constrains max-width must be left exactly as it was —
// never doubled up.
const alreadyCappedSection = `
<!-- SL:hero --><section></section><!-- /SL:hero -->`;
const alreadyCappedBefore = `
<!-- SL:hero --><section><img src="https://cdn.site.com/hero.png" style="max-width:400px;height:auto" data-field="hero.image"/></section><!-- /SL:hero -->`;
const alreadyCappedRestore = P.restoreLostImagesInPlace({
  beforeHtml: alreadyCappedBefore,
  afterHtml: alreadyCappedSection,
  images: ['https://cdn.site.com/hero.png'],
});
assert('an image that already constrains its own max-width is left untouched',
  alreadyCappedRestore.html.includes('style="max-width:400px;height:auto"') &&
  (alreadyCappedRestore.html.match(/max-width/g) ?? []).length === 1);

// getSlSection / replaceSlSection — the byte-level primitives the AI-assisted
// placement pass uses to read one section and splice its improved version
// back in.
const twoSectionPage = `<!-- SL:nav --><nav><a>Home</a></nav><!-- /SL:nav -->
<!-- SL:hero --><section><h1>Welcome, get $500M funded</h1></section><!-- /SL:hero -->`;
const gotHero = P.getSlSection(twoSectionPage, 'hero');
assert('getSlSection returns the section\'s inner markup', gotHero?.inner.includes('<h1>Welcome, get $500M funded</h1>'));
assert('getSlSection returns null for a section that is not live', P.getSlSection(twoSectionPage, 'footer') === null);

const replaced = P.replaceSlSection(twoSectionPage, 'hero', '<section><h1>New headline, still $500M</h1></section>');
assert('replaceSlSection swaps only the named section\'s inner markup', replaced.includes('<h1>New headline, still $500M</h1>'));
assert('replaceSlSection leaves the other section untouched', replaced.includes('<nav><a>Home</a></nav>'));
assert('replaceSlSection does not mangle a dollar figure via $-replacement syntax', replaced.includes('still $500M') && !replaced.includes('undefined'));

// verifyImagePlacementEdit — the gate the AI placement pass's answer must
// clear before it is trusted over the deterministic (safe but generic)
// splice. Fails closed: any doubt, reject.
const placementBefore = `<div class="row"><h3>Trusted by</h3><img src="https://cdn.site.com/badge.png" style="max-width:100%;height:auto;" data-field="trust.badge"/><img src="https://cdn.site.com/other.png" data-field="trust.other"/></div>`;
const goodPlacement = `<div class="row"><h3>Trusted by</h3><img src="https://cdn.site.com/other.png" data-field="trust.other" style="width:60px"/><img src="https://cdn.site.com/badge.png" data-field="trust.badge" style="width:60px"/></div>`;
assert('a placement edit that keeps the image, its data-field, and every sibling image passes',
  P.verifyImagePlacementEdit({ before: placementBefore, after: goodPlacement, mustKeepSrc: 'https://cdn.site.com/badge.png' }));

const droppedSrc = `<div class="row"><h3>Trusted by</h3><img src="https://cdn.site.com/other.png" data-field="trust.other"/></div>`;
assert('a placement edit that drops the very image it was asked to place fails',
  !P.verifyImagePlacementEdit({ before: placementBefore, after: droppedSrc, mustKeepSrc: 'https://cdn.site.com/badge.png' }));

const droppedField = `<div class="row"><h3>Trusted by</h3><img src="https://cdn.site.com/badge.png" style="width:60px"/><img src="https://cdn.site.com/other.png" data-field="trust.other"/></div>`;
assert('a placement edit that silently drops an unrelated data-field fails',
  !P.verifyImagePlacementEdit({ before: placementBefore, after: droppedField, mustKeepSrc: 'https://cdn.site.com/badge.png' }));

const droppedSibling = `<div class="row"><img src="https://cdn.site.com/badge.png" data-field="trust.badge" style="width:60px"/></div>`;
assert('a placement edit that silently drops a sibling image fails',
  !P.verifyImagePlacementEdit({ before: placementBefore, after: droppedSibling, mustKeepSrc: 'https://cdn.site.com/badge.png' }));

const gutted = `<img src="https://cdn.site.com/badge.png" data-field="trust.badge"/>`;
assert('a placement edit that guts most of the section fails, even if the one image survives',
  !P.verifyImagePlacementEdit({ before: placementBefore, after: gutted, mustKeepSrc: 'https://cdn.site.com/badge.png' }));

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll preservation behavior checks passed.');

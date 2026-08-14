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

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll preservation behavior checks passed.');

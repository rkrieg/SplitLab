/**
 * Guards against collateral damage: things that were on the page before an edit
 * and quietly disappeared after it, without the user ever asking.
 *
 * Every other check in this codebase asks "did we do what was requested?".
 * None of them asked "did we break something that was already fine?" — which is
 * how an edit about nav colors ended up deleting a logo the user had just
 * supplied, and still reported success.
 *
 * Conservative by design: when the prompt contains any removal intent we skip
 * enforcement entirely, because the user deleting their own content is not a
 * regression and fighting that would be worse than the bug.
 */

export interface PageFacts {
  /** Every external image the page renders. */
  imageUrls: string[];
  /** SL section markers present. */
  sectionNames: string[];
  /** h1–h3 text, normalized. */
  headings: string[];
  /**
   * data-field names — the page's click-to-edit handles. The preview's inline
   * editor is driven entirely by [data-field], so a rewrite that drops them
   * silently takes away the user's ability to edit that text by hand.
   */
  editableFields: string[];
}

export interface PageLosses {
  images: string[];
  sections: string[];
  headings: string[];
  /** Click-to-edit handles the edit removed. */
  editableFields: string[];
}

const REMOVAL_INTENT_RE =
  /\b(remove|delete|get rid of|take (it|that|this|them) (out|off)|drop|strip|kill|clear out|no longer|don'?t (want|need|include)|without the|hide)\b/i;

/**
 * STILL LIVE, but only as a fail-open fallback — see findUnrequestedLosses
 * below, which prefers the `removalIntent` boolean when one is supplied. Every
 * caller in follow-up/route.ts passes `intent.removalIntent`, so this regex
 * runs only when the classifier itself was unavailable.
 *
 * That is the one shape of keyword test the sweep deliberately kept: it never
 * overrides a model answer, it only stands in when there is no answer at all,
 * and getting it wrong loses a guard rather than executing a wrong verb.
 *
 * True when the user is deliberately deleting something. Preservation checks
 * stand down in that case — otherwise we'd restore exactly what they asked us
 * to take away.
 */
export function promptHasRemovalIntent(prompt: string): boolean {
  return REMOVAL_INTENT_RE.test(prompt);
}

/**
 * DEAD — no live callers. Unlike promptHasRemovalIntent above, nothing falls
 * back to this one.
 *
 * True when the user is deliberately replacing a logo/image with another
 * (e.g. "navbar logo same as footer"). Preservation must not restore the
 * old nav asset after a successful swap.
 *
 * The job it did is now `judgeUnrequestedLoss` in ai-follow-up-helpers.ts: the
 * model is shown what actually disappeared and asked whether that was the
 * point. It answers about the real diff instead of guessing from the wording.
 */
export function promptHasIntentionalLogoReplace(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;
  if (!/\blogo\b/i.test(t) && !/\b(wordmark|brand mark)\b/i.test(t)) return false;
  return (
    /\b(same as|same one as|same one|replace|swap|use the)\b/i.test(t) ||
    /\b(from|used in|used on)\s+(?:the\s+)?(footer|nav|header|hero)\b/i.test(t) ||
    /\b(footer|nav|header|hero)(?:'s)?\s+logo\b/i.test(t)
  );
}

function normalizeHeading(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function snapshotPageFacts(html: string): PageFacts {
  const imageUrls: string[] = [];
  for (const m of Array.from(html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi))) {
    const src = m[1].trim();
    if (!/^https?:\/\//i.test(src)) continue;
    if (!imageUrls.includes(src)) imageUrls.push(src);
  }

  const sectionNames: string[] = [];
  for (const m of Array.from(html.matchAll(/<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->/gi))) {
    const n = m[1].toLowerCase();
    if (!sectionNames.includes(n)) sectionNames.push(n);
  }

  const headings: string[] = [];
  for (const m of Array.from(html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi))) {
    const t = normalizeHeading(m[1]);
    if (t.length >= 4 && !headings.includes(t)) headings.push(t);
  }

  const editableFields: string[] = [];
  for (const m of Array.from(html.matchAll(/\bdata-field=["']([^"']+)["']/gi))) {
    const f = m[1].trim();
    if (f && !editableFields.includes(f)) editableFields.push(f);
  }

  return { imageUrls, sectionNames, headings, editableFields };
}

/**
 * What the edit destroyed without being asked to. Returns empty losses when the
 * prompt shows removal intent, so intentional deletes never look like bugs.
 */
export function findUnrequestedLosses(opts: {
  beforeHtml: string;
  afterHtml: string;
  prompt: string;
  /**
   * The classifier's read on whether the user is deliberately deleting
   * something. Pass it and it decides; the keyword test below is only used when
   * a caller has no classification available, because "is this a delete?" is a
   * question about meaning, not about which words were typed.
   */
  removalIntent?: boolean;
}): PageLosses {
  const { beforeHtml, afterHtml, prompt, removalIntent } = opts;
  const empty: PageLosses = { images: [], sections: [], headings: [], editableFields: [] };
  const isRemoval =
    typeof removalIntent === 'boolean' ? removalIntent : promptHasRemovalIntent(prompt);
  if (isRemoval) return empty;

  const before = snapshotPageFacts(beforeHtml);
  const after = snapshotPageFacts(afterHtml);

  // An image that moved to a re-hosted copy of itself is not a loss, so compare
  // on the filename tail as well as the full URL.
  const afterTails = new Set(after.imageUrls.map(urlTail));
  const images = before.imageUrls.filter(
    (u) => !after.imageUrls.includes(u) && !afterTails.has(urlTail(u)),
  );

  const sections = before.sectionNames.filter((n) => !after.sectionNames.includes(n));
  const headings = before.headings.filter((h) => !after.headings.includes(h));
  const editableFields = before.editableFields.filter((f) => !after.editableFields.includes(f));

  return { images, sections, headings, editableFields };
}

/**
 * Split losses into "came from sections the model was rewriting" and "came from
 * everywhere else".
 *
 * The region rewrite is handed a run of sections and replaces exactly that run;
 * every byte outside it is carried over untouched by the splice. So a loss
 * outside the run is provable damage — nothing was supposed to change there.
 * A loss INSIDE the run is the model doing the job it was given: putting a
 * picture where one already was replaces it, condensing two headings makes one,
 * merging sections drops a name. Second-guessing that is code overruling the
 * only thing that read the request.
 *
 * This is a mechanical split, not a judgement — it asks WHERE something was,
 * never whether losing it was reasonable.
 */
export function splitLossesByRegion(
  losses: PageLosses,
  beforeHtml: string,
  regionSections: string[],
): { inside: PageLosses; outside: PageLosses } {
  const region = new Set(regionSections);
  const inside: PageLosses = { images: [], sections: [], headings: [], editableFields: [] };
  const outside: PageLosses = { images: [], sections: [], headings: [], editableFields: [] };

  const place = (value: string, key: keyof PageLosses) => {
    const from = sectionsContainingAsset(beforeHtml, value);
    // Unlocatable ⇒ treat as outside. Erring toward "check it" keeps a real
    // loss visible; erring the other way would hide damage behind a shrug.
    const isInside = from.length > 0 && from.every((s) => region.has(s));
    (isInside ? inside : outside)[key].push(value);
  };

  for (const u of losses.images) place(u, 'images');
  for (const h of losses.headings) place(h, 'headings');
  for (const f of losses.editableFields) {
    // data-field paths are "<section>.<field>", so the section is in the name.
    const owner = f.split('.')[0];
    (region.has(owner) ? inside : outside).editableFields.push(f);
  }
  for (const s of losses.sections) {
    (region.has(s) ? inside : outside).sections.push(s);
  }
  return { inside, outside };
}

function urlTail(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  return clean.slice(clean.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * Which sections contained a given asset before the edit — so a restore puts it
 * back where the user had it (hero, testimonials, wherever), instead of
 * assuming nav/footer and quietly moving their content.
 */
export function sectionsContainingAsset(html: string, assetUrl: string): string[] {
  const out: string[] = [];
  for (const m of Array.from(
    html.matchAll(/<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/SL:\1\s*-->/gi),
  )) {
    if (m[2].includes(assetUrl)) out.push(m[1]);
  }
  return out;
}

interface SlBlock {
  name: string;
  /** The whole block including its SL markers — what gets spliced. */
  block: string;
  inner: string;
}

function slBlocks(html: string): SlBlock[] {
  const out: SlBlock[] = [];
  for (const m of Array.from(
    html.matchAll(/<!--\s*SL:([a-zA-Z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/SL:\1\s*-->/gi),
  )) {
    out.push({ name: m[1].toLowerCase(), block: m[0], inner: m[2] });
  }
  return out;
}

/** Does this section, as it stood before the edit, contain the lost thing? */
function blockHolds(inner: string, loss: string, kind: keyof PageLosses): boolean {
  if (kind === 'images') return inner.includes(loss);
  if (kind === 'editableFields') {
    return new RegExp(`data-field=["']${loss.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(
      inner,
    );
  }
  if (kind === 'headings') {
    return Array.from(inner.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)).some(
      (m) => normalizeHeading(m[1]) === loss,
    );
  }
  return false;
}

/**
 * Put back the sections an edit damaged, keeping the part the user asked for.
 *
 * Rejecting the whole edit was the only answer this code had, and it is a bad
 * one on its own: the user asks for one change, we make it, drop an unrelated
 * photo somewhere else on the way past, and hand them back their original page
 * with an apology. They lose the work they wanted because of a mistake they
 * never made.
 *
 * Collateral damage is almost always confined to sections the request was never
 * about, and those sections have a known-good version one edit back — so splice
 * it in, byte for byte, and let the requested change stand.
 *
 * `protectedSections` are the ones the request WAS about. Restoring those would
 * quietly undo the very thing that was asked for and then report success, which
 * is worse than refusing. They are left alone; if the damage is there, the
 * caller still rejects.
 */
export function restoreDamagedSections(opts: {
  beforeHtml: string;
  afterHtml: string;
  losses: PageLosses;
  protectedSections: string[];
}): { html: string; restored: string[] } {
  const { beforeHtml, afterHtml, losses } = opts;
  const before = slBlocks(beforeHtml);
  if (before.length === 0) return { html: afterHtml, restored: [] };

  const protectedNames = new Set(
    opts.protectedSections.map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  protectedNames.add('head');

  // Which sections held what vanished, according to the page as it was.
  const damaged = new Set<string>();
  for (const kind of ['images', 'editableFields', 'headings'] as const) {
    for (const loss of losses[kind]) {
      for (const b of before) {
        if (blockHolds(b.inner, loss, kind)) damaged.add(b.name);
      }
    }
  }
  for (const name of losses.sections) damaged.add(name.toLowerCase());

  let html = afterHtml;
  const restored: string[] = [];

  for (const b of before) {
    if (!damaged.has(b.name) || protectedNames.has(b.name)) continue;

    const live = new RegExp(
      `<!--\\s*SL:${b.name}\\s*-->[\\s\\S]*?<!--\\s*/SL:${b.name}\\s*-->`,
      'i',
    );
    if (live.test(html)) {
      const next = html.replace(live, () => b.block);
      if (next !== html) {
        html = next;
        restored.push(b.name);
      }
      continue;
    }

    // The section is gone entirely. Re-insert it at the seam it used to sit in,
    // but only if its content did not simply move — a section that was merged
    // into its neighbour is still on the page, and putting the old copy back
    // would show the user the same content twice.
    const marker = Array.from(b.inner.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi))
      .map((m) => normalizeHeading(m[1]))
      .find((t) => t.length >= 8);
    if (marker && normalizeHeading(html).includes(marker)) continue;

    const idx = before.findIndex((x) => x.name === b.name);
    const after = before.slice(idx + 1).find((x) => new RegExp(`<!--\\s*SL:${x.name}\\s*-->`, 'i').test(html));
    const prev = before
      .slice(0, idx)
      .reverse()
      .find((x) => new RegExp(`<!--\\s*/SL:${x.name}\\s*-->`, 'i').test(html));

    if (after) {
      const at = html.search(new RegExp(`<!--\\s*SL:${after.name}\\s*-->`, 'i'));
      if (at >= 0) {
        html = `${html.slice(0, at)}${b.block}\n${html.slice(at)}`;
        restored.push(b.name);
      }
    } else if (prev) {
      const close = new RegExp(`<!--\\s*/SL:${prev.name}\\s*-->`, 'i').exec(html);
      if (close) {
        const at = close.index + close[0].length;
        html = `${html.slice(0, at)}\n${b.block}${html.slice(at)}`;
        restored.push(b.name);
      }
    }
  }

  return { html, restored };
}

export function hasLosses(losses: PageLosses): boolean {
  return (
    losses.images.length > 0 ||
    losses.sections.length > 0 ||
    losses.headings.length > 0 ||
    losses.editableFields.length > 0
  );
}

/** Short human sentence for the "not fully done" message. */
export function describeLosses(losses: PageLosses): string | null {
  const bits: string[] = [];
  if (losses.images.length > 0) {
    bits.push(`${losses.images.length} image${losses.images.length === 1 ? '' : 's'} disappeared`);
  }
  if (losses.sections.length > 0) {
    bits.push(`section${losses.sections.length === 1 ? '' : 's'} ${losses.sections.join(', ')} disappeared`);
  }
  if (losses.headings.length > 0) {
    bits.push(`${losses.headings.length} heading${losses.headings.length === 1 ? '' : 's'} disappeared`);
  }
  if (losses.editableFields.length > 0) {
    bits.push(
      `${losses.editableFields.length} item${losses.editableFields.length === 1 ? '' : 's'} ` +
        `stopped being click-to-edit`,
    );
  }
  if (bits.length === 0) return null;
  return `${bits.join('; ')} without being asked for`;
}

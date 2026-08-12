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
 * True when the user is deliberately deleting something. Preservation checks
 * stand down in that case — otherwise we'd restore exactly what they asked us
 * to take away.
 */
export function promptHasRemovalIntent(prompt: string): boolean {
  return REMOVAL_INTENT_RE.test(prompt);
}

/**
 * True when the user is deliberately replacing a logo/image with another
 * (e.g. "navbar logo same as footer"). Preservation must not restore the
 * old nav asset after a successful swap.
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
}): PageLosses {
  const { beforeHtml, afterHtml, prompt } = opts;
  const empty: PageLosses = { images: [], sections: [], headings: [], editableFields: [] };
  if (promptHasRemovalIntent(prompt)) return empty;

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

/**
 * General “reuse existing content → put it in section X” — logo, text, or image.
 * Deterministic apply + fail-closed checks. Not one-off footer/logo helpers.
 */

import { extractQuotedSpans } from './ai-page-requirements';

export type ContentReuseKind = 'logo' | 'text' | 'image';

export interface ContentReuseIntent {
  kind: ContentReuseKind;
  /** Destination SL section names (resolved against live page). */
  targets: string[];
  /** Quoted / explicit copy to place (text kind). */
  textPayload: string | null;
  /** When copying from another section (“hero headline → footer”). */
  sourceSectionHint: string | null;
}

const SECTION_NOUN =
  'footer|hero|nav(?:bar)?|header|about|cta|sidebar|pricing|faq|form|section';

/**
 * Words users say for parts whose section name doesn't contain that word.
 * Everything else resolves by matching the live section names themselves, so a
 * page with `testimonials` or `how_it_works` works without being listed here.
 */
const SECTION_SYNONYMS: { key: RegExp; spoken: RegExp }[] = [
  { key: /nav|header/, spoken: /\b(nav|navbar|navigation(?:\s*bar)?|header|top\s*bar|menu\s*bar)\b/i },
  { key: /footer/, spoken: /\b(footer|bottom\s*(?:bar|section))\b/i },
  { key: /hero/, spoken: /\b(hero|banner|above[- ]the[- ]fold|top\s*section|first\s*section)\b/i },
  { key: /cta|form|popup|contact|lead/, spoken: /\b(form|cta|sign[- ]?up|contact|lead\s*capture)\b/i },
  { key: /faq/, spoken: /\b(faq|questions?|q\s*&\s*a)\b/i },
  { key: /social_proof|testimonial|review/, spoken: /\b(testimonials?|reviews?|social\s*proof)\b/i },
  { key: /logo_wall|logos/, spoken: /\b(logo\s*wall|client\s*logos)\b/i },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Map what the user said → existing SL section names.
 *
 * Matches the live section list first (so any section the builder can emit is
 * addressable — "put the logo in the testimonials section" works without the
 * word "testimonials" being hardcoded), then falls back to spoken synonyms for
 * parts whose section name doesn't contain the word people use for it.
 *
 * Word-boundary matched: a section called `form` must not be triggered by the
 * word "information".
 */
export function inferTargetSectionNames(prompt: string, sectionNames: string[]): string[] {
  const found: string[] = [];
  const add = (name: string) => {
    if (!found.includes(name)) found.push(name);
  };

  const everywhere =
    /\beverywhere\b|\ball (the )?(logos?|sections)\b|\bevery (logo|section)\b|\bnav and footer\b|\bfooter and nav\b|\bboth (the )?(nav|footer)/i.test(
      prompt,
    );

  if (everywhere) {
    for (const name of sectionNames) {
      if (name.toLowerCase() === 'head') continue;
      if (/nav|header|footer|hero/i.test(name)) add(name);
    }
    if (found.length > 0) return found.slice(0, 6);
  }

  // 1. The section's own name, spoken literally (`how_it_works` → "how it works")
  for (const name of sectionNames) {
    const spoken = name.toLowerCase().replace(/[-_]+/g, ' ').trim();
    if (spoken.length < 3) continue;
    if (new RegExp(`\\b${escapeRe(spoken)}s?\\b`, 'i').test(prompt)) add(name);
    else if (spoken.endsWith('s') && new RegExp(`\\b${escapeRe(spoken.slice(0, -1))}\\b`, 'i').test(prompt)) {
      add(name);
    }
  }

  // 2. Spoken synonyms for sections named something else
  for (const { key, spoken } of SECTION_SYNONYMS) {
    if (!spoken.test(prompt)) continue;
    for (const name of sectionNames) {
      if (key.test(name.toLowerCase())) add(name);
    }
  }

  return found.slice(0, 4);
}

function extractQuotedPayloads(prompt: string): string[] {
  // Shared extractor: apostrophes in words like `That's` must not open a quote,
  // or the "payload" to place becomes a slice of the user's own instructions.
  return extractQuotedSpans(prompt, 3, 400);
}

function placementLanguage(prompt: string): boolean {
  return /\b(in (the )?|on (the )?|into (the )?|to (the )?|also|as well|too|same|everywhere|both|copy|place|put|add|show|keep|use)\b/i.test(
    prompt,
  );
}

/** Recolor / restyle an existing logo — not "put the (white) logo in section X". */
export function isLogoColorStyleAsk(prompt: string): boolean {
  const t = prompt.trim();
  if (!/\blogos?\b/i.test(t)) return false;
  const recolor =
    /\bmake\b[\s\S]{0,50}\blogos?\b[\s\S]{0,40}\b(white|black|colou?rs?)\b/i.test(t) ||
    /\bmake\b[\s\S]{0,50}\b(the\s+)?(logo\s+)?(colou?rs?|fill|tint)\b[\s\S]{0,30}\b(white|black)\b/i.test(t) ||
    /\bmake\b[\s\S]{0,40}\b(white|black)\b[\s\S]{0,40}\blogos?\b/i.test(t) ||
    /\blogos?\s+(colou?rs?|fill|tint)\b/i.test(t) ||
    /\b(recolou?r|whiten)\b[\s\S]{0,30}\blogos?\b/i.test(t);
  if (!recolor) return false;
  // Explicit place/put/add/copy of a logo file into a section is still reuse.
  if (/\b(put|place|add|copy)\b[\s\S]{0,40}\blogos?\b[\s\S]{0,30}\b(in|into|on)\b/i.test(t)) {
    return false;
  }
  return true;
}

/**
 * Detect reuse/placement asks: put existing logo/text/image into named section(s).
 * Null when this is not a reuse ask (let normal edit paths handle it).
 */
export function detectContentReuseIntent(
  prompt: string,
  sectionNames: string[],
): ContentReuseIntent | null {
  const t = prompt.trim();
  if (!t) return null;

  const targets = inferTargetSectionNames(t, sectionNames);
  const quotes = extractQuotedPayloads(t);

  // ── Logo ──────────────────────────────────────────────────────────────
  // Recolor ("make the logo white everywhere") is a style patch, not embed.
  if (isLogoColorStyleAsk(t)) {
    return null;
  }
  // A resolved target already proves the user named a real destination, so any
  // section the page actually has works here — not just a fixed noun list.
  if (/\blogo\b/i.test(t) && placementLanguage(t) && (targets.length > 0 || /\beverywhere\b/i.test(t))) {
    let sourceSectionHint: string | null = null;
    const fromM =
      /\b(?:same as|same one as|from|used in|in the)\s+(?:the\s+)?(footer|hero|nav|header|navbar)\b/i.exec(t) ||
      /\b(footer|hero|nav|header|navbar)(?:'s)?\s+logo\b/i.exec(t) ||
      /\blogo\s+(?:used\s+)?(?:in|on|from)\s+(?:the\s+)?(footer|hero|nav|header|navbar)\b/i.exec(t);
    if (fromM) {
      const raw = (fromM[1] || fromM[2] || '').toLowerCase();
      sourceSectionHint = raw === 'navbar' ? 'nav' : raw;
    }

    let dests = targets;
    if (sourceSectionHint) {
      dests = dests.filter((n) => !n.toLowerCase().includes(sourceSectionHint!));
    }
    // "copy logo from footer to navbar" — destination wins over whatever
    // section nouns also appeared as the source.
    const toM =
      /\b(?:to|into|on)\s+(?:the\s+)?(nav(?:bar)?|header|footer|hero|[a-z][a-z0-9_-]{2,30})\b/i.exec(t);
    if (toM) {
      const mapped = inferTargetSectionNames(toM[1], sectionNames).filter(
        (n) => !sourceSectionHint || !n.toLowerCase().includes(sourceSectionHint),
      );
      if (mapped.length > 0) dests = mapped;
    }
    if (dests.length === 0 && sourceSectionHint) {
      const fallbackTo =
        /\b(?:to|into|on)\s+(?:the\s+)?(nav(?:bar)?|header|footer|hero)\b/i.exec(t) ||
        /\b(nav(?:bar)?|header)\b/i.exec(t);
      if (fallbackTo) {
        dests = inferTargetSectionNames(fallbackTo[1], sectionNames);
      }
    }

    return {
      kind: 'logo',
      targets: dests.length > 0 ? dests : targets,
      textPayload: null,
      sourceSectionHint,
    };
  }

  // ── Text ──────────────────────────────────────────────────────────────
  // "copy hero headline to footer" / "put this text in the about" / quotes + section
  const textish =
    /\b(text|copy|headline|heading|title|subhead|wording|tagline|sentence|paragraph)\b/i.test(t) ||
    quotes.length > 0;
  const copyFromTo =
    /\b(copy|move|duplicate)\b[\s\S]{0,40}\b(from\b|the\b)?[\s\S]{0,40}\b(to|into|in)\b/i.test(t) ||
    /\b(same|that|this)\s+(text|headline|copy|heading|title)\b[\s\S]{0,40}\b(in|on|to|into|as well)\b/i.test(
      t,
    ) ||
    /\b(put|place|add|use|show)\b[\s\S]{0,60}\b(text|headline|copy|heading|title)\b[\s\S]{0,40}\b(in|on|to|into)\b/i.test(
      t,
    ) ||
    (quotes.length > 0 && targets.length > 0 && /\b(in|on|to|into|for)\b/i.test(t));

  if (textish && copyFromTo && placementLanguage(t)) {
    let sourceSectionHint: string | null = null;
    const fromM =
      /\b(?:from|of)\s+(?:the\s+)?(footer|hero|nav|header|about)\b/i.exec(t) ||
      /\b(footer|hero|nav|header|about)\s+(?:headline|heading|title|text|copy)\b/i.exec(t);
    if (fromM) sourceSectionHint = fromM[1].toLowerCase();

    // Destinations: prefer explicit "to/in X"; if both source+dest nouns, drop source from targets
    let dests = targets;
    if (sourceSectionHint && dests.length > 1) {
      dests = dests.filter((n) => !n.toLowerCase().includes(sourceSectionHint!));
    }
    // "copy hero … to footer" — hero may be inferred as target; fix via to/in
    // clause. The destination phrase is resolved against live sections rather
    // than matched against a fixed list, so "to the testimonials" works too.
    const toM = /\b(?:to|into|in)\s+(?:the\s+)?([a-z][a-z0-9 _-]{2,30})/i.exec(t);
    if (toM) {
      const mapped = inferTargetSectionNames(toM[1], sectionNames);
      if (mapped.length > 0) dests = mapped;
    }

    if (dests.length === 0 && targets.length > 0 && !sourceSectionHint) dests = targets;

    return {
      kind: 'text',
      targets: dests,
      textPayload: quotes[0] ?? null,
      sourceSectionHint,
    };
  }

  // ── Image (attached content already handled elsewhere; detect place-existing-img) ──
  if (
    /\b(image|photo|picture|headshot)\b/i.test(t) &&
    placementLanguage(t) &&
    targets.length > 0 &&
    /\b(same|also|as well|too|copy|this|that)\b/i.test(t)
  ) {
    return {
      kind: 'image',
      targets,
      textPayload: null,
      sourceSectionHint: null,
    };
  }

  return null;
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Primary visible headline inside a section block. Fail-closed. */
export function extractPrimaryHeadlineFromHtml(sectionHtml: string): string | null {
  const h = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(sectionHtml);
  if (h) {
    const text = stripHtmlToText(h[1]);
    if (text.length >= 2) return text;
  }
  const df =
    /data-field=["'](?:headline|title|heading)["'][^>]*>([\s\S]*?)</i.exec(sectionHtml) ||
    /<[^>]+data-field=["'](?:headline|title|heading)["'][^>]*>([\s\S]*?)<\//i.exec(sectionHtml);
  if (df) {
    const text = stripHtmlToText(df[1]);
    if (text.length >= 2) return text;
  }
  return null;
}

function getSlSectionInner(html: string, sectionName: string): { full: string; inner: string; index: number } | null {
  const re = new RegExp(
    `<!--\\s*SL:${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->([\\s\\S]*?)<!--\\s*\\/SL:${sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-->`,
    'i',
  );
  const m = re.exec(html);
  if (!m || m.index === undefined) return null;
  return { full: m[0], inner: m[1], index: m.index };
}

/**
 * Place plain text into a section: prefer replacing first h1–h3, else first
 * data-field headline, else prepend a paragraph. Never invents copy.
 */
export function forcePlaceTextInSection(html: string, sectionName: string, text: string): string {
  const payload = text.replace(/\s+/g, ' ').trim();
  if (!payload) return html;
  const sl = getSlSectionInner(html, sectionName);
  if (!sl) return html;
  if (sl.inner.includes(payload)) return html;

  let inner = sl.inner;
  if (/<h[1-3]\b/i.test(inner)) {
    inner = inner.replace(
      /(<h[1-3]\b[^>]*>)([\s\S]*?)(<\/h[1-3]>)/i,
      `$1${escapeHtml(payload)}$3`,
    );
  } else if (/data-field=["'](?:headline|title|heading|text|body)["']/i.test(inner)) {
    inner = inner.replace(
      /(data-field=["'](?:headline|title|heading|text|body)["'][^>]*>)([\s\S]*?)(<)/i,
      `$1${escapeHtml(payload)}$3`,
    );
  } else if (/<p\b/i.test(inner)) {
    inner = inner.replace(/(<p\b[^>]*>)([\s\S]*?)(<\/p>)/i, `$1${escapeHtml(payload)}$3`);
  } else {
    inner =
      `<p data-field="text" style="margin:0 0 12px;">${escapeHtml(payload)}</p>` + inner;
  }

  return (
    html.slice(0, sl.index) +
    `<!-- SL:${sectionName} -->${inner}<!-- /SL:${sectionName} -->` +
    html.slice(sl.index + sl.full.length)
  );
}

export function forcePlaceTextIntoSections(
  html: string,
  sectionNames: string[],
  text: string,
): string {
  let out = html;
  for (const name of sectionNames) {
    out = forcePlaceTextInSection(out, name, text);
  }
  return out;
}

/**
 * Is the copy visible in a design screenshot content to reproduce, or just part
 * of a look to imitate?
 *
 * "make our footer like this" → reproduce: the footer's words are the point.
 * "look like this hero, except it should say 'X' … nothing else is required" →
 * imitate only. Reading the reference's own headline onto the page there puts
 * words on it the user explicitly replaced, and then reports them as unmet asks.
 *
 * Defaults to NO on purpose: force-placing text is destructive and highly
 * visible, while skipping it just leaves the model's own copy in place.
 */
export function wantsReferenceCopy(prompt: string): boolean {
  const t = prompt.trim();
  if (!t) return false;

  // The user supplied their own copy / capped the scope → the reference's copy is
  // explicitly not wanted, whatever else the prompt says.
  const REPLACEMENT_RE =
    /\b(except|instead|rather than|but it should say|it should (just )?say|change the (copy|text|headline|wording)|nothing else|no other (copy|text)|don'?t (use|copy|include) the (copy|text|words|wording))\b/i;
  if (REPLACEMENT_RE.test(t)) return false;

  // Explicit "use the words from it"
  if (
    /\b(use|copy|keep|reuse|take|pull|match|same)\b[^.]{0,40}\b(copy|text|words|wording|content|headline|legal|disclaimer)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(verbatim|word[- ]for[- ]word|exactly as (shown|written))\b/i.test(t)) return true;

  // "make our footer like this" — cloning a named part implies its content.
  const namesPart = new RegExp(`\\b(${SECTION_NOUN})\\b`, 'i').test(t);
  const clonesIt =
    /\b(like|just like|same as|identical to|replicate|recreate|clone|copy)\s+(this|that|these|those|the one)\b/i.test(
      t,
    );
  return namesPart && clonesIt;
}

/**
 * Collapse OCR/copy lines from design screenshots.
 * Same screenshot attached twice (or two near-identical crops) must not become
 * two copies of the footer legal block. Exact dups and "this line is already
 * inside a longer kept line" are dropped; the longer phrasing wins.
 */
export function dedupeDesignCopyLines(lines: string[]): string[] {
  const cleaned = lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 6);
  const kept: string[] = [];
  for (const line of cleaned) {
    const key = line.toLowerCase();
    const idx = kept.findIndex((u) => {
      const uk = u.toLowerCase();
      return uk === key || uk.includes(key) || key.includes(uk);
    });
    if (idx < 0) {
      kept.push(line);
      continue;
    }
    if (line.length > kept[idx].length) kept[idx] = line;
  }
  return kept.slice(0, 12);
}

/**
 * Append missing design-OCR lines as paragraphs inside a section (create path).
 * Does not overwrite existing headlines — only adds lines still absent from HTML.
 * Duplicate / near-duplicate OCR lines (same screenshot attached twice) are
 * collapsed first so we never stamp the same sentence twice.
 */
export function forceAppendMissingDesignCopy(
  html: string,
  sectionName: string,
  lines: string[],
): string {
  const missing = dedupeDesignCopyLines(lines).filter((l) => !html.includes(l));
  if (missing.length === 0) return html;
  const sl = getSlSectionInner(html, sectionName);
  if (!sl) return html;
  const block = missing
    .map(
      (l) =>
        `<p data-field="text" data-sl-design-copy="1" style="margin:0 0 8px;">${escapeHtml(l)}</p>`,
    )
    .join('');
  const inner = sl.inner + block;
  return (
    html.slice(0, sl.index) +
    `<!-- SL:${sectionName} -->${inner}<!-- /SL:${sectionName} -->` +
    html.slice(sl.index + sl.full.length)
  );
}

export function sectionHasText(html: string, sectionName: string, text: string): boolean {
  const sl = getSlSectionInner(html, sectionName);
  if (!sl) return false;
  return sl.inner.includes(text);
}

/** Resolve source section HTML by hint against live section list. */
export function resolveSourceSectionName(
  hint: string | null,
  sectionNames: string[],
): string | null {
  if (!hint) return null;
  const mapped = inferTargetSectionNames(hint, sectionNames);
  return mapped[0] ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

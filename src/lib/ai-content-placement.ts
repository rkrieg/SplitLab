/**
 * General “reuse existing content → put it in section X” — logo, text, or image.
 * Deterministic apply + fail-closed checks. Not one-off footer/logo helpers.
 */

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
    /\beverywhere\b|\ball sections\b|\bevery section\b|\bnav and footer\b|\bfooter and nav\b|\bboth (the )?(nav|footer)/i.test(
      prompt,
    );

  if (everywhere) {
    for (const name of sectionNames) {
      if (/nav|header|footer/i.test(name)) add(name);
    }
    if (found.length > 0) return found.slice(0, 4);
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
  const out: string[] = [];
  const re = /"([^"\n]{3,400})"|'([^'\n]{3,400})'|“([^”\n]{3,400})”/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const q = (m[1] || m[2] || m[3] || '').replace(/\s+/g, ' ').trim();
    if (q.length >= 3) out.push(q);
  }
  return out;
}

function placementLanguage(prompt: string): boolean {
  return /\b(in (the )?|on (the )?|into (the )?|to (the )?|also|as well|too|same|everywhere|both|copy|place|put|add|show|keep|use)\b/i.test(
    prompt,
  );
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
  // A resolved target already proves the user named a real destination, so any
  // section the page actually has works here — not just a fixed noun list.
  if (/\blogo\b/i.test(t) && placementLanguage(t) && (targets.length > 0 || /\beverywhere\b/i.test(t))) {
    return {
      kind: 'logo',
      targets,
      textPayload: null,
      sourceSectionHint: null,
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
 * Append missing design-OCR lines as paragraphs inside a section (create path).
 * Does not overwrite existing headlines — only adds lines still absent from HTML.
 */
export function forceAppendMissingDesignCopy(
  html: string,
  sectionName: string,
  lines: string[],
): string {
  const missing = lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 6 && !html.includes(l));
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

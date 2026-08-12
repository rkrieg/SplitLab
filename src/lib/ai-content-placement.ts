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
 * Map user nouns → existing SL section names.
 * Shared by design-match, logo placement, text/image reuse.
 */
export function inferTargetSectionNames(prompt: string, sectionNames: string[]): string[] {
  const found: string[] = [];
  const addMatching = (pred: (name: string) => boolean) => {
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
  if (/\b(cta|pricing|faq|sidebar|form)\b/i.test(prompt)) {
    const m = prompt.match(/\b(cta|pricing|faq|sidebar|form)\b/i);
    if (m) addMatching((n) => n.includes(m[1].toLowerCase()) || (m[1].toLowerCase() === 'form' && /cta|popup|contact|lead/.test(n)));
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
  if (/\blogo\b/i.test(t) && placementLanguage(t) && (targets.length > 0 || /\beverywhere\b/i.test(t))) {
    // Bare "use logo from https://…" without in/on/also destination → not reuse
    const hasDestNoun = new RegExp(`\\b(${SECTION_NOUN}|everywhere)\\b`, 'i').test(t);
    if (hasDestNoun) {
      return {
        kind: 'logo',
        targets,
        textPayload: null,
        sourceSectionHint: null,
      };
    }
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
    (quotes.length > 0 &&
      /\b(in|on|to|into|for)\b[\s\S]{0,30}\b(footer|hero|nav|header|about|cta|section)\b/i.test(t));

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
    // "copy hero … to footer" — hero may be inferred as target; fix via to/in clause
    const toM = /\b(?:to|into|in)\s+(?:the\s+)?(footer|hero|nav|header|about|cta)\b/i.exec(t);
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

/**
 * Shared utilities for AI variant generation — used by both
 * the generate and regenerate routes.
 */

// Strip HTML tags and decode common entities to get plain text
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1))));
}

// Normalize quotes, dashes, and whitespace for fuzzy matching
function normalizeText(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Apply text replacements to HTML using text-layer matching.
 *
 * The challenge: Claude produces "visible text" find strings, but the HTML
 * contains tags (<strong>, <span>, <br>), entities (&rsquo;, &amp;), and
 * varying whitespace between those words. Exact string matching fails.
 *
 * Solution: Build a mapping from plain-text positions → HTML positions,
 * find the text in the plain-text layer, then replace the corresponding
 * HTML span.
 */
export function applyReplacements(
  html: string,
  replacements: Array<{ find: string; replace: string }>,
  logPrefix = '[Variant]'
): string {
  let result = html;
  let applied = 0;

  for (const { find, replace } of replacements) {
    if (!find || find === replace) continue;

    // Strategy 1: Exact match in raw HTML
    if (result.includes(find)) {
      result = result.replace(find, replace);
      applied++;
      console.log(`${logPrefix} Exact match: "${find.slice(0, 60)}"`);
      continue;
    }

    // Strategy 2: Text-layer matching with normalization
    const plainText = htmlToText(result);
    const normalizedFind = normalizeText(find);
    const normalizedPlain = normalizeText(plainText);

    const textIdx = normalizedPlain.indexOf(normalizedFind);
    if (textIdx === -1) {
      console.warn(`${logPrefix} NOT FOUND: "${find.slice(0, 100)}"`);
      continue;
    }

    // Build mapping: for each character in normalized-plain-text, record the
    // corresponding position in the original HTML.
    const textToHtml: number[] = [];
    let inTag = false;

    let i = 0;
    while (i < result.length) {
      if (result[i] === '<') {
        inTag = true;
        i++;
        continue;
      }
      if (inTag) {
        if (result[i] === '>') inTag = false;
        i++;
        continue;
      }

      // We're in text content — read one "character" (may be an entity)
      const charStart = i;

      if (result[i] === '&') {
        // Read HTML entity
        let entityEnd = i + 1;
        while (entityEnd < result.length && result[entityEnd] !== ';' && entityEnd - i < 10) {
          entityEnd++;
        }
        if (entityEnd < result.length && result[entityEnd] === ';') {
          entityEnd++; // include the semicolon
        }
        const entity = result.slice(i, entityEnd);
        const decoded = htmlToText(entity);
        const normalized = normalizeText(decoded);

        if (/^\s+$/.test(normalized) || normalized === '') {
          // Whitespace entity (like &nbsp;) — check if we should collapse
          const lastMapped = textToHtml.length > 0 ? normalizedPlain[textToHtml.length - 1] : '';
          if (lastMapped !== ' ' || textToHtml.length === 0) {
            textToHtml.push(charStart);
          }
        } else {
          for (let c = 0; c < normalized.length; c++) {
            textToHtml.push(charStart);
          }
        }
        i = entityEnd;
      } else {
        const ch = result[i];
        const normCh = normalizeText(ch);

        if (/\s/.test(ch)) {
          // Collapse whitespace: only add if previous wasn't already a space
          if (textToHtml.length === 0 || normalizedPlain[textToHtml.length - 1] !== ' ') {
            textToHtml.push(charStart);
          }
          i++;
          // Skip remaining whitespace
          while (i < result.length && /\s/.test(result[i]) && result[i] !== '<') {
            i++;
          }
        } else {
          for (let c = 0; c < normCh.length; c++) {
            textToHtml.push(charStart);
          }
          i++;
        }
      }
    }
    textToHtml.push(result.length); // sentinel

    if (textIdx >= textToHtml.length || textIdx + normalizedFind.length >= textToHtml.length) {
      console.warn(`${logPrefix} Position out of range for: "${find.slice(0, 80)}"`);
      continue;
    }

    const htmlStart = textToHtml[textIdx];
    // For the end position, we need the HTML position AFTER the last matched char.
    // textToHtml[textIdx + normalizedFind.length] points to the start of the next char.
    let htmlEnd = textToHtml[textIdx + normalizedFind.length];

    // Walk backwards to trim any trailing whitespace/tags we might have overshot
    // Actually, we want to include any HTML tags that are INSIDE the matched text
    // but not tags that come AFTER. The mapping handles this correctly since
    // textToHtml points to char starts, and the next entry is the next char start.

    if (htmlStart >= 0 && htmlEnd > htmlStart) {
      const matchedHtml = result.slice(htmlStart, htmlEnd);
      console.log(`${logPrefix} Text-layer match: "${find.slice(0, 50)}" → "${matchedHtml.slice(0, 80)}"`);
      result = result.slice(0, htmlStart) + replace + result.slice(htmlEnd);
      applied++;
    } else {
      console.warn(`${logPrefix} Bad mapping for: "${find.slice(0, 80)}"`);
    }
  }

  console.log(`${logPrefix} Applied ${applied}/${replacements.length} replacements`);
  return result;
}

/**
 * Prepare HTML for Claude's context — strip non-text elements to reduce tokens.
 * This is only used for the PROMPT, not for the variant output.
 */
export function prepareHtml(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, (match) => {
    return match.length > 500 ? '<!-- svg -->' : match;
  });
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  if (s.length > 100_000) s = s.slice(0, 100_000) + '\n<!-- truncated -->';
  return s;
}

/**
 * Inject a <base> tag so ALL relative URLs resolve against the original domain.
 */
export function injectBaseTag(html: string, sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  const pathDir = parsed.pathname.replace(/\/[^/]*$/, '/');
  const base = parsed.origin + pathDir;
  const baseTag = `<base href="${base}">`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&\n${baseTag}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, `$&\n<head>${baseTag}</head>`);
  }
  return `${baseTag}\n${html}`;
}

/**
 * Utility to clean and prepare fetched HTML for safe inline rendering
 * inside a Shadow DOM container (no iframe required).
 */

export interface ShadowContent {
  styles: string;
  body: string;
  combined: string;
}

/**
 * Parse a full HTML document string into styles + body content
 * suitable for injection into a Shadow DOM root.
 *
 * - Strips all <script> and <noscript> tags
 * - Extracts <style> blocks and <link rel="stylesheet"> from <head>
 * - Extracts <body> inner HTML
 * - Preserves <base> tags so relative URLs resolve correctly
 * - Adds data-editable attributes to key text elements
 */
export function parseShadowContent(rawHtml: string): ShadowContent {
  let html = rawHtml;

  // Remove scripts entirely (security)
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');

  // Collect style / link tags from anywhere in the document
  const styleParts: string[] = [];

  // Preserve <base> tag if present
  const baseMatch = html.match(/<base[^>]*>/i);
  if (baseMatch) styleParts.push(baseMatch[0]);

  // Extract <link rel="stylesheet"> tags
  const linkRegex = /<link\b[^>]*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRegex.exec(html)) !== null) {
    const tag = lm[0];
    if (/rel=["']stylesheet["']/i.test(tag) || /type=["']text\/css["']/i.test(tag)) {
      styleParts.push(tag);
    }
  }

  // Extract <style> blocks
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = styleRegex.exec(html)) !== null) {
    styleParts.push(sm[0]);
  }

  // Extract body content
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let bodyHtml = bodyMatch ? bodyMatch[1] : html;

  // Add data-editable attributes to text elements not already marked
  bodyHtml = addEditableAttributes(bodyHtml);

  const styles = styleParts.join('\n');
  return {
    styles,
    body: bodyHtml,
    combined: styles + '\n' + bodyHtml,
  };
}

/**
 * Inject data-editable and data-section attributes onto key HTML elements.
 * Only adds attributes where they don't already exist.
 */
function addEditableAttributes(html: string): string {
  // Headings → data-editable="text"
  html = html.replace(
    /<(h[1-6])(\s[^>]*)?>/gi,
    (_m, tag: string, attrs = '') => {
      if (attrs.includes('data-editable')) return _m;
      return `<${tag}${attrs} data-editable="text">`;
    }
  );

  // Paragraphs → data-editable="text"
  html = html.replace(
    /<(p)(\s[^>]*)?>/gi,
    (_m, tag: string, attrs = '') => {
      if (attrs.includes('data-editable')) return _m;
      return `<${tag}${attrs} data-editable="text">`;
    }
  );

  // CTA buttons and links with class containing "btn", "cta", "button"
  html = html.replace(
    /<(a|button)(\s[^>]*)?>/gi,
    (_m, tag: string, attrs = '') => {
      if (attrs.includes('data-editable')) return _m;
      if (/class="[^"]*\b(btn|cta|button)\b/i.test(attrs)) {
        return `<${tag}${attrs} data-editable="cta">`;
      }
      return _m;
    }
  );

  return html;
}

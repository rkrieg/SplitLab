// Reads a field's current text/image value straight out of stored HTML,
// given a selector this codebase actually generates (`#id` from manual
// mapping's inject-field-id, or `[data-field="hero.X"]` from hero auto-
// mapping). Not a general CSS selector engine — only the two forms this
// system writes. Uses htmlparser2 (already a transitive dep used the same
// way in inject-field-id/route.ts) instead of cheerio, which pulls in
// undici and breaks the webpack build (private class fields it can't parse).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseDocument } = require('htmlparser2') as typeof import('htmlparser2');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

function textOf(el: Node): string {
  let out = '';
  function walk(node: Node) {
    if (node.type === 'text') out += node.data;
    else if (node.children) node.children.forEach(walk);
  }
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
}

function findFirst(nodes: Node[], predicate: (el: Node) => boolean): Node | null {
  for (const node of nodes) {
    if (node.type !== 'tag') continue;
    if (predicate(node)) return node;
    if (node.children) {
      const found = findFirst(node.children, predicate);
      if (found) return found;
    }
  }
  return null;
}

export function readFieldValueFromHtml(html: string, selector: string, type: 'text' | 'image'): string {
  let matcher: ((el: Node) => boolean) | null = null;

  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    matcher = el => el.attribs?.id === id;
  } else {
    const dataFieldMatch = selector.match(/^\[data-field=["']([^"']+)["']\]$/);
    if (dataFieldMatch) {
      const value = dataFieldMatch[1];
      matcher = el => el.attribs?.['data-field'] === value;
    }
  }

  if (!matcher) return '';

  try {
    const dom = parseDocument(html);
    const el = findFirst(dom.children as Node[], matcher);
    if (!el) return '';
    return type === 'image' ? (el.attribs?.src ?? '') : textOf(el);
  } catch {
    return '';
  }
}

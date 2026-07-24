import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
// htmlparser2 + dom-serializer are CJS packages already installed as transitive deps
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseDocument } = require('htmlparser2') as typeof import('htmlparser2');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const render = require('dom-serializer').default as typeof import('dom-serializer').default;

interface Injection {
  generatedId: string;
  indexPath: string;   // e.g. "0/2/1" — child element indices from <html> root down
  tagName?: string;     // tag of the element the client actually picked — verified before injecting
  textSignature?: string; // full trimmed textContent (text fields) or src (image fields), captured
                           // client-side — primary match signal, since the browser's HTML5 parser
                           // and htmlparser2 can structure malformed HTML differently and disagree
                           // on child indices even on a fresh load
  fieldKey: string;
  label: string;
  type: 'text' | 'image';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walkByIndexPath(rootChildren: any[], indexPath: string): any | null {
  const indices = indexPath.split('/').map(Number);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let nodes: any[] = rootChildren;
  let target = null;
  for (const idx of indices) {
    const elements = nodes.filter((n: { type: string }) => n.type === 'tag');
    target = elements[idx] ?? null;
    if (!target) return null;
    nodes = target.children ?? [];
  }
  return target;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(el: any): string {
  let out = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(node: any) {
    if (node.type === 'text') out += node.data;
    else if (node.children) node.children.forEach(walk);
  }
  walk(el);
  return out.trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function srcOf(el: any): string {
  return el.attribs?.src ?? '';
}

// Depth-first index-path distance — used only to disambiguate multiple equally-good
// text/src matches, picking the one structurally closest to where the client picked.
function pathDistance(a: string, b: string): number {
  const ai = a.split('/').map(Number);
  const bi = b.split('/').map(Number);
  let d = 0;
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) d += Math.abs((ai[i] ?? -1) - (bi[i] ?? -1));
  return d;
}

// Collect every element in the tree matching tagName, with its own indexPath computed
// the same way the client does (child-tag-index sequence from the root down).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findAllByTag(rootChildren: any[], tagName: string): { el: any; indexPath: string }[] {
  const results: { el: any; indexPath: string }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(nodes: any[], prefix: number[]) {
    const elements = nodes.filter((n: { type: string }) => n.type === 'tag');
    elements.forEach((el, idx) => {
      const path = [...prefix, idx];
      if (el.name.toLowerCase() === tagName.toLowerCase()) {
        results.push({ el, indexPath: path.join('/') });
      }
      if (el.children) walk(el.children, path);
    });
  }
  walk(rootChildren, []);
  return results;
}

// Resolve an injection to the element it actually refers to. Prefers an exact
// text/src signature match (unique or nearest-by-position among duplicates) over
// the raw indexPath, since indexPath alone can point at the wrong element when the
// browser's HTML5 parser and htmlparser2 structure the same malformed HTML differently.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveInjection(startChildren: any[], inj: Injection): any | null {
  if (inj.tagName && inj.textSignature !== undefined && inj.textSignature !== '') {
    const candidates = findAllByTag(startChildren, inj.tagName);
    const matches = candidates.filter(c =>
      inj.type === 'image' ? srcOf(c.el) === inj.textSignature : textOf(c.el) === inj.textSignature
    );
    if (matches.length === 1) return matches[0].el;
    if (matches.length > 1) {
      matches.sort((a, b) => pathDistance(a.indexPath, inj.indexPath) - pathDistance(b.indexPath, inj.indexPath));
      return matches[0].el;
    }
  }
  return walkByIndexPath(startChildren, inj.indexPath);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_content, field_selectors_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!page.html_content) {
    return NextResponse.json({ error: 'Page has no HTML content to inject into' }, { status: 400 });
  }

  let injections: Injection[];
  try {
    const body = await request.json();
    injections = body.injections;
    if (!Array.isArray(injections) || injections.length === 0) throw new Error();
  } catch {
    return NextResponse.json({ error: 'injections must be a non-empty array' }, { status: 400 });
  }

  for (const inj of injections) {
    if (!/^sl-f-[a-z0-9]{1,12}$/.test(inj.generatedId)) {
      return NextResponse.json({ error: `Invalid generatedId: ${inj.generatedId}` }, { status: 400 });
    }
    if (!/^[\d/]+$/.test(inj.indexPath)) {
      return NextResponse.json({ error: `Invalid indexPath: ${inj.indexPath}` }, { status: 400 });
    }
  }

  const dom = parseDocument(page.html_content as string);

  // Picker walks up to (not including) <html>, so indexPath indices start from <html>'s children
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const htmlEl = (dom.children as any[]).find((n: any) => n.type === 'tag' && n.name === 'html');
  const startChildren = htmlEl ? htmlEl.children : dom.children;

  // Resolve every injection — preferring an exact text/src content match over the raw
  // indexPath (see resolveInjection) — and verify the resolved element's tag matches
  // what the client actually clicked before mutating anything.
  const resolved: { inj: Injection; el: ReturnType<typeof walkByIndexPath> }[] = [];
  for (const inj of injections) {
    const el = resolveInjection(startChildren, inj);
    if (el && inj.tagName && el.name.toLowerCase() !== inj.tagName.toLowerCase()) {
      return NextResponse.json({
        error: `Element mapping is out of sync with the page (expected <${inj.tagName.toLowerCase()}>, found <${el.name}>). Please re-pick "${inj.label}" and save again.`,
      }, { status: 409 });
    }
    resolved.push({ inj, el });
  }

  for (const { inj, el } of resolved) {
    if (el) {
      el.attribs = { ...el.attribs, id: inj.generatedId };
    }
  }

  const updatedHtml = render(dom, { decodeEntities: false });

  const existing = (page.field_selectors_json as Record<string, { selector: string; type: string; label: string }> | null) ?? {};
  const updated = { ...existing };
  for (const inj of injections) {
    updated[inj.fieldKey] = { selector: `#${inj.generatedId}`, type: inj.type, label: inj.label };
  }

  const { error } = await db
    .from('pages')
    .update({ html_content: updatedHtml, field_selectors_json: updated })
    .eq('id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

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

  for (const inj of injections) {
    const el = walkByIndexPath(startChildren, inj.indexPath);
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

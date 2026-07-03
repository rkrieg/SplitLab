import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

const KEY_RE = /^[a-z0-9_]{1,50}$/;
const ALLOWED_TYPES = ['text', 'image'] as const;

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, field_selectors_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return NextResponse.json({ field_selectors: page.field_selectors_json ?? {} });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: { field_selectors: Record<string, { selector: string; type: string; label: string }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { field_selectors } = body;
  if (!field_selectors || typeof field_selectors !== 'object' || Array.isArray(field_selectors)) {
    return NextResponse.json({ error: 'field_selectors must be an object' }, { status: 400 });
  }

  const sanitized: Record<string, { selector: string; type: 'text' | 'image'; label: string }> = {};
  for (const [key, val] of Object.entries(field_selectors)) {
    if (!KEY_RE.test(key)) continue;
    if (!val || typeof val !== 'object') continue;
    const selector = typeof val.selector === 'string' ? val.selector.trim() : '';
    const type = ALLOWED_TYPES.includes(val.type as 'text' | 'image') ? (val.type as 'text' | 'image') : 'text';
    const label = typeof val.label === 'string' ? val.label.trim().slice(0, 100) : key;
    if (!selector) continue;
    sanitized[key] = { selector, type, label };
  }

  const { error } = await db
    .from('pages')
    .update({ field_selectors_json: sanitized })
    .eq('id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ field_selectors: sanitized });
}

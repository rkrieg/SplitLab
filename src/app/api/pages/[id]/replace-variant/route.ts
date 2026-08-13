import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { replaceVariantLive } from '@/lib/services/pages';

// Promotes a variant page's draft (accumulated via AI chat / WYSIWYG edits)
// onto the live HTML a test is actually serving. This is the only place a
// variant page's live columns get touched by the AI editor — everything
// else writes to draft_* until the user explicitly confirms here.
// Extracted into replaceVariantLive() (src/lib/services/pages.ts) so this
// route and MCP's replace_variant tool share one implementation.
export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: page } = await db
    .from('pages')
    .select('workspace_id, html_url, draft_html_content, draft_schema_json')
    .eq('id', params.id)
    .single();

  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const wsRole = await resolveWorkspaceRole(page.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const result = await replaceVariantLive(params.id, page);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json(result.data);
}

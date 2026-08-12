import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { createPage } from '@/lib/services/pages';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const {
      workspace_id, name, vertical,
      prompt, schema_json, conversation_json,
      html_url, html_content, slug,
    } = await request.json();

    if (!workspace_id || !name || !vertical) {
      return NextResponse.json(
        { error: 'workspace_id, name, and vertical are required' },
        { status: 400 }
      );
    }

    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const result = await createPage({
      workspace_id, name, vertical, prompt, schema_json, conversation_json,
      html_url, html_content, slug, created_by: session.user.id,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.data, { status: 201 });
  } catch (err) {
    console.error('[POST /api/pages]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

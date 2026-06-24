import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { workspace_id, name, prompt, vertical, schema_json, conversation_json, html_url, html_content, slug, published_url } =
      await request.json();

    if (!workspace_id || !name || !prompt || !vertical || !schema_json || !html_url) {
      return NextResponse.json(
        { error: 'workspace_id, name, prompt, vertical, schema_json, and html_url are required' },
        { status: 400 }
      );
    }

    const wsRole = await resolveWorkspaceRole(workspace_id, session.user.id, session.user.role);
    if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { data, error } = await db
      .from('pages')
      .insert({
        workspace_id,
        name,
        slug: slug ?? crypto.randomUUID(),
        prompt,
        vertical,
        schema_json,
        conversation_json: conversation_json ?? [],
        html_url,
        html_content: typeof html_content === 'string' && html_content.length < 500_000 ? html_content : null,
        status: 'active',
        published_url: published_url ?? null,
        source_type: 'ai_generated',
        created_by: session.user.id,
        version: 1,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error('[POST /api/pages]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// GET /api/workspaces/[id]/integrations
// Returns all integrations for the workspace (tokens are redacted)
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await db
    .from('workspace_integrations')
    .select('id, type, enabled, created_at, updated_at')
    .eq('workspace_id', params.id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ integrations: data });
}

// POST /api/workspaces/[id]/integrations
// Body: { type: 'hubspot', access_token: string }
// Creates or updates the integration for this workspace+type
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { type?: string; access_token?: string };
  const { type, access_token } = body;

  if (!type || !access_token) {
    return NextResponse.json({ error: 'Missing type or access_token' }, { status: 400 });
  }

  const { data, error } = await db
    .from('workspace_integrations')
    .upsert(
      {
        workspace_id: params.id,
        type,
        config: { access_token },
        enabled: true,
      },
      { onConflict: 'workspace_id,type' }
    )
    .select('id, type, enabled, created_at, updated_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ integration: data });
}

// DELETE /api/workspaces/[id]/integrations?type=hubspot
// Removes the integration and all associated variant mappings (cascade)
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const type = req.nextUrl.searchParams.get('type');
  if (!type) return NextResponse.json({ error: 'Missing type' }, { status: 400 });

  const { error } = await db
    .from('workspace_integrations')
    .delete()
    .eq('workspace_id', params.id)
    .eq('type', type);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

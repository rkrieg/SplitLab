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
// Body: { type: string; config?: Record<string,unknown> }
// For 'hubspot': OAuth handled separately — this is a general upsert endpoint.
// For 'email': config is empty (Resend API key is in env); enabled flag stored here.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json() as { type?: string; config?: Record<string, unknown> };
  const { type, config } = body;

  if (!type) {
    return NextResponse.json({ error: 'Missing type' }, { status: 400 });
  }

  const { data, error } = await db
    .from('workspace_integrations')
    .upsert(
      {
        workspace_id: params.id,
        type,
        config: config ?? {},
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

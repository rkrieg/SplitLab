import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

// GET /api/workspaces/[id]/integrations
// Returns all integrations for the workspace (tokens are redacted)
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wsRole = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await db
    .from('workspace_integrations')
    .select('id, type, enabled, config, created_at, updated_at')
    .eq('workspace_id', params.id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ integrations: data });
}

// POST /api/workspaces/[id]/integrations
// Body: { type: string; config?: Record<string,unknown> }
// For 'hubspot': OAuth handled separately.
// For 'email': config is empty (Resend API key is in env).
// For 'webhook': config = { url, format, headers[] }. Multiple webhooks allowed — always INSERT.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wsRole = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json() as { type?: string; config?: Record<string, unknown> };
  const { type, config } = body;

  if (!type) {
    return NextResponse.json({ error: 'Missing type' }, { status: 400 });
  }

  // Webhooks allow multiple rows per workspace — always INSERT
  if (type === 'webhook') {
    const { data, error } = await db
      .from('workspace_integrations')
      .insert({ workspace_id: params.id, type, config: config ?? {}, enabled: true })
      .select('id, type, enabled, created_at, updated_at')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ integration: data });
  }

  // All other types: one per workspace per type — SELECT then INSERT or UPDATE
  const { data: existing } = await db
    .from('workspace_integrations')
    .select('id')
    .eq('workspace_id', params.id)
    .eq('type', type)
    .single();

  if (existing) {
    const { data, error } = await db
      .from('workspace_integrations')
      .update({ config: config ?? {}, enabled: true })
      .eq('id', existing.id)
      .select('id, type, enabled, created_at, updated_at')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ integration: data });
  }

  const { data, error } = await db
    .from('workspace_integrations')
    .insert({ workspace_id: params.id, type, config: config ?? {}, enabled: true })
    .select('id, type, enabled, created_at, updated_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ integration: data });
}

// DELETE /api/workspaces/[id]/integrations
// ?type=hubspot|email  — deletes by workspace+type (single integrations)
// ?integrationId=uuid  — deletes by ID (for webhooks, which have multiple rows)
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wsRole = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const integrationId = req.nextUrl.searchParams.get('integrationId');
  const type = req.nextUrl.searchParams.get('type');

  if (integrationId) {
    const { error } = await db
      .from('workspace_integrations')
      .delete()
      .eq('id', integrationId)
      .eq('workspace_id', params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (type) {
    // Preserve the row so child test_integration_mappings keep their foreign key reference.
    // For OAuth integrations (hubspot), also wipe the stored tokens.
    const updateData: Record<string, unknown> = { enabled: false };
    if (type === 'hubspot') {
      updateData.config = { access_token: null, refresh_token: null, expires_at: null, hub_id: null };
    }
    const { error } = await db
      .from('workspace_integrations')
      .update(updateData)
      .eq('workspace_id', params.id)
      .eq('type', type);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Missing type or integrationId' }, { status: 400 });
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

// GET /api/tests/[id]/integrations
// Returns the test's integration mapping for all connected workspace integrations
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await db
    .from('test_integration_mappings')
    .select(`
      id,
      enabled,
      field_mappings,
      last_synced_at,
      total_synced,
      total_failed,
      updated_at,
      workspace_integrations ( id, type, enabled )
    `)
    .eq('test_id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ mappings: data });
}

// POST /api/tests/[id]/integrations
// Body: { workspace_integration_id, enabled, field_mappings }
// Creates or updates the mapping for this test + integration
export async function POST(req: NextRequest, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json() as {
    workspace_integration_id?: string;
    enabled?: boolean;
    field_mappings?: Record<string, string>;
  };

  const { workspace_integration_id, enabled, field_mappings } = body;

  if (!workspace_integration_id) {
    return NextResponse.json({ error: 'Missing workspace_integration_id' }, { status: 400 });
  }

  const { data, error } = await db
    .from('test_integration_mappings')
    .upsert(
      {
        test_id: params.id,
        workspace_integration_id,
        enabled: enabled ?? false,
        field_mappings: field_mappings ?? {},
      },
      { onConflict: 'test_id,workspace_integration_id' }
    )
    .select('id, enabled, field_mappings, last_synced_at, total_synced, total_failed, updated_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ mapping: data });
}

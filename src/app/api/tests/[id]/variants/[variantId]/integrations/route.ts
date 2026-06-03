import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string; variantId: string } };

// GET /api/tests/[id]/variants/[variantId]/integrations
// Returns the variant's integration mapping for each connected workspace integration
export async function GET(_req: NextRequest, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await db
    .from('variant_integration_mappings')
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
    .eq('variant_id', params.variantId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ mappings: data });
}

// POST /api/tests/[id]/variants/[variantId]/integrations
// Body: { workspace_integration_id, enabled, field_mappings }
// Creates or updates the mapping for this variant + integration
export async function POST(req: NextRequest, { params }: Params) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    .from('variant_integration_mappings')
    .upsert(
      {
        variant_id: params.variantId,
        workspace_integration_id,
        enabled: enabled ?? false,
        field_mappings: field_mappings ?? {},
      },
      { onConflict: 'variant_id,workspace_integration_id' }
    )
    .select('id, enabled, field_mappings, last_synced_at, total_synced, total_failed, updated_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ mapping: data });
}

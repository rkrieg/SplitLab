import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole, resolveTestWorkspaceRole } from '@/lib/workspace-auth';
import { updateTest, deleteTest, fullTestSelect } from '@/lib/services/tests';
import { z } from 'zod';

const goalSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['form_submit', 'button_click', 'url_reached', 'call_click']),
  selector: z.string().max(500).nullable().optional(),
  url_pattern: z.string().max(500).nullable().optional(),
  is_primary: z.boolean(),
  variant_id: z.string().uuid().nullable().optional(),
});

const weightSchema = z.object({
  id: z.string().uuid(),
  traffic_weight: z.number().int().min(0).max(100),
});

const variantUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  redirect_url: z.string().url().nullable().optional(),
  proxy_mode: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url_path: z.string().min(1).max(500).optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed']).optional(),
  head_scripts: z.string().nullable().optional(),
  forward_url_params: z.boolean().optional(),
  goals: z.array(goalSchema).optional(),
  weights: z.array(weightSchema).optional(),
  remaining_weights: z.array(weightSchema).optional(),
  variant_updates: z.array(variantUpdateSchema).optional(),
  delete_variant_id: z.string().uuid().optional(),
  archive_variant_id: z.string().uuid().optional(),
  unarchive_variant_id: z.string().uuid().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Ownership check — verify the test's workspace belongs to the requesting
  // user before returning it, same as PATCH/DELETE below. Previously any
  // authenticated user could read any test by UUID; low risk while only the
  // dashboard called this, but MCP tools call routes like this
  // programmatically, so unguessability alone is no longer enough.
  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { data, error } = await db
    .from('tests')
    .select(fullTestSelect())
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: testMeta } = await db.from('tests').select('workspace_id, url_path, status').eq('id', params.id).single();
  if (!testMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const wsRole = await resolveWorkspaceRole(testMeta.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const body = await request.json();
    const input = updateSchema.parse(body);

    const result = await updateTest(params.id, testMeta, input);
    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.limitError ? { limitError: true } : {}) }, { status: result.status });
    return NextResponse.json(result.data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: testMeta } = await db.from('tests').select('workspace_id').eq('id', params.id).single();
  if (!testMeta) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const wsRole = await resolveWorkspaceRole(testMeta.workspace_id, session.user.id, session.user.role);
  if (!wsRole || wsRole === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const result = await deleteTest(params.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.data);
}

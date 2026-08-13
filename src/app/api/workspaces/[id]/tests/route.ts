import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { createTest } from '@/lib/services/tests';
import { z } from 'zod';

const variantSchema = z.object({
  name: z.string().min(1),
  page_id: z.string().uuid().nullable().optional(),
  redirect_url: z.string().url().nullable().optional(),
  proxy_mode: z.boolean().optional(),
  traffic_weight: z.number().int().min(1).max(100),
  is_control: z.boolean().optional(),
});

const goalSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['form_submit', 'button_click', 'url_reached', 'call_click']),
  selector: z.string().nullable().optional(),
  url_pattern: z.string().nullable().optional(),
  is_primary: z.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(255),
  url_path: z.string().min(1).max(500),
  status: z.enum(['draft', 'active']).optional(),
  variants: z.array(variantSchema).min(1).max(5),
  goals: z.array(goalSchema).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await resolveWorkspaceRole(params.id, session.user.id, session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { data, error } = await db
    .from('tests')
    .select(`
      *,
      test_variants ( *, pages ( id, name ) ),
      conversion_goals (*)
    `)
    .eq('workspace_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const wsRole = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!wsRole || wsRole !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const data = createSchema.parse(body);

    const result = await createTest(
      { workspace_id: params.id, name: data.name, url_path: data.url_path, status: data.status, variants: data.variants, goals: data.goals },
      session.user.id,
      session.user.role
    );

    if (!result.ok) return NextResponse.json({ error: result.error, ...(result.limitError ? { limitError: true } : {}) }, { status: result.status });
    return NextResponse.json(result.data, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

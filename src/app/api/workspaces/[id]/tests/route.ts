import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { PLAN_LIMITS } from '@/lib/plans';
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

    // Enforce plan limits (admins bypass).
    // Use workspace owner's plan — invited managers have plan:'free' on their own row.
    if (session.user.role !== 'admin') {
      const { data: wsData } = await db.from('workspaces').select('client_id').eq('id', params.id).single();
      let planOwnerId = session.user.id;
      if (wsData) {
        const { data: clientData } = await db.from('clients').select('owner_id').eq('id', wsData.client_id).single();
        if (clientData?.owner_id) planOwnerId = clientData.owner_id;
      }

      const { data: userRow } = await db.from('users').select('plan').eq('id', planOwnerId).single();
      const plan = userRow?.plan ?? 'free';

      // 1. Enforce test count limit (counted across all workspaces owned by the plan owner)
      const testLimit = PLAN_LIMITS[plan]?.tests ?? 1;
      if (isFinite(testLimit)) {
        const { count: testCount } = await db
          .from('tests')
          .select('id, workspaces!inner(client_id, clients!inner(owner_id))', { count: 'exact', head: true })
          .eq('workspaces.clients.owner_id', planOwnerId)
          .not('status', 'eq', 'completed');

        if ((testCount ?? 0) >= testLimit) {
          return NextResponse.json(
            { error: `You have reached the test limit for your plan (${testLimit}). Please upgrade to create more tests.`, limitError: true },
            { status: 403 }
          );
        }
      }

      // 2. Enforce variant count limit for this test's initial variants
      const variantLimit = PLAN_LIMITS[plan]?.variants ?? 2;
      if (isFinite(variantLimit) && data.variants.length > variantLimit) {
        return NextResponse.json(
          { error: `Your plan allows a maximum of ${variantLimit} variants per test. Please upgrade for unlimited variants.`, limitError: true },
          { status: 403 }
        );
      }
    }

    const totalWeight = data.variants.reduce((s, v) => s + v.traffic_weight, 0);
    if (totalWeight !== 100) {
      return NextResponse.json(
        { error: 'Variant traffic weights must sum to 100' },
        { status: 400 }
      );
    }

    // Block duplicate active url_path within the same workspace
    const { data: pathConflict } = await db
      .from('tests')
      .select('name')
      .eq('workspace_id', params.id)
      .eq('url_path', data.url_path)
      .eq('status', 'active')
      .limit(1)
      .single();

    if (pathConflict) {
      return NextResponse.json(
        { error: `Another active test "${pathConflict.name}" is already running on path "${data.url_path}". Pause it before creating a new test on the same path.` },
        { status: 409 }
      );
    }

    const { data: test, error: testError } = await db
      .from('tests')
      .insert({ workspace_id: params.id, name: data.name, url_path: data.url_path, status: data.status ?? 'active' })
      .select()
      .single();

    if (testError) return NextResponse.json({ error: testError.message }, { status: 500 });

    const variantRows = data.variants.map((v, i) => ({
      test_id: test.id,
      name: v.name,
      page_id: v.page_id || null,
      redirect_url: v.redirect_url || null,
      proxy_mode: v.proxy_mode ?? true,
      traffic_weight: v.traffic_weight,
      is_control: i === 0 || v.is_control || false,
    }));

    const { error: varError } = await db.from('test_variants').insert(variantRows);
    if (varError) return NextResponse.json({ error: varError.message }, { status: 500 });

    if (data.goals && data.goals.length > 0) {
      const goalRows = data.goals.map((g) => ({
        test_id: test.id,
        name: g.name,
        type: g.type,
        selector: g.selector || null,
        url_pattern: g.url_pattern || null,
        is_primary: g.is_primary || false,
      }));
      await db.from('conversion_goals').insert(goalRows);
    }

    const { data: fullTest } = await db
      .from('tests')
      .select('*, test_variants(*), conversion_goals(*)')
      .eq('id', test.id)
      .single();

    return NextResponse.json(fullTest, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
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
  variants: z.array(variantSchema).min(2).max(5),
  goals: z.array(goalSchema).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  try {
    const body = await request.json();
    const data = createSchema.parse(body);

    // Validate weights sum to 100
    const totalWeight = data.variants.reduce((s, v) => s + v.traffic_weight, 0);
    if (totalWeight !== 100) {
      return NextResponse.json(
        { error: 'Variant traffic weights must sum to 100' },
        { status: 400 }
      );
    }

    // Create test
    const { data: test, error: testError } = await db
      .from('tests')
      .insert({ workspace_id: params.id, name: data.name, url_path: data.url_path })
      .select()
      .single();

    if (testError) return NextResponse.json({ error: testError.message }, { status: 500 });

    // Create variants
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

    // Create goals
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

    // Return full test with relations
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

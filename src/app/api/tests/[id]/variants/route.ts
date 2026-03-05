import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

const addVariantSchema = z.object({
  name: z.string().min(1),
  redirect_url: z.string().url().nullable().optional(),
  proxy_mode: z.boolean().optional(),
  traffic_weight: z.number().int().min(1).max(100),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin' && session.user.role !== 'manager') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const data = addVariantSchema.parse(body);

    // Verify test exists
    const { data: test, error: testErr } = await db
      .from('tests')
      .select('id')
      .eq('id', params.id)
      .single();
    if (testErr || !test) {
      return NextResponse.json({ error: 'Test not found' }, { status: 404 });
    }

    // Create variant
    const { error: varErr } = await db.from('test_variants').insert({
      test_id: params.id,
      name: data.name,
      redirect_url: data.redirect_url || null,
      proxy_mode: data.proxy_mode ?? true,
      traffic_weight: data.traffic_weight,
      is_control: false,
    });

    if (varErr) return NextResponse.json({ error: varErr.message }, { status: 500 });

    // Return full test with all variants
    const { data: fullTest } = await db
      .from('tests')
      .select('*, test_variants(*), conversion_goals(*)')
      .eq('id', params.id)
      .single();

    return NextResponse.json(fullTest, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

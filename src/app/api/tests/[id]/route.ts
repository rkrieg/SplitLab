import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

const goalSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['form_submit', 'button_click', 'url_reached', 'call_click']),
  selector: z.string().max(500).nullable().optional(),
  url_pattern: z.string().max(500).nullable().optional(),
  is_primary: z.boolean(),
});

const weightSchema = z.object({
  id: z.string().uuid(),
  traffic_weight: z.number().int().min(0).max(100),
});

const variantUpdateSchema = z.object({
  id: z.string().uuid(),
  proxy_mode: z.boolean(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url_path: z.string().min(1).max(500).optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed']).optional(),
  goals: z.array(goalSchema).optional(),
  weights: z.array(weightSchema).optional(),
  variant_updates: z.array(variantUpdateSchema).optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name, html_url)), conversion_goals(*)')
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

  try {
    const body = await request.json();
    const { goals, weights, variant_updates, ...testFields } = updateSchema.parse(body);

    // Update test fields if any provided
    if (Object.keys(testFields).length > 0) {
      const { error } = await db
        .from('tests')
        .update(testFields)
        .eq('id', params.id);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Update variant weights if provided
    if (weights) {
      const totalWeight = weights.reduce((s, w) => s + w.traffic_weight, 0);
      if (totalWeight !== 100) {
        return NextResponse.json({ error: 'Weights must sum to 100' }, { status: 400 });
      }
      for (const w of weights) {
        const { error: wErr } = await db
          .from('test_variants')
          .update({ traffic_weight: w.traffic_weight })
          .eq('id', w.id)
          .eq('test_id', params.id);
        if (wErr) return NextResponse.json({ error: wErr.message }, { status: 500 });
      }
    }

    // Update variant fields (e.g. proxy_mode) if provided
    if (variant_updates) {
      for (const vu of variant_updates) {
        const { error: vuErr } = await db
          .from('test_variants')
          .update({ proxy_mode: vu.proxy_mode })
          .eq('id', vu.id)
          .eq('test_id', params.id);
        if (vuErr) return NextResponse.json({ error: vuErr.message }, { status: 500 });
      }
    }

    // Replace goals if provided
    if (goals) {
      // Delete existing goals
      await db.from('conversion_goals').delete().eq('test_id', params.id);

      // Insert new goals
      if (goals.length > 0) {
        const { error: goalsError } = await db
          .from('conversion_goals')
          .insert(goals.map((g) => ({
            test_id: params.id,
            name: g.name,
            type: g.type,
            selector: g.selector || null,
            url_pattern: g.url_pattern || null,
            is_primary: g.is_primary,
          })));

        if (goalsError) return NextResponse.json({ error: goalsError.message }, { status: 500 });
      }
    }

    // Return full test with relations
    const { data: updated, error: fetchError } = await db
      .from('tests')
      .select('*, test_variants(*, pages(id, name)), conversion_goals(*)')
      .eq('id', params.id)
      .single();

    if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
    return NextResponse.json(updated);
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
  if (session.user.role === 'viewer') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await db.from('tests').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

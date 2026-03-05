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
  name: z.string().min(1).max(255).optional(),
  redirect_url: z.string().url().nullable().optional(),
  proxy_mode: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url_path: z.string().min(1).max(500).optional(),
  status: z.enum(['draft', 'active', 'paused', 'completed']).optional(),
  goals: z.array(goalSchema).optional(),
  weights: z.array(weightSchema).optional(),
  variant_updates: z.array(variantUpdateSchema).optional(),
  delete_variant_id: z.string().uuid().optional(),
});

function fullTestSelect() {
  return '*, test_variants(*, pages(id, name)), conversion_goals(*)';
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  try {
    const body = await request.json();
    const { goals, weights, variant_updates, delete_variant_id, ...testFields } = updateSchema.parse(body);

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

    // Update variant fields (name, redirect_url, proxy_mode) if provided
    if (variant_updates) {
      for (const vu of variant_updates) {
        const updateFields: Record<string, unknown> = {};
        if (vu.name !== undefined) updateFields.name = vu.name;
        if (vu.redirect_url !== undefined) updateFields.redirect_url = vu.redirect_url;
        if (vu.proxy_mode !== undefined) updateFields.proxy_mode = vu.proxy_mode;
        if (Object.keys(updateFields).length > 0) {
          const { error: vuErr } = await db
            .from('test_variants')
            .update(updateFields)
            .eq('id', vu.id)
            .eq('test_id', params.id);
          if (vuErr) return NextResponse.json({ error: vuErr.message }, { status: 500 });
        }
      }
    }

    // Delete variant if requested
    if (delete_variant_id) {
      const { error: delErr } = await db
        .from('test_variants')
        .delete()
        .eq('id', delete_variant_id)
        .eq('test_id', params.id);
      if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    }

    // Replace goals if provided
    if (goals) {
      await db.from('conversion_goals').delete().eq('test_id', params.id);
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
      .select(fullTestSelect())
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

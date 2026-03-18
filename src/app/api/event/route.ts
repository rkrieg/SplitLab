import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

const schema = z.object({
  testId: z.string().uuid(),
  variantId: z.string().uuid(),
  goalId: z.string().uuid().nullable().optional(),
  visitorHash: z.string().min(1).max(64),
  type: z.enum(['pageview', 'conversion']),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export async function POST(request: NextRequest) {
  const headers = corsHeaders(request);
  try {
    const body = await request.json();
    const data = schema.parse(body);

    // Deduplicate pageviews: one pageview per visitor per test per day
    if (data.type === 'pageview') {
      const today = new Date().toISOString().slice(0, 10);
      const { data: existing } = await db
        .from('events')
        .select('id')
        .eq('test_id', data.testId)
        .eq('variant_id', data.variantId)
        .eq('visitor_hash', data.visitorHash)
        .eq('type', 'pageview')
        .gte('created_at', `${today}T00:00:00Z`)
        .limit(1)
        .single();

      if (existing) {
        return NextResponse.json({ ok: true, duplicate: true }, { headers });
      }
    }

    // Auto-match goal_id from metadata.trigger when not explicitly provided
    let goalId = data.goalId || null;
    if (data.type === 'conversion' && !goalId && data.metadata?.trigger) {
      const { data: goals } = await db
        .from('conversion_goals')
        .select('id, type')
        .eq('test_id', data.testId)
        .eq('type', data.metadata.trigger as string);

      if (goals && goals.length > 0) {
        goalId = goals[0].id;
      }
    }

    const { error } = await db.from('events').insert({
      test_id: data.testId,
      variant_id: data.variantId,
      goal_id: goalId,
      visitor_hash: data.visitorHash,
      type: data.type,
      metadata: data.metadata || {},
    });

    if (error) throw error;

    // Aggregate AI page performance data
    if (data.type === 'pageview' || data.type === 'conversion') {
      try {
        const { data: variant } = await db
          .from('test_variants')
          .select('page_id')
          .eq('id', data.variantId)
          .single();

        if (variant?.page_id) {
          const { data: page } = await db
            .from('pages')
            .select('id, vertical, source_type')
            .eq('id', variant.page_id)
            .eq('source_type', 'ai_generated')
            .single();

          if (page) {
            const { data: existing } = await db
              .from('page_performance')
              .select('id, total_views, total_conversions')
              .eq('page_id', page.id)
              .order('recorded_at', { ascending: false })
              .limit(1)
              .single();

            if (existing) {
              const updates: Record<string, unknown> = {};
              if (data.type === 'pageview') {
                updates.total_views = existing.total_views + 1;
              } else {
                updates.total_conversions = existing.total_conversions + 1;
              }
              const views = data.type === 'pageview' ? existing.total_views + 1 : existing.total_views;
              const convs = data.type === 'conversion' ? existing.total_conversions + 1 : existing.total_conversions;
              updates.conversion_rate = views > 0 ? convs / views : 0;

              await db.from('page_performance').update(updates).eq('id', existing.id);
            } else {
              await db.from('page_performance').insert({
                page_id: page.id,
                vertical: page.vertical,
                total_views: data.type === 'pageview' ? 1 : 0,
                total_conversions: data.type === 'conversion' ? 1 : 0,
                conversion_rate: 0,
              });
            }
          }
        }
      } catch (perfErr) {
        console.error('[event] page_performance error:', perfErr);
      }
    }

    return NextResponse.json({ ok: true }, { headers });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400, headers });
    }
    console.error('[event]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers });
  }
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { headers: corsHeaders(request) });
}

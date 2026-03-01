import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const schema = z.object({
  testId: z.string().uuid(),
  variantId: z.string().uuid(),
  goalId: z.string().uuid().nullable().optional(),
  visitorHash: z.string().min(1).max(64),
  type: z.enum(['pageview', 'conversion']),
  metadata: z.record(z.unknown()).optional(),
});

export async function POST(request: NextRequest) {
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
        return NextResponse.json({ ok: true, duplicate: true }, { headers: CORS_HEADERS });
      }
    }

    const { error } = await db.from('events').insert({
      test_id: data.testId,
      variant_id: data.variantId,
      goal_id: data.goalId || null,
      visitor_hash: data.visitorHash,
      type: data.type,
      metadata: data.metadata || {},
    });

    if (error) throw error;

    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400, headers: CORS_HEADERS });
    }
    console.error('[event]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: CORS_HEADERS });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS_HEADERS });
}

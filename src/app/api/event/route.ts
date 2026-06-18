import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { getPlanDetails } from '@/lib/plans';
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

      // Visitor cap enforcement — only for brand new visitor hashes (returning visitors pass freely)
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);

      const { data: wsRow } = await db
        .from('tests')
        .select('workspaces!inner(client_id, clients!inner(owner_id))')
        .eq('id', data.testId)
        .single();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientsData = (wsRow as any)?.workspaces?.clients;
      const ownerId: string | undefined = Array.isArray(clientsData) ? clientsData[0]?.owner_id : clientsData?.owner_id;

      if (ownerId) {
        const { data: ownerRow } = await db.from('users').select('plan, role').eq('id', ownerId).single();
        if (ownerRow?.role !== 'admin') {
          const planDetails = getPlanDetails(ownerRow?.plan ?? 'free');
          if (isFinite(planDetails.monthlyVisitors)) {
            // Check if this visitor hash is already counted this month (returning visitor across any test)
            const { data: existingVisitor } = await db
              .from('events')
              .select('id')
              .eq('visitor_hash', data.visitorHash)
              .eq('type', 'pageview')
              .gte('created_at', monthStart.toISOString())
              .limit(1)
              .single();

            if (!existingVisitor) {
              // Brand new visitor — check if cap is already hit
              const { data: ownerTests } = await db
                .from('tests')
                .select('id, workspaces!inner(client_id, clients!inner(owner_id))')
                .eq('workspaces.clients.owner_id', ownerId);
              const ownerTestIds = Array.from(new Set([data.testId, ...(ownerTests ?? []).map((t: { id: string }) => t.id)]));
              const { data: visitorRows } = await db
                .from('events')
                .select('visitor_hash')
                .eq('type', 'pageview')
                .in('test_id', ownerTestIds)
                .gte('created_at', monthStart.toISOString());
              const uniqueCount = new Set((visitorRows ?? []).map((r: { visitor_hash: string }) => r.visitor_hash)).size;
              if (uniqueCount >= planDetails.monthlyVisitors) {
                return NextResponse.json({ ok: true, capped: true }, { headers });
              }
            }
          }
        }
      }
    }

    // Auto-match goal_id from metadata.trigger + selector when not explicitly provided
    let goalId = data.goalId || null;
    if (data.type === 'conversion' && !goalId && data.metadata?.trigger) {
      const { data: goals } = await db
        .from('conversion_goals')
        .select('id, type, selector, variant_id')
        .eq('test_id', data.testId)
        .eq('type', data.metadata.trigger as string)
        .or(`variant_id.is.null,variant_id.eq.${data.variantId}`);

      if (goals && goals.length > 0) {
        const metaId = (data.metadata?.id ?? null) as string | null;
        const metaText = (data.metadata?.text ?? null) as string | null;

        const matched = goals.find(g => {
          if (!g.selector) return true; // no selector — match all of that type

          if (g.selector.startsWith('id:')) {
            // ID-based: only match when event carries the same id
            return metaId === g.selector.slice(3);
          }

          if (g.selector.startsWith('text:')) {
            // Text-based: only match elements that have NO id
            if (metaId !== null) return false;
            return metaText === g.selector.slice(5);
          }

          // Legacy CSS ID selector (#hero-cta) — extract and match by id
          if (g.selector.startsWith('#')) {
            return metaId === g.selector.slice(1);
          }

          // Other legacy CSS selectors — can't match via tracker.js metadata; skip
          return false;
        });

        if (matched) goalId = matched.id;
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

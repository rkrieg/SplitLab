import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';
import { getWorkspaceOwner, incrementVisitorCount, maybeSendVisitorWarning, getUserPlan } from '@/lib/planLimits';
import { getPlan } from '@/lib/plans';
import { fireWebhooks } from '@/lib/webhooks';

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
    let isNewUniqueVisitor = false;
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
      isNewUniqueVisitor = true;
    }

    // Auto-match goal_id from metadata.trigger when not explicitly provided
    let goalId = data.goalId || null;
    if (data.type === 'conversion' && !goalId && data.metadata?.trigger) {
      const { data: goals } = await (db
        .from('conversion_goals')
        .select('id, type')
        .eq('test_id', data.testId)
        .eq('type', data.metadata.trigger as string) as unknown as Promise<{ data: { id: string; type: string }[] | null }>);

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

    // Update monthly visitor usage count for new unique visitors
    if (isNewUniqueVisitor) {
      try {
        const { data: testRow } = await (db
          .from('tests')
          .select('workspace_id')
          .eq('id', data.testId)
          .single() as unknown as Promise<{ data: { workspace_id: string } | null }>);

        if (testRow?.workspace_id) {
          const userId = await getWorkspaceOwner(testRow.workspace_id);
          if (userId) {
            const planId = await getUserPlan(userId);
            const limits = getPlan(planId);
            if (limits.monthlyVisitors !== Infinity) {
              const newCount = await incrementVisitorCount(userId);
              maybeSendVisitorWarning(userId, newCount, limits.monthlyVisitors, '').catch(() => {});
            }
          }
        }
      } catch (visitorErr) {
        console.error('[event] visitor tracking error:', visitorErr);
      }
    }

    // Aggregate AI page performance data
    if (data.type === 'pageview' || data.type === 'conversion') {
      try {
        const { data: variant } = await (db
          .from('test_variants')
          .select('page_id')
          .eq('id', data.variantId)
          .single() as unknown as Promise<{ data: { page_id: string | null } | null }>);

        if (variant?.page_id) {
          const { data: page } = await (db
            .from('pages')
            .select('id, vertical, source_type')
            .eq('id', variant.page_id)
            .eq('source_type', 'ai_generated')
            .single() as unknown as Promise<{ data: { id: string; vertical: string; source_type: string } | null }>);

          if (page) {
            const { data: existing } = await (db
              .from('page_performance')
              .select('id, total_views, total_conversions')
              .eq('page_id', page.id)
              .order('recorded_at', { ascending: false })
              .limit(1)
              .single() as unknown as Promise<{ data: { id: string; total_views: number; total_conversions: number } | null }>);

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

    // Fire webhooks for conversion events (non-blocking)
    if (data.type === 'conversion') {
      Promise.resolve().then(async () => {
        try {
          const { data: testRow } = await (db
            .from('tests')
            .select('id, name, url_path, workspace_id')
            .eq('id', data.testId)
            .single() as unknown as Promise<{ data: { id: string; name: string; url_path: string; workspace_id: string } | null }>);

          if (!testRow?.workspace_id) return;

          const { data: variant } = await (db
            .from('test_variants')
            .select('id, name')
            .eq('id', data.variantId)
            .single() as unknown as Promise<{ data: { id: string; name: string } | null }>);

          let goalName: string | null = null;
          let goalType: string | null = null;
          let isPrimary = false;
          if (goalId) {
            const { data: goal } = await (db
              .from('conversion_goals')
              .select('id, name, type, is_primary')
              .eq('id', goalId)
              .single() as unknown as Promise<{ data: { id: string; name: string; type: string; is_primary: boolean } | null }>);
            if (goal) {
              goalName = goal.name;
              goalType = goal.type;
              isPrimary = goal.is_primary;
            }
          }

          await fireWebhooks(testRow.workspace_id, 'conversion', {
            test_id: testRow.id,
            test_name: testRow.name,
            test_url: testRow.url_path,
            variant_id: data.variantId,
            variant_name: variant?.name ?? null,
            goal_id: goalId,
            goal_name: goalName,
            goal_type: goalType,
            is_primary_goal: isPrimary,
            visitor_hash: data.visitorHash,
            metadata: data.metadata || {},
          });
        } catch (whErr) {
          console.error('[event] webhook error:', whErr);
        }
      });
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

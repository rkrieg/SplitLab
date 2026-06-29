import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { confidencePercent, findWinner } from '@/lib/stats';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const access = await resolveTestWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.role || access.role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  // Fetch test with variants and primary goal
  const { data: test, error: testError } = await db
    .from('tests')
    .select('*, test_variants(*, pages(id, name)), conversion_goals(*)')
    .eq('id', params.id)
    .single();

  if (testError) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const variants = test.test_variants || [];

  // primaryGoal kept for backwards compatibility but no longer used for counting
  const primaryGoal = (test.conversion_goals || []).find(
    (g: { is_primary: boolean }) => g.is_primary
  ) || (test.conversion_goals || [])[0] || null;

  // All goal IDs for this test — any hit counts as a conversion
  const goalIds = new Set((test.conversion_goals || []).map((g: { id: string }) => g.id));

  // Build date filter
  let dateFilter = db
    .from('events')
    .select('variant_id, type, goal_id, visitor_hash')
    .eq('test_id', params.id);

  if (from) dateFilter = dateFilter.gte('created_at', `${from}T00:00:00Z`);
  if (to) dateFilter = dateFilter.lte('created_at', `${to}T23:59:59Z`);

  const { data: events } = await dateFilter;

  // Aggregate per variant
  const variantStats = variants.map((variant: { id: string; name: string; is_control: boolean; traffic_weight: number; pages?: { id: string; name: string } | null }) => {
    const varEvents = (events || []).filter(
      (e: { variant_id: string; type: string; goal_id: string | null }) => e.variant_id === variant.id
    );
    const views = varEvents.filter((e: { type: string }) => e.type === 'pageview').length;

    const goalEvents = varEvents.filter(
      (e: { type: string; goal_id: string | null }) =>
        e.type === 'conversion' && e.goal_id !== null && (goalIds.size === 0 || goalIds.has(e.goal_id))
    );

    // Unique converting visitors (one visitor counts once regardless of goals hit)
    const conversions = new Set(
      goalEvents.map((e: { visitor_hash: string }) => e.visitor_hash)
    ).size;

    // Total raw goal events (for Goal Hits column)
    const goalHits = goalEvents.length;

    const cvr = views > 0 ? conversions / views : 0;

    return {
      variant,
      views,
      conversions,
      goalHits,
      cvr,
      confidence: null as number | null,
      isWinner: false,
    };
  });

  // Compute confidence vs control
  const control = variantStats.find((v: { variant: { is_control: boolean } }) => v.variant.is_control) || variantStats[0];
  for (const stat of variantStats) {
    if (stat.variant.id === control.variant.id) continue;
    stat.confidence = confidencePercent(
      control.views,
      control.conversions,
      stat.views,
      stat.conversions
    );
  }

  // Mark winner
  const winnerId = findWinner(
    variantStats.map((s: { variant: { id: string }; views: number; conversions: number }) => ({
      id: s.variant.id,
      views: s.views,
      conversions: s.conversions,
    }))
  );
  for (const stat of variantStats) {
    stat.isWinner = stat.variant.id === winnerId;
  }

  const totalViews = variantStats.reduce((s: number, v: { views: number }) => s + v.views, 0);
  const totalConversions = variantStats.reduce((s: number, v: { conversions: number }) => s + v.conversions, 0);

  return NextResponse.json({
    test,
    primaryGoal,
    variantStats,
    totalViews,
    totalConversions,
  });
}

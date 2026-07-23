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

  // Server-side aggregation (Postgres RPC) — avoids fetching raw event rows
  // into JS, which used to hit Supabase's default 1,000-row PostgREST cap
  // and silently truncate/randomize results on tests with >1,000 events.
  const { data: rpcStats, error: rpcError } = await db.rpc('test_variant_stats', {
    p_test_id: params.id,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  // Desktop/mobile CVR split — device_type is only populated on events recorded
  // after this shipped, so older events (device_type null) are excluded by the
  // RPC rather than lumped into either bucket. A separate RPC/query since
  // test_variant_stats can't gain a column without a drop (see migration 040).
  const { data: rpcDeviceStats, error: rpcDeviceError } = await db.rpc('test_variant_device_stats', {
    p_test_id: params.id,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });

  if (rpcDeviceError) return NextResponse.json({ error: rpcDeviceError.message }, { status: 500 });

  const statsByVariant = new Map(
    (rpcStats || []).map((r: { variant_id: string; views: number; unique_visitors: number; conversions: number; goal_hits: number }) => [r.variant_id, r])
  );

  const deviceStatsByVariant = new Map<string, { desktop?: { views: number; unique_visitors: number; conversions: number }; mobile?: { views: number; unique_visitors: number; conversions: number } }>();
  for (const r of (rpcDeviceStats || []) as { variant_id: string; device_type: 'mobile' | 'desktop'; views: number; unique_visitors: number; conversions: number }[]) {
    const entry = deviceStatsByVariant.get(r.variant_id) || {};
    entry[r.device_type] = { views: Number(r.views), unique_visitors: Number(r.unique_visitors), conversions: Number(r.conversions) };
    deviceStatsByVariant.set(r.variant_id, entry);
  }

  // Aggregate per variant
  const variantStats = variants.map((variant: { id: string; name: string; is_control: boolean; traffic_weight: number; pages?: { id: string; name: string } | null }) => {
    const row = statsByVariant.get(variant.id) as { views: number; unique_visitors: number; conversions: number; goal_hits: number } | undefined;
    const views = Number(row?.views || 0);
    const uniqueVisitors = Number(row?.unique_visitors || 0);
    const conversions = Number(row?.conversions || 0);
    const goalHits = Number(row?.goal_hits || 0);

    const cvr = uniqueVisitors > 0 ? conversions / uniqueVisitors : 0;

    const deviceRow = deviceStatsByVariant.get(variant.id);
    const desktop = deviceRow?.desktop;
    const mobile = deviceRow?.mobile;
    const desktopUniqueVisitors = desktop?.unique_visitors || 0;
    const desktopConversions = desktop?.conversions || 0;
    const mobileUniqueVisitors = mobile?.unique_visitors || 0;
    const mobileConversions = mobile?.conversions || 0;

    return {
      variant,
      views,
      uniqueVisitors,
      conversions,
      goalHits,
      cvr,
      desktopUniqueVisitors,
      desktopConversions,
      desktopCvr: desktopUniqueVisitors > 0 ? desktopConversions / desktopUniqueVisitors : 0,
      mobileUniqueVisitors,
      mobileConversions,
      mobileCvr: mobileUniqueVisitors > 0 ? mobileConversions / mobileUniqueVisitors : 0,
      confidence: null as number | null,
      isWinner: false,
    };
  });

  // Compute confidence vs control (chi-square trial count = unique visitors,
  // not raw pageviews — each visitor is one Bernoulli trial, a reload isn't)
  const control = variantStats.find((v: { variant: { is_control: boolean } }) => v.variant.is_control) || variantStats[0];
  for (const stat of variantStats) {
    if (stat.variant.id === control.variant.id) continue;
    stat.confidence = confidencePercent(
      control.uniqueVisitors,
      control.conversions,
      stat.uniqueVisitors,
      stat.conversions
    );
  }

  // Mark winner
  const winnerId = findWinner(
    variantStats.map((s: { variant: { id: string }; uniqueVisitors: number; conversions: number }) => ({
      id: s.variant.id,
      views: s.uniqueVisitors,
      conversions: s.conversions,
    }))
  );
  for (const stat of variantStats) {
    stat.isWinner = stat.variant.id === winnerId;
  }

  const totalViews = variantStats.reduce((s: number, v: { views: number }) => s + v.views, 0);
  const totalUniqueVisitors = variantStats.reduce((s: number, v: { uniqueVisitors: number }) => s + v.uniqueVisitors, 0);
  const totalConversions = variantStats.reduce((s: number, v: { conversions: number }) => s + v.conversions, 0);

  return NextResponse.json({
    test,
    primaryGoal,
    variantStats,
    totalViews,
    totalUniqueVisitors,
    totalConversions,
  });
}

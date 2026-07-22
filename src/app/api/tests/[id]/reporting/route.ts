import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveTestWorkspaceRole } from '@/lib/workspace-auth';

export const dynamic = 'force-dynamic';

// GET /api/tests/[id]/reporting?from=YYYY-MM-DD&to=YYYY-MM-DD&variantId=uuid|all
// Returns daily time-series data grouped by variant for the chart.
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
  const variantId = searchParams.get('variantId'); // 'all' or a specific UUID

  // Fetch test variants
  const { data: test, error: testError } = await db
    .from('tests')
    .select('id, status, test_variants(id, name, is_control), conversion_goals(id)')
    .eq('id', params.id)
    .single();

  if (testError || !test) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const variants = (test.test_variants || []) as Array<{
    id: string;
    name: string;
    is_control: boolean;
  }>;

  // Server-side aggregation (Postgres RPC) — one row per (date, variant) bucket
  // instead of every raw event, avoiding Supabase's default 1,000-row PostgREST
  // cap that used to silently truncate/randomize this chart on busy tests.
  const { data: rpcRows, error: rpcError } = await db.rpc('test_variant_daily_stats', {
    p_test_id: params.id,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  type DailyRow = { day: string; variant_id: string; views: number; unique_visitors: number; conversions: number };
  let rows = (rpcRows || []) as DailyRow[];
  if (variantId && variantId !== 'all') rows = rows.filter((r) => r.variant_id === variantId);

  if (rows.length === 0) {
    return NextResponse.json({ variants, daily: [], totals: { visitors: 0, views: 0, conversions: 0, cvr: 0 } });
  }

  // Group by date
  const buckets = new Map<string, DailyRow[]>();
  for (const r of rows) {
    const date = r.day;
    if (!buckets.has(date)) buckets.set(date, []);
    buckets.get(date)!.push(r);
  }

  // Build sorted daily array
  const sortedDates = Array.from(buckets.keys()).sort();

  const daily = sortedDates.map((date) => {
    const dayRows = buckets.get(date)!;
    const row: Record<string, unknown> = { date };

    for (const variant of variants) {
      const r = dayRows.find((dr) => dr.variant_id === variant.id);
      const views = Number(r?.views || 0);
      const visitors = Number(r?.unique_visitors || 0);
      const conversions = Number(r?.conversions || 0);
      const cvr = visitors > 0 ? parseFloat(((conversions / visitors) * 100).toFixed(2)) : 0;

      row[`${variant.id}_views`] = views;
      row[`${variant.id}_visitors`] = visitors;
      row[`${variant.id}_conversions`] = conversions;
      row[`${variant.id}_cvr`] = cvr;
    }

    // Overall (sum across all variants for that day)
    const overallViews = dayRows.reduce((s, r) => s + Number(r.views || 0), 0);
    const overallVisitors = dayRows.reduce((s, r) => s + Number(r.unique_visitors || 0), 0);
    const overallConversions = dayRows.reduce((s, r) => s + Number(r.conversions || 0), 0);

    row['overall_views'] = overallViews;
    row['overall_visitors'] = overallVisitors;
    row['overall_conversions'] = overallConversions;
    row['overall_cvr'] = overallVisitors > 0
      ? parseFloat(((overallConversions / overallVisitors) * 100).toFixed(2))
      : 0;

    return row;
  });

  // Summary totals — dedup across the *entire* date range, not per-day. Summing
  // the daily buckets' unique_visitors would double-count anyone who returns on
  // a second day, so this reuses test_variant_stats (whole-range dedup) instead.
  const { data: totalsRpcRows, error: totalsRpcError } = await db.rpc('test_variant_stats', {
    p_test_id: params.id,
    p_from: from ? `${from}T00:00:00Z` : null,
    p_to: to ? `${to}T23:59:59Z` : null,
  });

  if (totalsRpcError) return NextResponse.json({ error: totalsRpcError.message }, { status: 500 });

  type TotalsRow = { variant_id: string; views: number; unique_visitors: number; conversions: number };
  let totalsRows = (totalsRpcRows || []) as TotalsRow[];
  if (variantId && variantId !== 'all') totalsRows = totalsRows.filter((r) => r.variant_id === variantId);

  const totalViews = totalsRows.reduce((s, r) => s + Number(r.views || 0), 0);
  const totalVisitors = totalsRows.reduce((s, r) => s + Number(r.unique_visitors || 0), 0);
  const totalConversions = totalsRows.reduce((s, r) => s + Number(r.conversions || 0), 0);
  const cvr = totalVisitors > 0 ? parseFloat(((totalConversions / totalVisitors) * 100).toFixed(2)) : 0;

  return NextResponse.json({
    variants,
    daily,
    totals: {
      visitors: totalVisitors,
      views: totalViews,
      conversions: totalConversions,
      cvr,
    },
  });
}

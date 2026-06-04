import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// GET /api/tests/[id]/reporting?from=YYYY-MM-DD&to=YYYY-MM-DD&variantId=uuid|all
// Returns daily time-series data grouped by variant for the chart.
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  const goalIds = new Set((test.conversion_goals || []).map((g: { id: string }) => g.id));

  // Build events query
  let query = db
    .from('events')
    .select('variant_id, type, goal_id, visitor_hash, created_at')
    .eq('test_id', params.id);

  if (from) query = query.gte('created_at', `${from}T00:00:00Z`);
  if (to) query = query.lte('created_at', `${to}T23:59:59Z`);
  if (variantId && variantId !== 'all') query = query.eq('variant_id', variantId);

  const { data: events } = await query;

  if (!events || events.length === 0) {
    return NextResponse.json({ variants, daily: [], totals: { visitors: 0, views: 0, conversions: 0, cvr: 0 } });
  }

  // Group events by date (YYYY-MM-DD) and variant_id
  type DayVariantBucket = {
    views: number;
    conversionVisitors: Set<string>;
    visitors: Set<string>;
  };

  const buckets = new Map<string, Map<string, DayVariantBucket>>();

  for (const ev of events) {
    const date = ev.created_at.slice(0, 10); // YYYY-MM-DD
    const vid = ev.variant_id as string;

    if (!buckets.has(date)) buckets.set(date, new Map());
    const dayMap = buckets.get(date)!;

    if (!dayMap.has(vid)) dayMap.set(vid, { views: 0, conversionVisitors: new Set(), visitors: new Set() });
    const bucket = dayMap.get(vid)!;

    if (ev.type === 'pageview') {
      bucket.views++;
      bucket.visitors.add(ev.visitor_hash as string);
    } else if (
      ev.type === 'conversion' &&
      ev.goal_id !== null &&
      (goalIds.size === 0 || goalIds.has(ev.goal_id as string))
    ) {
      bucket.conversionVisitors.add(ev.visitor_hash as string);
    }
  }

  // Build sorted daily array
  const sortedDates = Array.from(buckets.keys()).sort();

  const daily = sortedDates.map((date) => {
    const dayMap = buckets.get(date)!;
    const row: Record<string, unknown> = { date };

    for (const variant of variants) {
      const b = dayMap.get(variant.id);
      const views = b?.views ?? 0;
      const visitors = b?.visitors.size ?? 0;
      const conversions = b?.conversionVisitors.size ?? 0;
      const cvr = views > 0 ? parseFloat(((conversions / views) * 100).toFixed(2)) : 0;

      row[`${variant.id}_views`] = views;
      row[`${variant.id}_visitors`] = visitors;
      row[`${variant.id}_conversions`] = conversions;
      row[`${variant.id}_cvr`] = cvr;
    }

    // Overall (sum across all variants for that day)
    let overallViews = 0;
    let overallVisitors = new Set<string>();
    let overallConversions = new Set<string>();

    dayMap.forEach((b) => {
      overallViews += b.views;
      b.visitors.forEach((v) => overallVisitors.add(v));
      b.conversionVisitors.forEach((v) => overallConversions.add(v));
    });

    row['overall_views'] = overallViews;
    row['overall_visitors'] = overallVisitors.size;
    row['overall_conversions'] = overallConversions.size;
    row['overall_cvr'] = overallViews > 0
      ? parseFloat(((overallConversions.size / overallViews) * 100).toFixed(2))
      : 0;

    return row;
  });

  // Summary totals
  let totalViews = 0;
  const totalVisitorSet = new Set<string>();
  const totalConversionSet = new Set<string>();

  for (const ev of events) {
    if (ev.type === 'pageview') {
      totalViews++;
      totalVisitorSet.add(ev.visitor_hash as string);
    } else if (
      ev.type === 'conversion' &&
      ev.goal_id !== null &&
      (goalIds.size === 0 || goalIds.has(ev.goal_id as string))
    ) {
      totalConversionSet.add(ev.visitor_hash as string);
    }
  }

  const totalConversions = totalConversionSet.size;
  const cvr = totalViews > 0 ? parseFloat(((totalConversions / totalViews) * 100).toFixed(2)) : 0;

  return NextResponse.json({
    variants,
    daily,
    totals: {
      visitors: totalVisitorSet.size,
      views: totalViews,
      conversions: totalConversions,
      cvr,
    },
  });
}

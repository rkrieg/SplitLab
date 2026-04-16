import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { variantIds } = await request.json();

    if (!Array.isArray(variantIds) || variantIds.length === 0) {
      return NextResponse.json({ error: 'variantIds required' }, { status: 400 });
    }

    const testId = params.id;

    const { data: goals } = await db
      .from('conversion_goals')
      .select('id, is_primary')
      .eq('test_id', testId)
      .limit(1);

    const primaryGoalId = goals?.find((g: { is_primary: boolean }) => g.is_primary)?.id
      || goals?.[0]?.id
      || null;

    const now = new Date();
    const records: {
      test_id: string;
      variant_id: string;
      visitor_hash: string;
      type: string;
      goal_id: string | null;
      metadata: Record<string, unknown>;
    }[] = [];

    for (const variantId of variantIds) {
      const visitorHash = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      records.push({
        test_id: testId,
        variant_id: variantId,
        visitor_hash: visitorHash,
        type: 'pageview',
        goal_id: null,
        metadata: { simulated: true },
      });

      if (primaryGoalId) {
        records.push({
          test_id: testId,
          variant_id: variantId,
          visitor_hash: visitorHash,
          type: 'conversion',
          goal_id: primaryGoalId,
          metadata: { simulated: true },
        });
      }
    }

    const { error } = await db.from('events').insert(records);
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      inserted: records.length,
      hasGoal: !!primaryGoalId,
    });
  } catch (err) {
    console.error('[simulate]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

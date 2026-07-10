import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

// TODO (post-trial): Add ownership check — verify the test belongs to the requesting
// user's workspace before returning lead/conversion data.

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
  const offset = parseInt(searchParams.get('offset') || '0');
  // "all=1" surfaces goal_id=null rows too. These come from tracker.js's
  // capture-everything model on external/redirect-variant pages (every click/submit
  // is saved regardless of goal match) — hosted HTML variants (tracking.ts) only ever
  // write a row when a configured goal's element was actually clicked, so this toggle
  // is mostly empty for those tests, and that's expected, not a bug.
  const includeUntracked = searchParams.get('all') === '1';

  // Goals currently configured for this test — same set the analytics route
  // uses to decide what counts toward "Conversions"/"Goal Hits".
  const { data: goals } = await db
    .from('conversion_goals')
    .select('id')
    .eq('test_id', params.id);
  const goalIds = new Set((goals || []).map((g) => g.id));

  let query = db
    .from('events')
    .select('id, visitor_hash, goal_id, metadata, created_at, test_variants(name), conversion_goals(name)')
    .eq('test_id', params.id)
    .eq('type', 'conversion');

  if (!includeUntracked) {
    query = query.in('goal_id', Array.from(goalIds));
  }

  const { data: events, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const leads = (events || []).map((e) => ({
    ...e,
    goalEnabled: e.goal_id != null && goalIds.has(e.goal_id),
  }));

  return NextResponse.json({ leads });
}

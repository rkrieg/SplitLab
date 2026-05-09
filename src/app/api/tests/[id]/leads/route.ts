import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { rawQuery } from '@/lib/db';

async function requireTestMembership(testId: string, userId: string) {
  const rows = await rawQuery<{ workspace_id: string }>(
    `SELECT t.workspace_id FROM tests t
     JOIN workspace_members wm ON wm.workspace_id = t.workspace_id
     WHERE t.id = $1 AND wm.user_id = $2 LIMIT 1`,
    [testId, userId]
  );
  return rows[0] ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await requireTestMembership(params.id, session.user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
  const offset = parseInt(searchParams.get('offset') || '0');

  const { data: events, error } = await db
    .from('events')
    .select('id, visitor_hash, metadata, created_at, test_variants(name), conversion_goals(name)')
    .eq('test_id', params.id)
    .eq('type', 'conversion')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ leads: events || [] });
}

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { rawQuery } from '@/lib/db';
import { currentMonth } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const month = currentMonth();

  const users = await rawQuery<{
    id: string;
    name: string;
    email: string;
    role: string;
    status: string;
    plan: string;
    created_at: string;
    visitor_count: number;
    test_count: number;
    client_count: number;
  }>(
    `SELECT
       u.id,
       u.name,
       u.email,
       u.role,
       u.status,
       COALESCE(u.plan, 'starter') AS plan,
       u.created_at,
       COALESCE(vu.visitor_count, 0)::int AS visitor_count,
       (SELECT COUNT(DISTINCT t.id)
        FROM tests t
        JOIN workspaces w ON t.workspace_id = w.id
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.user_id = u.id AND t.status IN ('draft','running','paused','active'))::int AS test_count,
       (SELECT COUNT(DISTINCT c.id)
        FROM clients c
        JOIN workspaces w ON w.client_id = c.id
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.user_id = u.id)::int AS client_count
     FROM users u
     LEFT JOIN visitor_usage vu ON vu.user_id = u.id AND vu.month = $1
     ORDER BY u.created_at DESC`,
    [month]
  );

  return NextResponse.json(users);
}

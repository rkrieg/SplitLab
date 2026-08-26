import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';
import { logEvent } from '@/lib/log';

export const dynamic = 'force-dynamic';

// POST /api/tests/[id]/reset-stats
// Permanently deletes this test's recorded analytics data — all pageview /
// conversion events (which drives every stat: views, conversions, CVR, goals,
// confidence, device split). Optionally also deletes captured form leads.
// For when tracking was misconfigured and the data is unusable. Irreversible.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: test } = await db.from('tests').select('id, name, workspace_id').eq('id', params.id).single();
  if (!test) return NextResponse.json({ error: 'Test not found' }, { status: 404 });

  const role = await resolveWorkspaceRole(test.workspace_id, session.user.id, session.user.role);
  if (!role || role === 'viewer') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as { includeLeads?: boolean };

  // Delete events (drives all the analytics numbers).
  const { count: eventsDeleted, error: evErr } = await db
    .from('events')
    .delete({ count: 'exact' })
    .eq('test_id', params.id);
  if (evErr) return NextResponse.json({ error: evErr.message }, { status: 500 });

  let leadsDeleted = 0;
  if (body.includeLeads) {
    const { count, error: leadErr } = await db
      .from('form_leads')
      .delete({ count: 'exact' })
      .eq('test_id', params.id);
    if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });
    leadsDeleted = count ?? 0;
  }

  logEvent('admin_action', 'warn', `Reset stats for test "${test.name}"`, {
    test_id: params.id,
    workspace_id: test.workspace_id,
    by_user_id: session.user.id,
    by_email: session.user.email,
    events_deleted: eventsDeleted ?? 0,
    leads_deleted: leadsDeleted,
    include_leads: !!body.includeLeads,
  });

  return NextResponse.json({ ok: true, eventsDeleted: eventsDeleted ?? 0, leadsDeleted });
}

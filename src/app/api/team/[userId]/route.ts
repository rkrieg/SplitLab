import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

/** DELETE /api/team/[userId] — remove a team member and delete their account */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'manager') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Prevent self-removal
  if (params.userId === session.user.id) {
    return NextResponse.json({ error: 'Cannot remove yourself' }, { status: 400 });
  }

  // Confirm this user is actually a member of one of the manager's workspaces
  // (prevents a manager from removing members belonging to another account)
  const { data: clients } = await db
    .from('clients')
    .select('id')
    .eq('owner_id', session.user.id);

  if (!clients?.length) {
    return NextResponse.json({ error: 'No workspaces found' }, { status: 404 });
  }

  const { data: workspaces } = await db
    .from('workspaces')
    .select('id')
    .in('client_id', clients.map((c) => c.id));

  const workspaceIds = workspaces?.map((w) => w.id) ?? [];
  if (!workspaceIds.length) {
    return NextResponse.json({ error: 'No workspaces found' }, { status: 404 });
  }

  // Verify the target user is actually in one of those workspaces
  const { data: membership } = await db
    .from('workspace_members')
    .select('id')
    .in('workspace_id', workspaceIds)
    .eq('user_id', params.userId)
    .limit(1)
    .single();

  if (!membership) {
    return NextResponse.json({ error: 'Member not found in your workspaces' }, { status: 404 });
  }

  // Delete the user account — cascades to workspace_members via FK ON DELETE CASCADE
  const { error } = await db.from('users').delete().eq('id', params.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}

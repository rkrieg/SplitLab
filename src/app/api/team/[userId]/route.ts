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

  // Verify the target user is actually a member of, or has a pending invite
  // to, one of those workspaces
  const [{ data: membership }, { data: pending }] = await Promise.all([
    db.from('workspace_members').select('id').in('workspace_id', workspaceIds).eq('user_id', params.userId).limit(1).single(),
    db.from('pending_invites').select('id').in('workspace_id', workspaceIds).eq('user_id', params.userId).limit(1).single(),
  ]);

  if (!membership && !pending) {
    return NextResponse.json({ error: 'Member not found in your workspaces' }, { status: 404 });
  }

  // Always clear any pending invite for this manager's workspaces, whether or
  // not full membership has been accepted yet.
  await db.from('pending_invites').delete().in('workspace_id', workspaceIds).eq('user_id', params.userId);

  if (!membership) {
    // Only a pending invite existed — nothing else to clean up.
    return NextResponse.json({ success: true });
  }

  // Remove membership from this manager's workspaces only — the same account
  // may also belong to other clients' teams (or own clients of its own), and
  // must not lose that access just because one manager removed them here.
  const { error: removeError } = await db
    .from('workspace_members')
    .delete()
    .in('workspace_id', workspaceIds)
    .eq('user_id', params.userId);
  if (removeError) return NextResponse.json({ error: removeError.message }, { status: 500 });

  // If this was their only workspace membership anywhere and they don't own
  // any clients themselves, the account is now orphaned — clean it up.
  const [{ count: remainingMemberships }, { count: ownedClients }] = await Promise.all([
    db.from('workspace_members').select('*', { count: 'exact', head: true }).eq('user_id', params.userId),
    db.from('clients').select('*', { count: 'exact', head: true }).eq('owner_id', params.userId),
  ]);

  if (!remainingMemberships && !ownedClients) {
    await db.from('users').delete().eq('id', params.userId);
  }

  return NextResponse.json({ success: true });
}

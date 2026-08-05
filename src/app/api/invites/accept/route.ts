import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';

/** POST /api/invites/accept — accept a pending invite (adds workspace_members, clears the pending rows) */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { token } = await request.json();
  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  const { data: invites, error } = await db
    .from('pending_invites')
    .select('id, workspace_id, user_id, role, expires_at')
    .eq('token', token);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!invites?.length) return NextResponse.json({ error: 'Invite not found or already accepted' }, { status: 404 });

  // The invite is tied to a specific account — only that logged-in user can accept it.
  if (invites[0].user_id !== session.user.id) {
    return NextResponse.json({ error: 'This invite was sent to a different account. Please log in as the invited user.' }, { status: 403 });
  }

  if (new Date(invites[0].expires_at) < new Date()) {
    await db.from('pending_invites').delete().eq('token', token);
    return NextResponse.json({ error: 'This invite has expired. Please ask them to invite you again.' }, { status: 410 });
  }

  const { error: insertError } = await db.from('workspace_members').insert(
    invites.map((i) => ({ workspace_id: i.workspace_id, user_id: i.user_id, role: i.role }))
  );
  // Ignore duplicate-membership conflicts (e.g. double-accept) — the invite is
  // still consumed either way.
  if (insertError && insertError.code !== '23505') {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await db.from('pending_invites').delete().eq('token', token);

  return NextResponse.json({ success: true, workspaceIds: invites.map((i) => i.workspace_id) });
}

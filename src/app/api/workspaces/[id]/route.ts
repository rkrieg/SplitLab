import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { resolveWorkspaceRole } from '@/lib/workspace-auth';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const role = await resolveWorkspaceRole(params.id, session.user.id, session.user.role);
  if (!role) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await db
    .from('workspaces')
    .select('*, clients(*), domains(*), workspace_members(*, users(id, name, email, role))')
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

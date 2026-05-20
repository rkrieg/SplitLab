import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/supabase-server';
import { z } from 'zod';

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  logo_url: z.string().url().nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

async function canAccessClient(clientId: string, userId: string, userRole: string) {
  if (userRole === 'admin') return true;

  const { data: client } = await db
    .from('clients')
    .select('owner_id')
    .eq('id', clientId)
    .single();

  if (client?.owner_id === userId) return true;

  // Viewers (and managers invited to a workspace) can access the client if they
  // have membership in at least one workspace under it
  const { data: workspaces } = await db
    .from('workspaces')
    .select('id')
    .eq('client_id', clientId);

  const workspaceIds = workspaces?.map(w => w.id) ?? [];
  if (workspaceIds.length === 0) return false;

  const { data: member } = await db
    .from('workspace_members')
    .select('id')
    .eq('user_id', userId)
    .in('workspace_id', workspaceIds)
    .limit(1)
    .single();

  return !!member;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!await canAccessClient(params.id, session.user.id, session.user.role)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { data, error } = await db
    .from('clients')
    .select(`
      *,
      workspaces (
        *,
        domains (*),
        tests ( id, name, status, url_path, created_at )
      )
    `)
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role === 'viewer') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!await canAccessClient(params.id, session.user.id, session.user.role)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const body = await request.json();
    const data = updateSchema.parse(body);

    const { data: updated, error } = await db
      .from('clients')
      .update(data)
      .eq('id', params.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role === 'viewer') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!await canAccessClient(params.id, session.user.id, session.user.role)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { error } = await db.from('clients').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
